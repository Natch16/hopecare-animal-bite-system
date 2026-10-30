'use strict';

function toYmd(v) {
  if (!v) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const dt = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(dt.getTime())) return null;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function nullableNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const DIFFERENCE_REASONS = [
  'Unrecorded Usage',
  'Counting Error',
  'Damaged Vial',
  'Expired/Discarded',
  'Stock Transfer',
  'Recording Error',
  'Other',
];

const LEGACY_DIFFERENCE_REASONS = [
  'Additional Stock Received',
  'Previous Inventory Correction',
  'Verified Stock Adjustment',
  'Incorrect AM Count',
  'Vaccine Usage Not Yet Recorded',
  'Damaged or Expired Vaccine',
];

const INITIAL_SETUP_REASON = 'Initial Stock Setup';

const VERIFIED_DIFFERENCE_STATUSES = ['Matched', 'Verified', 'Initial Setup'];
const COMPLETED_PM_STATUSES = ['Completed', 'Recorded', 'Closed', 'PM Count Saved'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function expectedAmStock(previousVerified, additional) {
  const prev = nullableNum(previousVerified);
  const add = additional == null || additional === '' ? 0 : num(additional);
  if (prev == null) return add;
  return prev + add;
}

/**
 * Receipts already inside the verified AM physical count are AM receipts.
 * They must not be classified again as PM additional.
 * A later PM receipt remains only when the physical count does not already include it.
 * When AM additional is already stored on the AM record, receipts that were all
 * timestamped after the cutoff still must not add that AM quantity a second time.
 */
function classifyShiftReceipts({
  baseline, physical, amReceipts = 0, pmReceipts = 0, storedAmAdditional,
} = {}) {
  const timedAm = num(amReceipts);
  const timedPm = num(pmReceipts);
  const all = timedAm + timedPm;
  const base = nullableNum(baseline);
  const phys = nullableNum(physical);
  if (phys != null && base != null && all > 0 && phys === base + all) {
    return { amAdditional: all, pmAdditional: 0 };
  }
  const storedAm = storedAmAdditional == null || storedAmAdditional === ''
    ? null
    : num(storedAmAdditional);
  let amAdditional = timedAm;
  let pmAdditional = timedPm;
  if (timedAm === 0 && storedAm != null && storedAm > 0 && timedPm >= storedAm) {
    amAdditional = storedAm;
    pmAdditional = timedPm - storedAm;
  }
  if (phys != null && base != null && pmAdditional > 0 && phys === base + amAdditional + pmAdditional) {
    pmAdditional = 0;
  }
  return { amAdditional, pmAdditional };
}

function dayAdditionalParts(amAdditional, pmAdditional) {
  // SEMANTIC FIX: pmAdditional is the PM PORTION of amAdditional, not ADDITIONAL stock on top of it.
  // 
  // When stock is added after AM count:
  //   - additional_vaccine (amAdditional) = total additional for the day (e.g., 10)
  //   - pm_additional_vaccine (pmAdditional) = PM portion of that total (e.g., 10)
  //   - This means ALL 10 were added during PM, ZERO during AM
  // 
  // Calculation:
  //   - Total = amAdditional (the total additional for the day)
  //   - PM portion = pmAdditional (what was added after AM count)
  //   - AM portion = amAdditional - pmAdditional (what was added before/during AM count)
  // 
  // Example: amAdditional=10, pmAdditional=10
  //   - AM portion = 10 - 10 = 0 (nothing added during AM)
  //   - PM portion = 10 (all 10 added during PM)
  //   - Total = 10 ✅ (NOT 20)
  
  const totalAdd = num(amAdditional);
  const pmPortion = num(pmAdditional);
  const amPortion = Math.max(0, totalAdd - pmPortion);
  
  return {
    am_additional: amPortion,
    pm_additional: pmPortion,
    total_additional: totalAdd,
  };
}

/**
 * PM additional only. Never include AM additional — that quantity is already
 * inside the verified AM count used as PM beginning stock.
 */
function exclusivePmAdditionalFromRows(amRow, pmRow) {
  if (!pmRow) return 0;
  const amAdd = amRow
    ? num(amRow.additional_vaccine != null ? amRow.additional_vaccine : amRow.additional_receipt_qty)
    : 0;
  
  // If pm_additional_vaccine is explicitly set, it's authoritative
  if (pmRow.pm_additional_vaccine != null && pmRow.pm_additional_vaccine !== '') {
    return num(pmRow.pm_additional_vaccine);
  }
  
  // Otherwise, fall back to additional_vaccine but check if it's a legacy copy
  const raw = num(pmRow.additional_vaccine != null ? pmRow.additional_vaccine : pmRow.additional_receipt_qty);
  
  // If raw equals amAdd, it's likely a legacy copy (not PM-only stock)
  if (amAdd > 0 && raw === amAdd) return 0;
  
  // Check if physical count already includes this additional stock
  const phys = amRow
    ? nullableNum(amRow.physical_count != null ? amRow.physical_count : amRow.morning_shift_inventory)
    : null;
  const prev = amRow ? nullableNum(amRow.previous_verified_stock) : null;
  if (phys != null && prev != null && raw > 0 && phys === prev + amAdd + raw) return 0;
  
  return raw;
}

function amDifference(physical, expected) {
  const phys = nullableNum(physical);
  const exp = nullableNum(expected);
  if (phys == null || exp == null) return null;
  return phys - exp;
}

/**
 * The physical count verified by an authorized administrator is Current Verified Stock.
 * A difference explains Expected Stock versus that count. It is not applied again.
 * Before PM is verified, stock is the AM count. After PM is verified, stock is the PM count.
 */
function currentVerifiedStock({ expectedAm, amCount, pmCount } = {}) {
  const expected = nullableNum(expectedAm);
  const am = nullableNum(amCount);
  const pm = nullableNum(pmCount);
  const difference = am != null && expected != null ? am - expected : null;
  const current = pm != null ? pm : am;
  return {
    expected_am_stock: expected,
    am_count: am,
    am_difference: difference,
    verified_am_stock: am,
    current_verified_stock: current,
  };
}

/**
 * `am` is the verified AM physical count (PM beginning). It already includes AM additional stock.
 * `additional` is PM additional stock only — receipts after AM verification. Pass 0 for AM receipts.
 * Vaccine Used = PM Beginning + PM Additional − PM Count.
 */
function expectedUsage(am, additional, pm) {
  const amN = nullableNum(am);
  const pmN = nullableNum(pm);
  if (amN == null || pmN == null) return null;
  return amN + num(additional) - pmN;
}

/** Expected PM ending = PM Beginning + PM Additional − Vaccine Used. */
function expectedPmStock(am, additional, totalUsed) {
  const amN = nullableNum(am);
  const usedN = nullableNum(totalUsed);
  if (amN == null || usedN == null) return null;
  return amN + num(additional) - usedN;
}

function pmStockDifference(actualPm, expectedPm) {
  const pmN = nullableNum(actualPm);
  const expN = nullableNum(expectedPm);
  if (pmN == null || expN == null) return null;
  return pmN - expN;
}

function differenceStatusFromDiff(diff) {
  if (diff == null) return 'Pending';
  if (diff === 0) return 'Matched';
  return 'Variance';
}

function clinicStockDifference({
  am, additional = 0, pm, totalUsed, vaccineName,
} = {}) {
  const used = totalUsed != null && totalUsed !== ''
    ? nullableNum(totalUsed)
    : expectedUsage(am, additional, pm);
  const expectedPm = expectedPmStock(am, additional, used);
  const diff = pmStockDifference(pm, expectedPm);
  const status = differenceStatusFromDiff(diff);
  const name = String(vaccineName || '');
  if (/abhayrab|vaxirab/i.test(name) || process.env.INVENTORY_DIFF_LOG === '1') {
    console.log('[inventory-difference]', {
      vaccine: name || null,
      am: nullableNum(am),
      additional: num(additional),
      pm: nullableNum(pm),
      totalUsed: used,
      expectedPm,
      difference: diff,
      status,
    });
  }
  return {
    expected_usage: used,
    expected_pm_stock: expectedPm,
    stock_difference: diff,
    difference_status: status,
  };
}

function formatDifference(diff) {
  if (diff == null) return null;
  if (diff > 0) return `+${diff}`;
  return String(diff);
}

function isVerifiedDifferenceStatus(status) {
  return VERIFIED_DIFFERENCE_STATUSES.includes(String(status || ''));
}

function isAmOfficial(row) {
  if (!row) return false;
  if (Number(row.opening_recorded) !== 1) return false;
  const st = String(row.inventory_status || '');
  if (st === 'Pending Verification' || st === 'Pending Initial Setup' || st === 'Pending') return false;
  const ds = String(row.difference_status || '');
  if (ds === 'Pending Verification') return false;
  return true;
}

function isPmOfficial(row) {
  if (!row) return false;
  if (Number(row.opening_recorded) !== 1) return false;
  if (nullableNum(row.remaining_pm_shift) == null) return false;
  const st = String(row.inventory_status || '');
  return COMPLETED_PM_STATUSES.includes(st) || st === 'Completed';
}

function clinicWorkflowStatus({ amOfficial, pmOfficial, hasPrevious, pendingVerification }) {
  if (pendingVerification) return 'Pending Verification';
  if (!amOfficial && !hasPrevious) return 'Pending Initial Setup';
  if (!amOfficial) return 'Pending';
  if (!pmOfficial) return 'Pending PM Count';
  return 'Completed';
}

function clipVerificationNote(text) {
  const note = String(text || '').trim();
  if (!note) return null;
  return note.length > 255 ? note.slice(0, 255) : note;
}

function verificationExplanation(row) {
  if (!row) return '';
  return String(row.verification_reason || row.remarks || '').trim();
}

function assertAmVerification({
  hasPrevious,
  physical,
  additional,
  difference,
  verification_reason,
  remarks,
}) {
  const reason = String(verification_reason || '').trim();
  const note = String(remarks || '').trim();

  if (physical == null || physical < 0) {
    const err = new Error('Enter the AM inventory count. Missing inventory cannot be saved as 0.');
    err.status = 400;
    throw err;
  }
  if (additional < 0) {
    const err = new Error('Verified additional stock cannot be negative.');
    err.status = 400;
    throw err;
  }

  if (!hasPrevious) {
    if (reason && reason !== INITIAL_SETUP_REASON && reason !== 'Previous Inventory Correction') {
      const err = new Error(
        'No previous verified inventory record was found for this vaccine. An authorized initial stock setup is required before AM inventory can be saved.'
      );
      err.status = 400;
      throw err;
    }
    if (!note) {
      const err = new Error('Remarks are required for initial stock setup.');
      err.status = 400;
      throw err;
    }
    return { difference_status: 'Initial Setup', verified: true };
  }

  if (difference === 0) {
    return { difference_status: 'Matched', verified: true };
  }

  if (reason === 'Incorrect AM Count') {
    const err = new Error(
      'If the AM count is incorrect, enter the correct AM Count. A difference is not verified as Incorrect AM Count.'
    );
    err.status = 400;
    throw err;
  }
  if (reason === 'Additional Stock Received' && num(additional) === 0) {
    const err = new Error(
      'Record verified additional stock separately. A difference between previous stock and the AM count is not automatically Additional Vaccine.'
    );
    err.status = 400;
    throw err;
  }
  if (!note) {
    const err = new Error(
      'The AM count differs from expected stock. Enter remarks describing the difference before saving.'
    );
    err.status = 400;
    throw err;
  }
  return { difference_status: 'Verified', verified: true };
}

async function fetchPreviousVerifiedStock(conn, vaccineId, beforeDate) {
  const date = toYmd(beforeDate);
  const [rows] = await conn.query(
    `SELECT remaining_pm_shift, record_date, shift, opening_recorded, inventory_status, difference_status
     FROM inventory_daily_records
     WHERE vaccine_id = ?
       AND record_date < ?
       AND remaining_pm_shift IS NOT NULL
       AND opening_recorded = 1
     ORDER BY record_date DESC,
              CASE WHEN shift = 'Afternoon Shift' THEN 0 ELSE 1 END ASC
     LIMIT 20`,
    [vaccineId, date]
  ).catch(async () => {
    const [fallback] = await conn.query(
      `SELECT remaining_pm_shift, record_date, shift, opening_recorded, inventory_status
       FROM inventory_daily_records
       WHERE vaccine_id = ? AND record_date < ? AND remaining_pm_shift IS NOT NULL
       ORDER BY record_date DESC LIMIT 20`,
      [vaccineId, date]
    );
    return [fallback];
  });

  for (const r of rows || []) {
    if (String(r.difference_status || '') === 'Pending Verification') continue;
    const rem = nullableNum(r.remaining_pm_shift);
    if (rem == null) continue;
    const st = String(r.inventory_status || '');
    if (!COMPLETED_PM_STATUSES.includes(st) && Number(r.opening_recorded) !== 1) continue;
    if (st === 'Pending' || st === 'Pending Verification' || st === 'Pending Initial Setup') continue;
    if (st === 'Pending PM Count') continue;
    return {
      remaining: rem,
      date: toYmd(r.record_date),
      shift: r.shift,
    };
  }
  return null;
}

module.exports = {
  DIFFERENCE_REASONS,
  INITIAL_SETUP_REASON,
  clipVerificationNote,
  verificationExplanation,
  expectedAmStock,
  classifyShiftReceipts,
  dayAdditionalParts,
  exclusivePmAdditionalFromRows,
  amDifference,
  currentVerifiedStock,
  expectedUsage,
  expectedPmStock,
  pmStockDifference,
  clinicStockDifference,
  differenceStatusFromDiff,
  formatDifference,
  isVerifiedDifferenceStatus,
  isAmOfficial,
  isPmOfficial,
  clinicWorkflowStatus,
  assertAmVerification,
  fetchPreviousVerifiedStock,
  toYmd,
  nullableNum,
};
