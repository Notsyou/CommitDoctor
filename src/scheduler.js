'use strict';
const { localDate } = require('./time');
const { generateSummary, catchUp } = require('./summary');

/**
 * Saves each day's summary when the day ends.
 * No cron dependency: once every 30 s we compare "today" (in the configured
 * timezone) with the day we last saw. When it changes, the day that just
 * finished is summarized. On startup, catchUp() covers any days missed while
 * the server was down.
 */
function startScheduler({ db, config, log = console, intervalMs = 30_000 }) {
  const caught = catchUp(db, config);
  const saved = caught.filter((c) => c.saved).length;
  if (caught.length) log.info(`[scheduler] catch-up: ${saved} of ${caught.length} missed day(s) summarized`);

  let lastDate = localDate(Date.now(), config.timezone);
  const timer = setInterval(() => {
    const today = localDate(Date.now(), config.timezone);
    if (today === lastDate) return;
    const result = generateSummary(db, config, lastDate, 'scheduled');
    log.info(`[scheduler] ${lastDate}: ${result.saved ? 'summary saved' : `skipped (${result.reason})`}`);
    lastDate = today;
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startScheduler };
