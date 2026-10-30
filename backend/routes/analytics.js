const express = require('express');
const router  = express.Router();
const pool    = require('../config/database').pool;
const fs = require('fs');
const path = require('path');
const {
  barangayRiskTier,
  reportPeriodRange,
  filterCasesByRisk,
  riskLevelLabel,
  sexCode,
  recordedAge,
  animalBucket,
  filterAnalyticsCases,
} = require('../utils/analyticsFilters');
const { requireAuth, getAuditBy, requirePermission, normalizeRole } = require('../middleware/auth');
const { logActivity, MODULES, ACTIONS } = require('../utils/activityLogger');
const { PERMISSIONS } = require('../utils/permissions');
const { computeTreatmentStatus } = require('../utils/treatmentStatus');
const { toSqlDate } = require('../utils/dateOnly');
const aiClient = require('../utils/groqClient');
const remisAi = require('../utils/remisAi');
const aiService = require('../utils/aiService');
const { collectNurseSummary } = require('../utils/remisAiData');
const { applyImmunoglobulinFlags } = require('../utils/immunoglobulinClassify');
const { loadBiteCases, buildFullAnalytics } = require('../utils/analyticsCaseSummary');
const { buildGeographicAnalytics, loadBarangayPopulations } = require('../utils/geoReportAnalytics');
const { buildMapSummary } = require('../utils/mapRecommendations');
const { fetchCurrentLotGroups, summarizeLotGroups, currentStockLevels } = require('../utils/currentLotStock');

let officialBarangayCache = null;
function officialGingoogBarangays() {
  if (officialBarangayCache) return officialBarangayCache;
  try {
    const file = path.join(__dirname, '../../frontend/js/nurse/gingoog-barangays.js');
    const text = fs.readFileSync(file, 'utf8');
    officialBarangayCache = [...text.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  } catch (err) {
    officialBarangayCache = [];
  }
  return officialBarangayCache;
}

router.use(requireAuth);

// -- /dashboard ? comprehensive dashboard data endpoint ----------------------
router.get('/dashboard', async (req, res) => {
  try {
    const generatedBy = getAuditBy(req);
    const today = new Date(); today.setHours(0,0,0,0);
    const todayStr = today.toISOString().slice(0,10);

    // Run all queries in parallel for performance
    const [
      [totalRow],
      [dogRow],
      [catRow],
      [otherRow],
      [allPatients],
      [monthlyRows],
      [barangayRows],
      [categoryRows],
      [recentPatients],
      [todayRegistered],
      [weeklyRow],
      [monthlyRow],
      [quarterlyRow],
      [yearlyRow],
      [recentActivity],
    ] = await Promise.all([
      // Total unique patients (for patient-level stats)
      pool.query('SELECT COUNT(*) as total FROM patients'),
      // Bite case counts ? from patient_exposures so every New Case is counted
      pool.query(`SELECT COUNT(*) as c FROM patient_exposures WHERE type_of_animal IN ('D','SD')`),
      pool.query(`SELECT COUNT(*) as c FROM patient_exposures WHERE type_of_animal = 'C'`),
      pool.query(`SELECT COUNT(*) as c FROM patient_exposures WHERE type_of_animal = 'O'`),
      pool.query(`SELECT patient_id, vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28, outcome, category FROM patients GROUP BY patient_id`),
      // Monthly trend: use date_of_exposure from patient_exposures, not date_registered
      pool.query(`
        SELECT DATE_FORMAT(date_of_exposure,'%Y-%m') as month, COUNT(*) as count
        FROM patient_exposures
        WHERE YEAR(date_of_exposure) = YEAR(CURDATE())
        GROUP BY DATE_FORMAT(date_of_exposure,'%Y-%m')
        ORDER BY month
      `),
      // Top barangays: use per-case barangay from patient_exposures
      pool.query(`
        SELECT COALESCE(pe.barangay, p.barangay) AS barangay,
               COUNT(*) AS case_count
        FROM patient_exposures pe
        JOIN patients p ON p.patient_id = pe.patient_id
        GROUP BY COALESCE(pe.barangay, p.barangay)
        ORDER BY case_count DESC LIMIT 10
      `),
      // Category distribution: from patient_exposures so each case is counted
      pool.query(`
        SELECT category, COUNT(*) as count FROM patient_exposures
        WHERE category IS NOT NULL GROUP BY category ORDER BY category
      `),
      pool.query(`
        SELECT patient_id, full_name, barangay, type_of_animal, category, date_registered, contact_number
        FROM patients ORDER BY CAST(registration_number AS UNSIGNED) DESC, patient_id DESC LIMIT 5
      `),
      // Period case counts: from patient_exposures by date_of_exposure
      pool.query(`SELECT COUNT(*) as c FROM patient_exposures WHERE DATE(date_of_exposure) = ?`, [todayStr]),
      pool.query(`SELECT COUNT(*) as c FROM patient_exposures WHERE date_of_exposure >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)`),
      pool.query(`SELECT COUNT(*) as c FROM patient_exposures WHERE MONTH(date_of_exposure)=MONTH(CURDATE()) AND YEAR(date_of_exposure)=YEAR(CURDATE())`),
      pool.query(`SELECT COUNT(*) as c FROM patient_exposures WHERE QUARTER(date_of_exposure)=QUARTER(CURDATE()) AND YEAR(date_of_exposure)=YEAR(CURDATE())`),
      pool.query(`SELECT COUNT(*) as c FROM patient_exposures WHERE YEAR(date_of_exposure)=YEAR(CURDATE())`),
      pool.query(`
        SELECT f.followup_status, f.updated_at, f.staff_name, p.full_name
        FROM patient_followup f
        JOIN patients p ON f.patient_id = p.patient_id
        ORDER BY f.updated_at DESC LIMIT 8
      `).catch(() => [[]]), // graceful if table doesn't exist yet
    ]);

    // Total bite cases = total rows in patient_exposures (one per case, including New Cases)
    const [[totalBitesRow]] = await pool.query('SELECT COUNT(*) AS total FROM patient_exposures');
    const totalBites = Number(totalBitesRow.total) || total; // fall back to patient count if empty

    const total = Number(totalRow[0].total);

    // Compute treatment statuses from patient vaccine data
    let underTreatment = 0, completedVacc = 0, dueToday = 0, overdueCount = 0;
    let interruptedCount = 0, dueTomorrow = 0, missedToday = 0;
    const todayMs = today.getTime();
    const role = normalizeRole(req.session.role);
    const isAdmin = role === 'Administrator';

    allPatients.forEach(p => {
      const computed = computeTreatmentStatus(p);
      if (computed.treatmentStatus === 'Completed') { completedVacc++; return; }
      if (computed.treatmentStatus === 'Incomplete' || computed.treatmentStatus === 'Treatment Interrupted') {
        interruptedCount++;
        overdueCount++;
        if (p.missed_date === todayStr) missedToday++;
        return;
      }
      if (computed.treatmentStatus === 'Due Today') dueToday++;
      else if (computed.treatmentStatus === 'Upcoming' && computed.daysRemaining === 1) dueTomorrow++;
      else underTreatment++;
    });

    // Build full 12-month trend (fill missing months with 0)
    const monthMap = {};
    monthlyRows.forEach(r => { monthMap[r.month] = Number(r.count); });
    const currentYear = new Date().getFullYear();
    const fullMonthlyTrend = Array.from({length: 12}, (_, i) => {
      const m = String(i + 1).padStart(2,'0');
      const key = `${currentYear}-${m}`;
      const labels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return { month: labels[i], count: monthMap[key] || 0 };
    });

    // AI insights (rule-based)
    const topBarangay = barangayRows[0];
    const dogCount = Number(dogRow[0].c), catCount = Number(catRow[0].c), otherCount = Number(otherRow[0].c);
    const mostCommonAnimal = dogCount >= catCount && dogCount >= otherCount ? 'Dog bites'
      : catCount >= otherCount ? 'Cat bites' : 'Other animal bites';
    const topCat = categoryRows[0] ? `Category ${categoryRows[0].category}` : 'N/A';
    const vaccRate = total > 0 ? Math.round((completedVacc / total) * 100) : 0;

    const insights = [];
    if (topBarangay) insights.push(`?? Barangay <strong>${topBarangay.barangay}</strong> currently has the highest number of bite cases (${topBarangay.case_count} cases).`);
    insights.push(`?? <strong>${mostCommonAnimal}</strong> account for the majority of reported cases.`);
    if (topCat !== 'N/A') insights.push(`?? <strong>${topCat}</strong> is the most common bite category recorded.`);
    insights.push(`?? Vaccination completion rate is <strong>${vaccRate}%</strong>. ${vaccRate < 70 ? 'Enhanced follow-up is recommended.' : 'Compliance is satisfactory.'}`);
    if (overdueCount > 0) insights.push(`?? There are <strong>${overdueCount} overdue patients</strong> requiring immediate follow-up.`);
    if (dueToday > 0) insights.push(`?? <strong>${dueToday} patient(s)</strong> are scheduled for vaccination today.`);
    if (interruptedCount > 0) insights.push(`?? <strong>${interruptedCount} interrupted treatment(s)</strong> require nurse review.`);

    let inventorySummary = null;
    if (isAdmin) {
      try {
        const lotSummary = summarizeLotGroups(await fetchCurrentLotGroups(pool));
        const stockLevels = currentStockLevels(lotSummary.lots);
        inventorySummary = {
          total_stock: lotSummary.counts.total_stock,
          low_stock_count: stockLevels.low,
          expired_count: lotSummary.counts.expired_count,
        };
      } catch (_) { inventorySummary = { total_stock: 0, low_stock_count: 0, expired_count: 0 }; }
    }

    // Recent notifications from follow-up activity
    // recentActivity is the raw Promise.all result entry: [[rows]] normally, [[]] on catch
    const activityRows = Array.isArray(recentActivity[0]) ? recentActivity[0] : [];
    const notifications = activityRows.map(a => ({
      icon: a.followup_status === 'Texted' ? '??' : '??',
      text: `${a.followup_status} follow-up recorded for <strong>${a.full_name}</strong>`,
      time: a.updated_at,
      staff: a.staff_name,
    }));

    res.json({
      success: true,
      data: {
        stats: {
          totalPatients: total,
          totalBites: totalBites,
          dogBites: dogCount,
          catBites: catCount,
          otherBites: otherCount,
          underTreatment,
          completedVacc,
          dueToday,
          dueTomorrow,
          overdue: overdueCount,
          interrupted: interruptedCount,
          missedToday,
        },
        role,
        inventorySummary,
        reportSummary: {
          todayCases:     Number(todayRegistered[0].c),
          weeklyCases:    Number(weeklyRow[0].c),
          monthlyCases:   Number(monthlyRow[0].c),
          quarterlyCases: Number(quarterlyRow[0].c),
          yearlyCases:    Number(yearlyRow[0].c),
        },
        monthlyTrend: fullMonthlyTrend,
        barangayCases: barangayRows,
        categoryData:  categoryRows,
        animalTypes: [
          { label: 'Dog',   count: dogCount  },
          { label: 'Cat',   count: catCount  },
          { label: 'Other', count: otherCount },
        ],
        recentPatients,
        insights,
        notifications,
        topBarangay: topBarangay || null,
        vaccRate,
      }
    });
    logActivity(req, { action: ACTIONS.VIEW, module: MODULES.ANALYTICS, reference_id: 'dashboard', description: 'Viewed Dashboard analytics & statistics' });
  } catch (err) {
    console.error('Dashboard analytics error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// -- /dashboard/due-today ? patients due today with details -------------------
router.get('/dashboard/due-today', async (req, res) => {
  try {
    const [patients] = await pool.query(`SELECT * FROM patients`);
    const today = new Date(); today.setHours(0,0,0,0);
    const todayMs = today.getTime();

    const dueTodayPatients = [];
    patients.forEach(p => {
      const computed = computeTreatmentStatus(p);
      // Only include patients who are actually due today (not completed or incomplete)
      if (computed.treatmentStatus === 'Due Today' && computed.nextSchedule && computed.nextDoseLabel) {
        dueTodayPatients.push({
          patient_id: p.patient_id,
          full_name: p.full_name,
          contact_number: p.contact_number,
          barangay: p.barangay,
          brand_name: p.brand_name,
          nextDoseLabel: computed.nextDoseLabel,
          nextSchedule: computed.nextSchedule,
          treatmentStatus: 'Due Today',
        });
      }
    });

    res.json({ success: true, data: dueTodayPatients });
  } catch (err) {
    console.error('Due today error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// -- /dashboard/overdue ? overdue patients ------------------------------------
router.get('/dashboard/overdue', async (req, res) => {
  try {
    const [patients] = await pool.query(`SELECT * FROM patients`);
    const today = new Date(); today.setHours(0,0,0,0);
    const todayMs = today.getTime();

    const overduePatients = [];
    patients.forEach(p => {
      const computed = computeTreatmentStatus(p);
      if (computed.treatmentStatus !== 'Incomplete' && computed.treatmentStatus !== 'Treatment Interrupted') return;
      overduePatients.push({
        patient_id: p.patient_id,
        full_name: p.full_name,
        contact_number: p.contact_number,
        barangay: p.barangay,
        daysOverdue: computed.daysOverdue || computed.daysDelayed || 0,
        nextVaccine: `${computed.missedDose || 'Missed dose'} (${p.brand_name || 'N/A'})`,
        brand_name: p.brand_name,
        treatmentStatus: 'Incomplete',
      });
    });

    // Sort by most overdue first
    overduePatients.sort((a,b) => b.daysOverdue - a.daysOverdue);
    res.json({ success: true, data: overduePatients });
  } catch (err) {
    console.error('Overdue error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/full', requirePermission(PERMISSIONS.ANALYTICS), async (req, res) => {
  try {
    const cases = await loadBiteCases(pool);
    const data = buildFullAnalytics(cases, req.query, officialGingoogBarangays());
    res.json({ success: true, data });
    logActivity(req, { action: ACTIONS.VIEW, module: MODULES.ANALYTICS, reference_id: 'full', description: 'Viewed full Analytics page data' });
  } catch (error) {
    console.error('Full analytics error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


const AI_UNAVAILABLE = 'AI analysis is temporarily unavailable. Please try again later.';

router.get('/ai-health', requirePermission(PERMISSIONS.ANALYTICS), async (req, res) => {
  const st = aiClient.status();
  const body = {
    success: true,
    aiAvailable: st.configured,
    configured: st.configured,
    provider: st.provider,
    label: st.label,
    model: st.model,
    errorCode: st.errorCode,
    message: st.message,
  };
  if (String(req.query.ping || '') === '1' && st.configured) {
    try {
      body.ping = await aiClient.ping();
    } catch (err) {
      aiClient.logFailure(err);
      return res.status(aiClient.httpStatusFor(err.code)).json(aiService.failureBody(err, {
        configured: true,
        model: st.model,
      }));
    }
  }
  res.json(body);
});

router.get('/ai-insights', requirePermission(PERMISSIONS.ANALYTICS), async (req, res) => {
  const generatedAt = new Date().toISOString();
  const wantInterpret = String(req.query.interpret || '') === '1';
  try {
    const summary = await collectNurseSummary(req.query || {});
    const stats = {
      predictions: {
        predictedNextMonth: summary.predictedNextMonth,
        predictedNextQuarter: summary.predictedNextQuarter,
        highestRiskBarangay: summary.highestCaseBarangay || '?',
        trend: summary.trend,
        method: 'linear_regression',
      },
      generatedAt,
      lastUpdated: generatedAt,
    };

    if (!wantInterpret) {
      return res.json({
        success: true,
        aiAvailable: aiClient.isConfigured(),
        data: { ...stats, insights: [], recommendations: [], aiUsed: false, source: 'none' },
      });
    }

    try {
      const analysis = await aiService.interpretOrThrow(summary, 'Nurse', {
        periodStart: summary.period?.year ? String(summary.period.year) : null,
        periodEnd: summary.period?.quarter ? `Q${summary.period.quarter}` : null,
      });
      logActivity(req, {
        action: ACTIONS.GENERATE,
        module: MODULES.ANALYTICS,
        reference_id: 'ai-insights',
        description: `Nurse AI analysis (Groq ${aiClient.getActiveModel()})`,
        status: 'Success',
      });
      return res.json({
        success: true,
        aiAvailable: true,
        status: 'ok',
        data: {
          ...stats,
          insights: analysis.insights,
          recommendations: analysis.recommendations,
          trendExplanation: analysis.trendExplanation,
          forecastInterpretation: analysis.forecastInterpretation || '',
          riskAreas: analysis.riskAreas,
          limitations: analysis.limitations,
          status: 'ok',
          source: analysis.source,
          aiUsed: true,
          aiModel: analysis.model,
          generatedAt: analysis.generatedAt || generatedAt,
          lastUpdated: analysis.generatedAt || generatedAt,
        },
      });
    } catch (aiErr) {
      logActivity(req, {
        action: ACTIONS.GENERATE,
        module: MODULES.ANALYTICS,
        reference_id: 'ai-insights',
        description: `Nurse AI analysis failed (${aiClient.publicErrorCode(aiErr.code)})`,
        status: 'Failed',
      });
      return res.status(aiClient.httpStatusFor(aiErr.code)).json(aiService.failureBody(aiErr, {
        data: {
          ...stats,
          insights: [],
          recommendations: [],
          source: 'none',
          aiUsed: false,
        },
      }));
    }
  } catch (error) {
    console.error('Nurse AI insights error:', error);
    logActivity(req, {
      action: ACTIONS.GENERATE,
      module: MODULES.ANALYTICS,
      reference_id: 'ai-insights',
      description: 'Nurse AI analysis failed',
      status: 'Failed',
    });
    res.status(500).json({
      success: false,
      aiAvailable: false,
      errorCode: 'BACKEND_ERROR',
      message: AI_UNAVAILABLE,
    });
  }
});

router.get('/ai-analysis', requirePermission(PERMISSIONS.ANALYTICS), async (req, res) => {
  try {
    const summary = await collectNurseSummary(req.query || {});
    const stats = remisAi.fallbackNurse(summary);
    res.json({
      success: true,
      data: {
        analysis: [...stats.insights, ...stats.recommendations].join('\n\n'),
        insights: stats.insights,
        recommendations: stats.recommendations,
        source: 'statistical',
        aiUsed: false,
      },
    });
  } catch (error) {
    console.error('AI Analysis error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});



function buildDateConditions(dateFilter, dateValue) {
  const conditions = [];
  const params = [];

  if (!dateFilter || !dateValue) return { conditions, params };

  if (dateFilter === 'monthly') {
    conditions.push(`DATE_FORMAT(p.date_registered, '%Y-%m') = ?`);
    params.push(dateValue);
  } else if (dateFilter === 'quarterly') {
    const [year, quarter] = dateValue.split('-Q');
    const startMonth = (parseInt(quarter, 10) - 1) * 3 + 1;
    const endMonth   = parseInt(quarter, 10) * 3;
    conditions.push(`YEAR(p.date_registered) = ? AND MONTH(p.date_registered) BETWEEN ? AND ?`);
    params.push(year, startMonth, endMonth);
  } else if (dateFilter === 'yearly') {
    conditions.push(`YEAR(p.date_registered) = ?`);
    params.push(dateValue);
  }

  return { conditions, params };
}

function buildPreviousDateConditions(dateFilter, dateValue) {
  const conditions = [];
  const params = [];

  if (!dateFilter || !dateValue) return { conditions, params };

  if (dateFilter === 'monthly') {
    const [y, m] = dateValue.split('-').map(Number);
    const prev = new Date(y, m - 2, 1);
    const prevVal = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
    conditions.push(`DATE_FORMAT(p.date_registered, '%Y-%m') = ?`);
    params.push(prevVal);
  } else if (dateFilter === 'quarterly') {
    const [year, quarter] = dateValue.split('-Q');
    let y = parseInt(year, 10);
    let q = parseInt(quarter, 10) - 1;
    if (q < 1) { q = 4; y -= 1; }
    const startMonth = (q - 1) * 3 + 1;
    const endMonth   = q * 3;
    conditions.push(`YEAR(p.date_registered) = ? AND MONTH(p.date_registered) BETWEEN ? AND ?`);
    params.push(String(y), startMonth, endMonth);
  } else if (dateFilter === 'yearly') {
    conditions.push(`YEAR(p.date_registered) = ?`);
    params.push(String(parseInt(dateValue, 10) - 1));
  }

  return { conditions, params };
}

function buildAnimalCondition(animalType) {
  const conditions = [];
  const params = [];

  if (!animalType || animalType === 'All') return { conditions, params };

  const animalMap = { Dog: ['D', 'SD'], Cat: ['C'], Other: ['O'] };
  const mapped = animalMap[animalType];
  if (mapped) {
    conditions.push(`p.type_of_animal IN (${mapped.map(() => '?').join(',')})`);
    params.push(...mapped);
  } else if (['D', 'SD', 'C', 'O'].includes(animalType)) {
    conditions.push(`p.type_of_animal = ?`);
    params.push(animalType);
  }

  return { conditions, params };
}

async function queryBarangayCases(where, params) {
  // Join patient_exposures so each case is counted individually under its own
  // barangay (pe.barangay).  COALESCE falls back to the patient's home barangay
  // (p.barangay) for historical rows that were created before migration_017
  // added the per-case barangay column.
  //
  // Existing WHERE/filter conditions reference p.* columns (p.date_registered,
  // p.type_of_animal) and are intentionally left unchanged so the existing
  // date and animal-type filters continue to work without modification.
  const [rows] = await pool.query(`
    SELECT
      COALESCE(pe.barangay, p.barangay) AS barangay,
      -- Use CASE to count each patient at least once even if they have no exposure row
      COUNT(CASE WHEN pe.exposure_id IS NOT NULL THEN pe.exposure_id ELSE p.patient_id END) AS case_count,
      COUNT(CASE WHEN COALESCE(pe.type_of_animal, p.type_of_animal) IN ('D','SD') THEN 1 END) AS dog_cases,
      COUNT(CASE WHEN COALESCE(pe.type_of_animal, p.type_of_animal) = 'C' THEN 1 END) AS cat_cases,
      COUNT(CASE WHEN COALESCE(pe.type_of_animal, p.type_of_animal) IS NOT NULL
        AND COALESCE(pe.type_of_animal, p.type_of_animal) NOT IN ('D','SD','C') THEN 1 END) AS other_cases,
      MAX(p.date_registered)            AS last_recorded_case
    FROM patients p
    LEFT JOIN patient_exposures pe ON pe.patient_id = p.patient_id
    ${where}
    GROUP BY COALESCE(pe.barangay, p.barangay)
    ORDER BY case_count DESC
  `, params);

  return rows;
}

router.get('/map-data', async (req, res) => {
  try {
    const generatedBy = getAuditBy(req);
    const { animalType, dateFilter, dateValue } = req.query;

    const datePart   = buildDateConditions(dateFilter, dateValue);
    const animalPart = buildAnimalCondition(animalType);
    const conditions = [...datePart.conditions, ...animalPart.conditions];
    const params     = [...datePart.params, ...animalPart.params];
    const where      = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const barangayCases = await queryBarangayCases(where, params);

    const total = barangayCases.reduce((s, b) => s + Number(b.case_count), 0);

    barangayCases.forEach(b => {
      b.case_count    = Number(b.case_count);
      b.dog_cases     = Number(b.dog_cases);
      b.cat_cases     = Number(b.cat_cases);
      b.other_cases   = Number(b.other_cases);
      b.risk_level    = barangayRiskTier(b.case_count);
      b.percentage    = total > 0 ? ((b.case_count / total) * 100).toFixed(2) : '0.00';
    });

    // Trend vs the previous period, using the same recorded case counts.
    let trend = {
      direction: 'none',
      change: 0,
      previousTotal: null,
      currentTotal: total,
      label: 'No prior period',
    };
    if (dateFilter && dateValue) {
      const prevDate   = buildPreviousDateConditions(dateFilter, dateValue);
      const prevConds  = [...prevDate.conditions, ...animalPart.conditions];
      const prevParams = [...prevDate.params, ...animalPart.params];
      const prevWhere  = prevConds.length ? 'WHERE ' + prevConds.join(' AND ') : '';
      const prevRows   = await queryBarangayCases(prevWhere, prevParams);
      const prevTotal  = prevRows.reduce((s, b) => s + Number(b.case_count), 0);
      const change     = total - prevTotal;
      trend = {
        direction: change > 0 ? 'increasing' : change < 0 ? 'decreasing' : 'stable',
        change,
        previousTotal: prevTotal,
        currentTotal: total,
        label: dateFilter === 'monthly' ? 'previous month'
          : dateFilter === 'quarterly' ? 'previous quarter'
          : 'previous year',
      };
    }

    const summary = buildMapSummary(barangayCases, trend);

    res.json({
      success: true,
      data: {
        barangayCases,
        summary: {
          ...summary,
          lastUpdated: new Date().toISOString(),
        },
      },
    });
    logActivity(req, { action: ACTIONS.VIEW, module: MODULES.MAP, reference_id: 'map', description: `Viewed Geographic Map data (${animalType || 'All'} / ${dateFilter || 'All periods'})` });
  } catch (error) {
    console.error('Get map data error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/barangay-cases', async (req, res) => {
  try {
    // Use per-case barangay from patient_exposures (COALESCE falls back to
    // patients.barangay for rows that predate migration_017).
    const [rows] = await pool.query(`
      SELECT
        COALESCE(pe.barangay, p.barangay) AS barangay,
        COUNT(CASE WHEN pe.exposure_id IS NOT NULL THEN pe.exposure_id ELSE p.patient_id END) AS case_count,
        ROUND(
          COUNT(CASE WHEN pe.exposure_id IS NOT NULL THEN pe.exposure_id ELSE p.patient_id END)
            / (SELECT COUNT(*) FROM patients) * 100,
          2
        ) AS percentage
      FROM patients p
      LEFT JOIN patient_exposures pe ON pe.patient_id = p.patient_id
      GROUP BY COALESCE(pe.barangay, p.barangay)
      ORDER BY case_count DESC
    `);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Get barangay cases error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

function keepLatestExposureRows(rows) {
  const byExposure = new Map();
  const withoutExposure = [];
  for (const row of rows || []) {
    if (row.exposure_id == null) {
      withoutExposure.push(row);
      continue;
    }
    const prev = byExposure.get(row.exposure_id);
    if (!prev || Number(row.episode_id || 0) > Number(prev.episode_id || 0)) {
      byExposure.set(row.exposure_id, row);
    }
  }
  return [...byExposure.values(), ...withoutExposure];
}

function aggregatePatientGroup(ps, label) {
  const population = ps.length;
  const males   = ps.filter((p) => sexCode(p.sex) === 'M').length;
  const females = ps.filter((p) => sexCode(p.sex) === 'F').length;
  const total   = population;

  const ageLt15  = ps.filter((p) => {
    const age = recordedAge(p.age);
    return age != null && age < 15;
  }).length;
  const ageGte15 = ps.filter((p) => {
    const age = recordedAge(p.age);
    return age != null && age >= 15;
  }).length;

  const cat1 = ps.filter(p => String(p.category) === '1').length;
  const cat2 = ps.filter(p => String(p.category) === '2').length;
  const cat3 = ps.filter(p => String(p.category) === '3').length;
  const catTotal = cat1 + cat2 + cat3;

  const hr = ps.filter(p => p.outcome === 'D').length;
  const ib   = ps.filter(p => p.washing_of_bite === 'Y').length;
  const hrPep = hr;
  const tcv  = ps.filter(p => p.vaccine_d0 || p.vaccine_d3 || p.vaccine_d7).length;
  // HRIG/ERIG come from Add Patient immunoglobulin selection (and rig_records),
  // not from TCV injection route (IM/ID).
  const hrig = ps.filter(p => p._hrig).length;
  const erig = ps.filter(p => p._erig).length;

  const dogs   = ps.filter((p) => animalBucket(p.type_of_animal) === 'dog').length;
  const cats   = ps.filter((p) => animalBucket(p.type_of_animal) === 'cat').length;
  const others = ps.filter((p) => animalBucket(p.type_of_animal) === 'other').length;
  const animalTotal = dogs + cats + others;

  const pepTotal = tcv;
  const pctTCV = population > 0 ? ((tcv / population) * 100).toFixed(2) : '0.00';
  const rigTotal = hrig + erig;
  const pctRIG = population > 0 ? ((rigTotal / population) * 100).toFixed(2) : '0.00';

  return {
    label,
    population,
    males,
    females,
    total,
    ageLt15,
    ageGte15,
    cat1, cat2, cat3, catTotal,
    hr,
    ib, hrPep, tcv, hrig, erig,
    dogs, cats, others, animalTotal,
    pepTotal,
    pctTCV,
    pctRIG,
    rigTotal,
  };
}

function computeTotalsFromRows(rows) {
  const sum = (field) => rows.reduce((a, r) => a + (parseFloat(r[field]) || 0), 0);
  const totPop  = sum('population');
  const totTCV  = sum('tcv');
  const totRIG  = sum('rigTotal');
  return {
    label:       'TOTAL',
    population:  totPop,
    males:       sum('males'),
    females:     sum('females'),
    total:       totPop,
    ageLt15:     sum('ageLt15'),
    ageGte15:    sum('ageGte15'),
    cat1:        sum('cat1'),
    cat2:        sum('cat2'),
    cat3:        sum('cat3'),
    catTotal:    sum('catTotal'),
    hr:          sum('hr'),
    ib:          sum('ib'),
    hrPep:       sum('hrPep'),
    tcv:         totTCV,
    hrig:        sum('hrig'),
    erig:        sum('erig'),
    dogs:        sum('dogs'),
    cats:        sum('cats'),
    others:      sum('others'),
    animalTotal: sum('animalTotal'),
    pepTotal:    totTCV,
    pctTCV:      totPop > 0 ? ((totTCV / totPop) * 100).toFixed(2) : '0.00',
    pctRIG:      totPop > 0 ? ((totRIG / totPop) * 100).toFixed(2) : '0.00',
    rigTotal:    totRIG,
  };
}

router.get('/quarterly-report', async (req, res) => {
  try {
    const generatedBy = getAuditBy(req);
    const { quarter, year } = req.query;
    const period = reportPeriodRange({
      reportType: 'quarterly',
      year,
      quarter,
    });
    const q = period.quarter;
    const y = period.year;
    const startDate = period.startDate;
    const endDate = period.endDate;

    // Same source as Nurse Analytics: each patient_exposures row is one case,
    // with age/sex from patients and animal type from that exposure.
    const biteCases = await loadBiteCases(pool);
    const filtered = filterAnalyticsCases(biteCases, { year: y, quarter: q });
    const allCases = filtered.cases.map((row) => ({
      ...row,
      case_date: row.date_of_exposure,
    }));

    // RIG data is already loaded in allCases (from patients table via loadBiteCases)
    // Just need to apply classification flags based on the existing fields
    applyImmunoglobulinFlags(allCases, []);

    // Filter RIG flags based on administration date within reporting period
    allCases.forEach(c => {
      // Only count ERIG if it was administered within the reporting period
      if (c._erig && c.rig_equine_date) {
        const rigDate = new Date(c.rig_equine_date);
        const start = new Date(startDate);
        const end = new Date(endDate);
        if (rigDate < start || rigDate > end) {
          c._erig = false; // RIG was given outside reporting period
        }
      }
      // Only count HRIG if it was administered within the reporting period
      if (c._hrig && c.rig_human_date) {
        const rigDate = new Date(c.rig_human_date);
        const start = new Date(startDate);
        const end = new Date(endDate);
        if (rigDate < start || rigDate > end) {
          c._hrig = false; // RIG was given outside reporting period
        }
      }
    });

    // -- Weekly rows ---------------------------------------------------
    const weekMap = new Map();
    allCases.forEach(p => {
      const caseDate = toSqlDate(p.case_date || p.date_of_exposure || p.date_registered);
      if (!caseDate) return;
      const [yy, mm, dd] = caseDate.split('-').map(Number);
      const d = new Date(yy, mm - 1, dd);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      const fmt = (dt) => {
        const mo = dt.toLocaleString('en-US', { month: 'long' });
        return `${mo} ${dt.getDate()}-${weekEnd.getDate()}, ${dt.getFullYear()}`;
      };
      const key = toSqlDate(weekStart);
      if (!weekMap.has(key)) {
        weekMap.set(key, { label: fmt(weekStart), patients: [] });
      }
      weekMap.get(key).patients.push(p);
    });
    const rows = [];
    for (const [, week] of weekMap) {
      rows.push(aggregatePatientGroup(week.patients, week.label));
    }
    const totals = computeTotalsFromRows(rows);

    // -- Barangay-level distribution ----------------------------------
    const barangayMap = new Map();
    allCases.forEach(p => {
      const b = (p.barangay || 'Unknown').trim();
      if (!barangayMap.has(b)) barangayMap.set(b, []);
      barangayMap.get(b).push(p);
    });
    const totalPatients = allCases.length;
    let barangayRows = [];
    for (const [barangayName, ps] of barangayMap) {
      const agg = aggregatePatientGroup(ps, barangayName);
      const caseCount = ps.length;
      barangayRows.push({
        barangay: barangayName,
        case_count: caseCount,
        percentage: totalPatients > 0 ? ((caseCount / totalPatients) * 100).toFixed(2) : '0.00',
        risk_level: barangayRiskTier(caseCount),
        population: agg.population,
        males: agg.males,
        females: agg.females,
        ageLt15: agg.ageLt15,
        ageGte15: agg.ageGte15,
        cat1: agg.cat1, cat2: agg.cat2, cat3: agg.cat3, catTotal: agg.catTotal,
        tcv: agg.tcv, hrig: agg.hrig, erig: agg.erig,
        dogs: agg.dogs, cats: agg.cats, others: agg.others, animalTotal: agg.animalTotal,
        pctTCV: agg.pctTCV, pctRIG: agg.pctRIG,
      });
    }
    barangayRows.sort((a, b) => b.case_count - a.case_count);
    const barangayTotals = computeTotalsFromRows(barangayRows.map(b => ({
      ...b, label: b.barangay,
    })));

    // -- Predictive insights ------------------------------------------
    // Historical monthly counts ? use exposure date matching the dashboard
    const predDate = new Date(y, ((q - 1) * 3) - 9, 1);
    const predStart = `${predDate.getFullYear()}-${String(predDate.getMonth() + 1).padStart(2, '0')}-01`;
    const [monthlyData] = await pool.query(`
      SELECT
        DATE_FORMAT(COALESCE(pe.date_of_exposure, p.date_registered), '%Y-%m') AS month,
        COUNT(*) AS count
      FROM patients p
      LEFT JOIN patient_exposures pe ON pe.patient_id = p.patient_id
      WHERE COALESCE(pe.date_of_exposure, p.date_registered) >= ?
        AND COALESCE(pe.date_of_exposure, p.date_registered) <= ?
      GROUP BY DATE_FORMAT(COALESCE(pe.date_of_exposure, p.date_registered), '%Y-%m')
      ORDER BY month
    `, [predStart, endDate]);

    const last3 = monthlyData.slice(-3);
    const avgLast3 = last3.length > 0
      ? last3.reduce((s, m) => s + Number(m.count), 0) / last3.length
      : 0;

    let trend = 'Stable';
    if (last3.length >= 2) {
      const latest   = Number(last3[last3.length - 1].count);
      const previous = Number(last3[last3.length - 2].count);
      if (latest > previous * 1.1)      trend = 'Increasing';
      else if (latest < previous * 0.9) trend = 'Decreasing';
    }

    const mult = trend === 'Increasing' ? 1.2 : trend === 'Decreasing' ? 0.8 : 1;
    const predictedNextMonth   = Math.max(Math.round(avgLast3 * mult), 0);
    const predictedNextQuarter = Math.max(predictedNextMonth * 3, 0);

    // Highest risk barangay from this quarter
    const highestRiskBarangay = barangayRows[0]?.barangay || 'N/A';

    // Statistical summary + recommendations (rule-based; this report does not call the AI provider)
    const top3 = barangayRows.slice(0, 3).map(b => b.barangay).join(', ');
    const dogPct  = totals.population > 0 ? ((totals.dogs / totals.population) * 100).toFixed(1) : '0';
    const vaccRate = totals.population > 0 ? ((totals.tcv / totals.population) * 100).toFixed(1) : '0';

    let aiSummary = null;
    let recommendations = [];

    recommendations = [
      `Prioritize anti-rabies awareness and vaccination drives in barangays with highest bite burden: ${top3 || '(no data)'}.`,
      totals.dogs >= totals.cats
        ? `Dog bites represent ${dogPct}% of cases ? intensify responsible pet ownership campaigns and coordinate with City Veterinary Office for dog vaccination.`
        : `Cat bites are significant ? promote responsible cat ownership and stray management.`,
      Number(vaccRate) < 70
        ? `PEP completion is at ${vaccRate}% ? enhance patient follow-up and SMS reminders to improve compliance.`
        : `PEP completion rate of ${vaccRate}% is satisfactory; maintain current follow-up protocols.`,
      `Based on a ${trend.toLowerCase()} trend, project ${predictedNextQuarter} cases next quarter ? ensure vaccine stock (${totals.tcv > 0 ? Math.ceil((predictedNextQuarter / totals.tcv) * totals.tcv) : predictedNextQuarter} doses est.) and HRIG/ERIG supply.`,
      `Share this quarterly report with LGU and DOH stakeholders to align proactive rabies control measures.`,
    ];

    if (!aiSummary) {
      aiSummary = `During Q${q} ${y}, HOPECARE Animal Bite Center registered a total of ${totals.population} animal bite victims. Barangays ${top3 || 'N/A'} recorded the highest case volumes, with ${highestRiskBarangay} identified as the highest-risk area requiring intensified interventions. Dog bites accounted for ${dogPct}% of all exposures, while PEP (TCV) coverage reached ${vaccRate}%. Current trends are ${trend.toLowerCase()}, with a forecast of approximately ${predictedNextQuarter} cases for the following quarter ? supporting proactive vaccine stock planning and LGU/DOH coordination.`;
    }

    res.json({
      success: true,
      data: {
        quarter: q,
        year: y,
        startDate,
        endDate,
        demographics: {
          sex: { male: totals.males, female: totals.females },
          age: { lt15: totals.ageLt15, gte15: totals.ageGte15 },
          animal: { dog: totals.dogs, cat: totals.cats, other: totals.others },
        },
        rows,
        totals,
        barangayDistribution: {
          rows: barangayRows,
          totals: barangayTotals,
          totalPatients,
          affectedBarangays: barangayRows.filter(b => b.case_count > 0).length,
          highestRiskBarangay,
          top3Barangays: barangayRows.slice(0, 3).map(b => ({ barangay: b.barangay, case_count: b.case_count, percentage: b.percentage, risk_level: b.risk_level })),
        },
        predictions: {
          predictedNextMonth,
          predictedNextQuarter,
          highestRiskBarangay,
          trend,
          historicalMonths: monthlyData.slice(-12),
        },
        aiSection: {
          summary: aiSummary,
          source: 'statistical',
          recommendations,
          dogPct,
          vaccRate,
        },
      }
    });
    logActivity(req, { action: ACTIONS.GENERATE, module: MODULES.REPORTS, reference_id: 'quarterly', description: `Generated Quarterly Rabies Report (Q${q} ${y})` });
  } catch (error) {
    console.error('Quarterly report error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// -- New AI Predictive Analytics Endpoints ------------------------------------

// GET /api/analytics/predictions
router.get('/predictions', requirePermission(PERMISSIONS.ANALYTICS), async (req, res) => {
  try {
    const generatedBy = getAuditBy(req);
    // Get historical data for predictions
    const now = new Date();
    const lastYear = new Date(now.getFullYear() - 1, now.getMonth(), 1);
    
    // Get monthly data for the last 12 months
    const [monthlyData] = await pool.query(`
      SELECT 
        DATE_FORMAT(date_registered, '%Y-%m') as month,
        COUNT(*) as count
      FROM patients
      WHERE date_registered >= ?
      GROUP BY DATE_FORMAT(date_registered, '%Y-%m')
      ORDER BY month
    `, [lastYear]);
    
    // Get barangay data
    const [barangayData] = await pool.query(`
      SELECT 
        barangay,
        COUNT(*) as case_count
      FROM patients
      WHERE date_registered >= DATE_SUB(CURDATE(), INTERVAL 3 MONTH)
      GROUP BY barangay
      ORDER BY case_count DESC
    `);
    
    // Simple prediction logic (average of last 3 months with trend)
    const last3Months = monthlyData.slice(-3);
    const avgLast3 = last3Months.length > 0 
      ? last3Months.reduce((sum, m) => sum + Number(m.count), 0) / last3Months.length 
      : 0;
    
    // Calculate trend
    let trend = 'Stable';
    if (last3Months.length >= 2) {
      const latest = Number(last3Months[last3Months.length - 1].count);
      const previous = Number(last3Months[last3Months.length - 2].count);
      if (latest > previous * 1.1) trend = 'Increasing';
      else if (latest < previous * 0.9) trend = 'Decreasing';
    }
    
    // Predict next month and quarter
    const predictedNextMonth = Math.round(avgLast3 * (trend === 'Increasing' ? 1.2 : trend === 'Decreasing' ? 0.8 : 1));
    const predictedNextQuarter = Math.round(predictedNextMonth * 3);
    
    // Get highest risk barangay
    const highestRiskBarangay = barangayData.length > 0 ? barangayData[0].barangay : 'N/A';
    
    res.json({
      success: true,
      data: {
        predictedNextMonth: Math.max(predictedNextMonth, 0),
        predictedNextQuarter: Math.max(predictedNextQuarter, 0),
        highestRiskBarangay,
        trend,
        historicalData: monthlyData,
        barangayData
      }
    });
    logActivity(req, { action: ACTIONS.GENERATE, module: MODULES.ANALYTICS, reference_id: 'predictions', description: 'Generated AI Predictive Analytics' });
  } catch (error) {
    console.error('Predictions error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate predictions' });
  }
});

// POST /api/analytics/generate-analysis
router.post('/generate-analysis', requirePermission(PERMISSIONS.ANALYTICS), async (req, res) => {
  try {
    const summary = await collectNurseSummary({ ...(req.query || {}), ...(req.body && req.body.filters ? req.body.filters : {}) });
    try {
      const analysis = await aiService.interpretOrThrow(summary, 'Nurse');
      res.json({
        success: true,
        data: {
          summary: [...analysis.insights, analysis.trendExplanation].filter(Boolean).join(' '),
          recommendations: analysis.recommendations,
          source: analysis.source,
          aiUsed: true,
          generatedAt: analysis.generatedAt,
        },
      });
    } catch (aiErr) {
      const stats = remisAi.fallbackNurse(summary);
      return res.status(aiClient.httpStatusFor(aiErr.code)).json(aiService.failureBody(aiErr, {
        data: {
          summary: stats.insights.join(' '),
          recommendations: stats.recommendations,
          source: 'statistical',
          aiUsed: false,
        },
      }));
    }
    logActivity(req, { action: ACTIONS.GENERATE, module: MODULES.ANALYTICS, reference_id: 'ai-analysis', description: 'Generated AI Analysis Report with recommendations' });
  } catch (error) {
    console.error('Generate analysis error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate analysis' });
  }
});

// GET /api/analytics/ai-summary (legacy endpoint)
router.get('/ai-summary', requirePermission(PERMISSIONS.ANALYTICS), async (req, res) => {
  try {
    const generatedBy = getAuditBy(req);
    // First get predictions
    const now = new Date();
    const lastYear = new Date(now.getFullYear() - 1, now.getMonth(), 1);
    
    const [monthlyData] = await pool.query(`
      SELECT DATE_FORMAT(date_registered, '%Y-%m') as month, COUNT(*) as count
      FROM patients WHERE date_registered >= ? GROUP BY DATE_FORMAT(date_registered, '%Y-%m') ORDER BY month
    `, [lastYear]);
    
    const [barangayData] = await pool.query(`
      SELECT barangay, COUNT(*) as case_count FROM patients
      WHERE date_registered >= DATE_SUB(CURDATE(), INTERVAL 3 MONTH)
      GROUP BY barangay ORDER BY case_count DESC
    `);
    
    const last3Months = monthlyData.slice(-3);
    const avgLast3 = last3Months.length > 0 
      ? last3Months.reduce((sum, m) => sum + Number(m.count), 0) / last3Months.length 
      : 0;
    
    let trend = 'Stable';
    if (last3Months.length >= 2) {
      const latest = Number(last3Months[last3Months.length - 1].count);
      const previous = Number(last3Months[last3Months.length - 2].count);
      if (latest > previous * 1.1) trend = 'Increasing';
      else if (latest < previous * 0.9) trend = 'Decreasing';
    }
    
    const predictedNextMonth = Math.round(avgLast3 * (trend === 'Increasing' ? 1.2 : trend === 'Decreasing' ? 0.8 : 1));
    const highestRiskBarangay = barangayData.length > 0 ? barangayData[0].barangay : 'N/A';
    
    const summary = `Based on historical records, ${highestRiskBarangay} is expected to remain the highest-risk area next quarter. The projected ${trend.toLowerCase()} in animal bite cases suggests that HOPECARE should strengthen awareness campaigns and ensure sufficient anti-rabies vaccine stock.`;
    
    const recommendations = [
      'Increase awareness campaign',
      'Monitor high-risk barangays',
      'Prepare additional vaccine stock',
      'Strengthen follow-up monitoring'
    ];
    
    res.json({
      success: true,
      data: { summary, recommendations }
    });
    logActivity(req, { action: ACTIONS.GENERATE, module: MODULES.ANALYTICS, reference_id: 'ai-summary', description: 'Generated AI summary for analytics' });
  } catch (error) {
    console.error('AI Summary error:', error);
    res.status(500).json({ success: false, message: 'Failed to get AI summary' });
  }
});

function animalCodeList(animalType) {
  if (!animalType || animalType === 'all') return null;
  const map = { Dog: ['D', 'SD'], Cat: ['C'], Other: ['O'] };
  if (map[animalType]) return map[animalType];
  return ['D', 'SD', 'C', 'O'].includes(animalType) ? [animalType] : null;
}

/** One exposure row per bite case, plus patients who have no exposure row yet. */
async function queryGeoCases(pool, startDate, endDate, animalType) {
  const codes = animalCodeList(animalType);
  const exposureAnimal = codes
    ? ` AND COALESCE(pe.type_of_animal, p.type_of_animal) IN (${codes.map(() => '?').join(',')})`
    : '';
  const patientAnimal = codes ? ` AND p.type_of_animal IN (${codes.map(() => '?').join(',')})` : '';
  const sql = `SELECT * FROM (
      SELECT
        p.patient_id,
        p.age,
        p.sex,
        p.date_registered,
        COALESCE(pe.date_of_exposure, p.date_registered) AS case_date,
        COALESCE(pe.type_of_animal,  p.type_of_animal)  AS type_of_animal,
        COALESCE(pe.category,        p.category)        AS category,
        COALESCE(pe.barangay,        p.barangay)        AS barangay,
        pe.exposure_id
      FROM patients p
      INNER JOIN patient_exposures pe ON pe.patient_id = p.patient_id
      WHERE COALESCE(pe.date_of_exposure, p.date_registered) BETWEEN ? AND ?${exposureAnimal}
      UNION ALL
      SELECT
        p.patient_id,
        p.age,
        p.sex,
        p.date_registered,
        p.date_registered AS case_date,
        p.type_of_animal,
        p.category,
        p.barangay,
        NULL AS exposure_id
      FROM patients p
      WHERE p.date_registered BETWEEN ? AND ?${patientAnimal}
        AND NOT EXISTS (SELECT 1 FROM patient_exposures pe3 WHERE pe3.patient_id = p.patient_id)
    ) _cases ORDER BY case_date`;
  const params = [startDate, endDate];
  if (codes) params.push(...codes);
  params.push(startDate, endDate);
  if (codes) params.push(...codes);
  const [rows] = await pool.query(sql, params);
  return rows;
}

// -- /geo-ai-report ? Geographic Mapping & AI Analytics Report -------------
router.get('/geo-ai-report', requirePermission(PERMISSIONS.ANALYTICS), async (req, res) => {
  try {
    const generatedBy = getAuditBy(req);
    const {
      reportType = 'quarterly',
      year,
      quarter,
      month,
      animalType = 'all',
      riskLevel = 'all',
    } = req.query;

    const period = reportPeriodRange({ reportType, year, quarter, month });
    const y = period.year;
    const q = period.quarter;
    const m = period.month;
    const { startDate, endDate, periodLabel } = period;

    const pad2 = (n) => String(n).padStart(2, '0');
    let predStart;
    if (reportType === 'monthly') {
      const d = new Date(y, (m || 1) - 1, 1);
      d.setMonth(d.getMonth() - 11);
      predStart = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
    } else if (reportType === 'annual') {
      predStart = `${y - 2}-01-01`;
    } else {
      const d = new Date(y, (q - 1) * 3, 1);
      d.setMonth(d.getMonth() - 11);
      predStart = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
    }
    const loadStart = predStart < startDate ? predStart : startDate;

    // Same case grain for the reporting period and the forecast history.
    // A LEFT JOIN would double-count patients who have more than one exposure.
    const historyRows = await queryGeoCases(pool, loadStart, endDate, animalType);
    const periodRows = historyRows.filter((row) => {
      const day = toSqlDate(row.case_date);
      return day && day >= startDate && day <= endDate;
    });
    const selectedRisk = ['None', 'Low', 'Medium', 'High', 'Critical'].includes(riskLevel) ? riskLevel : 'all';
    const riskFiltered = filterCasesByRisk(periodRows, selectedRisk, officialGingoogBarangays());
    const cases = riskFiltered.cases;

    let predictionRows = historyRows;
    if (selectedRisk === 'None') predictionRows = [];
    else if (selectedRisk !== 'all') {
      const allowed = new Set(cases.map((row) => String(row.barangay || 'Unknown').trim().toLowerCase()));
      predictionRows = historyRows.filter((row) => allowed.has(String(row.barangay || 'Unknown').trim().toLowerCase()));
    }

    const populations = await loadBarangayPopulations(pool);
    const analytics = buildGeographicAnalytics({
      periodCases: cases,
      historyCases: predictionRows,
      historyStart: loadStart,
      historyEnd: endDate,
      populations,
      riskBasis: 'case_count',
      periodLabel,
      selectedRisk,
      zeroBarangays: riskFiltered.zeroBarangays,
    });

    const total = analytics.total;
    const maleCount = cases.filter((c) => c.sex === 'M').length;
    const femaleCount = cases.filter((c) => c.sex === 'F').length;
    const topBarangays = analytics.topBarangays;
    const brgyCases = analytics.barangayCases;
    const mostCommonAnimal = analytics.mostCommonAnimal;
    const affectedBarangays = analytics.affectedBarangays;
    const overallRisk = analytics.overallRiskLevel;

    // -- Category distribution -----------------------------------------
    const catDistMap = {};
    cases.forEach(c => {
      if (c.category != null) {
        catDistMap[c.category] = (catDistMap[c.category] || 0) + 1;
      }
    });
    const categoryData = Object.entries(catDistMap)
      .map(([category, count]) => ({ category: parseInt(category), count }))
      .sort((a, b) => a.category - b.category);

    // -- Age distribution ----------------------------------------------
    const ageGroupMap = {};
    cases.forEach(c => {
      const a = parseInt(c.age) || 0;
      const g = a <= 10 ? '0?10' : a <= 20 ? '11?20' : a <= 30 ? '21?30'
              : a <= 40 ? '31?40' : a <= 50 ? '41?50' : '51+';
      ageGroupMap[g] = (ageGroupMap[g] || 0) + 1;
    });
    const ageData = Object.entries(ageGroupMap).map(([age_group, count]) => ({ age_group, count }));

    // -- Monthly trend -------------------------------------------------
    const monthMap = {};
    cases.forEach(c => {
      const mo = toSqlDate(c.case_date);
      if (mo) {
        const key = mo.slice(0, 7);
        monthMap[key] = (monthMap[key] || 0) + 1;
      }
    });
    const monthlyTrend = Object.entries(monthMap)
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month));

    let predNextMonthLabel = '—';
    let predNextQuarterLabel = '—';
    if (reportType === 'monthly') {
      const nextMo = new Date(y, m, 1);
      predNextMonthLabel = `${nextMo.toLocaleString('en-US', { month: 'long' })} ${nextMo.getFullYear()}`;
      const nq = m >= 10 ? 1 : Math.ceil((m + 1) / 3);
      const nqy = m >= 10 ? y + 1 : y;
      predNextQuarterLabel = `${['Q1', 'Q2', 'Q3', 'Q4'][nq - 1]} ${nqy}`;
    } else if (reportType === 'annual') {
      predNextMonthLabel = `January ${y + 1}`;
      predNextQuarterLabel = `Q1 ${y + 1}`;
    } else {
      const nextMoDate = new Date(y, q * 3, 1);
      predNextMonthLabel = `${nextMoDate.toLocaleString('en-US', { month: 'long' })} ${nextMoDate.getFullYear()}`;
      const nq = q === 4 ? 1 : q + 1;
      const nqy = q === 4 ? y + 1 : y;
      predNextQuarterLabel = `${['Q1', 'Q2', 'Q3', 'Q4'][nq - 1]} ${nqy}`;
    }

    const geoPayload = {
      ...analytics.aiPayload,
      categoryDistribution: categoryData,
      officialBarangays: officialGingoogBarangays(),
    };

    const wantInterpret = String(req.query.interpret || '') === '1';
    const geoAi = await aiService.interpretGeo(geoPayload, {
      allowAi: wantInterpret,
      periodStart: startDate,
      periodEnd: endDate,
    });
    const aiUsed = geoAi.source === aiClient.PROVIDER;
    const aiAvailable = aiUsed;
    const aiErrorCode = geoAi.error ? aiClient.publicErrorCode(geoAi.error.code) : null;
    let aiMessage = null;
    if (geoAi.error) {
      aiMessage = `${aiClient.publicMessage(geoAi.error.code)} The observations below are statistical (not AI-generated).`;
    } else if (!aiUsed) {
      aiMessage = 'Statistical observations from REMIS (not AI-generated). Tick "Include AI interpretation" and generate the report to add AI insights.';
    }

    const insights = (geoAi.insights || []).map((text) => ({ icon: '?', color: 'blue', text }));
    const recommendations = (geoAi.recommendations || []).map((text) => ({ icon: '?', text }));
    const reportSummary = geoAi.summary;

    const generatedDate = new Date().toLocaleString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    res.json({
      success: true,
      data: {
        meta: {
          reportType,
          year: y,
          quarter: q,
          month: m || null,
          periodLabel,
          riskLevel: selectedRisk,
          riskLabel: riskLevelLabel(selectedRisk),
          animalType: animalType || 'all',
          startDate,
          endDate,
          generatedDate,
          reportId: `GAMR-${y}-${String(q).padStart(2,'0')}${m ? String(m).padStart(2,'0') : '00'}`,
        },
        summary: {
          totalCases: total,
          affectedBarangays,
          highestRiskBarangay: analytics.highestRiskBarangay,
          highestRiskBarangayCases: analytics.highestRiskBarangayCases,
          highestRiskTied: analytics.highestRiskTied,
          highestRiskBarangays: analytics.highestRiskBarangays,
          mostCommonAnimal,
          animalNote: analytics.animalNote,
          overallRiskLevel: overallRisk,
          overallRiskBasis: analytics.overallRiskBasis,
          riskBasis: analytics.riskBasis,
          maleCount,
          femaleCount,
        },
        topBarangays,
        animalDistribution: analytics.animalDistribution,
        barangayCases: brgyCases,
        categoryData: categoryData,
        ageData: ageData,
        monthlyTrend: monthlyTrend,
        aiInsights: insights,
        aiAvailable,
        aiWarning: aiMessage,
        aiErrorCode,
        aiStatus: geoAi.status || (aiUsed ? 'ok' : 'statistical'),
        aiUsed,
        aiModel: aiUsed ? geoAi.model : null,
        aiGeneratedAt: aiUsed ? geoAi.generatedAt || null : null,
        trendExplanation: geoAi.trendExplanation || '',
        forecastInterpretation: geoAi.forecastInterpretation || '',
        riskAreas: geoAi.riskAreas || [],
        limitations: geoAi.limitations || '',
        summarySource: aiUsed ? aiClient.PROVIDER : 'statistical',
        predictions: {
          ...analytics.predictions,
          nextMonth: {
            ...analytics.predictions.nextMonth,
            label: predNextMonthLabel,
          },
          nextQuarter: {
            ...analytics.predictions.nextQuarter,
            label: predNextQuarterLabel,
          },
        },
        recommendations,
        reportSummary,
        disclaimer: 'AI-generated insights are based on aggregated REMIS data and are intended to support data analysis and planning. Predictions are estimates and should not be treated as guaranteed outcomes or as a substitute for professional clinical judgment.',
      }
    });
    logActivity(req, {
      action: ACTIONS.GENERATE,
      module: MODULES.MAP,
      reference_id: 'geo-ai-report',
      description: `Generated Geo-AI Report (${reportType} ${year}${aiUsed ? `, Groq ${aiClient.getActiveModel()}` : geoAi.error ? `, AI failed ${aiErrorCode}` : ', statistical'})`,
      status: 'Success',
    });

  } catch (error) {
    console.error('Geo AI report error:', error);
    res.status(500).json({ success: false, message: 'Server error generating report.' });
  }
});

module.exports = router;
