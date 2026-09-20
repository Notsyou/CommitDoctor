'use strict';
const fs = require('fs');
const path = require('path');
// Node's built-in SQLite (Node 22.13+). No native compilation, nothing extra to install.
const { DatabaseSync } = require('node:sqlite');

// Four tables:
//   commits         the raw material (one row per unique commit SHA)
//   summaries       one saved summary per day (JSON snapshot)
//   webhook_events  every delivery GitHub sent us, accepted or not
//   summary_runs    every attempt to generate a summary, saved or skipped
// The last two are the prototype's own activity log (research question 4).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS commits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sha             TEXT    NOT NULL UNIQUE,
  repo            TEXT    NOT NULL,
  branch          TEXT,
  author_name     TEXT    NOT NULL,
  author_username TEXT,
  author_email    TEXT,
  contributor     TEXT    NOT NULL,
  message         TEXT    NOT NULL,
  url             TEXT,
  is_merge        INTEGER NOT NULL DEFAULT 0,
  committed_at    TEXT    NOT NULL,
  committed_date  TEXT    NOT NULL,
  committed_hour  INTEGER NOT NULL,
  delivery_id     TEXT,
  received_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_commits_date ON commits(committed_date);

CREATE TABLE IF NOT EXISTS summaries (
  date          TEXT PRIMARY KEY,
  total_commits INTEGER NOT NULL,
  data          TEXT    NOT NULL,
  trigger       TEXT    NOT NULL,
  generated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id      TEXT,
  event            TEXT,
  repo             TEXT,
  status           TEXT NOT NULL,
  detail           TEXT,
  commits_received INTEGER NOT NULL DEFAULT 0,
  commits_new      INTEGER NOT NULL DEFAULT 0,
  received_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS summary_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  total_commits INTEGER NOT NULL DEFAULT 0,
  run_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** Wrap fn so all its writes succeed together or not at all. */
function transaction(db, fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}

module.exports = { openDb, transaction };
