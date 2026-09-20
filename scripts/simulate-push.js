#!/usr/bin/env node
'use strict';
// Sends a correctly signed fake GitHub "push" (or "ping") event to a running
// Commit Doctor server, so you can test without touching GitHub.
//
//   npm run simulate -- --author alice --count 3
//   npm run simulate -- --event ping
//   npm run simulate -- --url https://your-tunnel.example/webhook/github
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, [])
);

const url = args.url || `http://localhost:${process.env.PORT || 3000}/webhook/github`;
const secret = args.secret || process.env.GITHUB_WEBHOOK_SECRET;
const event = args.event || 'push';
const repo = args.repo || process.env.GITHUB_REPO || 'demo-team/demo-repo';
const author = args.author || 'alice';
const count = Math.max(1, parseInt(args.count || '1', 10));
const branch = args.branch || 'main';

if (!secret) {
  console.error('No secret found. Set GITHUB_WEBHOOK_SECRET in .env or pass --secret.');
  process.exit(1);
}

const messages = [
  'Fix off-by-one in pagination', 'Add login form validation', 'Refactor user service',
  'Update README with setup steps', 'Handle empty response from API', 'Tidy up CSS variables',
  'Add unit tests for parser', 'Bump express to latest patch',
];
const sha = () => crypto.randomBytes(20).toString('hex');
const now = Date.now();

const payload =
  event === 'ping'
    ? { zen: 'Keep it logically awesome.', hook_id: 1, repository: { full_name: repo } }
    : {
        ref: `refs/heads/${branch}`,
        repository: { full_name: repo },
        commits: Array.from({ length: count }, (_, i) => {
          const id = sha();
          return {
            id,
            distinct: true,
            message: args.message || messages[Math.floor(Math.random() * messages.length)],
            timestamp: new Date(now - (count - 1 - i) * 60_000).toISOString(),
            url: `https://github.com/${repo}/commit/${id}`,
            author: { name: author, username: author, email: `${author}@example.com` },
          };
        }),
      };

const body = JSON.stringify(payload);
const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-GitHub-Event': event,
    'X-GitHub-Delivery': crypto.randomUUID(),
    'X-Hub-Signature-256': signature,
  },
  body,
})
  .then(async (res) => console.log(`${res.status} ${res.statusText}`, await res.text()))
  .catch((err) => { console.error('Request failed:', err.message); process.exit(1); });
