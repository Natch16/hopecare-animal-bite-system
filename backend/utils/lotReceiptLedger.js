'use strict';

const { toSqlDate } = require('./dateOnly');

const RECEIPT_TYPES = ['Stock In', 'Returned Vaccine', 'Initial Opening Balance'];
const SYNC_MARKER = 'lot-receipt-sync:';

/** History-only backfill. The lot quantity already includes this stock. */
function isLedgerBackfill(row) {
  return String((row && (row.notes || row.remarks)) || '').includes(SYNC_MARKER);
}

const BALANCE_NEUTRAL_SQL = `(notes IS NULL OR notes NOT LIKE '%${SYNC_MARKER}%')`;

/**
 * Quantity received for a lot. Remaining stock is not used.
 * A lot that has already been used and has no stored received quantity is left alone.
 */
function receiptQuantityForLot(lot) {
  if (!lot) return null;
  if (lot.received_quantity != null && lot.received_quantity !== '') {
    const received = Number(lot.received_quantity);
    return Number.isFinite(received) && received > 0 ? received : null;
  }
  const used = Number(lot.used_quantity);
  if (Number.isFinite(used) && used > 0) return null;
  const qty = Number(lot.quantity);
  return Number.isFinite(qty) && qty > 0 ? qty : null;
}

function receiptMoment(lot) {
  const day = toSqlDate(lot && lot.received_date) || toSqlDate(lot && lot.created_at);
  return day ? `${day} 00:00:00` : null;
}

/**
 * One receipt plan per lot that has no Stock In, opening balance, or return.
 * Existing receipts, including corrected and expired lots, are not planned again.
 */
function planMissingLotReceipts(lots, coveredIds) {
  const covered = coveredIds instanceof Set
    ? coveredIds
    : new Set((coveredIds || []).map(Number).filter((id) => id > 0));
  const vaccinesWithReceipt = new Set();
  const ordered = [...(lots || [])].sort((a, b) => Number(a.inventory_id) - Number(b.inventory_id));
  for (const lot of ordered) {
    if (covered.has(Number(lot.inventory_id))) vaccinesWithReceipt.add(Number(lot.vaccine_id));
  }
  const plans = [];
  for (const lot of ordered) {
    const inventoryId = Number(lot.inventory_id);
    const vaccineId = Number(lot.vaccine_id);
    if (!inventoryId || !vaccineId || covered.has(inventoryId)) continue;
    const quantity = receiptQuantityForLot(lot);
    if (!quantity) continue;
    const transactionType = vaccinesWithReceipt.has(vaccineId) ? 'Stock In' : 'Initial Opening Balance';
    vaccinesWithReceipt.add(vaccineId);
    const remarks = String(lot.notes || '').trim() || 'Recorded from the vaccine lot record';
    plans.push({
      inventory_id: inventoryId,
      vaccine_id: vaccineId,
      transaction_type: transactionType,
      quantity,
      expiration_date: toSqlDate(lot.expiry_date),
      transaction_date: receiptMoment(lot),
      received_by: lot.received_by || null,
      received_by_name: lot.received_by_name || null,
      remarks,
      notes: `${SYNC_MARKER}${inventoryId}`,
    });
  }
  return plans;
}

async function ensureLotReceiptTransactions(conn) {
  const [lots] = await conn.query(`
    SELECT inventory_id, vaccine_id, quantity, received_quantity, used_quantity,
           expiry_date, received_date, created_at, notes, received_by, received_by_name
    FROM vaccine_inventory
  `);
  const [receipts] = await conn.query(
    `SELECT inventory_id FROM vaccine_transactions
     WHERE inventory_id IS NOT NULL
       AND transaction_type IN (?)`,
    [RECEIPT_TYPES]
  );
  const covered = new Set((receipts || []).map((row) => Number(row.inventory_id)).filter((id) => id > 0));
  const plans = planMissingLotReceipts(lots, covered);
  if (!plans.length) return { created: 0, plans: [] };

  const [[admin]] = await conn.query(
    `SELECT id, full_name FROM staff_account WHERE role = 'Administrator' ORDER BY id LIMIT 1`
  ).catch(() => [[null]]);
  const [[anyStaff]] = admin ? [[null]] : await conn.query(
    `SELECT id, full_name FROM staff_account ORDER BY id LIMIT 1`
  ).catch(() => [[null]]);
  const fallback = admin || anyStaff;

  let created = 0;
  for (const plan of plans) {
    const staffId = Number(plan.received_by) || Number(fallback && fallback.id);
    if (!staffId) continue;
    const staffName = plan.received_by_name || (fallback && fallback.full_name) || 'System Administrator';
    const params = [
      plan.inventory_id, plan.vaccine_id, plan.transaction_type, plan.quantity, plan.quantity,
      staffId, staffName, 'Stock Receiving', plan.notes, plan.remarks,
      plan.expiration_date, plan.transaction_date, plan.inventory_id,
    ];
    let result;
    try {
      [result] = await conn.query(
        `INSERT INTO vaccine_transactions
           (inventory_id, vaccine_id, transaction_type, quantity, original_quantity,
            staff_id, staff_name, shift, notes, remarks, expiration_date, transaction_date)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?
         FROM DUAL
         WHERE NOT EXISTS (
           SELECT 1 FROM vaccine_transactions
           WHERE inventory_id = ?
             AND transaction_type IN ('Stock In','Returned Vaccine','Initial Opening Balance')
         )`,
        params
      );
    } catch (_) {
      [result] = await conn.query(
        `INSERT INTO vaccine_transactions
           (inventory_id, vaccine_id, transaction_type, quantity,
            staff_id, staff_name, shift, notes, remarks, expiration_date, transaction_date)
         SELECT ?,?,?,?,?,?,?,?,?,?,?
         FROM DUAL
         WHERE NOT EXISTS (
           SELECT 1 FROM vaccine_transactions
           WHERE inventory_id = ?
             AND transaction_type IN ('Stock In','Returned Vaccine','Initial Opening Balance')
         )`,
        [
          plan.inventory_id, plan.vaccine_id, plan.transaction_type, plan.quantity,
          staffId, staffName, 'Stock Receiving', plan.notes, plan.remarks,
          plan.expiration_date, plan.transaction_date, plan.inventory_id,
        ]
      );
    }
    created += Number(result && result.affectedRows) || 0;
  }
  return { created, plans };
}

module.exports = {
  RECEIPT_TYPES,
  SYNC_MARKER,
  BALANCE_NEUTRAL_SQL,
  isLedgerBackfill,
  receiptQuantityForLot,
  planMissingLotReceipts,
  ensureLotReceiptTransactions,
};
