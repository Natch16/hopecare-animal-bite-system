'use strict';

const { toSqlDate } = require('./dateOnly');

function toYmd(v) {
  return toSqlDate(v);
}

const OPENING_BALANCE_TYPE = 'Initial Opening Balance';
const ADDITIONAL_RECEIPT_TYPES = ['Stock In', 'Returned Vaccine'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function startingFromParts({ previousPm, openingBalance = 0, additional = 0 }) {
  const opening = num(openingBalance);
  const add = num(additional);
  const prev = previousPm == null || previousPm === '' ? null : num(previousPm);
  const baseline = prev != null ? prev : (opening > 0 ? opening : null);
  if (baseline == null && add <= 0) return null;
  return (baseline == null ? 0 : baseline) + add;
}

async function countByQuery(conn, sql, params) {
  try {
    const [[row]] = await conn.query(sql, params);
    return num(row && (row.n != null ? row.n : row.cnt));
  } catch (_) {
    return 0;
  }
}

/**
 * Established inventory for a vaccine: opening already recorded, verified
 * daily counts exist, lots exist, or prior stock-in/returned receipts exist.
 * Quantity reaching 0 does not re-open initial setup.
 */
async function isVaccineInventoryEstablished(conn, vaccineId) {
  const id = Number(vaccineId);
  if (!Number.isFinite(id)) return { established: false, reason: 'invalid' };

  if (await countByQuery(conn,
    `SELECT COUNT(*) AS n FROM vaccine_transactions
     WHERE vaccine_id = ? AND transaction_type = ? LIMIT 1`,
    [id, OPENING_BALANCE_TYPE]
  ) > 0) {
    return { established: true, reason: 'opening_balance' };
  }

  if (await countByQuery(conn,
    `SELECT COUNT(*) AS n FROM inventory_daily_records
     WHERE vaccine_id = ? AND opening_recorded = 1 LIMIT 1`,
    [id]
  ) > 0) {
    return { established: true, reason: 'daily_record' };
  }

  if (await countByQuery(conn,
    `SELECT COUNT(*) AS n FROM vaccine_inventory WHERE vaccine_id = ? LIMIT 1`,
    [id]
  ) > 0) {
    return { established: true, reason: 'lot' };
  }

  if (await countByQuery(conn,
    `SELECT COUNT(*) AS n FROM vaccine_transactions
     WHERE vaccine_id = ? AND transaction_type IN ('Stock In','Returned Vaccine') LIMIT 1`,
    [id]
  ) > 0) {
    return { established: true, reason: 'stock_in' };
  }

  return { established: false, reason: 'none' };
}

function addStockTransactionType(established) {
  return established ? 'Stock In' : OPENING_BALANCE_TYPE;
}

async function sumOpeningBalance(conn, vaccineId, toInclusive) {
  const to = toYmd(toInclusive);
  try {
    const [[row]] = await conn.query(
      `SELECT COALESCE(SUM(COALESCE(corrected_quantity, quantity)),0) AS qty
       FROM vaccine_transactions
       WHERE vaccine_id = ?
         AND transaction_type = ?
         AND (notes IS NULL OR notes NOT LIKE '%lot-receipt-sync:%')
         AND DATE(transaction_date) <= ?`,
      [vaccineId, OPENING_BALANCE_TYPE, to]
    );
    return num(row && row.qty);
  } catch (_) {
    try {
      const [[row]] = await conn.query(
        `SELECT COALESCE(SUM(quantity),0) AS qty
         FROM vaccine_transactions
         WHERE vaccine_id = ?
           AND transaction_type = ?
           AND (notes IS NULL OR notes NOT LIKE '%lot-receipt-sync:%')
           AND DATE(transaction_date) <= ?`,
        [vaccineId, OPENING_BALANCE_TYPE, to]
      );
      return num(row && row.qty);
    } catch (__) {
      return 0;
    }
  }
}

async function loadOpeningBalanceMap(conn, recordDate) {
  const to = toYmd(recordDate);
  let rows = [];
  try {
    [rows] = await conn.query(
      `SELECT vaccine_id, COALESCE(SUM(COALESCE(corrected_quantity, quantity)),0) AS qty
       FROM vaccine_transactions
       WHERE transaction_type = ?
         AND (notes IS NULL OR notes NOT LIKE '%lot-receipt-sync:%')
         AND DATE(transaction_date) <= ?
       GROUP BY vaccine_id`,
      [OPENING_BALANCE_TYPE, to]
    );
  } catch (_) {
    try {
      [rows] = await conn.query(
        `SELECT vaccine_id, COALESCE(SUM(quantity),0) AS qty
         FROM vaccine_transactions
         WHERE transaction_type = ?
           AND (notes IS NULL OR notes NOT LIKE '%lot-receipt-sync:%')
           AND DATE(transaction_date) <= ?
         GROUP BY vaccine_id`,
        [OPENING_BALANCE_TYPE, to]
      );
    } catch (__) {
      rows = [];
    }
  }
  const map = new Map();
  for (const r of rows || []) {
    map.set(Number(r.vaccine_id), num(r.qty));
  }
  return map;
}

module.exports = {
  OPENING_BALANCE_TYPE,
  ADDITIONAL_RECEIPT_TYPES,
  startingFromParts,
  isVaccineInventoryEstablished,
  addStockTransactionType,
  sumOpeningBalance,
  loadOpeningBalanceMap,
};
