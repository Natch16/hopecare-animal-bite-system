const express = require('express');
const router = express.Router();
const pool = require('../config/database').pool;
const { requireAuth, requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../utils/permissions');
const { logActivity, MODULES, ACTIONS } = require('../utils/activityLogger');
const { buildInventorySheets, localYmd } = require('../utils/vaccineInventorySheet');
const { fetchCurrentLotGroups, summarizeLotGroups, currentStockLevels } = require('../utils/currentLotStock');

router.use(requireAuth);
router.use(requirePermission(PERMISSIONS.INVENTORY_REPORTS));

function rangeForType(type, { date, month, year, from, to }) {
  if (from && to) {
    const title = from === to
      ? 'Daily Vaccine Inventory Report'
      : 'Vaccine Inventory Sheet';
    return { title, from, to };
  }
  if (date && !from && !to) {
    return { title: 'Daily Vaccine Inventory Report', from: date, to: date };
  }
  const today = date || localYmd();
  if (type === 'weekly') {
    const end = new Date(`${today}T00:00:00`);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    return {
      title: 'Vaccine Inventory Sheet — Weekly',
      from: localYmd(start),
      to: today,
    };
  }
  if (type === 'monthly') {
    const y = year ? Number(year) : Number(today.slice(0, 4));
    const m = month ? Number(month) : Number(today.slice(5, 7));
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const last = new Date(y, m, 0).getDate();
    return {
      title: 'Vaccine Inventory Sheet — Monthly',
      from: start,
      to: `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`,
    };
  }
  return { title: 'Daily Vaccine Inventory Report', from: today, to: today };
}

router.get('/generate', async (req, res) => {
  try {
    const { type = 'daily', date, month, year, from, to } = req.query;
    const range = rangeForType(type, { date, month, year, from, to });
    
    // FIX: Use getClinicSheet (same as Management page) instead of buildInventorySheets
    const { getClinicSheet } = require('../utils/vaccineInventorySheet');
    const { eachDate } = require('../utils/vaccineInventorySheet');
    
    // Generate date range
    const dates = [];
    let current = new Date(range.from);
    const endDate = new Date(range.to);
    while (current <= endDate) {
      const y = current.getFullYear();
      const m = String(current.getMonth() + 1).padStart(2, '0');
      const d = String(current.getDate()).padStart(2, '0');
      dates.push(`${y}-${m}-${d}`);
      current.setDate(current.getDate() + 1);
    }
    
    // Fetch data for each date using the SAME function as Management page
    const days = [];
    for (const d of dates) {
      const sheetData = await getClinicSheet(pool, { date: d });
      if (sheetData && sheetData.rows && sheetData.rows.length > 0) {
        days.push({
          date: d,
          rows: sheetData.rows,
          doses_used: sheetData.rows.reduce((s, r) => s + (r.vaccine_used != null ? Number(r.vaccine_used) : 0), 0),
        });
      }
    }
    
    const sheet = { dateFrom: range.from, dateTo: range.to, days };
    const allRows = days.flatMap((d) => d.rows || []);
    
    // Calculate totals using the SAME logic as Management page
    const totalUsed = allRows.reduce((s, r) => {
      // Only count if PM recorded or completed
      if ((r.pm_recorded || r.sheet_status === 'Completed') && r.vaccine_used != null) {
        return s + Number(r.vaccine_used);
      }
      return s;
    }, 0);
    
    const totalAdditional = allRows.reduce((s, r) => {
      // Sum both AM additional and PM additional
      const amAdd = Number(r.am_additional != null ? r.am_additional : r.additional_vaccine) || 0;
      const pmAdd = Number(r.pm_additional) || 0;
      return s + amAdd + pmAdd;
    }, 0);

    const [lots] = await pool.query(
      `SELECT vi.*, v.name AS vaccine_name
       FROM vaccine_inventory vi
       JOIN vaccines v ON v.vaccine_id = vi.vaccine_id`
    );
    const { enrichLot } = require('../utils/inventoryBatches');
    let expiredVaccines = 0;
    (lots || []).forEach((r) => {
      const lot = enrichLot(r);
      if (lot.batch_status === 'Expired' && Number(lot.quantity) > 0) expiredVaccines += 1;
    });

    const lotSummary = summarizeLotGroups(await fetchCurrentLotGroups(pool));
    const levels = currentStockLevels(lotSummary.lots);
    const lotCounts = lotSummary.counts;
    const lowStock = levels.low;

    logActivity(req, {
      action: ACTIONS.GENERATE,
      module: MODULES.REPORTS,
      reference_id: type,
      description: `Generated ${range.title}`,
    });

    res.json({
      success: true,
      data: {
        title: range.title,
        type,
        generated_at: new Date().toISOString(),
        center: 'ABC Animal Bite Center — Gingoog City',
        dateFrom: range.from,
        dateTo: range.to,
        sheet,
        summary: {
          total_used: totalUsed,
          total_additional: totalAdditional,
          current_stock: lotCounts.total_stock,
          low_stock: lowStock,
          expired: expiredVaccines,
        },
      },
    });
  } catch (err) {
    console.error('Report generate error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
