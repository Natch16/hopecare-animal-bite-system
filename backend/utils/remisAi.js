'use strict';

/**
 * REMIS AI analysis layer: aggregated stats + optional Groq interpretation.
 * The AI provider never receives PII and never writes to MySQL.
 */

const aiClient = require('./groqClient');

const SYSTEM_TITLE =
  'REMIS: Rabies Exposure & Monitoring Information System with GARP Features for the HOPECARE Animal Bite Center, Gingoog City';

const PII_KEY_RE = /^(full_?name|first_?name|last_?name|middle_?name|patient_?name|patient_?id|patient_id_display|registration_?(number|no)|reg_?no|contact_?(number|no)?|phone|mobile|address|street|email|birth_?date|date_of_birth|dob|guardian\w*|password|password_hash|token|username|staff_id|created_by|updated_by|vaccinator|given_by|notes|remarks)$/i;

function linearRegression(values) {
  const pts = (values || [])
    .map((v, i) => ({ x: i + 1, y: Number(v) }))
    .filter((p) => Number.isFinite(p.y));
  const n = pts.length;
  if (n < 2) {
    const last = n === 1 ? pts[0].y : 0;
    return { slope: 0, intercept: last, next: Math.max(0, Math.round(last)), r2: 0, n };
  }
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  pts.forEach((p) => {
    sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumXX += p.x * p.x;
  });
  const denom = n * sumXX - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const meanY = sumY / n;
  let ssRes = 0, ssTot = 0;
  pts.forEach((p) => {
    const pred = intercept + slope * p.x;
    ssRes += (p.y - pred) ** 2;
    ssTot += (p.y - meanY) ** 2;
  });
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  const next = Math.max(0, Math.round(intercept + slope * (n + 1)));
  return {
    slope: Number(slope.toFixed(4)),
    intercept: Number(intercept.toFixed(4)),
    next,
    r2: Number(r2.toFixed(4)),
    n,
  };
}

function trendFromSeries(values) {
  const nums = (values || []).map(Number).filter((n) => Number.isFinite(n));
  if (nums.length < 2) return 'Stable';
  const last = nums[nums.length - 1];
  const prev = nums[nums.length - 2];
  if (prev === 0) return last > 0 ? 'Increasing' : 'Stable';
  if (last > prev * 1.1) return 'Increasing';
  if (last < prev * 0.9) return 'Decreasing';
  return 'Stable';
}

function describeCaseUsageRelationship(monthlyCases, monthlyUsage, { unit = 'month' } = {}) {
  const months = [...new Set([
    ...Object.keys(monthlyCases || {}),
    ...Object.keys(monthlyUsage || {}),
  ])].sort();
  if (months.length < 2) {
    const sum = (m) => Object.values(m || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const cases = sum(monthlyCases);
    const usage = sum(monthlyUsage);
    const only = months[0];
    return {
      sufficient: false,
      unit,
      totalCases: cases,
      totalUsage: usage,
      observation: only
        ? `All available records fall in a single ${unit} (${only}): ${cases} bite case(s) and ${usage} vial(s) of verified vaccine usage. `
          + `At least two ${unit}s of records are needed to compare how bite cases and vaccine usage change together.`
        : 'No bite cases or verified vaccine usage have been recorded for the selected period yet.',
    };
  }
  const last = months[months.length - 1];
  const prev = months[months.length - 2];
  const c1 = Number((monthlyCases || {})[prev] || 0);
  const c2 = Number((monthlyCases || {})[last] || 0);
  const u1 = Number((monthlyUsage || {})[prev] || 0);
  const u2 = Number((monthlyUsage || {})[last] || 0);
  let observation;
  if (c2 > c1 && u2 > u1) {
    observation = 'Vaccine usage increased during periods when recorded bite cases also increased.';
  } else if (c2 < c1 && u2 < u1) {
    observation = 'Vaccine usage decreased during periods when recorded bite cases also decreased.';
  } else {
    observation = 'Recorded bite-case volume and vaccine usage did not move in the same direction in the latest comparable periods.';
  }
  observation += ` Latest comparison: ${prev} — ${c1} case(s), ${u1} vial(s); ${last} — ${c2} case(s), ${u2} vial(s).`;
  if (unit === 'week') observation += ' Compared by week because less than two months of records are available.';
  return {
    sufficient: true,
    unit,
    observation,
    lastMonth: last,
    previousMonth: prev,
    lastCases: c2,
    previousCases: c1,
    lastUsage: u2,
    previousUsage: u1,
  };
}

function compactNursePayload(summary) {
  const s = summary || {};
  return anonymize({
    totalPatients: s.totalPatients,
    totalBiteCases: s.totalCases,
    categoryI: s.categoryI,
    categoryII: s.categoryII,
    categoryIII: s.categoryIII,
    mostCommonAnimal: s.topAnimal,
    animalDistribution: s.animalDistribution,
    highestCaseBarangay: s.highestCaseBarangay,
    highestCaseBarangayCases: s.highestCaseBarangayCases,
    barangayDistribution: (s.barangayDistribution || []).slice(0, 8).map((b) => ({
      barangay: b.barangay,
      case_count: b.case_count,
    })),
    overduePatients: s.overduePatients,
    vaccinationCompletionRate: s.vaccinationCompletionRate,
    caseTrend: s.trend,
    predictedCasesNextMonth: s.predictedNextMonth,
    predictedCasesNextQuarter: s.predictedNextQuarter,
    dataSufficient: s.dataSufficient,
  });
}

function compactAdminPayload(summary) {
  return anonymize(require('./adminInventoryAi').buildAdminSnapshot(summary));
}

function anonymize(value, key) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((v) => anonymize(v, key));
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((k) => {
      if (PII_KEY_RE.test(k)) return;
      out[k] = anonymize(value[k], k);
    });
    return out;
  }
  if (key && PII_KEY_RE.test(key)) return undefined;
  return value;
}

function flattenText(item) {
  if (item == null) return '';
  if (typeof item === 'string' || typeof item === 'number') return String(item);
  if (typeof item === 'object') {
    return item.text || item.insight || item.recommendation || item.message || item.value || '';
  }
  return String(item);
}

function asStringArray(v, max = 8) {
  if (typeof v === 'string' && v.trim()) {
    return [stripAiText(v)].slice(0, max);
  }
  if (!Array.isArray(v)) return [];
  return v
    .map((item) => stripAiText(flattenText(item)))
    .filter(Boolean)
    .slice(0, max);
}

function stripAiText(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function validateAiPayload(raw, { includeInventory }) {
  const empty = {
    insights: [],
    recommendations: [],
    trendExplanation: '',
    forecastInterpretation: '',
    riskAreas: [],
    inventoryInsights: [],
    limitations: '',
  };
  if (!raw || typeof raw !== 'object') return { ...empty, valid: false };
  const out = {
    insights: asStringArray(raw.insights || raw.insight || raw.keyFindings),
    recommendations: asStringArray(raw.recommendations || raw.recommendation || raw.actions),
    trendExplanation: stripAiText(
      raw.trendExplanation || raw.trend || raw.explanation
      || (includeInventory ? raw.forecastInterpretation : '')
    ),
    forecastInterpretation: stripAiText(raw.forecastInterpretation || raw.forecast),
    riskAreas: asStringArray(raw.riskAreas || raw.risk_areas, 6),
    inventoryInsights: includeInventory ? asStringArray(raw.inventoryInsights || raw.inventory_insights) : [],
    summary: stripAiText(raw.summary),
    limitations: stripAiText(raw.limitations),
    valid: true,
  };
  if (!out.insights.length && !out.recommendations.length && !out.trendExplanation && !out.summary) {
    out.valid = false;
  }
  return out;
}

function fallbackNurse(summary) {
  const s = summary || {};
  const insights = [];
  const recs = [];
  const riskAreas = [];
  if (s.highestCaseBarangay) {
    insights.push(`${s.highestCaseBarangay} has the highest recorded case count (${s.highestCaseBarangayCases || 0}) in the selected period.`);
    riskAreas.push(s.highestCaseBarangay);
    recs.push(`Review outreach and surveillance in ${s.highestCaseBarangay}.`);
  }
  if (s.overduePatients > 0) {
    insights.push(`Overdue vaccination records: ${s.overduePatients}.`);
    recs.push('Follow up patients with overdue PEP doses to prevent treatment interruption.');
  }
  if (s.vaccinationCompletionRate != null) {
    insights.push(`Vaccination completion rate is ${s.vaccinationCompletionRate}%.`);
    if (s.vaccinationCompletionRate < 70) recs.push('Strengthen follow-up for incomplete vaccination schedules.');
  }
  if (s.trend) {
    insights.push(`Cases ${String(s.trend).toLowerCase()} compared with the previous period.`);
  }
  if (s.predictedNextMonth != null) {
    insights.push(`Linear-regression projection for next month: ${s.predictedNextMonth} cases.`);
  }
  if (!insights.length) insights.push('Insufficient historical data for detailed AI interpretation. Charts and statistics remain available.');
  if (!recs.length) recs.push('Continue monitoring aggregated REMIS analytics and vaccination schedules.');
  return {
    insights,
    recommendations: recs,
    trendExplanation: s.trend
      ? `Backend statistical analysis indicates a ${String(s.trend).toLowerCase()} case trend. Predicted next month: ${s.predictedNextMonth ?? 'n/a'}; next quarter: ${s.predictedNextQuarter ?? 'n/a'}.`
      : 'Not enough consecutive months to describe a trend.',
    riskAreas,
    inventoryInsights: [],
    limitations: 'Rule-based fallback from REMIS aggregated statistics. AI was not used.',
    source: 'fallback',
  };
}

function fallbackAdmin(summary) {
  return require('./adminInventoryAi').fallbackAdminInventory(summary || {});
}

const SYSTEM_RULES = `You are a decision-support analyst for ${SYSTEM_TITLE}.
Rules:
- Interpret ONLY the aggregated, anonymized DATA provided. Never invent numbers, barangays, vaccines, animals, or events.
- Every number was calculated by REMIS from MySQL. Quote numbers exactly as given; never recalculate, round differently, or replace them.
- You cannot modify any record. Recommendations are decision-support suggestions only.
- No medical diagnoses, no treatment orders, no statements about individual patients.
- Forecasts are statistical estimates, not guarantees. Say so when interpreting them.
- Plain text inside JSON strings. No markdown, no HTML.`;

const NURSE_FOCUS = `MODULE: Nurse Analytics (animal bite cases).
Focus on: animal bite case trend, barangay distribution and the highest-case barangays, biting-animal distribution,
exposure categories I/II/III, vaccination completion rate and overdue doses, and the linear-regression case projections.
riskAreas = barangay names from DATA with the highest recorded cases. Empty array if none.`;

const JSON_SHAPE = `Return exactly this JSON object:
{"insights": [2-4 short strings], "recommendations": [2-4 short strings], "trendExplanation": "string",
 "riskAreas": [strings], "forecastInterpretation": "string", "limitations": "one sentence on data gaps", "status": "success"}`;

async function interpretWithAi(summary, role) {
  if (role === 'Administrator') {
    const adminAi = require('./adminInventoryAi');
    const snapshot = compactAdminPayload(summary);
    const parsed = await aiClient.generateJson(adminAi.buildAdminPrompt(snapshot), SYSTEM_RULES);
    const validated = adminAi.validateAdminAiResponse(parsed, snapshot);
    if (!validated.valid) throw aiClient.typedError('invalid_response', 'Invalid AI response');
    return { ...validated, source: aiClient.PROVIDER };
  }
  const clean = compactNursePayload(summary);
  const prompt = `${NURSE_FOCUS}

${JSON_SHAPE}

DATA:
${JSON.stringify(clean)}`;

  const parsed = await aiClient.generateJson(prompt, SYSTEM_RULES);
  const validated = validateAiPayload(parsed, { includeInventory: false });
  if (!validated.valid) throw aiClient.typedError('invalid_response', 'Invalid AI response');
  return { ...validated, source: aiClient.PROVIDER };
}

function hasCaseData(payload) {
  const p = payload || {};
  return Number(p.totalCases ?? p.totalBiteCases ?? 0) > 0;
}

function hasInventoryData(summary) {
  const inv = (summary && summary.inventory) || {};
  return Number(inv.totalVaccinesUsed || 0) > 0
    || (inv.forecast || []).some((r) => Number(r.currentStock) > 0)
    || Number(inv.remainingInventory || 0) > 0;
}

function predictionBand(next, series) {
  if (next == null || !Number.isFinite(next)) {
    return { value: null, range: 'Insufficient data', display: 'Insufficient data' };
  }
  const values = (series || []).map(Number).filter((n) => Number.isFinite(n));
  const point = Math.max(0, Math.round(next));
  if (values.length < 3) {
    return { value: point, range: String(point), display: `${point} cases` };
  }
  const lr = linearRegression(values);
  let absErr = 0;
  values.forEach((y, i) => {
    absErr += Math.abs(y - (lr.intercept + lr.slope * (i + 1)));
  });
  const mae = Math.max(1, Math.round(absErr / values.length));
  const lo = Math.max(0, point - mae);
  const hi = point + mae;
  return { value: point, range: `${lo}–${hi}`, display: `${lo}–${hi} cases` };
}

function predictionReliability(seriesLength, r2) {
  if (!seriesLength || seriesLength < 1) {
    return {
      label: 'Insufficient historical data',
      detail: 'Prediction reliability cannot be assessed from the available history.',
    };
  }
  if (seriesLength < 2) {
    return {
      label: 'Limited historical data',
      detail: 'Estimate is based on the selected reporting period. Additional monthly history will improve this projection. Predictions are estimates, not guaranteed outcomes.',
    };
  }
  return {
    label: 'Based on available historical data',
    detail: `Estimated from ${seriesLength} monthly observations using linear regression. Predictions are estimates, not guaranteed outcomes.`,
  };
}

function monthlyCountsBetween(rows, startDate, endDate) {
  const map = {};
  (rows || []).forEach((r) => {
    const key = String(r.month || '').slice(0, 7);
    if (key.length === 7) map[key] = Number(r.count) || 0;
  });
  const start = String(startDate || '').slice(0, 7);
  const end = String(endDate || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(start) || !/^\d{4}-\d{2}$/.test(end)) {
    return Object.keys(map).sort().map((k) => map[k]);
  }
  const out = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const endY = Number(end.slice(0, 4));
  const endM = Number(end.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(map[key] || 0);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function projectAhead(regression, stepsAhead) {
  return Math.max(0, Math.round(regression.intercept + regression.slope * (regression.n + stepsAhead)));
}

/**
 * Linear regression on monthly recorded counts.
 * Leading months with no cases are ignored so a long run of empty months
 * is not treated as a real downward history.
 * A forecast is returned only when at least three months remain and at least
 * two of those months have recorded cases. Otherwise the result is explicitly
 * insufficient — the current period total is never copied into the forecast.
 */
function buildGeoPredictions(histValues, periodTotal = 0) {
  const raw = (histValues || []).map(Number).filter((n) => Number.isFinite(n));
  const firstPositive = raw.findIndex((value) => value > 0);
  const series = firstPositive < 0 ? [] : raw.slice(firstPositive);
  const positiveMonths = series.filter((value) => value > 0).length;
  const reliable = series.length >= 3 && positiveMonths >= 2;
  const recordedTotal = Number(periodTotal) || 0;

  if (!reliable) {
    return {
      nextMonth: null,
      nextQuarter: null,
      trend: 'Insufficient Data',
      reliable: false,
      reliability: {
        label: 'Insufficient Data for Reliable Prediction',
        detail: `Linear regression needs at least 3 months of history and at least 2 months with recorded cases. This window has ${series.length} month(s) after the first recorded case and ${positiveMonths} month(s) with cases. Recorded cases in the current reporting period: ${recordedTotal}. That total is not a forecast.`,
      },
      n: series.length,
      positiveMonths,
      r2: null,
      slope: null,
      intercept: null,
    };
  }

  const lr = linearRegression(series);
  const nextMonth = projectAhead(lr, 1);
  const nextQuarter = projectAhead(lr, 1) + projectAhead(lr, 2) + projectAhead(lr, 3);
  return {
    nextMonth,
    nextQuarter,
    trend: trendFromSeries(series),
    reliable: true,
    reliability: {
      label: 'Based on available historical data',
      detail: `Estimated from ${series.length} monthly observations (${positiveMonths} with recorded cases) using linear regression. Predictions are estimates, not recorded cases and not guaranteed outcomes.`,
    },
    n: lr.n,
    positiveMonths,
    r2: lr.r2,
    slope: lr.slope,
    intercept: lr.intercept,
  };
}

function caseWord(count) {
  const n = Number(count) || 0;
  return `${n} case${n === 1 ? '' : 's'}`;
}

function leaderNames(payload) {
  const d = payload || {};
  if (Array.isArray(d.highestRiskBarangays) && d.highestRiskBarangays.length) return d.highestRiskBarangays;
  if (d.topBarangay && d.topBarangay !== 'No Cases' && d.topBarangay !== 'Insufficient Data' && !/\(Tie\)/.test(d.topBarangay)) {
    return [d.topBarangay];
  }
  return [];
}

function animalSentence(payload) {
  const d = payload || {};
  const animals = d.animalDistribution || {};
  if (animals.dog && animals.cat && animals.other && animals.dog.count != null) {
    return `Dog = ${animals.dog.count} (${animals.dog.pct}%), Cat = ${animals.cat.count} (${animals.cat.pct}%), Other Animals = ${animals.other.count} (${animals.other.pct}%).`;
  }
  if (d.dogPct != null) return `Dog bites accounted for ${d.dogPct}% of the recorded animal bite cases.`;
  return '';
}

function fallbackGeoReport(payload) {
  const d = payload || {};
  const insights = [];
  const recs = [];
  const names = leaderNames(d);
  const tied = d.highestRiskTied === true || names.length > 1;
  const label = tied ? `${names.join(' & ')} (Tie)` : (names[0] || d.highestRiskBarangay || '');
  const total = Number(d.totalCases) || 0;
  const eachCases = d.highestRiskCases != null ? d.highestRiskCases : d.topBarangayCases;
  const eachPct = d.highestRiskPercentage != null ? d.highestRiskPercentage : null;
  const animals = animalSentence(d);
  const reliable = d.predictionReliable === true && d.historicalTrend && d.historicalTrend !== 'Insufficient Data';

  if (total === 0) {
    insights.push(`No animal bite cases were recorded for ${d.reportingPeriod || 'the selected reporting period'}.`);
    insights.push('There is insufficient data to name a highest-risk barangay or to classify a case trend.');
    recs.push('More recorded exposure data is needed before a barangay risk ranking or a case forecast can be made. No barangay is singled out from this empty period.');
  } else if (names.length) {
    const share = eachPct != null ? `, ${eachPct}% of recorded cases` : '';
    if (tied) {
      insights.push(`${label} are tied for the highest number of recorded cases, with ${caseWord(eachCases)} each${share}, out of ${caseWord(total)} in the reporting period.`);
      recs.push(`Monitoring for the highest recorded cases must include ${names.join(' and ')}. They are tied at ${caseWord(eachCases)} each. Do not limit follow-up to only one of them.`);
    } else {
      insights.push(`The highest number of recorded cases occurred in ${names[0]}, with ${caseWord(eachCases)} during the selected reporting period.`);
      recs.push(`Include ${names[0]} in monitoring because it has the highest recorded case count (${caseWord(eachCases)}) for this reporting period.`);
    }
  }
  if (animals) insights.push(`Animal bite distribution for this period: ${animals}`);
  if (total > 0) {
    insights.push(`${d.affectedBarangays || 0} barangay${Number(d.affectedBarangays) === 1 ? '' : 's'} recorded animal bite cases during the reporting period.`);
    insights.push(`Overall risk level is ${d.overallRiskLevel || 'Insufficient Data'}. ${d.overallRiskBasis || ''}`.trim());
  }
  if (reliable) {
    insights.push(`The historical case trend is ${d.historicalTrend}. The linear-regression forecast for next month is ${d.predictedNextMonthDisplay} (an estimate, not a recorded total).`);
    recs.push(`The forecast trend is ${d.historicalTrend}. Use it only as an estimate when planning awareness for the barangays with recorded cases.`);
  } else {
    insights.push('Insufficient Data for Reliable Prediction. No future case count is estimated from this history.');
    recs.push(`More monthly history is needed before a forecast can be used. Recorded cases for this reporting period: ${total}. Do not treat a prediction as a recorded value.`);
  }
  if (d.mostCommonAnimal && d.mostCommonAnimal !== 'N/A' && total > 0) {
    recs.push(`Animal distribution for this period is led by ${d.mostCommonAnimal}. Prevention messages should follow that recorded distribution.`);
  }

  const summary = total === 0
    ? `During the selected reporting period (${d.reportingPeriod || 'n/a'}), HOPECARE Animal Bite Center recorded no animal bite cases in the filtered geographic data. Highest-risk barangay and overall risk are not inferred from an empty period. There is insufficient data for a reliable prediction.`
    : `During the selected reporting period (${d.reportingPeriod || 'n/a'}), HOPECARE Animal Bite Center recorded ${total} animal bite cases across ${d.affectedBarangays || 0} affected barangays. Highest recorded barangay: ${label || 'Insufficient Data'}${eachCases != null ? ` (${caseWord(eachCases)}${tied ? ' each' : ''})` : ''}. ${animals} Overall risk level: ${d.overallRiskLevel || 'Insufficient Data'}. ${reliable
      ? `Historical trend: ${d.historicalTrend}. Forecast for next month: ${d.predictedNextMonthDisplay} (estimate, not a recorded total).`
      : 'Insufficient Data for Reliable Prediction. The current case total is recorded history, not a forecast.'}`;

  return {
    insights: insights.filter(Boolean).slice(0, 5),
    recommendations: recs.filter(Boolean).slice(0, 5),
    summary,
    trendExplanation: reliable
      ? `Linear regression on the recorded monthly case counts indicates a ${String(d.historicalTrend).toLowerCase()} trend. The next-month figure is a forecast, not a recorded total.`
      : 'Insufficient Data for Reliable Prediction. A trend was not classified from the available monthly history.',
    forecastInterpretation: reliable
      ? `Next month forecast: ${d.predictedNextMonthDisplay}. Next quarter forecast: ${d.predictedNextQuarterDisplay}. These are estimates.`
      : 'Insufficient Data for Reliable Prediction.',
    riskAreas: names,
    limitations: reliable
      ? 'Observations use the validated reporting-period counts. Forecasts are estimates from linear regression and are not guaranteed.'
      : 'Observations use the validated reporting-period counts. Historical data is not sufficient for a reliable prediction.',
    source: 'fallback',
  };
}

function geoRecordedBarangays(payload) {
  const names = new Set();
  (payload.recordedBarangays || []).forEach((name) => names.add(String(name).toLowerCase()));
  (payload.highestRiskBarangays || []).forEach((name) => names.add(String(name).toLowerCase()));
  (payload.topBarangays || []).forEach((row) => {
    if (row && row.barangay) names.add(String(row.barangay).toLowerCase());
  });
  if (payload.topBarangay && !/\(Tie\)|&/.test(payload.topBarangay)) names.add(String(payload.topBarangay).toLowerCase());
  return names;
}

function barangaysMentioned(text, officialNames) {
  const found = [];
  let masked = String(text || '').toLowerCase();
  const names = [...(officialNames || [])].sort((a, b) => b.length - a.length);
  names.forEach((name) => {
    const token = String(name || '').trim().toLowerCase();
    if (token.length < 2 || !masked.includes(token)) return;
    found.push(name);
    masked = masked.split(token).join(' ');
  });
  return found;
}

function allowedGeoNumbers(payload) {
  const set = new Set(['0', '0.00']);
  const add = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    set.add(String(n));
    set.add(n.toFixed(2));
    set.add(String(Math.round(n)));
  };
  const skip = new Set(['reportingPeriod', 'overallRiskBasis', 'riskCriteria', 'month', 'historicalTrend', 'mostCommonAnimal', 'highestRiskBarangay', 'topBarangay']);
  const walk = (value, key) => {
    if (skip.has(key)) return;
    if (typeof value === 'number') add(value);
    else if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) add(value.trim());
    else if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([childKey, child]) => walk(child, childKey));
  };
  walk(payload, '');
  const years = String(payload.reportingPeriod || '').match(/\b(?:19|20)\d{2}\b/g) || [];
  years.forEach(add);
  return set;
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function geoSentenceAllowed(sentence, payload, officialBarangays) {
  const recorded = geoRecordedBarangays(payload);
  const mentioned = barangaysMentioned(sentence, officialBarangays);
  if (mentioned.some((name) => !recorded.has(String(name).toLowerCase()))) return false;
  const tied = (payload.highestRiskBarangays || []).filter(Boolean);
  if (tied.length > 1) {
    const hit = tied.filter((name) => sentence.toLowerCase().includes(String(name).toLowerCase()));
    if (hit.length > 0 && hit.length < tied.length) return false;
  }
  const numbers = sentence.match(/\d+(?:\.\d+)?/g) || [];
  const allowed = allowedGeoNumbers(payload);
  if (numbers.some((n) => !allowed.has(n) && !allowed.has(String(Number(n))))) return false;
  const reliable = payload.predictionReliable === true;
  if (!reliable) {
    if (/\b(predict(?:ed|ion|s)?|forecast(?:ed)?|projected|projection|next month|next quarter)\b/i.test(sentence)
      && /\d/.test(sentence)
      && !/insufficient/i.test(sentence)) return false;
    if (/\b(increasing|decreasing|stable|upward|downward)\b/i.test(sentence) && !/insufficient/i.test(sentence)) return false;
  } else if (/\b(increasing|decreasing|stable)\b/i.test(sentence)) {
    const trend = String(payload.historicalTrend || '').toLowerCase();
    if (trend && !sentence.toLowerCase().includes(trend)) return false;
  }
  return true;
}

function filterGeoSentences(items, payload, officialBarangays) {
  const out = [];
  (items || []).forEach((item) => {
    const kept = splitSentences(flattenText(item)).filter((sentence) => geoSentenceAllowed(sentence, payload, officialBarangays));
    if (kept.length) out.push(kept.join(' '));
  });
  return out;
}

/**
 * Drop AI sentences that invent barangays, counts, trends, or forecasts.
 * A tie must name every tied barangay. Returns valid:false when nothing usable remains.
 */
function validateGeoAiResponse(raw, payload, officialBarangays = []) {
  const data = { ...(payload || {}) };
  delete data.officialBarangays;
  const official = officialBarangays.length ? officialBarangays : [];
  if (!raw || typeof raw !== 'object') return { valid: false };
  const insights = filterGeoSentences(raw.insights || raw.insight, data, official).slice(0, 5);
  const recommendations = filterGeoSentences(raw.recommendations || raw.recommendation, data, official).slice(0, 5);
  const summaryParts = filterGeoSentences([raw.summary], data, official);
  const fallback = fallbackGeoReport(data);
  const summary = summaryParts.join(' ').length >= 40 ? summaryParts.join(' ') : fallback.summary;
  const tied = (data.highestRiskBarangays || []).filter(Boolean);
  const recorded = geoRecordedBarangays(data);
  let riskAreas = asStringArray(raw.riskAreas || raw.risk_areas, 6).filter((name) => {
    const text = String(name).toLowerCase();
    return [...recorded].some((recordedName) => text === recordedName || text.includes(recordedName));
  });
  if (tied.length > 1) {
    const hasAll = tied.every((name) => riskAreas.some((area) => String(area).toLowerCase() === String(name).toLowerCase()));
    if (!hasAll) riskAreas = tied.slice();
  }
  if (!insights.length || !recommendations.length) return { valid: false };
  return {
    valid: true,
    insights,
    recommendations,
    summary,
    trendExplanation: filterGeoSentences([raw.trendExplanation], data, official).join(' ') || fallback.trendExplanation,
    forecastInterpretation: filterGeoSentences([raw.forecastInterpretation], data, official).join(' ') || fallback.forecastInterpretation,
    riskAreas,
    limitations: filterGeoSentences([raw.limitations], data, official).join(' ') || fallback.limitations,
  };
}

async function interpretGeoReport(payload) {
  const officialBarangays = payload.officialBarangays || [];
  const clean = anonymize(payload);
  delete clean.officialBarangays;
  const prompt = `MODULE: Geographic Mapping & AI Analytics Report (printed report for LGU / DOH readers).
Write in clear, formal, professional report language.
Interpret ONLY the validated DATA. Never invent case counts, barangay names, percentages, risk levels, animal distributions, trends, or predictions.
If highestRiskTied is true, every sentence that names one highest-risk barangay must name every barangay in highestRiskBarangays.
If predictionReliable is false, do not give a numeric forecast and do not call the trend increasing, decreasing, or stable. Say there is insufficient data for a reliable prediction.
Separate recorded cases for the reporting period from any forecast. A forecast is never a recorded total.
Quote numbers exactly as given in DATA.

Return exactly this JSON object:
{"insights": [3-5 strings], "recommendations": [3-5 strings], "summary": "3-4 sentence report summary",
 "trendExplanation": "string", "forecastInterpretation": "string", "riskAreas": [barangay names from DATA only],
 "limitations": "one sentence", "status": "success"}

DATA:
${JSON.stringify(clean)}`;

  const parsed = await aiClient.generateJson(prompt, SYSTEM_RULES);
  const validated = validateGeoAiResponse(parsed, clean, officialBarangays);
  if (!validated.valid) throw aiClient.typedError('invalid_response', 'Invalid AI response');
  return { ...validated, source: aiClient.PROVIDER };
}

module.exports = {
  SYSTEM_TITLE,
  linearRegression,
  trendFromSeries,
  describeCaseUsageRelationship,
  compactNursePayload,
  compactAdminPayload,
  anonymize,
  validateAiPayload,
  fallbackNurse,
  fallbackAdmin,
  interpretWithAi,
  hasCaseData,
  hasInventoryData,
  predictionBand,
  predictionReliability,
  monthlyCountsBetween,
  buildGeoPredictions,
  fallbackGeoReport,
  validateGeoAiResponse,
  interpretGeoReport,
};
