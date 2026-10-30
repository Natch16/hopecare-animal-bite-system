'use strict';

const { toSqlDate, sqlDateTimeOnCalendarDate } = require('./dateOnly');
const { isUsableLot, persistLotQuantity, deriveLotStatus } = require('./inventoryBatches');

/**
 * Keeps vaccine_inventory lot quantities in step with verified AM/PM clinic usage:
 *   Current Stock = Previous Current Stock + Additional Stock − Total Vaccines Used
 * Additional stock is already added to lots when it is received, so only usage is
 * deducted here. Each (date, vaccine) owns a ledger in vaccine_transactions keyed by
 * notes, so re-saving or retrying only applies the difference.
 */
const DEDUCT_NOTE = 'sheet-usage';
const RESTORE_NOTE = 'sheet-usage-restore';
const MANUAL_DECREASE_TYPES = ['Vaccine Usage', 'Usage', 'Stock Out', 'Damaged Vaccine', 'Expired Vaccine', 'Transfer'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

function ledgerKey(prefix, date, vaccineId) {
  return `${prefix}:${date}:${Number(vaccineId)}`;
}

/** Positive = deduct more from lots, negative = restore to lots. */
function planUsageDelta({ used, manualDeducted = 0, alreadyDeducted = 0 }) {
  const u = used == null || used === '' ? NaN : Number(used);
  if (!Number.isFinite(u) || u < 0 || u !== Math.floor(u)) {
    fail('Vaccine Used must be a whole number that is zero or greater.');
  }
  const target = Math.max(0, u - Math.max(0, num(manualDeducted)));
  return { target, delta: target - Math.max(0, num(alreadyDeducted)) };
}

/** First-expiry-first-out allocation over usable lots. */
function allocateDeduction(lots, qty, today) {
  const usable = (lots || [])
    .filter((l) => isUsableLot(l, today))
    .sort((a, b) => String(toSqlDate(a.expiry_date) || '9999').localeCompare(String(toSqlDate(b.expiry_date) || '9999'))
      || Number(a.inventory_id) - Number(b.inventory_id));
  const available = usable.reduce((s, l) => s + num(l.quantity), 0);
  if (qty > available) return { available, parts: null };
  const parts = [];
  let left = qty;
  for (const lot of usable) {
    if (left <= 0) break;
    const take = Math.min(num(lot.quantity), left);
    if (take > 0) parts.push({ lot, take });
    left -= take;
  }
  return { available, parts };
}

async function insertLedgerRow(conn, {
  lot, vaccineId, type, quantity, date, staff, notes, remarks, beginning, remaining,
}) {
  await conn.query(
    `INSERT INTO vaccine_transactions
       (inventory_id, vaccine_id, transaction_type, quantity, original_quantity, staff_id, staff_name,
        staff_id_display, shift, notes, remarks, beginning_stock, remaining_stock, expiration_date, transaction_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      lot.inventory_id, vaccineId, type, quantity, quantity,
      staff.staff_id || null, staff.full_name || null, staff.staff_id_display || null,
      'Afternoon Shift', notes, remarks, beginning, remaining,
      lot.expiry_date || null, sqlDateTimeOnCalendarDate(date),
    ]
  );
}

async function vaccineStockTotal(conn, vaccineId) {
  const [[row]] = await conn.query(
    'SELECT COALESCE(SUM(quantity),0) AS qty FROM vaccine_inventory WHERE vaccine_id = ?',
    [vaccineId]
  );
  return num(row && row.qty);
}

/**
 * Must run inside the caller's DB transaction (same connection).
 * Returns { used, deducted, delta, currentStock }.
 */
async function syncSheetUsageDeduction(conn, {
  date, vaccineId, used, staff = {}, vaccineName = null, today = null, counts = null,
}) {
  const day = toSqlDate(date);
  if (!day) fail('A valid inventory date is required.');
  const vid = Number(vaccineId);
  if (!vid) fail('A valid vaccine is required.');

  const [[vaccineRow]] = await conn.query('SELECT vaccine_id, name FROM vaccines WHERE vaccine_id = ? FOR UPDATE', [vid]);
  if (!vaccineRow) fail('The selected vaccine was not found.', 404);

  const deductKey = ledgerKey(DEDUCT_NOTE, day, vid);
  const restoreKey = ledgerKey(RESTORE_NOTE, day, vid);
  const [ledger] = await conn.query(
    `SELECT transaction_id, inventory_id, quantity, notes
     FROM vaccine_transactions
     WHERE vaccine_id = ? AND notes IN (?, ?)
     ORDER BY transaction_id ASC`,
    [vid, deductKey, restoreKey]
  );
  const netByLot = new Map();
  for (const r of ledger || []) {
    const sign = r.notes === deductKey ? 1 : -1;
    const id = Number(r.inventory_id);
    netByLot.set(id, (netByLot.get(id) || 0) + sign * num(r.quantity));
  }
  const alreadyDeducted = [...netByLot.values()].reduce((s, n) => s + n, 0);

  const [[manual]] = await conn.query(
    `SELECT COALESCE(SUM(COALESCE(corrected_quantity, quantity)),0) AS qty
     FROM vaccine_transactions
     WHERE vaccine_id = ? AND DATE(transaction_date) = ?
       AND transaction_type IN (?)
       AND (notes IS NULL OR (notes NOT LIKE 'sheet-usage:%' AND notes NOT LIKE 'sheet-usage-restore:%'))`,
    [vid, day, MANUAL_DECREASE_TYPES]
  );
  const { target, delta } = planUsageDelta({
    used, manualDeducted: manual && manual.qty, alreadyDeducted,
  });

  const label = vaccineName || vaccineRow.name || `vaccine #${vid}`;
  const formula = counts
    ? `AM ${counts.am} + additional ${counts.additional} − PM ${counts.pm} = ${used}`
    : `Vaccine Used ${used}`;

  if (delta > 0) {
    const [lots] = await conn.query(
      'SELECT * FROM vaccine_inventory WHERE vaccine_id = ? AND quantity > 0 FOR UPDATE',
      [vid]
    );
    const { available, parts } = allocateDeduction(lots, delta, today || undefined);
    if (!parts) {
      fail(
        `Vaccine Used for ${label} (${delta} more vial(s)) exceeds the available stock (${available}). `
        + 'Record the additional stock received or an authorized stock adjustment first.'
      );
    }
    for (const { lot, take } of parts) {
      const before = await vaccineStockTotal(conn, vid);
      await persistLotQuantity(conn, lot, num(lot.quantity) - take, { usedDelta: take });
      await insertLedgerRow(conn, {
        lot, vaccineId: vid, type: 'Vaccine Usage', quantity: take, date: day, staff,
        notes: deductKey,
        remarks: `AM/PM clinic usage ${day}: ${formula}`,
        beginning: before, remaining: before - take,
      });
    }
  } else if (delta < 0) {
    let left = -delta;
    const ids = [...netByLot.entries()].filter(([, n]) => n > 0).map(([id]) => id).sort((a, b) => b - a);
    for (const id of ids) {
      if (left <= 0) break;
      const give = Math.min(netByLot.get(id), left);
      const [[lot]] = await conn.query('SELECT * FROM vaccine_inventory WHERE inventory_id = ? FOR UPDATE', [id]);
      if (!lot || give <= 0) continue;
      const before = await vaccineStockTotal(conn, vid);
      const nextQty = num(lot.quantity) + give;
      const nextUsed = Math.max(0, num(lot.used_quantity) - give);
      const status = deriveLotStatus({ ...lot, quantity: nextQty, lot_status: lot.lot_status === 'Depleted' ? null : lot.lot_status });
      await conn.query(
        'UPDATE vaccine_inventory SET quantity = ?, used_quantity = ?, lot_status = ? WHERE inventory_id = ?',
        [nextQty, nextUsed, status, id]
      );
      await insertLedgerRow(conn, {
        lot, vaccineId: vid, type: 'Adjustment', quantity: give, date: day, staff,
        notes: restoreKey,
        remarks: `AM/PM usage corrected for ${day}: ${give} vial(s) returned to stock (${formula})`,
        beginning: before, remaining: before + give,
      });
      left -= give;
    }
  }

  return {
    used: Number(used),
    deducted: target,
    delta,
    currentStock: await vaccineStockTotal(conn, vid),
  };
}

module.exports = {
  DEDUCT_NOTE,
  RESTORE_NOTE,
  MANUAL_DECREASE_TYPES,
  ledgerKey,
  planUsageDelta,
  allocateDeduction,
  syncSheetUsageDeduction,
};
