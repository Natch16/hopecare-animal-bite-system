/**
 * Calendar-date helpers. DATE fields must never be converted through
 * UTC via Date#toISOString() — that shifts the day in UTC+ timezones.
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ymd(y, m, d) {
  if (!y || !m || !d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function localYmd(dt) {
  return ymd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

function utcYmd(dt) {
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function hasValue(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/**
 * Normalize any date-like value to YYYY-MM-DD without timezone shift.
 * HTML date inputs and MySQL DATE columns are calendar dates, not instants.
 */
function toSqlDate(v) {
  if (!hasValue(v)) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return localYmd(v);
  }

  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2} /.test(s)) return s.slice(0, 10);

  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const dt = new Date(s);
    if (isNaN(dt.getTime())) return null;
    const midnightUtc = dt.getUTCHours() === 0 && dt.getUTCMinutes() === 0 && dt.getUTCSeconds() === 0;
    return midnightUtc ? utcYmd(dt) : localYmd(dt);
  }

  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const month = Number(us[1]);
    const day = Number(us[2]);
    const year = Number(us[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return ymd(year, month, day);
  }

  const dt = new Date(s);
  if (isNaN(dt.getTime())) return null;
  return localYmd(dt);
}

function addDaysIso(iso, days) {
  const base = toSqlDate(iso);
  if (!base) return null;
  const [y, m, d] = base.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + Number(days)));
  return utcYmd(dt);
}

function localTodayIso() {
  return localYmd(new Date());
}

/** Local calendar datetime, so JSON does not shift the day through UTC. */
function toSqlDateTime(v) {
  if (!hasValue(v)) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return `${localYmd(v)} ${pad2(v.getHours())}:${pad2(v.getMinutes())}:${pad2(v.getSeconds())}`;
  }
  const s = String(v).trim().replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return s.slice(0, 19);
  return toSqlDate(v);
}

/** Inclusive calendar day as DATETIME start (local clock, no UTC conversion). */
function sqlDayStart(iso) {
  const d = toSqlDate(iso);
  return d ? `${d} 00:00:00` : null;
}

/** Exclusive end bound: midnight of the day after `iso`. */
function sqlDayEndExclusive(iso) {
  const next = addDaysIso(iso, 1);
  return next ? `${next} 00:00:00` : null;
}

/**
 * Stamp a calendar date with the current local clock so TIMESTAMP storage
 * stays on the selected day instead of “now” when Date Received differs.
 */
function sqlDateTimeOnCalendarDate(isoDate, now = new Date()) {
  const d = toSqlDate(isoDate);
  if (!d) return null;
  return `${d} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

module.exports = {
  toSqlDate,
  toSqlDateTime,
  addDaysIso,
  localTodayIso,
  localYmd,
  utcYmd,
  sqlDayStart,
  sqlDayEndExclusive,
  sqlDateTimeOnCalendarDate,
};
