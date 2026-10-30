'use strict';

const aiClient = require('./groqClient');
const remisAi = require('./remisAi');
const aiAnalysis = require('../services/aiAnalysisService');

function assertSufficient(summary, role) {
  const ok = role === 'Administrator'
    ? remisAi.hasInventoryData(summary) || remisAi.hasCaseData(summary && summary.cases)
    : remisAi.hasCaseData(summary);
  if (!ok) throw aiClient.typedError('insufficient_data');
}

async function interpretOrThrow(summary, role, options = {}) {
  assertSufficient(summary, role);
  return aiAnalysis.interpret({
    context: role === 'Administrator' ? 'admin' : 'nurse',
    payload: role === 'Administrator' ? remisAi.compactAdminPayload(summary) : remisAi.compactNursePayload(summary),
    periodStart: options.periodStart || null,
    periodEnd: options.periodEnd || null,
    runner: () => remisAi.interpretWithAi(summary, role),
  });
}

async function interpretGeo(payload, options = {}) {
  const fallback = remisAi.fallbackGeoReport(payload);
  if (options.allowAi !== true) {
    return { ...fallback, status: 'statistical', cached: false, aiCalled: false };
  }
  try {
    if (!remisAi.hasCaseData(payload)) throw aiClient.typedError('insufficient_data');
    const result = await aiAnalysis.interpret({
      context: 'geo',
      payload,
      periodStart: options.periodStart || null,
      periodEnd: options.periodEnd || null,
      runner: () => remisAi.interpretGeoReport(payload),
    });
    return { ...result, summarySource: aiClient.PROVIDER };
  } catch (err) {
    return {
      ...fallback,
      status: err.code === 'rate_limit' ? 'rate_limited' : err.code || 'api_error',
      cached: false,
      aiCalled: false,
      error: err,
    };
  }
}

function failureBody(err, extra = {}) {
  const code = err && err.code ? err.code : 'api_error';
  return {
    success: false,
    aiAvailable: false,
    status: code === 'rate_limit' ? 'rate_limited' : code,
    errorCode: aiClient.publicErrorCode(code),
    message: aiClient.publicMessage(code),
    retryable: !['missing_key', 'invalid_key', 'insufficient_data'].includes(code),
    fallbackAvailable: true,
    ...extra,
  };
}

module.exports = {
  interpretOrThrow,
  interpretGeo,
  failureBody,
};
