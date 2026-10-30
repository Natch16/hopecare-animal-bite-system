'use strict';

/**
 * IPROG SMS transport. The API token stays on the backend.
 * Never log the token, request body, or Authorization material.
 *
 * Documented send contract:
 * POST https://www.iprogsms.com/api/v1/sms_messages
 * Content-Type: application/json
 * Body: { api_token, phone_number, message, sms_provider }
 * sms_provider 2 sends the API message only. Provider 0 wraps the
 * IPROG account header/footer sample and must not be used.
 */
const { normalizePhMobile } = require('../utils/phonePh');
const { loadSmsSettings, resolveIprogSmsProvider } = require('../utils/smsConfig');
const { smsForPatient } = require('../utils/smsTemplates');

const SEND_TIMEOUT_MS = 15000;
const OFFICIAL_API_URL = 'https://www.iprogsms.com/api/v1/sms_messages';
const PROVIDER = 'iprog';
const SMS_PROVIDER = 2;

function isOfficialIprogUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    return parsed.protocol === 'https:'
      && parsed.hostname === 'www.iprogsms.com'
      && parsed.pathname === '/api/v1/sms_messages';
  } catch {
    return false;
  }
}

const REMINDER_SENDER = 'IPROGREMIND';

function iprogMessageText(message) {
  if (Array.isArray(message)) return message.map((item) => String(item)).join(' ');
  if (message == null) return null;
  return String(message);
}

function buildIprogPayload(token, phone, message, smsProvider, senderName) {
  const sender = String(senderName || REMINDER_SENDER).trim() || REMINDER_SENDER;
  return {
    api_token: token,
    phone_number: phone,
    message,
    sms_provider: resolveIprogSmsProvider(smsProvider),
    sender_name: sender,
  };
}

function parseIprogResponse(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { accepted: false, invalid: true, messageId: null, apiMessage: null, statusCode: null };
  }
  const statusCode = Number(parsed.status);
  const messageId = parsed.message_id ? String(parsed.message_id) : null;
  const apiMessage = iprogMessageText(parsed.message);
  const accepted = statusCode === 200 && Boolean(messageId);
  return {
    accepted,
    invalid: !accepted && !apiMessage,
    messageId,
    apiMessage,
    statusCode: Number.isFinite(statusCode) ? statusCode : null,
  };
}

function sanitizeProviderMessage(text, token) {
  let safe = String(text || '').replace(/\s+/g, ' ').trim();
  if (token) safe = safe.split(token).join('[redacted]');
  return safe.slice(0, 240);
}

function classifyIprogFailure(httpStatus, parsed, token) {
  const apiMessage = sanitizeProviderMessage(parsed?.apiMessage || '', token).toLowerCase();
  if (/credit|balance|insufficient/.test(apiMessage)) {
    return { code: 'credits', error: 'IPROG SMS reported insufficient credits.' };
  }
  if (/shared sender|sender name|smart\/tnt/.test(apiMessage)) {
    return {
      code: 'sender_name',
      error: 'This mobile network does not accept IPROG\'s shared sender name. Vaccination reminders must use the IPROGREMIND sender.',
    };
  }
  if (httpStatus === 401 || httpStatus === 403 || /token|unauthor|forbidden|invalid api/.test(apiMessage)) {
    return { code: 'auth', error: 'IPROG SMS rejected the API token. Configure a valid token in the backend .env file.' };
  }
  if (parsed?.invalid || (httpStatus === 200 && !parsed?.accepted && !parsed?.apiMessage)) {
    return { code: 'invalid_response', error: 'IPROG SMS returned an invalid response.' };
  }
  if (httpStatus >= 500) {
    return { code: 'unavailable', error: 'IPROG SMS is temporarily unavailable.' };
  }
  if (httpStatus && httpStatus !== 200) {
    return { code: 'api_error', error: 'IPROG SMS did not accept the message.' };
  }
  return { code: 'rejected', error: 'IPROG SMS did not accept the message.' };
}

function safeApiError(httpStatus, parsed, token) {
  return classifyIprogFailure(httpStatus, parsed, token).error;
}

function failureResult(extra) {
  return {
    success: false,
    ok: false,
    provider: PROVIDER,
    delivered: false,
    ...extra,
    error: extra.error || extra.reason,
    reason: extra.reason || extra.error,
  };
}

async function postJson(url, body, timeoutMs = SEND_TIMEOUT_MS) {
  if (typeof fetch !== 'function') {
    throw new Error('HTTP client is not available.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    return { httpStatus: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function sendSms(db, { recipient, message, patientName } = {}) {
  const cfg = await loadSmsSettings(db);
  if (!cfg.enabled) {
    return failureResult({
      skipped: true,
      status: 'Skipped',
      code: 'disabled',
      reason: 'SMS integration is disabled.',
    });
  }
  if (!cfg.tokenConfigured) {
    return failureResult({
      skipped: true,
      status: 'Skipped',
      code: 'missing_token',
      reason: 'IPROG SMS API token is not configured on the server.',
    });
  }

  const phone = normalizePhMobile(recipient);
  if (!phone) {
    return failureResult({
      skipped: true,
      status: 'Skipped',
      code: 'invalid_phone',
      reason: 'Invalid or missing Philippine mobile number.',
    });
  }

  const text = smsForPatient(message, patientName);
  if (!text) {
    return failureResult({
      skipped: true,
      status: 'Skipped',
      code: 'empty_message',
      reason: 'SMS text is empty.',
    });
  }

  const url = cfg.apiUrl;
  if (!isOfficialIprogUrl(url)) {
    return failureResult({
      skipped: true,
      status: 'Skipped',
      code: 'invalid_endpoint',
      reason: 'IPROG SMS endpoint is not the documented /api/v1/sms_messages URL.',
    });
  }

  const payload = buildIprogPayload(cfg.token, phone, text, cfg.smsProvider, cfg.senderName);

  try {
    const { httpStatus, text: bodyText } = await postJson(url, payload);
    const parsed = parseIprogResponse(bodyText);

    if (httpStatus !== 200 || !parsed.accepted) {
      const classified = classifyIprogFailure(httpStatus, parsed, cfg.token);
      return failureResult({
        skipped: false,
        status: 'Failed',
        code: classified.code,
        errorKind: classified.code,
        reason: classified.error,
        httpStatus,
        apiStatus: parsed.statusCode != null ? String(parsed.statusCode) : null,
        apiMessage: sanitizeProviderMessage(parsed.apiMessage, cfg.token) || null,
      });
    }

    return {
      success: true,
      ok: true,
      skipped: false,
      status: 'Sent',
      provider: PROVIDER,
      messageId: parsed.messageId,
      message: sanitizeProviderMessage(parsed.apiMessage, cfg.token),
      httpStatus,
      apiStatus: '200',
      delivered: false,
    };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return failureResult({
      skipped: false,
      status: 'Failed',
      code: aborted ? 'timeout' : 'network',
      errorKind: aborted ? 'timeout' : 'network',
      reason: aborted ? 'IPROG SMS request timed out.' : 'Could not reach IPROG SMS.',
    });
  }
}

module.exports = {
  SEND_TIMEOUT_MS,
  OFFICIAL_API_URL,
  PROVIDER,
  SMS_PROVIDER,
  REMINDER_SENDER,
  isOfficialIprogUrl,
  buildIprogPayload,
  parseIprogResponse,
  classifyIprogFailure,
  safeApiError,
  sendSms,
};
