'use strict';
const { addDays, daysBetween, localDate } = require('./time');

const round = (n) => Math.round(n * 100) / 100;

/**
 * A deliberately simple, non-ML projection of whether the team is on pace to
 * meet the user-set deadline, based on recent commit rate and recent code
 * churn. This is the "basic linear estimation... an early, lightweight signal
 * rather than a statistically validated forecasting model" the paper scopes
 * this feature to — not a trained or historically-calibrated predictor.
 *
 * Method:
 *  - pace_ratio = (commits/day over the last N days) / (commits/day over the
 *    whole project so far). Below 1 means slowing down relative to the
 *    project's own history.
 *  - churn_ratio = deletions / (additions + deletions) over the same recent
 *    window, using line-level churn where known (polled repos) and falling
 *    back to a files-removed proportion where it isn't (webhook-only repos).
 *    High churn suggests rework/instability rather than net progress.
 *  - status is on-pace / at-risk / behind from pace_ratio alone, then nudged
 *    down one tier if churn is heavily skewed toward deletions.
 */
function predictDeadline(db, config, date = localDate(Date.now(), config.timezone)) {
  const settings = db.prepare('SELECT deadline_date FROM project_settings WHERE id = 1').get();
  const deadline_date = settings ? settings.deadline_date : null;
  if (!deadline_date) return { date, deadline_date: null, status: 'no-deadline', urgency: 'none' };

  const first = db.prepare('SELECT MIN(committed_date) AS d FROM commits').get().d;
  if (!first) return { date, deadline_date, days_remaining: daysBetween(date, deadline_date), status: 'insufficient-data', urgency: 'none' };

  const days_remaining = daysBetween(date, deadline_date);

  const n = config.summary.comparisonDays;
  let windowStart = addDays(date, -n);
  if (first > windowStart) windowStart = first;
  const windowDays = Math.max(1, daysBetween(windowStart, date));

  const recentCount = db
    .prepare('SELECT COUNT(*) AS c FROM commits WHERE committed_date >= ? AND committed_date <= ?')
    .get(windowStart, date).c;
  const recentRate = recentCount / windowDays;

  const totalDays = Math.max(1, daysBetween(first, date));
  const totalCount = db.prepare('SELECT COUNT(*) AS c FROM commits').get().c;
  const overallRate = totalCount / totalDays;

  const paceRatio = overallRate > 0 ? recentRate / overallRate : (recentRate > 0 ? 1 : 0);

  const churnRows = db
    .prepare(
      `SELECT lines_added, lines_deleted, files_added, files_removed, files_modified
       FROM commits WHERE committed_date >= ? AND committed_date <= ?`
    )
    .all(windowStart, date);

  let linesAdded = 0;
  let linesDeleted = 0;
  let haveLineData = false;
  let filesAdded = 0;
  let filesRemoved = 0;
  let filesModified = 0;
  for (const r of churnRows) {
    if (r.lines_added != null && r.lines_deleted != null) {
      linesAdded += r.lines_added;
      linesDeleted += r.lines_deleted;
      haveLineData = true;
    }
    filesAdded += r.files_added || 0;
    filesRemoved += r.files_removed || 0;
    filesModified += r.files_modified || 0;
  }

  let churnRatio = null;
  let churnBasis = null;
  if (haveLineData && linesAdded + linesDeleted > 0) {
    churnRatio = linesDeleted / (linesAdded + linesDeleted);
    churnBasis = 'lines';
  } else if (filesAdded + filesRemoved + filesModified > 0) {
    churnRatio = filesRemoved / (filesAdded + filesRemoved + filesModified);
    churnBasis = 'files';
  }

  let status;
  if (days_remaining < 0) status = 'deadline-passed';
  else if (paceRatio >= 0.75) status = 'on-pace';
  else if (paceRatio >= 0.4) status = 'at-risk';
  else status = 'behind';

  if (status === 'on-pace' && churnRatio != null && churnRatio > 0.6) status = 'at-risk';

  return {
    date,
    deadline_date,
    days_remaining,
    window_days: windowDays,
    recent_commit_rate: round(recentRate),
    overall_commit_rate: round(overallRate),
    pace_ratio: round(paceRatio),
    churn_ratio: churnRatio == null ? null : round(churnRatio),
    churn_basis: churnBasis,
    status,
    urgency: urgencyForStatus(status, days_remaining),
  };
}

function urgencyForStatus(status, days_remaining){
  if (status !== 'at-risk' && status !== 'behind') return 'none';
  if (days_remaining == null || days_remaining > 7) return 'none';
  if (days_remaining <= 1) return 'final';
  if (days_remaining <= 3) return 'urgent';
  return 'reminder';
}
module.exports = { predictDeadline, urgencyForStatus };