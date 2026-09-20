'use strict';
// Every "day" in Commit Doctor is a calendar day in the configured timezone,
// stored as a plain YYYY-MM-DD string. These helpers are the only place
// where timezone maths happens.

const dateFmt = (tz) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });

/** "2026-09-20" for the given instant, as seen in `tz`. */
function localDate(input, tz) {
  return dateFmt(tz).format(new Date(input));
}

/** Hour of day (0-23) for the given instant, as seen in `tz`. */
function localHour(input, tz) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(
    new Date(input)
  );
  return parseInt(h, 10);
}

/** "14:05" for the given instant, as seen in `tz`. */
function localTime(input, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(input));
}

/** Add (or subtract) whole days to a YYYY-MM-DD string. */
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a) for two YYYY-MM-DD strings. */
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function tzOffsetMs(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** The UTC instant at which it is `hour:minute` on `dateStr` in `tz`. */
function zonedToUtc(dateStr, hour, minute, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  return new Date(guess - tzOffsetMs(guess, tz));
}

const isDateStr = (s) =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

module.exports = { localDate, localHour, localTime, addDays, daysBetween, zonedToUtc, isDateStr };
