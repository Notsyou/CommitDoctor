#!/usr/bin/env node
'use strict';
// Fills the database with two weeks of believable fake activity so the
// dashboard has something to show. Safe to run more than once
// (SHAs are random, so it adds more data; delete data/commitdoctor.db to start clean).
const crypto = require('crypto');
const { config } = require('../src/config');
const { openDb } = require('../src/db');
const { createStore } = require('../src/store');
const { generateSummary, catchUp } = require('../src/summary');
const { localDate, addDays, zonedToUtc } = require('../src/time');

const db = openDb(config.dbPath);
const store = createStore(db, config);
const repo = config.repo || 'demo-team/demo-repo';

const people = [
  { username: 'alice', name: 'Alice Reyes', weight: 5 },
  { username: 'bong', name: 'Bong Santos', weight: 3 },
  { username: 'carla', name: 'Carla Dizon', weight: 2 },
  { username: 'dennis', name: 'Dennis Cruz', weight: 1 },
];
const messages = [
  'Add webhook signature check', 'Fix null author on merge commits', 'Style contributor table',
  'Refactor summary builder', 'Add tests for daily aggregation', 'Update README',
  'Handle repeated pushes', 'Tweak dashboard spacing', 'Bump dependencies',
  'Merge pull request #12 from demo-team/feature/dashboard', 'Fix timezone off-by-one',
  'Add index on committed_date', 'Remove unused helper', 'Clean up error messages',
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const pickPerson = () => {
  const total = people.reduce((n, p) => n + p.weight, 0);
  let r = Math.random() * total;
  return people.find((p) => (r -= p.weight) < 0) || people[0];
};

const today = localDate(Date.now(), config.timezone);
const raw = [];
for (let back = 14; back >= 0; back--) {
  const date = addDays(today, -back);
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  const weekend = dow === 0 || dow === 6;
  let n = weekend ? Math.floor(Math.random() * 3) : 2 + Math.floor(Math.random() * 9);
  if (back === 0) n = Math.max(3, Math.floor(n / 2)); // today is partly done
  for (let i = 0; i < n; i++) {
    const p = pickPerson();
    const hour = 9 + Math.floor(Math.random() * 10);
    const when = zonedToUtc(date, hour, Math.floor(Math.random() * 60), config.timezone);
    if (back === 0 && when.getTime() > Date.now()) continue; // no commits from the future
    const sha = crypto.randomBytes(20).toString('hex');
    raw.push({
      sha, repo, branch: 'main', authorName: p.name, authorUsername: p.username,
      authorEmail: `${p.username}@example.com`, message: pick(messages),
      url: `https://github.com/${repo}/commit/${sha}`, timestamp: when.toISOString(), deliveryId: 'seed',
    });
  }
}

const added = store.addMany(raw);
const caught = catchUp(db, config);
console.log(`Seeded ${added} commits across 15 days; saved ${caught.filter((c) => c.saved).length} daily summaries.`);
db.close();
