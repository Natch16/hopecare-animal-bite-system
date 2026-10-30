'use strict';

const { normalizeShift } = require('./shiftHelper');
const { toSqlDate, sqlDateTimeOnCalendarDate } = require('./dateOnly');
const { nullableNum, replaceInventoryRemarks } = require('./vaccineInventorySheet');
const { isUsableLot, deriveLotStatus } = require('./inventoryBatches');
const { syncSheetUsageDeduction } = require('./inventoryUsageDeduction');
const { ensureDailyRecordSchema } = require('./inventoryClinicCount');
const { totalUsedFromCounts } = require('./inventoryShiftUsage');

const DEDUCT_NOTE = 'physical-count-correction';
const RESTORE_NOTE = 'physical-count-correction-restore';
const AUDIT_NOTE = 'count-correction-audit';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

function wholeCount(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n !== Math.floor(n)) {
    fail(`Enter a valid ${label}. Negative or empty quantities are not allowed.`);
  }
  return n;
}

/**
 * Physical-count correction replaces the verified count.
 * It never adds the count, the previous count, or Additional Stock again.
 *
 * AM without a PM count: lot stock moves only by (corrected count − expected stock),
 * and a later correction replaces that variance.
 * Once PM is recorded, lot stock moves only through the existing usage delta.
 */
function planPhysicalCorrection({
  shift,
  previous,
  additional = 0,
  expected,
  currentPhysical,
  correctedPhysical,
  balanceApplied = null,
  pmAdditional = 0,
  pmPhysical = null,
  amPhysical = null,
  hasPm = false,
} = {}) {
  const recShift = normalizeShift(shift);
  const corrected = wholeCount(
    correctedPhysical,
    recShift === 'Afternoon Shift' ? 'corrected PM count' : 'corrected AM count'
  );
  const current = nullableNum(currentPhysical);
  const add = num(additional);
  if (recShift === 'Morning Shift') {
    const exp = nullableNum(expected);
    const expectedStock = exp != null ? exp : (nullableNum(previous) != null ? num(previous) + add : null);
    if (expectedStock == null) fail('Expected AM stock is not available for this record.');
    const applied = nullableNum(balanceApplied);
    const baseline = applied != null ? applied : expectedStock;
    const difference = corrected - expectedStock;
    const pm = nullableNum(pmPhysical);
    const usage = hasPm && pm != null
      ? totalUsedFromCounts({ previous, additional: 0, physical: corrected, pm, pmAdditional })
      : null;
    return {
      shift: 'Morning Shift',
      expectedStock,
      correctedPhysical: corrected,
      currentPhysical: current,
      additional: add,
      difference,
      verificationStatus: difference === 0 ? 'Matched' : 'Variance',
      balanceTarget: hasPm ? expectedStock : corrected,
      balanceBaseline: baseline,
      stockDelta: hasPm ? 0 : corrected - baseline,
      usage,
      createsReceipt: false,
    };
  }
  const am = nullableNum(amPhysical);
  if (am == null) fail('Verify the AM inventory before correcting the PM count.');
  const pmAdd = num(pmAdditional);
  const usage = am + pmAdd - corrected;
  if (usage < 0) {
    fail('The corrected PM count cannot exceed the verified AM count plus PM additional stock.');
  }
  const expectedStock = am + pmAdd - usage;
  return {
    shift: 'Afternoon Shift',
    expectedStock,
    correctedPhysical: corrected,
    currentPhysical: current,
    additional: pmAdd,
    difference: corrected - expectedStock,
    verificationStatus: corrected === expectedStock ? 'Matched' : 'Variance',
    balanceTarget: null,
    balanceBaseline: null,
    stockDelta: 0,
    usage,
    createsReceipt: false,
  };
}

function ledgerKey(prefix, recordId) {
  return `${prefix}:${Number(recordId)}`;
}

function countCorrectionAuditNote(recordId, token) {
  return `${AUDIT_NOTE}:${Number(recordId)}:${String(token || '').trim()}`;
}

function countCorrectionRemark({ shift, original, corrected, reason, inventoryDate, previousRemarks }) {
  const label = normalizeShift(shift) === 'Afternoon Shift' ? 'PM Count' : 'AM Count';
  const day = toSqlDate(inventoryDate);
  const when = day ? ` Inventory date ${day}.` : '';
  const prior = String(previousRemarks || '').trim();
  const priorText = prior ? ` Previous remarks: ${prior}.` : '';
  return `${label} corrected: ${original} → ${corrected} vials. Reason: ${reason}.${priorText}${when}`;
}

/**
 * Next-day AM expected stock follows the corrected verified count only when that
 * next record still stores the count this correction is replacing.
 */
function planNextAmAfterVerifiedChange({
  oldVerified, newVerified, storedPrevious, physical, additional = 0,
  verificationReason, differenceStatus,
} = {}) {
  const oldN = nullableNum(oldVerified);
  const newN = nullableNum(newVerified);
  const stored = nullableNum(storedPrevious);
  if (oldN == null || newN == null || oldN === newN) return null;
  if (stored == null || stored !== oldN) return null;
  const expected = newN + num(additional);
  const count = nullableNum(physical);
  const difference = count == null ? null : count - expected;
  let status = differenceStatus || null;
  if (difference === 0) status = 'Matched';
  else if (difference != null) {
    status = String(verificationReason || '').trim()
      ? (status && status !== 'Matched' ? status : 'Verified')
      : 'Variance';
  }
  return {
    previous_verified_stock: newN,
    expected_remaining: expected,
    stock_difference: difference,
    difference_status: status,
  };
}

/**
 * One Adjustment per correction event. Quantity is 0 so this row is history only
 * and is not additional stock, usage, or a second Stock In.
 */
async function recordCountCorrectionAudit(conn, {
  recordId, token, vaccineId, shift, original, corrected, reason, previousRemarks, inventoryDate,
  expirationDate, staff, correctedAt,
}) {
  const note = countCorrectionAuditNote(recordId, token);
  const [existing] = await conn.query(
    'SELECT transaction_id FROM vaccine_transactions WHERE notes = ? LIMIT 1',
    [note]
  );
  if (existing && existing.length) return { created: false, transaction_id: existing[0].transaction_id };

  const [[lot]] = await conn.query(
    `SELECT inventory_id, expiry_date FROM vaccine_inventory
     WHERE vaccine_id = ? ORDER BY expiry_date DESC, inventory_id DESC LIMIT 1`,
    [vaccineId]
  );
  const remarks = countCorrectionRemark({
    shift, original, corrected, reason, previousRemarks, inventoryDate,
  });
  const expiry = toSqlDate(expirationDate) || (lot && toSqlDate(lot.expiry_date)) || null;
  await conn.query(
    `INSERT INTO vaccine_transactions
       (inventory_id, vaccine_id, transaction_type, quantity, original_quantity, staff_id, staff_name,
        staff_id_display, shift, notes, remarks, expiration_date, transaction_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      lot ? lot.inventory_id : null,
      vaccineId,
      'Adjustment',
      0,
      original,
      staff.staff_id || null,
      staff.full_name || null,
      staff.staff_id_display || null,
      normalizeShift(shift),
      note,
      remarks,
      expiry,
      correctedAt || new Date(),
    ]
  );
  return { created: true };
}

async function withTx(conn, work) {
  const canTx = typeof conn.beginTransaction === 'function';
  if (canTx) await conn.beginTransaction();
  try {
    const result = await work();
    if (canTx && typeof conn.commit === 'function') await conn.commit();
    return result;
  } catch (err) {
    if (canTx && typeof conn.rollback === 'function') await conn.rollback();
    throw err;
  }
}

async function loadRecord(conn, recordId, { lock = false } = {}) {
  const [[row]] = await conn.query(
    `SELECT idr.*, v.name AS vaccine_name
     FROM inventory_daily_records idr
     JOIN vaccines v ON v.vaccine_id = idr.vaccine_id
     WHERE idr.record_id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [recordId]
  );
  return row || null;
}

async function syncCountVariance(conn, { recordId, vaccineId, targetNet, date, staff }) {
  const deductKey = ledgerKey(DEDUCT_NOTE, recordId);
  const restoreKey = ledgerKey(RESTORE_NOTE, recordId);
  const [ledger] = await conn.query(
    `SELECT transaction_id, inventory_id, quantity, notes, transaction_type
     FROM vaccine_transactions
     WHERE vaccine_id = ? AND notes IN (?, ?)
     ORDER BY transaction_id ASC`,
    [vaccineId, deductKey, restoreKey]
  );
  let already = 0;
  const netByLot = new Map();
  for (const row of ledger || []) {
    if (String(row.transaction_type) === 'Stock In' || String(row.transaction_type) === 'Returned Vaccine') {
      fail('A physical-count correction was stored as added stock. It was not applied again.');
    }
    const sign = row.notes === restoreKey ? 1 : -1;
    const qty = num(row.quantity);
    already += sign * qty;
    const id = Number(row.inventory_id);
    netByLot.set(id, (netByLot.get(id) || 0) + sign * qty);
  }
  const delta = num(targetNet) - already;
  if (!delta) return { delta: 0 };
  const day = toSqlDate(date);
  if (delta > 0) {
    const [lots] = await conn.query(
      'SELECT * FROM vaccine_inventory WHERE vaccine_id = ? ORDER BY expiry_date DESC, inventory_id DESC LIMIT 1 FOR UPDATE',
      [vaccineId]
    );
    const lot = lots && lots[0];
    if (!lot) fail('No inventory lot is available to hold the corrected balance.');
    const nextQty = num(lot.quantity) + delta;
    const status = deriveLotStatus({ ...lot, quantity: nextQty, lot_status: lot.lot_status === 'Depleted' ? null : lot.lot_status });
    await conn.query(
      'UPDATE vaccine_inventory SET quantity = ?, lot_status = ? WHERE inventory_id = ?',
      [nextQty, status, lot.inventory_id]
    );
    await conn.query(
      `INSERT INTO vaccine_transactions
         (inventory_id, vaccine_id, transaction_type, quantity, original_quantity, staff_id, staff_name,
          staff_id_display, shift, notes, remarks, expiration_date, transaction_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        lot.inventory_id, vaccineId, 'Adjustment', delta, delta,
        staff.staff_id || null, staff.full_name || null, staff.staff_id_display || null,
        'Morning Shift', restoreKey,
        'AM Count correction. This is not additional stock.',
        lot.expiry_date || null, sqlDateTimeOnCalendarDate(day),
      ]
    );
  } else {
    const take = -delta;
    const [lots] = await conn.query(
      'SELECT * FROM vaccine_inventory WHERE vaccine_id = ? AND quantity > 0 FOR UPDATE',
      [vaccineId]
    );
    const usable = (lots || [])
      .filter((lot) => isUsableLot(lot, day))
      .sort((a, b) => String(toSqlDate(a.expiry_date) || '9999').localeCompare(String(toSqlDate(b.expiry_date) || '9999'))
        || Number(a.inventory_id) - Number(b.inventory_id));
    const available = usable.reduce((sum, lot) => sum + num(lot.quantity), 0);
    if (take > available) {
      fail(`The corrected count would reduce stock by ${take}, but only ${available} usable vial(s) are on hand.`);
    }
    let left = take;
    for (const lot of usable) {
      if (left <= 0) break;
      const part = Math.min(num(lot.quantity), left);
      if (part <= 0) continue;
      const nextQty = num(lot.quantity) - part;
      const status = deriveLotStatus({ ...lot, quantity: nextQty, lot_status: nextQty > 0 ? lot.lot_status : 'Depleted' });
      await conn.query(
        'UPDATE vaccine_inventory SET quantity = ?, lot_status = ? WHERE inventory_id = ?',
        [nextQty, status, lot.inventory_id]
      );
      await conn.query(
        `INSERT INTO vaccine_transactions
           (inventory_id, vaccine_id, transaction_type, quantity, original_quantity, staff_id, staff_name,
            staff_id_display, shift, notes, remarks, expiration_date, transaction_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          lot.inventory_id, vaccineId, 'Adjustment', part, part,
          staff.staff_id || null, staff.full_name || null, staff.staff_id_display || null,
          'Morning Shift', deductKey,
          'AM Count correction. This is not vaccine usage and not additional stock.',
          lot.expiry_date || null, sqlDateTimeOnCalendarDate(day),
        ]
      );
      left -= part;
    }
  }
  return { delta, netByLot };
}

async function refreshNextDayOpening(conn, { vaccineId, recordDate, oldVerified, newVerified }) {
  const day = toSqlDate(recordDate);
  if (!day) return null;
  const [nextRows] = await conn.query(
    `SELECT record_id, record_date, previous_verified_stock, additional_vaccine,
            physical_count, morning_shift_inventory, verification_reason, difference_status, opening_recorded
     FROM inventory_daily_records
     WHERE vaccine_id = ? AND record_date > ? AND shift = 'Morning Shift' AND opening_recorded = 1
     ORDER BY record_date ASC LIMIT 1`,
    [vaccineId, day]
  );
  const next = nextRows && nextRows[0];
  if (!next) return null;
  const plan = planNextAmAfterVerifiedChange({
    oldVerified,
    newVerified,
    storedPrevious: next.previous_verified_stock,
    physical: next.physical_count != null ? next.physical_count : next.morning_shift_inventory,
    additional: next.additional_vaccine,
    verificationReason: next.verification_reason,
    differenceStatus: next.difference_status,
  });
  if (!plan) return null;
  const nextDay = toSqlDate(next.record_date);
  await conn.query(
    `UPDATE inventory_daily_records SET
       previous_verified_stock = ?,
       expected_remaining = ?,
       stock_difference = ?,
       difference_status = ?
     WHERE record_id = ?`,
    [
      plan.previous_verified_stock,
      plan.expected_remaining,
      plan.stock_difference,
      plan.difference_status,
      next.record_id,
    ]
  );
  await conn.query(
    `UPDATE inventory_daily_records SET
       previous_verified_stock = ?,
       expected_remaining = ?
     WHERE vaccine_id = ? AND record_date = ? AND shift = 'Afternoon Shift'
       AND previous_verified_stock = ?`,
    [plan.previous_verified_stock, plan.expected_remaining, vaccineId, nextDay, oldVerified]
  );
  return { record_date: nextDay, ...plan };
}

async function correctPhysicalCount(conn, {
  record_id,
  corrected_physical_count,
  correction_reason,
  client_token,
  staff = {},
}) {
  const reason = String(correction_reason || '').trim();
  if (reason.length < 3) fail('A correction reason is required.');
  const token = String(client_token || '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) {
    fail('The correction could not be identified. Submit it once from the inventory form.');
  }
  const recordId = Number(record_id);
  if (!recordId) fail('Choose the verified inventory record to correct.');

  await ensureDailyRecordSchema(conn);
  return withTx(conn, async () => {
    const row = await loadRecord(conn, recordId, { lock: true });
    if (!row) fail('Verified inventory record not found.', 404);
    const recShift = normalizeShift(row.shift);
    const countName = recShift === 'Afternoon Shift' ? 'PM count' : 'AM count';
    if (Number(row.opening_recorded) !== 1) fail(`Only a verified ${countName} can be corrected.`);
    const current = recShift === 'Afternoon Shift'
      ? nullableNum(row.remaining_pm_shift)
      : nullableNum(row.physical_count != null ? row.physical_count : row.morning_shift_inventory);
    if (row.physical_correction_token && row.physical_correction_token === token) {
      return snapshot(row, current, { idempotent: true });
    }
    const corrected = wholeCount(corrected_physical_count, `corrected ${countName}`);
    if (current === corrected) fail(`The corrected ${countName} is already the verified count.`);

    let linkedAm = null;
    if (recShift === 'Afternoon Shift') {
      const [[amRow]] = await conn.query(
        `SELECT * FROM inventory_daily_records
         WHERE record_date = ? AND vaccine_id = ? AND shift = 'Morning Shift' LIMIT 1 FOR UPDATE`,
        [toSqlDate(row.record_date), row.vaccine_id]
      );
      linkedAm = amRow || null;
    }
    const am = recShift === 'Morning Shift'
      ? current
      : nullableNum(linkedAm && (linkedAm.physical_count != null ? linkedAm.physical_count : linkedAm.morning_shift_inventory));
    const [[pmRow]] = recShift === 'Morning Shift'
      ? await conn.query(
        `SELECT * FROM inventory_daily_records
         WHERE record_date = ? AND vaccine_id = ? AND shift = 'Afternoon Shift' LIMIT 1 FOR UPDATE`,
        [toSqlDate(row.record_date), row.vaccine_id]
      )
      : [[row]];
    const pmPhysical = pmRow && Number(pmRow.opening_recorded) === 1
      ? nullableNum(pmRow.remaining_pm_shift)
      : null;
    const hasPm = pmPhysical != null;
    const plan = planPhysicalCorrection({
      shift: recShift,
      previous: row.previous_verified_stock,
      additional: recShift === 'Morning Shift' ? row.additional_vaccine : row.pm_additional_vaccine,
      expected: row.expected_remaining,
      currentPhysical: current,
      correctedPhysical: corrected,
      balanceApplied: row.balance_applied_qty,
      pmAdditional: num(pmRow && pmRow.pm_additional_vaccine),
      pmPhysical: recShift === 'Afternoon Shift' ? corrected : pmPhysical,
      amPhysical: recShift === 'Morning Shift' ? corrected : am,
      hasPm: recShift === 'Afternoon Shift' ? true : hasPm,
    });

    const original = row.original_physical_count != null && row.original_physical_count !== ''
      ? Number(row.original_physical_count)
      : current;
    const previousRemarks = String(row.remarks || '').trim();
    const nextRemarks = replaceInventoryRemarks(previousRemarks, reason);
    const now = new Date();
    const oldVerified = recShift === 'Afternoon Shift' ? current : (hasPm ? pmPhysical : current);
    const newVerified = recShift === 'Afternoon Shift' ? corrected : (hasPm ? pmPhysical : corrected);
    if (recShift === 'Morning Shift') {
      await conn.query(
        `UPDATE inventory_daily_records SET
           physical_count = ?,
           morning_shift_inventory = ?,
           stock_difference = ?,
           difference_status = ?,
           original_physical_count = ?,
           corrected_physical_count = ?,
           physical_correction_reason = ?,
           physical_corrected_at = ?,
           physical_corrected_by = ?,
           physical_corrected_by_name = ?,
           physical_correction_token = ?,
           balance_applied_qty = ?,
           remarks = ?,
           vaccine_used = COALESCE(?, vaccine_used),
           additional_vaccine = additional_vaccine
         WHERE record_id = ?`,
        [
          corrected, corrected, plan.difference, plan.verificationStatus, original, corrected, reason, now,
          staff.staff_id || null, staff.full_name || '', token,
          hasPm ? (row.balance_applied_qty != null ? row.balance_applied_qty : plan.expectedStock) : corrected,
          nextRemarks,
          plan.usage,
          recordId,
        ]
      );
      if (!hasPm) {
        await syncCountVariance(conn, {
          recordId,
          vaccineId: row.vaccine_id,
          targetNet: corrected - plan.expectedStock,
          date: row.record_date,
          staff,
        });
      } else if (plan.usage != null) {
        await syncCountVariance(conn, {
          recordId,
          vaccineId: row.vaccine_id,
          targetNet: corrected - plan.expectedStock,
          date: row.record_date,
          staff,
        });
        await conn.query(
          `UPDATE inventory_daily_records SET vaccine_used = ?, remaining_pm_shift = ?
           WHERE record_id = ?`,
          [plan.usage, pmPhysical, pmRow.record_id]
        );
        await syncSheetUsageDeduction(conn, {
          date: row.record_date,
          vaccineId: row.vaccine_id,
          used: plan.usage,
          staff,
          counts: { am: corrected, additional: num(pmRow.pm_additional_vaccine), pm: pmPhysical },
        });
      }
    } else {
      await conn.query(
        `UPDATE inventory_daily_records SET
           remaining_pm_shift = ?,
           physical_count = ?,
           vaccine_used = ?,
           stock_difference = ?,
           difference_status = ?,
           original_physical_count = ?,
           corrected_physical_count = ?,
           physical_correction_reason = ?,
           physical_corrected_at = ?,
           physical_corrected_by = ?,
           physical_corrected_by_name = ?,
           physical_correction_token = ?,
           remarks = ?,
           additional_vaccine = additional_vaccine
         WHERE record_id = ?`,
        [
          corrected, corrected, plan.usage, plan.difference, plan.verificationStatus, original, corrected, reason, now,
          staff.staff_id || null, staff.full_name || '', token, nextRemarks, recordId,
        ]
      );
      if (linkedAm && linkedAm.record_id) {
        await conn.query(
          `UPDATE inventory_daily_records SET vaccine_used = ? WHERE record_id = ?`,
          [plan.usage, linkedAm.record_id]
        );
      }
      await syncSheetUsageDeduction(conn, {
        date: row.record_date,
        vaccineId: row.vaccine_id,
        used: plan.usage,
        staff,
        counts: { am: plan.amPhysical || am, additional: plan.additional, pm: corrected },
      });
    }

    if ((recShift === 'Afternoon Shift' || hasPm) && oldVerified !== newVerified) {
      await refreshNextDayOpening(conn, {
        vaccineId: row.vaccine_id,
        recordDate: row.record_date,
        oldVerified,
        newVerified,
      });
    }

    await recordCountCorrectionAudit(conn, {
      recordId,
      token,
      vaccineId: row.vaccine_id,
      shift: recShift,
      original: current,
      corrected,
      reason,
      previousRemarks,
      inventoryDate: row.record_date,
      expirationDate: row.expiration_date,
      staff,
      correctedAt: now,
    });

    const [[stock]] = await conn.query(
      'SELECT COALESCE(SUM(quantity),0) AS qty FROM vaccine_inventory WHERE vaccine_id = ?',
      [row.vaccine_id]
    );
    const [receiptRows] = await conn.query(
      `SELECT COUNT(*) AS total FROM vaccine_transactions
       WHERE vaccine_id = ? AND transaction_type IN ('Stock In','Returned Vaccine')
         AND notes IN (?, ?)`,
      [row.vaccine_id, ledgerKey(DEDUCT_NOTE, recordId), ledgerKey(RESTORE_NOTE, recordId)]
    );
    return {
      record_id: recordId,
      vaccine_id: row.vaccine_id,
      vaccine_name: row.vaccine_name,
      record_date: toSqlDate(row.record_date),
      shift: recShift,
      expiration_date: toSqlDate(row.expiration_date),
      previous_verified_stock: nullableNum(row.previous_verified_stock),
      additional_stock: plan.additional,
      expected_stock: plan.expectedStock,
      original_physical_count: original,
      corrected_physical_count: corrected,
      difference: plan.difference,
      verification_status: plan.verificationStatus,
      previous_remarks: previousRemarks || null,
      remarks: nextRemarks,
      correction_reason: reason,
      corrected_by: staff.full_name || '',
      corrected_at: now,
      current_stock: num(stock && stock.qty),
      usage: plan.usage,
      idempotent: false,
      receipt_rows_for_correction: num(receiptRows && receiptRows[0] && receiptRows[0].total),
    };
  });
}

function snapshot(row, current, extra) {
  return {
    record_id: row.record_id,
    vaccine_id: row.vaccine_id,
    vaccine_name: row.vaccine_name,
    record_date: toSqlDate(row.record_date),
    shift: normalizeShift(row.shift),
    original_physical_count: row.original_physical_count != null ? Number(row.original_physical_count) : current,
    corrected_physical_count: current,
    additional_stock: num(row.additional_vaccine),
    expected_stock: nullableNum(row.expected_remaining),
    difference: nullableNum(row.stock_difference),
    verification_status: row.difference_status,
    correction_reason: row.physical_correction_reason || null,
    idempotent: true,
    ...extra,
  };
}

module.exports = {
  countCorrectionRemark,
  countCorrectionAuditNote,
  planNextAmAfterVerifiedChange,
  DEDUCT_NOTE,
  RESTORE_NOTE,
  planPhysicalCorrection,
  correctPhysicalCount,
  syncCountVariance,
};
