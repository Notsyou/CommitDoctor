'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx } = require('./helpers');
const { createApp } = require('../src/app');
const { ensureWebhookSecret, connectWebhook } = require('../src/hooks');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function listen(ctx) {
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** Stub GitHub's API while letting requests to the local test server through. */
function stubGitHub(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (!String(url).startsWith('https://api.github.com')) return realFetch(url, opts);
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    const { status = 200, json = {} } = handler(String(url), opts.method || 'GET') || {};
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

test('a secret is generated once and kept when .env has none', () => {
  const ctx = makeCtx({ webhookSecret: '' });
  assert.equal(ensureWebhookSecret(ctx.db, ctx.config), 'generated');
  const first = ctx.config.webhookSecret;
  assert.match(first, /^[0-9a-f]{48}$/);

  const again = { ...ctx.config, webhookSecret: '' };
  ensureWebhookSecret(ctx.db, again);
  assert.equal(again.webhookSecret, first);
});

test('the .env secret wins over a stored one', () => {
  const ctx = makeCtx();
  assert.equal(ensureWebhookSecret(ctx.db, ctx.config), 'env');
  assert.equal(ctx.config.webhookSecret, 'test-secret');
});

test('GET /api/webhook-setup returns the values to paste into GitHub', async () => {
  const { server, base } = await listen(makeCtx());
  try {
    const body = await (await fetch(`${base}/api/webhook-setup`)).json();
    assert.equal(body.secret, 'test-secret');
    assert.equal(body.content_type, 'application/json');
    assert.deepEqual(body.events, ['push']);
  } finally { server.close(); }
});

test('webhook setup is admin-only when ADMIN_TOKEN is set', async () => {
  const { server, base } = await listen(makeCtx({ adminToken: 'adm' }));
  try {
    assert.equal((await fetch(`${base}/api/webhook-setup`)).status, 401);
    const ok = await fetch(`${base}/api/webhook-setup`, { headers: { Authorization: 'Bearer adm' } });
    assert.equal(ok.status, 200);
  } finally { server.close(); }
});

test('connect rejects a localhost payload URL before calling GitHub', async () => {
  const calls = stubGitHub(() => ({}));
  const { server, base } = await listen(makeCtx());
  try {
    const res = await fetch(`${base}/api/webhook-setup/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'a/b', token: 't', payload_url: 'http://localhost:3000/webhook/github' }),
    });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  } finally { server.close(); }
});

test('connect creates the hook on GitHub and starts tracking the repo', async () => {
  const calls = stubGitHub((url, method) => (method === 'GET' ? { json: [] } : { status: 201, json: { id: 42 } }));
  const ctx = makeCtx();
  const { server, base } = await listen(ctx);
  try {
    const res = await fetch(`${base}/api/webhook-setup/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'Team/Repo', token: 't', payload_url: 'https://cd.example.com/webhook/github' }),
    });
    assert.equal(res.status, 201);
    const post = calls.find((c) => c.method === 'POST');
    assert.equal(post.url, 'https://api.github.com/repos/team/repo/hooks');
    assert.deepEqual(post.body.events, ['push']);
    assert.equal(post.body.config.content_type, 'json');
    assert.equal(post.body.config.secret, 'test-secret');
    assert.equal(ctx.db.prepare('SELECT tracked_repo FROM project_settings').get().tracked_repo, 'team/repo');
  } finally { server.close(); }
});

test('connectWebhook updates an existing hook with the same URL instead of duplicating it', async () => {
  const url = 'https://cd.example.com/webhook/github';
  const calls = stubGitHub((u, method) => (method === 'GET' ? { json: [{ id: 7, config: { url } }] } : { json: { id: 7 } }));
  const hook = await connectWebhook({ repo: 'a/b', token: 't', payloadUrl: url, secret: 's' });
  assert.deepEqual(hook, { id: 7, created: false });
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url, 'https://api.github.com/repos/a/b/hooks/7');
});

test('a GitHub permission error is explained', async () => {
  stubGitHub(() => ({ status: 404, json: { message: 'Not Found' } }));
  const { server, base } = await listen(makeCtx());
  try {
    const res = await fetch(`${base}/api/webhook-setup/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'a/b', token: 't', payload_url: 'https://cd.example.com/webhook/github' }),
    });
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /admin:repo_hook/);
  } finally { server.close(); }
});

test('overview reports whether GitHub is delivering for the tracked repo', async () => {
  const ctx = makeCtx();
  const { server, base } = await listen(ctx);
  const status = async () => (await (await fetch(`${base}/api/overview`)).json()).webhook;
  const log = (event, repo, status, detail = null) => ctx.db
    .prepare('INSERT INTO webhook_events (event, repo, status, detail) VALUES (?, ?, ?, ?)').run(event, repo, status, detail);
  try {
    ctx.db.prepare("UPDATE project_settings SET tracked_repo = 'team/repo'").run();
    assert.equal((await status()).state, 'waiting');

    log('ping', null, 'rejected', 'Invalid or missing signature');
    const failing = await status();
    assert.equal(failing.state, 'failing');
    assert.match(failing.detail, /signature/);

    log('ping', 'Someone/Else', 'accepted', 'ping');
    const other = await status();
    assert.equal(other.state, 'other_repo');
    assert.equal(other.repo_seen, 'Someone/Else');

    log('ping', 'Team/Repo', 'accepted', 'ping');
    const pinged = await status();
    assert.equal(pinged.state, 'connected');
    assert.equal(pinged.last_ok_event, 'ping');

    log('push', 'Team/Repo', 'accepted', 'refs/heads/main');
    assert.equal((await status()).last_ok_event, 'push');
  } finally { server.close(); }
});
