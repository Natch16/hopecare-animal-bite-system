const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/database').pool;
const { logActivity, MODULES, ACTIONS } = require('../utils/activityLogger');
const { requireAuth, getAuditBy, getPermissionsForRole, normalizeRole, getDefaultHomePage } = require('../middleware/auth');
const { generateStaffId } = require('../utils/idFormats');

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please enter both username and password.',
      });
    }

    const trimmedUsername = String(username).trim();

    const [rows] = await pool.query(
      'SELECT * FROM staff_account WHERE username = ? LIMIT 1',
      [trimmedUsername]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password.',
      });
    }

    const staff = rows[0];
    const isMatch = await bcrypt.compare(String(password), staff.password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password.',
      });
    }

    if (staff.status && staff.status !== 'Active') {
      return res.status(401).json({
        success: false,
        message: 'Account is inactive. Please contact your supervisor.',
        code: 'INACTIVE_ACCOUNT',
      });
    }

    req.session.staffId = staff.id;
    req.session.username = staff.username;
    req.session.fullName = staff.full_name || staff.username;
    req.session.designation = staff.designation || 'ABC Nurse';
    req.session.role = normalizeRole(staff.role || staff.designation);
    req.session.loginTime = new Date().toISOString();
    req.session.loggedIn = true;

    const permissions = getPermissionsForRole(req.session.role);

    logActivity(req, {
      action: ACTIONS.LOGIN,
      module: MODULES.AUTH,
      reference_id: staff.id,
      description: `${staff.full_name || staff.username} signed in.`,
    });

    res.json({
      success: true,
      message: 'Login successful',
      home_page: getDefaultHomePage(req.session.role),
      user: {
        staff_id: staff.id,
        staff_id_display: generateStaffId(staff.id, req.session.role),
        username: staff.username,
        full_name: staff.full_name || staff.username,
        designation: staff.designation || 'ABC Nurse',
        role: req.session.role,
        permissions,
        contact_number: staff.contact_number || null,
        login_time: req.session.loginTime,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    if (req.session.loggedIn) {
      await logActivity(req, {
        action: ACTIONS.LOGOUT,
        module: MODULES.AUTH,
        reference_id: req.session.staffId,
        description: `${req.session.fullName || req.session.username} signed out.`,
      });
    }
  } catch (e) {
    console.error('Logout activity log error:', e.message);
  }

  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Logout failed' });
    }
    res.json({ success: true, message: 'Logout successful' });
  });
});

router.get('/check', (req, res) => {
  if (req.session.loggedIn) {
    const role = normalizeRole(req.session.role);
    res.json({
      loggedIn: true,
      staff_id: req.session.staffId,
      staff_id_display: generateStaffId(req.session.staffId, role),
      username: req.session.username,
      full_name: req.session.fullName,
      designation: req.session.designation,
      role,
      permissions: getPermissionsForRole(role),
      home_page: getDefaultHomePage(role),
      login_time: req.session.loginTime || null,
    });
  } else {
    res.json({ loggedIn: false });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const [[staff]] = await pool.query(
      `SELECT id as staff_id, username, full_name, designation, role, position,
              email, contact_number, status, created_at, updated_at
       FROM staff_account WHERE id = ? LIMIT 1`,
      [req.session.staffId]
    );
    if (!staff) {
      return res.status(404).json({ success: false, message: 'Staff not found' });
    }
    staff.staff_id_display = generateStaffId(staff.staff_id, staff.role);
    staff.role = normalizeRole(staff.role);
    staff.permissions = getPermissionsForRole(staff.role);
    res.json({ success: true, data: staff });
  } catch (err) {
    console.error('Me GET error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
