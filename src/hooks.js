'use strict';
const crypto = require('crypto');
const { ghFetch, API } = require('./poller');

/**
 * Make sure config.webhookSecret is set. GITHUB_WEBHOOK_SECRET from .env wins;
 * otherwise a random secret is generated once and kept in project_settings, so
 * the webhook works out of the box without editing .env.
 */
function ensureWebhookSecret(db, config) {
  if (config.webhookSecret) return 'env';
  const row = db.prepare('SELECT webhook_secret FROM project_settings WHERE id = 1').get();
  if (row && row.webhook_secret) {
    config.webhookSecret = row.webhook_secret;
  } else {
    config.webhookSecret = crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE project_settings SET webhook_secret = ? WHERE id = 1').run(config.webhookSecret);
  }
  return 'generated';
}

/**
 * Create the push webhook on GitHub (or update ours if one with the same URL
 * already exists). The token is used for these calls only and never stored.
 * Needs a classic token with admin:repo_hook, or a fine-grained token with
 * "Webhooks: read and write" on the repo.
 */
async function connectWebhook({ repo, token, payloadUrl, secret }) {
  const hookConfig = { url: payloadUrl, content_type: 'json', secret, insecure_ssl: '0' };
  const hooks = await (await ghFetch(`${API}/repos/${repo}/hooks?per_page=100`, token)).json();
  const existing = Array.isArray(hooks) ? hooks.find((h) => h.config && h.config.url === payloadUrl) : null;
  if (existing) {
    const res = await ghFetch(`${API}/repos/${repo}/hooks/${existing.id}`, token, {
      method: 'PATCH',
      body: { config: hookConfig, events: ['push'], active: true },
    });
    return { id: (await res.json()).id, created: false };
  }
  const res = await ghFetch(`${API}/repos/${repo}/hooks`, token, {
    method: 'POST',
    body: { name: 'web', config: hookConfig, events: ['push'], active: true },
  });
  return { id: (await res.json()).id, created: true };
}

module.exports = { ensureWebhookSecret, connectWebhook };
