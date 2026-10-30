const express = require('express');
const router = express.Router();
const pool = require('../config/database').pool;
const { requireAuth, requirePermission, requireRole, getStaffFromSession } = require('../middleware/auth');
const { logActivity, MODULES, ACTIONS } = require('../utils/activityLogger');
const { getCurrentShift, normalizeShift, parseShiftQuery } = require('../utils/shiftHelper');
const { PERMISSIONS } = require('../utils/permissions');
const { generateStaffId } = require('../utils/idFormats');
const { getStockLevel, getExpiryStatus, TRANSACTION_TYPES } = require('../utils/inventoryHelpers');
const { canMergeIntoLot, persistLotQuantity, isUsableLot, deriveLotStatus, groupLotsForDisplay } = require('../utils/inventoryBatches');
const { getClinicSheet, sheetLabel, toYmd, localYmd, clinicCountStatus, nullableNum } = require('../utils/vaccineInventorySheet');
const { toSqlDate, toSqlDateTime, localTodayIso, sqlDateTimeOnCalendarDate } = require('../utils/dateOnly');
const { fetchInventoryCatalog, requireActiveManagedVaccine } = require('../utils/vaccineCatalog');
const { listPendingAlerts, listShiftHistory, summarizeShiftDashboard } = require('../utils/inventoryShiftStatus');
const { saveAmInventory, savePmCount, ensureDailyRecordSchema } = require('../utils/inventoryClinicCount');
const { correctPhysicalCount } = require('../utils/inventoryPhysicalCorrection');
const { fetchAmReference, refreshClinicReceipts, correctStockIn, effectiveReceiptQty, CORRECTION_REASONS } = require('../utils/inventoryVerifiedStock');
const { isVaccineInventoryEstablished, addStockTransactionType, OPENING_BALANCE_TYPE } = require('../utils/inventoryOpeningBalance');
const { fetchClinicUsageMaps, usageForVaccine, usageForDay, totalUsedFromCounts } = require('../utils/inventoryShiftUsage');
const { sendPublicInventoryError } = require('../utils/publicError');
const { parseStockAddedDateRange, stockAddedDateFilterSql } = require('../utils/inventoryDateFilter');
const { fetchCurrentLotGroups, summarizeLotGroups, currentStockLevels, additionalStockForGroupedLot, fetchReceiptTotals, lotRecordStatus, groupedLotWasCorrected } = require('../utils/currentLotStock');
const { ensureLotReceiptTransactions } = require('../utils/lotReceiptLedger');

router.use(requireAuth);

function staffDisplay(req) {
  const s = getStaffFromSession(req);
  return {
    ...s,
    staff_id_display: generateStaffId(s.staff_id, s.role),
  };
}

async function recordTransaction(conn, {
  inventory_id, vaccine_id, type, quantity, staff, shift, patient_id, notes, remarks,
  beginning_stock, remaining_stock, expiration_date, shift_literal, transaction_date,
}) {
  const recShift = shift_literal || normalizeShift(shift);
  const txnAt = transaction_date || null;
  const withTxnDate = txnAt
    ? [{
        sql: `INSERT INTO vaccine_transactions
         (inventory_id, vaccine_id, transaction_type, quantity, original_quantity, staff_id, staff_name,
          staff_id_display, shift, patient_id, notes, remarks, beginning_stock, remaining_stock, expiration_date, transaction_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [
          inventory_id || null, vaccine_id, type, quantity, quantity,
          staff.staff_id, staff.full_name, staff.staff_id_display,
          recShift, patient_id || null, notes || null, remarks || null,
          beginning_stock != null ? beginning_stock : null,
          remaining_stock != null ? remaining_stock : null,
          expiration_date || null, txnAt,
        ],
      }, {
        sql: `INSERT INTO vaccine_transactions
           (inventory_id, vaccine_id, transaction_type, quantity, staff_id, staff_name,
            staff_id_display, shift, patient_id, notes, remarks, beginning_stock, remaining_stock, expiration_date, transaction_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [
          inventory_id || null, vaccine_id, type, quantity,
          staff.staff_id, staff.full_name, staff.staff_id_display,
          recShift, patient_id || null, notes || null, remarks || null,
          beginning_stock != null ? beginning_stock : null,
          remaining_stock != null ? remaining_stock : null,
          expiration_date || null, txnAt,
        ],
      }, {
        sql: `INSERT INTO vaccine_transactions
           (inventory_id, vaccine_id, transaction_type, quantity, staff_id, staff_name,
            staff_id_display, shift, patient_id, notes, remarks, transaction_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [
          inventory_id || null, vaccine_id, type, quantity,
          staff.staff_id, staff.full_name, staff.staff_id_display,
          recShift, patient_id || null, notes || null, remarks || null, txnAt,
        ],
      }]
    : [];
  const attempts = [
    ...withTxnDate,
    {
      sql: `INSERT INTO vaccine_transactions
         (inventory_id, vaccine_id, transaction_type, quantity, original_quantity, staff_id, staff_name,
          staff_id_display, shift, patient_id, notes, remarks, beginning_stock, remaining_stock, expiration_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        inventory_id || null, vaccine_id, type, quantity, quantity,
        staff.staff_id, staff.full_name, staff.staff_id_display,
        recShift, patient_id || null, notes || null, remarks || null,
        beginning_stock != null ? beginning_stock : null,
        remaining_stock != null ? remaining_stock : null,
        expiration_date || null,
      ],
    },
    {
      sql: `INSERT INTO vaccine_transactions
           (inventory_id, vaccine_id, transaction_type, quantity, staff_id, staff_name,
            staff_id_display, shift, patient_id, notes, remarks, beginning_stock, remaining_stock, expiration_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        inventory_id || null, vaccine_id, type, quantity,
        staff.staff_id, staff.full_name, staff.staff_id_display,
        recShift, patient_id || null, notes || null, remarks || null,
        beginning_stock != null ? beginning_stock : null,
        remaining_stock != null ? remaining_stock : null,
        expiration_date || null,
      ],
    },
    {
      sql: `INSERT INTO vaccine_transactions
           (inventory_id, vaccine_id, transaction_type, quantity, staff_id, staff_name,
            staff_id_display, shift, patient_id, notes, remarks)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        inventory_id || null, vaccine_id, type, quantity,
        staff.staff_id, staff.full_name, staff.staff_id_display,
        recShift, patient_id || null, notes || null, remarks || null,
      ],
    },
  ];
  let lastErr;
  for (const attempt of attempts) {
    try {
      await conn.query(attempt.sql, attempt.params);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

router.get('/brands', requirePermission(PERMISSIONS.INVENTORY), async (req, res) => {
  try {
    const includeInactive = String(req.query.include_inactive || '') === '1';
    const rows = await fetchInventoryCatalog(pool, {
      activeOnly: !includeInactive,
    });
    res.json({
      success: true,
      data: rows.map((v) => ({
        ...v,
        sheet_label: v.name,
      })),
    });
  } catch (err) {
    console.error('Inventory brands error:', err);
    res.status(500).json({ success: false, message: 'Unable to load vaccines from Vaccine Management' });
  }
});

router.get('/sheet', requirePermission(PERMISSIONS.INVENTORY), async (req, res) => {
  try {
    const data = await getClinicSheet(pool, {
      date: req.query.date,
      shift: req.query.shift,
      vaccine_id: req.query.vaccine_id,
    });
    data.rows = data.rows.map((r) => ({
      ...r,
      expiry_status: getExpiryStatus(r.expiration_date),
      stock_status: getStockLevel(r.on_hand, 10, 5),
    }));
    res.json({ success: true, data });
  } catch (err) {
    console.error('Inventory sheet error:', err);
    res.status(500).json({ success: false, message: 'The system is temporarily unavailable. Please try again later.' });
  }
});

router.get('/stock-entry-mode', requirePermission(PERMISSIONS.INVENTORY), async (req, res) => {
  try {
    const vaccineId = Number(req.query.vaccine_id);
    if (!Number.isFinite(vaccineId) || vaccineId <= 0) {
      return res.json({
        success: true,
        data: {
          mode: 'opening',
          transaction_type: OPENING_BALANCE_TYPE,
          label: 'Initial Setup / Opening Balance',
          additional: false,
        },
      });
    }
    const status = await isVaccineInventoryEstablished(pool, vaccineId);
    const opening = !status.established;
    res.json({
      success: true,
      data: {
        mode: opening ? 'opening' : 'additional',
        transaction_type: addStockTransactionType(status.established),
        label: opening ? 'Initial Setup / Opening Balance' : 'Stock In / Additional Stock Received',
        additional: !opening,
        established_reason: status.reason,
      },
    });
  } catch (err) {
    console.error('Stock entry mode error:', err);
    res.status(500).json({ success: false, message: 'The system is temporarily unavailable. Please try again later.' });
  }
});

router.get('/', requirePermission(PERMISSIONS.INVENTORY), async (req, res) => {
  try {
    let dateFrom = null;
    let dateTo = null;
    try {
      ({ dateFrom, dateTo } = parseStockAddedDateRange(req.query));
    } catch (err) {
      return res.status(err.status || 400).json({ success: false, message: err.message });
    }
    const dateFilter = stockAddedDateFilterSql({ dateFrom, dateTo });
    const [rows] = await pool.query(`
      SELECT vi.*, v.name as vaccine_name, v.type as vaccine_type, v.category
      FROM vaccine_inventory vi JOIN vaccines v ON vi.vaccine_id = v.vaccine_id
      WHERE 1=1 ${dateFilter.sql}
      ORDER BY CAST(REGEXP_REPLACE(COALESCE(vi.batch_number, CONCAT('#', vi.inventory_id)), '[^0-9]', '') AS UNSIGNED) DESC,
               vi.received_date DESC,
               v.name ASC
    `, dateFilter.params);
    const grouped = groupLotsForDisplay(rows);
    const storedReceived = new Map();
    for (const row of rows || []) {
      const id = Number(row.inventory_id);
      if (!id || row.received_quantity == null || row.received_quantity === '') continue;
      storedReceived.set(id, Number(row.received_quantity) || 0);
    }
    const lotIds = grouped.flatMap((lot) => (lot.inventory_ids && lot.inventory_ids.length ? lot.inventory_ids : [lot.inventory_id]));
    const { totals: receipts, corrected } = await fetchReceiptTotals(pool, lotIds);
    const { byVaccine } = await fetchClinicUsageMaps(pool);
    const data = grouped.map(lot => {
      const usage = usageForVaccine(byVaccine, lot.vaccine_id);
      return {
        ...lot,
        sheet_label: sheetLabel(lot.vaccine_name),
        stock_status: getStockLevel(lot.usable_quantity, lot.low_stock_threshold, lot.critical_stock_threshold),
        expiry_status: getExpiryStatus(lot.expiry_date),
        batch_status: lot.batch_status,
        record_status: lotRecordStatus({
          expiryDate: lot.expiry_date,
          corrected: groupedLotWasCorrected(lot, corrected),
          today: localTodayIso(),
        }),
        total_vaccine_used: usage.total_vaccine_used,
        used_quantity: usage.total_vaccine_used,
        additional_stock: additionalStockForGroupedLot(lot, receipts, storedReceived),
        stock_added_date: toSqlDate(lot.received_date) || toSqlDate(lot.created_at),
      };
    });
    res.json({
      success: true,
      data,
      filter: { date_from: dateFrom, date_to: dateTo },
    });
  } catch (err) {
    console.error('Current Lot Stock error:', err);
    res.status(500).json({ success: false, message: 'The system is temporarily unavailable. Please try again later.' });
  }
});

router.get('/summary', requirePermission(PERMISSIONS.INVENTORY), async (req, res) => {
  try {
    const summary = summarizeLotGroups(await fetchCurrentLotGroups(pool));
    const levels = currentStockLevels(summary.lots);
    res.json({
      success: true,
      data: {
        ...summary.counts,
        low_stock_count: levels.low,
        critical_stock_count: levels.critical,
        out_of_stock_count: levels.out,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'The system is temporarily unavailable. Please try again later.' });
  }
});

router.get('/daily-records', requirePermission(PERMISSIONS.INVENTORY), async (req, res) => {
  try {
    const { date, shift, vaccine_id } = req.query;
    let q = `SELECT idr.*, v.name as vaccine_name, v.category
      FROM inventory_daily_records idr JOIN vaccines v ON idr.vaccine_id = v.vaccine_id WHERE 1=1`;
    const params = [];
    if (date) { q += ' AND idr.record_date = ?'; params.push(date); }
    if (shift) {
      const sh = parseShiftQuery(shift);
      if (sh) { q += ' AND idr.shift = ?'; params.push(sh); }
    }
    if (vaccine_id) { q += ' AND idr.vaccine_id = ?'; params.push(vaccine_id); }
    q += ' ORDER BY idr.record_date DESC, v.name ASC';
    const [rows] = await pool.query(q, params);

    // ── Pair AM + PM rows so vaccine_used is always computed from both ──
    // Build a lookup map: (date::vaccineId) → { am, pm }
    // When a filter requests only one shift we still need the partner row to
    // compute the correct Total Used, so fetch the partner rows silently.
    const pairMap = new Map();
    for (const r of rows) {
      const day = toYmd(r.record_date);
      const key = `${day}::${r.vaccine_id}`;
      const cur = pairMap.get(key) || { am: null, pm: null, vaccine_id: r.vaccine_id, day };
      const sh = normalizeShift(r.shift);
      if (sh === 'Morning Shift') cur.am = r;
      else if (sh === 'Afternoon Shift') cur.pm = r;
      pairMap.set(key, cur);
    }

    // If filtering by shift, we may be missing partner rows — fetch them
    if (shift) {
      const missingKeys = [...pairMap.values()].filter(p => p.am === null || p.pm === null);
      if (missingKeys.length > 0) {
        const partnerShift = normalizeShift(shift) === 'Morning Shift' ? 'Afternoon Shift' : 'Morning Shift';
        const dates = [...new Set(missingKeys.map(p => p.day))];
        const vids  = [...new Set(missingKeys.map(p => p.vaccine_id))];
        if (dates.length > 0 && vids.length > 0) {
          const [partners] = await pool.query(
            `SELECT * FROM inventory_daily_records
             WHERE record_date IN (${dates.map(() => '?').join(',')})
               AND vaccine_id IN (${vids.map(() => '?').join(',')})
               AND shift = ?`,
            [...dates, ...vids, partnerShift]
          ).catch(() => [[]]);
          for (const r of partners || []) {
            const day = toYmd(r.record_date);
            const key = `${day}::${r.vaccine_id}`;
            const cur = pairMap.get(key);
            if (!cur) continue;
            const sh = normalizeShift(r.shift);
            if (sh === 'Morning Shift' && !cur.am) cur.am = r;
            else if (sh === 'Afternoon Shift' && !cur.pm) cur.pm = r;
          }
        }
      }
    }

    res.json({
      success: true,
      data: rows.map((r) => {
        const { discrepancy: _omit, physical_remaining: _omitPhys, physical_count: _omitCount, ...row } = r;
        const day = toYmd(r.record_date);
        const key = `${day}::${r.vaccine_id}`;
        const pair = pairMap.get(key) || { am: null, pm: null };
        const amRow = pair.am;
        const pmRow = pair.pm;
        const sh = normalizeShift(r.shift);

        // AM row: official if opening_recorded=1 and not pending verification
        const amRecorded = amRow ? (
          Number(amRow.opening_recorded) === 1
          || ['Completed','Pending PM Count','Recorded','Late Entry','Open','Initial Setup'].includes(amRow.inventory_status)
        ) : false;
        const amOfficial = amRecorded
          && amRow.inventory_status !== 'Pending Verification'
          && amRow.difference_status !== 'Pending Verification';

        // AM physical count — prefer physical_count (corrected) over morning_shift_inventory
        const amCount = amOfficial && amRow.morning_shift_inventory != null
          ? Number(amRow.physical_count != null ? amRow.physical_count : amRow.morning_shift_inventory)
          : null;

        // PM count
        const pmRecorded = pmRow ? (
          pmRow.inventory_status === 'Completed'
          || (amOfficial && Number(pmRow.opening_recorded) === 1 && pmRow.remaining_pm_shift != null)
        ) : (
          // Fallback: single AM row may store PM count when shifts share a row
          sh === 'Morning Shift' && r.inventory_status === 'Completed' && r.remaining_pm_shift != null
        );
        const pmCount = pmRecorded
          ? (pmRow ? nullableNum(pmRow.remaining_pm_shift) : nullableNum(r.remaining_pm_shift))
          : null;

        // PM additional: stock received after AM verification (stamped separately)
        const pmExtra = (() => {
          const fromPm = pmRow && pmRow.pm_additional_vaccine != null && pmRow.pm_additional_vaccine !== ''
            ? Number(pmRow.pm_additional_vaccine) : null;
          const fromAm = r.pm_additional_vaccine != null && r.pm_additional_vaccine !== ''
            ? Number(r.pm_additional_vaccine) : null;
          const v = fromPm ?? fromAm ?? 0;
          return Number.isFinite(v) ? v : 0;
        })();

        // ── Total Used = AM Physical + PM Additional − PM Count ──────────
        // This is the same formula used by savePmCount and usageFromDailyPair.
        const used = totalUsedFromCounts({
          previous:    amRow ? nullableNum(amRow.previous_verified_stock) : null,
          additional:  0,        // AM additional is already inside the physical count
          physical:    amCount,
          pm:          pmCount,
          pmAdditional: pmExtra,
        });

        // Beginning stock for this row's shift
        const isAfternoon = sh === 'Afternoon Shift';
        const amReceipt   = isAfternoon ? 0 : Number(r.additional_vaccine || 0);
        const prevStock   = amRow ? nullableNum(amRow.previous_verified_stock) : nullableNum(r.previous_verified_stock);
        const expectedAm  = (prevStock != null || amReceipt > 0)
          ? Number(prevStock || 0) + amReceipt
          : null;
        const amStart     = isAfternoon && amCount != null
          ? amCount
          : (expectedAm != null ? expectedAm : amCount);

        // Status
        const statusForRow = r.inventory_status || clinicCountStatus(amCount, pmCount);

        return {
          ...row,
          sheet_label:           sheetLabel(r.vaccine_name),
          inventory_am:          amCount,
          inventory_pm:          pmCount,
          vaccine_used:          used,           // ← live-computed, always correct
          total_vaccine_used:    used,
          remaining_pm_shift:    pmCount,
          previous_verified_stock: prevStock,
          am_starting_stock:     amStart,
          pm_additional:         pmExtra,
          stock_difference:      r.stock_difference,
          difference_status:     r.difference_status,
          physical_count:        r.physical_count,
          inventory_status:      statusForRow,
          am_recorded:           amOfficial,
          pm_recorded:           pmRecorded,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'The system is temporarily unavailable. Please try again later.' });
  }
});

router.post('/daily-records/:id/correct-physical', requirePermission(PERMISSIONS.INVENTORY), requireRole('Administrator'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const staff = staffDisplay(req);
    const result = await correctPhysicalCount(conn, {
      record_id: req.params.id,
      corrected_physical_count: req.body.corrected_physical_count,
      correction_reason: req.body.correction_reason,
      client_token: req.body.client_token,
      staff,
    });
    if (!result.idempotent) {
      logActivity(req, {
        action: ACTIONS.UPDATE,
        module: MODULES.INVENTORY,
        reference_id: result.record_id,
        description: `${result.shift === 'Afternoon Shift' ? 'Correct PM Count' : 'Correct AM Count'} for ${result.vaccine_name} on ${result.record_date} (${result.shift}). `
          + `Original ${result.shift === 'Afternoon Shift' ? 'PM count' : 'AM count'} ${result.original_physical_count}, corrected ${result.shift === 'Afternoon Shift' ? 'PM count' : 'AM count'} ${result.corrected_physical_count}. `
          + `Previous remarks: ${result.previous_remarks || '—'}. Current remarks: ${result.remarks}. `
          + `Reason: ${result.correction_reason}. Additional stock was not added. Record #${result.record_id}.`,
        old_value: String(result.original_physical_count),
        new_value: String(result.corrected_physical_count),
      });
    }
    res.json({
      success: true,
      message: result.idempotent
        ? 'This correction was already saved. Inventory was not changed again.'
        : (result.shift === 'Afternoon Shift'
          ? 'PM count corrected. This did not add vaccine stock.'
          : 'AM count corrected. This did not add vaccine stock.'),
      data: result,
    });
  } catch (err) {
    console.error('AM/PM count correction error:', err);
    return sendPublicInventoryError(res, err, 'The count correction could not be saved. Please try again.');
  } finally {
    conn.release();
  }
});

router.post('/daily-records', requirePermission(PERMISSIONS.INVENTORY), requireRole('Administrator'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const staff = staffDisplay(req);
    const {
      record_date, vaccine_id, morning_shift_inventory,
      additional_vaccine, expiration_date, remarks, shift, physical_count,
      verification_reason, pm_additional_vaccine,
    } = req.body;

    // Debug logging
    if (shift === 'Afternoon Shift' || normalizeShift(shift) === 'Afternoon Shift') {
      console.log('[PM INVENTORY DEBUG]', {
        vaccine_id,
        shift,
        pm_additional_vaccine,
        remaining_pm_shift: req.body.remaining_pm_shift,
        physical_count,
      });
    }

    if (!vaccine_id || !record_date) {
      return res.status(400).json({ success: false, message: 'Date and vaccine are required' });
    }

    const recShift = normalizeShift(shift);
    await ensureDailyRecordSchema(conn);
    const amPhysical = physical_count != null ? physical_count : morning_shift_inventory;
    if (recShift !== 'Afternoon Shift') {
      const n = Number(amPhysical);
      if (!Number.isFinite(n) || n < 0 || n !== Math.floor(n)) {
        return res.status(400).json({
          success: false,
          message: 'Enter a valid AM inventory count. Negative or empty quantities are not allowed.',
        });
      }
    } else {
      const pmVal = req.body.remaining_pm_shift != null ? req.body.remaining_pm_shift : physical_count;
      const n = Number(pmVal);
      if (!Number.isFinite(n) || n < 0 || n !== Math.floor(n)) {
        return res.status(400).json({
          success: false,
          message: 'Enter a valid PM physical inventory count. Negative or empty quantities are not allowed.',
        });
      }
    }

    const saved = recShift === 'Afternoon Shift'
      ? await savePmCount(conn, {
        record_date,
        vaccine_id: Number(vaccine_id),
        remaining_pm_shift: req.body.remaining_pm_shift != null ? req.body.remaining_pm_shift : physical_count,
        physical_count,
        pm_additional_vaccine: req.body.pm_additional_vaccine,
        expiration_date,
        remarks,
        staff,
      })
      : await saveAmInventory(conn, {
        record_date,
        vaccine_id: Number(vaccine_id),
        morning_shift_inventory,
        physical_count: amPhysical,
        additional_vaccine,
        expiration_date,
        remarks,
        verification_reason,
        staff,
      });

    logActivity(req, {
      action: saved.difference_status && saved.difference_status !== 'Matched' ? ACTIONS.REVIEW : ACTIONS.ADD,
      module: MODULES.INVENTORY,
      reference_id: vaccine_id,
      description: `${saved.inventory_status} inventory for vaccine #${vaccine_id} on ${record_date} (${recShift})`
        + (saved.difference_status ? `; difference ${saved.stock_difference} (${saved.difference_status})` : ''),
      old_value: saved.previous_verified_stock != null ? String(saved.previous_verified_stock) : null,
      new_value: saved.inventory_am != null ? String(saved.inventory_am) : null,
    });

    const verifiedNow = saved.current_verified_stock != null ? saved.current_verified_stock : saved.inventory_am;
    const gap = saved.am_difference != null && saved.am_difference !== 0
      ? ` AM difference is ${saved.am_difference}.`
      : '';
    const okMsg = recShift === 'Afternoon Shift'
      ? `PM count saved. Vaccine Used = ${saved.vaccine_used}. Current Verified Stock is ${verifiedNow}.${gap}`
      : `AM inventory saved. Current Verified Stock is ${verifiedNow}.${gap}`;
    res.status(201).json({ success: true, message: okMsg, data: saved });
  } catch (err) {
    console.error('Daily record error:', err);
    return sendPublicInventoryError(res, err, 'We couldn’t save the inventory record. Please try again.');
  } finally {
    conn.release();
  }
});

router.get('/history', requirePermission(PERMISSIONS.INVENTORY_HISTORY), async (req, res) => {
  try {
    try {
      const synced = await ensureLotReceiptTransactions(pool);
      if (synced.created) {
        console.info(`Lot receipt ledger added ${synced.created} missing stock receipt(s).`);
      }
    } catch (syncErr) {
      console.error('Lot receipt ledger sync skipped:', syncErr.message);
    }
    const { date_from, date_to, month, year, vaccine_id, shift, search, sort = 'desc' } = req.query;
    let q = `SELECT vt.*, v.name as vaccine_name, v.category,
        vi.batch_number, vi.expiry_date AS lot_expiry_date
      FROM vaccine_transactions vt
      JOIN vaccines v ON vt.vaccine_id = v.vaccine_id
      LEFT JOIN vaccine_inventory vi ON vi.inventory_id = vt.inventory_id
      WHERE 1=1`;
    const params = [];

    if (date_from) { q += ' AND DATE(vt.transaction_date) >= ?'; params.push(date_from); }
    if (date_to) { q += ' AND DATE(vt.transaction_date) <= ?'; params.push(date_to); }
    if (month && year) {
      q += ' AND MONTH(vt.transaction_date)=? AND YEAR(vt.transaction_date)=?';
      params.push(month, year);
    } else if (year) {
      q += ' AND YEAR(vt.transaction_date)=?'; params.push(year);
    }
    if (vaccine_id) { q += ' AND vt.vaccine_id = ?'; params.push(vaccine_id); }
    if (shift) {
      const sh = parseShiftQuery(shift);
      if (sh) { q += ' AND vt.shift = ?'; params.push(sh); }
    }
    if (search) {
      q += ' AND (v.name LIKE ? OR vt.staff_name LIKE ? OR vt.remarks LIKE ? OR vt.notes LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    q += sort === 'asc' ? ' ORDER BY vt.transaction_date ASC, vt.transaction_id ASC' : ' ORDER BY vt.transaction_date DESC, vt.transaction_id DESC';

    const [rows] = await pool.query(q, params);
    const { byDay } = await fetchClinicUsageMaps(pool, {
      dateFrom: date_from || undefined,
      dateTo: date_to || undefined,
      vaccineId: vaccine_id || undefined,
    });
    const seenUsage = new Set();
    res.json({
      success: true,
      data: rows.map((r) => {
        const isReceipt = ['Stock In', 'Returned Vaccine', 'Initial Opening Balance'].includes(r.transaction_type);
        const usage = usageForDay(byDay, r.transaction_date, r.vaccine_id);
        const usageKey = `${toYmd(r.transaction_date)}::${r.vaccine_id}`;
        const usage_total_row = !seenUsage.has(usageKey);
        if (usage_total_row) seenUsage.add(usageKey);
        return {
          ...r,
          sheet_label: sheetLabel(r.vaccine_name),
          batch_number: r.batch_number || null,
          transaction_date: toSqlDateTime(r.transaction_date) || r.transaction_date,
          expiration_date: toSqlDate(r.expiration_date) || toSqlDate(r.lot_expiry_date) || null,
          stock_added: isReceipt ? effectiveReceiptQty(r) : 0,
          original_quantity: r.original_quantity != null ? r.original_quantity : r.quantity,
          corrected_quantity: r.corrected_quantity,
          correction_reason: r.correction_reason,
          is_corrected: r.corrected_quantity != null || (r.correction_reason && String(r.correction_reason).trim() !== ''),
          total_vaccine_used: usage_total_row ? usage.total_vaccine_used : null,
          vaccine_used: isReceipt ? 0 : (usage_total_row ? usage.total_vaccine_used : 0),
          usage_total_row,
          expiry_status: getExpiryStatus(r.expiration_date),
        };
      }),
      transaction_types: TRANSACTION_TYPES,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'The system is temporarily unavailable. Please try again later.' });
  }
});

router.get('/pending', requirePermission(PERMISSIONS.INVENTORY), async (req, res) => {
  try {
    const groups = await listPendingAlerts(pool, { days: req.query.days || 14 });
    res.json({ success: true, data: groups });
  } catch (err) {
    console.error('Pending inventory error:', err);
    res.status(500).json({ success: false, message: 'The system is temporarily unavailable. Please try again later.' });
  }
});

router.get('/shift-history', requirePermission(PERMISSIONS.INVENTORY_HISTORY), async (req, res) => {
  try {
    const data = await listShiftHistory(pool, req.query);
    res.json({
      success: true,
      data,
      summary: summarizeShiftDashboard(data),
    });
  } catch (err) {
    console.error('Shift history error:', err);
    res.status(500).json({ success: false, message: 'The system is temporarily unavailable. Please try again later.' });
  }
});

router.post('/shifts/close', requirePermission(PERMISSIONS.INVENTORY), async (req, res) => {
  res.status(410).json({
    success: false,
    message: 'Close Shift is no longer used. Save the AM inventory, then save the PM count to calculate Vaccine Used.',
  });
});

router.post('/reconcile', requirePermission(PERMISSIONS.INVENTORY), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const staff = staffDisplay(req);
    const {
      record_date, vaccine_id, shift, physical_count, remarks, reconciliation_remarks,
    } = req.body;
    if (!vaccine_id || !record_date) {
      return res.status(400).json({ success: false, message: 'Date and vaccine are required' });
    }
    const recShift = normalizeShift(shift);
    const saved = recShift === 'Afternoon Shift'
      ? await savePmCount(conn, {
        record_date,
        vaccine_id,
        remaining_pm_shift: req.body.remaining_pm_shift != null ? req.body.remaining_pm_shift : physical_count,
        physical_count,
        remarks: remarks || reconciliation_remarks,
        staff,
      })
      : await saveAmInventory(conn, {
        record_date,
        vaccine_id,
        physical_count,
        additional_vaccine: req.body.additional_vaccine,
        remarks: remarks || reconciliation_remarks,
        staff,
      });
    logActivity(req, {
      action: ACTIONS.UPDATE, module: MODULES.INVENTORY,
      reference_id: vaccine_id,
      description: `Reconciled inventory for vaccine #${vaccine_id} on ${record_date}`,
    });
    res.json({ success: true, message: 'Inventory reconciliation saved', data: saved });
  } catch (err) {
    console.error('Reconcile error:', err);
    return sendPublicInventoryError(res, err, 'We couldn’t save the inventory record. Please try again.');
  } finally {
    conn.release();
  }
});

router.get('/transactions', requirePermission(PERMISSIONS.INVENTORY), async (req, res) => {
  try {
    const { shift, date } = req.query;
    let query = `SELECT vt.*, v.name as vaccine_name FROM vaccine_transactions vt
      JOIN vaccines v ON vt.vaccine_id = v.vaccine_id WHERE 1=1`;
    const params = [];
    if (date) { query += ' AND DATE(vt.transaction_date) = ?'; params.push(date); }
    if (shift) {
      const sh = parseShiftQuery(shift);
      if (sh) { query += ' AND vt.shift = ?'; params.push(sh); }
    }
    query += ' ORDER BY vt.transaction_date DESC LIMIT 200';
    const [rows] = await pool.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'The system is temporarily unavailable. Please try again later.' });
  }
});

router.post('/', requirePermission(PERMISSIONS.INVENTORY), requireRole('Administrator'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const staff = staffDisplay(req);
    const {
      vaccine_id, quantity, expiry_date, low_stock_threshold, critical_stock_threshold,
      notes, remarks, date_added,
    } = req.body;
    const qty = Number(quantity);
    if (!vaccine_id || !Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ success: false, message: 'Vaccine and a valid quantity are required' });
    }
    if (qty !== Math.floor(qty)) {
      return res.status(400).json({ success: false, message: 'Quantity must be a whole number' });
    }
    const noteText = String(remarks || notes || '').trim();
    if (!noteText) {
      return res.status(400).json({ success: false, message: 'Remarks are required when adding vaccine stock.' });
    }
    const clientToken = String(req.body.client_token || '').replace(/[^\w.-]/g, '').slice(0, 64);
    const ledgerNotes = clientToken ? `${noteText} [receipt-key:${clientToken}]` : noteText;

    await requireActiveManagedVaccine(conn, vaccine_id);
    await ensureDailyRecordSchema(conn);

    const recShift = 'Stock Receiving';
    const recDate = toSqlDate(date_added) || localTodayIso();
    const expiry = expiry_date || null;
    if (!expiry) {
      return res.status(400).json({ success: false, message: 'Expiration date is required for each inventory batch' });
    }
    const expiredOnReceive = toYmd(expiry) && toYmd(expiry) < recDate;
    const lotStatus = expiredOnReceive ? 'Expired' : 'Available';

    await conn.beginTransaction();
    await conn.query('SELECT vaccine_id FROM vaccines WHERE vaccine_id = ? FOR UPDATE', [vaccine_id]);

    const [[recentDup]] = await conn.query(
      `SELECT transaction_id, inventory_id FROM vaccine_transactions
       WHERE vaccine_id = ?
         AND transaction_type IN ('Stock In', ?)
         AND (
           (? <> '' AND notes LIKE ?)
           OR (
             quantity = ? AND staff_id <=> ? AND DATE(transaction_date) = ?
             AND ABS(TIMESTAMPDIFF(SECOND, transaction_date, NOW())) < 20
             AND (expiration_date <=> ?)
             AND (remarks <=> ?)
           )
         )
       LIMIT 1`,
      [
        vaccine_id, OPENING_BALANCE_TYPE,
        clientToken, clientToken ? `%receipt-key:${clientToken}%` : '',
        qty, staff.staff_id || null, recDate, expiry, noteText,
      ]
    ).catch(() => [[]]);
    if (recentDup) {
      await conn.rollback();
      return res.status(200).json({
        success: true,
        message: 'This stock addition was already recorded. Duplicate submit ignored.',
        inventory_id: recentDup.inventory_id || null,
        duplicate: true,
      });
    }

    const established = await isVaccineInventoryEstablished(conn, vaccine_id);
    const txnType = addStockTransactionType(established.established);

    const beforeRef = await fetchAmReference(conn, vaccine_id, recDate);

    const [[sumBefore]] = await conn.query(
      `SELECT COALESCE(SUM(CASE
          WHEN quantity > 0 AND (expiry_date IS NULL OR expiry_date >= CURDATE())
           AND (lot_status IS NULL OR lot_status IN ('Available','Low Stock','Expiring Soon',''))
          THEN quantity ELSE 0 END),0) AS qty
       FROM vaccine_inventory WHERE vaccine_id = ?`,
      [vaccine_id]
    ).catch(async () => conn.query(
      `SELECT COALESCE(SUM(quantity),0) AS qty FROM vaccine_inventory WHERE vaccine_id = ?`,
      [vaccine_id]
    ).then(([rows]) => rows));

    let inventoryId;
    const [[existingLot]] = await conn.query(
      `SELECT * FROM vaccine_inventory
       WHERE vaccine_id = ? AND expiry_date = ?
         AND (batch_number IS NULL OR TRIM(batch_number) = '')
       ORDER BY inventory_id DESC LIMIT 1`,
      [vaccine_id, expiry]
    );

    const incomingLot = { vaccine_id, expiry_date: expiry, batch_number: existingLot ? existingLot.batch_number : null };
    if (existingLot && canMergeIntoLot(existingLot, incomingLot, recDate) && !expiredOnReceive) {
      const newQty = Number(existingLot.quantity || 0) + qty;
      const nextReceived = Number(existingLot.received_quantity || 0) + qty;
      await persistLotQuantity(conn, { ...existingLot, received_quantity: nextReceived }, newQty, { usedDelta: 0 });
      await conn.query(
        `UPDATE vaccine_inventory SET notes = COALESCE(?, notes)
         WHERE inventory_id = ?`,
        [noteText, existingLot.inventory_id]
      ).catch(() => {});
      inventoryId = existingLot.inventory_id;
    } else {
      let result;
      try {
        [result] = await conn.query(
          `INSERT INTO vaccine_inventory
             (vaccine_id, batch_number, quantity, received_quantity, used_quantity, lot_status,
              expiry_date, received_date, received_by, received_by_name,
              low_stock_threshold, critical_stock_threshold, notes)
           VALUES (?,?,?,?,0,?,?,?,?,?,?,?,?)`,
          [
            vaccine_id, null, qty, qty, lotStatus, expiry, recDate,
            staff.staff_id || null, staff.full_name || null,
            low_stock_threshold || 10, critical_stock_threshold || 5, noteText,
          ]
        );
      } catch (_) {
        [result] = await conn.query(
          `INSERT INTO vaccine_inventory (vaccine_id, batch_number, quantity, expiry_date, low_stock_threshold, critical_stock_threshold, notes)
           VALUES (?,?,?,?,?,?,?)`,
          [vaccine_id, null, qty, expiry, low_stock_threshold || 10, critical_stock_threshold || 5, noteText]
        );
      }
      inventoryId = result.insertId;
    }

    if (expiredOnReceive) {
      await conn.query(
        `UPDATE vaccine_inventory SET lot_status = 'Expired' WHERE inventory_id = ?`,
        [inventoryId]
      ).catch(() => {});
    }

    const [[sumAfter]] = await conn.query(
      `SELECT COALESCE(SUM(quantity),0) AS qty FROM vaccine_inventory WHERE vaccine_id = ?`,
      [vaccine_id]
    );

    await recordTransaction(conn, {
      inventory_id: inventoryId, vaccine_id, type: txnType, quantity: qty,
      staff, shift_literal: recShift, notes: ledgerNotes, remarks: noteText,
      beginning_stock: Number(sumBefore.qty) || 0,
      remaining_stock: Number(sumAfter.qty) || 0,
      expiration_date: expiry,
      transaction_date: sqlDateTimeOnCalendarDate(recDate),
    });

    let afterRef = beforeRef;
    if (!expiredOnReceive) {
      afterRef = await refreshClinicReceipts(conn, vaccine_id, recDate);
    }

    await conn.commit();

    logActivity(req, {
      action: ACTIONS.STOCK_IN, module: MODULES.INVENTORY, reference_id: inventoryId,
      description: txnType === OPENING_BALANCE_TYPE
        ? `Initial opening balance: ${qty} units. Verified additional stock 0. AM starting stock ${afterRef.starting ?? qty}.`
        : `Added vaccine stock: ${qty} units. Previous verified stock ${afterRef.previous ?? 0} + additional ${afterRef.additional} = AM starting stock ${afterRef.starting ?? 0}.`,
      old_value: beforeRef.starting != null ? String(beforeRef.starting) : '0',
      new_value: afterRef.starting != null ? String(afterRef.starting) : String(qty),
    });
    res.status(201).json({
      success: true,
      message: expiredOnReceive
        ? 'Stock recorded as expired. It is kept for audit and is not added to usable additional stock.'
        : (txnType === OPENING_BALANCE_TYPE
          ? `Initial opening balance saved (${qty}). This is not verified additional stock. Starting inventory is ${afterRef.starting ?? qty}.`
          : `Additional stock received (${qty}). Previous verified stock ${afterRef.previous ?? 0} + additional ${afterRef.additional} = AM starting stock ${afterRef.starting ?? 0}.`),
      inventory_id: inventoryId,
      data: {
        transaction_type: txnType,
        stock_classification: txnType === OPENING_BALANCE_TYPE ? 'Initial Opening Balance' : 'Additional Stock Received',
        previous_verified_stock: afterRef.previous,
        opening_balance: afterRef.opening_balance,
        additional_vaccine: afterRef.additional,
        am_starting_stock: afterRef.starting,
      },
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('Add stock error:', err);
    return sendPublicInventoryError(res, err, 'We couldn’t add the vaccine stock. Please try again.');
  } finally {
    conn.release();
  }
});

router.get('/:id/stock-ins', requirePermission(PERMISSIONS.INVENTORY), async (req, res) => {
  try {
    const ids = String(req.query.ids || req.params.id)
      .split(',')
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v > 0);
    const lookup = ids.length ? ids : [Number(req.params.id)];
    const placeholders = lookup.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT vt.*, v.name AS vaccine_name, vi.expiry_date AS lot_expiry_date
       FROM vaccine_transactions vt
       JOIN vaccines v ON v.vaccine_id = vt.vaccine_id
       LEFT JOIN vaccine_inventory vi ON vi.inventory_id = vt.inventory_id
       WHERE vt.inventory_id IN (${placeholders}) AND vt.transaction_type IN ('Stock In','Returned Vaccine','Initial Opening Balance')
       ORDER BY vt.transaction_date DESC LIMIT 50`,
      lookup
    );
    res.json({
      success: true,
      correction_reasons: CORRECTION_REASONS,
      data: (rows || []).map((r) => {
        const currentExpiry = toSqlDate(r.corrected_expiration_date) || toSqlDate(r.expiration_date) || toSqlDate(r.lot_expiry_date) || null;
        const originalExpiry = toSqlDate(r.original_expiration_date) || currentExpiry;
        return {
          ...r,
          original_quantity: r.original_quantity != null ? r.original_quantity : r.quantity,
          effective_quantity: r.corrected_quantity != null ? r.corrected_quantity : r.quantity,
          original_expiration_date: originalExpiry,
          current_expiration_date: currentExpiry,
          is_corrected: r.corrected_quantity != null || !!(r.correction_reason && String(r.correction_reason).trim()) || !!(r.corrected_expiration_date),
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'The system is temporarily unavailable. Please try again later.' });
  }
});

router.post('/transactions/:id/correct', requirePermission(PERMISSIONS.INVENTORY), requireRole('Administrator'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const staff = staffDisplay(req);
    const reason = String(req.body.correction_reason || req.body.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ success: false, message: 'A correction reason is required.' });
    }
    if (!req.body.confirm) {
      return res.status(400).json({ success: false, message: 'Confirm the correction summary before saving.' });
    }
    await conn.beginTransaction();
    const result = await correctStockIn(conn, {
      transaction_id: Number(req.params.id),
      quantity: req.body.quantity,
      expiration_date: req.body.expiration_date,
      correction_reason: reason,
      staff,
    });
    await conn.commit();
    const parts = [];
    if (result.quantity_changed) {
      parts.push('added stock ' + result.previous_quantity + ' to ' + result.corrected_quantity);
    }
    if (result.expiration_changed) {
      parts.push('expiration date ' + (result.previous_expiration_date || 'none') + ' to ' + result.corrected_expiration_date);
    }
    logActivity(req, {
      action: ACTIONS.EDIT,
      module: MODULES.INVENTORY,
      reference_id: result.transaction_id,
      description: 'Corrected ' + result.vaccine_name + ' lot #' + (result.inventory_id || '—') + ': ' + parts.join('; ') + ' (' + reason + ').',
      old_value: JSON.stringify({
        transaction_id: result.transaction_id,
        inventory_id: result.inventory_id,
        vaccine: result.vaccine_name,
        original_quantity: result.original_quantity,
        previous_quantity: result.previous_quantity,
        original_expiration_date: result.original_expiration_date,
        previous_expiration_date: result.previous_expiration_date,
        record_date: result.record_date,
        shift: result.shift,
      }),
      new_value: JSON.stringify({
        corrected_quantity: result.quantity_changed ? result.corrected_quantity : result.previous_quantity,
        quantity_changed: result.quantity_changed,
        corrected_expiration_date: result.corrected_expiration_date,
        expiration_changed: result.expiration_changed,
        lot_status: result.lot_status,
        correction_reason: reason,
        corrected_at: result.corrected_at,
        corrected_by: result.corrected_by,
        corrected_by_name: result.corrected_by_name,
        staff_id: staff.staff_id,
        username: req.session && req.session.username,
      }),
    });
    const message = result.expiration_changed && result.quantity_changed
      ? 'Added stock corrected from ' + result.previous_quantity + ' to ' + result.corrected_quantity + '. Expiration date corrected from ' + (result.previous_expiration_date || 'none') + ' to ' + result.corrected_expiration_date + '.'
      : result.expiration_changed
        ? 'Expiration date corrected from ' + (result.previous_expiration_date || 'none') + ' to ' + result.corrected_expiration_date + '. Additional stock was not changed.'
        : 'Stock entry corrected from ' + result.previous_quantity + ' to ' + result.corrected_quantity + '. Original quantity ' + result.original_quantity + ' is kept for audit.';
    res.json({
      success: true,
      message,
      data: result,
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    return sendPublicInventoryError(res, err, 'The inventory update could not be completed. Please check your entries.');
  } finally {
    conn.release();
  }
});

router.put('/:id', requirePermission(PERMISSIONS.INVENTORY), async (req, res) => {
  try {
    const [[existing]] = await pool.query('SELECT * FROM vaccine_inventory WHERE inventory_id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, message: 'Not found' });

    const { batch_number, quantity, expiry_date, low_stock_threshold, critical_stock_threshold, notes } = req.body;
    if (quantity != null && Number(quantity) !== Number(existing.quantity)) {
      return res.status(400).json({
        success: false,
        message: 'Correct added stock quantities through the stock correction workflow with a required reason. Lot remaining cannot be edited here.',
      });
    }
    await pool.query(
      `UPDATE vaccine_inventory SET
         batch_number=COALESCE(?,batch_number), quantity=COALESCE(?,quantity),
         expiry_date=COALESCE(?,expiry_date), low_stock_threshold=COALESCE(?,low_stock_threshold),
         critical_stock_threshold=COALESCE(?,critical_stock_threshold), notes=COALESCE(?,notes)
       WHERE inventory_id=?`,
      [batch_number, quantity, expiry_date, low_stock_threshold, critical_stock_threshold, notes, req.params.id]
    );

    logActivity(req, { action: ACTIONS.EDIT, module: MODULES.INVENTORY, reference_id: req.params.id,
      description: 'Updated vaccine inventory', old_value: JSON.stringify(existing), new_value: JSON.stringify(req.body) });
    res.json({ success: true, message: 'Inventory updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'The system is temporarily unavailable. Please try again later.' });
  }
});

async function handleTxn(req, res, type, deltaFn) {
  const conn = await pool.getConnection();
  try {
    const staff = staffDisplay(req);
    const { quantity, notes, remarks, patient_id, shift } = req.body;
    if (!quantity || quantity <= 0) {
      return res.status(400).json({ success: false, message: 'Valid quantity required' });
    }

    const [[inv]] = await conn.query('SELECT * FROM vaccine_inventory WHERE inventory_id = ?', [req.params.id]);
    if (!inv) return res.status(404).json({ success: false, message: 'Inventory not found' });

    const recShift = normalizeShift(shift || getCurrentShift());
    const recDate = toYmd(req.body.record_date) || localYmd();
    const decreases = ['Stock Out', 'Vaccine Usage', 'Damaged Vaccine', 'Expired Vaccine', 'Transfer'];
    if (decreases.includes(type) && !isUsableLot(inv) && type !== 'Expired Vaccine' && type !== 'Damaged Vaccine') {
      const st = deriveLotStatus(inv);
      return res.status(400).json({
        success: false,
        message: `This batch cannot be used (${st}). Receive a new delivery under the same vaccine instead.`,
      });
    }
    if (type === 'Expired Vaccine' && (Number(inv.quantity) || 0) <= 0) {
      return res.status(400).json({ success: false, message: 'This batch has no remaining quantity to expire' });
    }

    const [[sumBefore]] = await conn.query(
      `SELECT COALESCE(SUM(quantity),0) AS qty FROM vaccine_inventory WHERE vaccine_id = ?`,
      [inv.vaccine_id]
    );

    const oldQty = inv.quantity;
    const newQty = deltaFn(oldQty, quantity);
    if (newQty < 0) return res.status(400).json({ success: false, message: 'Insufficient stock on this batch' });

    const usedDelta = decreases.includes(type) ? Number(quantity) : 0;
    const forceStatus = type === 'Expired Vaccine' ? 'Expired'
      : type === 'Returned Vaccine' ? 'Returned'
      : null;
    await persistLotQuantity(conn, inv, newQty, { usedDelta, forceStatus });

    const [[sumAfter]] = await conn.query(
      `SELECT COALESCE(SUM(quantity),0) AS qty FROM vaccine_inventory WHERE vaccine_id = ?`,
      [inv.vaccine_id]
    );

    await recordTransaction(conn, {
      inventory_id: req.params.id, vaccine_id: inv.vaccine_id, type, quantity,
      staff, shift: recShift, patient_id, notes, remarks,
      beginning_stock: Number(sumBefore.qty) || 0,
      remaining_stock: Number(sumAfter.qty) || 0,
      expiration_date: inv.expiry_date || null,
    });

    const addTypes = ['Stock In', 'Returned Vaccine'];
    if (addTypes.includes(type)) {
      // STOCK LINKING FIX: Block Stock In after PM count submission
      const [[pmCheck]] = await conn.query(
        `SELECT record_id, shift FROM inventory_daily_records
         WHERE vaccine_id = ? AND record_date = ? 
           AND shift = 'Afternoon Shift' AND opening_recorded = 1
         LIMIT 1`,
        [inv.vaccine_id, recDate]
      );
      
      if (pmCheck) {
        return res.status(400).json({
          success: false,
          message: `PM count for this vaccine on ${recDate} has already been submitted. ` +
                   `Stock received after PM count belongs to the next day. ` +
                   `To add this stock to today's count, use "Correct PM Count" to revise the PM inventory.`,
        });
      }
      
      await refreshClinicReceipts(conn, inv.vaccine_id, recDate);
    }

    logActivity(req, { action: ACTIONS.UPDATE, module: MODULES.INVENTORY, reference_id: req.params.id,
      description: `${type}: ${quantity} units`, old_value: String(oldQty), new_value: String(newQty) });
    res.json({ success: true, message: `${type} recorded successfully` });
  } catch (err) {
    return sendPublicInventoryError(res, err, 'We couldn’t save the inventory record. Please try again.');
  } finally {
    conn.release();
  }
}

router.post('/:id/stock-in', requirePermission(PERMISSIONS.INVENTORY), (req, res) =>
  handleTxn(req, res, 'Stock In', (old, q) => old + q));
router.post('/:id/stock-out', requirePermission(PERMISSIONS.INVENTORY), (req, res) =>
  handleTxn(req, res, 'Stock Out', (old, q) => old - q));
router.post('/:id/usage', requirePermission(PERMISSIONS.INVENTORY), (req, res) =>
  handleTxn(req, res, 'Vaccine Usage', (old, q) => old - q));
router.post('/:id/adjustment', requirePermission(PERMISSIONS.INVENTORY), async (req, res) => {
  const { new_quantity, remarks } = req.body;
  const conn = await pool.getConnection();
  try {
    const staff = staffDisplay(req);
    const [[inv]] = await conn.query('SELECT * FROM vaccine_inventory WHERE inventory_id = ?', [req.params.id]);
    if (!inv) return res.status(404).json({ success: false, message: 'Not found' });
    if (new_quantity == null || Number(new_quantity) < 0) {
      return res.status(400).json({ success: false, message: 'New quantity must be zero or greater' });
    }
    if (!remarks || !String(remarks).trim()) {
      return res.status(400).json({ success: false, message: 'Remarks are required for inventory adjustments' });
    }
    const nextQty = Number(new_quantity);
    const diff = Math.abs(nextQty - Number(inv.quantity));
    const usedDelta = nextQty < Number(inv.quantity) ? Number(inv.quantity) - nextQty : 0;
    await persistLotQuantity(conn, inv, nextQty, { usedDelta });
    await recordTransaction(conn, {
      inventory_id: req.params.id, vaccine_id: inv.vaccine_id, type: 'Adjustment', quantity: diff,
      staff, shift: getCurrentShift(), remarks,
    });
    res.json({ success: true, message: 'Adjustment recorded' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'The system is temporarily unavailable. Please try again later.' });
  } finally {
    conn.release();
  }
});

router.post('/:id/disposition', requirePermission(PERMISSIONS.INVENTORY), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const staff = staffDisplay(req);
    const action = String(req.body.action || '').trim().toLowerCase();
    const remarks = String(req.body.remarks || '').trim();
    const map = { quarantine: 'Quarantined', dispose: 'Disposed', return: 'Returned' };
    const status = map[action];
    if (!status) {
      return res.status(400).json({ success: false, message: 'Action must be quarantine, dispose, or return' });
    }
    if (!remarks) {
      return res.status(400).json({ success: false, message: 'Remarks are required for authorized disposition' });
    }
    const [[inv]] = await conn.query('SELECT * FROM vaccine_inventory WHERE inventory_id = ?', [req.params.id]);
    if (!inv) return res.status(404).json({ success: false, message: 'Inventory not found' });
    await persistLotQuantity(conn, inv, inv.quantity, { usedDelta: 0, forceStatus: status });
    await recordTransaction(conn, {
      inventory_id: inv.inventory_id,
      vaccine_id: inv.vaccine_id,
      type: status === 'Returned' ? 'Returned Vaccine' : 'Adjustment',
      quantity: Number(inv.quantity) || 0,
      staff,
      shift: getCurrentShift(),
      remarks: `${status}: ${remarks}`,
      notes: `disposition:${status}`,
      expiration_date: inv.expiry_date || null,
    });
    logActivity(req, {
      action: ACTIONS.UPDATE, module: MODULES.INVENTORY, reference_id: inv.inventory_id,
      description: `${status} batch #${inv.inventory_id}: ${remarks}`,
    });
    res.json({ success: true, message: `Batch marked ${status}`, data: { lot_status: status } });
  } catch (err) {
    return sendPublicInventoryError(res, err, 'We couldn’t save the inventory record. Please try again.');
  } finally {
    conn.release();
  }
});

router.post('/:id/transaction', requirePermission(PERMISSIONS.INVENTORY), async (req, res) => {
  const { transaction_type, quantity, remarks, notes } = req.body;
  if (!TRANSACTION_TYPES.includes(transaction_type)) {
    return res.status(400).json({ success: false, message: 'Invalid transaction type' });
  }
  const decreases = ['Stock Out', 'Vaccine Usage', 'Damaged Vaccine', 'Expired Vaccine', 'Transfer'];
  const increases = ['Stock In', 'Returned Vaccine'];
  if (decreases.includes(transaction_type)) {
    return handleTxn(req, res, transaction_type, (old, q) => old - q);
  }
  if (increases.includes(transaction_type)) {
    return handleTxn(req, res, transaction_type, (old, q) => old + q);
  }
  if (transaction_type === 'Adjustment') {
    req.body.new_quantity = quantity;
    return router.handle({ ...req, url: `/${req.params.id}/adjustment` }, res, () => {});
  }
  res.status(400).json({ success: false, message: 'Unsupported transaction' });
});

module.exports = router;
