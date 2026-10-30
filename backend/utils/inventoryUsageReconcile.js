'use strict';

const { toYmd } = require('./vaccineInventorySheet');
const { normalizeShift } = require('./shiftHelper');
const { isAmOfficial } = require('./inventoryAmVerification');
const { totalUsedFromCounts, pmAdditionalOf } = require('./inventoryShiftUsage');
const { syncSheetUsageDeduction } = require('./inventoryUsageDeduction');

function nullableNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Completed AM/PM pairs with their verified usage, oldest first. */
function completedPairs(rows) {
  const pairs = new Map();
  for (const r of rows || []) {
    const key = `${toYmd(r.record_date)}::${r.vaccine_id}`;
    const cur = pairs.get(key) || { date: toYmd(r.record_date), vaccine_id: Number(r.vaccine_id), am: null, pm: null };
    if (normalizeShift(r.shift) === 'Morning Shift') cur.am = r;
    else cur.pm = r;
    pairs.set(key, cur);
  }
  const out = [];
  for (const p of pairs.values()) {
    if (!p.am || !p.pm || !isAmOfficial(p.am) || Number(p.pm.opening_recorded) !== 1) continue;
    const pm = nullableNum(p.pm.remaining_pm_shift);
    if (pm == null) continue;
    const am = nullableNum(p.am.physical_count != null ? p.am.physical_count : p.am.morning_shift_inventory);
    const additional = pmAdditionalOf(p.am, p.pm);
    const used = totalUsedFromCounts({
      previous: p.am.previous_verified_stock,
      additional: 0,
      physical: am,
      pm,
      pmAdditional: additional,
    });
    out.push({ ...p, counts: { am, additional, pm }, used });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.vaccine_id - b.vaccine_id);
}

/**
 * Applies AM/PM usage recorded before automatic deduction existed.
 * Idempotent: pairs already deducted produce delta 0.
 */
async function reconcileSheetUsage(pool, { dryRun = false, staff = { full_name: 'System reconciliation' } } = {}) {
  const [rows] = await pool.query(
    `SELECT * FROM inventory_daily_records WHERE opening_recorded = 1 ORDER BY record_date ASC, vaccine_id ASC`
  );
  const results = [];
  for (const pair of completedPairs(rows)) {
    if (pair.used == null || pair.used < 0) {
      results.push({ date: pair.date, vaccine_id: pair.vaccine_id, status: 'skipped', reason: 'invalid usage', used: pair.used });
      continue;
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const r = await syncSheetUsageDeduction(conn, {
        date: pair.date, vaccineId: pair.vaccine_id, used: pair.used, staff, counts: pair.counts,
      });
      if (dryRun) await conn.rollback();
      else await conn.commit();
      results.push({ date: pair.date, vaccine_id: pair.vaccine_id, status: dryRun ? 'dry-run' : 'ok', used: pair.used, delta: r.delta, currentStock: r.currentStock });
    } catch (err) {
      await conn.rollback().catch(() => {});
      results.push({ date: pair.date, vaccine_id: pair.vaccine_id, status: 'failed', reason: err.message, used: pair.used });
    } finally {
      conn.release();
    }
  }
  return results;
}

/**
 * Corrects PM usage that added AM additional stock a second time
 * (verified physical count + the same receipt − PM count).
 * Restores the extra vials through the usage ledger. Does not delete receipts.
 */
async function repairOvercountedSheetUsage(pool, staff = { full_name: 'Inventory correction' }) {
  const [rows] = await pool.query(
    'SELECT * FROM inventory_daily_records WHERE opening_recorded = 1 ORDER BY record_date ASC, vaccine_id ASC'
  );
  const results = [];
  for (const pair of completedPairs(rows)) {
    if (pair.used == null || pair.used < 0) {
      results.push({ date: pair.date, vaccine_id: pair.vaccine_id, status: 'skipped', used: pair.used });
      continue;
    }
    const stored = Number(pair.am && pair.am.vaccine_used);
    if (stored === pair.used) {
      results.push({ date: pair.date, vaccine_id: pair.vaccine_id, status: 'unchanged', used: pair.used });
      continue;
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE inventory_daily_records SET vaccine_used = ?
         WHERE record_date = ? AND vaccine_id = ?`,
        [pair.used, pair.date, pair.vaccine_id]
      );
      const synced = await syncSheetUsageDeduction(conn, {
        date: pair.date,
        vaccineId: pair.vaccine_id,
        used: pair.used,
        staff,
        counts: pair.counts,
      });
      await conn.commit();
      results.push({
        date: pair.date,
        vaccine_id: pair.vaccine_id,
        status: 'corrected',
        from: stored,
        used: pair.used,
        delta: synced.delta,
        currentStock: synced.currentStock,
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      results.push({ date: pair.date, vaccine_id: pair.vaccine_id, status: 'failed', reason: err.message, used: pair.used });
    } finally {
      conn.release();
    }
  }
  return results;
}

module.exports = { completedPairs, reconcileSheetUsage, repairOvercountedSheetUsage };
