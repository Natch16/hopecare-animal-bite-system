'use strict';

/**
 * Temporary portal-password helpers.
 * The password column stores a bcrypt hash. The cipher exists only so the
 * printed Patient Card can show the same temporary password the patient was given.
 * Never log the plaintext, hash, or cipher, and never place them in SMS.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

/** Case-sensitive clinic temporary password. New accounts and the Patient Card use this exact value. */
const CLINIC_TEMP_PASSWORD = 'hopecare';
const LEGACY_DEFAULT_TEMP = CLINIC_TEMP_PASSWORD;
const TEMP_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function secretKey() {
  return crypto.createHash('sha256')
    .update(process.env.SESSION_SECRET || 'hopecare-session-secret')
    .digest();
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function cipherToBase64(blob) {
  if (blob == null || blob === '') return '';
  const raw = Buffer.isBuffer(blob) ? blob.toString('utf8') : String(blob);
  return raw.trim().replace(/ /g, '+').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
}

function decryptSecret(blob) {
  if (blob == null || blob === '') return null;
  const b64 = cipherToBase64(blob);
  if (!b64) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 29) return null;
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function generateTempPassword(length = 8) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += TEMP_CHARS[bytes[i] % TEMP_CHARS.length];
  return out;
}

function isTempPasswordActive(patient = {}) {
  return Number(patient.is_temp_password) === 1;
}

async function resolveTempPassword(patient = {}) {
  if (!isTempPasswordActive(patient)) return null;
  if (patient.password) {
    try {
      if (await bcrypt.compare(CLINIC_TEMP_PASSWORD, patient.password)) return CLINIC_TEMP_PASSWORD;
    } catch { /* ignore */ }
  }
  if (patient.temp_password_cipher) {
    try {
      const recovered = decryptSecret(patient.temp_password_cipher);
      if (recovered === CLINIC_TEMP_PASSWORD) return CLINIC_TEMP_PASSWORD;
    } catch { /* ignore */ }
  }
  return CLINIC_TEMP_PASSWORD;
}

async function issueTempPassword(db, patientId) {
  const plain = CLINIC_TEMP_PASSWORD;
  const hash = await bcrypt.hash(plain, 10);
  const cipher = encryptSecret(plain);
  const [[patient]] = await db.query(
    'SELECT patient_id, registration_number FROM patients WHERE patient_id = ? LIMIT 1',
    [patientId]
  );
  if (!patient) throw new Error('Patient not found');

  await db.query(
    `UPDATE patients
        SET password = ?, is_temp_password = 1, temp_password_cipher = ?
      WHERE patient_id = ?`,
    [hash, cipher, patientId]
  );
  const { generatePatientId } = require('./idFormats');
  await db.query(
    `INSERT INTO patient_accounts (patient_id, username, password_hash, first_login, account_status)
     VALUES (?, ?, ?, 1, 'Active')
     ON DUPLICATE KEY UPDATE
       password_hash = VALUES(password_hash),
       first_login = 1,
       account_status = 'Active',
       is_locked = 0,
       failed_attempts = 0`,
    [patientId, generatePatientId(patientId), hash]
  );

  return { patientId, plain };
}

function needsPasswordChange(patient = {}, account = {}) {
  return isTempPasswordActive(patient) || Number(account.first_login) === 1;
}

function asHashString(hash) {
  if (hash == null || hash === '') return '';
  return (Buffer.isBuffer(hash) ? hash.toString('utf8') : String(hash)).trim();
}

async function passwordMatches(typed, patient = {}, account = {}) {
  const value = String(typed == null ? '' : typed).trim();
  if (!value) return false;
  const hashes = [patient.password, patient.password_hash, account.password_hash]
    .map(asHashString)
    .filter((hash, index, list) => hash && list.indexOf(hash) === index);
  for (const hash of hashes) {
    try {
      if (await bcrypt.compare(value, hash)) return true;
    } catch { /* ignore invalid hashes */ }
  }
  if (isTempPasswordActive(patient) || Number(account.first_login) === 1) {
    const recovered = await resolveTempPassword(patient);
    if (recovered && value === String(recovered)) return true;
    if (value === CLINIC_TEMP_PASSWORD) return true;
  }
  return false;
}

function omitCredentialFields(record) {
  if (!record || typeof record !== 'object') return record;
  if (Array.isArray(record)) return record.map(omitCredentialFields);
  const copy = { ...record };
  delete copy.password;
  delete copy.password_hash;
  delete copy.temp_password_cipher;
  delete copy.patient_password;
  return copy;
}

async function clearTempPassword(db, patientId) {
  await db.query(
    `UPDATE patients SET is_temp_password = 0, temp_password_cipher = NULL WHERE patient_id = ?`,
    [patientId]
  );
  await db.query(
    `UPDATE patient_accounts SET first_login = 0 WHERE patient_id = ?`,
    [patientId]
  ).catch(() => {});
}

module.exports = {
  CLINIC_TEMP_PASSWORD,
  LEGACY_DEFAULT_TEMP,
  generateTempPassword,
  encryptSecret,
  decryptSecret,
  cipherToBase64,
  isTempPasswordActive,
  needsPasswordChange,
  resolveTempPassword,
  passwordMatches,
  issueTempPassword,
  clearTempPassword,
  omitCredentialFields,
};
