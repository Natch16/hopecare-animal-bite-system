'use strict';

const {
  expectedAmStock, fetchPreviousVerifiedStock, isAmOfficial, isPmOfficial,
  clinicStockDifference, classifyShiftReceipts, amDifference, verificationExplanation,
} = require('./inventoryAmVerification');
const { vaccineUsedFromCounts, toYmd, nullableNum } = require('./vaccineInventorySheet');
const { persistLotQuantity, deriveLotStatus, toYmd: lotYmd } = require('./inventoryBatches');
const { normalizeShift } = require('./shiftHelper');
const { sumOpeningBalance, startingFromParts } = require('./inventoryOpeningBalance');

const RECEIPT_TYPES = ['Stock In', 'Returned Vaccine'];
const CORRECTABLE_RECEIPT_TYPES = ['Stock In', 'Returned Vaccine', 'Initial Opening Balance'];
const CORRECTION_REASONS = [
  'Incorrect expiration date',
  'Incorrect added stock',
  'Incorrect added stock and expiration date',
  'Typographical Error',
  'Quantity Miscount',
  'Duplicate Entry Correction',
  'Wrong Vaccine or Batch',
  'Other',
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

function effectiveReceiptQty(row) {
  if (!row || !CORRECTABLE_RECEIPT_TYPES.includes(String(row.transaction_type || ''))) return 0;
  if (row.corrected_quantity != null && row.corrected_quantity !== '') return num(row.corrected_quantity);
  return num(row.quantity);
}

function originalReceiptQty(row) {
  if (!row) return 0;
  if (row.original_quantity != null && row.original_quantity !== '') return num(row.original_quantity);
  return num(row.quantity);
}

async function sumVerifiedStockIn(conn, vaccineId, fromExclusive, toInclusive, bound = {}) {
  const to = toYmd(toInclusive);
  const from = fromExclusive ? toYmd(fromExclusive) : null;
  const until = bound.untilInclusive || null;
  const after = bound.afterExclusive || null;
  const sqlWithCorrected = `SELECT COALESCE(SUM(COALESCE(corrected_quantity, quantity)),0) AS qty
       FROM vaccine_transactions
       WHERE vaccine_id = ?
         AND transaction_type IN ('Stock In','Returned Vaccine')
         AND (notes IS NULL OR notes NOT LIKE '%lot-receipt-sync:%')
         AND DATE(transaction_date) <= ?
         AND (? IS NULL OR DATE(transaction_date) > ?)
         AND (? IS NULL OR transaction_date <= ?)
         AND (? IS NULL OR transaction_date > ?)`;
  const sqlPlain = `SELECT COALESCE(SUM(quantity),0) AS qty
       FROM vaccine_transactions
       WHERE vaccine_id = ?
         AND transaction_type IN ('Stock In','Returned Vaccine')
         AND (notes IS NULL OR notes NOT LIKE '%lot-receipt-sync:%')
         AND DATE(transaction_date) <= ?
         AND (? IS NULL OR DATE(transaction_date) > ?)
         AND (? IS NULL OR transaction_date <= ?)
         AND (? IS NULL OR transaction_date > ?)`;
  const params = [vaccineId, to, from, from, until, until, after, after];
  try {
    const [[row]] = await conn.query(sqlWithCorrected, params);
    return num(row && row.qty);
  } catch (_) {
    const [[row]] = await conn.query(sqlPlain, params);
    return num(row && row.qty);
  }
}

function receiptCutoff(amRow) {
  if (!amRow || !isAmOfficial(amRow)) return null;
  return amRow.recorded_at || amRow.verified_at || amRow.updated_at || null;
}

async function fetchAmReference(conn, vaccineId, date) {
  const day = toYmd(date);
  const prev = await fetchPreviousVerifiedStock(conn, vaccineId, day);
  const previous = prev ? prev.remaining : null;
  const amRow = await fetchDaily(conn, day, vaccineId, 'Morning Shift');
  const cutoff = receiptCutoff(amRow);
  const fromDate = prev ? prev.date : null;
  const opening_balance = await sumOpeningBalance(conn, vaccineId, day);
  const allReceipts = await sumVerifiedStockIn(conn, vaccineId, fromDate, day, {});
  const amByTime = cutoff
    ? await sumVerifiedStockIn(conn, vaccineId, fromDate, day, { untilInclusive: cutoff })
    : allReceipts;
  const pmByTime = Math.max(0, allReceipts - amByTime);
  const physical = amRow && isAmOfficial(amRow)
    ? nullableNum(amRow.physical_count != null ? amRow.physical_count : amRow.morning_shift_inventory)
    : null;
  const baseline = previous != null ? previous : (opening_balance > 0 ? opening_balance : null);
  const storedAmAdditional = amRow && isAmOfficial(amRow)
    ? nullableNum(amRow.additional_vaccine)
    : null;
  const classified = classifyShiftReceipts({
    baseline,
    physical,
    amReceipts: amByTime,
    pmReceipts: pmByTime,
    storedAmAdditional,
  });
  const additional = classified.amAdditional;
  const pm_additional = classified.pmAdditional;
  const expected = startingFromParts({
    previousPm: previous,
    openingBalance: opening_balance,
    additional,
  });
  const starting = expected;
  return {
    prev,
    previous,
    previous_date: prev ? prev.date : null,
    previous_shift: prev ? prev.shift : null,
    additional,
    pm_additional,
    opening_balance,
    expected,
    starting,
    previous_source: prev ? 'pm' : (opening_balance > 0 ? 'opening' : null),
  };
}

async function fetchDaily(conn, date, vaccineId, shift) {
  const [[row]] = await conn.query(
    `SELECT * FROM inventory_daily_records
     WHERE record_date = ? AND vaccine_id = ? AND shift = ? LIMIT 1`,
    [date, vaccineId, normalizeShift(shift)]
  );
  return row || null;
}

async function refreshClinicReceipts(conn, vaccineId, date) {
  const ref = await fetchAmReference(conn, vaccineId, date);
  const am = await fetchDaily(conn, date, vaccineId, 'Morning Shift');
  const pm = await fetchDaily(conn, date, vaccineId, 'Afternoon Shift');
  if (!am && !pm) return ref;

  const officialAm = isAmOfficial(am);
  const physical = officialAm
    ? nullableNum(am.physical_count != null ? am.physical_count : am.morning_shift_inventory)
    : null;
  const pmCount = isPmOfficial(pm)
    ? nullableNum(pm.remaining_pm_shift)
    : (officialAm && isPmOfficial(am) ? nullableNum(am.remaining_pm_shift) : null);
  const used = vaccineUsedFromCounts(physical, ref.pm_additional, pmCount);
  const sheet = clinicStockDifference({
    am: physical,
    additional: ref.pm_additional,
    pm: pmCount,
    totalUsed: used,
  });
  const amDiff = officialAm ? amDifference(physical, ref.expected) : null;
  let amDiffStatus = am ? am.difference_status : null;
  if (amDiff != null) {
    if (amDiff === 0) amDiffStatus = 'Matched';
    else if (verificationExplanation(am)) {
      amDiffStatus = String(am.difference_status || '') === 'Initial Setup' ? 'Initial Setup' : 'Verified';
    } else {
      amDiffStatus = 'Variance';
    }
  }

  if (am) {
    await writeReceiptColumns(conn, am.record_id, {
      additional: ref.additional,
      pmAdditional: ref.pm_additional,  // Save PM additional in AM record until PM is submitted
      previous: ref.previous,
      expected: ref.expected,
      difference: amDiff,
      differenceStatus: amDiffStatus,
      used,
    });
  }
  if (pm) {
    await writeReceiptColumns(conn, pm.record_id, {
      additional: ref.pm_additional,
      pmAdditional: ref.pm_additional,
      previous: ref.previous,
      expected: ref.expected,
      difference: sheet.stock_difference,
      differenceStatus: sheet.difference_status,
      used,
    });
  }
  return { ...ref, used, difference: sheet.stock_difference, difference_status: sheet.difference_status, physical };
}

async function writeReceiptColumns(conn, recordId, fields) {
  await conn.query(
    `UPDATE inventory_daily_records SET
       additional_vaccine = ?,
       additional_receipt_qty = ?,
       pm_additional_vaccine = ?,
       previous_verified_stock = ?,
       expected_remaining = ?,
       stock_difference = ?,
       difference_status = ?,
       vaccine_used = ?
     WHERE record_id = ?`,
    [
      fields.additional,
      fields.additional,
      fields.pmAdditional,
      fields.previous,
      fields.expected,
      fields.difference,
      fields.differenceStatus,
      fields.used == null ? 0 : fields.used,
      recordId,
    ]
  ).catch(async () => {
    await conn.query(
      `UPDATE inventory_daily_records SET additional_vaccine = ? WHERE record_id = ?`,
      [fields.additional, recordId]
    );
  });
}

function storedCalendarDate(value) {
  return lotYmd(value);
}

function parseCorrectionDate(value) {
  if (value == null || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    fail('Enter a valid corrected expiration date.');
  }
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    fail('Enter a valid corrected expiration date.');
  }
  return s;
}

async function correctStockIn(conn, {
  transaction_id, quantity, expiration_date, correction_reason, staff = {},
}) {
  const reason = String(correction_reason || '').trim();
  if (!reason) fail('A correction reason is required.');
  if (reason === 'Other') fail('Enter the correction details when Other is selected.');
  const knownReason = CORRECTION_REASONS.includes(reason) || reason.startsWith('Other: ');
  if (!knownReason && reason.length < 3) fail('Enter a valid correction reason.');
  if (reason.startsWith('Other: ') && reason.slice('Other: '.length).trim().length < 3) {
    fail('Enter the correction details when Other is selected.');
  }

  const qtyProvided = !(quantity === undefined || quantity === null || quantity === '');
  let qty = null;
  if (qtyProvided) {
    qty = Number(quantity);
    if (!Number.isFinite(qty) || qty < 0 || qty !== Math.floor(qty)) {
      fail('Enter a valid corrected quantity. Negative or empty quantities are not allowed.');
    }
  }

  const [[txn]] = await conn.query(
    `SELECT vt.*, v.name AS vaccine_name
     FROM vaccine_transactions vt
     JOIN vaccines v ON v.vaccine_id = vt.vaccine_id
     WHERE vt.transaction_id = ? LIMIT 1`,
    [transaction_id]
  );
  if (!txn) fail('Stock entry not found.', 404);
  if (!CORRECTABLE_RECEIPT_TYPES.includes(String(txn.transaction_type))) {
    fail('Only added stock entries can be corrected through this workflow.');
  }

  const original = originalReceiptQty(txn);
  const previousEffective = effectiveReceiptQty(txn);
  const qtyChanged = qtyProvided && qty !== previousEffective;
  const nextQty = qtyChanged ? qty : previousEffective;

  let lot = null;
  if (txn.inventory_id) {
    const [[row]] = await conn.query(
      `SELECT * FROM vaccine_inventory WHERE inventory_id = ? LIMIT 1`,
      [txn.inventory_id]
    );
    lot = row || null;
  }

  const currentExpiry = storedCalendarDate(txn.corrected_expiration_date)
    || storedCalendarDate(txn.expiration_date)
    || storedCalendarDate(lot && lot.expiry_date);
  const originalExpiry = storedCalendarDate(txn.original_expiration_date) || currentExpiry;
  const expProvided = !(expiration_date === undefined || expiration_date === null || String(expiration_date).trim() === '');
  const nextExpiry = expProvided ? parseCorrectionDate(expiration_date) : null;
  const expChanged = !!(nextExpiry && nextExpiry !== currentExpiry);
  if (!qtyChanged && !expChanged) {
    fail('Change the additional stock, the expiration date, or both before saving.');
  }

  const delta = qtyChanged ? (nextQty - previousEffective) : 0;
  const recDate = toYmd(txn.transaction_date);
  const previousBalance = qtyChanged
    ? await fetchAmReference(conn, txn.vaccine_id, recDate)
    : null;

  if (qtyChanged && lot) {
    const adjustedQty = Math.max(0, num(lot.quantity) + delta);
    const nextReceived = Math.max(0, num(lot.received_quantity || lot.quantity) + delta);
    await persistLotQuantity(conn, { ...lot, received_quantity: nextReceived, expiry_date: expChanged ? nextExpiry : lot.expiry_date }, adjustedQty, { usedDelta: 0 });
    await conn.query(
      `UPDATE vaccine_inventory SET received_quantity = ? WHERE inventory_id = ?`,
      [nextReceived, lot.inventory_id]
    ).catch(() => {});
  }

  const statusLot = lot
    ? {
      ...lot,
      expiry_date: expChanged ? nextExpiry : lot.expiry_date,
      lot_status: lot.lot_status === 'Expired' ? null : lot.lot_status,
    }
    : null;
  let lotStatus = statusLot ? deriveLotStatus(statusLot) : null;
  if (expChanged && lot) {
    lotStatus = deriveLotStatus(statusLot);
    await conn.query(
      `UPDATE vaccine_inventory
         SET expiry_date = ?,
             original_expiry_date = COALESCE(original_expiry_date, ?),
             lot_status = ?
       WHERE inventory_id = ?`,
      [nextExpiry, originalExpiry || currentExpiry, lotStatus, lot.inventory_id]
    );
    await conn.query(
      `UPDATE vaccine_transactions
         SET expiration_date = ?,
             original_expiration_date = COALESCE(original_expiration_date, ?),
             corrected_expiration_date = ?
       WHERE inventory_id = ?
         AND transaction_id <> ?
         AND transaction_type IN ('Stock In','Returned Vaccine','Initial Opening Balance')`,
      [nextExpiry, currentExpiry, nextExpiry, lot.inventory_id, transaction_id]
    );
  }

  const noteParts = [];
  if (qtyChanged) noteParts.push(`Corrected added stock from ${previousEffective} to ${nextQty}`);
  if (expChanged) noteParts.push(`Corrected expiration date from ${currentExpiry || 'none'} to ${nextExpiry}`);
  const auditNote = `${noteParts.join('. ')} (${reason})`;

  try {
    await conn.query(
      `UPDATE vaccine_transactions SET
         original_quantity = COALESCE(original_quantity, quantity),
         corrected_quantity = CASE WHEN ? THEN ? ELSE corrected_quantity END,
         quantity = CASE WHEN ? THEN ? ELSE quantity END,
         original_expiration_date = COALESCE(original_expiration_date, ?),
         corrected_expiration_date = CASE WHEN ? THEN ? ELSE corrected_expiration_date END,
         expiration_date = CASE WHEN ? THEN ? ELSE expiration_date END,
         correction_reason = ?,
         corrected_at = ?,
         corrected_by = ?,
         corrected_by_name = ?,
         remarks = CONCAT(COALESCE(remarks,''), CASE WHEN COALESCE(remarks,'')='' THEN '' ELSE '; ' END, ?)
       WHERE transaction_id = ?`,
      [
        qtyChanged ? 1 : 0, nextQty,
        qtyChanged ? 1 : 0, nextQty,
        originalExpiry,
        expChanged ? 1 : 0, nextExpiry,
        expChanged ? 1 : 0, nextExpiry,
        reason, new Date(),
        staff.staff_id || null, staff.full_name || '',
        auditNote,
        transaction_id,
      ]
    );
  } catch (_) {
    if (!qtyChanged) throw _;
    await conn.query(
      `UPDATE vaccine_transactions SET quantity = ?, remarks = CONCAT(COALESCE(remarks,''), ?)
       WHERE transaction_id = ?`,
      [nextQty, `; ${auditNote}`, transaction_id]
    );
  }

  const updatedBalance = qtyChanged
    ? await refreshClinicReceipts(conn, txn.vaccine_id, recDate)
    : null;
  return {
    transaction_id: Number(transaction_id),
    inventory_id: txn.inventory_id || (lot && lot.inventory_id) || null,
    vaccine_id: txn.vaccine_id,
    vaccine_name: txn.vaccine_name,
    original_quantity: original,
    previous_quantity: previousEffective,
    corrected_quantity: nextQty,
    quantity_changed: qtyChanged,
    original_expiration_date: originalExpiry,
    previous_expiration_date: currentExpiry,
    corrected_expiration_date: expChanged ? nextExpiry : currentExpiry,
    expiration_changed: expChanged,
    lot_status: lotStatus,
    correction_reason: reason,
    corrected_at: new Date().toISOString(),
    corrected_by: staff.staff_id || null,
    corrected_by_name: staff.full_name || '',
    record_date: recDate,
    shift: txn.shift,
    previous_balance: previousBalance ? previousBalance.starting : null,
    updated_balance: updatedBalance ? updatedBalance.starting : null,
    additional_vaccine: updatedBalance ? updatedBalance.additional : null,
    previous_verified_stock: updatedBalance ? updatedBalance.previous : null,
    am_starting_stock: updatedBalance ? updatedBalance.starting : null,
    delta,
  };
}

module.exports = {
  RECEIPT_TYPES,
  CORRECTABLE_RECEIPT_TYPES,
  CORRECTION_REASONS,
  effectiveReceiptQty,
  originalReceiptQty,
  sumVerifiedStockIn,
  fetchAmReference,
  refreshClinicReceipts,
  correctStockIn,
};
