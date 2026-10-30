'use strict';

const { localTodayIso, toSqlDate, addDaysIso } = require('./dateOnly');
const { getCurrentShift, normalizeShift } = require('./shiftHelper');
const { enrichLot } = require('./inventoryBatches');
const {
  listPendingAlerts,
  listShiftHistory,
  summarizeShiftDashboard,
  shiftHasStarted,
  shiftHasEnded,
} = require('./inventoryShiftStatus');
const { generateStaffId } = require('./idFormats');
const { fetchCurrentLotGroups, summarizeLotGroups, currentStockLevels } = require('./currentLotStock');
const { collectClinicInventoryAnalytics } = require('./inventoryPredictiveAnalytics');
const { classifyVaccinationSchedules } = require('./vaccinationProgress');

const USAGE_TYPES = ['Vaccine Usage', 'Usage', 'Stock Out'];
const RECEIVED_TYPES = ['Stock In', 'Returned Vaccine'];
const PERIODS = ['today', 'week', 'month', 'quarter', 'custom'];
const MAX_RANGE_DAYS = 366;
const FORECAST_WINDOW_DAYS = 90;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function bucketShift(shift) {
  const n = normalizeShift(shift);
  return n === 'Afternoon Shift' ? 'afternoon' : 'morning';
}

function buildStockByVaccine(lots) {
  const map = new Map();
  for (const row of lots || []) {
    const lot = enrichLot(row);
    const name = lot.vaccine_name || lot.name || 'Unknown';
    const id = Number(lot.vaccine_id);
    const cur = map.get(id) || { vaccine_id: id, name, quantity: 0 };
    cur.name = name;
    cur.quantity += Number(lot.usable_quantity) || 0;
    map.set(id, cur);
  }
  return [...map.values()]
    .filter((x) => Number(x.quantity) > 0)
    .sort((a, b) => b.quantity - a.quantity || String(a.name).localeCompare(String(b.name)));
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function daySpan(from, to) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) + 1;
}

function parseDashboardRange(query = {}, today = localTodayIso()) {
  const period = PERIODS.includes(String(query.period || '').toLowerCase())
    ? String(query.period).toLowerCase()
    : 'today';
  const [y, m, d] = today.split('-').map(Number);
  let dateFrom = today;
  let dateTo = today;
  if (period === 'week') {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
    dateFrom = addDaysIso(today, -(dow - 1));
  } else if (period === 'month') {
    dateFrom = `${today.slice(0, 7)}-01`;
  } else if (period === 'quarter') {
    const qStart = Math.floor((m - 1) / 3) * 3 + 1;
    dateFrom = `${y}-${String(qStart).padStart(2, '0')}-01`;
  } else if (period === 'custom') {
    dateFrom = toSqlDate(query.date_from);
    dateTo = toSqlDate(query.date_to);
    if (!dateFrom || !dateTo) throw badRequest('Select both a start date and an end date.');
    if (dateFrom > dateTo) throw badRequest('The end date cannot be earlier than the start date.');
    if (daySpan(dateFrom, dateTo) > MAX_RANGE_DAYS) throw badRequest('The selected date range cannot exceed one year.');
  }
  const span = daySpan(dateFrom, dateTo);
  const grainRaw = String(query.grain || '').toLowerCase();
  const grain = ['day', 'week', 'month'].includes(grainRaw) ? grainRaw
    : span > 120 ? 'month' : span > 35 ? 'week' : 'day';
  const shiftDate = toSqlDate(query.shift_date) || (dateTo < today ? dateTo : today);
  return {
    period, dateFrom, dateTo, grain, today, shiftDate,
    includesToday: dateFrom <= today && today <= dateTo,
    days: span,
  };
}

function latestIso(values) {
  let best = null;
  for (const v of values) {
    if (!v) continue;
    const t = new Date(v).getTime();
    if (Number.isFinite(t) && (best == null || t > best)) best = t;
  }
  return best == null ? null : new Date(best).toISOString();
}

function uniqueNames(values) {
  return [...new Set(values.filter(Boolean).map((s) => String(s).trim()).filter(Boolean))];
}

function shiftSectionStatus({ total, recorded, verified, started, ended, closed }) {
  if (total <= 0) return 'No Vaccines';
  if (recorded <= 0) {
    if (!started) return 'Not Started';
    return ended || closed ? 'Missing' : 'Pending';
  }
  if (recorded < total) return 'Incomplete';
  if (verified < total) return 'Pending Verification';
  return 'Verified';
}

/**
 * AM / PM status for one clinic date. Only rows actually saved count as recorded;
 * vaccines without rows are reported as missing, never as completed.
 */
function summarizeShiftDay(rows, closures, { date, now = new Date() } = {}) {
  const list = rows || [];
  const summary = summarizeShiftDashboard(list);
  const closed = (shift) => (closures || []).some((c) => normalizeShift(c.shift) === shift
    && String(c.shift_status || '').toLowerCase() === 'closed');

  const amRecorded = list.filter((r) => r.am_recorded);
  const pmRecorded = list.filter((r) => r.pm_recorded);
  const amVerified = amRecorded.filter((r) => r.am_count_status === 'Verified').length;
  const pmVerified = pmRecorded.filter((r) => r.pm_count_status === 'Verified').length;
  const usageRows = list.filter((r) => r.am_recorded && r.pm_recorded && r.vaccine_used != null);

  const am = {
    status: shiftSectionStatus({
      total: list.length,
      recorded: amRecorded.length,
      verified: amVerified,
      started: shiftHasStarted(date, 'Morning Shift', now),
      ended: shiftHasEnded(date, 'Morning Shift', now),
      closed: closed('Morning Shift'),
    }),
    closed: closed('Morning Shift'),
    totalVaccines: list.length,
    recordedVaccines: amRecorded.length,
    verifiedVaccines: amVerified,
    pendingVerification: amRecorded.length - amVerified,
    missingVaccines: list.filter((r) => !r.am_recorded).map((r) => r.vaccine_name),
    totalAmCount: amRecorded.reduce((s, r) => s + num(r.inventory_am), 0),
    additionalRecorded: amRecorded.reduce((s, r) => s + num(r.additional_vaccine), 0),
    recordedBy: uniqueNames(amRecorded.map((r) => r.am_recorded_by_name)),
    lastUpdated: latestIso(amRecorded.map((r) => r.am_recorded_at)),
  };
  const pm = {
    status: shiftSectionStatus({
      total: list.length,
      recorded: pmRecorded.length,
      verified: pmVerified,
      started: shiftHasStarted(date, 'Afternoon Shift', now),
      ended: shiftHasEnded(date, 'Afternoon Shift', now),
      closed: closed('Afternoon Shift'),
    }),
    closed: closed('Afternoon Shift'),
    totalVaccines: list.length,
    recordedVaccines: pmRecorded.length,
    verifiedVaccines: pmVerified,
    pendingVerification: pmRecorded.length - pmVerified,
    missingVaccines: list.filter((r) => !r.pm_recorded).map((r) => r.vaccine_name),
    totalPmCount: pmRecorded.reduce((s, r) => s + num(r.inventory_pm), 0),
    usageCalculatedVaccines: usageRows.length,
    calculatedUsage: usageRows.reduce((s, r) => s + num(r.vaccine_used), 0),
    recordedBy: uniqueNames(pmRecorded.map((r) => r.pm_recorded_by_name)),
    lastUpdated: latestIso(pmRecorded.map((r) => r.pm_recorded_at)),
  };

  const amDue = am.closed || shiftHasEnded(date, 'Morning Shift', now);
  const pmDue = pm.closed || shiftHasEnded(date, 'Afternoon Shift', now);
  const missingAm = list.filter((r) => !r.am_recorded && (amDue || r.pm_recorded)).length;
  // Always calculate Missing PM (not just after shift ends)
  const missingPm = list.filter((r) => !r.pm_recorded).length;
  
  // PM breakdown: vaccines with AM (ready for PM) vs vaccines without AM (not ready)
  const pmWaitingForAm = list.filter((r) => r.am_recorded && !r.pm_recorded).length;
  const pmNoAmYet = list.filter((r) => !r.am_recorded && !r.pm_recorded).length;

  let combined;
  if (!list.length) combined = 'No Vaccines';
  else if (!amRecorded.length && !pmRecorded.length) combined = am.status === 'Not Started' ? 'Not Started' : 'Not Recorded';
  else if (summary.both_completed === list.length) {
    combined = am.status === 'Verified' && pm.status === 'Verified' ? 'Completed' : 'Pending Verification';
  } else combined = 'Incomplete';

  return {
    date,
    am,
    pm,
    combined: {
      status: combined,
      bothCompleted: summary.both_completed,
      totalVaccines: list.length,
      missingAm,
      missingPm,
      missingTotal: missingAm + missingPm,
      pmWaitingForAm,
      pmNoAmYet,
      varianceCount: summary.variance_count,
      lastUpdated: latestIso([am.lastUpdated, pm.lastUpdated]),
    },
  };
}

function buildInventorySummary(monitoringRows, lotSummary) {
  const lotsByVaccine = new Map();
  for (const lot of lotSummary.lots) {
    const id = Number(lot.vaccine_id);
    const list = lotsByVaccine.get(id) || [];
    list.push(lot);
    lotsByVaccine.set(id, list);
  }
  return (monitoringRows || []).map((row) => {
    const lots = lotsByVaccine.get(Number(row.vaccine_id)) || [];
    const usableLots = lots.filter((l) => l.usable_quantity > 0 && !l.isExpired);
    const nearest = usableLots
      .map((l) => toSqlDate(l.expiry_date))
      .filter(Boolean)
      .sort()[0] || null;
    return {
      vaccine_id: row.vaccine_id,
      vaccine: row.vaccine,
      availableStock: num(row.currentStock),
      usedInPeriod: num(row.historicalUsage),
      additionalInPeriod: num(row.additionalReceived),
      nearestExpiry: nearest,
      lotCount: lots.length,
      expiringLots: num(row.expiringLots),
      expiredLots: num(row.expiredLots),
      status: row.inventoryStatus,
      lastUpdated: latestIso(lots.map((l) => l.updated_at)),
    };
  });
}

const INVENTORY_LINK = '/admin/inventory.html';
const HISTORY_LINK = '/admin/inventory-history.html';

function buildDashboardAlerts({
  lotSummary, pendingInventory, amPm, shiftDay, aiFailure, generatedAt,
}) {
  const alerts = [];
  const seen = new Set();
  const push = (a) => {
    if (seen.has(a.key)) return;
    seen.add(a.key);
    alerts.push(a);
  };

  const stockLevels = currentStockLevels(lotSummary.lots);
  for (const vaccine of stockLevels.vaccines) {
    if (vaccine.isCritical) {
      push({
        key: `critical-${vaccine.vaccine_id}`, severity: 'critical', type: 'Critical',
        title: `${vaccine.vaccine_name} is at critical stock`,
        detail: `Current stock is ${vaccine.currentStock} usable vial(s).`,
        date: generatedAt, link: INVENTORY_LINK,
      });
    } else if (vaccine.isLow) {
      push({
        key: `low-${vaccine.vaccine_id}`, severity: 'warning', type: 'Low Stock',
        title: `${vaccine.vaccine_name} is low on stock`,
        detail: `Current stock is ${vaccine.currentStock} usable vial(s).`,
        date: generatedAt, link: INVENTORY_LINK,
      });
    }
  }

  for (const lot of lotSummary.lots) {
    const lotName = lot.batch_number || (lot.inventory_id != null ? `#${lot.inventory_id}` : '');
    const label = lotName ? `${lot.vaccine_name} (Lot ${lotName})` : lot.vaccine_name;
    const expiry = toSqlDate(lot.expiry_date);
    if (lot.isExpired && lot.quantity > 0) {
      push({
        key: `expired-${lot.inventory_id}`, severity: 'critical', type: 'Expired',
        title: `${label} has expired`,
        detail: `${lot.quantity} vial(s) remain on record past the expiration date.`,
        date: expiry, link: INVENTORY_LINK,
      });
      continue;
    }
    if (lot.expiringWithin) {
      push({
        key: `expiring-${lot.inventory_id}`, severity: lot.expiringWithin <= 7 ? 'critical' : 'warning',
        type: 'Expiring Soon',
        title: `${label} expires in ${lot.expiry_days} day(s)`,
        detail: `${lot.usable_quantity} usable vial(s) expire on ${expiry}.`,
        date: expiry, link: INVENTORY_LINK,
      });
    }
  }

  for (const g of pendingInventory || []) {
    if (g.status !== 'Not Recorded') continue;
    const label = g.shift === 'Afternoon Shift' ? 'PM' : 'AM';
    push({
      key: `missing-${g.date}-${g.shift}`, severity: 'warning', type: 'Missing Record',
      title: `${label} inventory not completed for ${g.date}`,
      detail: `${g.vaccines.length} vaccine(s) have no recorded ${label} count.`,
      date: g.date, link: INVENTORY_LINK,
    });
  }

  const pendingToday = shiftDay ? shiftDay.am.pendingVerification + shiftDay.pm.pendingVerification : 0;
  if (pendingToday > 0) {
    push({
      key: `pending-shift-${shiftDay.date}`, severity: 'info', type: 'Pending',
      title: `${pendingToday} AM/PM count(s) awaiting verification`,
      detail: `Counts saved on ${shiftDay.date} have not been verified yet.`,
      date: shiftDay.date, link: INVENTORY_LINK,
    });
  } else if (amPm && amPm.pendingVerification > 0) {
    push({
      key: 'pending-period', severity: 'info', type: 'Pending',
      title: `${amPm.pendingVerification} inventory record(s) pending verification`,
      detail: 'Pending records are excluded from verified usage until verified.',
      date: generatedAt, link: HISTORY_LINK,
    });
  }

  const variance = shiftDay ? shiftDay.combined.varianceCount : 0;
  if (amPm && amPm.inconsistencies > 0) {
    push({
      key: 'inconsistent-period', severity: 'warning', type: 'Unusual Change',
      title: `${amPm.inconsistencies} AM/PM record(s) show a PM count above the AM count`,
      detail: 'Review these records in Inventory History.',
      date: generatedAt, link: HISTORY_LINK,
    });
  }
  if (variance > 0) {
    push({
      key: `variance-${shiftDay.date}`, severity: 'warning', type: 'Unusual Change',
      title: `${variance} vaccine(s) have a stock variance on ${shiftDay.date}`,
      detail: 'The PM count does not match the expected remaining stock.',
      date: shiftDay.date, link: HISTORY_LINK,
    });
  }

  if (aiFailure) {
    push({
      key: 'ai-failed', severity: 'info', type: 'AI Analysis',
      title: 'The last AI analysis request failed',
      detail: 'Statistical insights remain available. Try generating the analysis again later.',
      date: aiFailure, link: '/admin/ai-predictive.html',
    });
  }

  const rank = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]
    || String(b.date || '').localeCompare(String(a.date || '')));
}

function mapActivities({ transactions, sheetRows, verifications, corrections, closures }) {
  const out = [];
  for (const t of transactions || []) {
    out.push({
      key: `txn-${t.transaction_id}`,
      date: t.transaction_date,
      type: t.transaction_type,
      vaccine: t.vaccine_name || '—',
      quantity: t.corrected_quantity != null ? t.corrected_quantity : t.quantity,
      shift: t.shift || '—',
      staff: t.staff_name || '—',
      staffId: t.staff_id_display || (t.staff_id ? generateStaffId(t.staff_id, 'Administrator') : null),
      status: 'Recorded',
    });
  }
  for (const c of corrections || []) {
    out.push({
      key: `corr-${c.transaction_id}`,
      date: c.corrected_at,
      type: 'Stock correction',
      vaccine: c.vaccine_name || '—',
      quantity: c.corrected_quantity,
      shift: c.shift || '—',
      staff: c.corrected_by_name || '—',
      status: 'Corrected',
    });
  }
  for (const r of sheetRows || []) {
    const pm = normalizeShift(r.shift) === 'Afternoon Shift';
    out.push({
      key: `sheet-${r.record_id}`,
      date: r.recorded_at || r.updated_at || r.record_date,
      type: Number(r.late_entry) === 1 ? 'Late inventory entry' : (pm ? 'PM inventory recording' : 'AM inventory recording'),
      vaccine: r.vaccine_name || '—',
      quantity: pm ? r.remaining_pm_shift : (r.physical_count != null ? r.physical_count : r.morning_shift_inventory),
      shift: r.shift || '—',
      staff: r.recorded_by_name || '—',
      status: r.inventory_status || 'Recorded',
    });
  }
  for (const v of verifications || []) {
    out.push({
      key: `verify-${v.record_id}`,
      date: v.verified_at,
      type: 'Inventory verification',
      vaccine: v.vaccine_name || '—',
      quantity: null,
      shift: v.shift || '—',
      staff: v.verified_by_name || '—',
      status: 'Verified',
    });
  }
  for (const c of closures || []) {
    out.push({
      key: `close-${c.closure_id}`,
      date: c.closed_at || c.shift_date,
      type: 'Shift closing',
      vaccine: '—',
      quantity: null,
      shift: c.shift || '—',
      staff: c.closed_by_name || '—',
      status: 'Closed',
    });
  }
  return out
    .filter((a) => a.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function parseStoredAi(row) {
  if (!row) return null;
  let body = null;
  try { body = JSON.parse(row.ai_response); } catch (_) { return null; }
  if (!body || typeof body !== 'object') return null;
  const list = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string').slice(0, 3) : []);
  return {
    generatedAt: row.generated_at,
    model: row.model || null,
    periodStart: toSqlDate(row.period_start),
    periodEnd: toSqlDate(row.period_end),
    insights: list(body.insights),
    recommendations: list(body.recommendations),
  };
}

async function collectAdminDashboard(pool, query = {}) {
  const range = parseDashboardRange(query);
  const { dateFrom, dateTo, today } = range;
  console.log('[adminDashboard] Date range:', { today, dateFrom, dateTo });
  
  const safe = (p, fallback) => p.catch((err) => {
    console.error('Admin dashboard query failed:', err.message);
    return fallback;
  });

  const forecastFrom = addDaysIso(today, -(FORECAST_WINDOW_DAYS - 1));
  const [
    lotGroups,
    analytics,
    todayAnalytics,
    forecastAnalytics,
    [[firstRecord]],
    shiftRows,
    [shiftClosures],
    pendingInventory,
    [[txnCounts]],
    [[caseCounts]],
    [[patientCount]],
    [vaccRows],
    [[accountCounts]],
    [staffRows],
    [[topBarangay]],
    [transactions],
    [corrections],
    [sheetRows],
    [verifications],
    [closures],
    [[lastAi]],
    [[lastAiFailure]],
  ] = await Promise.all([
    fetchCurrentLotGroups(pool),
    collectClinicInventoryAnalytics(pool, { date_from: dateFrom, date_to: dateTo, grain: range.grain }),
    range.includesToday ? Promise.resolve(null)
      : collectClinicInventoryAnalytics(pool, { date_from: today, date_to: today }),
    range.days >= FORECAST_WINDOW_DAYS && range.includesToday ? Promise.resolve(null)
      : collectClinicInventoryAnalytics(pool, { date_from: forecastFrom, date_to: today }),
    safe(pool.query('SELECT MIN(record_date) AS first_date FROM inventory_daily_records'), [[{}]]),
    listShiftHistory(pool, { date_from: range.shiftDate, date_to: range.shiftDate }),
    safe(pool.query(
      'SELECT shift, shift_status, closed_at FROM inventory_shift_closures WHERE shift_date = ?',
      [range.shiftDate]
    ), [[]]),
    safe(listPendingAlerts(pool, { days: 7 }), []),
    pool.query(
      `SELECT
         COUNT(CASE WHEN DATE(transaction_date) = ? THEN 1 END) AS today,
         COUNT(CASE WHEN DATE(transaction_date) BETWEEN ? AND ? THEN 1 END) AS period,
         COUNT(*) AS total,
         COUNT(CASE WHEN transaction_date IS NULL THEN 1 END) AS null_dates
       FROM vaccine_transactions`,
      [today, dateFrom, dateTo]
    ),
    safe(pool.query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(DATE(created_at) = ?), 0) AS today,
              COALESCE(SUM(DATE(created_at) BETWEEN ? AND ?), 0) AS period
       FROM patient_exposures`,
      [today, dateFrom, dateTo]
    ), [[{ total: null, today: null, period: null }]]),
    pool.query('SELECT COUNT(*) AS total FROM patients'),
    safe(pool.query('SELECT vaccine_d0, vaccine_d3, vaccine_d7 FROM patients'), [[]]),
    safe(pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(account_status = 'Active'), 0) AS active FROM patient_accounts`
    ), [[{ total: null, active: null }]]),
    pool.query(`SELECT role, COUNT(*) AS total FROM staff_account WHERE status = 'Active' GROUP BY role`),
    safe(pool.query(
      `SELECT COALESCE(pe.barangay, p.barangay) AS barangay, COUNT(*) AS cases
       FROM patient_exposures pe JOIN patients p ON p.patient_id = pe.patient_id
       WHERE DATE(pe.date_of_exposure) BETWEEN ? AND ?
       GROUP BY COALESCE(pe.barangay, p.barangay)
       ORDER BY cases DESC LIMIT 1`,
      [dateFrom, dateTo]
    ), [[null]]),
    pool.query(
      `SELECT vt.transaction_id, vt.transaction_date, vt.transaction_type, vt.quantity, vt.corrected_quantity,
              vt.shift, vt.staff_name, vt.staff_id, vt.staff_id_display, v.name AS vaccine_name
       FROM vaccine_transactions vt LEFT JOIN vaccines v ON vt.vaccine_id = v.vaccine_id
       WHERE DATE(vt.transaction_date) BETWEEN ? AND ?
       ORDER BY vt.transaction_date DESC, vt.transaction_id DESC LIMIT 25`,
      [dateFrom, dateTo]
    ),
    safe(pool.query(
      `SELECT vt.transaction_id, vt.corrected_at, vt.corrected_quantity, vt.corrected_by_name, vt.shift,
              v.name AS vaccine_name
       FROM vaccine_transactions vt LEFT JOIN vaccines v ON vt.vaccine_id = v.vaccine_id
       WHERE vt.corrected_at IS NOT NULL AND DATE(vt.corrected_at) BETWEEN ? AND ?
       ORDER BY vt.corrected_at DESC LIMIT 25`,
      [dateFrom, dateTo]
    ), [[]]),
    safe(pool.query(
      `SELECT idr.record_id, idr.record_date, idr.recorded_at, idr.updated_at, idr.shift, idr.physical_count,
              idr.morning_shift_inventory, idr.remaining_pm_shift, idr.inventory_status, idr.late_entry,
              idr.recorded_by_name, v.name AS vaccine_name
       FROM inventory_daily_records idr LEFT JOIN vaccines v ON idr.vaccine_id = v.vaccine_id
       WHERE idr.opening_recorded = 1 AND idr.record_date BETWEEN ? AND ?
       ORDER BY COALESCE(idr.recorded_at, idr.updated_at, idr.created_at) DESC LIMIT 25`,
      [dateFrom, dateTo]
    ), [[]]),
    safe(pool.query(
      `SELECT idr.record_id, idr.verified_at, idr.verified_by_name, idr.shift, v.name AS vaccine_name
       FROM inventory_daily_records idr LEFT JOIN vaccines v ON idr.vaccine_id = v.vaccine_id
       WHERE idr.verified_at IS NOT NULL AND DATE(idr.verified_at) BETWEEN ? AND ?
       ORDER BY idr.verified_at DESC LIMIT 25`,
      [dateFrom, dateTo]
    ), [[]]),
    safe(pool.query(
      `SELECT closure_id, shift_date, shift, closed_at, closed_by_name
       FROM inventory_shift_closures
       WHERE shift_date BETWEEN ? AND ?
       ORDER BY closed_at DESC LIMIT 10`,
      [dateFrom, dateTo]
    ), [[]]),
    safe(pool.query(
      `SELECT ai_response, generated_at, model, period_start, period_end
       FROM ai_analysis_cache WHERE context = 'admin' AND status = 'ok'
       ORDER BY generated_at DESC, id DESC LIMIT 1`
    ), [[null]]),
    safe(pool.query(
      `SELECT MAX(CASE WHEN status = 'Failed' THEN created_at END) AS failed_at,
              MAX(CASE WHEN status = 'Success' THEN created_at END) AS success_at
       FROM activity_logs
       WHERE reference_id = 'admin-ai-insights' AND action = 'Generate'`
    ), [[{}]]),
  ]);

  const generatedAt = new Date().toISOString();
  const lotSummary = summarizeLotGroups(lotGroups);
  const c = lotSummary.counts;
  const stockLevels = currentStockLevels(lotSummary.lots);
  const todayData = todayAnalytics || analytics;
  
  // Debug logging for transaction counts
  console.log('[adminDashboard] Transaction counts:', {
    today: txnCounts?.today,
    period: txnCounts?.period,
    total: txnCounts?.total,
    null_dates: txnCounts?.null_dates
  });
  
  const shiftDay = summarizeShiftDay(shiftRows, shiftClosures, { date: range.shiftDate });
  const vacc = classifyVaccinationSchedules(vaccRows);
  const staffByRole = {};
  for (const r of staffRows || []) staffByRole[r.role] = num(r.total);
  const activeStaff = Object.values(staffByRole).reduce((s, n) => s + n, 0);
  const firstDate = toSqlDate(firstRecord && firstRecord.first_date);
  const pendingSinceStart = firstDate
    ? (pendingInventory || []).filter((g) => g.date >= firstDate)
    : [];
  const pendingRecords = pendingSinceStart.reduce((s, g) => s + g.vaccines.length, 0);
  const fc = forecastAnalytics || analytics;
  const failedAt = lastAiFailure && lastAiFailure.failed_at;
  const successAt = lastAiFailure && lastAiFailure.success_at;
  const aiFailure = failedAt && (!successAt || new Date(failedAt) > new Date(successAt))
    ? new Date(failedAt).toISOString() : null;
  const nullableCount = (v) => (v == null ? null : num(v));

  const forecastItems = (fc.forecast || [])
    .filter((f) => f.forecastMethod !== 'insufficient' && f.forecastUsage > 0)
    .slice(0, 3)
    .map((f) => ({
      vaccine: f.vaccine,
      forecastUsage: f.forecastUsage,
      currentStock: f.currentStock,
      period: f.forecastPeriod,
      replenishmentWarning: f.replenishmentWarning,
    }));
  const replenishment = (fc.forecast || [])
    .filter((f) => f.replenishmentWarning)
    .map((f) => f.vaccine);

  return {
    clinicDate: today,
    currentShift: getCurrentShift(),
    generatedAt,
    range: {
      period: range.period,
      dateFrom,
      dateTo,
      grain: range.grain,
      days: range.days,
      shiftDate: range.shiftDate,
    },
    current: {
      availableStock: c.total_stock,
      lotCount: c.total_items,
      lowStock: stockLevels.low,
      criticalStock: stockLevels.critical,
      expiringSoon: c.expiring_30 + c.expiring_15 + c.expiring_7,
      expired: c.expired_count,
      pendingInventoryRecords: pendingRecords,
      totalPatients: num(patientCount && patientCount.total),
      totalBiteCases: nullableCount(caseCounts && caseCounts.total),
      patientAccounts: nullableCount(accountCounts && accountCounts.total),
      activePatientAccounts: nullableCount(accountCounts && accountCounts.active),
      activeStaff,
      activeNurses: staffByRole.Nurse || 0,
      staffByRole,
      completedVaccinations: vacc.completed,
      ongoingVaccinations: vacc.ongoing,
      overdueVaccinations: vacc.overdue,
    },
    today: {
      vaccineUsed: num(todayData.vaccinesUsedToday),
      additionalReceived: num(todayData.additionalVaccinesReceivedToday),
      transactions: num(txnCounts && txnCounts.today),
      newCases: nullableCount(caseCounts && caseCounts.today),
    },
    period: {
      vaccineUsed: num(analytics.totalVaccinesUsed),
      additionalReceived: num(analytics.additionalVaccinesReceived),
      transactions: num(txnCounts && txnCounts.period),
      newCases: nullableCount(caseCounts && caseCounts.period),
      completedPairs: num(analytics.amPmAnalysis && analytics.amPmAnalysis.completed),
      pendingVerification: num(analytics.amPmAnalysis && analytics.amPmAnalysis.pendingVerification),
      topBarangay: topBarangay && topBarangay.barangay ? { name: topBarangay.barangay, cases: num(topBarangay.cases) } : null,
    },
    usageDefinition: analytics.usageDefinition,
    shifts: shiftDay,
    inventorySummary: buildInventorySummary(analytics.monitoring && analytics.monitoring.rows, lotSummary),
    charts: {
      usageSeries: analytics.usageSeries || [],
      usageByVaccine: (analytics.usageByBrand || []).filter((u) => u.qty > 0),
      stockByVaccine: ((analytics.monitoring && analytics.monitoring.rows) || [])
        .filter((r) => num(r.currentStock) > 0)
        .map((r) => ({ name: r.vaccine, quantity: num(r.currentStock) }))
        .sort((a, b) => b.quantity - a.quantity),
    },
    ai: {
      window: { dateFrom: fc.dateFrom, dateTo: fc.dateTo },
      dataSufficient: Boolean(fc.dataSufficient),
      inventoryTrend: fc.inventoryTrend,
      mostUsedVaccine: fc.mostUsedVaccine,
      forecast: forecastItems,
      forecastNote: fc.forecastNote,
      replenishment,
      lastAnalysis: parseStoredAi(lastAi),
      lastFailureAt: aiFailure,
    },
    alerts: buildDashboardAlerts({
      lotSummary,
      pendingInventory: pendingSinceStart,
      amPm: analytics.amPmAnalysis,
      shiftDay,
      aiFailure,
      generatedAt,
    }),
    recentActivities: mapActivities({ transactions, sheetRows, verifications, corrections, closures }).slice(0, 20),
    pendingInventory: pendingSinceStart,
  };
}

module.exports = {
  collectAdminDashboard,
  parseDashboardRange,
  summarizeShiftDay,
  buildInventorySummary,
  buildDashboardAlerts,
  mapActivities,
  parseStoredAi,
  buildStockByVaccine,
  bucketShift,
  USAGE_TYPES,
  RECEIVED_TYPES,
};
