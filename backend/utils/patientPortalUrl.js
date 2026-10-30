'use strict';

const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

const MISSING_MESSAGE =
  'PATIENT_PORTAL_URL is not configured. Set it in the backend environment before printing a patient card.';
const INVALID_MESSAGE =
  'PATIENT_PORTAL_URL is not a valid URL. Update the backend environment before printing a patient card.';
const LOCAL_MESSAGE =
  'PATIENT_PORTAL_URL cannot be a localhost or development URL. Set the official patient portal URL in the backend environment.';

/**
 * The official patient portal address printed on the patient card.
 * Reads only PATIENT_PORTAL_URL. There is no localhost fallback.
 */
function readPatientPortalUrl(env = process.env) {
  const raw = String(env.PATIENT_PORTAL_URL == null ? '' : env.PATIENT_PORTAL_URL).trim();
  if (!raw) return { ok: false, url: '', message: MISSING_MESSAGE };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, url: '', message: INVALID_MESSAGE };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, url: '', message: INVALID_MESSAGE };
  }

  const host = String(parsed.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || BLOCKED_HOSTS.has(host)) {
    return { ok: false, url: '', message: LOCAL_MESSAGE };
  }

  return { ok: true, url: raw, message: null };
}

module.exports = {
  readPatientPortalUrl,
  MISSING_MESSAGE,
  INVALID_MESSAGE,
  LOCAL_MESSAGE,
};
