'use strict';

const DEFAULT_PORTAL_PATH = '/patient/patient-login.html';
const PROVIDER_NAME = 'IPROG SMS';
const PROVIDER_CODE = 'iprog';
const OFFICIAL_API_URL = 'https://www.iprogsms.com/api/v1/sms_messages';

function sanitizeApiKey(raw) {
  let key = String(raw == null ? '' : raw).trim();
  if (
    (key.startsWith('"') && key.endsWith('"'))
    || (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  return key.replace(/^App\s+/i, '').trim();
}

function officialApiUrl() {
  return OFFICIAL_API_URL;
}

function envFlag(name, fallback = false) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function inspectPortalUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) {
    return { ok: false, url: '', isLocal: false, reason: 'Patient Portal URL is not configured.' };
  }
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(url);
  if (isLocal) {
    return { ok: false, url, isLocal: true, reason: 'Production SMS cannot use a localhost or development portal URL.' };
  }
  if (!/^https:\/\//i.test(url)) {
    return { ok: false, url, isLocal: false, reason: 'Patient Portal URL must use HTTPS.' };
  }
  return { ok: true, url, isLocal: false, reason: null };
}

function resolveIprogSmsProvider(raw) {
  const n = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
  if (n === 1 || n === 2) return n;
  return 2;
}

function readEnvConfig() {
  return {
    provider: PROVIDER_NAME,
    providerCode: PROVIDER_CODE,
    token: sanitizeApiKey(process.env.IPROG_SMS_API_TOKEN),
    smsProvider: resolveIprogSmsProvider(process.env.IPROG_SMS_PROVIDER),
    senderName: String(process.env.IPROG_SMS_SENDER_NAME || 'IPROGREMIND').trim() || 'IPROGREMIND',
    envEnabled: envFlag('IPROG_SMS_ENABLED', false),
    portalUrl: String(process.env.PATIENT_PORTAL_URL || '').trim(),
    clinicContact: String(process.env.HOPECARE_CONTACT_NUMBER || 'HOPECARE Animal Bite Center').trim(),
    apiUrl: OFFICIAL_API_URL,
  };
}

async function loadSmsSettings(db) {
  const env = readEnvConfig();
  let row = null;
  try {
    const [[found]] = await db.query('SELECT * FROM sms_settings WHERE setting_id = 1 LIMIT 1');
    row = found || null;
  } catch { /* table may not exist yet */ }

  const unusedSeed = row && Number(row.enabled) === 0 && !row.portal_url && !row.clinic_contact;
  const enabled = (!row || unusedSeed) ? env.envEnabled : Number(row.enabled) === 1;
  const portalUrl = (row?.portal_url || env.portalUrl || '').trim();
  const clinicContact = (row?.clinic_contact || env.clinicContact).trim();
  const portal = inspectPortalUrl(portalUrl);

  return {
    provider: PROVIDER_NAME,
    providerCode: PROVIDER_CODE,
    enabled,
    tokenConfigured: Boolean(env.token),
    smsProvider: env.smsProvider,
    senderName: env.senderName,
    portalUrl: portal.url || portalUrl,
    portal,
    clinicContact,
    apiUrl: env.apiUrl,
    token: env.token,
    defaultPortalPath: DEFAULT_PORTAL_PATH,
    lastTestAt: row?.last_test_at || null,
    lastTestOk: row?.last_test_ok == null ? null : Number(row.last_test_ok) === 1,
    lastTestMessage: row?.last_test_message || null,
  };
}

function publicSmsSettings(cfg) {
  let apiStatus = 'Not Configured';
  if (!cfg.tokenConfigured && !cfg.enabled) apiStatus = 'Not Configured';
  else if (cfg.enabled && cfg.tokenConfigured) apiStatus = 'Enabled';
  else if (cfg.enabled && !cfg.tokenConfigured) apiStatus = 'Configuration Error';
  else if (!cfg.enabled) apiStatus = 'Disabled';

  return {
    provider: cfg.provider || PROVIDER_NAME,
    enabled: cfg.enabled,
    api_key_configured: cfg.tokenConfigured,
    token_configured: cfg.tokenConfigured,
    sms_provider: cfg.smsProvider,
    portal_url: cfg.portalUrl,
    portal_ok: cfg.portal.ok,
    portal_warning: cfg.portal.reason,
    clinic_contact: cfg.clinicContact,
    default_portal_path: cfg.defaultPortalPath,
    api_connection: apiStatus,
    status: cfg.enabled ? 'Enabled' : 'Disabled',
    credits_supported: false,
    credits: null,
    last_test_at: cfg.lastTestAt,
    last_test_ok: cfg.lastTestOk,
    last_test_message: cfg.lastTestMessage,
  };
}

module.exports = {
  DEFAULT_PORTAL_PATH,
  OFFICIAL_API_URL,
  PROVIDER_NAME,
  PROVIDER_CODE,
  envFlag,
  inspectPortalUrl,
  resolveIprogSmsProvider,
  sanitizeApiToken: sanitizeApiKey,
  sanitizeApiKey,
  officialApiUrl,
  readEnvConfig,
  loadSmsSettings,
  publicSmsSettings,
};
