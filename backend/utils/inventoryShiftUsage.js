'use strict';

const { normalizeShift } = require('./shiftHelper');
const {
  toYmd,
  nullableNum,
  isOpeningRecorded,
} = require('./vaccineInventorySheet');
const { exclusivePmAdditionalFromRows } = require('./inventoryAmVerification');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function emptyUsage() {
  return { total_vaccine_used: 0 };
}

/**
 * PM beginning stock is the verified AM physical count.
 * AM additional stock is already inside that count and must not be added again.
 * Before a physical count exists, beginning stock is previous verified stock + AM additional.
 */
function shiftStartingStock(amRow) {
  if (!amRow) return null;
  const additional = num(amRow.additional_vaccine != null ? amRow.additional_vaccine : amRow.additional_receipt_qty);
  const physical = nullableNum(amRow.physical_count != null ? amRow.physical_count : amRow.morning_shift_inventory);
  const previous = nullableNum(amRow.previous_verified_stock);
  if (physical != null) return physical;
  if (previous != null) return previous + additional;
  return additional > 0 ? additional : null;
}

/**
 * PM additional only. A legacy PM row copied the AM receipt into additional_vaccine;
 * that copy is not a second receipt. An explicit pm_additional_vaccine is authoritative.
 */
function pmAdditionalOf(amRow, pmRow) {
  return exclusivePmAdditionalFromRows(amRow, pmRow);
}

/**
 * Vaccine Used = PM Beginning + PM Additional − PM Count.
 * `additional` is AM additional and is used only when no physical count exists yet.
 * `pmAdditional` is stock received after AM verification and is added once.
 */
function totalUsedFromCounts({ previous, additional = 0, physical, pm, pmAdditional = 0 }) {
  if (pm == null || pm === '') return null;
  const pmN = Number(pm);
  if (!Number.isFinite(pmN)) return null;
  const phys = nullableNum(physical);
  const prev = nullableNum(previous);
  const pmExtra = num(pmAdditional);
  if (phys != null) return phys + pmExtra - pmN;
  if (prev != null) return prev + num(additional) + pmExtra - pmN;
  if (num(additional) > 0 || pmExtra > 0) return num(additional) + pmExtra - pmN;
  return null;
}

function usageFromDailyPair(amRow, pmRow) {
  const recordedAm = isOpeningRecorded(amRow);
  const recordedPm = isOpeningRecorded(pmRow) && nullableNum(pmRow && pmRow.remaining_pm_shift) != null;
  const pm = recordedPm ? nullableNum(pmRow.remaining_pm_shift) : null;
  const used = recordedAm ? totalUsedFromCounts({
    previous: amRow.previous_verified_stock,
    additional: amRow.additional_vaccine,
    physical: nullableNum(amRow.physical_count != null ? amRow.physical_count : amRow.morning_shift_inventory),
    pm,
    pmAdditional: pmAdditionalOf(amRow, pmRow),
  }) : null;
  return {
    total_vaccine_used: used == null ? 0 : used,
  };
}

function pairDailyRecords(rows) {
  const pairs = new Map();
  for (const r of rows || []) {
    const day = toYmd(r.record_date);
    if (!day || r.vaccine_id == null) continue;
    const key = `${day}::${r.vaccine_id}`;
    const cur = pairs.get(key) || { am: null, pm: null, vaccine_id: r.vaccine_id, record_date: day };
    const shift = normalizeShift(r.shift);
    if (shift === 'Morning Shift') cur.am = r;
    else if (shift === 'Afternoon Shift') cur.pm = r;
    pairs.set(key, cur);
  }
  return pairs;
}

function usageMapFromRows(rows) {
  const byDay = new Map();
  const byVaccine = new Map();
  for (const pair of pairDailyRecords(rows).values()) {
    const usage = usageFromDailyPair(pair.am, pair.pm);
    byDay.set(`${pair.record_date}::${pair.vaccine_id}`, usage);
    const vid = Number(pair.vaccine_id);
    const cur = byVaccine.get(vid) || emptyUsage();
    cur.total_vaccine_used += usage.total_vaccine_used;
    byVaccine.set(vid, cur);
  }
  return { byDay, byVaccine };
}

async function fetchDailyRecordRows(pool, { dateFrom, dateTo, vaccineId } = {}) {
  let sql = 'SELECT * FROM inventory_daily_records WHERE 1=1';
  const params = [];
  if (dateFrom) {
    sql += ' AND record_date >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND record_date <= ?';
    params.push(dateTo);
  }
  if (vaccineId) {
    sql += ' AND vaccine_id = ?';
    params.push(vaccineId);
  }
  const [rows] = await pool.query(sql, params);
  return rows || [];
}

async function fetchClinicUsageMaps(pool, filters = {}) {
  const rows = await fetchDailyRecordRows(pool, filters);
  return usageMapFromRows(rows);
}

function usageForVaccine(byVaccine, vaccineId) {
  return byVaccine.get(Number(vaccineId)) || emptyUsage();
}

function usageForDay(byDay, date, vaccineId) {
  const day = toYmd(date);
  if (!day || vaccineId == null) return emptyUsage();
  return byDay.get(`${day}::${vaccineId}`) || emptyUsage();
}

module.exports = {
  emptyUsage,
  shiftStartingStock,
  pmAdditionalOf,
  totalUsedFromCounts,
  usageFromDailyPair,
  pairDailyRecords,
  usageMapFromRows,
  fetchClinicUsageMaps,
  usageForVaccine,
  usageForDay,
  fetchDailyRecordRows,
};
