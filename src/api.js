'use strict';
const crypto = require('crypto');
const express = require('express');
const { localDate, localTime, addDays, daysBetween, isDateStr } = require('./time');
const { getSummary, generateSummary, getTrend } = require('./summary');
const { predictDeadline } = require('./predict');
const { checkDeadlineUrgency } = require('./notify');
const { encryptToken } = require('./crypto');
const { testRepoAccess, pollOneRepo } = require('./poller');
const { connectWebhook } = require('./hooks');

const clamp = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function createApiRouter({ db, config, mailer = null }) {
  const router = express.Router();
  const tz = config.timezone;

  const requireAdmin = (req, res, next) => {
    if (!config.adminToken) return next();
    const header = req.get('authorization') || '';
    if (safeEqual(header, `Bearer ${config.adminToken}`)) return next();
    return res.status(401).json({ error: 'Admin token required.' });
  };

  const validDate = (req, res, next) => {
    if (!isDateStr(req.params.date)) return res.status(400).json({ error: 'Date must look like 2026-09-20.' });
    return next();
  };

  const readSettings = () => {
    const row = db.prepare('SELECT deadline_date, tracked_repo, updated_at FROM project_settings WHERE id = 1').get();
    const today = localDate(Date.now(), tz);
    const days_remaining = row && row.deadline_date ? daysBetween(today, row.deadline_date) : null;
    return {
      deadline_date: row ? row.deadline_date : null,
      days_remaining,
      tracked_repo: (row && row.tracked_repo) || config.repo || null,
      updated_at: row ? row.updated_at : null,
    };
  };

  // Is GitHub actually delivering for the tracked repo? Judged from the newest
  // delivery, so a later failure (e.g. a changed secret) shows up right away.
  //   waiting    nothing received yet
  //   failing    the newest delivery was rejected (bad secret, wrong content type)
  //   other_repo deliveries are arriving, but from a different repository
  //   connected  the newest delivery came from the tracked repo (ping or push)
  const lastEvent = db.prepare('SELECT event, repo, status, detail, received_at FROM webhook_events ORDER BY id DESC LIMIT 1');
  const lastOkFor = db.prepare(
    `SELECT event, received_at FROM webhook_events
     WHERE status = 'accepted' AND event IN ('ping', 'push') AND lower(repo) = ? ORDER BY id DESC LIMIT 1`
  );
  function webhookStatus(trackedRepo) {
    const last = lastEvent.get();
    const ok = trackedRepo ? lastOkFor.get(trackedRepo) : null;
    const base = { last_ok_event: ok ? ok.event : null, last_ok_at: ok ? ok.received_at : null };
    if (!last) return { state: 'waiting', ...base };
    if (last.status === 'rejected') return { state: 'failing', detail: last.detail, at: last.received_at, ...base };
    const lastRepo = (last.repo || '').toLowerCase();
    if (trackedRepo && lastRepo && lastRepo !== trackedRepo) {
      return { state: 'other_repo', repo_seen: last.repo, at: last.received_at, ...base };
    }
    return { state: ok ? 'connected' : 'waiting', ...base };
  }

  router.get('/health', (_req, res) => res.json({ ok: true }));

  // Everything the dashboard header needs in one call.
  router.get('/overview', (_req, res) => {
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS commits, COUNT(DISTINCT contributor) AS contributors,
                COUNT(DISTINCT committed_date) AS days, MIN(committed_date) AS first_date
         FROM commits`
      )
      .get();
    const latestCommit = db.prepare('SELECT repo FROM commits ORDER BY committed_at DESC LIMIT 1').get();
    const lastPush = db
      .prepare("SELECT received_at FROM webhook_events WHERE status = 'accepted' AND event = 'push' ORDER BY id DESC LIMIT 1")
      .get();
    const lastPing = db
      .prepare("SELECT received_at, repo FROM webhook_events WHERE status = 'accepted' AND event = 'ping' ORDER BY id DESC LIMIT 1")
      .get();
    const settings = readSettings();
    const lastSaved = db.prepare('SELECT date FROM summaries ORDER BY date DESC LIMIT 1').get();
    const activityCounts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM webhook_events) AS webhook_events_count,
                (SELECT COUNT(*) FROM summary_runs) AS summary_runs_count`
      )
      .get();
    res.json({
      today: localDate(Date.now(), tz),
      timezone: tz,
      repo: (latestCommit && latestCommit.repo) || config.repo || null,
      rules: { min_commits: config.summary.minCommits, comparison_days: config.summary.comparisonDays },
      secret_configured: Boolean(config.webhookSecret),
      totals,
      last_push_at: lastPush ? lastPush.received_at : null,
      last_ping_at: lastPing ? lastPing.received_at : null,
      webhook: webhookStatus(settings.tracked_repo),
      last_saved_date: lastSaved ? lastSaved.date : null,
      activity_log: activityCounts,
      settings,
    });
  });

  router.get('/trend', (req, res) => {
    res.json(getTrend(db, config, clamp(req.query.days, 1, 60, 14)));
  });

  router.get('/summaries', (req, res) => {
    const rows = db
      .prepare('SELECT date, total_commits, trigger, generated_at, data FROM summaries ORDER BY date DESC LIMIT ?')
      .all(clamp(req.query.limit, 1, 100, 30));
    res.json(
      rows.map((r) => ({
        date: r.date,
        total_commits: r.total_commits,
        trigger: r.trigger,
        generated_at: r.generated_at,
        headline: JSON.parse(r.data).headline,
      }))
    );
  });

  router.get('/summaries/:date', validDate, (req, res) => {
    res.json(getSummary(db, config, req.params.date));
  });

  // Manual "save the summary now" (also handy for demos and testing).
  router.post('/summaries/:date/generate', requireAdmin, validDate, (req, res) => {
    const result = generateSummary(db, config, req.params.date, 'manual', { force: true });
    res.status(result.saved ? 200 : 409).json(result);
  });

  router.get('/commits', (req, res) => {
    const date = req.query.date || localDate(Date.now(), tz);
    if (!isDateStr(date)) return res.status(400).json({ error: 'date must look like 2026-09-20.' });
    const rows = db
      .prepare('SELECT * FROM commits WHERE committed_date = ? ORDER BY committed_at DESC LIMIT ?')
      .all(date, clamp(req.query.limit, 1, 500, 200));
    return res.json(
      rows.map((r) => ({
        sha: r.sha,
        short_sha: r.sha.slice(0, 7),
        message: r.message,
        contributor: r.contributor,
        author_name: r.author_name,
        branch: r.branch,
        url: r.url,
        is_merge: Boolean(r.is_merge),
        committed_at: r.committed_at,
        time: localTime(r.committed_at, tz),
        // files_*: known for every commit. lines_*: null unless this commit came
        // from a polled (token-tracked) repo — see src/poller.js.
        churn: {
          files_added: r.files_added,
          files_removed: r.files_removed,
          files_modified: r.files_modified,
          lines_added: r.lines_added,
          lines_deleted: r.lines_deleted,
        },
      }))
    );
  });

  // --- Project settings (currently just the manually-entered deadline, and the
  // single push-webhook repo — see tracked_repos below for the multi-repo path) ---

  router.get('/settings', (_req, res) => res.json(readSettings()));

  // A basic linear projection of pace vs. the deadline — see src/predict.js for
  // the method and its deliberate limits. Live-computed, not stored, since it's
  // cheap and always wanted "as of now" rather than as of a saved day.
  router.get('/prediction', (req, res) => {
    const date = req.query.date && isDateStr(req.query.date) ? req.query.date : localDate(Date.now(), tz);
    res.json(predictDeadline(db, config, date));
  });

  router.post('/settings', requireAdmin, (req, res) => {
    const body = req.body || {};
    const hasDeadline = 'deadline_date' in body;
    const hasRepo = 'tracked_repo' in body;
    if (!hasDeadline && !hasRepo) {
      return res.status(400).json({ error: 'Send deadline_date and/or tracked_repo (either may be null to clear it).' });
    }

    const current = db.prepare('SELECT deadline_date, tracked_repo FROM project_settings WHERE id = 1').get();
    let deadline_date = current.deadline_date;
    let tracked_repo = current.tracked_repo;

    if (hasDeadline) {
      const value = body.deadline_date;
      if (value !== null && !isDateStr(value)) {
        return res.status(400).json({ error: 'deadline_date must look like 2026-09-20, or be null to clear it.' });
      }
      deadline_date = value;
    }
    if (hasRepo) {
      const value = body.tracked_repo === null ? null : String(body.tracked_repo).trim().toLowerCase();
      if (value !== null && !REPO_RE.test(value)) {
        return res.status(400).json({ error: 'tracked_repo must look like owner/name, or be null to clear it.' });
      }
      tracked_repo = value;
    }

    db.prepare(
      `UPDATE project_settings SET deadline_date = ?, tracked_repo = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`
    ).run(deadline_date, tracked_repo);
    return res.status(200).json(readSettings());
  });

  // --- Webhook setup helpers for the dashboard: the values to paste into GitHub,
  // and a one-click "create it for me" that uses a token once and forgets it. ---

  const URL_RE = /^https?:\/\/[^\s/]+(\/\S*)?$/i;

  router.get('/webhook-setup', requireAdmin, (_req, res) => {
    res.json({
      tracked_repo: readSettings().tracked_repo,
      secret: config.webhookSecret,
      content_type: 'application/json',
      events: ['push'],
      path: '/webhook/github',
    });
  });

  router.post('/webhook-setup/connect', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const repo = String(body.repo || '').trim().toLowerCase();
    const token = String(body.token || '').trim();
    const payloadUrl = String(body.payload_url || '').trim();
    if (!REPO_RE.test(repo)) return res.status(400).json({ error: 'repo must look like owner/name.' });
    if (!token) return res.status(400).json({ error: 'A GitHub token is required to create the webhook.' });
    if (!URL_RE.test(payloadUrl)) return res.status(400).json({ error: 'payload_url must be a full http(s) URL.' });
    if (/^https?:\/\/(localhost|127\.|\[::1\])/i.test(payloadUrl)) {
      return res.status(400).json({ error: 'GitHub cannot reach localhost. Use a public URL (for example from ngrok or smee.io).' });
    }

    let hook;
    try {
      hook = await connectWebhook({ repo, token, payloadUrl, secret: config.webhookSecret });
    } catch (err) {
      const hint = err.status === 404 || err.status === 403
        ? ' The token needs admin access to the repo (classic: admin:repo_hook; fine-grained: Webhooks read and write).'
        : '';
      return res.status(422).json({ error: `GitHub refused: ${err.message}${hint}` });
    }

    db.prepare(
      `UPDATE project_settings SET tracked_repo = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`
    ).run(repo);
    return res.status(hook.created ? 201 : 200).json({ ok: true, hook_id: hook.id, created: hook.created, settings: readSettings() });
  });

  // --- Tracked repos (polled via GitHub's API using a per-repo token; works for
  // private repos and repos with no public webhook). Token is encrypted at rest
  // and never returned by any of these endpoints. ---

  const publicRepoRow = (r) => ({
    id: r.id,
    repo: r.repo,
    default_branch: r.default_branch,
    last_polled_at: r.last_polled_at,
    last_error: r.last_error,
    active: Boolean(r.active),
    created_at: r.created_at,
  });

  router.get('/tracked-repos', (_req, res) => {
    res.json(db.prepare('SELECT * FROM tracked_repos ORDER BY created_at DESC').all().map(publicRepoRow));
  });

  router.post('/tracked-repos', requireAdmin, async (req, res) => {
    if (!config.tokenEncryptionKey) {
      return res.status(503).json({ error: 'Server has no TOKEN_ENCRYPTION_KEY configured; cannot store tokens.' });
    }
    const repo = String((req.body && req.body.repo) || '').trim().toLowerCase();
    const token = String((req.body && req.body.token) || '').trim();
    if (!REPO_RE.test(repo)) return res.status(400).json({ error: 'repo must look like owner/name.' });
    if (!token) return res.status(400).json({ error: 'token is required.' });

    let access;
    try {
      access = await testRepoAccess(repo, token);
    } catch (err) {
      return res.status(422).json({ error: `Could not verify that repo with this token: ${err.message}` });
    }

    try {
      const tokenEnc = encryptToken(token, config.tokenEncryptionKey);
      const info = db
        .prepare('INSERT INTO tracked_repos (repo, token_enc, default_branch) VALUES (?, ?, ?)')
        .run(repo, tokenEnc, access.defaultBranch);
      // Poll immediately rather than waiting for the next timer tick, so the
      // dashboard shows real status right away instead of "not checked yet".
      // The regular interval in poller.js still covers every row afterward.
      const freshRow = db.prepare('SELECT * FROM tracked_repos WHERE id = ?').get(info.lastInsertRowid);
      await pollOneRepo({ db, config, row: freshRow });
      const row = db.prepare('SELECT * FROM tracked_repos WHERE id = ?').get(info.lastInsertRowid);
      return res.status(201).json(publicRepoRow(row));
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'That repo is already tracked.' });
      throw err;
    }
  });

  router.delete('/tracked-repos/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a whole number.' });
    const info = db.prepare('DELETE FROM tracked_repos WHERE id = ?').run(id);
    if (info.changes === 0) return res.status(404).json({ error: 'Tracked repo not found.' });
    return res.status(204).end();
  });

  // --- Subscribers (notification recipients; storage + CRUD only, nothing sends email yet) ---

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  router.get('/subscribers', (_req, res) => {
    res.json(db.prepare('SELECT id, name, email, created_at FROM subscribers ORDER BY id').all());
  });

  router.post('/subscribers', requireAdmin, (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!name) return res.status(400).json({ error: 'name is required.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
    try {
      const info = db.prepare('INSERT INTO subscribers (name, email) VALUES (?, ?)').run(name, email);
      const row = db.prepare('SELECT id, name, email, created_at FROM subscribers WHERE id = ?').get(info.lastInsertRowid);
      return res.status(201).json(row);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'That email is already subscribed.' });
      throw err;
    }
  });

  router.delete('/subscribers/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a whole number.' });
    const info = db.prepare('DELETE FROM subscribers WHERE id = ?').run(id);
    if (info.changes === 0) return res.status(404).json({ error: 'Subscriber not found.' });
    return res.status(204).end();
  });

  router.post('/notifications/test', requireAdmin, async (req, res) => {
    if (!mailer) return res.status(503).json({ error: 'Email is off. Set SMTP_HOST in .env and restart.' });
    const to = String((req.body && req.body.to) || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'A valid "to" email is required.' });
    try{
      await mailer.sendMail({ to, subject: 'Commit Doctor test email', html: '<p>If you can read this, email works. </p>'});
      return res.json({ sent: true, to });
    } catch(err){
      return res.status(502).json({ error: `SMTP send failed: ${err.message}` });
    }
  });

  router.post('/notifications/check', requireAdmin, async (_req, res) => {
    if (!mailer) return res.status(503).json({ error: 'Email is off. Set SMTP_HOST in .env and restart.' });
    return res.json(await checkDeadlineUrgency(db, config, mailer));
  });

  router.get('/flags', (req, res) => {
    const limit = clamp(req.query.limit, 1, 200, 30);
    if (req.query.date) {
      if (!isDateStr(req.query.date)) return res.status(400).json({ error: 'date must look like 2026-09-20.' });
      return res.json(db.prepare('SELECT * FROM flags WHERE date = ? ORDER BY id DESC').all(req.query.date));
    }
    return res.json(db.prepare('SELECT * FROM flags ORDER BY date DESC, id DESC LIMIT ?').all(limit));
  });

  // The prototype's own activity record (deliveries received, summaries generated).
  router.get('/activity', (req, res) => {
    const limit = clamp(req.query.limit, 1, 200, 30);
    res.json({
      webhook_events: db.prepare('SELECT * FROM webhook_events ORDER BY id DESC LIMIT ?').all(limit),
      summary_runs: db.prepare('SELECT * FROM summary_runs ORDER BY id DESC LIMIT ?').all(limit),
    });
  });

  return router;
}

module.exports = { createApiRouter };