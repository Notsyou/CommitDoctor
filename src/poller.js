'use strict';
const { decryptToken } = require('./crypto');
const { createStore } = require('./store');

const API = 'https://api.github.com';
const UA = 'CommitDoctor';

const STATUS_ADDED = new Set(['added', 'copied']);
const STATUS_REMOVED = new Set(['removed']);
const STATUS_MODIFIED = new Set(['modified', 'renamed', 'changed']);

/**
 * Map one commit from GitHub's `GET /repos/:repo/commits` response to
 * store.addCommit's shape. `detail`, when given, is the response of
 * `GET /repos/:repo/commits/:sha` (fetchCommitDetail below) and supplies
 * line-level and file-level churn; without it only the base fields are set.
 */
function parseApiCommit(c, repo, branch, detail) {
  const commit = c.commit || {};
  const author = commit.author || {};
  const base = {
    sha: c.sha,
    repo,
    branch,
    authorName: author.name,
    authorUsername: c.author && c.author.login,
    authorEmail: author.email,
    message: commit.message,
    url: c.html_url,
    // GitHub's REST commit list has no `distinct` flag and can include merge
    // commits; store.js's own MERGE_RE (checked against the message) still
    // tags merges, so nothing extra is needed here.
    timestamp: author.date,
    deliveryId: null,
  };
  if (!detail) return base;
  const files = Array.isArray(detail.files) ? detail.files : [];
  const stats = detail.stats || {};
  return {
    ...base,
    filesAdded: files.filter((f) => STATUS_ADDED.has(f.status)).length,
    filesRemoved: files.filter((f) => STATUS_REMOVED.has(f.status)).length,
    filesModified: files.filter((f) => STATUS_MODIFIED.has(f.status)).length,
    linesAdded: stats.additions,
    linesDeleted: stats.deletions,
  };
}

/** One extra call per new commit: line-level stats + per-file status. */
async function fetchCommitDetail(repo, sha, token) {
  const res = await ghFetch(`${API}/repos/${repo}/commits/${sha}`, token);
  return res.json();
}

/** Follow the Link header for `rel="next"`, GitHub's pagination format. */
function nextUrl(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.split(',').find((part) => /rel="next"/.test(part));
  if (!match) return null;
  const m = match.match(/<([^>]+)>/);
  return m ? m[1] : null;
}

async function ghFetch(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': UA,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 401 || res.status === 403) {
    const body = await res.json().catch(() => ({}));
    const rateLimited = res.headers.get('x-ratelimit-remaining') === '0';
    const err = new Error(rateLimited ? 'Rate limited by GitHub. Will retry next cycle.' : (body.message || 'Bad token or insufficient permissions.'));
    err.status = res.status;
    throw err;
  }
  if (res.status === 404) {
    const err = new Error('Repository not found, or the token cannot see it.');
    err.status = 404;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`GitHub API returned ${res.status}.`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/** One real call used to validate a repo+token pair before saving it. */
async function testRepoAccess(repo, token) {
  const res = await ghFetch(`${API}/repos/${repo}`, token);
  const data = await res.json();
  return { defaultBranch: data.default_branch || 'main', private: Boolean(data.private) };
}

/** Fetch every new commit for one tracked repo since its stored cursor. */
async function fetchNewCommits(repo, token, since) {
  const commits = [];
  let url = `${API}/repos/${repo}/commits?per_page=100${since ? `&since=${encodeURIComponent(since)}` : ''}`;
  // GitHub returns newest-first; cap pages so one huge backlog can't block the poller forever.
  for (let page = 0; page < 10 && url; page += 1) {
    const res = await ghFetch(url, token);
    const batch = await res.json();
    commits.push(...batch);
    url = nextUrl(res.headers.get('link'));
  }
  return commits;
}

function startPoller({ db, config, log = console, intervalMs = 3 * 60_000 }) {
  const store = createStore(db, config);
  const listActive = db.prepare('SELECT * FROM tracked_repos WHERE active = 1');
  const touch = db.prepare(
    `UPDATE tracked_repos SET last_since = ?, last_polled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       last_error = ?, default_branch = COALESCE(?, default_branch) WHERE id = ?`
  );

  async function pollOne(row) {
    let token;
    try {
      token = decryptToken(row.token_enc, config.tokenEncryptionKey);
    } catch (err) {
      touch.run(row.last_since, `Cannot decrypt stored token: ${err.message}`, null, row.id);
      return;
    }
    try {
      let branch = row.default_branch;
      if (!branch) ({ defaultBranch: branch } = await testRepoAccess(row.repo, token));
      const nowIso = new Date().toISOString();
      const raw = await fetchNewCommits(row.repo, token, row.last_since);
      const fresh = raw.filter((c) => c && c.sha);
      // One detail call per new commit for churn stats. `since` already limits
      // the list to commits newer than the last poll, so this is bounded by
      // how much actually landed since then, not the whole repo history.
      const mapped = [];
      for (const c of fresh) {
        let detail;
        try {
          // eslint-disable-next-line no-await-in-loop
          detail = await fetchCommitDetail(row.repo, c.sha, token);
        } catch (detailErr) {
          log.info(`[poller] ${row.repo}: could not fetch churn detail for ${c.sha.slice(0, 7)}: ${detailErr.message}`);
        }
        mapped.push(parseApiCommit(c, row.repo, branch, detail));
      }
      const added = store.addMany(mapped);
      touch.run(nowIso, null, branch, row.id);
      if (added) log.info(`[poller] ${row.repo}: stored ${added} new commit(s)`);
    } catch (err) {
      touch.run(row.last_since, err.message, null, row.id);
      log.info(`[poller] ${row.repo}: ${err.message}`);
    }
  }

  async function pollAll() {
    const rows = listActive.all();
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await pollOne(row);
    }
  }

  pollAll().catch((err) => log.error('[poller] startup pass failed', err));
  const timer = setInterval(() => { pollAll().catch((err) => log.error('[poller] pass failed', err)); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startPoller, testRepoAccess, parseApiCommit, fetchCommitDetail, nextUrl };