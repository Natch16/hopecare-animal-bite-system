const express = require('express');
const router = express.Router();
const pool = require('../config/database').pool;
const { requireAuth, requirePermission, normalizeRole, hasPermission } = require('../middleware/auth');
const { logActivity, MODULES, ACTIONS } = require('../utils/activityLogger');
const { generateStaffId, parseStaffIdDisplay } = require('../utils/idFormats');
const { PERMISSIONS } = require('../utils/permissions');

function requireActivityLogAccess(req, res, next) {
  if (!req.session?.loggedIn) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }
  const role = normalizeRole(req.session.role);
  if (hasPermission(role, PERMISSIONS.ACTIVITY_LOGS) || hasPermission(role, PERMISSIONS.ACTIVITY_LOGS_VIEW)) {
    return next();
  }
  return res.status(403).json({ success: false, message: 'Access denied' });
}

router.use(requireAuth);

router.get('/', requireActivityLogAccess, async (req, res) => {
  try {
    const {
      staff_name,
      staff_id,
      username,
      module,
      action,
      date_from,
      date_to,
      page = 1,
      limit = 50,
    } = req.query;

    const conditions = ['1=1'];
    const params = [];

    if (staff_id) {
      const sid = parseStaffIdDisplay(staff_id) ?? parseInt(staff_id, 10);
      if (!isNaN(sid)) {
        conditions.push('staff_id = ?');
        params.push(sid);
      }
    }

    if (staff_name) {
      conditions.push('full_name LIKE ?');
      params.push(`%${staff_name}%`);
    }
    if (username) {
      conditions.push('username LIKE ?');
      params.push(`%${username}%`);
    }
    if (module) {
      conditions.push('module = ?');
      params.push(module);
    }
    if (action) {
      conditions.push('action = ?');
      params.push(action);
    }
    if (date_from) {
      conditions.push('DATE(created_at) >= DATE(?)');
      params.push(date_from);
    }
    if (date_to) {
      conditions.push('DATE(created_at) <= DATE(?)');
      params.push(date_to);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM activity_logs ${where}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);

    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (p - 1) * l;

    const [rows] = await pool.query(
      `SELECT id, staff_id, username, full_name, role, action, module, reference_id,
              description, old_value, new_value, status, shift, created_at
       FROM activity_logs ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, l, offset]
    );

    const data = rows.map(r => ({
      ...r,
      staff_id_display: generateStaffId(r.staff_id),
    }));

    res.json({
      success: true,
      data,
      pagination: {
        page: p,
        limit: l,
        total,
        total_pages: Math.ceil(total / l),
      },
    });
  } catch (err) {
    console.error('Activity logs list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [[row]] = await pool.query(
      `SELECT id, staff_id, username, full_name, role, action, module, reference_id,
              description, old_value, new_value, status, shift, created_at
       FROM activity_logs WHERE id = ? LIMIT 1`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Log entry not found' });
    row.staff_id_display = generateStaffId(row.staff_id);
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('Activity log detail error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/meta/filters', async (req, res) => {
  try {
    const [modules] = await pool.query(
      'SELECT DISTINCT module FROM activity_logs ORDER BY module ASC'
    );
    const [actions] = await pool.query(
      'SELECT DISTINCT action FROM activity_logs ORDER BY action ASC'
    );
    const [staff] = await pool.query(
      `SELECT DISTINCT staff_id, username, full_name
       FROM activity_logs
       WHERE full_name IS NOT NULL OR username IS NOT NULL
       ORDER BY full_name ASC, username ASC`
    );
    res.json({
      success: true,
      data: {
        modules: modules.map(r => r.module),
        actions: actions.map(r => r.action),
        staff: staff.map(r => ({
          staff_id: r.staff_id,
          staff_id_display: generateStaffId(r.staff_id),
          username: r.username,
          full_name: r.full_name,
        })),
      },
    });
  } catch (err) {
    console.error('Activity filters error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/activity-logs — allow frontend to record a UI-initiated action
// (e.g. export PDF, print, frontend-only flows). Request body must match
// the schema used by logActivity(). We deliberately restrict valid values
// to prevent garbage logs.
router.post('/', async (req, res) => {
  try {
    const { action, module: mod, reference_id, description } = req.body || {};
    if (!action || !mod) {
      return res.status(400).json({ success: false, message: 'action and module are required' });
    }
    await logActivity(req, {
      action: String(action).slice(0, 100),
      module: String(mod).slice(0, 100),
      reference_id: reference_id ? String(reference_id).slice(0, 255) : null,
      description: description ? String(description).slice(0, 1000) : null,
    });
    res.json({ success: true, message: 'Activity recorded' });
  } catch (err) {
    console.error('Activity log write error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
