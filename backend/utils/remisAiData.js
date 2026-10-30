'use strict';

const pool = require('../config/database').pool;
const { buildAnalyticsWhere } = require('./analyticsFilters');
const { loadBiteCases, buildNurseSummary } = require('./analyticsCaseSummary');
const { describeCaseUsageRelationship } = require('./remisAi');
const { collectClinicInventoryAnalytics, bucketKey } = require('./inventoryPredictiveAnalytics');

async function collectNurseSummary(query) {
  const cases = await loadBiteCases(pool);
  return buildNurseSummary(cases, query || {});
}

async function collectInventoryAnalytics(query) {
  return collectClinicInventoryAnalytics(pool, query || {});
}

async function collectInventorySummary(query) {
  return collectInventoryAnalytics(query);
}

/** Bite cases and verified usage per ISO week inside the inventory analytics range. */
async function weeklyCaseUsage(query, inventory) {
  if (!inventory.dateFrom || !inventory.dateTo) return null;
  const { where: whereP, params: paramsP } = buildAnalyticsWhere(query || {}, 'p');
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(pe.date_of_exposure, '%Y-%m-%d') AS d, COUNT(*) AS count
     FROM patient_exposures pe
     JOIN patients p ON p.patient_id = pe.patient_id
     ${whereP ? `${whereP} AND` : 'WHERE'} pe.date_of_exposure BETWEEN ? AND ?
     GROUP BY DATE_FORMAT(pe.date_of_exposure, '%Y-%m-%d')`,
    [...paramsP, inventory.dateFrom, inventory.dateTo]
  );
  const cases = {};
  for (const r of rows || []) {
    const wk = bucketKey(r.d, 'week');
    if (wk) cases[wk] = (cases[wk] || 0) + Number(r.count || 0);
  }
  const usage = {};
  for (const p of inventory.usageSeries || []) {
    const wk = inventory.grain === 'week' ? p.period : bucketKey(p.period, 'week');
    if (wk) usage[wk] = (usage[wk] || 0) + Number(p.used || 0);
  }
  return { cases, usage };
}

async function collectAdminSummary(query) {
  const q = query || {};
  const cases = await collectNurseSummary(q);
  const inventory = await collectInventorySummary(q);
  let caseMap = cases.monthlyCases || {};
  let usageMap = inventory.monthlyUsage || {};
  let unit = 'month';
  const monthCount = new Set([...Object.keys(caseMap), ...Object.keys(usageMap)]).size;
  if (monthCount < 2 && inventory.grain !== 'month') {
    const weekly = await weeklyCaseUsage(q, inventory);
    if (weekly) {
      caseMap = weekly.cases;
      usageMap = weekly.usage;
      unit = 'week';
    }
  }
  inventory.demand = describeCaseUsageRelationship(caseMap, usageMap, { unit });
  inventory.demand.monthly = Object.keys({ ...caseMap, ...usageMap }).sort().map((month) => ({
    month,
    cases: Number(caseMap[month] || 0),
    vaccineUsage: Number(usageMap[month] || 0),
  }));
  return { cases, inventory };
}

module.exports = {
  collectNurseSummary,
  collectInventorySummary,
  collectAdminSummary,
};
