'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { makeCtx } = require('./helpers');
const { createStore } = require('../src/store');
const { buildSummary, generateSummary, catchUp, getSummary, getTrend } = require('../src/summary');
const { zonedToUtc, localDate } = require('../src/time');

const TZ = 'Asia/Manila';
const commit = (date, hour, who, extra = {}) => ({
  sha: crypto.randomBytes(20).toString('hex'), repo: 'r/r', branch: 'main',
  authorName: who, authorUsername: who, message: 'work',
  timestamp: zonedToUtc(date, hour, 0, TZ).toISOString(), ...extra,
});

test('a commit at 23:30 Manila time belongs to that Manila day, not the UTC day', () => {
  const { db, config } = makeCtx();
  const store = createStore(db, config);
  store.addCommit(commit('2026-09-19', 23, 'alice'));
  const row = db.prepare('SELECT committed_date, committed_hour FROM commits').get();
  assert.equal(row.committed_date, '2026-09-19');
  assert.equal(row.committed_hour, 23);
});

test('duplicate SHAs are stored once', () => {
  const { db, config } = makeCtx();
  const store = createStore(db, config);
  const c = commit('2026-09-19', 10, 'alice');
  assert.equal(store.addMany([c, c]), 1);
  assert.equal(store.addMany([c]), 0);
});

test('summary counts commits per contributor, by hour, and detects merges', () => {
  const { db, config } = makeCtx();
  const store = createStore(db, config);
  store.addMany([
    commit('2026-09-19', 9, 'alice'), commit('2026-09-19', 14, 'alice'),
    commit('2026-09-19', 14, 'bong', { message: 'Merge pull request #3 from x/y' }),
  ]);
  const s = buildSummary(db, config, '2026-09-19');
  assert.equal(s.total_commits, 3);
  assert.equal(s.contributor_count, 2);
  assert.equal(s.contributors[0].name, 'alice');
  assert.equal(s.contributors[0].commits, 2);
  assert.equal(s.merge_commits, 1);
  assert.equal(s.hourly[14], 2);
  assert.equal(s.peak_hour, 14);
  assert.equal(s.first_commit_time, '09:00');
  assert.match(s.headline, /3 commits from 2 contributors/);
});

test('comparison uses only days since the first commit, and flags a busy day', () => {
  const { db, config } = makeCtx();
  const store = createStore(db, config);
  store.addMany([commit('2026-09-16', 10, 'a'), commit('2026-09-17', 10, 'a'), commit('2026-09-18', 10, 'a')]);
  for (let i = 0; i < 6; i++) store.addCommit(commit('2026-09-19', 10 + i, 'a'));
  const s = buildSummary(db, config, '2026-09-19');
  assert.equal(s.comparison.baseline_days, 3);      // 16th, 17th, 18th; not 7 days of empty history
  assert.equal(s.comparison.average, 1);
  assert.equal(s.comparison.trend, 'above');
  assert.equal(s.comparison.delta_pct, 500);
});

test('the very first day has no baseline', () => {
  const { db, config } = makeCtx();
  createStore(db, config).addCommit(commit('2026-09-19', 10, 'a'));
  assert.equal(buildSummary(db, config, '2026-09-19').comparison.trend, 'no-baseline');
});

test('minimum-activity rule: below threshold is skipped and logged, forced is saved', () => {
  const { db, config } = makeCtx({ summary: { minCommits: 3, comparisonDays: 7 } });
  const store = createStore(db, config);
  store.addMany([commit('2026-09-19', 9, 'a'), commit('2026-09-19', 10, 'a')]);
  assert.equal(generateSummary(db, config, '2026-09-19', 'scheduled').saved, false);
  assert.equal(db.prepare("SELECT outcome FROM summary_runs").get().outcome, 'skipped');
  assert.equal(generateSummary(db, config, '2026-09-19', 'manual', { force: true }).saved, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM summaries').get().c, 1);
});

test('catch-up summarizes missed past days once, never today', () => {
  const { db, config } = makeCtx();
  const store = createStore(db, config);
  const now = Date.parse('2026-09-20T12:00:00+08:00');
  store.addMany([commit('2026-09-18', 9, 'a'), commit('2026-09-19', 9, 'a'), commit('2026-09-20', 9, 'a')]);
  assert.equal(catchUp(db, config, now).length, 2);
  assert.equal(catchUp(db, config, now).length, 0);
  assert.equal(getSummary(db, config, '2026-09-20', now).source, 'live');
  assert.equal(getSummary(db, config, '2026-09-19', now).source, 'saved');
});

test('trend is zero-filled and marks today', () => {
  const { db, config } = makeCtx();
  const now = Date.parse('2026-09-20T12:00:00+08:00');
  createStore(db, config).addCommit(commit('2026-09-19', 9, 'a'));
  const t = getTrend(db, config, 3, now);
  assert.deepEqual(t.map((d) => [d.date, d.commits]), [['2026-09-18', 0], ['2026-09-19', 1], ['2026-09-20', 0]]);
  assert.equal(t[2].is_today, true);
  assert.equal(localDate(now, TZ), '2026-09-20');
});
