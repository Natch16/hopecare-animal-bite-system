'use strict';

const { normalizeShift, getCurrentShift } = require('./shiftHelper');
const { localYmd, toYmd, remainingOf, sheetLabel, amExpectedRemaining, displayRecordStatus, shiftLedgerFields, vaccineUsedFromCounts, clinicCountStatus, currentHistoryRemarks } = require('./vaccineInventorySheet');
const { totalUsedFromCounts, pmAdditionalOf } = require('./inventoryShiftUsage');
const { clinicStockDifference, isAmOfficial, isPmOfficial, currentVerifiedStock, verificationExplanation } = require('./inventoryAmVerification');
const { fetchInventoryCatalog, requireActiveManagedVaccine } = require('./vaccineCatalog');

function nullableNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isOpeningRecorded(row) {
  if (!row) return false;
  if (Number(row.opening_recorded) === 1) return true;
  const status = String(row.inventory_status || '');
  return ['Recorded', 'Late Entry', 'Adjusted', 'Open', 'Closed', 'Completed', 'Pending PM Count'].includes(status);
}

function isShiftClosed(row) {
  return !!(row && String(row.shift_status || '').toLowerCase() === 'closed');
}

function deriveWorkflowStatus(row, dateYmd, shift, now = new Date()) {
  if (!row) return 'Not Recorded';
  const recorded = isOpeningRecorded(row);
  const hasCounts = nullableNum(row.morning_shift_inventory) != null
    || nullableNum(row.remaining_pm_shift) != null
    || nullableNum(row.physical_count) != null;
  const activity = num(row.vaccine_used) > 0 || num(row.additional_vaccine) > 0;
  if (!recorded && !hasCounts && !activity) return 'Not Recorded';
  const late = Number(row.late_entry) === 1 || row.inventory_status === 'Late Entry';
  if (isShiftClosed(row)) return late ? 'Late Entry' : 'Closed';
  if (late) return 'Late Entry';
  if (recorded) return 'Open';
  return 'Pending';
}

function deriveInventoryStatus(row, dateYmd, shift, now = new Date()) {
  return deriveWorkflowStatus(row, dateYmd, shift, now);
}

function shiftHasEnded(dateYmd, shift, now = new Date()) {
  const day = toYmd(dateYmd);
  const today = localYmd(now);
  if (!day) return false;
  if (day < today) return true;
  if (day > today) return false;
  const hour = now.getHours();
  if (normalizeShift(shift) === 'Morning Shift') return hour >= 14;
  return hour >= 22;
}

function shiftHasStarted(dateYmd, shift, now = new Date()) {
  const day = toYmd(dateYmd);
  const today = localYmd(now);
  if (!day) return false;
  if (day < today) return true;
  if (day > today) return false;
  if (normalizeShift(shift) === 'Morning Shift') return now.getHours() >= 6;
  return now.getHours() >= 14;
}

function displayCount(value, recorded) {
  if (!recorded || value === null || value === undefined || value === '') return null;
  return nullableNum(value);
}

function computeShiftBalance({ beginning, additional, used } = {}) {
  const begin = nullableNum(beginning);
  const add = num(additional);
  const usedN = num(used);
  const expected = begin == null ? null : remainingOf(begin, add, usedN);
  return {
    beginning: begin,
    additional: add,
    used: usedN,
    expected_remaining: expected,
  };
}

function amCarryRemaining(amRow) {
  return amExpectedRemaining(amRow);
}

function amVerifiedRemaining(amRow) {
  if (!isOpeningRecorded(amRow) || !isShiftClosed(amRow)) return null;
  return amExpectedRemaining(amRow);
}

function addDaysYmd(ymd, days) {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + days);
  return localYmd(d);
}

async function listShiftVaccines(pool) {
  const [lots] = await pool.query(
    `SELECT DISTINCT vaccine_id FROM vaccine_inventory`
  ).catch(() => [[]]);
  return fetchInventoryCatalog(pool, {
    activeOnly: true,
    extraIds: (lots || []).map((r) => r.vaccine_id),
  });
}

async function fetchDailyRow(conn, date, vaccineId, shift) {
  const recShift = normalizeShift(shift);
  const [[row]] = await conn.query(
    `SELECT * FROM inventory_daily_records
     WHERE record_date = ? AND vaccine_id = ? AND shift = ? LIMIT 1`,
    [date, vaccineId, recShift]
  );
  if (row) return row;
  const alts = recShift === 'Morning Shift'
    ? ['Morning', 'AM', 'morning']
    : ['Afternoon', 'PM', 'Evening', 'afternoon', 'evening'];
  const [altsRows] = await conn.query(
    `SELECT * FROM inventory_daily_records
     WHERE record_date = ? AND vaccine_id = ? AND shift IN (?) LIMIT 1`,
    [date, vaccineId, alts]
  );
  return (altsRows && altsRows[0]) || null;
}

async function getPreviousPmRemaining(conn, vaccineId, beforeDate) {
  const { fetchPreviousVerifiedStock } = require('./inventoryAmVerification');
  return fetchPreviousVerifiedStock(conn, vaccineId, beforeDate);
}

async function completePhysical(conn, {
  record_date,
  vaccine_id,
  shift,
  physical_count,
  additional_vaccine,
  vaccine_used,
  expiration_date,
  remarks,
  staff = {},
  late = null,
  reconciling = false,
  reconciliation_remarks = null,
}) {
  const date = toYmd(record_date) || localYmd();
  const recShift = normalizeShift(shift);
  if (!reconciling) {
    await requireActiveManagedVaccine(conn, vaccine_id);
  }
  const count = nullableNum(physical_count);

  const row = await fetchDailyRow(conn, date, vaccine_id, recShift);

  const alreadyClosed = row && String(row.shift_status || '').toLowerCase() === 'closed';
  if (alreadyClosed && !reconciling) {
    const err = new Error('This shift is closed. Use reconciliation to correct a finalized inventory record.');
    err.status = 400;
    throw err;
  }

  const additional = additional_vaccine != null ? num(additional_vaccine)
    : (row ? num(row.additional_vaccine) : 0);
  const used = vaccine_used != null ? num(vaccine_used)
    : (row ? num(row.vaccine_used) : 0);
  if (additional < 0 || used < 0) {
    const err = new Error('Quantities cannot be negative');
    err.status = 400;
    throw err;
  }

  const prevPm = recShift === 'Morning Shift'
    ? await getPreviousPmRemaining(conn, vaccine_id, date)
    : null;

  let morningVal;
  let remainingVal;
  let expectedVal;
  if (recShift === 'Morning Shift') {
    if (count === null || count < 0) {
      const err = new Error('AM beginning stock is required');
      err.status = 400;
      throw err;
    }
    morningVal = count;
    expectedVal = remainingOf(count, additional, used);
    remainingVal = expectedVal;
    if (used > count + additional) {
      const err = new Error('Vaccine used cannot exceed AM inventory plus additional vaccine');
      err.status = 400;
      throw err;
    }
    if (prevPm && count !== prevPm.remaining) {
      if (!String(remarks || '').trim() && !reconciling) {
        const err = new Error(
          `Remarks are required when the AM beginning stock (${count}) differs from the previous PM remaining (${prevPm.remaining} on ${prevPm.date})`
        );
        err.status = 400;
        throw err;
      }
    }
  } else {
    const amRow = await fetchDailyRow(conn, date, vaccine_id, 'Morning Shift');
    const amOpening = isOpeningRecorded(amRow) ? nullableNum(amRow.morning_shift_inventory) : null;
    if (amOpening == null) {
      const err = new Error('Morning Shift inventory must be recorded before PM remaining can be completed');
      err.status = 400;
      throw err;
    }
    const amRemaining = remainingOf(amOpening, amRow.additional_vaccine, amRow.vaccine_used);
    if (amRemaining == null) {
      const err = new Error('Morning Shift inventory is incomplete. Record AM inventory before the PM remaining.');
      err.status = 400;
      throw err;
    }
    morningVal = amRemaining;
    expectedVal = remainingOf(amRemaining, additional, used);
    remainingVal = expectedVal;
    if (used > amRemaining + additional) {
      const err = new Error('Vaccine used cannot exceed the AM remaining balance plus additional vaccine');
      err.status = 400;
      throw err;
    }
  }
  if (remainingVal != null && remainingVal < 0) {
    const err = new Error('Remaining stock cannot be negative. Check beginning stock, additional vaccine, and used quantity.');
    err.status = 400;
    throw err;
  }
  const hasDiscrepancy = false;
  const isLate = late != null
    ? !!late
    : (alreadyClosed || shiftHasEnded(date, recShift));
  let inventoryStatus;
  if (alreadyClosed && reconciling) inventoryStatus = isLate ? 'Late Entry' : 'Closed';
  else if (isLate) inventoryStatus = 'Late Entry';
  else if (expectedVal == null) inventoryStatus = 'Pending';
  else inventoryStatus = 'Open';
  const shiftStatusVal = alreadyClosed ? 'Closed' : 'Open';

  const nextRemarks = remarks
    || (reconciling ? (reconciliation_remarks || 'Inventory reconciliation') : null)
    || (isLate ? 'Late inventory entry' : null);

  const payload = [
    date, vaccine_id, morningVal, used, remainingVal, additional,
    expiration_date || (row && row.expiration_date) || null,
    nextRemarks || (row && row.remarks) || null,
    recShift,
    staff.staff_id || null, staff.full_name || '', staff.staff_id_display || null,
    1, inventoryStatus, isLate ? 1 : 0, new Date(),
    count, Number.isFinite(expectedVal) ? expectedVal : null,
    reconciling ? 0 : (hasDiscrepancy ? 1 : (row ? Number(row.needs_reconciliation) || 0 : 0)),
    reconciling ? 1 : (row ? Number(row.reconciled) || 0 : 0),
    reconciling ? new Date() : (row && row.reconciled_at) || null,
    reconciling ? (staff.staff_id || null) : (row && row.reconciled_by) || null,
    reconciling ? (staff.full_name || null) : (row && row.reconciled_by_name) || null,
    reconciling ? (reconciliation_remarks || remarks || null) : (row && row.reconciliation_remarks) || null,
    alreadyClosed ? 'Closed' : 'Open',
  ];

  const recordedAt = new Date();
  const expectedStore = Number.isFinite(expectedVal) ? expectedVal : null;

  if (row && row.record_id) {
    try {
      await conn.query(
        `UPDATE inventory_daily_records SET
           morning_shift_inventory = ?,
           vaccine_used = ?,
           remaining_pm_shift = ?,
           additional_vaccine = ?,
           expiration_date = COALESCE(?, expiration_date),
           remarks = COALESCE(?, remarks),
           shift = ?,
           recorded_by = ?,
           recorded_by_name = ?,
           recorded_by_id_display = ?,
           opening_recorded = 1,
           inventory_status = ?,
           late_entry = ?,
           recorded_at = ?,
           physical_count = ?,
           expected_remaining = ?,
           needs_reconciliation = ?,
           reconciled = ?,
           reconciled_at = ?,
           reconciled_by = ?,
           reconciled_by_name = ?,
           reconciliation_remarks = COALESCE(?, reconciliation_remarks),
           shift_status = IF(LOWER(COALESCE(shift_status,'open'))='closed', shift_status, 'Open')
         WHERE record_id = ?`,
        [
          morningVal, used, remainingVal, additional,
          expiration_date || (row && row.expiration_date) || null,
          nextRemarks || (row && row.remarks) || null,
          recShift,
          staff.staff_id || null, staff.full_name || '', staff.staff_id_display || null,
          inventoryStatus, isLate ? 1 : 0, recordedAt, count, expectedStore,
          reconciling ? 0 : (hasDiscrepancy ? 1 : (Number(row.needs_reconciliation) || 0)),
          reconciling ? 1 : (Number(row.reconciled) || 0),
          reconciling ? recordedAt : (row.reconciled_at || null),
          reconciling ? (staff.staff_id || null) : (row.reconciled_by || null),
          reconciling ? (staff.full_name || null) : (row.reconciled_by_name || null),
          reconciling ? (reconciliation_remarks || remarks || null) : (row.reconciliation_remarks || null),
          row.record_id,
        ]
      );
    } catch (err) {
      console.error('Inventory daily record update failed, using core columns:', err.message);
      await conn.query(
        `UPDATE inventory_daily_records SET
           morning_shift_inventory = ?,
           vaccine_used = ?,
           remaining_pm_shift = ?,
           additional_vaccine = ?,
           expiration_date = COALESCE(?, expiration_date),
           remarks = COALESCE(?, remarks),
           recorded_by = ?,
           recorded_by_name = ?,
           recorded_by_id_display = ?,
           opening_recorded = 1,
           inventory_status = ?,
           late_entry = ?,
           recorded_at = ?,
           physical_count = ?
         WHERE record_id = ?`,
        [
          morningVal, used, remainingVal, additional,
          expiration_date || null, nextRemarks || (row && row.remarks) || null,
          staff.staff_id || null, staff.full_name || '', staff.staff_id_display || null,
          inventoryStatus, isLate ? 1 : 0, recordedAt, count, row.record_id,
        ]
      );
    }
  } else {
    try {
      await conn.query(
        `INSERT INTO inventory_daily_records
           (record_date, vaccine_id, morning_shift_inventory, vaccine_used, remaining_pm_shift,
            additional_vaccine, expiration_date, remarks, shift,
            recorded_by, recorded_by_name, recorded_by_id_display,
            opening_recorded, inventory_status, late_entry, recorded_at,
            physical_count, expected_remaining, needs_reconciliation,
            reconciled, reconciled_at, reconciled_by, reconciled_by_name, reconciliation_remarks,
            shift_status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           morning_shift_inventory=VALUES(morning_shift_inventory),
           remaining_pm_shift=VALUES(remaining_pm_shift),
           additional_vaccine=VALUES(additional_vaccine),
           vaccine_used=VALUES(vaccine_used),
           expiration_date=COALESCE(VALUES(expiration_date), expiration_date),
           remarks=COALESCE(VALUES(remarks), remarks),
           recorded_by=VALUES(recorded_by),
           recorded_by_name=VALUES(recorded_by_name),
           recorded_by_id_display=VALUES(recorded_by_id_display),
           opening_recorded=1,
           inventory_status=VALUES(inventory_status),
           late_entry=VALUES(late_entry),
           recorded_at=VALUES(recorded_at),
           physical_count=VALUES(physical_count),
           expected_remaining=VALUES(expected_remaining),
           needs_reconciliation=VALUES(needs_reconciliation),
           reconciled=VALUES(reconciled),
           reconciled_at=VALUES(reconciled_at),
           reconciled_by=VALUES(reconciled_by),
           reconciled_by_name=VALUES(reconciled_by_name),
           reconciliation_remarks=COALESCE(VALUES(reconciliation_remarks), reconciliation_remarks)`,
        payload
      );
    } catch (err) {
      console.error('Inventory daily record save (full columns) failed, using fallback:', err.message);
      await conn.query(
        `INSERT INTO inventory_daily_records
           (record_date, vaccine_id, morning_shift_inventory, vaccine_used, remaining_pm_shift,
            additional_vaccine, expiration_date, remarks, shift, recorded_by, recorded_by_name, recorded_by_id_display,
            opening_recorded, inventory_status, late_entry, recorded_at, physical_count)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           morning_shift_inventory=VALUES(morning_shift_inventory),
           vaccine_used=VALUES(vaccine_used),
           remaining_pm_shift=VALUES(remaining_pm_shift),
           additional_vaccine=VALUES(additional_vaccine),
           expiration_date=COALESCE(VALUES(expiration_date), expiration_date),
           remarks=COALESCE(VALUES(remarks), remarks),
           recorded_by=VALUES(recorded_by),
           recorded_by_name=VALUES(recorded_by_name),
           recorded_by_id_display=VALUES(recorded_by_id_display),
           opening_recorded=1,
           inventory_status=VALUES(inventory_status),
           late_entry=VALUES(late_entry),
           recorded_at=VALUES(recorded_at),
           physical_count=VALUES(physical_count)`,
        [
          date, vaccine_id, morningVal, used, remainingVal, additional,
          expiration_date || (row && row.expiration_date) || null,
          nextRemarks || (row && row.remarks) || null, recShift,
          staff.staff_id || null, staff.full_name || '', staff.staff_id_display || null,
          1, inventoryStatus, isLate ? 1 : 0, recordedAt, count,
        ]
      );
    }
  }

  if (recShift === 'Morning Shift') {
    await syncAfternoonBeginning(conn, date, vaccine_id, expectedVal);
  }

  const savedStatus = displayRecordStatus({
    opening_recorded: 1,
    inventory_status: inventoryStatus,
    late_entry: isLate ? 1 : 0,
  });
  return {
    record_date: date,
    shift: recShift,
    vaccine_id,
    expected_remaining: Number.isFinite(expectedVal) ? expectedVal : null,
    inventory_status: savedStatus,
    shift_status: alreadyClosed ? 'Closed' : 'Open',
    opening_recorded: true,
    sheet_status: savedStatus,
    late_entry: !!isLate,
    recorded_at: new Date(),
    recorded_by_name: staff.full_name || null,
    previous_pm: prevPm,
    beginning_stock: morningVal,
    remaining_pm_shift: remainingVal,
    am_closed: recShift === 'Afternoon Shift' ? isShiftClosed(await fetchDailyRow(conn, date, vaccine_id, 'Morning Shift')) : true,
  };
}

async function syncAfternoonBeginning(conn, date, vaccineId, amRemaining) {
  if (amRemaining == null) return;
  const pmRow = await fetchDailyRow(conn, date, vaccineId, 'Afternoon Shift');
  if (!pmRow || !pmRow.record_id || isShiftClosed(pmRow)) return;
  const expected = remainingOf(amRemaining, pmRow.additional_vaccine, pmRow.vaccine_used);
  await conn.query(
    `UPDATE inventory_daily_records
     SET morning_shift_inventory = ?, expected_remaining = ?, remaining_pm_shift = ?
     WHERE record_id = ?`,
    [amRemaining, expected, expected, pmRow.record_id]
  ).catch(() => {});
}

async function closeShift(conn, { record_date, shift, staff = {}, notes = null }) {
  const date = toYmd(record_date) || localYmd();
  const recShift = normalizeShift(shift);
  const [[existingClose]] = await conn.query(
    `SELECT closure_id, shift_status FROM inventory_shift_closures
     WHERE shift_date = ? AND shift = ? LIMIT 1`,
    [date, recShift]
  ).catch(() => [[]]);
  if (existingClose && String(existingClose.shift_status || '').toLowerCase() === 'closed') {
    const err = new Error(`${recShift} on ${date} is already closed`);
    err.status = 400;
    throw err;
  }

  if (recShift === 'Afternoon Shift') {
    const [[amClose]] = await conn.query(
      `SELECT closure_id, shift_status FROM inventory_shift_closures
       WHERE shift_date = ? AND shift = 'Morning Shift' LIMIT 1`,
      [date]
    ).catch(() => [[]]);
    if (!amClose || String(amClose.shift_status || '').toLowerCase() !== 'closed') {
      const err = new Error(
        'The AM Shift has not been closed. Please verify the previous shift inventory before finalizing the PM Shift.'
      );
      err.status = 400;
      throw err;
    }
  }

  const vaccines = await listShiftVaccines(conn);
  const loaded = [];
  const incomplete = [];
  for (const v of vaccines) {
    const row = await fetchDailyRow(conn, date, v.vaccine_id, recShift);
    const recorded = isOpeningRecorded(row);
    if (!recorded) continue;
    if (recShift === 'Morning Shift' && nullableNum(row.morning_shift_inventory) == null) incomplete.push(v.name);
    if (num(row.vaccine_used) < 0 || num(row.additional_vaccine) < 0) incomplete.push(v.name);
    loaded.push({ v, row, recorded });
  }
  if (!loaded.length) {
    const err = new Error(`Cannot close ${recShift}: no inventory has been recorded for this date. Save the shift counts first.`);
    err.status = 400;
    throw err;
  }
  if (incomplete.length) {
    const err = new Error(
      `Cannot close ${recShift}: beginning stock is missing for ${[...new Set(incomplete)].join(', ')}. Record inventory before closing.`
    );
    err.status = 400;
    throw err;
  }

  const closedAt = new Date();
  await conn.beginTransaction();
  try {
    for (const { row } of loaded) {
      const late = Number(row.late_entry) === 1;
      const inventoryStatus = late ? 'Late Entry' : 'Closed';
      let begin = nullableNum(row.morning_shift_inventory);
      if (recShift === 'Afternoon Shift') {
        const amRow = await fetchDailyRow(conn, date, row.vaccine_id, 'Morning Shift');
        const amRem = amExpectedRemaining(amRow);
        if (amRem != null) begin = amRem;
      }
      const expected = remainingOf(begin, row.additional_vaccine, row.vaccine_used);
      await conn.query(
        `UPDATE inventory_daily_records
         SET shift_status = 'Closed',
             inventory_status = ?,
             closed_at = ?,
             closed_by = ?,
             closed_by_name = ?,
             morning_shift_inventory = COALESCE(?, morning_shift_inventory),
             remaining_pm_shift = ?,
             expected_remaining = ?
         WHERE record_id = ?`,
        [
          inventoryStatus, closedAt, staff.staff_id || null, staff.full_name || '',
          begin, expected, expected, row.record_id,
        ]
      ).catch(async () => {
        await conn.query(
          `UPDATE inventory_daily_records SET shift_status = 'Closed', inventory_status = ? WHERE record_id = ?`,
          [inventoryStatus, row.record_id]
        );
      });
    }

    await conn.query(
      `INSERT INTO inventory_shift_closures
         (shift_date, shift, shift_status, closed_at, closed_by, closed_by_name, notes)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         shift_status=VALUES(shift_status),
         closed_at=VALUES(closed_at),
         closed_by=VALUES(closed_by),
         closed_by_name=VALUES(closed_by_name),
         notes=COALESCE(VALUES(notes), notes)`,
      [
        date, recShift, 'Closed', closedAt,
        staff.staff_id || null, staff.full_name || '', notes || null,
      ]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  }

  return { date, shift: recShift, vaccines: loaded.length, closed_at: closedAt };
}

async function listPendingAlerts(pool, { days = 14 } = {}) {
  const today = localYmd();
  const from = addDaysYmd(today, -Math.abs(Number(days) || 14));
  const vaccines = await listShiftVaccines(pool);
  const [rows] = await pool.query(
    `SELECT idr.*, v.name AS vaccine_name
     FROM inventory_daily_records idr
     JOIN vaccines v ON v.vaccine_id = idr.vaccine_id
     WHERE idr.record_date BETWEEN ? AND ?`,
    [from, today]
  ).catch(() => [[]]);
  const map = new Map();
  for (const r of rows || []) {
    map.set(`${toYmd(r.record_date)}::${r.shift}::${r.vaccine_id}`, r);
  }

  const groups = [];
  for (let d = from; d <= today; d = addDaysYmd(d, 1)) {
    for (const sh of ['Morning Shift', 'Afternoon Shift']) {
      if (!shiftHasStarted(d, sh)) continue;
      const items = [];
      for (const v of vaccines) {
        const rec = map.get(`${d}::${sh}::${v.vaccine_id}`);
        const status = deriveWorkflowStatus(rec, d, sh);
        if (status === 'Closed') continue;
        items.push({
          vaccine_id: v.vaccine_id,
          vaccine_name: v.name,
          sheet_label: sheetLabel(v.name),
          status,
          record_id: rec ? rec.record_id : null,
          needs_reconciliation: rec ? Number(rec.needs_reconciliation) === 1 : false,
        });
      }
      if (!items.length) continue;
      const status = items.some((i) => i.status === 'Pending' || i.status === 'Open')
        ? 'Pending'
        : (shiftHasEnded(d, sh) ? 'Not Recorded' : 'Pending');
      groups.push({
        date: d,
        shift: sh,
        status,
        vaccines: items,
        action: 'Complete Inventory',
      });
    }
  }
  return groups;
}

function shiftCountProgress({ hasRow, recorded, official }) {
  if (!hasRow && !recorded) return 'Not Started';
  if (!recorded) return 'In Progress';
  if (official) return 'Verified';
  return 'Saved';
}

function completionStatus({ recordedAm, recordedPm }) {
  if (recordedAm && recordedPm) return 'Both Shifts Completed';
  if (!recordedAm && !recordedPm) return 'Not Started';
  if (recordedAm) return 'Missing PM Inventory';
  return 'Missing AM Inventory';
}

function verificationLabel({
  recordedAm, recordedPm, differenceStatus, verificationReason, verifiedAt,
}) {
  const ds = String(differenceStatus || '');
  if (verificationReason && (verifiedAt || ds === 'Verified')) return 'Verified Correction';
  if (recordedPm && ds === 'Matched') return 'Matched';
  if (recordedPm && ds === 'Variance') return 'Variance Detected';
  if (recordedAm && !recordedPm) return 'Pending';
  if (!recordedAm) return 'Not Started';
  return 'Pending Verification';
}

function overallDashboardStatus(summary) {
  if (!summary || summary.total_vaccines <= 0) return 'Not Started';
  if (summary.vaccines_pending <= 0 && summary.both_completed > 0) return 'Complete';
  if (summary.both_completed > 0 || summary.am_completed > 0 || summary.pm_completed > 0) return 'Incomplete';
  return 'Not Started';
}

function summarizeShiftDashboard(rows) {
  const list = rows || [];
  const summary = {
    am_completed: 0,
    pm_completed: 0,
    both_completed: 0,
    missing_am: 0,
    missing_pm: 0,
    vaccines_completed: 0,
    vaccines_pending: 0,
    total_vaccines: list.length,
    variance_count: 0,
    overall_status: 'Not Started',
  };
  for (const r of list) {
    const am = r.am_recorded === true || r.am_recorded === 1;
    const pm = r.pm_recorded === true || r.pm_recorded === 1;
    if (am) summary.am_completed += 1;
    if (pm) summary.pm_completed += 1;
    if (am && pm) {
      summary.both_completed += 1;
      summary.vaccines_completed += 1;
    } else {
      summary.vaccines_pending += 1;
    }
    if (!am && pm) summary.missing_am += 1;
    if (am && !pm) summary.missing_pm += 1;
    if (r.verification_status === 'Variance Detected' || r.difference_status === 'Variance') {
      summary.variance_count += 1;
    }
  }
  summary.overall_status = overallDashboardStatus(summary);
  return summary;
}

function matchesShiftDashboardFilter(row, {
  am_status, pm_status, completion, verification,
} = {}) {
  if (am_status && row.am_count_status !== am_status) return false;
  if (pm_status && row.pm_count_status !== pm_status) return false;
  if (completion && row.completion_status !== completion) return false;
  if (verification && row.verification_status !== verification) return false;
  return true;
}

function buildShiftStatusRow(am, pm, src, extras = {}) {
  const recordedAm = isOpeningRecorded(am);
  const recordedPm = isOpeningRecorded(pm) && nullableNum(pm && pm.remaining_pm_shift) != null;
    const amCount = recordedAm
      ? nullableNum(am.physical_count != null ? am.physical_count : am.morning_shift_inventory)
      : null;
  const additional = recordedAm ? num(am.additional_vaccine) : 0;
  const pmExtra = pmAdditionalOf(am, pm);
  const pmCount = recordedPm ? nullableNum(pm.remaining_pm_shift) : null;
  const used = totalUsedFromCounts({
    previous: am ? am.previous_verified_stock : null,
    additional: 0,
    physical: amCount,
    pm: pmCount,
    pmAdditional: pmExtra,
  });
  const previous = am ? nullableNum(am.previous_verified_stock) : null;
  const storedExpected = am ? nullableNum(am.expected_remaining) : null;
  const expectedAm = storedExpected != null
    ? storedExpected
    : (previous != null ? previous + additional : null);
  const verified = currentVerifiedStock({
    expectedAm,
    amCount: recordedAm ? amCount : null,
    pmCount: recordedPm ? pmCount : null,
  });
  const sheetDiff = clinicStockDifference({
    am: amCount,
    additional: pmExtra,
    pm: pmCount,
    totalUsed: used,
    vaccineName: src.vaccine_name,
  });
  const status = clinicCountStatus(amCount, pmCount);
  const amOfficial = isAmOfficial(am);
  const pmOfficial = isPmOfficial(pm) || (recordedPm && isPmOfficial(am));
  const amProgress = shiftCountProgress({
    hasRow: !!am, recorded: recordedAm, official: amOfficial,
  });
  const pmProgress = shiftCountProgress({
    hasRow: !!pm, recorded: recordedPm, official: pmOfficial,
  });
  const complete = completionStatus({ recordedAm, recordedPm });
  const verifiedAt = (am && am.verified_at) || (pm && pm.verified_at) || null;
  const verifiedBy = (am && am.verified_by_name) || (pm && pm.verified_by_name) || null;
  const reason = verificationExplanation(am) || verificationExplanation(pm) || null;
  const verify = verificationLabel({
    recordedAm,
    recordedPm,
    differenceStatus: verified.am_difference != null && verified.am_difference !== 0
      ? (reason ? 'Verified' : 'Variance')
      : sheetDiff.difference_status,
    verificationReason: reason,
    verifiedAt,
  });
  return {
    record_id: (am && am.record_id) || (pm && pm.record_id) || null,
    record_date: toYmd(src.record_date) || extras.record_date || null,
    vaccine_id: src.vaccine_id,
    vaccine_name: src.vaccine_name,
    sheet_label: sheetLabel(src.vaccine_name),
    category: src.category,
    inventory_am: amCount,
    morning_shift_inventory: amCount,
    additional_vaccine: additional,
    am_additional: additional,
    pm_additional: pmExtra,
    total_additional: additional + pmExtra,
    inventory_pm: pmCount,
    remaining_pm_shift: pmCount,
    vaccine_used: used,
    expected_am_stock: expectedAm,
    am_difference: verified.am_difference,
    current_verified_stock: verified.current_verified_stock,
    stock_difference: verified.am_difference,
    difference_status: verified.am_difference == null
      ? null
      : (verified.am_difference === 0 ? 'Matched' : (reason ? 'Verified' : 'Variance')),
    pm_difference: recordedPm ? sheetDiff.stock_difference : null,
    expected_pm_stock: sheetDiff.expected_pm_stock,
    inventory_status: status,
    sheet_status: status,
    am_recorded: recordedAm,
    pm_recorded: recordedPm,
    am_count_status: amProgress,
    pm_count_status: pmProgress,
    completion_status: complete,
    verification_status: verify,
    verification_reason: reason,
    am_recorded_by_name: am ? (am.recorded_by_name || null) : null,
    am_recorded_at: am ? (am.recorded_at || am.updated_at || null) : null,
    pm_recorded_by_name: pm ? (pm.recorded_by_name || null) : null,
    pm_recorded_at: pm ? (pm.recorded_at || pm.updated_at || null) : null,
    verified_by_name: verifiedBy,
    verified_at: verifiedAt,
    remarks: currentHistoryRemarks(am, pm) || (pm && pm.remarks) || (am && am.remarks) || src.remarks || null,
    expiration_date: (pm && pm.expiration_date) || (am && am.expiration_date) || src.expiration_date || null,
    recorded_by_name: (pm && pm.recorded_by_name) || (am && am.recorded_by_name) || src.recorded_by_name || null,
    recorded_at: (pm && (pm.recorded_at || pm.updated_at)) || (am && (am.recorded_at || am.updated_at)) || src.recorded_at || null,
    opening_recorded: recordedAm || recordedPm ? 1 : 0,
  };
}

async function listShiftHistory(pool, {
  date_from, date_to, vaccine_id, shift, search,
  am_status, pm_status, completion, verification,
} = {}) {
  let q = `SELECT idr.*, v.name AS vaccine_name, v.category
    FROM inventory_daily_records idr
    JOIN vaccines v ON v.vaccine_id = idr.vaccine_id WHERE 1=1`;
  const params = [];
  if (date_from) { q += ' AND idr.record_date >= ?'; params.push(date_from); }
  if (date_to) { q += ' AND idr.record_date <= ?'; params.push(date_to); }
  if (vaccine_id) { q += ' AND idr.vaccine_id = ?'; params.push(vaccine_id); }
  if (shift) { q += ' AND idr.shift = ?'; params.push(normalizeShift(shift)); }
  if (search) {
    q += ' AND (v.name LIKE ? OR idr.recorded_by_name LIKE ? OR idr.remarks LIKE ? OR idr.inventory_status LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  q += ' ORDER BY idr.record_date DESC, idr.shift ASC, v.name ASC LIMIT 1000';
  const [rows] = await pool.query(q, params);
  const list = rows || [];
  const amByKey = new Map();
  const pmByKey = new Map();
  for (const r of list) {
    const key = `${toYmd(r.record_date)}::${r.vaccine_id}`;
    if (normalizeShift(r.shift) === 'Morning Shift') amByKey.set(key, r);
    else pmByKey.set(key, r);
  }
  const missingAm = [...pmByKey.keys()].filter((k) => !amByKey.has(k));
  if (missingAm.length) {
    const dates = [...new Set(missingAm.map((k) => k.split('::')[0]))];
    const ids = [...new Set(missingAm.map((k) => Number(k.split('::')[1])))];
    const [amRows] = await pool.query(
      `SELECT idr.*, v.name AS vaccine_name, v.category
       FROM inventory_daily_records idr
       JOIN vaccines v ON v.vaccine_id = idr.vaccine_id
       WHERE shift = 'Morning Shift' AND record_date IN (?) AND idr.vaccine_id IN (?)`,
      [dates, ids]
    );
    for (const a of amRows || []) amByKey.set(`${toYmd(a.record_date)}::${a.vaccine_id}`, a);
  }
  const missingPm = [...amByKey.keys()].filter((k) => !pmByKey.has(k));
  if (missingPm.length) {
    const dates = [...new Set(missingPm.map((k) => k.split('::')[0]))];
    const ids = [...new Set(missingPm.map((k) => Number(k.split('::')[1])))];
    const [pmRows] = await pool.query(
      `SELECT idr.*, v.name AS vaccine_name, v.category
       FROM inventory_daily_records idr
       JOIN vaccines v ON v.vaccine_id = idr.vaccine_id
       WHERE shift = 'Afternoon Shift' AND record_date IN (?) AND idr.vaccine_id IN (?)`,
      [dates, ids]
    );
    for (const p of pmRows || []) pmByKey.set(`${toYmd(p.record_date)}::${p.vaccine_id}`, p);
  }
  const keys = new Set([...amByKey.keys(), ...pmByKey.keys()]);
  if (date_from && date_to && date_from === date_to && !search) {
    const catalog = await fetchInventoryCatalog(pool).catch(() => []);
    for (const v of catalog || []) {
      if (vaccine_id && Number(v.vaccine_id) !== Number(vaccine_id)) continue;
      const key = `${date_from}::${v.vaccine_id}`;
      if (keys.has(key)) continue;
      keys.add(key);
      amByKey.set(key, null);
      pmByKey.set(key, null);
      amByKey.set(`${key}::__src`, {
        record_date: date_from,
        vaccine_id: v.vaccine_id,
        vaccine_name: v.name,
        category: v.category,
      });
    }
  }
  const dashboardRows = [...keys].flatMap((key) => {
    if (String(key).endsWith('::__src')) return [];
    const am = amByKey.get(key);
    const pm = pmByKey.get(key);
    const src = am || pm || amByKey.get(`${key}::__src`);
    if (!src) return [];
    return [buildShiftStatusRow(am, pm, src, { record_date: date_from })];
  }).filter((row) => matchesShiftDashboardFilter(row, {
    am_status, pm_status, completion, verification,
  }));
  dashboardRows.sort((a, b) => {
    const dateCmp = String(b.record_date || '').localeCompare(String(a.record_date || ''));
    if (dateCmp) return dateCmp;
    return String(a.vaccine_name || '').localeCompare(String(b.vaccine_name || ''));
  });
  return dashboardRows;
}

module.exports = {
  nullableNum,
  isOpeningRecorded,
  shiftHasEnded,
  shiftHasStarted,
  deriveInventoryStatus,
  deriveWorkflowStatus,
  isShiftClosed,
  displayCount,
  computeShiftBalance,
  amCarryRemaining,
  amVerifiedRemaining,
  completePhysical,
  closeShift,
  listPendingAlerts,
  listShiftHistory,
  listShiftVaccines,
  getPreviousPmRemaining,
  shiftCountProgress,
  completionStatus,
  verificationLabel,
  summarizeShiftDashboard,
  matchesShiftDashboardFilter,
};
