'use strict';

const { generateStaffId } = require('./idFormats');
const { getStaffFromSession } = require('../middleware/auth');
const { getCurrentShift, normalizeShift } = require('./shiftHelper');
const { isUsableLot, persistLotQuantity } = require('./inventoryBatches');

const NAME_ALIASES = {
  TT: ['TT', 'Tetanus Toxoid', 'Tetanus-Toxoid'],
  ATS: ['ATS'],
  HTIG: ['HTIG'],
};

async function resolveVaccine(conn, vaccineName) {
  const name = String(vaccineName || '').trim();
  if (!name) return null;
  const aliases = NAME_ALIASES[name] || [name];
  const [[vax]] = await conn.query(
    `SELECT vaccine_id, name FROM vaccines
     WHERE LOWER(name) IN (${aliases.map(() => 'LOWER(?)').join(',')})
     ORDER BY vaccine_id ASC LIMIT 1`,
    aliases
  );
  return vax || null;
}

function staffFromReq(req) {
  const s = getStaffFromSession(req);
  return {
    ...s,
    staff_id_display: s.staff_id ? generateStaffId(s.staff_id, s.role) : null,
  };
}

/**
 * Deduct treatment usage from live lots (FIFO by expiry) without failing the patient save.
 * Idempotent per patient + usage key so edits do not double-count.
 */
async function deductNamedVaccine(conn, {
  vaccineName, quantity = 1, patientId, usageKey, staff, shift, remarks, record_date,
}) {
  const qty = Number(quantity) || 0;
  if (!vaccineName || qty <= 0 || !patientId) return;

  const noteKey = `usage:${usageKey}`;
  const [[dup]] = await conn.query(
    `SELECT transaction_id FROM vaccine_transactions
     WHERE patient_id = ? AND notes = ? LIMIT 1`,
    [patientId, noteKey]
  ).catch(() => [[]]);
  if (dup) return;

  const vax = await resolveVaccine(conn, vaccineName);
  if (!vax) return;

  const [lots] = await conn.query(
    `SELECT * FROM vaccine_inventory
     WHERE vaccine_id = ? AND quantity > 0
     ORDER BY (expiry_date IS NULL), expiry_date ASC, inventory_id ASC`,
    [vax.vaccine_id]
  );

  let remainingToTake = qty;
  let lotId = null;
  let expiry = null;

  const beginning = (lots || []).reduce((s, l) => s + (isUsableLot(l) ? Number(l.quantity) || 0 : 0), 0);

  for (const lot of lots || []) {
    if (remainingToTake <= 0) break;
    if (!isUsableLot(lot)) continue;
    const take = Math.min(Number(lot.quantity) || 0, remainingToTake);
    if (take <= 0) continue;
    await persistLotQuantity(conn, lot, Number(lot.quantity) - take, { usedDelta: take });
    remainingToTake -= take;
    lotId = lot.inventory_id;
    expiry = lot.expiry_date;
  }

  const [[sumAfter]] = await conn.query(
    `SELECT COALESCE(SUM(quantity),0) AS qty FROM vaccine_inventory WHERE vaccine_id = ?`,
    [vax.vaccine_id]
  );
  const ending = Number(sumAfter.qty) || 0;

  const recShift = normalizeShift(shift || getCurrentShift());
  await conn.query(
    `INSERT INTO vaccine_transactions
       (inventory_id, vaccine_id, transaction_type, quantity, staff_id, staff_name,
        staff_id_display, shift, patient_id, notes, remarks, beginning_stock, remaining_stock, expiration_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      lotId, vax.vaccine_id, 'Vaccine Usage', qty,
      staff.staff_id || null, staff.full_name || null, staff.staff_id_display || null,
      recShift, patientId, noteKey, remarks || `Patient treatment: ${vax.name}`,
      beginning, ending, expiry || null,
    ]
  ).catch(async () => {
    await conn.query(
      `INSERT INTO vaccine_transactions
         (inventory_id, vaccine_id, transaction_type, quantity, staff_id, staff_name,
          staff_id_display, shift, patient_id, notes, remarks)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        lotId, vax.vaccine_id, 'Vaccine Usage', qty,
        staff.staff_id || null, staff.full_name || null, staff.staff_id_display || null,
        recShift, patientId, noteKey, remarks || `Patient treatment: ${vax.name}`,
      ]
    );
  });
}

/**
 * Clinical treatment records (new patient, new case, PEP doses, RIG, tetanus)
 * are stored independently of Admin vaccine inventory.
 *
 * Stock quantities, AM/PM sheet usage, and inventory history must change only
 * through authorized Admin inventory workflows (stock in/out, usage, adjustment).
 * These helpers remain as no-ops so leftover clinical call sites cannot deduct stock.
 */
async function applyTreatmentInventoryUsage() {
  return;
}

async function applyTreatmentInventoryUsageFromReq() {
  return;
}

module.exports = {
  applyTreatmentInventoryUsage,
  applyTreatmentInventoryUsageFromReq,
  deductNamedVaccine,
};
