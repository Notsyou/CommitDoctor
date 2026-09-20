'use strict';
const crypto = require('crypto');
const { openDb } = require('../src/db');
const { loadConfig } = require('../src/config');

const SECRET = 'test-secret';

function makeCtx(overrides = {}) {
  const config = { ...loadConfig({}), timezone: 'Asia/Manila', webhookSecret: SECRET, repo: '', adminToken: '', ...overrides };
  config.summary = { minCommits: 1, comparisonDays: 7, ...(overrides.summary || {}) };
  return { db: openDb(':memory:'), config };
}

const sign = (body, secret = SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

function pushPayload(commits, repo = 'demo-team/demo-repo') {
  return {
    ref: 'refs/heads/main',
    repository: { full_name: repo },
    commits: commits.map((c) => ({
      id: c.id || crypto.randomBytes(20).toString('hex'),
      distinct: c.distinct,
      message: c.message || 'A commit',
      timestamp: c.timestamp,
      url: 'https://example.com',
      author: { name: c.author || 'alice', username: c.author || 'alice', email: 'a@example.com' },
    })),
  };
}

module.exports = { makeCtx, sign, pushPayload, SECRET };
