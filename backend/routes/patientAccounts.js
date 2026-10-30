const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/database').pool;
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logActivity, MODULES, ACTIONS } = require('../utils/activityLogger');
const { PERMISSIONS } = require('../utils/permissions');
const { generatePatientId } = require('../utils/idFormats');
const { issueTempPassword } = require('../utils/patientTempPassword');

router.use(requireAuth);

router.get('/', requirePermission(PERMISSIONS.PATIENT_ACCOUNTS), async (req, res) => {
  try {
    const { search, status } = req.query;

    // LEFT JOIN so patients without a portal account row still appear
    let query = `
      SELECT p.patient_id,
             p.full_name,
             p.contact_number,
             p.barangay,
             p.registration_number,
             p.password        AS patient_password,
             pa.account_id,
             pa.username,
             pa.account_status,
             pa.is_locked,
             pa.failed_attempts,
             pa.last_login,
             pa.first_login,
             pa.created_at     AS account_created_at,
             pa.updated_at
      FROM patients p
      LEFT JOIN patient_accounts pa ON pa.patient_id = p.patient_id
      WHERE 1=1`;
    const params = [];

    if (search) {
      query += ` AND (
        p.full_name          LIKE ? OR
        pa.username          LIKE ? OR
        p.registration_number LIKE ? OR
        p.contact_number     LIKE ? OR
        CONCAT('PAT-', LPAD(p.patient_id, 6, '0')) LIKE ?
      )`;
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }
    if (status) {
      if (status === 'no_account') {
        query += ' AND pa.account_id IS NULL';
      } else {
        query += ' AND pa.account_status = ?';
        params.push(status);
      }
    }

    query += ' ORDER BY p.patient_id DESC LIMIT 500';
    const [rows] = await pool.query(query, params);

    // Auto-provision missing patient_accounts rows so the page can manage them
    const missing = rows.filter(r => r.account_id === null);
    if (missing.length > 0) {
      const tempHash = await bcrypt.hash('hopecare', 10);
      for (const r of missing) {
        const username = `PAT-${String(r.patient_id).padStart(6, '0')}`;
        const hash = r.patient_password || tempHash;
        await pool.query(
          `INSERT INTO patient_accounts (patient_id, username, password_hash, first_login)
           VALUES (?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE username = VALUES(username)`,
          [r.patient_id, username, hash]
        ).catch(() => {});
        // Back-fill patients.password if blank
        if (!r.patient_password) {
          await pool.query(
            'UPDATE patients SET password = ?, is_temp_password = 1 WHERE patient_id = ?',
            [tempHash, r.patient_id]
          ).catch(() => {});
        }
        // Populate the row object so we don't need a second query
        r.account_id     = -1; // marker – will be replaced below
        r.username       = username;
        r.account_status = 'Active';
        r.is_locked      = 0;
        r.failed_attempts = 0;
        r.last_login     = null;
        r.first_login    = 1;
      }

      // Re-fetch only the newly created rows to get real account_ids
      if (missing.length <= 50) {
        const ids = missing.map(r => r.patient_id);
        const [fresh] = await pool.query(
          `SELECT patient_id, account_id, username, account_status, is_locked,
                  failed_attempts, last_login, first_login
           FROM patient_accounts WHERE patient_id IN (?)`,
          [ids]
        ).catch(() => [[]]);
        const freshMap = Object.fromEntries((fresh || []).map(f => [f.patient_id, f]));
        for (const r of rows) {
          if (freshMap[r.patient_id]) Object.assign(r, freshMap[r.patient_id]);
        }
      }
    }

    const data = rows.map(r => ({
      ...r,
      patient_password: undefined, // never send password hash to frontend
      patient_id_display: generatePatientId(r.patient_id),
    }));
    res.json({ success: true, data });
  } catch (err) {
    console.error('Patient accounts list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/:id/login-history', requirePermission(PERMISSIONS.PATIENT_ACCOUNTS), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM patient_login_history WHERE patient_id = ?
       ORDER BY login_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Login history error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/:id/reset-password', async (req, res, next) => {
  const role = req.session?.role;
  const { hasPermission } = require('../utils/permissions');
  const { normalizeRole } = require('../utils/permissions');
  if (!hasPermission(normalizeRole(role), PERMISSIONS.PATIENT_ACCOUNTS) &&
      !hasPermission(normalizeRole(role), PERMISSIONS.RESET_PATIENT_PASSWORD)) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }
  next();
}, async (req, res) => {
  try {
    const patientId = req.params.id;

    const [[patient]] = await pool.query(
      'SELECT full_name, registration_number FROM patients WHERE patient_id = ?',
      [patientId]
    );
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found' });

    await issueTempPassword(pool, patientId);

    logActivity(req, {
      action: ACTIONS.RESET_PASSWORD,
      module: MODULES.PATIENT_ACCOUNTS,
      reference_id: patientId,
      description: `Reset patient password and issued a new temporary password for ${patient.full_name} (${patient.registration_number}). Credentials are on the Patient Card.`,
    });

    res.json({
      success: true,
      message: 'Password reset. Print a new Patient Card for the temporary password. It is not sent by SMS. The patient must change it after login.',
      credentials_on_patient_card: true,
    });
  } catch (err) {
    console.error('Reset patient password error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/:id/unlock', requirePermission(PERMISSIONS.PATIENT_ACCOUNTS), async (req, res) => {
  try {
    await pool.query(
      `UPDATE patient_accounts SET is_locked = 0, failed_attempts = 0 WHERE patient_id = ?`,
      [req.params.id]
    );

    logActivity(req, {
      action: ACTIONS.UNLOCK,
      module: MODULES.PATIENT_ACCOUNTS,
      reference_id: req.params.id,
      description: `Unlocked patient account PAT-${String(req.params.id).padStart(6, '0')}`,
    });

    res.json({ success: true, message: 'Patient account unlocked successfully' });
  } catch (err) {
    console.error('Unlock patient error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/:id/status', requirePermission(PERMISSIONS.PATIENT_ACCOUNTS), async (req, res) => {
  try {
    const { account_status } = req.body;
    if (!['Active', 'Inactive'].includes(account_status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    await pool.query(
      `UPDATE patient_accounts SET account_status = ? WHERE patient_id = ?`,
      [account_status, req.params.id]
    );

    const action = account_status === 'Active' ? ACTIONS.ACTIVATE : ACTIONS.DEACTIVATE;
    logActivity(req, {
      action,
      module: MODULES.PATIENT_ACCOUNTS,
      reference_id: req.params.id,
      description: `${account_status === 'Active' ? 'Activated' : 'Deactivated'} patient account`,
    });

    res.json({
      success: true,
      message: `Patient account ${account_status === 'Active' ? 'activated' : 'deactivated'} successfully`,
    });
  } catch (err) {
    console.error('Patient account status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
