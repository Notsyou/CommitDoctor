'use strict';
const { addDays, daysBetween, localDate, localTime } = require('./time');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;

/**
 * Turn the commits of one calendar day into a summary object.
 * Pure aggregation over SQLite; no side effects, so it can be used both for the
 * "live" view of today and for the snapshot saved at the end of a day.
 */
function buildSummary(db, config, date) {
  const tz = config.timezone;
  const rows = db
    .prepare('SELECT * FROM commits WHERE committed_date = ? ORDER BY committed_at')
    .all(date);
  const total = rows.length;

  // --- who, how many, when -------------------------------------------------
  const hourly = Array(24).fill(0);
  const byPerson = new Map();
  let merges = 0;
  for (const r of rows) {
    hourly[r.committed_hour] += 1;
    if (r.is_merge) merges += 1;
    let p = byPerson.get(r.contributor);
    if (!p) {
      p = { name: r.contributor, display_name: r.author_name, commits: 0, merges: 0, first_at: r.committed_at, last_at: r.committed_at };
      byPerson.set(r.contributor, p);
    }
    p.commits += 1;
    if (r.is_merge) p.merges += 1;
    p.last_at = r.committed_at;
  }
  const contributors = [...byPerson.values()]
    .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name))
    .map((p) => ({
      name: p.name,
      display_name: p.display_name,
      commits: p.commits,
      merges: p.merges,
      share: total ? p.commits / total : 0,
      first_time: localTime(p.first_at, tz),
      last_time: localTime(p.last_at, tz),
    }));

  const peakCount = Math.max(...hourly);
  const peakHour = total ? hourly.indexOf(peakCount) : null;

  // --- compared to recent days ---------------------------------------------
  // Baseline = average commits per day over the previous N calendar days, but
  // never reaching back before the first commit ever recorded (otherwise a new
  // installation would look permanently "busy" against empty history).
  const n = config.summary.comparisonDays;
  const firstDate = db.prepare('SELECT MIN(committed_date) AS d FROM commits').get().d;
  let start = addDays(date, -n);
  if (firstDate && firstDate > start) start = firstDate;
  const baselineDays = Math.max(0, daysBetween(start, date));

  let comparison = { baseline_days: 0, average: null, delta_pct: null, trend: 'no-baseline' };
  if (baselineDays > 0) {
    const sum = db
      .prepare('SELECT COUNT(*) AS c FROM commits WHERE committed_date >= ? AND committed_date < ?')
      .get(start, date).c;
    const average = sum / baselineDays;
    let trend = 'steady';
    if (average === 0) trend = total > 0 ? 'above' : 'steady';
    else if (total > average * 1.25) trend = 'above';
    else if (total < average * 0.75) trend = 'below';
    comparison = {
      baseline_days: baselineDays,
      average: Math.round(average * 10) / 10,
      delta_pct: average > 0 ? Math.round(((total - average) / average) * 100) : null,
      trend,
    };
  }

  const summary = {
    date,
    timezone: tz,
    total_commits: total,
    contributor_count: contributors.length,
    merge_commits: merges,
    first_commit_time: total ? localTime(rows[0].committed_at, tz) : null,
    last_commit_time: total ? localTime(rows[total - 1].committed_at, tz) : null,
    peak_hour: peakHour,
    hourly,
    contributors,
    comparison,
  };
  summary.headline = writeHeadline(summary);
  return summary;
}

/** One plain sentence or two: the "doctor's note" for the day. */
function writeHeadline(s) {
  if (s.total_commits === 0) return 'No commits were recorded this day.';
  const c = s.comparison;
  let text = `${plural(s.total_commits, 'commit')} from ${plural(s.contributor_count, 'contributor')}`;
  if (c.trend === 'above') {
    text += c.delta_pct != null
      ? `, ${c.delta_pct}% above the ${c.baseline_days}-day average`
      : `, after a quiet ${c.baseline_days}-day stretch`;
  } else if (c.trend === 'below') {
    text += `, ${Math.abs(c.delta_pct)}% below the ${c.baseline_days}-day average`;
  } else if (c.trend === 'steady') {
    text += `, in line with the ${c.baseline_days}-day average`;
  }
  text += '.';
  const top = s.contributors[0];
  text += s.contributor_count > 1
    ? ` ${top.name} was most active with ${top.commits}.`
    : ` All by ${top.name}.`;
  text += ` Activity peaked around ${hourLabel(s.peak_hour)}.`;
  return text;
}

// --- saving ----------------------------------------------------------------

function generateSummary(db, config, date, trigger, { force = false } = {}) {
  const total = db.prepare('SELECT COUNT(*) AS c FROM commits WHERE committed_date = ?').get(date).c;
  const logRun = db.prepare('INSERT INTO summary_runs (date, trigger, outcome, total_commits) VALUES (?, ?, ?, ?)');

  if (total === 0) {
    logRun.run(date, trigger, 'skipped', 0);
    return { saved: false, reason: 'No commits on this day.' };
  }
  if (!force && total < config.summary.minCommits) {
    logRun.run(date, trigger, 'skipped', total);
    return { saved: false, reason: `Only ${total} commit(s); the minimum is ${config.summary.minCommits}.` };
  }

  const data = buildSummary(db, config, date);
  const generatedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO summaries (date, total_commits, data, trigger, generated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET total_commits = excluded.total_commits, data = excluded.data,
       trigger = excluded.trigger, generated_at = excluded.generated_at`
  ).run(date, total, JSON.stringify(data), trigger, generatedAt);
  logRun.run(date, trigger, 'saved', total);
  return { saved: true, summary: { ...data, source: 'saved', trigger, generated_at: generatedAt } };
}

/**
 * Summary for a day as the dashboard should show it:
 * today (or later) is always computed live; past days use the saved snapshot
 * if one exists and fall back to a live computation if not.
 */
function getSummary(db, config, date, now = Date.now()) {
  const today = localDate(now, config.timezone);
  if (date < today) {
    const row = db.prepare('SELECT * FROM summaries WHERE date = ?').get(date);
    if (row) return { ...JSON.parse(row.data), source: 'saved', trigger: row.trigger, generated_at: row.generated_at };
  }
  return { ...buildSummary(db, config, date), source: 'live', trigger: null, generated_at: null };
}

/** Days that have commits but were never summarized (e.g. the server was off at midnight). */
function catchUp(db, config, now = Date.now()) {
  const today = localDate(now, config.timezone);
  const missing = db
    .prepare(
      `SELECT DISTINCT committed_date AS d FROM commits
       WHERE committed_date < ?
         AND committed_date NOT IN (SELECT date FROM summaries)
         AND committed_date NOT IN (SELECT date FROM summary_runs WHERE outcome = 'skipped')
       ORDER BY d`
    )
    .all(today)
    .map((r) => r.d);
  return missing.map((d) => ({ date: d, ...generateSummary(db, config, d, 'catchup') }));
}

/** Commits per day for the last `days` days ending today, zero-filled. */
function getTrend(db, config, days = 14, now = Date.now()) {
  const today = localDate(now, config.timezone);
  const start = addDays(today, -(days - 1));
  const counts = new Map(
    db
      .prepare('SELECT committed_date AS d, COUNT(*) AS c, COUNT(DISTINCT contributor) AS p FROM commits WHERE committed_date >= ? GROUP BY committed_date')
      .all(start)
      .map((r) => [r.d, r])
  );
  const saved = new Set(db.prepare('SELECT date FROM summaries WHERE date >= ?').all(start).map((r) => r.date));
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(start, i);
    const r = counts.get(date);
    return { date, commits: r ? r.c : 0, contributors: r ? r.p : 0, saved: saved.has(date), is_today: date === today };
  });
}

module.exports = { buildSummary, generateSummary, getSummary, catchUp, getTrend };
