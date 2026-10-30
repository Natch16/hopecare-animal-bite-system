'use strict';

/**
 * Server-side Groq client for REMIS.
 * The API key is read only from backend/.env (GROQ_API_KEY) and never leaves the server.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PROVIDER = 'groq';
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const MODELS = [MODEL, ...String(process.env.GROQ_FALLBACK_MODELS || 'qwen/qwen3.8-27b,openai/gpt-oss-20b').split(',')]
  .map((m) => m.trim())
  .filter((m, i, arr) => m && arr.indexOf(m) === i);
let activeModel = MODEL;
const TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS || 30000);
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = Number(process.env.GROQ_RETRY_DELAY_MS || 1500);
const MAX_TOKENS = Number(process.env.GROQ_MAX_TOKENS || 1500);

const PUBLIC_MESSAGES = {
  missing_key: 'AI analysis is not configured on the server. Statistical insights are still available.',
  invalid_key: 'AI analysis is not configured correctly on the server. Statistical insights are still available.',
  model_unavailable: 'The AI model is currently unavailable. Statistical insights are still available.',
  rate_limit: 'AI analysis is temporarily unavailable because the AI request limit has been reached. Please try again shortly. Statistical insights are still available.',
  quota: 'AI analysis is unavailable because the AI usage quota has been reached. Statistical insights are still available.',
  timeout: 'The AI service took too long to respond. Please try again. Statistical insights are still available.',
  network: 'Unable to connect to the AI service. Please try again. Statistical insights are still available.',
  server_error: 'AI analysis is temporarily unavailable. Statistical insights are still available.',
  invalid_response: 'The AI service returned an unusable response. Please try again. Statistical insights are still available.',
  insufficient_data: 'Not enough recorded data in the selected period for AI interpretation. Statistical insights are still available.',
  api_error: 'AI analysis is temporarily unavailable. Statistical insights are still available.',
};

const ERROR_CODES = {
  missing_key: 'AI_NOT_CONFIGURED',
  invalid_key: 'AI_INVALID_KEY',
  model_unavailable: 'AI_MODEL_UNAVAILABLE',
  rate_limit: 'AI_RATE_LIMIT',
  quota: 'AI_QUOTA_EXCEEDED',
  timeout: 'AI_TIMEOUT',
  network: 'AI_NETWORK_ERROR',
  server_error: 'AI_SERVER_ERROR',
  invalid_response: 'AI_INVALID_RESPONSE',
  insufficient_data: 'AI_INSUFFICIENT_DATA',
  api_error: 'AI_API_ERROR',
};

let client = null;
let clientKey = null;

function getApiKey() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  return String(process.env.GROQ_API_KEY || '').trim();
}

function isConfigured() {
  return Boolean(getApiKey());
}

function publicMessage(code) {
  return PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.api_error;
}

function publicErrorCode(code) {
  return ERROR_CODES[code] || ERROR_CODES.api_error;
}

function httpStatusFor(code) {
  if (code === 'rate_limit' || code === 'quota') return 429;
  if (code === 'timeout') return 504;
  if (code === 'invalid_response') return 502;
  if (code === 'insufficient_data') return 422;
  return 503;
}

function getClient() {
  const key = getApiKey();
  if (!key) {
    client = null;
    return null;
  }
  if (client && clientKey === key) return client;
  const Groq = require('groq-sdk');
  const Ctor = Groq.default || Groq;
  client = new Ctor({ apiKey: key, timeout: TIMEOUT_MS, maxRetries: 0 });
  clientKey = key;
  return client;
}

function errorBody(err) {
  const body = err && err.error;
  return (body && body.error) || body || {};
}

function classifyError(err) {
  if (!getApiKey()) return 'missing_key';
  if (err && err.code && ERROR_CODES[err.code]) return err.code;
  const status = err && (err.status || err.statusCode);
  const body = errorBody(err);
  const apiCode = String(body.code || '');
  const msg = `${String(err && err.message ? err.message : err || '')} ${body.message || ''}`;
  const name = String(err && err.name ? err.name : (err && err.constructor && err.constructor.name) || '');

  if (status === 401 || apiCode === 'invalid_api_key' || /invalid api key/i.test(msg)) return 'invalid_key';
  if (status === 403 && /organization|restricted|blocked/i.test(msg)) return 'quota';
  if (status === 403) return 'invalid_key';
  if (status === 429) {
    return /per day|\(TPD\)|\(RPD\)|quota|billing|organization/i.test(msg) ? 'quota' : 'rate_limit';
  }
  if (status === 404 || /model_not_found|model_decommissioned|does not exist|decommissioned/i.test(`${apiCode} ${msg}`)) return 'model_unavailable';
  if (status === 400 && /json_validate_failed|failed_generation/i.test(`${apiCode} ${msg}`)) return 'invalid_response';
  if (/Timeout/i.test(name) || /timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(msg)) return 'timeout';
  if (/ConnectionError/i.test(name) || /ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|Connection error/i.test(msg)) return 'network';
  if (status === 503 || status === 502 || status === 500 || (status >= 500 && status < 600)) return 'server_error';
  if (/invalid_response/i.test(msg)) return 'invalid_response';
  return 'api_error';
}

function isRetryable(err) {
  return Boolean(err) && err.code === 'server_error';
}

function logFailure(err) {
  const code = err && err.code ? err.code : classifyError(err);
  const msg = String(err && err.message ? err.message : err || 'unknown error');
  const safe = msg.replace(/gsk_[A-Za-z0-9]+/g, 'gsk_[redacted]');
  console.error('[groq]', publicErrorCode(code), err && err.status ? `http=${err.status}` : '', safe.slice(0, 500));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function typedError(code, message) {
  const err = new Error(message || publicMessage(code));
  err.code = code;
  return err;
}

async function chat(messages, { json = false } = {}) {
  const groq = getClient();
  if (!groq) throw typedError('missing_key');

  let lastErr = null;
  const order = [activeModel, ...MODELS.filter((m) => m !== activeModel)];
  for (const model of order) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const completion = await groq.chat.completions.create({
          model,
          messages,
          temperature: 0.2,
          max_tokens: MAX_TOKENS,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        });
        const text = String(completion?.choices?.[0]?.message?.content || '').trim();
        if (!text) throw typedError('invalid_response', 'AI returned an empty response');
        if (model !== activeModel) {
          console.warn(`[groq] model ${activeModel} unavailable; using ${model}`);
          activeModel = model;
        }
        return text;
      } catch (err) {
        err.code = classifyError(err);
        lastErr = err;
        if (isRetryable(err) && attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        if (err.code === 'model_unavailable') break;
        throw err;
      }
    }
  }
  throw lastErr || typedError('api_error');
}

function parseJsonSafe(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  try {
    return JSON.parse(text);
  } catch (_) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch (__) { return null; }
    }
    return null;
  }
}

async function generateText(prompt, systemInstruction) {
  const messages = [];
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
  messages.push({ role: 'user', content: prompt });
  return chat(messages);
}

async function generateJson(prompt, systemInstruction) {
  const messages = [
    { role: 'system', content: `${systemInstruction || ''}\nRespond with a single valid JSON object only.`.trim() },
    { role: 'user', content: prompt },
  ];
  const text = await chat(messages, { json: true });
  const parsed = parseJsonSafe(text);
  const obj = Array.isArray(parsed) ? { insights: parsed } : parsed;
  if (obj && typeof obj === 'object') return obj;
  throw typedError('invalid_response', 'AI returned an invalid response');
}

function getActiveModel() {
  return activeModel;
}

function status() {
  const configured = isConfigured();
  return {
    configured,
    provider: PROVIDER,
    label: configured ? 'AI (Groq): Configured' : 'AI (Groq): Not Configured',
    model: activeModel,
    fallbackModels: MODELS.slice(1),
    errorCode: configured ? null : ERROR_CODES.missing_key,
    message: configured ? null : publicMessage('missing_key'),
  };
}

async function ping() {
  if (!isConfigured()) throw typedError('missing_key');
  const text = await generateText('Reply with the single word OK.');
  if (!/ok/i.test(text)) throw typedError('invalid_response');
  return { ok: true, model: activeModel };
}

module.exports = {
  PROVIDER,
  MODEL,
  getActiveModel,
  isConfigured,
  isRetryable,
  generateText,
  generateJson,
  parseJsonSafe,
  classifyError,
  publicMessage,
  publicErrorCode,
  httpStatusFor,
  logFailure,
  status,
  ping,
  typedError,
};
