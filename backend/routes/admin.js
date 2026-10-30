const express = require('express');
const router = express.Router();
const pool = require('../config/database').pool;
const { requireAuth, requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../utils/permissions');
const { logActivity, MODULES, ACTIONS } = require('../utils/activityLogger');
const aiClient = require('../utils/groqClient');
const remisAi = require('../utils/remisAi');
const aiService = require('../utils/aiService');
const { collectAdminSummary } = require('../utils/remisAiData');
const { collectAdminDashboard } = require('../utils/adminDashboardData');

router.use(requireAuth);

router.get('/dashboard', requirePermission(PERMISSIONS.ADMIN_DASHBOARD), async (req, res) => {
  try {
    const data = await collectAdminDashboard(pool, req.query);
    res.json({ success: true, data });
  } catch (err) {
    if (err && err.status === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error('Admin dashboard error:', err);
    res.status(500).json({ success: false, message: 'The dashboard is temporarily unavailable. Please try again later.' });
  }
});

router.get('/system-info', requirePermission(PERMISSIONS.SYSTEM_SETTINGS), async (req, res) => {
  try {
    const [configs] = await pool.query('SELECT * FROM system_config ORDER BY config_key');
    const [[dbInfo]] = await pool.query('SELECT DATABASE() as db_name, VERSION() as mysql_version');
    res.json({
      success: true,
      data: {
        configs,
        system: {
          node_version: process.version,
          database: dbInfo.db_name,
          mysql_version: dbInfo.mysql_version,
          center: 'HopeCare Animal Bite Center',
          municipality: 'Gingoog City',
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

const AI_UNAVAILABLE = 'AI analysis is temporarily unavailable. Please try again later.';

function shapeAdminAiData(summary, analysis, extra = {}) {
  const cases = summary.cases || {};
  const inv = summary.inventory || {};
  const mon = inv.monitoring || {};
  return {
    predictions: {
      predictedNextMonth: cases.predictedNextMonth,
      predictedNextQuarter: cases.predictedNextQuarter,
      highestRiskBarangay: cases.highestCaseBarangay || '—',
      trend: cases.trend,
      method: 'linear_regression',
      estimated: true,
    },
    cases: {
      totalPatients: cases.totalPatients,
      totalCases: cases.totalCases,
      categoryI: cases.categoryI,
      categoryII: cases.categoryII,
      categoryIII: cases.categoryIII,
      vaccinationCompletionRate: cases.vaccinationCompletionRate,
      overduePatients: cases.overduePatients,
      dueToday: cases.dueToday,
      dueThisWeek: cases.dueThisWeek,
    },
    forecast: {
      note: inv.forecastNote || 'Forecast usage is an estimate from verified Vaccine Inventory Management records. It is not a guaranteed quantity.',
      period: inv.dateFrom && inv.dateTo ? `${inv.dateFrom} to ${inv.dateTo}` : null,
      grain: inv.grain || 'day',
      forecastDays: inv.forecastDays || 30,
      items: inv.forecast || [],
    },
    usageTrends: inv.usageTrends || [],
    usageSeries: inv.usageSeries || [],
    monitoring: {
      lowStockItems: mon.lowStockItems ?? 0,
      criticalStockItems: mon.criticalStockItems ?? 0,
      expiringItems: mon.expiringItems ?? 0,
      expiredItems: mon.expiredItems ?? 0,
      outOfStockItems: mon.outOfStockItems ?? 0,
      consistency: mon.consistency || null,
      pendingVerification: mon.pendingVerification ?? 0,
      missingPm: mon.missingPm ?? 0,
      rapidlyIncreasing: mon.rapidlyIncreasing || [],
      rows: mon.rows || [],
    },
    amPmAnalysis: inv.amPmAnalysis || { completed: 0, missingAm: 0, missingPm: 0, pendingVerification: 0, rows: [] },
    shifts: inv.shifts || { sufficient: false, shiftSpecificUsageAvailable: false, monthly: [] },
    demand: inv.demand || { sufficient: false, observation: 'No bite cases or verified vaccine usage have been recorded for the selected period yet.', monthly: [] },
    inventory: {
      remainingInventory: inv.remainingInventory,
      vaccinesUsedToday: inv.vaccinesUsedToday,
      additionalVaccinesReceivedToday: inv.additionalVaccinesReceivedToday,
      additionalVaccinesReceived: inv.additionalVaccinesReceived,
      mostUsedVaccine: inv.mostUsedVaccine,
      inventoryTrend: inv.inventoryTrend,
      overallTrend: inv.overallTrend || null,
      totalVaccinesUsed: inv.totalVaccinesUsed,
      averageDailyUsage: inv.averageDailyUsage ?? 0,
      highUsageVaccines: inv.highUsageVaccines || [],
      usageDefinition: inv.usageDefinition,
    },
    dataQuality: inv.dataQuality || null,
    dataLimitations: inv.dataLimitations || [],
    backendRiskAlerts: inv.riskAlerts || [],
    noRiskMessage: inv.noRiskMessage || null,
    insights: analysis?.insights || [],
    recommendations: analysis?.recommendations || [],
    recommendationDetails: analysis?.recommendationDetails || [],
    trendExplanation: analysis?.trendExplanation || '',
    forecastInterpretation: analysis?.forecastInterpretation || '',
    riskAlerts: analysis?.riskAlerts || analysis?.riskAreas || [],
    riskAreas: analysis?.riskAlerts || analysis?.riskAreas || [],
    inventoryInsights: analysis?.inventoryInsights || [],
    limitations: analysis?.limitations || '',
    removedStatements: analysis?.removedStatements || 0,
    source: analysis?.source || null,
    status: analysis ? (analysis.source === 'fallback' ? 'statistical' : (analysis.cached ? 'cached' : 'ok')) : 'none',
    ...extra,
  };
}

async function lastSuccessfulAdminAnalysis() {
  try {
    const [[row]] = await pool.query(
      `SELECT generated_at, model FROM ai_analysis_cache
       WHERE context = 'admin' AND status = 'ok'
       ORDER BY generated_at DESC LIMIT 1`
    );
    return row ? { at: new Date(row.generated_at).toISOString(), model: row.model || null } : null;
  } catch (_) {
    return null;
  }
}

router.get('/analytics/ai-health', requirePermission(PERMISSIONS.AI_ANALYTICS), async (req, res) => {
  const st = aiClient.status();
  res.json({
    success: true,
    aiAvailable: st.configured,
    configured: st.configured,
    label: st.label,
    model: st.model,
    errorCode: st.errorCode,
    message: st.message,
  });
});

router.get('/analytics/ai-insights', requirePermission(PERMISSIONS.AI_ANALYTICS), async (req, res) => {
  const generatedAt = new Date().toISOString();
  const wantInterpret = String(req.query.interpret || '') === '1';
  try {
    const summary = await collectAdminSummary(req.query);
    let analysis = null;
    let aiUsed = false;

    if (wantInterpret) {
      try {
        analysis = await aiService.interpretOrThrow(summary, 'Administrator', {
          periodStart: summary.inventory && summary.inventory.dateFrom,
          periodEnd: summary.inventory && summary.inventory.dateTo,
        });
        aiUsed = true;
        logActivity(req, {
          action: ACTIONS.GENERATE,
          module: MODULES.ANALYTICS,
          reference_id: 'admin-ai-insights',
          description: `Admin AI analysis (Groq ${aiClient.getActiveModel()})`,
          status: 'Success',
        });
        return res.json({
          success: true,
          aiAvailable: true,
          status: 'ok',
          data: shapeAdminAiData(summary, analysis, {
            aiUsed: true,
            aiModel: analysis.model,
            generatedAt: analysis.generatedAt || generatedAt,
            lastUpdated: analysis.generatedAt || generatedAt,
            lastSuccessfulAnalysis: { at: analysis.generatedAt || generatedAt, model: analysis.model || null },
          }),
        });
      } catch (aiErr) {
        logActivity(req, {
          action: ACTIONS.GENERATE,
          module: MODULES.ANALYTICS,
          reference_id: 'admin-ai-insights',
          description: `Admin AI analysis failed (${aiClient.publicErrorCode(aiErr.code)})`,
          status: 'Failed',
        });
        return res.status(aiClient.httpStatusFor(aiErr.code)).json(aiService.failureBody(aiErr, {
          data: shapeAdminAiData(summary, remisAi.fallbackAdmin(summary), {
            aiUsed: false,
            generatedAt,
            lastUpdated: generatedAt,
            lastSuccessfulAnalysis: await lastSuccessfulAdminAnalysis(),
            warning: aiClient.publicMessage(aiErr.code) || AI_UNAVAILABLE,
          }),
        }));
      }
    }

    logActivity(req, {
      action: ACTIONS.VIEW,
      module: MODULES.ANALYTICS,
      reference_id: 'admin-ai-insights',
      description: 'Viewed Admin AI Inventory Analytics statistics',
      status: 'Success',
    });

    res.json({
      success: true,
      aiAvailable: aiClient.isConfigured(),
      data: shapeAdminAiData(summary, analysis, {
        aiUsed,
        generatedAt,
        lastUpdated: generatedAt,
        lastSuccessfulAnalysis: await lastSuccessfulAdminAnalysis(),
      }),
    });
  } catch (error) {
    if (error && error.status === 400) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error('Admin AI insights error:', error);
    logActivity(req, {
      action: ACTIONS.GENERATE,
      module: MODULES.ANALYTICS,
      reference_id: 'admin-ai-insights',
      description: 'Admin AI analysis failed',
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

router.put('/system-config', requirePermission(PERMISSIONS.SYSTEM_SETTINGS), async (req, res) => {
  try {
    const { configs } = req.body;
    const updatedBy = req.session.fullName || req.session.username;
    for (const [key, value] of Object.entries(configs || {})) {
      await pool.query(
        `INSERT INTO system_config (config_key, config_value, updated_by) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE config_value=VALUES(config_value), updated_by=VALUES(updated_by)`,
        [key, String(value), updatedBy]
      );
    }
    res.json({ success: true, message: 'System configuration updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
