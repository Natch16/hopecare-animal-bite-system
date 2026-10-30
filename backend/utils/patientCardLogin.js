'use strict';

const QRCode = require('qrcode');
const { readPatientPortalUrl } = require('./patientPortalUrl');
const { generatePatientId } = require('./idFormats');
const { isTempPasswordActive, CLINIC_TEMP_PASSWORD } = require('./patientTempPassword');

const LOGIN_TITLE = 'PATIENT ACCOUNT LOGIN GUIDE';

const LOGIN_STEPS = [
  'Open your web browser and go to the HopeCare Patient Portal.',
  'Enter your Patient ID as your username.',
  'Enter your temporary password.',
  'Click Sign In. On your first login you will be prompted to change your password. Choose a new password you can remember.',
  'After logging in, you can view your vaccination schedule, upcoming dose dates, treatment history, and exposure records.',
  'If you forget your password, contact HopeCare Animal Bite Center at 0964-890-1339 so staff can reset it.',
];

function patientCardLoginView({
  patientIdDisplay, portalUrl, temporaryPassword, passwordChangeCompleted, qrCode,
}) {
  const completed = Boolean(passwordChangeCompleted);
  return {
    title: LOGIN_TITLE,
    patient_id: patientIdDisplay,
    portal_url: portalUrl,
    temporary_password: completed ? null : (temporaryPassword === CLINIC_TEMP_PASSWORD ? CLINIC_TEMP_PASSWORD : null),
    password_change_completed: completed,
    qr_code: qrCode || null,
    steps: LOGIN_STEPS.slice(),
  };
}

/** QR image for the same portal address printed in Step 1. */
async function portalQrDataUrl(url) {
  return QRCode.toDataURL(String(url), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 256,
    color: { dark: '#111111', light: '#ffffff' },
  });
}

/**
 * Login guide for the printed Patient Card.
 * The portal address is PATIENT_PORTAL_URL. The temporary password is the one
 * stored for this patient, and it is omitted after the patient changes it.
 */
async function loadPatientCardLogin(db, patientId) {
  const portal = readPatientPortalUrl();
  if (!portal.ok) return { ok: false, status: 503, message: portal.message };

  const [[row]] = await db.query(
    `SELECT patient_id, is_temp_password, temp_password_cipher, password
       FROM patients WHERE patient_id = ? LIMIT 1`,
    [patientId]
  );
  if (!row) return { ok: false, status: 404, message: 'Patient not found.' };

  const active = isTempPasswordActive(row);
  const qrCode = await portalQrDataUrl(portal.url);
  return {
    ok: true,
    data: patientCardLoginView({
      patientIdDisplay: generatePatientId(row.patient_id),
      portalUrl: portal.url,
      temporaryPassword: active ? CLINIC_TEMP_PASSWORD : null,
      passwordChangeCompleted: !active,
      qrCode,
    }),
  };
}

module.exports = {
  LOGIN_TITLE,
  LOGIN_STEPS,
  patientCardLoginView,
  portalQrDataUrl,
  loadPatientCardLogin,
};
