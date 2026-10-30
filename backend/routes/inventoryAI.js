const express = require('express');
const router = express.Router();
const pool = require('../config/database').pool;
const { requireAuth, requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../utils/permissions');
const { logActivity, MODULES, ACTIONS } = require('../utils/activityLogger');
const { collectClinicInventoryAnalytics } = require('../utils/inventoryPredictiveAnalytics');

router.use(requireAuth);
router.use(requirePermission(PERMISSIONS.AI_ANALYTICS));

router.get('/predictions', async (req, res) => {
  try {
    const inv = await collectClinicInventoryAnalytics(pool, req.query);
    const predictions = (inv.forecast || []).map((row) => {
      const monthlyAvg = Math.max(0, Number(row.dailyUsage) || 0) * 30;
      const daysUntilEmpty = row.currentStock > 0 && row.dailyUsage > 0
        ? Math.round(row.currentStock / row.dailyUsage)
        : (row.currentStock > 0 ? null : 0);
      return {
        brand: row.vaccine,
        current_stock: Number(row.currentStock) || 0,
        monthly_avg_usage: Math.round(monthlyAvg),
        predicted_monthly_demand: row.forecastUsage,
        days_until_shortage: daysUntilEmpty,
        recommended_reorder_qty: Math.max(row.forecastUsage, Number(row.currentStock) < row.forecastUsage ? row.forecastUsage : 0),
        shortage_risk: row.replenishmentWarning ? (row.warning && /Critical/.test(row.warning) ? 'High' : 'Medium') : 'Low',
        confidence: row.dataSufficient ? 75 : 40,
        dataLimitations: row.dataLimitations,
      };
    });

    const insights = [];
    const recommendations = [];
    if (inv.mostUsedVaccine) {
      insights.push(`${inv.mostUsedVaccine} had the highest verified clinic usage in the selected period.`);
    }
    (inv.forecast || []).filter((p) => p.replenishmentWarning).slice(0, 3).forEach((p) => {
      insights.push(`${p.vaccine}: ${p.warning || 'replenishment may be needed'}.`);
      recommendations.push(`Review ${p.vaccine} stock against estimated forecast usage of ${p.forecastUsage} (estimated).`);
    });
    if (!inv.dataSufficient) {
      insights.push(inv.forecastNote);
    }
    if (!recommendations.length) {
      recommendations.push('Continue recording AM and PM inventory so forecasts stay based on verified clinic usage.');
    }

    res.json({
      success: true,
      data: {
        predictions,
        insights,
        recommendations,
        ai_summary: null,
        usageSeries: inv.usageSeries,
        forecast: inv.forecast,
        generated_at: new Date().toISOString(),
      },
    });
    logActivity(req, {
      action: ACTIONS.GENERATE,
      module: MODULES.INVENTORY,
      reference_id: 'inventory-ai',
      description: 'Generated inventory statistical predictions from clinic usage',
      status: 'Success',
    });
  } catch (err) {
    if (err && err.status === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error('AI predictions error:', err);
    res.status(500).json({ success: false, message: 'The system is temporarily unavailable. Please try again later.' });
  }
});

module.exports = router;
