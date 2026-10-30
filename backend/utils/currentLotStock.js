'use strict';

const { groupLotsForDisplay } = require('./inventoryBatches');
const { toSqlDate, localTodayIso } = require('./dateOnly');
const { getStockLevel, getExpiryStatus } = require('./inventoryHelpers');

async function fetchCurrentLotGroups(pool) {
  const [rows] = await pool.query(`
    SELECT vi.*, v.name AS vaccine_name, v.category
    FROM vaccine_inventory vi
    JOIN vaccines v ON vi.vaccine_id = v.vaccine_id
  `);
  return groupLotsForDisplay(rows || []);
}

/** Same counting rules as the Current Lot Stock summary (GET /api/inventory/summary). */
function summarizeLotGroups(grouped, today = null) {
  let low = 0, critical = 0, expired = 0, exp30 = 0, exp15 = 0, exp7 = 0, total = 0;
  const lots = [];
  (grouped || []).forEach((lot) => {
    const usable = Number(lot.usable_quantity) || 0;
    total += usable;
    const s = getStockLevel(usable, lot.low_stock_threshold, lot.critical_stock_threshold);
    const e = getExpiryStatus(lot.expiry_date, today);
    let isExpired = false;
    let expiring = null;
    if (lot.batch_status === 'Expired') { expired++; isExpired = true; }
    const isLow = usable > 0 && s.class === 'stock-low';
    const isCritical = usable > 0 && (s.class === 'stock-critical' || s.class === 'stock-out');
    if (isLow) low++;
    if (isCritical) critical++;
    if (e.class === 'exp-expired' && lot.batch_status !== 'Expired') { expired++; isExpired = true; }
    else if (usable > 0 && e.class === 'exp-30') { exp30++; expiring = 30; }
    else if (usable > 0 && e.class === 'exp-15') { exp15++; expiring = 15; }
    else if (usable > 0 && e.class === 'exp-7') { exp7++; expiring = 7; }
    lots.push({
      inventory_id: lot.inventory_id,
      vaccine_id: lot.vaccine_id,
      vaccine_name: lot.vaccine_name,
      batch_number: lot.batch_number || null,
      usable_quantity: usable,
      quantity: Number(lot.quantity) || 0,
      expiry_date: lot.expiry_date || null,
      expiry_days: e.days,
      batch_status: lot.batch_status,
      updated_at: lot.updated_at || lot.created_at || null,
      isLow,
      isCritical,
      isExpired,
      expiringWithin: expiring,
    });
  });
  return {
    counts: {
      total_stock: total,
      total_items: (grouped || []).length,
      low_stock_count: low,
      critical_stock_count: critical,
      expired_count: expired,
      expiring_30: exp30,
      expiring_15: exp15,
      expiring_7: exp7,
    },
    lots,
  };
}

/**
 * Low and critical cards use each vaccine's current stock: the sum of usable
 * vials still on hand. One small lot does not make the vaccine low when other
 * usable lots keep the total above the threshold.
 */
function currentStockLevels(lots) {
  const byVaccine = new Map();
  for (const lot of lots || []) {
    const id = Number(lot.vaccine_id);
    if (!id) continue;
    const expired = !!(lot.isExpired || lot.batch_status === 'Expired');
    const usable = expired ? 0 : (Number(lot.usable_quantity) || 0);
    const row = byVaccine.get(id) || {
      vaccine_id: id,
      vaccine_name: lot.vaccine_name || 'Vaccine',
      currentStock: 0,
      low_stock_threshold: lot.low_stock_threshold,
      critical_stock_threshold: lot.critical_stock_threshold,
    };
    row.currentStock += usable;
    if (lot.vaccine_name) row.vaccine_name = lot.vaccine_name;
    if (lot.low_stock_threshold != null) row.low_stock_threshold = lot.low_stock_threshold;
    if (lot.critical_stock_threshold != null) row.critical_stock_threshold = lot.critical_stock_threshold;
    byVaccine.set(id, row);
  }
  let low = 0;
  let critical = 0;
  let out = 0;
  const vaccines = [];
  for (const row of byVaccine.values()) {
    const level = getStockLevel(row.currentStock, row.low_stock_threshold, row.critical_stock_threshold);
    row.isLow = row.currentStock > 0 && level.class === 'stock-low';
    row.isCritical = row.currentStock > 0 && level.class === 'stock-critical';
    row.isOut = row.currentStock <= 0;
    if (row.isLow) low += 1;
    if (row.isCritical) critical += 1;
    if (row.isOut) out += 1;
    vaccines.push(row);
  }
  return { low, critical, out, vaccines };
}

const RECEIPT_TYPES = ['Stock In', 'Returned Vaccine', 'Initial Opening Balance'];

/**
 * Additional stock is the quantity recorded on the lot's receiving transactions.
 * A corrected receipt uses corrected_quantity. Remaining quantity is not used.
 */
function additionalStockForGroupedLot(lot, receipts, stored) {
  const ids = (lot && lot.inventory_ids && lot.inventory_ids.length)
    ? lot.inventory_ids
    : [lot && lot.inventory_id];
  let total = 0;
  let any = false;
  for (const id of ids) {
    const key = Number(id);
    if (!key) continue;
    if (receipts.has(key)) {
      total += Number(receipts.get(key)) || 0;
      any = true;
    } else if (stored.has(key)) {
      total += Number(stored.get(key)) || 0;
      any = true;
    }
  }
  return any ? total : null;
}

function lotIdsOf(lot) {
  const ids = (lot && lot.inventory_ids && lot.inventory_ids.length)
    ? lot.inventory_ids
    : [lot && lot.inventory_id];
  return ids.map(Number).filter((id) => id > 0);
}

/**
 * Receipt-record status. Expired wins over a correction. Remaining quantity is ignored.
 */
function lotRecordStatus({ expiryDate, corrected = false, today = null } = {}) {
  const exp = toSqlDate(expiryDate);
  const day = toSqlDate(today) || localTodayIso();
  if (exp && day && exp < day) return 'Expired';
  if (corrected) return 'Corrected';
  return 'Received';
}

function groupedLotWasCorrected(lot, correctedIds) {
  return lotIdsOf(lot).some((id) => correctedIds && correctedIds.has(id));
}

async function fetchReceiptTotals(pool, inventoryIds) {
  const ids = [...new Set((inventoryIds || []).map(Number).filter((id) => id > 0))];
  const totals = new Map();
  const corrected = new Set();
  if (!ids.length) return { totals, corrected };
  const [rows] = await pool.query(
    `SELECT inventory_id,
            SUM(COALESCE(corrected_quantity, quantity)) AS qty,
            MAX(CASE
              WHEN corrected_quantity IS NOT NULL THEN 1
              WHEN correction_reason IS NOT NULL AND TRIM(correction_reason) <> ''
                AND corrected_expiration_date IS NULL THEN 1
              ELSE 0 END) AS was_corrected
     FROM vaccine_transactions
     WHERE inventory_id IN (?)
       AND transaction_type IN (?)
     GROUP BY inventory_id`,
    [ids, RECEIPT_TYPES]
  );
  for (const row of rows || []) {
    const id = Number(row.inventory_id);
    totals.set(id, Number(row.qty) || 0);
    if (Number(row.was_corrected) === 1) corrected.add(id);
  }
  return { totals, corrected };
}

module.exports = {
  fetchCurrentLotGroups,
  summarizeLotGroups,
  currentStockLevels,
  additionalStockForGroupedLot,
  fetchReceiptTotals,
  lotRecordStatus,
  groupedLotWasCorrected,
  RECEIPT_TYPES,
};
