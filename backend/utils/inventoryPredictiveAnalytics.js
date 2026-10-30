'use strict';

const { toSqlDate, localTodayIso, addDaysIso } = require('./dateOnly');
const { groupLotsForDisplay } = require('./inventoryBatches');
const { summarizeLotGroups } = require('./currentLotStock');
const { fetchInventoryCatalog } = require('./vaccineCatalog');
const {
  pairDailyRecords,
  usageFromDailyPair,
  fetchDailyRecordRows,
  pmAdditionalOf,
} = require('./inventoryShiftUsage');
const {
  nullableNum,
  isOpeningRecorded,
  isShiftClosed,
  shiftHasEnded,
  shiftHasStarted,
  listShiftVaccines,
} = require('./inventoryShiftStatus');
const { normalizeShift } = require('./shiftHelper');
const { linearRegression } = require('./remisAi');

const INSUFFICIENT_FORECAST =
  'Insufficient historical data for a reliable forecast. Continue collecting verified inventory records.';
const LIMITED_TREND =
  'The available data covers only a short reporting period. A reliable long-term usage trend cannot be established yet.';
const SHIFT_USAGE_NOTE =
  'Total vial usage was calculated from verified AM and PM inventory records. Shift-specific usage cannot be determined from the available data.';
const NO_RISK_ALERTS = 'No significant vaccine inventory risks detected based on the available data.';

/** Verified record days needed before any forecast is produced. */
const MIN_FORECAST_DAYS = 1;
/** Below this many verified days a forecast is preliminary and raises no depletion or high-usage alerts. */
const RELIABLE_FORECAST_DAYS = 7;
/** Verified record days (and weeks) needed for "Sufficient Data". */
const SUFFICIENT_DAYS = 28;
const REGRESSION_WEEKS = 4;
/** A trend needs at least this many weekly periods spanning this many days. */
const MIN_TREND_WEEKS = 3;
const MIN_TREND_SPAN_DAYS = 21;
const TREND_CHANGE = 0.15;
const HIGH_USAGE_FACTOR = 1.5;

const SUFFICIENCY = {
  SUFFICIENT: 'Sufficient based on current thresholds',
  LOW: 'Low-stock risk detected',
  CRITICAL: 'Critical-stock risk detected',
  DEPLETION: 'Potential depletion risk',
  UNKNOWN: 'Stock sufficiency cannot be determined',
  NO_DATA: 'Insufficient data for inventory assessment',
};

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Trend from per-period average daily usage. Returns 'Insufficient Data' unless
 * enough periods over a long enough span exist; never borrows another series.
 */
function assessTrend(values, spanDays) {
  const series = (values || []).map(num);
  const periods = series.length;
  if (periods < MIN_TREND_WEEKS || (Number(spanDays) || 0) < MIN_TREND_SPAN_DAYS) {
    return { trend: 'Insufficient Data', periods, changePct: null };
  }
  const mean = series.reduce((s, v) => s + v, 0) / periods;
  if (mean <= 0) return { trend: 'Stable', periods, changePct: 0 };
  const { slope } = linearRegression(series);
  const change = (slope * (periods - 1)) / mean;
  const trend = change > TREND_CHANGE ? 'Increasing' : change < -TREND_CHANGE ? 'Decreasing' : 'Stable';
  return { trend, periods, changePct: Math.round(change * 100) };
}

/**
 * Weekly trend when enough weeks exist; otherwise a preliminary comparison of
 * daily totals, or a single-day baseline.
 */
function trendWithFallback(weeklyValues, dailyValues, spanDays) {
  const weekly = assessTrend(weeklyValues, spanDays);
  if (weekly.trend !== 'Insufficient Data') return { ...weekly, basis: 'weekly', preliminary: false };
  const daily = (dailyValues || []).map(num);
  if (daily.length < 2) return { trend: 'Baseline', periods: daily.length, changePct: null, basis: 'baseline', preliminary: true };
  const mean = daily.reduce((s, v) => s + v, 0) / daily.length;
  if (mean <= 0) return { trend: 'Stable', periods: daily.length, changePct: 0, basis: 'daily', preliminary: true };
  const { slope, intercept } = linearRegression(daily);
  const start = intercept + slope;
  const end = intercept + slope * daily.length;
  const change = start > 0 ? (end - start) / start : (slope * (daily.length - 1)) / mean;
  const trend = change > TREND_CHANGE ? 'Increasing' : change < -TREND_CHANGE ? 'Decreasing' : 'Stable';
  return {
    trend,
    periods: daily.length,
    changePct: start > 0 ? Math.round(change * 100) : null,
    basis: 'daily',
    preliminary: true,
  };
}

function classifyDataStatus(recordedDays, weeks) {
  if (recordedDays < MIN_FORECAST_DAYS) return 'Insufficient Data';
  if (recordedDays < RELIABLE_FORECAST_DAYS) return 'Limited Data';
  if (recordedDays >= SUFFICIENT_DAYS && weeks >= REGRESSION_WEEKS) return 'Sufficient Data';
  return 'Limited Data';
}

/**
 * Forecast for one vaccine. Rates are per calendar day across the verified
 * coverage window so clinic closures inside that window are accounted for.
 */
function forecastVaccine({ hist, coverageDays, recordedDays, forecastAvailable, horizons = [7, 30, 90] }) {
  const empty = { method: 'insufficient', methodLabel: 'Not available', ratePerDay: null, values: {} };
  if (!forecastAvailable || !coverageDays) return empty;
  const weekKeys = Object.keys(hist.weekly || {}).sort();
  const operatingRatio = recordedDays / coverageDays;
  let rate;
  let method;
  let methodLabel;
  if (weekKeys.length >= REGRESSION_WEEKS) {
    const rates = weekKeys.map((k) => hist.weekly[k].used / hist.weekly[k].days.size);
    const { slope, intercept } = linearRegression(rates);
    rate = Math.max(0, intercept + slope * (rates.length + 1)) * operatingRatio;
    method = 'linear_regression';
    methodLabel = `Linear regression on weekly average daily usage (${weekKeys.length} weeks)`;
  } else {
    rate = (Number(hist.used) || 0) / coverageDays;
    method = 'daily_average';
    methodLabel = recordedDays < RELIABLE_FORECAST_DAYS
      ? `Preliminary estimate from ${coverageDays} day(s) of verified records`
      : `Average daily usage over ${coverageDays} day(s) of verified records`;
  }
  const values = {};
  horizons.forEach((h) => { values[h] = Math.round(rate * h); });
  return { method, methodLabel, ratePerDay: round2(rate), values };
}

function assessSufficiency({ lotCount, currentStock, inventoryStatus, lowAt, criticalAt, forecastAvailable, forecastUsage, horizon }) {
  if (!lotCount) return { label: SUFFICIENCY.NO_DATA, basis: 'No inventory lots are on record for this vaccine.' };
  if (inventoryStatus === 'Out of Stock' || inventoryStatus === 'Expired') {
    return { label: SUFFICIENCY.CRITICAL, basis: 'No usable stock is available.' };
  }
  if (inventoryStatus === 'Critical') {
    return { label: SUFFICIENCY.CRITICAL, basis: `Current stock (${currentStock} vials) is at or below the critical threshold (${criticalAt}).` };
  }
  if (inventoryStatus === 'Low Stock') {
    return { label: SUFFICIENCY.LOW, basis: `Current stock (${currentStock} vials) is at or below the low-stock threshold (${lowAt}).` };
  }
  if (forecastAvailable && forecastUsage > 0 && forecastUsage >= currentStock) {
    return {
      label: SUFFICIENCY.DEPLETION,
      basis: `Forecast usage for the next ${horizon} days (${forecastUsage} vials) meets or exceeds current stock (${currentStock} vials).`,
    };
  }
  if (forecastAvailable) {
    return { label: SUFFICIENCY.SUFFICIENT, basis: `Stock is above the configured thresholds and above the ${horizon}-day usage forecast.` };
  }
  return {
    label: SUFFICIENCY.UNKNOWN,
    basis: 'Future demand cannot be estimated from the verified usage on record. Current stock is above the configured thresholds, but that is not a sufficiency forecast.',
  };
}

function expirationLabel(stock) {
  if (!stock.lotCount) return 'No lots on record';
  if ((stock.expiredLotsWithStock || 0) > 0 && !(Number(stock.currentStock) > 0)) {
    return `${stock.expiredLotsWithStock} expired lot(s) on record`;
  }
  if ((stock.expiringLots || 0) > 0 && stock.nearestExpiryDays != null) {
    return `Expires in ${stock.nearestExpiryDays} days`;
  }
  if ((stock.expiringLots || 0) > 0) return 'Expiring soon';
  if ((stock.expiredLotsWithStock || 0) > 0) {
    return `${stock.expiredLotsWithStock} expired lot(s) on record`;
  }
  return 'No active lots expiring within 30 days';
}

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2 };

function highUsageRows(rows) {
  const used = rows.filter((r) => r.historicalUsage > 0);
  if (used.length < 2) return { mean: 0, rows: [] };
  const mean = used.reduce((s, r) => s + r.historicalUsage, 0) / used.length;
  return { mean, rows: used.filter((r) => r.historicalUsage >= mean * HIGH_USAGE_FACTOR) };
}

function buildRiskAlerts(rows, { horizon, totalUsed, historyAvailable = true }) {
  const alerts = [];
  const high = highUsageRows(rows);
  const highIds = new Set(high.rows.map((r) => r.vaccine_id));
  const meanUse = high.mean;
  rows.forEach((r) => {
    const add = (risk, severity, detail) => alerts.push({ vaccine: r.vaccine, risk, severity, detail });
    if (r.inventoryStatus === 'Out of Stock') add('Out of stock', 'critical', 'No usable stock is available (0 vials).');
    else if (r.inventoryStatus === 'Critical') {
      add('Critical stock', 'critical', `Current stock is ${r.currentStock} vials, at or below the critical threshold of ${r.criticalThreshold}.`);
    } else if (r.inventoryStatus === 'Low Stock') {
      add('Low stock', 'high', `Current stock is ${r.currentStock} vials, at or below the low-stock threshold of ${r.lowThreshold}.`);
    }
    if (r.expiredLotsWithStock > 0) {
      add('Expired stock', 'high', `${r.expiredLotsWithStock} expired lot(s) holding ${r.expiredQuantity} vial(s) remain on record.`);
    }
    if (r.expiringLots > 0) {
      add('Expiring stock', 'medium', r.nearestExpiryDays != null
        ? `${r.expiringLots} lot(s) expire within 30 days; the nearest expires in ${r.nearestExpiryDays} days (${r.nearestExpiryDate}).`
        : `${r.expiringLots} lot(s) expire within 30 days.`);
    }
    if (r.stockSufficiency === SUFFICIENCY.DEPLETION) {
      add('Forecast depletion', 'high', `Forecast usage for the next ${horizon} days (${r.forecastUsage} vials) meets or exceeds current stock (${r.currentStock} vials).`);
    }
    if (historyAvailable && totalUsed > 0 && highIds.has(r.vaccine_id)) {
      const share = Math.round((r.historicalUsage / totalUsed) * 100);
      add('High historical usage', 'medium', `${r.historicalUsage} vials used in the reporting period (${share}% of verified usage), well above the per-vaccine average of ${round2(meanUse)}.`);
    }
    if (r.trend === 'Increasing' && r.trendChangePct != null && !r.trendPreliminary) {
      add('Unusual usage increase', 'medium', `Weekly average daily usage rose by about ${r.trendChangePct}% across ${r.trendPeriods} weeks.`);
    }
  });
  return alerts.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    || String(a.vaccine).localeCompare(String(b.vaccine)));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function daysInclusive(from, to) {
  const a = toSqlDate(from);
  const b = toSqlDate(to);
  if (!a || !b || b < a) return 1;
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.max(1, Math.round((t2 - t1) / 86400000) + 1);
}

function isoWeekKey(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function bucketKey(ymd, grain) {
  if (!ymd) return null;
  if (grain === 'week') return isoWeekKey(ymd);
  if (grain === 'month') return String(ymd).slice(0, 7);
  return String(ymd).slice(0, 10);
}

function parseForecastDays(query = {}) {
  const n = Number(query.forecast_days || query.forecastDays || 30);
  if (n === 7 || n === 30 || n === 90) return n;
  return 30;
}

function parseAnalyticsRange(query = {}) {
  const today = localTodayIso();
  let dateFrom = toSqlDate(query.date_from || query.from);
  let dateTo = toSqlDate(query.date_to || query.to);
  if (dateFrom && dateTo && dateFrom > dateTo) {
    const err = new Error('The end date cannot be earlier than the start date.');
    err.status = 400;
    throw err;
  }
  if (!dateFrom && !dateTo) {
    dateTo = today;
    dateFrom = addDaysIso(today, -89);
  } else if (dateFrom && !dateTo) {
    dateTo = today;
  } else if (!dateFrom && dateTo) {
    dateFrom = addDaysIso(dateTo, -89);
  }
  const grainRaw = String(query.grain || query.interval || 'daily').toLowerCase();
  const grain = grainRaw === 'week' || grainRaw === 'weekly' ? 'week'
    : grainRaw === 'month' || grainRaw === 'monthly' ? 'month'
      : 'day';
  const vaccineId = query.vaccine_id ? Number(query.vaccine_id) : null;
  return {
    dateFrom,
    dateTo,
    grain,
    vaccineId: Number.isFinite(vaccineId) ? vaccineId : null,
    today,
    forecastDays: parseForecastDays(query),
  };
}

function pairUsageEligible(am, pm) {
  if (!am || !pm) return false;
  if (Number(am.opening_recorded) !== 1) return false;
  const amSt = String(am.inventory_status || '');
  const amDs = String(am.difference_status || '');
  if (amSt === 'Pending Verification' || amSt === 'Pending' || amSt === 'Pending Initial Setup') return false;
  if (amDs === 'Pending Verification') return false;
  const pmQty = pm.remaining_pm_shift;
  if (pmQty == null || pmQty === '') return false;
  const pmSt = String(pm.inventory_status || '');
  if (pmSt === 'Pending Verification' || pmSt === 'Pending') return false;
  if (String(pm.difference_status || '') === 'Pending Verification') return false;
  return true;
}

function isPendingVerificationRow(row) {
  if (!row) return false;
  return String(row.inventory_status || '') === 'Pending Verification'
    || String(row.difference_status || '') === 'Pending Verification';
}

/**
 * Status of one vaccine on one clinic day, using the Inventory module's shift windows.
 * A count is "Missing" only once its shift has ended or been closed; before that it is awaited.
 */
function classifyShiftDay({ am, pm, date, now = new Date(), closedShifts = new Set() }) {
  const amRecorded = isOpeningRecorded(am);
  const pmRecorded = isOpeningRecorded(pm) && nullableNum(pm && pm.remaining_pm_shift) != null;
  const pending = (amRecorded && isPendingVerificationRow(am)) || (pmRecorded && isPendingVerificationRow(pm));
  const amClosed = closedShifts.has(`${date}::Morning Shift`) || isShiftClosed(am);
  const pmClosed = closedShifts.has(`${date}::Afternoon Shift`) || isShiftClosed(pm);
  const amDue = amClosed || pmRecorded || shiftHasEnded(date, 'Morning Shift', now);
  const pmDue = pmClosed || shiftHasEnded(date, 'Afternoon Shift', now);
  const missingAm = !amRecorded && amDue;
  const missingPm = !pmRecorded && pmDue;
  let status;
  if (pending) status = 'Pending Verification';
  else if (missingAm && missingPm) status = 'Missing Count – AM & PM';
  else if (missingAm) status = 'Missing Count – AM';
  else if (missingPm) status = 'Missing Count – PM';
  else if (!amRecorded) status = 'Awaiting AM';
  else if (!pmRecorded) status = 'Awaiting PM';
  else status = 'Recorded';
  return { status, amRecorded, pmRecorded, pending, missingAm, missingPm };
}

function vaccineStatusFromStock({ currentStock, lowAt, criticalAt }) {
  const qty = Number(currentStock);
  const stock = Number.isFinite(qty) ? qty : 0;
  const low = Number(lowAt);
  const critical = Number(criticalAt);
  const lowN = Number.isFinite(low) && low > 0 ? low : null;
  const criticalN = Number.isFinite(critical) && critical > 0 ? critical : null;
  if (stock <= 0) return 'Out of Stock';
  if (criticalN != null && stock <= criticalN) return 'Critical';
  if (lowN != null && stock <= lowN) return 'Low Stock';
  return 'Available';
}

function configuredThreshold(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const f = Number(fallback);
  return Number.isFinite(f) && f > 0 ? f : null;
}

const EXPIRY_WARNING_DAYS = 30;
const INACTIVE_LOT_STATUSES = new Set(['Quarantined', 'Disposed', 'Returned']);

function lotIsInactive(lot) {
  const status = String((lot && (lot.lot_status || lot.batch_status)) || '').trim();
  return INACTIVE_LOT_STATUSES.has(status);
}

/**
 * One pass over grouped lots. Cards, Stock per Vaccine, and the stock chart
 * all read this result. Additional receipts are not added on top of usable quantity.
 */
function aggregateInventoryLots(lots, {
  today = localTodayIso(),
  defaults = {},
  warningDays = EXPIRY_WARNING_DAYS,
  vaccineId = null,
} = {}) {
  const warning = Number(warningDays) > 0 ? Number(warningDays) : EXPIRY_WARNING_DAYS;
  const horizon = addDaysIso(today, warning);
  const wanted = vaccineId ? Number(vaccineId) : null;
  const grouped = groupLotsForDisplay(lots || [], today).filter((lot) => {
    const id = Number(lot.vaccine_id);
    if (!id) return false;
    if (wanted && id !== wanted) return false;
    return !lotIsInactive(lot);
  });

  const byVaccine = new Map();
  const classified = [];
  const cards = {
    currentUsableStock: 0,
    lowStockLots: 0,
    criticalStockLots: 0,
    outOfStockLots: 0,
    expiringLots: 0,
    expiredLots: 0,
  };

  for (const lot of grouped) {
    const id = Number(lot.vaccine_id);
    const name = lot.vaccine_name || lot.name || 'Unknown';
    const lowAt = configuredThreshold(lot.low_stock_threshold, defaults.lowThreshold);
    const criticalAt = configuredThreshold(lot.critical_stock_threshold, defaults.criticalThreshold);
    const usable = Number(lot.usable_quantity) || 0;
    const quantity = Number(lot.quantity) || 0;
    const exp = toSqlDate(lot.expiry_date);
    const expired = !!(exp && today && exp < today) || lot.batch_status === 'Expired';
    let lotStockStatus = 'Available';
    if (expired) lotStockStatus = 'Expired';
    else if (usable <= 0) lotStockStatus = 'Out of Stock';
    else if (criticalAt != null && usable <= criticalAt) lotStockStatus = 'Critical';
    else if (lowAt != null && usable <= lowAt) lotStockStatus = 'Low Stock';
    const expiring = !expired && usable > 0 && !!(exp && horizon && exp >= today && exp <= horizon);

    if (!expired) cards.currentUsableStock += usable;
    if (lotStockStatus === 'Expired') cards.expiredLots += 1;
    if (expiring) cards.expiringLots += 1;

    classified.push({
      inventory_id: lot.inventory_id,
      vaccine_id: id,
      vaccine: name,
      usable,
      quantity,
      expired,
      expiring,
      lotStockStatus,
      lowAt,
      criticalAt,
    });

    const cur = byVaccine.get(id) || {
      vaccine_id: id,
      vaccine: name,
      currentStock: 0,
      lowStock: false,
      criticalStock: false,
      expiredLots: 0,
      expiringLots: 0,
      lotCount: 0,
      minThreshold: lowAt,
      criticalThreshold: criticalAt,
    };
    cur.vaccine = name;
    cur.lotCount += 1;
    cur.currentStock += expired ? 0 : usable;
    if (lowAt != null && (cur.thresholdUsable == null || usable >= cur.thresholdUsable)) {
      cur.minThreshold = lowAt;
      cur.criticalThreshold = criticalAt;
      cur.thresholdUsable = usable;
    }
    if (lotStockStatus === 'Low Stock') cur.lowStock = true;
    if (lotStockStatus === 'Critical') cur.criticalStock = true;
    if (lotStockStatus === 'Out of Stock') cur.outOfStock = true;
    if (expired) {
      cur.expiredLots += 1;
      if (quantity > 0) {
        cur.expiredLotsWithStock = (cur.expiredLotsWithStock || 0) + 1;
        cur.expiredQuantity = (cur.expiredQuantity || 0) + quantity;
      }
    }
    if (expiring) {
      cur.expiringLots += 1;
      const days = daysInclusive(today, exp) - 1;
      if (cur.nearestExpiryDays == null || days < cur.nearestExpiryDays) {
        cur.nearestExpiryDays = days;
        cur.nearestExpiryDate = exp;
      }
    }
    byVaccine.set(id, cur);
  }

  cards.lowStockLots = 0;
  cards.criticalStockLots = 0;
  cards.outOfStockLots = 0;
  for (const row of byVaccine.values()) {
    const status = vaccineStatusFromStock({
      currentStock: row.currentStock,
      lowAt: row.minThreshold,
      criticalAt: row.criticalThreshold,
    });
    row.lowStock = status === 'Low Stock';
    row.criticalStock = status === 'Critical';
    row.outOfStock = status === 'Out of Stock';
    if (status === 'Low Stock') cards.lowStockLots += 1;
    else if (status === 'Critical') cards.criticalStockLots += 1;
    else if (status === 'Out of Stock') cards.outOfStockLots += 1;
  }

  const sumCurrentLotStock = classified.reduce((sum, lot) => sum + (lot.expired ? 0 : lot.usable), 0);
  const sumStockPerVaccine = [...byVaccine.values()].reduce((sum, row) => sum + (Number(row.currentStock) || 0), 0);
  const lotSummary = summarizeLotGroups(grouped, today);
  const summaryExpiring = (lotSummary.counts.expiring_30 || 0)
    + (lotSummary.counts.expiring_15 || 0)
    + (lotSummary.counts.expiring_7 || 0);
  const mismatches = [];
  if (cards.currentUsableStock !== sumCurrentLotStock) {
    mismatches.push(`Current Usable Stock (${cards.currentUsableStock}) does not equal the sum of usable lot quantities (${sumCurrentLotStock}).`);
  }
  if (cards.currentUsableStock !== sumStockPerVaccine) {
    mismatches.push(`Current Usable Stock (${cards.currentUsableStock}) does not equal the sum of Stock per Vaccine (${sumStockPerVaccine}).`);
  }
  if (cards.currentUsableStock !== lotSummary.counts.total_stock) {
    mismatches.push(`Current Usable Stock (${cards.currentUsableStock}) does not equal Current Lot Stock total_stock (${lotSummary.counts.total_stock}).`);
  }
  const currentStockCards = { low: 0, critical: 0, out: 0 };
  for (const row of byVaccine.values()) {
    const status = vaccineStatusFromStock({
      currentStock: row.currentStock,
      lowAt: row.minThreshold,
      criticalAt: row.criticalThreshold,
    });
    if (status === 'Low Stock') currentStockCards.low += 1;
    else if (status === 'Critical') currentStockCards.critical += 1;
    else if (status === 'Out of Stock') currentStockCards.out += 1;
  }
  if (cards.lowStockLots !== currentStockCards.low) {
    mismatches.push(`Low-Stock Lots (${cards.lowStockLots}) does not equal vaccines whose current stock is low (${currentStockCards.low}).`);
  }
  if (cards.criticalStockLots !== currentStockCards.critical) {
    mismatches.push(`Critical-Stock Lots (${cards.criticalStockLots}) does not equal vaccines whose current stock is critical (${currentStockCards.critical}).`);
  }
  if (cards.outOfStockLots !== currentStockCards.out) {
    mismatches.push(`Out-of-Stock Lots (${cards.outOfStockLots}) does not equal vaccines whose current stock is zero (${currentStockCards.out}).`);
  }
  if (cards.expiredLots !== lotSummary.counts.expired_count) {
    mismatches.push(`Expired Lots (${cards.expiredLots}) does not equal Current Lot Stock expired_count (${lotSummary.counts.expired_count}).`);
  }
  if (cards.expiringLots !== summaryExpiring) {
    mismatches.push(`Expiring Lots (${cards.expiringLots}) does not equal Current Lot Stock lots expiring within 30 days (${summaryExpiring}).`);
  }

  return {
    lots: classified,
    byVaccine,
    ...cards,
    warningDays: warning,
    consistency: {
      ok: mismatches.length === 0,
      currentUsableStock: cards.currentUsableStock,
      sumCurrentLotStock,
      sumStockPerVaccine,
      currentLotStockTotal: lotSummary.counts.total_stock,
      mismatches,
    },
  };
}

const RECEIPT_TYPES = new Set(['Stock In', 'Returned Vaccine']);
const OPENING_TYPES = new Set(['Initial Opening Balance']);
const USAGE_TYPES = new Set(['Vaccine Usage', 'Usage', 'Stock Out', 'Damaged Vaccine', 'Expired Vaccine']);

function movementQuantity(row) {
  const corrected = row && row.corrected_quantity;
  const raw = corrected != null && corrected !== '' ? corrected : row && row.quantity;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function receiptKeyOf(notes) {
  const match = String(notes || '').match(/\[receipt-key:([^\]]+)\]/i);
  return match ? match[1] : null;
}

/**
 * One row per inventory transaction. A repeated receipt key is the same delivery.
 * A sheet-usage restore reverses an over-deducted usage row; it is not a new receipt.
 */
function summarizeMovements(transactions, { dateFrom, dateTo, today = null } = {}) {
  const byVaccine = new Map();
  const seenId = new Set();
  const seenReceipt = new Set();
  for (const row of transactions || []) {
    const id = row && row.transaction_id;
    if (id != null && seenId.has(id)) continue;
    if (id != null) seenId.add(id);
    const type = String((row && row.transaction_type) || '');
    const notes = String((row && row.notes) || '');
    if (notes.includes('count-correction-audit:')) continue;
    if (notes.includes('lot-receipt-sync:') && (RECEIPT_TYPES.has(type) || OPENING_TYPES.has(type))) continue;
    const key = receiptKeyOf(row && row.notes);
    if (key && (RECEIPT_TYPES.has(type) || OPENING_TYPES.has(type))) {
      const stamp = `${Number(row.vaccine_id)}::${key}`;
      if (seenReceipt.has(stamp)) continue;
      seenReceipt.add(stamp);
    }
    const vid = Number(row && row.vaccine_id);
    if (!vid) continue;
    const cur = byVaccine.get(vid) || {
      opening: 0, additional: 0, used: 0, corrections: 0, periodAdditional: 0, additionalToday: 0,
      additionalByDay: {},
    };
    const qty = movementQuantity(row);
    const day = toSqlDate(row.transaction_date || row.date_added);
    const inPeriod = (!dateFrom || (day && day >= dateFrom)) && (!dateTo || (day && day <= dateTo));
    if (OPENING_TYPES.has(type)) cur.opening += Math.abs(qty);
    else if (RECEIPT_TYPES.has(type)) {
      cur.additional += Math.abs(qty);
      if (inPeriod) {
        cur.periodAdditional += Math.abs(qty);
        if (day) cur.additionalByDay[day] = (cur.additionalByDay[day] || 0) + Math.abs(qty);
      }
      if (inPeriod && today && day === today) cur.additionalToday += Math.abs(qty);
    } else if (USAGE_TYPES.has(type)) cur.used += Math.abs(qty);
    else if (type === 'Adjustment') {
      if (/sheet-usage-restore/i.test(notes)) cur.used -= Math.abs(qty);
      else if (/physical-count-correction-restore:/i.test(notes)) cur.corrections += Math.abs(qty);
      else if (/physical-count-correction:/i.test(notes)) cur.corrections -= Math.abs(qty);
      else cur.corrections += qty;
    }
    byVaccine.set(vid, cur);
  }
  return byVaccine;
}

function stockCalculationOf(ledger, currentStock) {
  if (!ledger) return null;
  return {
    openingStock: ledger.opening,
    additionalStock: ledger.additional,
    vaccinesUsed: ledger.used,
    corrections: ledger.corrections,
    currentStock,
  };
}

/**
 * Current stock is the sum of usable lot quantities.
 * Additional stock in the reporting period is reported separately and is not added again.
 */
function buildClinicUsageAnalytics({
  dailyRows,
  lots,
  transactions = null,
  dateFrom,
  dateTo,
  grain = 'day',
  vaccineId = null,
  today = localTodayIso(),
  stockInToday = 0,
  transactionsToday = 0,
  forecastDays = 30,
  expectedVaccines = null,
  closures = [],
  now = new Date(),
  thresholdDefaults = null,
}) {
  const horizon = (forecastDays === 7 || forecastDays === 90) ? forecastDays : 30;
  const aggregated = aggregateInventoryLots(lots, {
    today,
    defaults: thresholdDefaults || {},
    warningDays: thresholdDefaults && thresholdDefaults.expiryWarningDays,
    vaccineId,
  });
  const stockMap = aggregated.byVaccine;
  if (aggregated.consistency && !aggregated.consistency.ok) {
    console.warn('[inventory-consistency]', aggregated.consistency.mismatches.join(' '));
  }
  const receiptsFromLedger = Array.isArray(transactions);
  const ledger = summarizeMovements(transactions || [], { dateFrom, dateTo, today });

  const byPeriod = new Map();
  const byVaccine = new Map();
  const byMonthVaccine = new Map();
  const byMonth = new Map();
  const byMonthAdd = new Map();
  let totalUsed = 0;
  let totalAdditional = 0;
  let usedToday = 0;
  let additionalToday = 0;
  let recordsAnalyzed = 0;
  const usageDays = new Set();
  const verifiedDays = new Set();
  const clinicWeekly = new Map();
  const clinicDaily = new Map();
  const amPmRows = [];
  const amPm = {
    completed: 0,
    missingAm: 0,
    missingPm: 0,
    pendingVerification: 0,
    awaitingAm: 0,
    awaitingPm: 0,
    incomplete: 0,
    inconsistencies: 0,
    expectedVaccineDays: 0,
    operatingDays: 0,
    rows: [],
  };

  const closedShifts = new Set((closures || [])
    .filter((c) => String(c.shift_status || '').toLowerCase() === 'closed')
    .map((c) => `${toSqlDate(c.shift_date)}::${normalizeShift(c.shift)}`));
  const pairs = pairDailyRecords(dailyRows);
  
  // Track which vaccine-days have had Additional counted to prevent double counting
  // Bug fix: Additional stock should only be counted once per vaccine per day
  const additionalCounted = new Set();
  // A clinic day is expected to have AM and PM counts for every tracked vaccine once any count was saved that day (or it is today and the AM shift has started).
  if (Array.isArray(expectedVaccines)) {
    const lastDay = dateTo && dateTo < today ? dateTo : today;
    const days = new Set([...pairs.values()].map((p) => p.record_date).filter((d) => d <= lastDay));
    if ((!dateFrom || dateFrom <= today) && (!dateTo || today <= dateTo) && shiftHasStarted(today, 'Morning Shift', now)) {
      days.add(today);
    }
    amPm.operatingDays = days.size;
    for (const day of days) {
      for (const v of expectedVaccines) {
        const key = `${day}::${v.vaccine_id}`;
        if (!pairs.has(key)) {
          pairs.set(key, { am: null, pm: null, vaccine_id: v.vaccine_id, record_date: day, vaccine_name: v.name });
        }
      }
    }
  }

  for (const pair of pairs.values()) {
    if (vaccineId && Number(pair.vaccine_id) !== Number(vaccineId)) continue;
    const shiftDay = classifyShiftDay({ am: pair.am, pm: pair.pm, date: pair.record_date, now, closedShifts });
    const eligible = !shiftDay.pending && pairUsageEligible(pair.am, pair.pm);
    const usage = eligible ? usageFromDailyPair(pair.am, pair.pm) : { total_vaccine_used: 0 };
    const usedRaw = usage.total_vaccine_used;
    const used = usedRaw == null ? 0 : num(usedRaw);
    const additional = pair.am ? num(pair.am.additional_vaccine) : 0;
    const pmAdditional = pmAdditionalOf(pair.am, pair.pm);
    const day = pair.record_date;
    const vid = Number(pair.vaccine_id);
    const name = (pair.am && (pair.am.vaccine_name || pair.am.name))
      || (pair.pm && (pair.pm.vaccine_name || pair.pm.name))
      || pair.vaccine_name
      || (stockMap.get(vid) && stockMap.get(vid).vaccine)
      || `Vaccine ${vid}`;

    let status = shiftDay.status;
    if (status === 'Recorded') status = eligible ? (used < 0 ? 'Inconsistent' : 'Completed') : 'Incomplete';
    amPm.expectedVaccineDays += 1;
    if (shiftDay.pending) amPm.pendingVerification += 1;
    if (shiftDay.missingAm) amPm.missingAm += 1;
    if (shiftDay.missingPm) amPm.missingPm += 1;
    if (status === 'Awaiting AM') amPm.awaitingAm += 1;
    if (status === 'Awaiting PM') amPm.awaitingPm += 1;
    if (status === 'Incomplete') amPm.incomplete += 1;
    if (eligible) amPm.completed += 1;
    if (eligible && used < 0) amPm.inconsistencies += 1;
    recordsAnalyzed += (pair.am ? 1 : 0) + (pair.pm ? 1 : 0);
    amPmRows.push({
      date: day,
      vaccine: name,
      am: shiftDay.amRecorded
        ? nullableNum(pair.am.physical_count != null ? pair.am.physical_count : pair.am.morning_shift_inventory)
        : null,
      additional,
      pm_additional: pmAdditional,
      pm: shiftDay.pmRecorded ? nullableNum(pair.pm.remaining_pm_shift) : null,
      used: eligible ? used : null,
      amRecordedBy: (pair.am && pair.am.recorded_by_name) || null,
      pmRecordedBy: (pair.pm && pair.pm.recorded_by_name) || null,
      status,
    });
    if (eligible) {
      verifiedDays.add(day);
      const week = bucketKey(day, 'week');
      const cw = clinicWeekly.get(week) || { used: 0, days: new Set() };
      cw.used += used;
      cw.days.add(day);
      clinicWeekly.set(week, cw);
      const v = byVaccine.get(vid) || { vaccine_id: vid, vaccine: name, used: 0, additional: 0, months: {} };
      v.days = v.days || new Set();
      v.weekly = v.weekly || {};
      v.days.add(day);
      v.daily = v.daily || {};
      v.daily[day] = (v.daily[day] || 0) + used;
      clinicDaily.set(day, (clinicDaily.get(day) || 0) + used);
      const vw = v.weekly[week] || { used: 0, days: new Set() };
      vw.used += used;
      vw.days.add(day);
      v.weekly[week] = vw;
      byVaccine.set(vid, v);
    }

    if (used !== 0 || additional !== 0 || pair.am || pair.pm) {
      const countedAdditional = receiptsFromLedger ? 0 : additional;
      
      // Bug fix: Only count Additional once per vaccine-day to prevent double counting
      // When the same vaccine-day pair is processed multiple times, we track it
      const additionalKey = `${vid}::${day}`;
      const shouldCountAdditional = countedAdditional > 0 && !additionalCounted.has(additionalKey);
      if (shouldCountAdditional) {
        additionalCounted.add(additionalKey);
      }
      
      if (eligible && used !== 0) usageDays.add(day);
      if (eligible) totalUsed += used;
      
      // Only add to totals if this is the first time we're counting this vaccine-day's Additional
      if (shouldCountAdditional) {
        totalAdditional += countedAdditional;
      }
      
      if (day === today) {
        if (eligible) usedToday += used;
        if (shouldCountAdditional) {
          additionalToday += countedAdditional;
        }
      }

      const period = bucketKey(day, grain);
      if (period) {
        const cur = byPeriod.get(period) || { period, used: 0, additional: 0 };
        cur.used += used;
        if (shouldCountAdditional) {
          cur.additional += countedAdditional;
        }
        byPeriod.set(period, cur);
      }

      const month = String(day).slice(0, 7);
      byMonth.set(month, (byMonth.get(month) || 0) + used);
      if (shouldCountAdditional) {
        byMonthAdd.set(month, (byMonthAdd.get(month) || 0) + countedAdditional);
      }

      const v = byVaccine.get(vid) || { vaccine_id: vid, vaccine: name, used: 0, additional: 0, months: {} };
      v.vaccine = name;
      v.used += used;
      if (shouldCountAdditional) {
        v.additional += countedAdditional;
      }
      v.months[month] = (v.months[month] || 0) + used;
      byVaccine.set(vid, v);

      const mk = `${vid}::${month}`;
      byMonthVaccine.set(mk, (byMonthVaccine.get(mk) || 0) + used);
    }
  }

  if (receiptsFromLedger) {
    totalAdditional = 0;
    additionalToday = 0;
    for (const [vid, led] of ledger) {
      if (vaccineId && Number(vid) !== Number(vaccineId)) continue;
      totalAdditional += led.periodAdditional;
      additionalToday += led.additionalToday || 0;
      // Sheet additional is already inside the verified AM count. The trend line
      // uses ledger receipts (Stock In / Returned Vaccine), one point per period.
      for (const [day, qty] of Object.entries(led.additionalByDay || {})) {
        const period = bucketKey(day, grain);
        if (!period || !qty) continue;
        const cur = byPeriod.get(period) || { period, used: 0, additional: 0 };
        cur.additional += qty;
        byPeriod.set(period, cur);
        const month = String(day).slice(0, 7);
        byMonthAdd.set(month, (byMonthAdd.get(month) || 0) + qty);
      }
    }
  }

  const usageSeries = [...byPeriod.values()].sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const monthlyUsage = {};
  [...byMonth.keys()].sort().forEach((m) => { monthlyUsage[m] = byMonth.get(m); });

  const sortedDays = [...verifiedDays].sort();
  const firstRecordDate = sortedDays[0] || null;
  const lastRecordDate = sortedDays[sortedDays.length - 1] || null;
  const recordedDays = sortedDays.length;
  const coverageDays = firstRecordDate ? daysInclusive(firstRecordDate, lastRecordDate) : 0;
  const weekKeys = [...clinicWeekly.keys()].sort();
  const dataStatus = classifyDataStatus(recordedDays, weekKeys.length);
  const forecastAvailable = dataStatus !== 'Insufficient Data';
  const overallTrend = trendWithFallback(
    weekKeys.map((k) => clinicWeekly.get(k).used / clinicWeekly.get(k).days.size),
    sortedDays.map((d) => clinicDaily.get(d) || 0),
    coverageDays
  );
  const averageDailyUsage = recordedDays ? round2(totalUsed / recordedDays) : 0;
  const forecastPeriod = `Next ${horizon} days`;

  const catalogNames = new Map();
  for (const v of expectedVaccines || []) {
    if (v && v.vaccine_id != null) catalogNames.set(Number(v.vaccine_id), v.name);
  }
  const ids = vaccineId
    ? new Set([Number(vaccineId)])
    : new Set([...stockMap.keys(), ...byVaccine.keys(), ...catalogNames.keys()]);

  const forecast = [];
  const usageTrends = [];
  const rapidlyIncreasing = [];
  const monitoringRows = [];
  let mostUsed = null;
  let mostUsedQty = -1;

  ids.forEach((id) => {
    const stock = stockMap.get(Number(id)) || {
      vaccine_id: Number(id),
      vaccine: `Vaccine ${id}`,
      currentStock: 0,
      lowStock: false,
      criticalStock: false,
      expiredLots: 0,
      expiringLots: 0,
      lotCount: 0,
      minThreshold: configuredThreshold(null, thresholdDefaults && thresholdDefaults.lowThreshold),
      criticalThreshold: configuredThreshold(null, thresholdDefaults && thresholdDefaults.criticalThreshold),
    };
    const hist = byVaccine.get(Number(id)) || { vaccine: stock.vaccine, used: 0, additional: 0, months: {}, weekly: {} };
    const vaccine = catalogNames.get(Number(id)) || hist.vaccine || stock.vaccine;
    const vDays = hist.days ? hist.days.size : 0;
    const perRecordedDay = vDays ? round2(hist.used / vDays) : 0;
    const vWeeks = Object.keys(hist.weekly || {}).sort();
    const trendInfo = trendWithFallback(
      vWeeks.map((k) => hist.weekly[k].used / hist.weekly[k].days.size),
      Object.keys(hist.daily || {}).sort().map((k) => hist.daily[k]),
      coverageDays
    );
    const fc = forecastVaccine({ hist, coverageDays, recordedDays, forecastAvailable });
    const forecastUsage = fc.method === 'insufficient' ? null : fc.values[horizon];

    const currentStock = Number(stock.currentStock) || 0;
    const led = ledger.get(Number(id));
    const additionalReceived = receiptsFromLedger ? (led ? led.periodAdditional : 0) : hist.additional;
    const stockCalculation = stockCalculationOf(led, currentStock);
    const inventoryStatus = vaccineStatusFromStock({
      currentStock,
      lowAt: stock.minThreshold,
      criticalAt: stock.criticalThreshold,
    });
    const sufficiency = assessSufficiency({
      lotCount: stock.lotCount,
      currentStock,
      inventoryStatus,
      lowAt: stock.minThreshold,
      criticalAt: stock.criticalThreshold,
      forecastAvailable: fc.method !== 'insufficient' && recordedDays >= RELIABLE_FORECAST_DAYS,
      forecastUsage,
      horizon,
    });
    const daysOfStock = fc.ratePerDay > 0 ? Math.floor(currentStock / fc.ratePerDay) : null;
    const warning = inventoryStatus === 'Critical' ? 'Critical stock — replenishment recommended'
      : inventoryStatus === 'Low Stock' ? 'Low stock — monitor replenishment'
        : inventoryStatus === 'Out of Stock' ? 'Out of stock'
          : sufficiency.label === SUFFICIENCY.DEPLETION ? 'Current stock is below the estimated forecast usage'
            : (stock.expiringLots || 0) > 0 ? 'Lots approaching expiration'
              : null;

    const tracked = currentStock > 0 || hist.used > 0 || (stock.lotCount || 0) > 0 || catalogNames.has(Number(id));
    if (!tracked) return;
      const row = {
        vaccine,
        vaccine_id: Number(id),
        currentStock,
        historicalUsage: hist.used,
        additionalReceived,
        stockCalculation,
        recordedDays: vDays,
        averageDailyUsage: perRecordedDay,
        dailyUsage: perRecordedDay,
        forecastRatePerDay: fc.ratePerDay,
        estimatedForecastUsage: forecastUsage,
        forecastUsage,
        forecasts: fc.values,
        forecastLabel: 'estimated',
        forecastMethod: fc.method,
        forecastMethodLabel: fc.methodLabel,
        forecastPeriod,
        estimatedRemainingStock: forecastUsage == null ? null : Math.max(0, currentStock - forecastUsage),
        estimatedDaysOfStock: daysOfStock,
        inventoryStatus,
        stockSufficiency: sufficiency.label,
        sufficiencyBasis: sufficiency.basis,
        expirationStatus: expirationLabel(stock),
        expiredLotsWithStock: stock.expiredLotsWithStock || 0,
        expiredQuantity: stock.expiredQuantity || 0,
        expiringLots: stock.expiringLots || 0,
        nearestExpiryDays: stock.nearestExpiryDays ?? null,
        nearestExpiryDate: stock.nearestExpiryDate || null,
        lowThreshold: stock.minThreshold,
        criticalThreshold: stock.criticalThreshold,
        monthlyUsage: hist.used,
        monthlyUsageByMonth: hist.months,
        trend: trendInfo.trend,
        trendChangePct: trendInfo.changePct,
        trendPreliminary: trendInfo.preliminary,
        trendBasis: trendInfo.basis,
        trendPeriods: trendInfo.periods,
        replenishmentWarning: [SUFFICIENCY.LOW, SUFFICIENCY.CRITICAL, SUFFICIENCY.DEPLETION].includes(sufficiency.label),
        warning,
        alert: warning,
        dataLimitations: fc.method === 'insufficient' ? INSUFFICIENT_FORECAST
          : `${fc.methodLabel}. Forecast is an estimate, not a guaranteed quantity.`,
        dataSufficient: fc.method !== 'insufficient',
        stockSource: 'vaccine_inventory usable lot quantity',
      };
      if (currentStock > 0 || hist.used > 0 || (stock.lotCount || 0) > 0) {
        forecast.push(row);
        usageTrends.push({
          vaccine,
          trend: trendInfo.trend,
          changePct: trendInfo.changePct,
          periods: trendInfo.periods,
          preliminary: trendInfo.preliminary,
          basis: trendInfo.basis,
          monthlyUsage: hist.used,
          historicalUsage: hist.used,
          averageDailyUsage: perRecordedDay,
        });
        if (trendInfo.trend === 'Increasing' && !trendInfo.preliminary) rapidlyIncreasing.push(vaccine);
      }
      monitoringRows.push({
        vaccine,
        vaccine_id: Number(id),
        currentStock,
        historicalUsage: hist.used,
        additionalReceived,
        stockCalculation,
        inventoryStatus,
        stockSufficiency: sufficiency.label,
        sufficiencyBasis: sufficiency.basis,
        expirationStatus: row.expirationStatus,
        lowThreshold: stock.minThreshold,
        criticalThreshold: stock.criticalThreshold,
        expiredLots: stock.expiredLotsWithStock || 0,
        expiringLots: stock.expiringLots || 0,
        alert: warning,
      });
    if (hist.used > mostUsedQty) {
      mostUsedQty = hist.used;
      mostUsed = vaccine;
    }
  });

  forecast.sort((a, b) => (b.historicalUsage - a.historicalUsage) || String(a.vaccine).localeCompare(String(b.vaccine)));
  usageTrends.sort((a, b) => String(a.vaccine).localeCompare(String(b.vaccine)));

  const riskAlerts = buildRiskAlerts(forecast, { horizon, totalUsed, historyAvailable: recordedDays >= RELIABLE_FORECAST_DAYS });
  const highUsageVaccines = highUsageRows(forecast).rows.map((r) => ({
    vaccine: r.vaccine,
    historicalUsage: r.historicalUsage,
    sharePct: totalUsed ? Math.round((r.historicalUsage / totalUsed) * 100) : 0,
  }));
  const remaining = aggregated.currentUsableStock;

  const overallSufficiency = !forecast.length ? SUFFICIENCY.NO_DATA
    : forecast.some((r) => r.stockSufficiency === SUFFICIENCY.CRITICAL) ? SUFFICIENCY.CRITICAL
      : forecast.some((r) => r.stockSufficiency === SUFFICIENCY.DEPLETION) ? SUFFICIENCY.DEPLETION
        : forecast.some((r) => r.stockSufficiency === SUFFICIENCY.LOW) ? SUFFICIENCY.LOW
          : forecast.some((r) => r.stockSufficiency === SUFFICIENCY.UNKNOWN || r.stockSufficiency === SUFFICIENCY.NO_DATA) ? SUFFICIENCY.UNKNOWN
            : SUFFICIENCY.SUFFICIENT;

  const dataLimitations = [];
  if (!recordedDays) {
    dataLimitations.push('No verified AM/PM inventory records were found for the selected period.');
  } else if (recordedDays < RELIABLE_FORECAST_DAYS) {
    dataLimitations.push(`Forecasts are preliminary estimates from ${recordedDays} day(s) of verified records (${firstRecordDate} to ${lastRecordDate}). Accuracy improves as more daily AM/PM records are collected.`);
  } else if (dataStatus === 'Limited Data') {
    dataLimitations.push(`Forecasts are based on ${recordedDays} day(s) of verified records and should be treated as rough estimates.`);
  }
  if (overallTrend.basis === 'daily') {
    dataLimitations.push(`Usage trends are preliminary day-to-day comparisons across ${recordedDays} day(s) of verified records. A reliable weekly trend needs ${MIN_TREND_WEEKS} weeks of records.`);
  } else if (overallTrend.basis === 'baseline' && recordedDays) {
    dataLimitations.push('Usage from the first day of records is shown as a baseline. Trends appear once a second day of verified records is available.');
  }
  dataLimitations.push(SHIFT_USAGE_NOTE);
  if (amPm.missingAm) dataLimitations.push(`${amPm.missingAm} vaccine-day(s) have no AM count after the AM shift ended and are excluded from usage.`);
  if (amPm.missingPm) dataLimitations.push(`${amPm.missingPm} vaccine-day(s) have no PM count after the PM shift ended and are excluded from usage.`);
  if (amPm.pendingVerification) dataLimitations.push(`${amPm.pendingVerification} record(s) are pending verification and are excluded from usage.`);
  if (forecastAvailable) {
    dataLimitations.push('Forecasts assume future usage follows the recorded pattern and do not account for outbreaks, holidays or supply changes.');
  }

  const dataQuality = {
    status: dataStatus,
    labels: [dataStatus, ...(forecastAvailable ? [] : ['Forecast Unavailable'])],
    reportingPeriod: { startDate: dateFrom, endDate: dateTo },
    firstRecordDate,
    lastRecordDate,
    coverageDays,
    recordedDays,
    weeksWithRecords: weekKeys.length,
    recordsAnalyzed,
    completedPairs: amPm.completed,
    missingAm: amPm.missingAm,
    missingPm: amPm.missingPm,
    pendingVerification: amPm.pendingVerification,
    forecastAvailable,
    trendAvailable: overallTrend.basis === 'weekly',
    trendPreliminary: overallTrend.basis === 'daily',
    sufficiencyStatus: overallSufficiency,
    requirements: {
      forecastMinDays: MIN_FORECAST_DAYS,
      reliableForecastDays: RELIABLE_FORECAST_DAYS,
      sufficientDays: SUFFICIENT_DAYS,
      trendMinWeeks: MIN_TREND_WEEKS,
      trendMinSpanDays: MIN_TREND_SPAN_DAYS,
    },
  };

  const statusRank = (s) => (s === 'Completed' ? 1 : 0);
  amPm.rows = amPmRows
    .sort((a, b) => String(b.date).localeCompare(String(a.date))
      || statusRank(a.status) - statusRank(b.status)
      || String(a.vaccine).localeCompare(String(b.vaccine)))
    .slice(0, 60);
  amPm.totalRows = amPmRows.length;
  amPm.missingTotal = amPm.missingAm + amPm.missingPm;

  const stockStatusCounts = { low: 0, critical: 0, out: 0 };
  for (const row of monitoringRows) {
    if (row.inventoryStatus === 'Low Stock') stockStatusCounts.low += 1;
    else if (row.inventoryStatus === 'Critical') stockStatusCounts.critical += 1;
    else if (row.inventoryStatus === 'Out of Stock') stockStatusCounts.out += 1;
  }

  return {
    inventoryDate: today,
    dateFrom,
    dateTo,
    grain,
    forecastDays: horizon,
    source: 'vaccine_inventory_management',
    usageDefinition: 'Verified clinic usage = verified AM count + PM additional stock − PM count. AM additional stock is already inside the verified AM count and is not added again. Stock on hand comes from lot quantities, not from adding the sheet fields together.',
    remainingInventory: remaining,
    vaccinesUsedToday: usedToday,
    additionalVaccinesReceivedToday: additionalToday,
    additionalVaccinesReceived: totalAdditional,
    transactionsToday: num(transactionsToday),
    lowStockItems: stockStatusCounts.low,
    criticalStockItems: stockStatusCounts.critical,
    expiringSoonItems: aggregated.expiringLots,
    expiringItems: aggregated.expiringLots,
    expiredItems: aggregated.expiredLots,
    outOfStockItems: stockStatusCounts.out,
    inventoryConsistency: aggregated.consistency,
    mostUsedVaccine: mostUsedQty > 0 ? mostUsed : null,
    totalVaccinesUsed: totalUsed,
    averageDailyUsage,
    usageDaysWithConsumption: usageDays.size,
    inventoryTrend: `${overallTrend.trend.toLowerCase()}${overallTrend.basis === 'daily' ? ' (preliminary)' : ''}`,
    overallTrend,
    usageByBrand: [...byVaccine.values()]
      .map((v) => ({ brand: v.vaccine, qty: v.used }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 12),
    usageSeries,
    forecast,
    usageTrends,
    riskAlerts,
    noRiskMessage: riskAlerts.length ? null : NO_RISK_ALERTS,
    highUsageVaccines,
    dataQuality,
    dataLimitations,
    forecastNote: !forecastAvailable
      ? 'No verified AM/PM inventory records were found for the selected period. Forecasts appear once daily AM and PM counts are recorded.'
      : recordedDays < RELIABLE_FORECAST_DAYS
        ? `Preliminary forecast based on ${recordedDays} day(s) of verified records (${firstRecordDate} to ${lastRecordDate}). Estimates will become more reliable as more daily records are collected.`
        : `Forecasts are estimated from ${recordedDays} day(s) of verified records (${firstRecordDate} to ${lastRecordDate}). They are not guaranteed quantities.`,
    forecastPreliminary: forecastAvailable && recordedDays < RELIABLE_FORECAST_DAYS,
    dataSufficient: recordedDays >= RELIABLE_FORECAST_DAYS,
    amPmAnalysis: amPm,
    monitoring: {
      lowStockItems: stockStatusCounts.low,
      criticalStockItems: stockStatusCounts.critical,
      expiringItems: aggregated.expiringLots,
      expiredItems: aggregated.expiredLots,
      outOfStockItems: stockStatusCounts.out,
      consistency: aggregated.consistency,
      pendingVerification: amPm.pendingVerification,
      missingPm: amPm.missingPm,
      rapidlyIncreasing,
      rows: monitoringRows.sort((a, b) => String(a.vaccine).localeCompare(String(b.vaccine))),
    },
    shifts: {
      sufficient: amPm.completed > 0,
      shiftSpecificUsageAvailable: false,
      note: SHIFT_USAGE_NOTE,
      totalUsage: totalUsed,
      averageDailyUsage,
      additionalTotal: totalAdditional,
      completedPairs: amPm.completed,
      missingAm: amPm.missingAm,
      missingPm: amPm.missingPm,
      missingTotal: amPm.missingAm + amPm.missingPm,
      pendingVerification: amPm.pendingVerification,
      monthly: [...new Set([...Object.keys(monthlyUsage), ...byMonthAdd.keys()])].sort().map((month) => ({
        month,
        used: monthlyUsage[month] || 0,
        additional: byMonthAdd.get(month) || 0,
      })),
    },
    monthlyUsage,
  };
}

async function collectClinicInventoryAnalytics(pool, query = {}) {
  const range = parseAnalyticsRange(query);
  const [dailyRows, lots, txRows, thresholdRows, [[stockInToday]], [[txnToday]]] = await Promise.all([
    fetchDailyRecordRows(pool, {
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      vaccineId: range.vaccineId,
    }),
    pool.query(`
      SELECT vi.*, v.name AS vaccine_name
      FROM vaccine_inventory vi
      JOIN vaccines v ON vi.vaccine_id = v.vaccine_id
    `).then(([rows]) => rows || []),
    pool.query(`
      SELECT transaction_id, vaccine_id, transaction_type, quantity, corrected_quantity, notes, transaction_date
      FROM vaccine_transactions
    `).then(([rows]) => rows || []).catch(() => []),
    pool.query(`
      SELECT config_key, config_value FROM system_config
      WHERE config_key IN ('default_low_stock_threshold', 'default_critical_stock_threshold', 'expiry_warning_days')
    `).then(([rows]) => rows || []).catch(() => []),
    pool.query(
      `SELECT COALESCE(SUM(COALESCE(corrected_quantity, quantity)),0) AS total
       FROM vaccine_transactions
       WHERE DATE(transaction_date)=? AND transaction_type IN ('Stock In','Returned Vaccine')
         AND (notes IS NULL OR notes NOT LIKE '%lot-receipt-sync:%')`,
      [range.today]
    ).catch(() => [[{ total: 0 }]]),
    pool.query(
      `SELECT COUNT(*) AS total FROM vaccine_transactions WHERE DATE(transaction_date)=?`,
      [range.today]
    ).catch(() => [[{ total: 0 }]]),
  ]);

  let namedRows = dailyRows || [];
  try {
    const catalog = await fetchInventoryCatalog(pool, { activeOnly: false, extraIds: namedRows.map((r) => r.vaccine_id) });
    const names = new Map((catalog || []).map((v) => [Number(v.vaccine_id), v.name]));
    namedRows = namedRows.map((r) => ({ ...r, vaccine_name: names.get(Number(r.vaccine_id)) || r.vaccine_name }));
  } catch (_) { /* keep rows */ }

  const [expectedVaccines, closures] = await Promise.all([
    listShiftVaccines(pool)
      .then((list) => (list || []).map((v) => ({ vaccine_id: Number(v.vaccine_id), name: v.name })))
      .catch(() => null),
    pool.query(
      'SELECT shift_date, shift, shift_status FROM inventory_shift_closures WHERE shift_date BETWEEN ? AND ?',
      [range.dateFrom, range.dateTo]
    ).then(([rows]) => rows || []).catch(() => []),
  ]);

  const thresholdDefaults = {};
  for (const row of thresholdRows || []) {
    if (row.config_key === 'default_low_stock_threshold') thresholdDefaults.lowThreshold = Number(row.config_value);
    if (row.config_key === 'default_critical_stock_threshold') thresholdDefaults.criticalThreshold = Number(row.config_value);
    if (row.config_key === 'expiry_warning_days') thresholdDefaults.expiryWarningDays = Number(row.config_value);
  }

  return buildClinicUsageAnalytics({
    expectedVaccines,
    closures,
    dailyRows: namedRows,
    lots,
    transactions: txRows || [],
    thresholdDefaults,
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    grain: range.grain,
    vaccineId: range.vaccineId,
    today: range.today,
    forecastDays: range.forecastDays,
    stockInToday: stockInToday && stockInToday.total,
    transactionsToday: txnToday && txnToday.total,
  });
}

module.exports = {
  INSUFFICIENT_FORECAST,
  LIMITED_TREND,
  SHIFT_USAGE_NOTE,
  NO_RISK_ALERTS,
  SUFFICIENCY,
  assessTrend,
  classifyDataStatus,
  forecastVaccine,
  assessSufficiency,
  buildRiskAlerts,
  parseAnalyticsRange,
  parseForecastDays,
  pairUsageEligible,
  classifyShiftDay,
  buildClinicUsageAnalytics,
  collectClinicInventoryAnalytics,
  aggregateInventoryLots,
  vaccineStatusFromStock,
  bucketKey,
  summarizeMovements,
};