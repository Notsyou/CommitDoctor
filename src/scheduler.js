'use strict';
const { localDate } = require('./time');
const { generateSummary, catchUp } = require('./summary');
const{notifyFlags, checkDeadlineUrgency} = require('./notify');

/**
 * Saves each day's summary when the day ends.
 * No cron dependency: once every 30 s we compare "today" (in the configured
 * timezone) with the day we last saw. When it changes, the day that just
 * finished is summarized. On startup, catchUp() covers any days missed while
 * the server was down.
 */
function startScheduler({ db, config, mailer = null, log = console, intervalMs = 30_000 }) {
  const caught = catchUp(db, config);
  const saved = caught.filter((c) => c.saved).length;
  if (caught.length) log.info(`[scheduler] catch-up: ${saved} of ${caught.length} missed day(s) summarized`);

  let lastDate = localDate(Date.now(), config.timezone);
  let checkingDeadline = false;

  const timer = setInterval(() => {

    if (mailer && !checkingDeadline){
      checkingDeadline = true;
      checkDeadlineUrgency(db, config, mailer, log).catch((err) => log.error(`[scheduler] deadline check failed: ${err.message}`)).finally(() => {checkingDeadline = false;});
    }

    const today = localDate(Date.now(), config.timezone);
    if (today === lastDate) return;
    const result = generateSummary(db, config, lastDate, 'scheduled');
    log.info(`[scheduler] ${lastDate}: ${result.saved ? 'summary saved' : `skipped (${result.reason})`}`);
    if (result.saved && mailer){
      const flags = db.prepare('SELECT type, detail FROM flags WHERE date = ?').all(lastDate);
      notifyFlags(db, config, mailer, lastDate, flags, log).catch((err) => log.error(`[scheduler] flag email failed: ${err.message}`));
    }
    lastDate = today;
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startScheduler };
