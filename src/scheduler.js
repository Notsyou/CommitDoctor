'use strict';
const { localDate } = require('./time');
const { generateSummary, catchUp } = require('./summary');
const { notifyFlags, checkDeadlineUrgency } = require('./notify');

/**
 * Saves each day's summary when the day ends.
 * No cron dependency: once every 30 s we compare "today" (in the configured
 * timezone) with the day we last saw. When it changes, the day that just
 * finished is summarized. catchUp() also runs every tick, so days missed while
 * the server was down, and commits pushed late for an already-summarized day,
 * are folded in.
 */
function startScheduler({ db, config, mailer = null, log = console, intervalMs = 30_000 }) {
  const runCatchUp = () => {
    try {
      const caught = catchUp(db, config);
      if (caught.length) {
        const saved = caught.filter((c) => c.saved).length;
        log.info(`[scheduler] catch-up: ${saved} of ${caught.length} day(s) summarized or refreshed`);
      }
    } catch (err) {
      log.error(`[scheduler] catch-up failed: ${err.message}`);
    }
  };
  runCatchUp();

  let lastDate = localDate(Date.now(), config.timezone);
  let checkingDeadline = false;

  const timer = setInterval(() => {
    if (mailer && !checkingDeadline) {
      checkingDeadline = true;
      checkDeadlineUrgency(db, config, mailer, log)
        .catch((err) => log.error(`[scheduler] deadline check failed: ${err.message}`))
        .finally(() => { checkingDeadline = false; });
    }

    const today = localDate(Date.now(), config.timezone);
    if (today !== lastDate) {
      try {
        const result = generateSummary(db, config, lastDate, 'scheduled');
        log.info(`[scheduler] ${lastDate}: ${result.saved ? 'summary saved' : `skipped (${result.reason})`}`);
        if ((result.saved || result.flagged) && mailer) {
          const flags = db.prepare('SELECT type, detail FROM flags WHERE date = ?').all(lastDate);
          notifyFlags(db, config, mailer, lastDate, flags, log)
            .catch((err) => log.error(`[scheduler] flag email failed: ${err.message}`));
        }
        lastDate = today;
      } catch (err) {
        // Don't let one bad tick crash the process; lastDate stays put so the next tick retries.
        log.error(`[scheduler] could not summarize ${lastDate}: ${err.message}`);
        return;
      }
    }
    runCatchUp();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startScheduler };
