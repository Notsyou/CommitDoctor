'use strict';
const crypto = require('crypto');
const express = require('express');
const { localDate, localTime, addDays, isDateStr } = require('./time');
const { getSummary, generateSummary, getTrend } = require('./summary');

const clamp = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createApiRouter({ db, config }) {
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
    const lastSaved = db.prepare('SELECT date FROM summaries ORDER BY date DESC LIMIT 1').get();
    res.json({
      today: localDate(Date.now(), tz),
      timezone: tz,
      repo: (latestCommit && latestCommit.repo) || config.repo || null,
      rules: { min_commits: config.summary.minCommits, comparison_days: config.summary.comparisonDays },
      secret_configured: Boolean(config.webhookSecret),
      totals,
      last_push_at: lastPush ? lastPush.received_at : null,
      last_saved_date: lastSaved ? lastSaved.date : null,
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
      }))
    );
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
