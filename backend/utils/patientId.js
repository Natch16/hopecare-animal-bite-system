'use strict';

const { generatePatientId } = require('./idFormats');

const LOCK_NAME = 'hopecare_patient_id';

/**
 * The Patient ID is PAT- plus the patients.patient_id value.
 * New records must use the next number after the highest ID still stored,
 * not MySQL AUTO_INCREMENT, which keeps climbing after deleted test rows.
 */
async function lockPatientIdAllocation(conn) {
  const [rows] = await conn.query('SELECT GET_LOCK(?, 15) AS locked', [LOCK_NAME]);
  if (!rows[0] || Number(rows[0].locked) !== 1) {
    const err = new Error('Could not allocate a Patient ID. Please try again.');
    err.code = 'PATIENT_ID_LOCK';
    throw err;
  }
}

async function unlockPatientIdAllocation(conn) {
  if (!conn) return;
  try {
    await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
  } catch (_) { /* connection is closing */ }
}

async function nextPatientId(conn) {
  const [rows] = await conn.query(
    'SELECT COALESCE(MAX(patient_id), 0) + 1 AS next_id FROM patients'
  );
  const nextId = Number(rows[0] && rows[0].next_id);
  if (!Number.isInteger(nextId) || nextId < 1) {
    throw new Error('Could not allocate a Patient ID.');
  }
  return nextId;
}

module.exports = {
  LOCK_NAME,
  lockPatientIdAllocation,
  unlockPatientIdAllocation,
  nextPatientId,
  generatePatientId,
};
