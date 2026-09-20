'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx, sign, pushPayload } = require('./helpers');
const { createApp } = require('../src/app');

let server, base, ctx;
before(async () => {
  ctx = makeCtx({ repo: 'demo-team/demo-repo' });
  server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const send = (payload, { event = 'push', signature, raw } = {}) => {
  const body = raw ?? JSON.stringify(payload);
  return fetch(`${base}/webhook/github`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': 'd-' + Math.random(),
      'X-Hub-Signature-256': signature ?? sign(body),
    },
    body,
  });
};
const count = () => ctx.db.prepare('SELECT COUNT(*) c FROM commits').get().c;
const now = new Date().toISOString();

test('ping is accepted', async () => {
  const res = await send({ zen: 'x', repository: { full_name: 'demo-team/demo-repo' } }, { event: 'ping' });
  assert.equal(res.status, 200);
});

test('a bad signature is rejected, stores nothing, and is logged', async () => {
  const before = count();
  const res = await send(pushPayload([{ timestamp: now }]), { signature: 'sha256=' + '0'.repeat(64) });
  assert.equal(res.status, 401);
  assert.equal(count(), before);
  assert.equal(ctx.db.prepare("SELECT status FROM webhook_events ORDER BY id DESC LIMIT 1").get().status, 'rejected');
});

test('a missing signature is rejected', async () => {
  const body = JSON.stringify(pushPayload([{ timestamp: now }]));
  const res = await fetch(`${base}/webhook/github`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push' }, body,
  });
  assert.equal(res.status, 401);
});

test('a signed push stores its commits; redelivery does not double count', async () => {
  const payload = pushPayload([{ id: 'a'.repeat(40), timestamp: now }, { id: 'b'.repeat(40), timestamp: now, author: 'bong' }]);
  const first = await (await send(payload)).json();
  assert.deepEqual([first.received, first.stored], [2, 2]);
  const again = await (await send(payload)).json();
  assert.deepEqual([again.received, again.stored], [2, 0]);
  assert.equal(count(), 2);
});

test('distinct:false commits (already in the repo) are skipped', async () => {
  const before = count();
  const res = await (await send(pushPayload([{ timestamp: now, distinct: false }, { timestamp: now }]))).json();
  assert.equal(res.stored, 1);
  assert.equal(count(), before + 1);
});

test('events from another repository are ignored', async () => {
  const before = count();
  const res = await send(pushPayload([{ timestamp: now }], 'someone/else'));
  assert.equal(res.status, 202);
  assert.equal(count(), before);
});

test('non-push events are ignored', async () => {
  const res = await send({ action: 'opened', repository: { full_name: 'demo-team/demo-repo' } }, { event: 'issues' });
  assert.equal(res.status, 202);
});

test('the API reports what was stored', async () => {
  const overview = await (await fetch(`${base}/api/overview`)).json();
  assert.ok(overview.totals.commits >= 3);
  const commits = await (await fetch(`${base}/api/commits`)).json();
  assert.ok(commits.length >= 3);
  const bad = await fetch(`${base}/api/summaries/not-a-date`);
  assert.equal(bad.status, 400);
});
