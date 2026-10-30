'use strict';

const { getStockLevel, getExpiryStatus } = require('./inventoryHelpers');

function toYmd(v) {
  if (!v) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const dt = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(dt.getTime())) return null;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayYmd(now = new Date()) {
  return toYmd(now);
}

function qtyOf(lot) {
  return Number(lot && lot.quantity) || 0;
}

function isExpiredLot(lot, today = todayYmd()) {
  const exp = toYmd(lot && lot.expiry_date);
  if (!exp || !today) return false;
  return exp < today;
}

const MANUAL_STATUSES = new Set(['Quarantined', 'Disposed', 'Returned']);

/**
 * Depleted = remaining 0 from use. Expired = past expiry with leftover (or marked expired).
 * Zero remaining is never classified as Expired solely because the date passed.
 */
function deriveLotStatus(lot, today = todayYmd()) {
  const explicit = String((lot && (lot.lot_status || lot.status)) || '').trim();
  if (MANUAL_STATUSES.has(explicit)) return explicit;
  if (qtyOf(lot) <= 0) return 'Depleted';
  // Expired is calculated from the stored expiry date. A previous Expired
  // label must not hide stock after that date is corrected to the future.
  if (isExpiredLot(lot, today)) return 'Expired';
  const exp = getExpiryStatus(lot && lot.expiry_date, today);
  if (exp.class === 'exp-7' || exp.class === 'exp-15' || exp.class === 'exp-30') return 'Expiring Soon';
  const stock = getStockLevel(qtyOf(lot), lot && lot.low_stock_threshold, lot && lot.critical_stock_threshold);
  if (stock.class === 'stock-out') return 'Out of Stock';
  if (stock.class === 'stock-low' || stock.class === 'stock-critical') return 'Low Stock';
  return 'Available';
}

function isUsableLot(lot, today = todayYmd()) {
  const status = deriveLotStatus(lot, today);
  if (MANUAL_STATUSES.has(status) || status === 'Expired' || status === 'Depleted' || status === 'Out of Stock') {
    return false;
  }
  return qtyOf(lot) > 0 && !isExpiredLot(lot, today);
}

function usableQuantity(lot, today = todayYmd()) {
  return isUsableLot(lot, today) ? qtyOf(lot) : 0;
}

function enrichLot(lot, today = todayYmd()) {
  const received = Number(lot.received_quantity);
  const used = Number(lot.used_quantity);
  const remaining = qtyOf(lot);
  const receivedQty = Number.isFinite(received) && received > 0 ? received : remaining + (Number.isFinite(used) ? used : 0);
  const usedQty = Number.isFinite(used) ? used : Math.max(0, receivedQty - remaining);
  const batch_status = deriveLotStatus({ ...lot, quantity: remaining }, today);
  return {
    ...lot,
    received_quantity: receivedQty,
    used_quantity: usedQty,
    remaining_quantity: remaining,
    batch_status,
    usable: isUsableLot({ ...lot, quantity: remaining, lot_status: lot.lot_status }, today),
    usable_quantity: usableQuantity({ ...lot, quantity: remaining, lot_status: lot.lot_status }, today),
  };
}

function normalizeBatch(value) {
  return String(value || '').trim().toLowerCase();
}

function lotIdentity(lot) {
  return [
    Number(lot && lot.vaccine_id) || 0,
    toYmd(lot && lot.expiry_date) || '',
    normalizeBatch(lot && lot.batch_number),
  ].join('::');
}

function lotsMatch(a, b) {
  if (!a || !b) return false;
  return lotIdentity(a) === lotIdentity(b);
}

function canMergeIntoLot(lot, incoming = null, today = todayYmd()) {
  if (!lot) return false;
  if (incoming != null && (typeof incoming === 'string' || incoming instanceof Date) && arguments.length < 3) {
    today = typeof incoming === 'string' ? incoming : todayYmd(incoming);
    incoming = null;
  }
  if (!isUsableLot(lot, today)) return false;
  if (incoming && !lotsMatch(lot, incoming)) return false;
  return true;
}

function groupLotsForDisplay(rows, today = todayYmd()) {
  const map = new Map();
  for (const raw of rows || []) {
    const lot = enrichLot(raw, today);
    const key = lotIdentity(lot);
    const cur = map.get(key);
    if (!cur) {
      map.set(key, {
        ...lot,
        inventory_ids: [lot.inventory_id],
      });
      continue;
    }
    cur.quantity = Number(cur.quantity || 0) + Number(lot.quantity || 0);
    cur.received_quantity = Number(cur.received_quantity || 0) + Number(lot.received_quantity || 0);
    cur.used_quantity = Number(cur.used_quantity || 0) + Number(lot.used_quantity || 0);
    cur.remaining_quantity = Number(cur.remaining_quantity || 0) + Number(lot.remaining_quantity || 0);
    cur.usable_quantity = Number(cur.usable_quantity || 0) + Number(lot.usable_quantity || 0);
    cur.inventory_ids.push(lot.inventory_id);
    if (Number(lot.inventory_id) < Number(cur.inventory_id)) cur.inventory_id = lot.inventory_id;
  }
  return [...map.values()].map((lot) => {
    const batch_status = deriveLotStatus(lot, today);
    const next = { ...lot, batch_status };
    return {
      ...next,
      usable: isUsableLot(next, today),
      usable_quantity: usableQuantity(next, today),
    };
  });
}

async function persistLotQuantity(conn, lot, newQty, { usedDelta = 0, forceStatus = null } = {}) {
  const remaining = Math.max(0, Number(newQty) || 0);
  const usedDeltaN = Number(usedDelta) || 0;
  const prevUsed = Number(lot.used_quantity) || 0;
  const used = Math.max(0, prevUsed + (usedDeltaN > 0 ? usedDeltaN : 0));
  const prevReceived = Number(lot.received_quantity);
  const received = Number.isFinite(prevReceived) && prevReceived > 0
    ? Math.max(prevReceived, remaining + used)
    : remaining + used;
  const next = {
    ...lot,
    quantity: remaining,
    used_quantity: used,
    received_quantity: received,
    lot_status: forceStatus || lot.lot_status,
  };
  const status = forceStatus || deriveLotStatus(next);
  try {
    await conn.query(
      `UPDATE vaccine_inventory
       SET quantity = ?, used_quantity = ?, received_quantity = ?, lot_status = ?
       WHERE inventory_id = ?`,
      [remaining, used, received, status, lot.inventory_id]
    );
  } catch (_) {
    await conn.query(
      `UPDATE vaccine_inventory SET quantity = ? WHERE inventory_id = ?`,
      [remaining, lot.inventory_id]
    );
  }
  return { remaining, used, received, status };
}

function usableSqlFilter() {
  return `(quantity > 0
    AND (lot_status IS NULL OR lot_status IN ('Available','Low Stock','Expiring Soon',''))
    AND (expiry_date IS NULL OR expiry_date >= CURDATE()))`;
}

module.exports = {
  toYmd,
  todayYmd,
  isExpiredLot,
  deriveLotStatus,
  isUsableLot,
  usableQuantity,
  enrichLot,
  canMergeIntoLot,
  persistLotQuantity,
  usableSqlFilter,
  normalizeBatch,
  lotIdentity,
  lotsMatch,
  groupLotsForDisplay,
};
