'use strict';
const crypto = require('crypto');
const express = require('express');
const { createStore } = require('./store');

/** Constant-time check of GitHub's X-Hub-Signature-256 header against the raw request body. */
function verifySignature(rawBody, header, secret) {
  if (!rawBody || !header || !secret || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(header);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Map one commit from a GitHub "push" payload to the shape store.addCommit expects. */
function parsePushCommit(c, payload, deliveryId) {
  return {
    sha: c.id,
    repo: payload.repository.full_name,
    branch: String(payload.ref || '').replace(/^refs\/heads\//, ''),
    authorName: c.author && c.author.name,
    authorUsername: c.author && c.author.username,
    authorEmail: c.author && c.author.email,
    message: c.message,
    url: c.url,
    timestamp: c.timestamp,
    deliveryId,
    // Push payloads list filenames per commit, not line counts. Good enough for
    // file-level churn; line-level churn (lines_added/lines_deleted) is left
    // unset here and stays NULL — only the poller's authenticated per-commit
    // calls (for polled repos) can afford to fetch that.
    filesAdded: Array.isArray(c.added) ? c.added.length : undefined,
    filesRemoved: Array.isArray(c.removed) ? c.removed.length : undefined,
    filesModified: Array.isArray(c.modified) ? c.modified.length : undefined,
  };
}

function createWebhookRouter({ db, config }) {
  const router = express.Router();
  const store = createStore(db, config);
  const getTrackedRepo = db.prepare('SELECT tracked_repo FROM project_settings WHERE id = 1');
  const logEvent = db.prepare(
    `INSERT INTO webhook_events (delivery_id, event, repo, status, detail, commits_received, commits_new)
     VALUES (@delivery_id, @event, @repo, @status, @detail, @received, @added)`
  );
  const record = (base, status, detail, received = 0, added = 0) =>
    logEvent.run({ ...base, status, detail, received, added });

  router.post('/', (req, res) => {
    const base = {
      delivery_id: req.get('X-GitHub-Delivery') || null,
      event: req.get('X-GitHub-Event') || null,
      repo: (req.body && req.body.repository && req.body.repository.full_name) || null,
    };

    if (!config.webhookSecret) {
      record(base, 'rejected', 'Server has no GITHUB_WEBHOOK_SECRET configured');
      return res.status(503).json({ error: 'Webhook secret is not configured on the server.' });
    }
    if (!req.rawBody) {
      record(base, 'rejected', 'Body was not application/json');
      return res.status(400).json({ error: 'Set the webhook content type to application/json.' });
    }
    if (!verifySignature(req.rawBody, req.get('X-Hub-Signature-256'), config.webhookSecret)) {
      record(base, 'rejected', 'Invalid or missing signature');
      return res.status(401).json({ error: 'Invalid signature.' });
    }

    const payload = req.body;
    if (base.event === 'ping') {
      record(base, 'accepted', 'ping');
      return res.json({ ok: true, message: 'pong' });
    }
    if (base.event !== 'push') {
      record(base, 'ignored', `Event "${base.event}" is not tracked`);
      return res.status(202).json({ ok: true, ignored: base.event });
    }
    if (!payload.repository || !payload.repository.full_name) {
      record(base, 'rejected', 'Push payload has no repository');
      return res.status(400).json({ error: 'Malformed push payload.' });
    }
    // The dashboard's "Track" button can set this at runtime; .env's GITHUB_REPO
    // is only the fallback default so upgrading doesn't require re-entering it.
    const row = getTrackedRepo.get();
    const trackedRepo = (row && row.tracked_repo) || config.repo || '';
    if (trackedRepo && payload.repository.full_name.toLowerCase() !== trackedRepo) {
      record(base, 'ignored', `Repository is not ${trackedRepo}`);
      return res.status(202).json({ ok: true, ignored: 'other repository' });
    }

    // GitHub marks commits that were already in the repository (e.g. the branch
    // commits re-listed when a PR is merged) as distinct:false. Counting them
    // again would inflate the numbers, so we skip them. The UNIQUE(sha) column
    // is the second line of defence against repeated pushes and redeliveries.
    const all = Array.isArray(payload.commits) ? payload.commits : [];
    const fresh = all.filter((c) => c && c.id && c.distinct !== false);
    const added = store.addMany(fresh.map((c) => parsePushCommit(c, payload, base.delivery_id)));

    record(base, 'accepted', `${payload.ref || 'unknown ref'}`, all.length, added);
    return res.json({ ok: true, received: all.length, stored: added });
  });

  return router;
}

module.exports = { createWebhookRouter, verifySignature, parsePushCommit };