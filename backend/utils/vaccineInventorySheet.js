'use strict';

const { normalizeShift, parseShiftQuery } = require('./shiftHelper');
const { pickManagedVaccines, fetchInventoryCatalog, isExcludedGenericVaccineName } = require('./vaccineCatalog');
const { enrichLot } = require('./inventoryBatches');
const { getExpiryStatus } = require('./inventoryHelpers');
const {
  expectedAmStock, isAmOfficial, isPmOfficial, clinicWorkflowStatus, clinicStockDifference,
  classifyShiftReceipts, dayAdditionalParts, exclusivePmAdditionalFromRows, currentVerifiedStock, verificationExplanation,
} = require('./inventoryAmVerification');
const { loadOpeningBalanceMap, startingFromParts } = require('./inventoryOpeningBalance');

/** @deprecated Display names now come from Vaccine Management (`vaccines.name`). */
const SHEET_LABELS = {};
const SHEET_ORDER = [];
const REPORT_SHEET_ORDER = [];

const STOCK_IN_TYPES = ['Stock In', 'Returned Vaccine'];
const ADMIN_USED_TYPES = ['Vaccine Usage', 'Usage'];
const USED_TYPES = ['Vaccine Usage', 'Usage', 'Stock Out', 'Damaged Vaccine', 'Expired Vaccine', 'Transfer'];

function sheetLabel(name) {
  return name == null ? '' : String(name);
}

function localYmd(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toYmd(v) {
  if (!v) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return localYmd(v);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function blankIfZero(v) {
  const n = num(v);
  return n === 0 ? '' : n;
}

/**
 * Apply Add Vaccine Stock / usage onto the day's inventory sheet row.
 * Uses Morning Shift as the canonical daily row so the paper sheet stays one line per vaccine per date.
 */
/**
 * Never copy a missing PM/AM count as the next opening.
 * Returns a recorded remaining value only; otherwise null.
 */
async function getOpeningStock(conn, vaccine_id, date, shift) {
  const recShift = normalizeShift(shift);
  if (recShift === 'Afternoon Shift') {
    const [[am]] = await conn.query(
      `SELECT * FROM inventory_daily_records
       WHERE record_date = ? AND vaccine_id = ? AND shift = 'Morning Shift' LIMIT 1`,
      [date, vaccine_id]
    );
    if (am && isOpeningRecorded(am) && String(am.shift_status || '').toLowerCase() === 'closed') {
      return amExpectedRemaining(am);
    }
    return null;
  }
  return null;
}

function remainingOf(morning, additional, used) {
  if (morning === null || morning === undefined || morning === '') return null;
  return Math.max(0, num(morning) + num(additional) - num(used));
}

/**
 * Vaccine Used = verified AM physical count + PM additional − PM count.
 * `additional` must be PM receipts only. AM receipts are already inside the physical count.
 */
function vaccineUsedFromCounts(am, additional, pm) {
  if (am === null || am === undefined || am === '' || pm === null || pm === undefined || pm === '') return null;
  return num(am) + num(additional) - num(pm);
}

function clinicUsageFromCounts({
  physical,
  pm,
}) {
  const pmUsed = vaccineUsedFromCounts(physical, 0, pm);
  return {
    am_vaccine_used: 0,
    pm_vaccine_used: pmUsed,
    vaccine_used: pmUsed,
  };
}

function clinicCountStatus(am, pm) {
  if (am === null || am === undefined || am === '') return 'Pending';
  if (pm === null || pm === undefined || pm === '') return 'Pending PM Count';
  return 'Completed';
}

function joinUniqueRemarks(parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts || []) {
    const pieces = String(part || '').split(/\s*;\s*/);
    for (const piece of pieces) {
      const item = piece.trim();
      if (!item) continue;
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out.join('; ');
}

/** The new correction reason becomes the only current remarks. Previous text is not appended. */
function replaceInventoryRemarks(_previousRemarks, nextReason) {
  const next = String(nextReason || '').trim();
  return next || null;
}

function correctionStamp(row) {
  if (!row || row.physical_corrected_at == null || row.physical_corrected_at === '') return 0;
  const t = new Date(row.physical_corrected_at).getTime();
  return Number.isFinite(t) ? t : 0;
}

function correctedRemarkText(row) {
  const reason = String((row && row.physical_correction_reason) || '').trim();
  const remarks = String((row && row.remarks) || '').trim();
  return reason || remarks;
}

/**
 * Inventory History remarks are the latest correction reason when a count was corrected.
 * Uncorrected AM and PM notes are left to the caller. Old and new reasons are not joined.
 */
function currentHistoryRemarks(am, pm) {
  const corrected = [am, pm].filter((row) => row && (
    correctionStamp(row) > 0 || String(row.physical_correction_reason || '').trim()
  ));
  if (!corrected.length) return null;
  corrected.sort((a, b) => correctionStamp(b) - correctionStamp(a));
  return correctedRemarkText(corrected[0]) || null;
}

function nullableNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isOpeningRecorded(row) {
  if (!row) return false;
  if (Number(row.opening_recorded) === 1) return true;
  const status = String(row.inventory_status || '');
  if (status === 'Recorded' || status === 'Late Entry' || status === 'Adjusted' || status === 'Open' || status === 'Closed' || status === 'Completed' || status === 'Pending PM Count') return true;
  return false;
}

function amExpectedRemaining(amRow) {
  if (!isOpeningRecorded(amRow)) return null;
  return remainingOf(amRow.morning_shift_inventory, amRow.additional_vaccine, amRow.vaccine_used);
}

function displayRecordStatus(row) {
  if (!isOpeningRecorded(row)) return 'Pending';
  if (Number(row.late_entry) === 1 || row.inventory_status === 'Late Entry') return 'Late Entry';
  return 'Recorded';
}

function shiftLedgerFields(row, amRow) {
  if (!row) {
    return {
      record_date: null,
      shift: null,
      beginning_inventory: null,
      beginning_stock: null,
      additional_vaccine: null,
      vaccine_used: null,
      expected_remaining: null,
      remaining_pm_shift: null,
      inventory_status: 'Pending',
      shift_status: 'Open',
    };
  }
  const recShift = normalizeShift(row.shift);
  const recorded = isOpeningRecorded(row);
  let beginning = null;
  if (recShift === 'Afternoon Shift') {
    const fromAm = amExpectedRemaining(amRow);
    beginning = fromAm != null ? fromAm : (recorded ? nullableNum(row.morning_shift_inventory) : null);
  } else {
    beginning = recorded ? nullableNum(row.morning_shift_inventory) : null;
  }
  const additional = recorded ? num(row.additional_vaccine) : null;
  const used = recorded ? num(row.vaccine_used) : null;
  const expected = recorded && beginning != null ? remainingOf(beginning, additional, used) : null;
  return {
    record_date: toYmd(row.record_date),
    shift: recShift,
    beginning_inventory: beginning,
    beginning_stock: beginning,
    additional_vaccine: additional,
    vaccine_used: used,
    expected_remaining: expected,
    remaining_pm_shift: expected,
    inventory_status: displayRecordStatus(row),
    shift_status: row.shift_status || 'Open',
  };
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

function deriveInventoryStatus(row, dateYmd, shift, now = new Date()) {
  if (!row) return 'Not Recorded';
  const recorded = isOpeningRecorded(row);
  const hasCounts = nullableNum(row.morning_shift_inventory) != null
    || nullableNum(row.remaining_pm_shift) != null
    || nullableNum(row.physical_count) != null;
  const activity = num(row.vaccine_used) > 0 || num(row.additional_vaccine) > 0;
  if (!recorded && !hasCounts && !activity) return 'Not Recorded';
  const late = Number(row.late_entry) === 1 || row.inventory_status === 'Late Entry';
  const closed = row && String(row.shift_status || '').toLowerCase() === 'closed';
  if (closed) return late ? 'Late Entry' : 'Closed';
  if (late) return 'Late Entry';
  if (recorded) return 'Open';
  return 'Pending';
}

async function applyDailySheetDelta(conn, {
  record_date,
  vaccine_id,
  additionalDelta = 0,
  usedDelta = 0,
  expiration_date = null,
  remarks = null,
  staff = {},
  shift = null,
}) {
  const date = toYmd(record_date) || localYmd();
  const recShift = normalizeShift(shift);
  const add = num(additionalDelta);
  const usedInc = num(usedDelta);

  const [[row]] = await conn.query(
    `SELECT * FROM inventory_daily_records
     WHERE record_date = ? AND vaccine_id = ? AND shift = ? LIMIT 1`,
    [date, vaccine_id, recShift]
  );

  if (row) {
    const additional = num(row.additional_vaccine) + add;
    const recorded = isOpeningRecorded(row);
    const morning = recorded ? nullableNum(row.morning_shift_inventory) : null;
    const pmCount = nullableNum(row.remaining_pm_shift);
    const remaining = pmCount;
    const used = morning != null && pmCount != null
      ? vaccineUsedFromCounts(morning, 0, pmCount)
      : (recorded ? nullableNum(row.vaccine_used) : null);
    const usedCol = used == null ? 0 : used;
    const nextRemarks = [row.remarks, remarks].filter(Boolean).join('; ') || null;
    const needsRecon = recorded ? 0 : 1;
    await conn.query(
      `UPDATE inventory_daily_records SET
         additional_vaccine = ?,
         vaccine_used = ?,
         remaining_pm_shift = ?,
         expected_remaining = ?,
         expiration_date = COALESCE(?, expiration_date),
         remarks = COALESCE(?, remarks),
         needs_reconciliation = ?
       WHERE record_id = ?`,
      [additional, usedCol, remaining, remaining, expiration_date || null, nextRemarks, needsRecon, row.record_id]
    ).catch(async () => {
      await conn.query(
        `UPDATE inventory_daily_records SET
           additional_vaccine = ?,
           vaccine_used = ?,
           remaining_pm_shift = ?,
           expiration_date = COALESCE(?, expiration_date),
           remarks = COALESCE(?, remarks)
         WHERE record_id = ?`,
        [additional, usedCol, remaining, expiration_date || null, nextRemarks, row.record_id]
      );
    });
    return { remaining, morning, additional, used, opening_recorded: recorded };
  }

  const additional = add;
  const used = usedInc;
  const morning = null;
  const remaining = null;
  const status = 'Pending';

  try {
    await conn.query(
      `INSERT INTO inventory_daily_records
         (record_date, vaccine_id, morning_shift_inventory, vaccine_used, remaining_pm_shift,
          additional_vaccine, expiration_date, remarks, shift,
          recorded_by, recorded_by_name, recorded_by_id_display,
          opening_recorded, inventory_status, late_entry, shift_status, needs_reconciliation)
       VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,0,?,0,'Open',1)`,
      [
        date, vaccine_id, used == null ? 0 : used, remaining, additional,
        expiration_date || null, remarks || null, recShift,
        staff.staff_id || null, staff.full_name || '', staff.staff_id_display || null,
        status,
      ]
    );
  } catch (_) {
    await conn.query(
      `INSERT INTO inventory_daily_records
         (record_date, vaccine_id, morning_shift_inventory, vaccine_used, remaining_pm_shift,
          additional_vaccine, expiration_date, remarks, shift,
          recorded_by, recorded_by_name, recorded_by_id_display)
       VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?)`,
      [
        date, vaccine_id, used == null ? 0 : used, remaining, additional,
        expiration_date || null, remarks || null, recShift,
        staff.staff_id || null, staff.full_name || '', staff.staff_id_display || null,
      ]
    );
  }
  return { remaining, morning, additional, used, opening_recorded: false };
}

async function getClinicSheet(pool, { date, shift, vaccine_id } = {}) {
  const recordDate = toYmd(date) || localYmd();
  const recShift = parseShiftQuery(shift);

  const [dailies] = await pool.query(
    `SELECT * FROM inventory_daily_records WHERE record_date = ?`,
    [recordDate]
  );
  const dailyMap = new Map();
  for (const r of dailies || []) {
    dailyMap.set(`${r.vaccine_id}::${normalizeShift(r.shift)}`, r);
  }

  const [expiries] = await pool.query(
    `SELECT * FROM vaccine_inventory`
  );
  const stockMap = new Map();
  const prevMap = new Map();
  for (const e of expiries || []) {
    const lot = enrichLot(e);
    const cur = stockMap.get(Number(e.vaccine_id)) || {
      on_hand: 0, usable: 0, next_expiry: null, expiry_date: null, depleted: true, expired: false,
    };
    cur.on_hand += Number(e.quantity) || 0;
    cur.usable += lot.usable_quantity;
    if (lot.batch_status === 'Expired') cur.expired = true;
    if (lot.usable_quantity > 0) {
      cur.depleted = false;
      const exp = lot.expiry_date ? toYmd(lot.expiry_date) : null;
      if (exp && (!cur.next_expiry || exp < cur.next_expiry)) cur.next_expiry = exp;
    }
    if (lot.expiry_date) cur.expiry_date = toYmd(lot.expiry_date);
    stockMap.set(Number(e.vaccine_id), cur);
  }

  const extraIds = [
    ...(dailies || []).map((r) => r.vaccine_id),
    ...(expiries || []).map((e) => e.vaccine_id),
  ];
  let list = await fetchInventoryCatalog(pool, { activeOnly: true, extraIds });
  if (vaccine_id) list = list.filter((v) => Number(v.vaccine_id) === Number(vaccine_id));

  const [prevRows] = await pool.query(
    `SELECT vaccine_id, morning_shift_inventory, additional_vaccine, vaccine_used, expected_remaining,
            remaining_pm_shift, record_date, shift, opening_recorded, inventory_status,
            needs_reconciliation, reconciled, shift_status
     FROM inventory_daily_records
     WHERE record_date < ? AND shift = 'Afternoon Shift'
     ORDER BY record_date DESC`,
    [recordDate]
  ).catch(() => [[]]);
  for (const r of prevRows || []) {
    const id = Number(r.vaccine_id);
    if (prevMap.has(id)) continue;
    const recorded = Number(r.opening_recorded) === 1;
    if (!recorded) continue;
    const st = String(r.inventory_status || '');
    if (['Pending', 'Pending Verification', 'Pending Initial Setup', 'Pending PM Count'].includes(st)) continue;
    if (String(r.difference_status || '') === 'Pending Verification') continue;
    const prevCount = nullableNum(r.remaining_pm_shift);
    if (prevCount == null) continue;
    prevMap.set(id, {
      remaining: prevCount,
      date: toYmd(r.record_date),
      shift: r.shift,
    });
  }

  let receiptRows = [];
  try {
    [receiptRows] = await pool.query(
      `SELECT vaccine_id, transaction_date AS d,
              COALESCE(corrected_quantity, quantity) AS qty
       FROM vaccine_transactions
       WHERE transaction_type IN ('Stock In','Returned Vaccine')
         AND DATE(transaction_date) <= ?
         AND DATE(transaction_date) >= DATE_SUB(?, INTERVAL 120 DAY)`,
      [recordDate, recordDate]
    );
  } catch (_) {
    [receiptRows] = await pool.query(
      `SELECT vaccine_id, transaction_date AS d, quantity AS qty
       FROM vaccine_transactions
       WHERE transaction_type IN ('Stock In','Returned Vaccine')
         AND DATE(transaction_date) <= ?
         AND DATE(transaction_date) >= DATE_SUB(?, INTERVAL 120 DAY)`,
      [recordDate, recordDate]
    ).catch(() => [[]]);
  }
  const receiptMap = new Map();
  for (const r of receiptRows || []) {
    const id = Number(r.vaccine_id);
    const list = receiptMap.get(id) || [];
    list.push({ date: toYmd(r.d), at: r.d, qty: Number(r.qty) || 0 });
    receiptMap.set(id, list);
  }
  const openingMap = await loadOpeningBalanceMap(pool, recordDate);

  const rows = recShift
    ? list.flatMap((v) => [buildShiftSheetRow(v, recShift, {
      recordDate, dailyMap, stockMap, prevMap, receiptMap, openingMap,
    })])
    : await Promise.all(list.map((v) => buildDailyPaperRow(v, {
      recordDate, dailyMap, stockMap, prevMap, receiptMap, openingMap, pool,
    })));
  return { date: recordDate, shift: recShift || 'Daily Sheet', view: recShift ? 'shift' : 'daily', rows };
}

function lotDisplay(stock, expiryYmd) {
  const lotLabel = stock.usable > 0 ? 'Available'
    : (stock.expired ? 'Expired' : (stock.depleted !== false && stock.on_hand === 0 ? 'Out of Stock' : (stock.usable === 0 && stock.on_hand > 0 ? 'Expired' : 'Out of Stock')));
  const near = expiryYmd ? getExpiryStatus(expiryYmd) : { class: 'exp-unknown', status: 'Unknown' };
  const displayLot = stock.usable > 0
    ? ((near.class === 'exp-7' || near.class === 'exp-15' || near.class === 'exp-30') ? 'Near Expiry' : 'Available')
    : lotLabel;
  return { near, displayLot };
}

function sheetStatus({ recorded, pendingVerify, expired, late, ended, adjusted, closed, open }) {
  if (closed) return late ? 'Late Entry' : 'Closed';
  if (adjusted) return 'Adjusted';
  if (expired) return 'Expired';
  if (late) return 'Late Entry';
  if (open || recorded) return 'Open';
  if (pendingVerify) return 'Pending';
  if (ended) return 'Not Recorded';
  return 'Pending';
}

function receiptsAfter(receiptMap, vaccineId, afterDate, throughDate) {
  return splitReceipts(receiptMap, vaccineId, afterDate, throughDate, null).am;
}

/**
 * Receipts after the previous verified date and through `throughDate`.
 * When `cutoff` is the AM verification time, receipts at or before it are AM additional
 * (already inside the AM physical count). Later receipts are PM additional and are counted once.
 */
function splitReceipts(receiptMap, vaccineId, afterDate, throughDate, cutoff) {
  const list = (receiptMap && receiptMap.get(Number(vaccineId))) || [];
  const cut = cutoff ? new Date(cutoff).getTime() : null;
  let am = 0;
  let pm = 0;
  for (const item of list) {
    const d = toYmd(item.date || item.at);
    if (!d || d > throughDate) continue;
    if (afterDate && d <= afterDate) continue;
    const at = item.at ? new Date(item.at).getTime() : null;
    if (cut != null && Number.isFinite(cut) && at != null && Number.isFinite(at) && at > cut) pm += num(item.qty);
    else am += num(item.qty);
  }
  return { am, pm };
}

async function buildDailyPaperRow(v, { recordDate, dailyMap, stockMap, prevMap, receiptMap, openingMap, pool }) {
  const amRec = dailyMap.get(`${v.vaccine_id}::Morning Shift`);
  const pmRec = dailyMap.get(`${v.vaccine_id}::Afternoon Shift`);
  const stock = stockMap.get(Number(v.vaccine_id)) || {};
  const amRecorded = isAmOfficial(amRec);
  const pmRecorded = isPmOfficial(pmRec) || (amRecorded && isPmOfficial(amRec));
  const amStatus = deriveInventoryStatus(amRec, recordDate, 'Morning Shift');
  const pmStatus = deriveInventoryStatus(pmRec, recordDate, 'Afternoon Shift');
  const amOpening = amRecorded
    ? nullableNum(amRec.physical_count != null ? amRec.physical_count : amRec.morning_shift_inventory)
    : null;
  const prevPm = prevMap.get(Number(v.vaccine_id)) || null;
  const storedPrev = amRec ? nullableNum(amRec.previous_verified_stock) : null;
  const previousVerified = storedPrev != null ? storedPrev : (prevPm ? prevPm.remaining : null);
  const cutoff = amRecorded
    ? ((amRec && (amRec.recorded_at || amRec.verified_at || amRec.updated_at)) || null)
    : null;
  const split = splitReceipts(receiptMap, v.vaccine_id, prevPm ? prevPm.date : null, recordDate, cutoff);
  const openingBalance = (openingMap && openingMap.get(Number(v.vaccine_id))) || 0;
  const baseline = previousVerified != null ? previousVerified : (openingBalance > 0 ? openingBalance : null);
  const classified = classifyShiftReceipts({
    baseline,
    physical: amOpening,
    amReceipts: split.am,
    pmReceipts: split.pm,
    storedAmAdditional: amRecorded && amRec ? nullableNum(amRec.additional_vaccine) : null,
  });
  const additional = classified.amAdditional;
  // Prefer the stamped pm_additional_vaccine column (set by stampPmAdditional during savePmCount)
  // over the receipt-derived pmAdditional — the column is authoritative when stock is added
  // via the daily records form rather than a separate Stock In transaction.
  const pmAdditionalFromDb = pmRec && pmRec.pm_additional_vaccine != null && pmRec.pm_additional_vaccine !== ''
    ? num(pmRec.pm_additional_vaccine)
    : (amRec && amRec.pm_additional_vaccine != null && amRec.pm_additional_vaccine !== ''
      ? num(amRec.pm_additional_vaccine)
      : null);
  const pmAdditional = pmAdditionalFromDb != null ? pmAdditionalFromDb : classified.pmAdditional;
  const addParts = dayAdditionalParts(additional, pmAdditional);
  const expectedAm = startingFromParts({
    previousPm: previousVerified,
    openingBalance,
    additional,
  });
  const starting = expectedAm;
  const physicalEntered = amRec ? nullableNum(amRec.physical_count != null ? amRec.physical_count : amRec.morning_shift_inventory) : null;
  const beginningRef = starting;
  const pmCount = pmRecorded
    ? (nullableNum(pmRec && pmRec.remaining_pm_shift) != null
      ? nullableNum(pmRec.remaining_pm_shift)
      : nullableNum(amRec && amRec.remaining_pm_shift))
    : null;
  const used = vaccineUsedFromCounts(amOpening, pmAdditional, pmCount);
  const verified = currentVerifiedStock({
    expectedAm: starting,
    amCount: amRecorded ? amOpening : null,
    pmCount: pmRecorded ? pmCount : null,
  });
  
  // STOCK LINKING FIX: Include PM Additional in Current Verified Stock before PM count
  // When AM recorded but PM not yet: Current Stock = AM Count + PM Additional (not yet used)
  if (amRecorded && !pmRecorded && amOpening != null && pmAdditional > 0) {
    verified.current_verified_stock = amOpening + pmAdditional;
  }
  
  const sheetDiff = clinicStockDifference({
    am: amOpening,
    additional: pmAdditional,
    pm: pmCount,
    totalUsed: used,
    vaccineName: v.name,
  });
  const remaining = pmCount;
  const sheetSt = clinicWorkflowStatus({
    amOfficial: amRecorded,
    pmOfficial: pmRecorded,
    hasPrevious: starting != null,
    pendingVerification: String((amRec && amRec.inventory_status) || '') === 'Pending Verification',
  });
  const expiry = (pmRec && pmRec.expiration_date) || (amRec && amRec.expiration_date) || stock.next_expiry || '';
  const expiryYmd = expiry ? toYmd(expiry) : '';
  const { near, displayLot } = lotDisplay(stock, expiryYmd);
  const remarks = currentHistoryRemarks(amRec, pmRec)
    || joinUniqueRemarks([amRec && amRec.remarks, pmRec && pmRec.remarks]);
  
  // STOCK LINKING FIX: Get lot details for PM Additional stock
  let pmAdditionalLots = [];
  if (pmAdditional > 0 && amRecorded) {
    const cutoff = amRec && (amRec.recorded_at || amRec.verified_at || amRec.updated_at);
    if (cutoff) {
      const [lots] = await pool.query(`
        SELECT vi.inventory_id, vi.batch_number, vt.quantity, vi.expiry_date
        FROM vaccine_transactions vt
        JOIN vaccine_inventory vi ON vt.inventory_id = vi.inventory_id
        WHERE vt.vaccine_id = ? 
          AND DATE(vt.transaction_date) = ?
          AND vt.transaction_type IN ('Stock In', 'Returned Vaccine')
          AND vt.transaction_date > ?
        ORDER BY vt.transaction_date   
      `, [v.vaccine_id, recordDate, cutoff]);
      
      pmAdditionalLots = lots.map(l => ({
        lot_id: l.inventory_id,
        batch: l.batch_number || `#${l.inventory_id}`,
        quantity: l.quantity,
        expiry: toYmd(l.expiry_date),
      }));
    }
  }
  
  return {
    record_id: (pmRec && pmRec.record_id) || (amRec && amRec.record_id) || null,
    am_record_id: amRec ? amRec.record_id : null,
    pm_record_id: pmRec ? pmRec.record_id : null,
    am_original_physical_count: amRec && amRec.original_physical_count != null ? Number(amRec.original_physical_count) : null,
    pm_original_physical_count: pmRec && pmRec.original_physical_count != null ? Number(pmRec.original_physical_count) : null,
    record_date: recordDate,
    vaccine_id: v.vaccine_id,
    vaccine_name: v.name,
    sheet_label: sheetLabel(v.name),
    category: v.category,
    vaccine_status: v.status,
    shift: 'Daily Sheet',
    morning_shift_inventory: amOpening,
    beginning_stock: beginningRef,
    am_starting_stock: starting,
    previous_verified_stock: previousVerified,
    expected_am_stock: starting,
    physical_count: physicalEntered,
    am_difference: verified.am_difference,
    current_verified_stock: verified.current_verified_stock,
    verified_am_stock: verified.verified_am_stock,
    // Use PM stock difference when PM is recorded (includes PM Additional), otherwise use AM difference
    stock_difference: pmRecorded && sheetDiff.stock_difference != null ? sheetDiff.stock_difference : verified.am_difference,
    difference_status: pmRecorded && sheetDiff.difference_status
      ? sheetDiff.difference_status
      : (verified.am_difference == null
        ? null
        : (verified.am_difference === 0
          ? 'Matched'
          : (verificationExplanation(amRec) ? (amRec.difference_status || 'Verified') : 'Variance'))),
    pm_difference: pmRecorded ? sheetDiff.stock_difference : null,
    expected_pm_stock: sheetDiff.expected_pm_stock,
    verification_reason: verificationExplanation(amRec) || null,
    am_verified: amRecorded,
    pm_starting_stock: amOpening,
    vaccine_used: used,
    total_vaccine_used: used != null ? used : 0,
    additional_vaccine: additional,
    total_additional: addParts.total_additional,
    opening_balance: openingBalance,
    previous_source: previousVerified != null ? 'pm' : (openingBalance > 0 ? 'opening' : null),
    remaining_pm_shift: remaining,
    inventory_pm: remaining,
    inventory_am: amOpening,
    expiration_date: expiryYmd,
    expiry_status: near,
    remarks,
    recorded_by_name: (pmRec && pmRec.recorded_by_name) || (amRec && amRec.recorded_by_name) || null,
    recorded_at: (pmRec && (pmRec.recorded_at || pmRec.updated_at)) || (amRec && (amRec.recorded_at || amRec.updated_at)) || null,
    on_hand: num(stock.usable != null ? stock.usable : stock.on_hand),
    usable_stock: num(stock.usable),
    expired_stock: Math.max(0, num(stock.on_hand) - num(stock.usable)),
    lot_status_label: displayLot,
    previous_pm_remaining: prevPm ? prevPm.remaining : null,
    previous_pm_date: prevPm ? prevPm.date : null,
    previous_pm_shift: prevPm ? prevPm.shift : null,
    am_recorded: amRecorded,
    pm_recorded: pmRecorded,
    am_additional: addParts.am_additional,
    pm_additional: addParts.pm_additional,
    pm_additional_lots: pmAdditionalLots,  // STOCK LINKING FIX: Include lot details
    morning_status: amRecorded ? 'Recorded' : (starting == null ? 'Pending Initial Setup' : 'Pending'),
    remaining_status: pmRecorded ? 'Recorded' : (amRecorded ? 'Pending PM Count' : (pmStatus || 'Pending')),
    inventory_status: sheetSt,
    sheet_status: sheetSt,
    shift_status: sheetSt,
    opening_recorded: amRecorded,
    late_entry: (amRec && Number(amRec.late_entry) === 1) || (pmRec && Number(pmRec.late_entry) === 1),
    can_calculate: used != null,
  };
}

function buildShiftSheetRow(v, sh, { recordDate, dailyMap, stockMap, prevMap }) {
  const rec = dailyMap.get(`${v.vaccine_id}::${sh}`);
  const stock = stockMap.get(Number(v.vaccine_id)) || {};
  const amRec = dailyMap.get(`${v.vaccine_id}::Morning Shift`);
  const ledger = shiftLedgerFields(rec || { shift: sh, record_date: recordDate }, amRec);
  const recorded = isOpeningRecorded(rec);
  const amRecorded = isOpeningRecorded(amRec);
  const additional = ledger.additional_vaccine;
  const physical = amRecorded
    ? nullableNum(amRec.physical_count != null ? amRec.physical_count : amRec.morning_shift_inventory)
    : null;
  const pmRecForUsage = dailyMap.get(`${v.vaccine_id}::Afternoon Shift`);
  const pmForUsage = isOpeningRecorded(pmRecForUsage)
    ? nullableNum(pmRecForUsage.remaining_pm_shift)
    : null;
  const previous = amRec ? nullableNum(amRec.previous_verified_stock) : null;
  const addAmt = amRec ? num(amRec.additional_vaccine) : additional;
  const starting = physical != null ? physical : (previous != null ? previous + addAmt : null);
  const pmExtra = exclusivePmAdditionalFromRows(amRec, pmRecForUsage);
  const used = (starting != null && pmForUsage != null) ? starting + pmExtra - pmForUsage : null;
  const prevPm = prevMap.get(Number(v.vaccine_id)) || null;
  const amClosed = !!(amRec && String(amRec.shift_status || '').toLowerCase() === 'closed');
  const amExpected = (physical != null && used != null)
    ? Math.max(0, physical + pmExtra - used)
    : null;
  const morning = sh === 'Morning Shift'
    ? ledger.beginning_stock
    : (amRecorded ? nullableNum(amRec.morning_shift_inventory) : null);
  const beginning = ledger.beginning_stock;
  const expected = ledger.expected_remaining;
  const remaining = expected;
  const expiry = (rec && rec.expiration_date) || stock.next_expiry || '';
  const expiryYmd = expiry ? toYmd(expiry) : '';
  const { near, displayLot } = lotDisplay(stock, expiryYmd);
  const sheetSt = ledger.inventory_status;
  return {
    record_id: rec ? rec.record_id : null,
    record_date: recordDate,
    vaccine_id: v.vaccine_id,
    vaccine_name: v.name,
    sheet_label: sheetLabel(v.name),
    category: v.category,
    shift: sh,
    morning_shift_inventory: sh === 'Afternoon Shift' ? beginning : morning,
    beginning_stock: beginning,
    vaccine_used: used,
    additional_vaccine: additional,
    total_additional: num(addAmt) + num(pmExtra),
    remaining_pm_shift: sh === 'Afternoon Shift' ? remaining : null,
    expected_remaining: expected,
    expiration_date: expiryYmd,
    expiry_status: near,
    remarks: rec ? (rec.remarks || '') : '',
    recorded_by_name: rec ? rec.recorded_by_name : null,
    recorded_at: rec ? (rec.recorded_at || rec.updated_at) : null,
    on_hand: num(stock.usable != null ? stock.usable : stock.on_hand),
    usable_stock: num(stock.usable),
    expired_stock: Math.max(0, num(stock.on_hand) - num(stock.usable)),
    lot_status_label: displayLot,
    previous_pm_remaining: prevPm ? prevPm.remaining : null,
    previous_pm_date: prevPm ? prevPm.date : null,
    previous_pm_shift: prevPm ? prevPm.shift : null,
    am_recorded: amRecorded,
    pm_recorded: sh === 'Afternoon Shift' ? recorded : false,
    am_closed: amClosed,
    am_verified_remaining: amClosed ? amExpected : null,
    am_remaining_calculated: amExpected,
    am_additional: amRec ? num(amRec.additional_vaccine) : 0,
    pm_additional: pmExtra,
    inventory_status: sheetSt,
    sheet_status: sheetSt,
    shift_status: rec ? (rec.shift_status || 'Open') : 'Open',
    opening_recorded: recorded,
    late_entry: rec ? Number(rec.late_entry) === 1 : false,
    needs_reconciliation: rec ? Number(rec.needs_reconciliation) === 1 : (!recorded && (used > 0 || additional > 0)),
    can_calculate: expected != null,
  };
}

function applyOpening(cur, row) {
  const opening = nullableNum(row.morning_shift_inventory);
  if (opening == null && !isOpeningRecorded(row)) return;
  if (opening == null) return;
  cur.hasMorningCount = true;
  cur.morning_shift_inventory = opening;
}

function aggregateDaily(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const key = `${toYmd(r.record_date)}::${r.vaccine_id}`;
    const cur = map.get(key) || {
      record_date: toYmd(r.record_date),
      vaccine_id: r.vaccine_id,
      morning_shift_inventory: null,
      vaccine_used: null,
      remaining_pm_shift: null,
      additional_vaccine: 0,
      expiration_date: null,
      remarks: [],
      latest_correction_at: 0,
      latest_correction_remarks: '',
      hasMorning: false,
      hasMorningCount: false,
      hasAfternoon: false,
      morningRemaining: null,
      afternoonRemaining: null,
      amStatus: null,
      pmStatus: null,
      previous_verified_stock: null,
      stock_difference: null,
      difference_status: null,
      verification_reason: null,
      recorded_by_name: null,
      expected_remaining: null,
      pm_additional: 0,
    };
    if (r.expiration_date) cur.expiration_date = toYmd(r.expiration_date);
    if (r.remarks) cur.remarks.push(r.remarks);
    const correctedText = correctedRemarkText(r);
    const correctedAt = correctionStamp(r);
    if (correctedText && (correctedAt > 0 || String(r.physical_correction_reason || '').trim())) {
      if (!cur.latest_correction_remarks || correctedAt >= cur.latest_correction_at) {
        cur.latest_correction_at = correctedAt;
        cur.latest_correction_remarks = correctedText;
      }
    }
    const recDate = toYmd(r.record_date);
    const shift = normalizeShift(r.shift);
    if (shift === 'Morning Shift') {
      cur.hasMorning = true;
      applyOpening(cur, r);
      if (!isOpeningRecorded(r)) {
        cur.amStatus = deriveInventoryStatus(r, recDate, 'Morning Shift');
      }
      if (isOpeningRecorded(r)) cur.additional_vaccine = num(r.additional_vaccine);
      if (r.pm_additional_vaccine != null && r.pm_additional_vaccine !== '') {
        cur.pm_additional = num(r.pm_additional_vaccine);
      }
      if (r.previous_verified_stock != null) cur.previous_verified_stock = nullableNum(r.previous_verified_stock);
      if (r.stock_difference != null) cur.stock_difference = nullableNum(r.stock_difference);
      if (r.difference_status) cur.difference_status = r.difference_status;
      if (r.verification_reason) cur.verification_reason = r.verification_reason;
      else if (!cur.verification_reason && r.remarks) cur.verification_reason = r.remarks;
      if (r.recorded_by_name) cur.recorded_by_name = r.recorded_by_name;
      if (r.expected_remaining != null) cur.expected_remaining = nullableNum(r.expected_remaining);
    } else if (shift === 'Afternoon Shift') {
      const pmRecorded = isOpeningRecorded(r);
      cur.hasAfternoon = pmRecorded;
      if (pmRecorded) {
        cur.remaining_pm_shift = nullableNum(r.remaining_pm_shift);
        cur.pmStatus = 'Recorded';
        cur.pm_additional = exclusivePmAdditionalFromRows({
          additional_vaccine: cur.additional_vaccine,
          physical_count: cur.morning_shift_inventory,
          morning_shift_inventory: cur.morning_shift_inventory,
          previous_verified_stock: cur.previous_verified_stock,
        }, r);
        if (!cur.hasMorningCount) {
          applyOpening(cur, r);
          cur.additional_vaccine = num(r.additional_vaccine);
        }
      } else {
        cur.pmStatus = deriveInventoryStatus(r, recDate, 'Afternoon Shift');
      }
    } else if (!cur.hasMorningCount) {
      applyOpening(cur, r);
    }
    map.set(key, cur);
  }
  for (const cur of map.values()) {
    const am = cur.hasMorningCount ? nullableNum(cur.morning_shift_inventory) : null;
    const pm = cur.hasAfternoon ? nullableNum(cur.remaining_pm_shift) : null;
    const add = num(cur.pm_additional);
    cur.vaccine_used = vaccineUsedFromCounts(am, add, pm);
    const previous = nullableNum(cur.previous_verified_stock);
    const storedExpected = nullableNum(cur.expected_remaining);
    const expectedAm = storedExpected != null
      ? storedExpected
      : (previous != null ? previous + num(cur.additional_vaccine) : null);
    const verified = currentVerifiedStock({ expectedAm, amCount: am, pmCount: pm });
    const sheetDiff = clinicStockDifference({
      am, additional: add, pm, totalUsed: cur.vaccine_used,
    });
    cur.am_difference = verified.am_difference;
    cur.current_verified_stock = verified.current_verified_stock;
    cur.stock_difference = verified.am_difference;
    cur.pm_difference = pm != null ? sheetDiff.stock_difference : null;
    cur.difference_status = verified.am_difference == null
      ? cur.difference_status
      : (verified.am_difference === 0
        ? 'Matched'
        : (verificationExplanation(cur) ? (cur.difference_status || 'Verified') : 'Variance'));
    cur.expected_remaining = pm;
    cur.sheet_status = clinicCountStatus(am, pm);
    if (am != null) cur.amStatus = pm == null ? 'Pending PM Count' : 'Recorded';
    if (pm != null) cur.pmStatus = 'Recorded';
    else if (am != null) cur.pmStatus = 'Pending PM Count';
    cur.remarks = cur.latest_correction_remarks || joinUniqueRemarks(cur.remarks);
  }
  return map;
}

function txnDeltasByDayVaccine(transactions) {
  const map = new Map();
  for (const t of transactions || []) {
    const d = toYmd(t.d || t.transaction_date);
    if (!d) continue;
    const key = `${d}::${t.vaccine_id}`;
    const cur = map.get(key) || { additional: 0, used: 0, remarks: [], expiration_date: '' };
    const qty = t.corrected_quantity != null && t.corrected_quantity !== ''
      ? num(t.corrected_quantity)
      : num(t.quantity);
    if (STOCK_IN_TYPES.includes(t.transaction_type)) cur.additional += qty;
    if (ADMIN_USED_TYPES.includes(t.transaction_type)) cur.used += qty;
    const note = String(t.notes || '');
    if (t.remarks && !note.startsWith('usage:')) cur.remarks.push(t.remarks);
    if (t.expiration_date && !cur.expiration_date) cur.expiration_date = toYmd(t.expiration_date);
    map.set(key, cur);
  }
  return map;
}

function pickReportCatalog(vaccines, extraIds) {
  return pickManagedVaccines(vaccines, extraIds);
}

function eachDate(from, to) {
  const dates = [];
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    dates.push(localYmd(new Date(t)));
  }
  return dates;
}

async function buildInventorySheets(pool, { dateFrom, dateTo, listAllVaccines = true } = {}) {
  const from = toYmd(dateFrom) || localYmd();
  const to = toYmd(dateTo) || from;

  const [vaccines] = await pool.query(
    `SELECT vaccine_id, name, type, category, status FROM vaccines ORDER BY name ASC`
  );
  const [dailies] = await pool.query(
    `SELECT * FROM inventory_daily_records WHERE record_date BETWEEN ? AND ?`,
    [from, to]
  );
  const [txns] = await pool.query(
    `SELECT vaccine_id, transaction_type, quantity, notes, remarks, transaction_date,
            expiration_date, DATE(transaction_date) AS d
     FROM vaccine_transactions
     WHERE DATE(transaction_date) BETWEEN ? AND ?`,
    [from, to]
  );
  const dailyMap = aggregateDaily(dailies);
  const txnMap = txnDeltasByDayVaccine(txns);
  const extraIds = [];
  for (const k of dailyMap.keys()) extraIds.push(Number(k.split('::')[1]));
  for (const k of txnMap.keys()) extraIds.push(Number(k.split('::')[1]));
  const catalog = pickReportCatalog(vaccines || [], extraIds);

  const dateSet = new Set();
  for (const k of dailyMap.keys()) dateSet.add(k.split('::')[0]);
  for (const k of txnMap.keys()) dateSet.add(k.split('::')[0]);
  const singleDay = from === to;
  let dates;
  if (singleDay) {
    dates = [from];
  } else {
    dates = eachDate(from, to).filter((d) => dateSet.has(d));
    if (!dates.length) {
      const all = eachDate(from, to);
      dates = all.length <= 14 ? all : [from];
    }
  }

  function buildSheetRow(v, date) {
    const key = `${date}::${v.vaccine_id}`;
    const daily = dailyMap.get(key);
    const txn = txnMap.get(key) || { additional: 0, used: 0, remarks: [], expiration_date: '' };
    const additionalRaw = daily ? num(daily.additional_vaccine) : num(txn.additional);
    const pmExtra = daily ? num(daily.pm_additional) : 0;
    const am = daily && daily.hasMorningCount ? nullableNum(daily.morning_shift_inventory) : null;
    const pm = daily && daily.hasAfternoon ? nullableNum(daily.remaining_pm_shift) : null;
    const previous = daily ? nullableNum(daily.previous_verified_stock) : null;
    const starting = previous == null && additionalRaw <= 0 ? (am != null ? am : null) : (previous == null ? additionalRaw : previous + additionalRaw);
    const usedFormula = vaccineUsedFromCounts(am, pmExtra, pm);
    const verified = currentVerifiedStock({
      expectedAm: starting,
      amCount: am,
      pmCount: pm,
    });
    const sheetDiff = clinicStockDifference({
      am, additional: pmExtra, pm, totalUsed: usedFormula, vaccineName: v.name,
    });
    const morningRecorded = am != null;
    const pmRecorded = pm != null;
    const sheetSt = clinicCountStatus(am, pm);
    const amStatus = morningRecorded ? (pmRecorded ? 'Recorded' : 'Pending PM Count') : ((daily && daily.amStatus) || deriveInventoryStatus(null, date, 'Morning Shift'));
    const pmStatus = pmRecorded ? 'Recorded' : (morningRecorded ? 'Pending PM Count' : ((daily && daily.pmStatus) || deriveInventoryStatus(null, date, 'Afternoon Shift')));
    const remarks = (daily && daily.remarks) || '';
    return {
      vaccine_id: v.vaccine_id,
      vaccine_name: v.name,
      sheet_label: sheetLabel(v.name),
      category: v.category,
      record_date: date,
      morning_shift_inventory: am,
      inventory_am: am,
      morning_status: amStatus,
      additional_vaccine: additionalRaw,
      am_additional: additionalRaw,
      pm_additional: pmExtra,
      total_additional: additionalRaw + pmExtra,
      remaining_pm_shift: pm,
      inventory_pm: pm,
      remaining_status: pmStatus,
      vaccine_used: usedFormula,
      total_vaccine_used: usedFormula != null ? usedFormula : 0,
      inventory_status: sheetSt,
      sheet_status: sheetSt,
      am_recorded: morningRecorded,
      pm_recorded: pmRecorded,
      opening_recorded: morningRecorded,
      previous_verified_stock: previous,
      am_starting_stock: starting,
      beginning_stock: starting,
      expected_am_stock: starting,
      am_difference: morningRecorded ? verified.am_difference : null,
      current_verified_stock: morningRecorded ? verified.current_verified_stock : null,
      stock_difference: morningRecorded ? verified.am_difference : null,
      difference_status: !morningRecorded
        ? null
        : (verified.am_difference === 0
          ? 'Matched'
          : (verificationExplanation(daily) ? (daily.difference_status || 'Verified') : 'Variance')),
      pm_difference: pmRecorded ? sheetDiff.stock_difference : null,
      expected_pm_stock: sheetDiff.expected_pm_stock,
      verification_reason: verificationExplanation(daily) || null,
      expiration_date: (daily && daily.expiration_date) || (txn && txn.expiration_date) || '',
      remarks,
      recorded_by_name: daily ? daily.recorded_by_name : null,
    };
  }

  const days = dates.map((date) => {
    const rows = catalog.map((v) => buildSheetRow(v, date));
    const seen = new Set(rows.map((r) => Number(r.vaccine_id)));
    for (const v of vaccines || []) {
      if (seen.has(Number(v.vaccine_id))) continue;
      if (isExcludedGenericVaccineName(v.name)) continue;
      const txn = txnMap.get(`${date}::${v.vaccine_id}`);
      const daily = dailyMap.get(`${date}::${v.vaccine_id}`);
      if ((!txn || num(txn.used) <= 0) && !daily) continue;
      rows.push(buildSheetRow(v, date));
      seen.add(Number(v.vaccine_id));
    }
    const dosesUsed = rows.reduce((s, r) => s + (r.vaccine_used != null ? num(r.vaccine_used) : 0), 0);
    return { date, rows, doses_used: dosesUsed };
  });

  return { dateFrom: from, dateTo: to, days };
}

module.exports = {
  SHEET_LABELS,
  SHEET_ORDER,
  sheetLabel,
  applyDailySheetDelta,
  getClinicSheet,
  getOpeningStock,
  remainingOf,
  vaccineUsedFromCounts,
  splitReceipts,
  clinicUsageFromCounts,
  clinicCountStatus,
  nullableNum,
  replaceInventoryRemarks,
  currentHistoryRemarks,
  isOpeningRecorded,
  amExpectedRemaining,
  displayRecordStatus,
  shiftLedgerFields,
  deriveInventoryStatus,
  shiftHasEnded,
  buildInventorySheets,
  localYmd,
  toYmd,
};
