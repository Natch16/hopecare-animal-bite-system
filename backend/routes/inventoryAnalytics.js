const express = require('express');
const router = express.Router();
const pool = require('../config/database').pool;
const { requireAuth, requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../utils/permissions');
const { getExpiryStatus, getStockLevel } = require('../utils/inventoryHelpers');
const { enrichLot } = require('../utils/inventoryBatches');
const { collectClinicInventoryAnalytics } = require('../utils/inventoryPredictiveAnalytics');

router.use(requireAuth);
router.use(requirePermission(PERMISSIONS.ANALYTICS));

router.get('/overview', async (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : null;
    const month = req.query.month ? Number(req.query.month) : null;
    let date_from = req.query.date_from;
    let date_to = req.query.date_to;
    if (year && month >= 1 && month <= 12) {
      const mm = String(month).padStart(2, '0');
      date_from = `${year}-${mm}-01`;
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      date_to = `${year}-${mm}-${String(last).padStart(2, '0')}`;
    } else if (year) {
      date_from = `${year}-01-01`;
      date_to = `${year}-12-31`;
    }
    const inv = await collectClinicInventoryAnalytics(pool, {
      date_from,
      date_to,
      vaccine_id: req.query.vaccine_id,
      grain: 'month',
    });

    const [inventoryRows] = await pool.query(`
      SELECT vi.*, v.name as vaccine_name FROM vaccine_inventory vi
      JOIN vaccines v ON vi.vaccine_id = v.vaccine_id
    `);
    const lowStock = [];
    const expired = [];
    inventoryRows.forEach((r) => {
      const lot = enrichLot(r);
      const s = getStockLevel(lot.usable_quantity, r.low_stock_threshold, r.critical_stock_threshold);
      const e = getExpiryStatus(r.expiry_date);
      if (lot.usable_quantity > 0 && (s.class === 'stock-low' || s.class === 'stock-critical')) {
        lowStock.push({ ...lot, stock_status: s });
      }
      if (lot.batch_status === 'Expired' || e.class === 'exp-expired') {
        expired.push({ ...lot, expiry_status: e });
      }
    });

    const usageByBrand = (inv.usageByBrand || []).map((r) => ({
      brand: r.brand, category: null, total_used: r.qty,
    }));
    const monthlyConsumption = Object.keys(inv.monthlyUsage || {}).sort().map((month) => ({
      month, consumption: inv.monthlyUsage[month],
    }));
    const dailyUsage = (inv.usageSeries || []).map((p) => ({ day: p.period, used: p.used }));
    const remainingInventory = (inv.forecast || []).map((r) => ({
      brand: r.vaccine, remaining: r.currentStock, expired: 0,
    }));

    res.json({
      success: true,
      data: {
        usageByBrand,
        monthlyConsumption,
        dailyUsage,
        remainingInventory,
        transactionsByShift: [],
        lowStockVaccines: lowStock,
        expiredVaccines: expired,
        mostUsedVaccine: usageByBrand[0] || null,
        leastUsedVaccine: usageByBrand.length ? usageByBrand[usageByBrand.length - 1] : null,
        source: inv.source,
        usageDefinition: inv.usageDefinition,
      },
    });
  } catch (err) {
    if (err && err.status === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error('Inventory analytics error:', err);
    res.status(500).json({ success: false, message: 'The system is temporarily unavailable. Please try again later.' });
  }
});

module.exports = router;
