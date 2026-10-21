'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { makeCtx } = require('./helpers');
const { createStore } = require('../src/store');
const { buildSummary, detectFlags, generateSummary } = require('../src/summary');
const { predictDeadline } = require('../src/predict');
const { zonedToUtc, addDays } = require('../src/time');

const TZ = 'Asia/Manila';
const START = '2026-09-01';
const commit = (date, hour, who, extra = {}) => ({
  sha: crypto.randomBytes(20).toString('hex'), repo: 'r/r', branch: 'main',
  authorName: who, authorUsername: who, message: 'work',
  timestamp: zonedToUtc(date, hour, 0, TZ).toISOString(), ...extra,
});
const setDeadline = (db, date) => db.prepare('UPDATE project_settings SET deadline_date = ? WHERE id = 1').run(date);
const flagTypes = (db, config, date) => detectFlags(db, config, date, buildSummary(db, config, date)).map((f) => f.type);

// --- rolling-baseline flags --------------------------------------------------

test('a day well below the baseline is flagged', () => {
  const { db, config } = makeCtx();
  const store = createStore(db, config);
  for (let i = 0; i < 7; i++) for (let h = 0; h < 4; h++) store.addCommit(commit(addDays(START, i), 9 + h, 'a'));
  store.addCommit(commit(addDays(START, 7), 9, 'a'));
  assert.deepEqual(flagTypes(db, config, addDays(START, 7)), ['activity_below_baseline']);
});

test('a day in line with the baseline raises no flags', () => {
  const { db, config } = makeCtx();
  const store = createStore(db, config);
  for (let i = 0; i <= 7; i++) for (let h = 0; h < 3; h++) store.addCommit(commit(addDays(START, i), 9 + h, 'a'));
  assert.deepEqual(flagTypes(db, config, addDays(START, 7)), []);
});

test('a contributor quiet for a full comparison window is flagged, an active one is not', () => {
  const { db, config } = makeCtx();
  const store = createStore(db, config);
  store.addCommit(commit(START, 10, 'bob'));
  for (let i = 0; i <= 8; i++) store.addCommit(commit(addDays(START, i), 9, 'alice'));
  const flags = detectFlags(db, config, addDays(START, 8), buildSummary(db, config, addDays(START, 8)));
  const inactive = flags.filter((f) => f.type === 'contributor_inactive');
  assert.equal(inactive.length, 1);
  assert.match(inactive[0].detail, /^bob has had no commits since 2026-09-01 \(8 days\)/);
});

test('saving a summary stores its flags, and re-saving replaces them', () => {
  const { db, config } = makeCtx();
  const store = createStore(db, config);
  store.addCommit(commit(START, 9, 'a'));
  for (let h = 0; h < 5; h++) store.addCommit(commit(addDays(START, 1), 9 + h, 'a'));
  generateSummary(db, config, addDays(START, 1), 'manual');
  generateSummary(db, config, addDays(START, 1), 'manual');
  const rows = db.prepare('SELECT type FROM flags WHERE date = ?').all(addDays(START, 1));
  assert.deepEqual(rows.map((r) => r.type), ['activity_above_baseline']);
});

// --- deadline prediction ------------------------------------------------------

test('no deadline set means no prediction', () => {
  const { db, config } = makeCtx();
  assert.equal(predictDeadline(db, config, START).status, 'no-deadline');
});

test('a deadline with no commits yet is insufficient data', () => {
  const { db, config } = makeCtx();
  setDeadline(db, addDays(START, 10));
  const p = predictDeadline(db, config, START);
  assert.equal(p.status, 'insufficient-data');
  assert.equal(p.days_remaining, 10);
});

test('a steady pace is on-pace', () => {
  const { db, config } = makeCtx();
  const store = createStore(db, config);
  for (let i = 0; i < 30; i++) store.addCommit(commit(addDays(START, i), 10, 'a'));
  setDeadline(db, addDays(START, 45));
  const p = predictDeadline(db, config, addDays(START, 29));
  assert.equal(p.status, 'on-pace');
  assert.equal(p.days_remaining, 16);
});

test('activity that stopped weeks ago is behind', () => {
  const { db, config } = makeCtx();
  const store = createStore(db, config);
  for (let i = 0; i < 20; i++) store.addCommit(commit(addDays(START, i), 10, 'a'));
  setDeadline(db, addDays(START, 70));
  const p = predictDeadline(db, config, addDays(START, 50));
  assert.equal(p.status, 'behind');
  assert.equal(p.pace_ratio, 0);
});

test('a slowdown to about half the usual pace is at-risk', () => {
  const { db, config } = makeCtx();
  const store = createStore(db, config);
  for (let i = 0; i < 30; i++) {
    store.addCommit(commit(addDays(START, i), 10, 'a'));
    store.addCommit(commit(addDays(START, i), 11, 'a'));
  }
  for (let i = 30; i < 51; i++) if (i % 2) store.addCommit(commit(addDays(START, i), 10, 'a'));
  setDeadline(db, addDays(START, 70));
  const p = predictDeadline(db, config, addDays(START, 50));
  assert.equal(p.status, 'at-risk');
});

test('heavy deletion churn turns on-pace into at-risk', () => {
  const { db, config } = makeCtx();
  const store = createStore(db, config);
  for (let i = 0; i < 30; i++) store.addCommit(commit(addDays(START, i), 10, 'a', { linesAdded: 10, linesDeleted: 90 }));
  setDeadline(db, addDays(START, 45));
  const p = predictDeadline(db, config, addDays(START, 29));
  assert.equal(p.churn_basis, 'lines');
  assert.equal(p.churn_ratio, 0.9);
  assert.equal(p.status, 'at-risk');
});

test('a past deadline is reported as passed', () => {
  const { db, config } = makeCtx();
  createStore(db, config).addCommit(commit(START, 10, 'a'));
  setDeadline(db, START);
  assert.equal(predictDeadline(db, config, addDays(START, 3)).status, 'deadline-passed');
});

test('prediction uses its own 21-day window, not the 7-day summary baseline', () => {
  const { db, config } = makeCtx();
  const store = createStore(db, config);
  for (let i = 0; i < 40; i++) store.addCommit(commit(addDays(START, i), 10, 'a'));
  setDeadline(db, addDays(START, 60));
  assert.equal(config.summary.comparisonDays, 7);
  assert.equal(predictDeadline(db, config, addDays(START, 39)).window_days, 21);
});

test('saving a summary while behind pace stores a deadline flag', () => {
  const { db, config } = makeCtx();
  const store = createStore(db, config);
  for (let i = 0; i < 20; i++) for (let h = 0; h < 3; h++) store.addCommit(commit(addDays(START, i), 9 + h, 'a'));
  store.addCommit(commit(addDays(START, 50), 10, 'a'));
  setDeadline(db, addDays(START, 70));
  generateSummary(db, config, addDays(START, 50), 'manual');
  const types = db.prepare('SELECT type FROM flags WHERE date = ?').all(addDays(START, 50)).map((r) => r.type);
  assert.ok(types.includes('deadline_behind'), `expected deadline_behind in ${types}`);
});
