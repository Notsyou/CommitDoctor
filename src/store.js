'use strict';
const { localDate, localHour } = require('./time');
const { transaction } = require('./db');

const MERGE_RE = /^Merge (pull request|branch|remote-tracking branch)\b/i;

/**
 * Write side of the commits table.
 * A "raw" commit is what the webhook parser (or the seed script) produces:
 * { sha, repo, branch, authorName, authorUsername, authorEmail, message, url, timestamp, deliveryId }
 */
function createStore(db, config) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO commits
      (sha, repo, branch, author_name, author_username, author_email, contributor,
       message, url, is_merge, committed_at, committed_date, committed_hour, delivery_id)
    VALUES
      (@sha, @repo, @branch, @author_name, @author_username, @author_email, @contributor,
       @message, @url, @is_merge, @committed_at, @committed_date, @committed_hour, @delivery_id)
  `);

  /** Returns 1 if the commit was new, 0 if this SHA was already stored. */
  function addCommit(c) {
    const when = new Date(c.timestamp);
    if (Number.isNaN(when.getTime())) return 0;
    const contributor = c.authorUsername || c.authorName || c.authorEmail || 'unknown';
    const message = String(c.message || '').trim();
    return insert.run({
      sha: c.sha,
      repo: c.repo,
      branch: c.branch || null,
      author_name: c.authorName || contributor,
      author_username: c.authorUsername || null,
      author_email: c.authorEmail || null,
      contributor,
      message,
      url: c.url || null,
      is_merge: MERGE_RE.test(message) ? 1 : 0,
      committed_at: when.toISOString(),
      committed_date: localDate(when, config.timezone),
      committed_hour: localHour(when, config.timezone),
      delivery_id: c.deliveryId || null,
    }).changes;
  }

  const addMany = transaction(db, (list) => list.reduce((n, c) => n + addCommit(c), 0));

  return { addCommit, addMany };
}

module.exports = { createStore };
