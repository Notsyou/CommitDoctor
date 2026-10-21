'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { makeCtx } = require('./helpers');
const { createStore } = require('../src/store');
const { encryptToken } = require('../src/crypto');
const { pollOneRepo } = require('../src/poller');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

const apiCommit = (sha, date) => ({
  sha, html_url: `https://github.com/o/r/commit/${sha}`, author: { login: 'alice' },
  commit: { message: 'work', author: { name: 'Alice', email: 'a@example.com', date } },
});
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const quiet = { info() {}, error() {} };

test('a commit made before the last poll but pushed after it is still picked up', async () => {
  const key = crypto.randomBytes(32).toString('hex');
  const { db, config } = makeCtx({ tokenEncryptionKey: key });
  const oldSha = 'a'.repeat(40);
  const lateSha = 'b'.repeat(40);
  createStore(db, config).addCommit({ sha: oldSha, repo: 'o/r', authorName: 'Alice', message: 'old', timestamp: '2026-10-21T02:00:00Z' });
  db.prepare("INSERT INTO tracked_repos (repo, token_enc, default_branch, last_since) VALUES ('o/r', ?, 'main', '2026-10-21T03:10:00Z')")
    .run(encryptToken('t', key));

  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/commits?')) {
      // Committed at 03:06, before the 03:10 cursor, but only pushed now.
      return json([apiCommit(lateSha, '2026-10-21T03:06:29Z'), apiCommit(oldSha, '2026-10-21T02:00:00Z')]);
    }
    return json({ files: [{ status: 'modified' }], stats: { additions: 5, deletions: 1 } });
  };

  const row = db.prepare('SELECT * FROM tracked_repos').get();
  const result = await pollOneRepo({ db, config, row, log: quiet });

  assert.deepEqual(result, { ok: true, added: 1 });
  const since = new URL(calls[0]).searchParams.get('since');
  assert.ok(since < '2026-10-21T03:06:29Z', `since=${since} should reach back before the late commit`);
  const detailCalls = calls.filter((u) => u.includes('/commits/'));
  assert.deepEqual(detailCalls.map((u) => u.split('/').pop()), [lateSha]); // stored commit is not re-fetched
  const stored = db.prepare('SELECT lines_added FROM commits WHERE sha = ?').get(lateSha);
  assert.equal(stored.lines_added, 5);
});
