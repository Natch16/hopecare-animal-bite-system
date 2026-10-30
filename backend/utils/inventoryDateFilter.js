'use strict';

const { toSqlDate, sqlDayStart, sqlDayEndExclusive } = require('./dateOnly');

function parseStockAddedDateRange(query = {}) {
  const fromRaw = query.date_from != null ? query.date_from : query.from;
  const toRaw = query.date_to != null ? query.date_to : query.to;
  const fromFilled = fromRaw != null && String(fromRaw).trim() !== '';
  const toFilled = toRaw != null && String(toRaw).trim() !== '';
  const dateFrom = fromFilled ? toSqlDate(fromRaw) : null;
  const dateTo = toFilled ? toSqlDate(toRaw) : null;

  if (fromFilled && !dateFrom) {
    const err = new Error('Enter a valid start date for when stock was added.');
    err.status = 400;
    throw err;
  }
  if (toFilled && !dateTo) {
    const err = new Error('Enter a valid end date for when stock was added.');
    err.status = 400;
    throw err;
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    const err = new Error('The end date cannot be earlier than the start date.');
    err.status = 400;
    throw err;
  }
  return { dateFrom, dateTo };
}

function appendRange(parts, params, { dateFrom, dateTo, dateColumn, timestampColumn }) {
  if (dateColumn) {
    if (dateFrom) {
      parts.push(`${dateColumn} >= ?`);
      params.push(dateFrom);
    }
    if (dateTo) {
      parts.push(`${dateColumn} <= ?`);
      params.push(dateTo);
    }
    return;
  }
  if (dateFrom) {
    parts.push(`${timestampColumn} >= ?`);
    params.push(sqlDayStart(dateFrom));
  }
  if (dateTo) {
    parts.push(`${timestampColumn} < ?`);
    params.push(sqlDayEndExclusive(dateTo));
  }
}

/**
 * Current Lot Stock is filtered by when stock was received / added — not
 * expiry, AM/PM count date, or correction time.
 *
 * A lot matches if:
 *  - vaccine_inventory.received_date (DATE) is in range, or
 *  - received_date is missing and created_at falls in the calendar range, or
 *  - a Stock In / Returned Vaccine row for that lot falls in the range
 *    (covers later restocks merged into the same lot).
 *
 * DATETIME bounds are half-open [start, next-day) so the full end date is
 * included without DATE() timezone wrapping.
 */
function stockAddedDateFilterSql({ dateFrom, dateTo }) {
  if (!dateFrom && !dateTo) return { sql: '', params: [] };

  const recParts = [];
  const recParams = [];
  appendRange(recParts, recParams, { dateFrom, dateTo, dateColumn: 'vi.received_date' });

  const createdParts = [];
  const createdParams = [];
  appendRange(createdParts, createdParams, { dateFrom, dateTo, timestampColumn: 'vi.created_at' });

  const txnParts = [];
  const txnParams = [];
  appendRange(txnParts, txnParams, { dateFrom, dateTo, timestampColumn: 'vt.transaction_date' });

  const sql = ` AND (
    (vi.received_date IS NOT NULL AND ${recParts.join(' AND ')})
    OR (
      vi.received_date IS NULL
      AND ${createdParts.join(' AND ')}
    )
    OR EXISTS (
      SELECT 1 FROM vaccine_transactions vt
      WHERE vt.inventory_id = vi.inventory_id
        AND vt.transaction_type IN ('Stock In','Returned Vaccine','Initial Opening Balance')
        AND ${txnParts.join(' AND ')}
    )
  )`;
  return { sql, params: [...recParams, ...createdParams, ...txnParams] };
}

module.exports = {
  parseStockAddedDateRange,
  stockAddedDateFilterSql,
};
