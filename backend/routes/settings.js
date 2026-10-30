const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const pool     = require('../config/database').pool;
const { requireAuth, getAuditBy, requirePermission } = require('../middleware/auth');
const { logActivity, MODULES, ACTIONS } = require('../utils/activityLogger');
const { generateStaffId } = require('../utils/idFormats');
const { PERMISSIONS } = require('../utils/permissions');
const { VALID_VACCINE_CATEGORIES, fetchAvailableCatalog } = require('../utils/vaccineCatalog');
const { readPatientPortalUrl } = require('../utils/patientPortalUrl');

function vaccineFieldFlag(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  return (val === true || val === 1 || val === '1') ? 1 : 0;
}

router.use(requireAuth);

// Official patient portal address for the printed patient card.
// Returns only PATIENT_PORTAL_URL — no other environment values.
router.get('/patient-portal-url', (req, res) => {
  const result = readPatientPortalUrl();
  if (!result.ok) {
    return res.status(503).json({ success: false, message: result.message });
  }
  return res.json({
    success: true,
    data: { patient_portal_url: result.url },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STAFF PROFILE
// ─────────────────────────────────────────────────────────────────────────────

router.get('/profile', async (req, res) => {
  try {
    const staffId = req.session.staffId;
    if (!staffId) return res.status(401).json({ success: false, message: 'Not authenticated' });

    const [[staff]] = await pool.query(
      'SELECT id, username, full_name, position, designation, role, status, created_at FROM staff_account WHERE id = ?',
      [staffId]
    );
    if (!staff) return res.status(404).json({ success: false, message: 'Staff not found' });

    staff.staff_id_display = generateStaffId(staff.id);
    res.json({ success: true, data: staff });
  } catch (err) {
    console.error('Profile GET error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/profile', async (req, res) => {
  try {
    const staffId = req.session.staffId;
    if (!staffId) return res.status(401).json({ success: false, message: 'Not authenticated' });

    const { full_name, username, current_password, new_password } = req.body;

    // Req 2.9 – username is required and must not be whitespace-only
    if (!username || !username.trim()) {
      return res.status(400).json({ success: false, message: 'Username is required' });
    }

    const trimmedUsername = username.trim();

    // Req 2.4 – case-insensitive uniqueness check
    const [[existingUser]] = await pool.query(
      'SELECT id FROM staff_account WHERE LOWER(username) = LOWER(?) AND id != ?',
      [trimmedUsername, staffId]
    );
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Username already taken' });
    }

    const changingPassword = new_password && new_password.length > 0;

    if (changingPassword) {
      // Req 2.3 – current_password must be provided when changing password
      if (!current_password || !current_password.trim()) {
        return res.status(400).json({ success: false, message: 'Current password is required' });
      }

      // Req 2.10 – new password must be at least 6 characters
      if (new_password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
      }

      // Fetch stored hash and verify current password
      const [[staff]] = await pool.query('SELECT password FROM staff_account WHERE id = ?', [staffId]);
      const match = await bcrypt.compare(current_password, staff.password);
      if (!match) {
        return res.status(400).json({ success: false, message: 'Current password is incorrect' });
      }

      // Req 2.7 – hash new password and update including password column (no contact_number)
      const newHash = await bcrypt.hash(new_password, 10);
      await pool.query(
        'UPDATE staff_account SET full_name=?, username=?, password=? WHERE id=?',
        [full_name || null, trimmedUsername, newHash, staffId]
      );
    } else {
      // Req 2.6 – profile-only update, leave password column unchanged (no contact_number)
      await pool.query(
        'UPDATE staff_account SET full_name=?, username=? WHERE id=?',
        [full_name || null, trimmedUsername, staffId]
      );
    }

    // Req 2.5 – update session to reflect new values
    req.session.username = trimmedUsername;
    req.session.fullName = full_name || null;

    // Req 2.8 – log the activity
    logActivity(req, {
      action: ACTIONS.EDIT,
      module: MODULES.SETTINGS,
      reference_id: staffId,
      description: `Updated own profile: ${full_name || trimmedUsername || 'User #' + staffId}`,
    });

    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (err) {
    console.error('Profile PUT error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// VACCINE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

router.get('/vaccines', requirePermission(PERMISSIONS.SYSTEM_SETTINGS), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM vaccines
       WHERE UPPER(TRIM(name)) NOT IN ('ERIG','HRIG','PCEC','PVRV')
       ORDER BY FIELD(category, 'Anti-Rabies Vaccine','ERIG','HRIG','Tetanus Prophylaxis'), name ASC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Authenticated catalog for clinical forms (Add Patient Record + New Case).
// Returns Available vaccines grouped by classification. No system_settings perm required.
router.get('/vaccines/catalog', requireAuth, async (req, res) => {
  try {
    const catalog = await fetchAvailableCatalog(pool);
    res.json({ success: true, data: catalog });
  } catch (err) {
    console.error('Vaccine catalog error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Public endpoint — returns Available Tetanus Prophylaxis vaccines for patient forms.
// Accessible to any authenticated staff (Nurse or Admin) without system_settings perm.
router.get('/vaccines/tetanus', requireAuth, async (req, res) => {
  try {
    const catalog = await fetchAvailableCatalog(pool);
    res.json({ success: true, data: catalog.tetanus });
  } catch (err) {
    console.error('Tetanus vaccines list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/vaccines', requirePermission(PERMISSIONS.SYSTEM_SETTINGS), async (req, res) => {
  try {
    const {
      name, type, category, status,
      has_route = 0, has_anst = 0,
      has_dose, has_injection_site, has_date_given, has_given_by,
      concentration = null, default_dose_ml = null, default_injection_site = null,
    } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Vaccine name is required' });
    if (!type || !type.trim()) return res.status(400).json({ success: false, message: 'Vaccine type is required' });
    if (!category || !category.trim()) return res.status(400).json({ success: false, message: 'Category is required' });
    if (!VALID_VACCINE_CATEGORIES.includes(category.trim())) {
      return res.status(400).json({
        success: false,
        message: `Invalid category. Must be one of: ${VALID_VACCINE_CATEGORIES.join(', ')}`
      });
    }

    const trimmedName     = name.trim();
    const trimmedType     = type.trim();
    const trimmedCategory = category.trim();
    const createdBy = getAuditBy(req);

    const [[existing]] = await pool.query(
      'SELECT vaccine_id FROM vaccines WHERE LOWER(name) = LOWER(?)',
      [trimmedName]
    );
    if (existing) {
      return res.status(409).json({ success: false, message: `A vaccine named "${trimmedName}" already exists` });
    }

    const isTetanus = trimmedCategory === 'Tetanus Prophylaxis';
    const doseFlag = vaccineFieldFlag(has_dose, isTetanus ? 1 : 0);
    const siteFlag = vaccineFieldFlag(has_injection_site, isTetanus ? 1 : 0);
    const dateFlag = vaccineFieldFlag(has_date_given, isTetanus ? 1 : 0);
    const givenByFlag = vaccineFieldFlag(has_given_by, isTetanus ? 1 : 0);

    const [result] = await pool.query(
      `INSERT INTO vaccines
         (name, type, category, status, has_route, has_anst,
          has_dose, has_injection_site, has_date_given, has_given_by,
          concentration, default_dose_ml, default_injection_site, created_by, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        trimmedName, trimmedType, trimmedCategory, status || 'Available',
        has_route ? 1 : 0, has_anst ? 1 : 0,
        doseFlag, siteFlag, dateFlag, givenByFlag,
        concentration || null,
        default_dose_ml !== undefined && default_dose_ml !== '' ? default_dose_ml : null,
        default_injection_site || null,
        createdBy, createdBy,
      ]
    );

    logActivity(req, {
      action: ACTIONS.ADD,
      module: MODULES.VACCINES,
      reference_id: result.insertId,
      description: `Added vaccine: ${trimmedName} (${trimmedType} / ${trimmedCategory})`,
    });

    res.status(201).json({ success: true, message: 'Vaccine added', vaccine_id: result.insertId });
  } catch (err) {
    console.error('Vaccine POST error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/vaccines/:id', requirePermission(PERMISSIONS.SYSTEM_SETTINGS), async (req, res) => {
  try {
    const [[row]] = await pool.query(
      'SELECT * FROM vaccines WHERE vaccine_id = ?', [req.params.id]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Vaccine not found' });
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('Vaccine GET/:id error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/vaccines/:id', requirePermission(PERMISSIONS.SYSTEM_SETTINGS), async (req, res) => {
  try {
    const {
      name, type, category, status,
      has_route = 0, has_anst = 0,
      has_dose, has_injection_site, has_date_given, has_given_by,
      concentration = null, default_dose_ml = null, default_injection_site = null,
    } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Vaccine name is required' });
    if (!type || !type.trim()) return res.status(400).json({ success: false, message: 'Vaccine type is required' });
    if (!category || !category.trim()) return res.status(400).json({ success: false, message: 'Category is required' });
    if (!VALID_VACCINE_CATEGORIES.includes(category.trim())) {
      return res.status(400).json({
        success: false,
        message: `Invalid category. Must be one of: ${VALID_VACCINE_CATEGORIES.join(', ')}`
      });
    }

    const trimmedName     = name.trim();
    const trimmedType     = type.trim();
    const trimmedCategory = category.trim();
    const updatedBy = getAuditBy(req);

    const [[current]] = await pool.query(
      'SELECT * FROM vaccines WHERE vaccine_id = ?',
      [req.params.id]
    );
    if (!current) {
      return res.status(404).json({ success: false, message: 'Vaccine not found' });
    }

    const [[existing]] = await pool.query(
      'SELECT vaccine_id FROM vaccines WHERE LOWER(name) = LOWER(?) AND vaccine_id != ?',
      [trimmedName, req.params.id]
    );
    if (existing) {
      return res.status(409).json({ success: false, message: `A vaccine named "${trimmedName}" already exists` });
    }

    const isTetanus = trimmedCategory === 'Tetanus Prophylaxis';
    const doseFlag = vaccineFieldFlag(has_dose, current.has_dose != null ? current.has_dose : (isTetanus ? 1 : 0));
    const siteFlag = vaccineFieldFlag(has_injection_site, current.has_injection_site != null ? current.has_injection_site : (isTetanus ? 1 : 0));
    const dateFlag = vaccineFieldFlag(has_date_given, current.has_date_given != null ? current.has_date_given : (isTetanus ? 1 : 0));
    const givenByFlag = vaccineFieldFlag(has_given_by, current.has_given_by != null ? current.has_given_by : (isTetanus ? 1 : 0));

    const [result] = await pool.query(
      `UPDATE vaccines
       SET name=?, type=?, category=?, status=?,
           has_route=?, has_anst=?,
           has_dose=?, has_injection_site=?, has_date_given=?, has_given_by=?,
           concentration=?,
           default_dose_ml=?, default_injection_site=?,
           updated_by=?
       WHERE vaccine_id=?`,
      [
        trimmedName, trimmedType, trimmedCategory, status,
        has_route ? 1 : 0, has_anst ? 1 : 0,
        doseFlag, siteFlag, dateFlag, givenByFlag,
        concentration || null,
        default_dose_ml !== undefined && default_dose_ml !== '' ? default_dose_ml : null,
        default_injection_site || null,
        updatedBy, req.params.id,
      ]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Vaccine not found' });
    }

    logActivity(req, {
      action: ACTIONS.EDIT,
      module: MODULES.VACCINES,
      reference_id: req.params.id,
      description: `Updated vaccine: ${trimmedName} (${trimmedType} / ${trimmedCategory}) [Status: ${status}]`,
    });

    res.json({ success: true, message: 'Vaccine updated' });
  } catch (err) {
    console.error('Vaccine PUT error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/vaccines/:id', requirePermission(PERMISSIONS.SYSTEM_SETTINGS), async (req, res) => {
  try {
    const staffId = req.session.staffId;
    if (!staffId) return res.status(401).json({ success: false, message: 'Not authenticated' });

    const [[existing]] = await pool.query(
      'SELECT vaccine_id, name FROM vaccines WHERE vaccine_id = ? LIMIT 1',
      [req.params.id]
    );
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Vaccine not found' });
    }

    const [result] = await pool.query('DELETE FROM vaccines WHERE vaccine_id = ?', [req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Vaccine not found' });
    }

    logActivity(req, {
      action: ACTIONS.DELETE,
      module: MODULES.VACCINES,
      reference_id: req.params.id,
      description: `Deleted vaccine: ${existing.name}`,
    });

    res.json({ success: true, message: 'Vaccine deleted successfully' });
  } catch (err) {
    console.error('Vaccine DELETE error:', err);
    if (err.code && (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_NO_REFERENCED_ROW_2')) {
      return res.status(409).json({
        success: false,
        message: 'Cannot delete vaccine: it is still referenced by patient records.'
      });
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REPORT SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/report', async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM report_settings WHERE id=1');
    res.json({ success: true, data: row || {} });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/report', async (req, res) => {
  try {
    const { center_name, city, prepared_by, noted_by, prepared_by_designation, noted_by_designation } = req.body;
    const updatedBy = getAuditBy(req);

    await pool.query(
      `INSERT INTO report_settings
         (id, center_name, city, prepared_by, noted_by, prepared_by_designation, noted_by_designation, updated_by)
       VALUES (1,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         center_name=VALUES(center_name), city=VALUES(city),
         prepared_by=VALUES(prepared_by),
         noted_by=VALUES(noted_by),
         prepared_by_designation=VALUES(prepared_by_designation),
         noted_by_designation=VALUES(noted_by_designation),
         updated_by=VALUES(updated_by)`,
      [center_name, city, prepared_by, noted_by, prepared_by_designation, noted_by_designation, updatedBy]
    );

    logActivity(req, {
      action: ACTIONS.UPDATE,
      module: MODULES.REPORTS,
      reference_id: 'settings',
      description: 'Updated report settings (center, signatures, designations)',
    });

    res.json({ success: true, message: 'Report settings saved' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/report/signature', async (req, res) => {
  try {
    const { role, name, signature } = req.body;
    if (!role || !['prepared', 'noted'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Invalid signature role' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required before saving a signature' });
    }
    if (!signature || typeof signature !== 'string' || !signature.startsWith('data:image/')) {
      return res.status(400).json({ success: false, message: 'A valid drawn signature is required' });
    }
    if (signature.length > 500000) {
      return res.status(400).json({ success: false, message: 'Signature image is too large' });
    }

    const trimmedName = name.trim();
    const updatedBy = getAuditBy(req);

    if (role === 'prepared') {
      await pool.query(
        `INSERT INTO report_settings (id, prepared_by, prepared_by_signature, updated_by)
         VALUES (1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           prepared_by=VALUES(prepared_by),
           prepared_by_signature=VALUES(prepared_by_signature),
           updated_by=VALUES(updated_by)`,
        [trimmedName, signature, updatedBy]
      );
    } else {
      await pool.query(
        `INSERT INTO report_settings (id, noted_by, noted_by_signature, updated_by)
         VALUES (1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           noted_by=VALUES(noted_by),
           noted_by_signature=VALUES(noted_by_signature),
           updated_by=VALUES(updated_by)`,
        [trimmedName, signature, updatedBy]
      );
    }

    logActivity(req, {
      action: ACTIONS.UPDATE,
      module: MODULES.REPORTS,
      reference_id: 'signature-' + role,
      description: `Updated ${role === 'prepared' ? 'Prepared By' : 'Noted By'} signature for: ${trimmedName}`,
    });

    res.json({ success: true, message: 'Signature saved' });
  } catch (err) {
    console.error('Signature PUT error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
