'use strict';

/**
 * Admin AI Inventory Analytics: anonymized inventory snapshot for Groq,
 * response validation against that snapshot, and the statistical fallback.
 * All numbers, trends, forecasts, sufficiency labels and risk alerts are
 * calculated by inventoryPredictiveAnalytics; the AI only interprets them.
 */

function analytics() {
  return require('./inventoryPredictiveAnalytics');
}

function buildAdminSnapshot(summary) {
  const inv = (summary && summary.inventory) || {};
  const dq = inv.dataQuality || {};
  const mon = inv.monitoring || {};
  const amPm = inv.amPmAnalysis || {};
  const horizon = inv.forecastDays || 30;
  return {
    reportingPeriod: { startDate: inv.dateFrom || null, endDate: inv.dateTo || null },
    dataCoverage: {
      firstRecordDate: dq.firstRecordDate || null,
      lastRecordDate: dq.lastRecordDate || null,
      recordedDays: dq.recordedDays || 0,
      coverageDays: dq.coverageDays || 0,
      dataStatus: dq.status || 'Insufficient Data',
      forecastAvailable: Boolean(dq.forecastAvailable),
      forecastPreliminary: Boolean(inv.forecastPreliminary),
      trendAvailable: Boolean(dq.trendAvailable),
      trendPreliminary: Boolean(dq.trendPreliminary),
    },
    forecastPeriodDays: horizon,
    inventory: {
      totalVialsUsed: inv.totalVaccinesUsed || 0,
      averageDailyUsage: inv.averageDailyUsage || 0,
      averageDailyUsageBasis: 'per recorded day',
      additionalVialsReceived: inv.additionalVaccinesReceived || 0,
      completedAMPMRecords: amPm.completed || 0,
      missingAMRecords: amPm.missingAm || 0,
      missingPMRecords: amPm.missingPm || 0,
      pendingVerificationRecords: amPm.pendingVerification || 0,
      currentTotalStock: inv.remainingInventory || 0,
      lowStockLots: mon.lowStockItems || 0,
      criticalStockLots: mon.criticalStockItems || 0,
      outOfStockLots: mon.outOfStockItems || 0,
      expiringLots: mon.expiringItems || 0,
      expiredLots: mon.expiredItems || 0,
      overallUsageTrend: (inv.overallTrend && inv.overallTrend.trend) || 'Insufficient Data',
      overallStockSufficiency: dq.sufficiencyStatus || 'Stock sufficiency cannot be determined',
    },
    vaccines: (inv.forecast || []).slice(0, 20).map((r) => ({
      vaccineName: r.vaccine,
      currentStock: r.currentStock,
      historicalUsage: r.historicalUsage,
      averageDailyUsage: r.averageDailyUsage,
      forecastedUsage: r.forecastMethod === 'insufficient' ? null : r.forecastUsage,
      forecastedUsagePeriod: r.forecastMethod === 'insufficient' ? null : `total for the next ${horizon} days`,
      forecastMethod: r.forecastMethodLabel,
      usageTrend: r.trend,
      usageTrendPreliminary: Boolean(r.trendPreliminary),
      stockStatus: r.inventoryStatus,
      stockSufficiency: r.stockSufficiency,
      expirationStatus: r.expirationStatus,
    })),
    riskAlerts: (inv.riskAlerts || []).map((a) => ({ vaccine: a.vaccine, risk: a.risk, detail: a.detail })),
    dataLimitations: inv.dataLimitations || [],
  };
}

const ADMIN_FOCUS = `MODULE: Admin AI Inventory Analytics (vaccine inventory, unit = vials).
Interpret the DATA snapshot only. Strict rules:
1. Usage is known only as a daily total per vaccine: Vials Used = AM Count + Additional Stock - PM Count.
   Never attribute usage to the morning, afternoon, AM shift or PM shift. Never say a shift had zero usage.
2. Trends: only describe a trend when usageTrend (or inventory.overallUsageTrend) is Increasing, Decreasing or Stable.
   If dataCoverage.trendPreliminary is true, call it a preliminary day-to-day change over dataCoverage.recordedDays days, not a long-term trend.
   usageTrend "Baseline" means only one day of records: describe it as a baseline, not as a trend.
3. Forecasts: if dataCoverage.forecastAvailable is false, give no forecast numbers and state that more verified records are needed.
   If dataCoverage.forecastPreliminary is true, call every forecast a preliminary estimate based on dataCoverage.recordedDays day(s) of records.
   forecastedUsage is the TOTAL for the next forecastPeriodDays days, never a daily figure. averageDailyUsage is per recorded day.
4. Stock sufficiency: use each vaccine's stockSufficiency label exactly. Never call stock sufficient, adequate or enough unless the label is "Sufficient based on current thresholds", and then say "based on current thresholds".
5. riskAlerts: restate only items from DATA.riskAlerts as "<vaccine> - <risk>: <detail>". If DATA.riskAlerts is empty return [].
   Never use the words "risk areas", "high-risk areas", "geographic" or "barangay".
6. Recommendations: each must name the metric from DATA that supports it in "basis".
7. Quote numbers exactly as given. Do not calculate new totals, percentages or projections. Do not claim causes.
8. Opening balance and stock received are never usage.`;

const ADMIN_JSON_SHAPE = `Return exactly this JSON object:
{"insights": [2-5 short strings], "recommendations": [{"text": "string", "basis": "metric and its value from DATA, e.g. recordedDays = 2"}],
 "trendExplanation": "string", "riskAlerts": [strings], "limitations": [strings], "status": "success"}`;

function buildAdminPrompt(snapshot) {
  return `${ADMIN_FOCUS}

${ADMIN_JSON_SHAPE}

DATA:
${JSON.stringify(snapshot)}`;
}

function clean(s) {
  return String(s == null ? '' : s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function toText(item) {
  if (item == null) return '';
  if (typeof item === 'string' || typeof item === 'number') return clean(item);
  if (typeof item === 'object') return clean(item.text || item.insight || item.recommendation || item.message || '');
  return '';
}

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) return [v];
  return [];
}

function splitSentences(text) {
  return clean(text).split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((s) => s.trim()).filter(Boolean);
}

function collectNumbers(value, out = new Set()) {
  if (value == null) return out;
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.add(Number(value.toFixed(2)));
    return out;
  }
  if (typeof value === 'string') {
    (value.match(/-?\d+(?:\.\d+)?/g) || []).forEach((n) => out.add(Number(Number(n).toFixed(2))));
    return out;
  }
  if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, out));
  else if (typeof value === 'object') Object.values(value).forEach((v) => collectNumbers(v, out));
  return out;
}

const SHIFT_RE = /\b(morning|afternoon)\b|\b(AM|PM)\s+shift\b/i;
const USAGE_RE = /\b(us(e|ed|es|age|ing)|consum\w*|dispens\w*|administer\w*)\b/i;
const SHIFT_OK_RE = /cannot be determined|not available|not recorded|shift-specific usage cannot/i;
const TREND_RE = /\b(increas\w*|decreas\w*|ris(e|es|ing)|declin\w*|upward|downward|growing|grew|stable trend|trending)\b/i;
const TREND_OK_RE = /cannot be established|insufficient|too short|not enough|not yet|limited data|unavailable/i;
const SUFFICIENT_RE = /\b(sufficient|adequate|enough)\b/i;
const SUFFICIENT_OK_RE = /insufficient|not enough|cannot be determined|based on current thresholds/i;
const GEO_RE = /\b(risk areas?|high-risk areas?|geographic\w*|barangays?)\b/i;
const CAUSE_RE = /\b(caused|because of|due to|led to|drove|driven by)\b/i;
const VIAL_NUM_RE = /(\d+(?:\.\d+)?)\s*(?:vials?|doses?)\b/gi;
const DAILY_RE = /\b(per day|daily|a day|each day)\b/i;

/**
 * Returns null when the sentence is supported by the snapshot, otherwise the rule it breaks.
 */
function sentenceViolation(sentence, ctx) {
  if (SHIFT_RE.test(sentence) && USAGE_RE.test(sentence) && !SHIFT_OK_RE.test(sentence)) return 'shift_attribution';
  if (GEO_RE.test(sentence)) return 'geographic_term';
  if (!ctx.trendAvailable && TREND_RE.test(sentence) && !TREND_OK_RE.test(sentence)) {
    const mentionsBackendTrend = ctx.vaccineTrends.some((t) => sentence.includes(t.vaccine) && /^(Increasing|Decreasing|Stable)$/.test(t.trend));
    if (!mentionsBackendTrend) return 'unsupported_trend';
  }
  if (SUFFICIENT_RE.test(sentence) && !SUFFICIENT_OK_RE.test(sentence)) return 'unsupported_sufficiency';
  if (/\bbite cases?\b/i.test(sentence) && CAUSE_RE.test(sentence)) return 'causal_claim';
  let m;
  VIAL_NUM_RE.lastIndex = 0;
  while ((m = VIAL_NUM_RE.exec(sentence))) {
    const n = Number(Number(m[1]).toFixed(2));
    if (!ctx.numbers.has(n)) return 'unverified_number';
    if (DAILY_RE.test(sentence) && ctx.forecastTotals.has(n) && !ctx.dailyValues.has(n)) return 'daily_vs_period';
  }
  if (!ctx.forecastAvailable && /\bforecast\w*\b/i.test(sentence) && /\d/.test(sentence) && !TREND_OK_RE.test(sentence)) {
    return 'unsupported_forecast';
  }
  return null;
}

function validationContext(snapshot) {
  const vaccines = snapshot.vaccines || [];
  return {
    numbers: collectNumbers(snapshot),
    trendAvailable: Boolean(snapshot.dataCoverage
      && (snapshot.dataCoverage.trendAvailable || snapshot.dataCoverage.trendPreliminary)),
    forecastAvailable: Boolean(snapshot.dataCoverage && snapshot.dataCoverage.forecastAvailable),
    vaccineTrends: vaccines.map((v) => ({ vaccine: v.vaccineName, trend: v.usageTrend })),
    forecastTotals: new Set(vaccines.map((v) => v.forecastedUsage).filter((n) => n != null).map(Number)),
    dailyValues: new Set([
      ...vaccines.map((v) => Number(v.averageDailyUsage)),
      Number(snapshot.inventory && snapshot.inventory.averageDailyUsage),
    ]),
  };
}

function filterStatements(items, ctx, removed) {
  const out = [];
  items.forEach((text) => {
    const kept = splitSentences(text).filter((s) => {
      const why = sentenceViolation(s, ctx);
      if (why) removed.push(why);
      return !why;
    });
    if (kept.length) out.push(kept.join(' '));
  });
  return out;
}

function formatBackendAlert(a) {
  return `${a.vaccine} - ${a.risk}: ${a.detail}`;
}

/**
 * Validates an AI response against the snapshot. Unsupported sentences are
 * removed; risk alerts are always the backend-verified list.
 */
function validateAdminAiResponse(raw, snapshot) {
  const removed = [];
  if (!raw || typeof raw !== 'object') return { valid: false, removedStatements: 0 };
  const ctx = validationContext(snapshot);

  const insights = filterStatements(toArray(raw.insights || raw.keyFindings).map(toText).filter(Boolean), ctx, removed).slice(0, 6);

  const recommendationDetails = [];
  toArray(raw.recommendations).forEach((r) => {
    let text = toText(r);
    let basis = r && typeof r === 'object' ? clean(r.basis) : '';
    const inline = !basis && text.match(/^(.*?)\s*\(?\bBasis:\s*(.+?)\)?\s*$/i);
    if (inline) {
      text = inline[1].trim();
      basis = inline[2].trim();
    }
    if (!text) return;
    const kept = filterStatements([text], ctx, removed);
    if (!kept.length) return;
    if (!basis) {
      removed.push('recommendation_without_basis');
      return;
    }
    recommendationDetails.push({ text: kept[0], basis });
  });

  const trendExplanation = filterStatements(
    [toText(raw.trendExplanation || raw.forecastInterpretation)].filter(Boolean), ctx, removed
  ).join(' ');

  const backendAlerts = snapshot.riskAlerts || [];
  const alertVaccines = new Set(backendAlerts.map((a) => a.vaccine));
  const aiAlerts = filterStatements(toArray(raw.riskAlerts || raw.riskAreas).map(toText).filter(Boolean), ctx, removed)
    .filter((t) => [...alertVaccines].some((v) => t.includes(v)));
  const riskAlerts = backendAlerts.length
    ? (aiAlerts.length >= backendAlerts.length ? aiAlerts : backendAlerts.map(formatBackendAlert))
    : [];
  if (!backendAlerts.length && toArray(raw.riskAlerts || raw.riskAreas).length) removed.push('unverified_risk_alert');

  const aiLimits = filterStatements(toArray(raw.limitations).map(toText).filter(Boolean), ctx, removed);
  const limitations = [...new Set([...(snapshot.dataLimitations || []), ...aiLimits])];

  const valid = insights.length > 0 && recommendationDetails.length > 0;
  return {
    valid,
    insights,
    recommendations: recommendationDetails.map((r) => `${r.text} (Basis: ${r.basis})`),
    recommendationDetails,
    trendExplanation,
    forecastInterpretation: '',
    riskAlerts,
    riskAreas: riskAlerts,
    inventoryInsights: [],
    limitations,
    removedStatements: removed.length,
    removedReasons: [...new Set(removed)],
  };
}

function fallbackAdminInventory(summary) {
  const { SHIFT_USAGE_NOTE } = analytics();
  const inv = (summary && summary.inventory) || {};
  const dq = inv.dataQuality || {};
  const amPm = inv.amPmAnalysis || {};
  const rows = inv.forecast || [];
  const horizon = inv.forecastDays || 30;
  const insights = [];
  const recs = [];
  const rec = (text, basis) => recs.push({ text, basis });

  if (dq.recordedDays) {
    insights.push(`Total vial usage was ${inv.totalVaccinesUsed} vials across ${dq.recordedDays} day(s) of verified AM/PM records (${dq.firstRecordDate} to ${dq.lastRecordDate}), an average of ${inv.averageDailyUsage} vials per recorded day.`);
    insights.push(SHIFT_USAGE_NOTE);
  } else {
    insights.push('No verified AM/PM inventory records were found for the selected period, so vial usage cannot be calculated.');
  }
  if (inv.mostUsedVaccine) {
    const top = rows.find((r) => r.vaccine === inv.mostUsedVaccine);
    if (top) insights.push(`${top.vaccine} had the highest recorded usage (${top.historicalUsage} vials) in the reporting period.`);
  }
  if (inv.additionalVaccinesReceived) {
    insights.push(`${inv.additionalVaccinesReceived} additional vials were recorded on AM/PM sheets; additional stock is not counted as usage.`);
  }
  insights.push(`Current usable stock totals ${inv.remainingInventory || 0} vials. Overall stock status: ${dq.sufficiencyStatus || 'Stock sufficiency cannot be determined'}.`);
  const trend = inv.overallTrend || {};
  if (dq.trendAvailable && trend.trend) {
    insights.push(`Weekly average daily usage is ${String(trend.trend).toLowerCase()} (about ${trend.changePct}% across ${trend.periods} weeks).`);
  } else if (dq.trendPreliminary && trend.trend) {
    const pct = trend.changePct != null ? `about ${trend.changePct}% ` : '';
    insights.push(`Preliminary day-to-day comparison: total daily usage is ${String(trend.trend).toLowerCase()} (${pct}across ${trend.periods} recorded days).`);
  } else if (dq.recordedDays) {
    insights.push(`Usage from ${dq.firstRecordDate} is the baseline. Trends appear once a second day of verified records is available.`);
  }

  rows.forEach((r) => {
    if (r.stockSufficiency === 'Critical-stock risk detected') {
      rec(`Prioritise a replenishment review for ${r.vaccine}.`, `current stock ${r.currentStock} vials; critical threshold ${r.criticalThreshold}`);
    } else if (r.stockSufficiency === 'Low-stock risk detected') {
      rec(`Plan replenishment for ${r.vaccine}.`, `current stock ${r.currentStock} vials; low-stock threshold ${r.lowThreshold}`);
    } else if (r.stockSufficiency === 'Potential depletion risk') {
      rec(`Review stock of ${r.vaccine} before the forecast period ends.`, `${horizon}-day forecast ${r.forecastUsage} vials vs current stock ${r.currentStock} vials`);
    }
    if (r.expiredLotsWithStock > 0) {
      rec(`Record the disposal of expired ${r.vaccine} lots through authorized inventory functions.`, `${r.expiredLotsWithStock} expired lot(s), ${r.expiredQuantity} vials`);
    }
    if (r.expiringLots > 0) {
      rec(`Use ${r.vaccine} lots nearest to expiry first.`, `${r.expiringLots} lot(s) expiring within 30 days${r.nearestExpiryDays != null ? `, nearest in ${r.nearestExpiryDays} days` : ''}`);
    }
  });
  if (amPm.missingAm) rec('Record the missing AM counts so vial usage can be calculated.', `Missing AM records = ${amPm.missingAm}`);
  if (amPm.missingPm) rec('Complete the missing PM counts so vial usage can be calculated.', `Missing PM records = ${amPm.missingPm}`);
  if (amPm.pendingVerification) rec('Verify pending inventory records.', `${amPm.pendingVerification} record(s) pending verification`);
  if (!dq.forecastAvailable || inv.forecastPreliminary) {
    rec('Continue recording verified AM and PM counts every clinic day to make forecasts more reliable.', `${dq.recordedDays || 0} verified day(s) on record`);
  }
  if (!recs.length) rec('Continue daily AM/PM counts and review stock against thresholds.', `overall stock status: ${dq.sufficiencyStatus || 'n/a'}`);

  const trendExplanation = dq.forecastAvailable
    ? `Forecast values are totals for the stated period, not daily amounts. ${inv.forecastNote || ''}`.trim()
    : (inv.forecastNote || 'Forecasts appear once daily AM and PM counts are recorded.');

  const riskAlerts = (inv.riskAlerts || []).map(formatBackendAlert);
  const recommendationDetails = recs.slice(0, 8);
  return {
    insights: insights.slice(0, 7),
    recommendations: recommendationDetails.map((r) => `${r.text} (Basis: ${r.basis})`),
    recommendationDetails,
    trendExplanation,
    forecastInterpretation: '',
    riskAlerts,
    riskAreas: riskAlerts,
    inventoryInsights: [],
    limitations: [...(inv.dataLimitations || []), 'Statistical observations calculated by REMIS. AI was not used.'],
    source: 'fallback',
  };
}

module.exports = {
  ADMIN_FOCUS,
  buildAdminSnapshot,
  buildAdminPrompt,
  validateAdminAiResponse,
  fallbackAdminInventory,
  sentenceViolation,
  validationContext,
  splitSentences,
};
