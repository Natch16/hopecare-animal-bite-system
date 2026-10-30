'use strict';

/**
 * Central AI (Groq) access for REMIS.
 * Every explicit "Generate AI Analysis" request produces a fresh interpretation.
 * Identical requests that arrive while one is still running share that single call,
 * so double-clicks or parallel tabs never multiply provider requests.
 * Successful results are recorded in ai_analysis_cache as a generation history only.
 */

const crypto = require('crypto');
const aiClient = require('../utils/groqClient');

const inflight = new Map();

function stableStringify(value) {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashSnapshot(snapshot) {
  return crypto.createHash('sha256').update(stableStringify(snapshot || {})).digest('hex');
}

function logEvent(fields) {
  const safe = {
    ts: new Date().toISOString(),
    provider: aiClient.PROVIDER,
    model: aiClient.getActiveModel(),
    context: fields.context || 'unknown',
    status: fields.status || 'ok',
    ms: fields.ms != null ? fields.ms : undefined,
    errorType: fields.errorType || undefined,
    hash: fields.hash ? String(fields.hash).slice(0, 12) : undefined,
  };
  console.log('[aiAnalysis]', JSON.stringify(safe));
}

async function recordHistory(entry) {
  try {
    const pool = require('../config/database').pool;
    await pool.query(
      `INSERT INTO ai_analysis_cache
        (context, period_start, period_end, data_hash, ai_response, generated_at, expires_at, model, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.context,
        entry.periodStart || null,
        entry.periodEnd || null,
        entry.hash,
        JSON.stringify(entry.response || {}),
        new Date(entry.generatedAt),
        new Date(entry.generatedAt),
        aiClient.getActiveModel(),
        'ok',
      ]
    );
  } catch (err) {
    console.warn('[aiAnalysis] history write skipped:', err.message);
  }
}

async function interpret({
  context,
  payload,
  periodStart = null,
  periodEnd = null,
  runner,
  allowAi = true,
} = {}) {
  if (!allowAi) return null;
  const dataHash = hashSnapshot({ context, payload });

  if (inflight.has(dataHash)) {
    logEvent({ context, status: 'coalesced', hash: dataHash });
    return inflight.get(dataHash);
  }

  const job = (async () => {
    const t0 = Date.now();
    try {
      if (!aiClient.isConfigured()) throw aiClient.typedError('missing_key');
      const result = await runner();
      const generatedAt = Date.now();
      const response = {
        insights: result.insights || [],
        recommendations: result.recommendations || [],
        trendExplanation: result.trendExplanation || '',
        forecastInterpretation: result.forecastInterpretation || '',
        riskAreas: result.riskAreas || [],
        ...(result.riskAlerts ? { riskAlerts: result.riskAlerts } : {}),
        ...(result.recommendationDetails ? { recommendationDetails: result.recommendationDetails } : {}),
        ...(result.removedStatements != null ? { removedStatements: result.removedStatements } : {}),
        inventoryInsights: result.inventoryInsights || [],
        limitations: result.limitations || '',
        summary: result.summary || '',
        source: aiClient.PROVIDER,
      };
      await recordHistory({ hash: dataHash, context, periodStart, periodEnd, response, generatedAt });
      logEvent({ context, status: 'ok', ms: Date.now() - t0, hash: dataHash });
      return {
        ...response,
        cached: false,
        status: 'ok',
        aiCalled: true,
        model: aiClient.getActiveModel(),
        generatedAt: new Date(generatedAt).toISOString(),
      };
    } catch (err) {
      if (!err.code) err.code = aiClient.classifyError(err);
      aiClient.logFailure(err);
      logEvent({ context, status: 'error', ms: Date.now() - t0, hash: dataHash, errorType: err.code });
      throw err;
    }
  })();

  inflight.set(dataHash, job);
  try {
    return await job;
  } finally {
    inflight.delete(dataHash);
  }
}

function _resetForTests() {
  inflight.clear();
}

module.exports = {
  hashSnapshot,
  interpret,
  _resetForTests,
};
