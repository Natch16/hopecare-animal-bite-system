'use strict';

const { normalizeShift } = require('./shiftHelper');
const {
  localYmd, toYmd, nullableNum, vaccineUsedFromCounts, clinicUsageFromCounts,
} = require('./vaccineInventorySheet');
const { requireActiveManagedVaccine } = require('./vaccineCatalog');
const {
  amDifference, assertAmVerification,
  isAmOfficial, clinicWorkflowStatus, clinicStockDifference, currentVerifiedStock,
  clipVerificationNote, INITIAL_SETUP_REASON,
} = require('./inventoryAmVerification');
const { fetchAmReference } = require('./inventoryVerifiedStock');
const { totalUsedFromCounts } = require('./inventoryShiftUsage');
const { syncSheetUsageDeduction } = require('./inventoryUsageDeduction');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

function persistVaccineUsed(used) {
  if (used == null || used === '') return 0;
  const n = Number(used);
  return Number.isFinite(n) ? n : 0;
}

async function stampPmAdditional(conn, date, vaccineId, shift, pmAdditional) {
  await conn.query(
    `UPDATE inventory_daily_records SET pm_additional_vaccine = ?
     WHERE record_date = ? AND vaccine_id = ? AND shift = ?`,
    [num(pmAdditional), date, vaccineId, normalizeShift(shift)]
  ).catch(() => {});
}

let dailySchemaReady = false;
async function ensureDailyRecordSchema(conn) {
  if (dailySchemaReady || !conn || typeof conn.query !== 'function') return;
  const statements = [
    `ALTER TABLE inventory_daily_records MODIFY COLUMN vaccine_used INT NOT NULL DEFAULT 0`,
    `ALTER TABLE inventory_daily_records MODIFY COLUMN remaining_pm_shift INT NULL`,
    `ALTER TABLE inventory_daily_records MODIFY COLUMN morning_shift_inventory INT NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN previous_verified_stock INT NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN stock_difference INT NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN difference_status VARCHAR(60) NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN verification_reason VARCHAR(255) NULL`,
    `ALTER TABLE inventory_daily_records MODIFY COLUMN verification_reason VARCHAR(255) NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN physical_count INT NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN expected_remaining INT NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN additional_receipt_qty INT NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN opening_recorded TINYINT(1) NOT NULL DEFAULT 0`,
    `ALTER TABLE inventory_daily_records ADD COLUMN inventory_status VARCHAR(30) NOT NULL DEFAULT 'Pending'`,
    `ALTER TABLE inventory_daily_records ADD COLUMN recorded_at DATETIME NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN verified_at DATETIME NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN verified_by INT NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN verified_by_name VARCHAR(100) NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN pm_additional_vaccine INT NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN original_physical_count INT NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN corrected_physical_count INT NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN physical_correction_reason VARCHAR(255) NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN physical_corrected_at DATETIME NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN physical_corrected_by INT NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN physical_corrected_by_name VARCHAR(100) NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN physical_correction_token VARCHAR(64) NULL`,
    `ALTER TABLE inventory_daily_records ADD COLUMN balance_applied_qty INT NULL`,
  ];
  for (const sql of statements) {
    await conn.query(sql).catch(() => {});
  }
  dailySchemaReady = true;
}

function isNullConstraintError(err) {
  const msg = String((err && (err.sqlMessage || err.message)) || '');
  return (err && err.code === 'ER_BAD_NULL_ERROR') || /cannot be null/i.test(msg);
}

async function fetchRow(conn, date, vaccineId, shift) {
  const recShift = normalizeShift(shift);
  const [[row]] = await conn.query(
    `SELECT * FROM inventory_daily_records
     WHERE record_date = ? AND vaccine_id = ? AND shift = ? LIMIT 1`,
    [date, vaccineId, recShift]
  );
  return row || null;
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

async function upsertClinicRow(conn, {
  date, vaccine_id, shift, morning, additional, pmCount, used, status,
  expiration_date, remarks, staff,
  previous_verified_stock, stock_difference, difference_status, verification_reason,
  physical_count, expected_am, additional_receipt_qty, verified,
}) {
  const recShift = normalizeShift(shift);
  const recordedAt = new Date();
  const usedCol = persistVaccineUsed(used);
  const verifiedAt = verified ? recordedAt : null;
  const payload = [
    date, vaccine_id, morning, usedCol, pmCount, additional,
    expiration_date || null, remarks || null, recShift,
    staff.staff_id || null, staff.full_name || '', staff.staff_id_display || null,
    verified ? 1 : 0, status, 0, recordedAt,
    physical_count != null ? physical_count : morning,
    expected_am,
    previous_verified_stock, stock_difference, difference_status,
    verification_reason || null,
    verifiedAt, verified ? (staff.staff_id || null) : null, verified ? (staff.full_name || '') : null,
    additional_receipt_qty != null ? additional_receipt_qty : additional,
  ];
  try {
    await conn.query(
      `INSERT INTO inventory_daily_records
         (record_date, vaccine_id, morning_shift_inventory, vaccine_used, remaining_pm_shift,
          additional_vaccine, expiration_date, remarks, shift,
          recorded_by, recorded_by_name, recorded_by_id_display,
          opening_recorded, inventory_status, late_entry, recorded_at,
          physical_count, expected_remaining,
          previous_verified_stock, stock_difference, difference_status, verification_reason,
          verified_at, verified_by, verified_by_name, additional_receipt_qty)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         morning_shift_inventory=VALUES(morning_shift_inventory),
         vaccine_used=VALUES(vaccine_used),
         remaining_pm_shift=VALUES(remaining_pm_shift),
         additional_vaccine=VALUES(additional_vaccine),
         expiration_date=COALESCE(VALUES(expiration_date), expiration_date),
         remarks=VALUES(remarks),
         recorded_by=VALUES(recorded_by),
         recorded_by_name=VALUES(recorded_by_name),
         recorded_by_id_display=VALUES(recorded_by_id_display),
         opening_recorded=VALUES(opening_recorded),
         inventory_status=VALUES(inventory_status),
         recorded_at=VALUES(recorded_at),
         physical_count=VALUES(physical_count),
         expected_remaining=VALUES(expected_remaining),
         previous_verified_stock=VALUES(previous_verified_stock),
         stock_difference=VALUES(stock_difference),
         difference_status=VALUES(difference_status),
         verification_reason=VALUES(verification_reason),
         verified_at=VALUES(verified_at),
         verified_by=VALUES(verified_by),
         verified_by_name=VALUES(verified_by_name),
         additional_receipt_qty=VALUES(additional_receipt_qty)`,
      payload
    );
  } catch (err) {
    const existing = await fetchRow(conn, date, vaccine_id, recShift);
    if (existing && existing.record_id) {
      await conn.query(
        `UPDATE inventory_daily_records SET
           morning_shift_inventory = ?,
           vaccine_used = ?,
           remaining_pm_shift = ?,
           additional_vaccine = ?,
           expiration_date = COALESCE(?, expiration_date),
           remarks = ?,
           recorded_by = ?,
           recorded_by_name = ?,
           recorded_by_id_display = ?,
           opening_recorded = ?,
           inventory_status = ?,
           recorded_at = ?,
           physical_count = ?,
           expected_remaining = ?,
           previous_verified_stock = ?,
           stock_difference = ?,
           difference_status = ?,
           verification_reason = ?,
           verified_at = ?,
           verified_by = ?,
           verified_by_name = ?,
           additional_receipt_qty = ?
         WHERE record_id = ?`,
        [
          morning, usedCol, pmCount, additional,
          expiration_date || null, remarks || null,
          staff.staff_id || null, staff.full_name || '', staff.staff_id_display || null,
          verified ? 1 : 0, status, recordedAt,
          physical_count != null ? physical_count : morning, expected_am,
          previous_verified_stock, stock_difference, difference_status,
          verification_reason || null,
          verifiedAt, verified ? (staff.staff_id || null) : null, verified ? (staff.full_name || '') : null,
          additional_receipt_qty != null ? additional_receipt_qty : additional,
          existing.record_id,
        ]
      );
    } else if (isNullConstraintError(err)) {
      dailySchemaReady = false;
      await ensureDailyRecordSchema(conn);
      await conn.query(
        `INSERT INTO inventory_daily_records
           (record_date, vaccine_id, morning_shift_inventory, vaccine_used, remaining_pm_shift,
            additional_vaccine, expiration_date, remarks, shift,
            recorded_by, recorded_by_name, recorded_by_id_display,
            opening_recorded, inventory_status, late_entry, recorded_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           morning_shift_inventory=VALUES(morning_shift_inventory),
           vaccine_used=VALUES(vaccine_used),
           remaining_pm_shift=VALUES(remaining_pm_shift),
           additional_vaccine=VALUES(additional_vaccine),
           expiration_date=COALESCE(VALUES(expiration_date), expiration_date),
           remarks=VALUES(remarks),
           recorded_by=VALUES(recorded_by),
           recorded_by_name=VALUES(recorded_by_name),
           opening_recorded=VALUES(opening_recorded),
           inventory_status=VALUES(inventory_status),
           recorded_at=VALUES(recorded_at)`,
        [
          date, vaccine_id, morning, usedCol, pmCount, additional,
          expiration_date || null, remarks || null, recShift,
          staff.staff_id || null, staff.full_name || '', staff.staff_id_display || null,
          verified ? 1 : 0, status, 0, recordedAt,
        ]
      );
    } else {
      throw err;
    }
  }
}

function savedPayload({
  date, shift, vaccine_id, am, additional, pmCount, used, status,
  previous, expected, diff, difference_status, verification_reason, remarks,
  opening_balance, pm_difference,
}) {
  const verified = currentVerifiedStock({
    expectedAm: expected,
    amCount: am,
    pmCount,
  });
  return {
    record_date: date,
    shift,
    vaccine_id,
    previous_verified_stock: previous,
    opening_balance: opening_balance != null ? opening_balance : 0,
    am_starting_stock: expected != null ? expected : previous,
    inventory_am: am,
    physical_count: am,
    additional_vaccine: additional,
    expected_am_stock: expected,
    stock_difference: verified.am_difference,
    am_difference: verified.am_difference,
    difference_status,
    current_verified_stock: verified.current_verified_stock,
    verified_am_stock: verified.verified_am_stock,
    pm_difference: pmCount != null ? pm_difference : null,
    verification_reason: verification_reason || null,
    inventory_pm: pmCount,
    remaining_pm_shift: pmCount,
    pm_starting_stock: am,
    vaccine_used: used,
    inventory_status: status,
    sheet_status: status,
    opening_recorded: true,
    remarks: remarks || null,
  };
}

async function alignVerifiedAmStock(conn, { recordId, vaccineId, physical, expected, date, staff }) {
  if (recordId == null || physical == null || expected == null) return;
  const { syncCountVariance } = require('./inventoryPhysicalCorrection');
  await syncCountVariance(conn, {
    recordId,
    vaccineId,
    targetNet: physical - expected,
    date,
    staff,
  });
  await conn.query(
    `UPDATE inventory_daily_records SET balance_applied_qty = ? WHERE record_id = ?`,
    [physical, recordId]
  );
}

async function saveAmInventory(conn, {
  record_date, vaccine_id, morning_shift_inventory, physical_count,
  additional_vaccine, expiration_date, remarks, staff = {},
  verification_reason, previous_verified_stock: _ignoredPrevious,
}) {
  const date = toYmd(record_date) || localYmd();
  await requireActiveManagedVaccine(conn, vaccine_id);
  await ensureDailyRecordSchema(conn);
  const physical = nullableNum(physical_count != null ? physical_count : morning_shift_inventory);
  const ref = await fetchAmReference(conn, vaccine_id, date);
  const previous = ref.previous;
  const additional = ref.additional;
  const expected = ref.expected;
  const amGap = amDifference(physical, expected);
  const note = String(remarks || '').trim();
  const incomingReason = String(verification_reason || '').trim();
  const reasonForCheck = ref.starting == null
    ? (incomingReason || INITIAL_SETUP_REASON)
    : incomingReason;
  const check = assertAmVerification({
    hasPrevious: ref.starting != null,
    physical,
    additional,
    difference: amGap,
    verification_reason: reasonForCheck,
    remarks: note,
  });

  return withTx(conn, async () => {
    const existingAm = await fetchRow(conn, date, vaccine_id, 'Morning Shift');
    
    // LOCK: Block re-submission if AM shift already recorded
    if (existingAm && isAmOfficial(existingAm)) {
      fail('AM inventory has already been submitted and is locked. Use the physical count correction endpoint to make changes.');
    }

    const pmRow = await fetchRow(conn, date, vaccine_id, 'Afternoon Shift');
    const pmCount = pmRow && Number(pmRow.opening_recorded) === 1
      ? nullableNum(pmRow.remaining_pm_shift)
      : null;
    const pmAdditional = num(ref.pm_additional);
    const used = totalUsedFromCounts({
      previous, additional, physical, pm: pmCount, pmAdditional,
    });
    if (used != null && used < 0) {
      fail('Vaccine Used cannot be negative. The PM count cannot exceed the verified AM count plus PM additional stock.');
    }
    const sheetDiff = clinicStockDifference({
      am: physical, additional: pmAdditional, pm: pmCount, totalUsed: used,
    });
    const diff = amGap;
    const sheetStatus = check.difference_status;
    const status = clinicWorkflowStatus({
      amOfficial: true,
      pmOfficial: pmCount != null,
      hasPrevious: ref.starting != null,
      pendingVerification: false,
    });
    const storedReason = amGap === 0
      ? (ref.starting == null ? clipVerificationNote(reasonForCheck) : null)
      : clipVerificationNote(incomingReason || note);
    const rowFields = {
      date, vaccine_id,
      morning: physical, additional, pmCount, used, status,
      expiration_date, remarks: note || null, staff,
      previous_verified_stock: previous,
      stock_difference: diff,
      difference_status: sheetStatus,
      verification_reason: storedReason,
      physical_count: physical,
      expected_am: expected,
      additional_receipt_qty: additional,
      verified: true,
    };
    await upsertClinicRow(conn, { ...rowFields, shift: 'Morning Shift' });
    await stampPmAdditional(conn, date, vaccine_id, 'Morning Shift', 0);
    const morningSaved = await fetchRow(conn, date, vaccine_id, 'Morning Shift');
    await alignVerifiedAmStock(conn, {
      recordId: morningSaved && morningSaved.record_id,
      vaccineId: vaccine_id,
      physical,
      expected,
      date,
      staff,
    });
    let stock = null;
    if (pmRow) {
      await upsertClinicRow(conn, {
        ...rowFields,
        shift: 'Afternoon Shift',
        additional: pmAdditional,
        additional_receipt_qty: pmAdditional,
        stock_difference: sheetDiff.stock_difference,
        difference_status: sheetDiff.difference_status,
      });
      await stampPmAdditional(conn, date, vaccine_id, 'Afternoon Shift', pmAdditional);
      if (pmCount != null && used != null) {
        stock = await syncSheetUsageDeduction(conn, {
          date, vaccineId: vaccine_id, used, staff,
          counts: { am: physical, additional: pmAdditional, pm: pmCount },
        });
      }
    }
    return {
      ...savedPayload({
        date, shift: 'Morning Shift', vaccine_id,
        am: physical, additional, pmCount, used, status,
        previous, expected, diff,
        difference_status: sheetStatus,
        verification_reason: rowFields.verification_reason,
        remarks: note || null,
        opening_balance: ref.opening_balance,
        pm_difference: pmCount != null ? sheetDiff.stock_difference : null,
      }),
      current_stock: stock ? stock.currentStock : undefined,
    };
  });
}

async function savePmCount(conn, {
  record_date, vaccine_id, remaining_pm_shift, physical_count,
  pm_additional_vaccine, expiration_date, remarks, staff = {},
}) {
  const date = toYmd(record_date) || localYmd();
  await requireActiveManagedVaccine(conn, vaccine_id);
  await ensureDailyRecordSchema(conn);
  const pm = nullableNum(remaining_pm_shift != null ? remaining_pm_shift : physical_count);
  if (pm == null || pm < 0) fail('Enter the PM physical inventory count.');

  return withTx(conn, async () => {
    const amRow = await fetchRow(conn, date, vaccine_id, 'Morning Shift');
    if (!amRow || !isAmOfficial(amRow)) {
      fail('Verify the AM inventory for this date and vaccine before entering the PM count.');
    }
    
    // LOCK: Block re-submission if PM shift already recorded
    const existingPm = await fetchRow(conn, date, vaccine_id, 'Afternoon Shift');
    if (existingPm && isPmOfficial(existingPm)) {
      fail('PM inventory has already been submitted and is locked. Use the physical count correction endpoint to make changes.');
    }
    
    const am = nullableNum(amRow.physical_count != null
      ? amRow.physical_count : amRow.morning_shift_inventory);
    if (am == null) fail('Save the AM inventory for this date and vaccine before entering the PM count.');
    const ref = await fetchAmReference(conn, vaccine_id, date);
    const additional = num(amRow.additional_vaccine);
    // Use user-provided PM Additional if available, otherwise get from reference
    const pmAdditional = pm_additional_vaccine != null ? num(pm_additional_vaccine) : num(ref.pm_additional);
    const previous = nullableNum(amRow.previous_verified_stock);
    const expected = nullableNum(amRow.expected_remaining);
    const used = totalUsedFromCounts({
      previous, additional: 0, physical: am, pm, pmAdditional,
    });
    if (used == null) fail('Unable to calculate Vaccine Used.');
    if (used < 0) {
      fail(
        `PM inventory (${pm}) is greater than the verified AM count plus PM additional stock. Review the counts. Vaccine Used cannot be negative.`
      );
    }
    const sheetDiff = clinicStockDifference({
      am, additional: pmAdditional, pm, totalUsed: used,
    });
    const diff = amDifference(am, expected);
    const status = 'Completed';
    const nextRemarks = remarks || amRow.remarks || null;
    const expiry = expiration_date || amRow.expiration_date || null;
    const rowFields = {
      date, vaccine_id,
      morning: am, additional, pmCount: pm, used, status,
      expiration_date: expiry, remarks: nextRemarks, staff,
      previous_verified_stock: previous,
      stock_difference: diff,
      difference_status: amRow.difference_status || (diff === 0 ? 'Matched' : 'Verified'),
      verification_reason: amRow.verification_reason || null,
      physical_count: am,
      expected_am: expected,
      additional_receipt_qty: additional,
      verified: true,
    };
    await upsertClinicRow(conn, { ...rowFields, shift: 'Morning Shift' });
    await stampPmAdditional(conn, date, vaccine_id, 'Morning Shift', 0);
    const morningSaved = await fetchRow(conn, date, vaccine_id, 'Morning Shift');
    await alignVerifiedAmStock(conn, {
      recordId: morningSaved && morningSaved.record_id,
      vaccineId: vaccine_id,
      physical: am,
      expected,
      date,
      staff,
    });
    await upsertClinicRow(conn, {
      ...rowFields,
      shift: 'Afternoon Shift',
      additional: pmAdditional,
      additional_receipt_qty: pmAdditional,
      stock_difference: sheetDiff.stock_difference,
      difference_status: sheetDiff.difference_status,
    });
    await stampPmAdditional(conn, date, vaccine_id, 'Afternoon Shift', pmAdditional);
    const stock = await syncSheetUsageDeduction(conn, {
      date, vaccineId: vaccine_id, used, staff, counts: { am, additional: pmAdditional, pm },
    });
    return {
      ...savedPayload({
        date, shift: 'Afternoon Shift', vaccine_id,
        am, additional, pmCount: pm, used, status,
        previous, expected, diff,
        difference_status: rowFields.difference_status,
        verification_reason: rowFields.verification_reason,
        remarks: nextRemarks,
        pm_difference: sheetDiff.stock_difference,
      }),
      current_stock: stock.currentStock,
    };
  });
}

module.exports = {
  saveAmInventory,
  savePmCount,
  vaccineUsedFromCounts,
  persistVaccineUsed,
  ensureDailyRecordSchema,
  clinicUsageFromCounts,
};
