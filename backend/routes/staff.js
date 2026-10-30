const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/database').pool;
const { requireAuth, getAuditBy, requirePermission, normalizeRole } = require('../middleware/auth');
const { logActivity, MODULES, ACTIONS } = require('../utils/activityLogger');
const { generateStaffId, parseStaffIdDisplay, staffIdWithRole } = require('../utils/idFormats');
const { PERMISSIONS, ROLES } = require('../utils/permissions');

router.use(requireAuth);

router.get('/', requirePermission(PERMISSIONS.STAFF_MANAGEMENT), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        id as staff_id,
        id as id,
        username,
        full_name,
        designation,
        role,
        position,
        email,
        status,
        created_at,
        updated_at
      FROM staff_account
      ORDER BY status DESC, full_name ASC, username ASC
    `);
    const withIds = rows.map(r => ({
      ...r,
      staff_id_display: generateStaffId(r.staff_id, r.role),
    }));
    res.json({ success: true, data: withIds });
  } catch (err) {
    console.error('Staff list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/search', requirePermission(PERMISSIONS.STAFF_MANAGEMENT), async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !String(q).trim()) {
      return res.status(400).json({ success: false, message: 'Search query is required' });
    }

    const term = String(q).trim();
    let query = `
      SELECT id as staff_id, id, username, full_name, designation, role, position, email, status, created_at, updated_at
      FROM staff_account WHERE 1=1`;
    const params = [];

    const staffNum = parseStaffIdDisplay(term);
    if (staffNum !== null) {
      query += ' AND id = ?';
      params.push(staffNum);
    } else if (term.toUpperCase().startsWith('STF-')) {
      const num = parseInt(term.replace(/^STF-/i, ''), 10);
      if (!isNaN(num)) {
        query += ' AND id = ?';
        params.push(num);
      }
    } else {
      query += ' AND (username LIKE ? OR full_name LIKE ? OR designation LIKE ?)';
      const like = `%${term}%`;
      params.push(like, like, like);
    }

    query += ' ORDER BY status DESC, full_name ASC, username ASC LIMIT 50';

    const [rows] = await pool.query(query, params);
    const data = rows.map(r => ({ ...r, staff_id_display: generateStaffId(r.staff_id, r.role) }));
    res.json({ success: true, data });
  } catch (err) {
    console.error('Staff search error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/:id', requirePermission(PERMISSIONS.STAFF_MANAGEMENT), async (req, res) => {
  try {
    const [[row]] = await pool.query(
      `SELECT id as staff_id, id, username, full_name, designation, role, position,
              email, status, created_at, updated_at
       FROM staff_account WHERE id = ? LIMIT 1`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Staff not found' });
    row.staff_id_display = generateStaffId(row.staff_id, row.role);
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('Staff get error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/', requirePermission(PERMISSIONS.STAFF_MANAGEMENT), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { full_name, username, password, designation, email, role } = req.body;

    if (!username || !username.trim())
      return res.status(400).json({ success: false, message: 'Username is required' });
    if (!full_name || !full_name.trim())
      return res.status(400).json({ success: false, message: 'Full name is required' });

    // Password is optional — default to 'hopecare' if not supplied
    const rawPassword = (password && String(password).length >= 1)
      ? String(password)
      : 'hopecare';

    if (rawPassword !== 'hopecare' && rawPassword.length < 6)
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

    const trimmedUsername = String(username).trim();

    const [[existing]] = await conn.query(
      'SELECT id FROM staff_account WHERE LOWER(username) = LOWER(?) LIMIT 1',
      [trimmedUsername]
    );
    if (existing)
      return res.status(409).json({ success: false, message: `Username "${trimmedUsername}" already exists` });

    const hashed = await bcrypt.hash(rawPassword, 10);

    const staffRole = normalizeRole(role || ROLES.NURSE);
    if (staffRole === ROLES.ADMINISTRATOR && normalizeRole(req.session.role) !== ROLES.ADMINISTRATOR) {
      return res.status(403).json({ success: false, message: 'Only administrators can create administrator accounts' });
    }

    const [result] = await conn.query(
      `INSERT INTO staff_account (username, password, full_name, designation, role, position, email, status)
       VALUES (?,?,?,?,?,?,?, 'Active')`,
      [
        trimmedUsername,
        hashed,
        String(full_name).trim(),
        designation || (staffRole === ROLES.ADMINISTRATOR ? 'Administrator' : 'ABC Nurse'),
        staffRole,
        designation || 'Animal Bite Center Staff',
        email || null,
      ]
    );

    logActivity(req, {
      action: ACTIONS.ADD,
      module: MODULES.STAFF,
      reference_id: result.insertId,
      description: `Added staff account: ${full_name} (${trimmedUsername})`,
    });

    res.status(201).json({
      success: true,
      message: 'Staff account created successfully',
      staff_id: result.insertId,
      staff_id_display: generateStaffId(result.insertId, staffRole),
    });
  } catch (err) {
    console.error('Staff create error:', err);
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ success: false, message: 'Username already exists' });
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    conn.release();
  }
});

router.put('/:id', requirePermission(PERMISSIONS.STAFF_MANAGEMENT), async (req, res) => {
  try {
    const { full_name, username, designation, email, status, role } = req.body;
    const staffId = req.params.id;

    const [[existing]] = await pool.query('SELECT id, username FROM staff_account WHERE id = ? LIMIT 1', [staffId]);
    if (!existing) return res.status(404).json({ success: false, message: 'Staff not found' });

    if (username) {
      const trimmedUsername = String(username).trim();
      const [[dup]] = await pool.query(
        'SELECT id FROM staff_account WHERE LOWER(username) = LOWER(?) AND id != ? LIMIT 1',
        [trimmedUsername, staffId]
      );
      if (dup)
        return res.status(409).json({ success: false, message: `Username "${trimmedUsername}" already exists` });
    }

    const staffRole = role ? normalizeRole(role) : null;
    if (staffRole === ROLES.ADMINISTRATOR && normalizeRole(req.session.role) !== ROLES.ADMINISTRATOR) {
      return res.status(403).json({ success: false, message: 'Cannot assign administrator role' });
    }

    await pool.query(
      `UPDATE staff_account SET
        full_name       = COALESCE(?, full_name),
        username        = COALESCE(?, username),
        designation     = COALESCE(?, designation),
        role            = COALESCE(?, role),
        position        = COALESCE(?, position),
        email           = COALESCE(?, email),
        status          = COALESCE(?, status)
      WHERE id = ?`,
      [
        full_name ? String(full_name).trim() : null,
        username ? String(username).trim() : null,
        designation || null,
        staffRole,
        designation || null,
        email || null,
        status || null,
        staffId,
      ]
    );

    logActivity(req, {
      action: ACTIONS.EDIT,
      module: MODULES.STAFF,
      reference_id: staffId,
      description: `Updated staff account: ${full_name || existing.username} (${username || existing.username})`,
    });

    res.json({ success: true, message: 'Staff account updated successfully' });
  } catch (err) {
    console.error('Staff update error:', err);
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ success: false, message: 'Username already exists' });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/:id/reset-password', requirePermission(PERMISSIONS.STAFF_MANAGEMENT), async (req, res) => {
  try {
    const { new_password } = req.body;
    const staffId = req.params.id;
    const currentId = req.session.staffId;

    // If no password provided, reset to default 'hopecare'
    const rawPassword = (new_password && String(new_password).trim().length >= 1)
      ? String(new_password).trim()
      : 'hopecare';

    if (rawPassword !== 'hopecare' && rawPassword.length < 6)
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters' });

    const [[existing]] = await pool.query(
      'SELECT id, username, full_name, role FROM staff_account WHERE id = ? LIMIT 1',
      [staffId]
    );
    if (!existing) return res.status(404).json({ success: false, message: 'Staff not found' });

    if (normalizeRole(existing.role) === ROLES.ADMINISTRATOR &&
        normalizeRole(req.session.role) !== ROLES.ADMINISTRATOR &&
        String(currentId) !== String(staffId)) {
      return res.status(403).json({ success: false, message: 'Cannot reset administrator passwords' });
    }

    const hashed = await bcrypt.hash(rawPassword, 10);
    await pool.query('UPDATE staff_account SET password = ? WHERE id = ?', [hashed, staffId]);

    const isDefault = rawPassword === 'hopecare';
    logActivity(req, {
      action: ACTIONS.RESET_PASSWORD,
      module: MODULES.STAFF,
      reference_id: staffId,
      description: `Reset password for staff: ${existing.full_name || existing.username} (${existing.username})${isDefault ? ' — reset to default' : ''}`,
    });

    res.json({
      success: true,
      message: isDefault
        ? 'Password reset to default (hopecare). Staff member must change it at next login.'
        : 'Password reset successfully.',
    });
  } catch (err) {
    console.error('Staff reset password error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/:id/status', requirePermission(PERMISSIONS.STAFF_MANAGEMENT), async (req, res) => {
  try {
    const { status } = req.body;
    const staffId = req.params.id;

    if (!['Active', 'Inactive'].includes(status))
      return res.status(400).json({ success: false, message: 'Invalid status' });

    const [[existing]] = await pool.query(
      'SELECT id, username, full_name, status as old_status FROM staff_account WHERE id = ? LIMIT 1',
      [staffId]
    );
    if (!existing) return res.status(404).json({ success: false, message: 'Staff not found' });

    await pool.query('UPDATE staff_account SET status = ? WHERE id = ?', [status, staffId]);

    const action = status === 'Active' ? ACTIONS.ACTIVATE : ACTIONS.DEACTIVATE;
    logActivity(req, {
      action,
      module: MODULES.STAFF,
      reference_id: staffId,
      description: `${status === 'Active' ? 'Activated' : 'Deactivated'} staff: ${existing.full_name || existing.username} (${existing.username})`,
    });

    res.json({
      success: true,
      message: `Staff account ${status === 'Active' ? 'activated' : 'deactivated'} successfully`,
    });
  } catch (err) {
    console.error('Staff status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/:id', requirePermission(PERMISSIONS.STAFF_MANAGEMENT), async (req, res) => {
  try {
    const staffId = req.params.id;
    const currentId = req.session.staffId;

    if (String(currentId) === String(staffId))
      return res.status(400).json({ success: false, message: 'You cannot delete your own account' });

    const [[existing]] = await pool.query(
      'SELECT id, username, full_name FROM staff_account WHERE id = ? LIMIT 1',
      [staffId]
    );
    if (!existing) return res.status(404).json({ success: false, message: 'Staff not found' });

    await pool.query('DELETE FROM staff_account WHERE id = ?', [staffId]);

    logActivity(req, {
      action: ACTIONS.DELETE,
      module: MODULES.STAFF,
      reference_id: staffId,
      description: `Deleted staff account: ${existing.full_name || existing.username} (${existing.username})`,
    });

    res.json({ success: true, message: 'Staff account deleted successfully' });
  } catch (err) {
    console.error('Staff delete error:', err);
    if (err.code && (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_NO_REFERENCED_ROW_2')) {
      return res.status(409).json({
        success: false,
        message: 'Cannot delete staff: this account is still referenced by activity logs or records.',
      });
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
