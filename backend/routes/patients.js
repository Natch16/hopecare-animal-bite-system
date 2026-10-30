const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/database').pool;
const { requireAuth, getAuditBy } = require('../middleware/auth');
const { logActivity, MODULES, ACTIONS } = require('../utils/activityLogger');
const {
  ORDER_BY_REGISTRATION,
  getNextRegistrationNumber,
  allocateRegistrationNumber,
} = require('../utils/registrationNumber');
const { generatePatientId } = require('../utils/idFormats');
const { lockPatientIdAllocation, unlockPatientIdAllocation, nextPatientId } = require('../utils/patientId');
const { CLINIC_TEMP_PASSWORD, encryptSecret, omitCredentialFields } = require('../utils/patientTempPassword');
const { loadPatientCardLogin } = require('../utils/patientCardLogin');
const {
  syncPrimaryRecord,
  assertCurrentCaseDoseEntry,
  computeOutcome,
  attachCurrentCaseFromDb,
  overlayPatientListFromDb,
  toSqlDate,
} = require('../utils/patientRecordSync');
const { actorFromReq, WorkflowError } = require('../utils/missedDose');
const { isValidAntiRabiesBrand, invalidBrandMessage, insertDynamicTetanus, insertDynamicRig } = require('../utils/vaccineCatalog');
const { validatePatientIdentity } = require('../utils/patientFieldValidation');

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM patients ${ORDER_BY_REGISTRATION}`);
    const overlayed = await overlayPatientListFromDb(pool, rows);
    const data = overlayed.map(r => omitCredentialFields({ ...r, patient_id_display: generatePatientId(r.patient_id) }));
    res.json({ success: true, data });
  } catch (error) {
    console.error('Get patients error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/next/registration-number', async (req, res) => {
  try {
    const registration_number = await getNextRegistrationNumber(pool);
    res.json({ success: true, data: { registration_number } });
  } catch (error) {
    console.error('Next registration number error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/search/query', async (req, res) => {
  try {
    const { q, name, barangay, date } = req.query;
    const searchTerm = q || name;

    // Build WHERE conditions for the base patients filter
    const conditions = ['1=1'];
    const params = [];

    if (searchTerm) {
      if (searchTerm.toUpperCase().startsWith('PAT-')) {
        const num = parseInt(searchTerm.replace(/^PAT-/i, ''), 10);
        if (!isNaN(num)) {
          conditions.push('p.patient_id = ?');
          params.push(num);
        }
      } else if (searchTerm.toUpperCase().startsWith('ABC-')) {
        conditions.push('p.registration_number LIKE ?');
        params.push(`${searchTerm}%`);
      } else if (/^\d{7,}$/.test(searchTerm)) {
        // 7+ digit string → contact number exact match OR name
        conditions.push('(p.contact_number = ? OR p.full_name LIKE ?)');
        params.push(searchTerm, `%${searchTerm}%`);
      } else {
        conditions.push('p.full_name LIKE ?');
        params.push(`%${searchTerm}%`);
      }
    }
    if (barangay) {
      conditions.push('p.barangay = ?');
      params.push(barangay);
    }
    
    // Date search: check date_of_exposure and vaccination dates
    if (date) {
      conditions.push(`(
        p.date_of_exposure = ? OR
        p.vaccine_d0 = ? OR
        p.vaccine_d3 = ? OR
        p.vaccine_d7 = ? OR
        p.vaccine_d14 = ? OR
        p.vaccine_d28 = ?
      )`);
      params.push(date, date, date, date, date, date);
    }

    const where = conditions.join(' AND ');

    const enrichedQuery = `
      SELECT
        p.patient_id,
        p.registration_number,
        p.full_name,
        p.age,
        p.sex,
        p.address,
        p.barangay,
        p.contact_number,
        p.date_registered,
        p.date_of_exposure,
        p.place_of_exposure,
        p.type_of_animal,
        p.type_of_exposure,
        p.site_of_exposure,
        p.category,
        p.washing_of_bite,
        p.rig_date_given,
        p.route,
        p.vaccine_d0,
        p.vaccine_d3,
        p.vaccine_d7,
        p.vaccine_d14,
        p.vaccine_d28,
        p.brand_name,
        p.outcome,
        p.biting_animal_status,
        p.remarks,
        COUNT(DISTINCT pe.exposure_id) AS total_cases,
        (SELECT pe2.category
         FROM patient_exposures pe2
         WHERE pe2.patient_id = p.patient_id
         ORDER BY pe2.exposure_number DESC, pe2.exposure_id DESC
         LIMIT 1)                                          AS latest_category,
        (SELECT te.status
         FROM treatment_episodes te
         WHERE te.patient_id = p.patient_id
         ORDER BY te.episode_number DESC, te.episode_id DESC
         LIMIT 1)                                          AS latest_pep_status
      FROM patients p
      LEFT JOIN patient_exposures pe ON pe.patient_id = p.patient_id
      WHERE ${where}
      GROUP BY p.patient_id
      ORDER BY p.registration_number ASC
      LIMIT 50
    `;

    const [rows] = await pool.query(enrichedQuery, params);
    const overlayed = await overlayPatientListFromDb(pool, rows);
    const data = overlayed.map(r => omitCredentialFields({
      ...r,
      patient_id_display: generatePatientId(r.patient_id),
      total_cases: Number(r.total_cases) || 0,
    }));
    res.json({ success: true, data });
  } catch (error) {
    console.error('Search patients error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/:id/portal-card', async (req, res) => {
  try {
    const result = await loadPatientCardLogin(pool, req.params.id);
    if (!result.ok) {
      return res.status(result.status).json({ success: false, message: result.message });
    }
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error('[patients] portal-card:', err.message);
    res.status(500).json({ success: false, message: 'Could not load the patient card login guide.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM patients WHERE patient_id = ?', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }
    const row = await attachCurrentCaseFromDb(pool, { ...rows[0] });
    row.patient_id_display = generatePatientId(row.patient_id);
    res.json({ success: true, data: omitCredentialFields(row) });
  } catch (error) {
    console.error('Get patient error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/', async (req, res) => {
  let conn;
  try {
    const identity = validatePatientIdentity(req.body);
    if (!identity.ok) {
      return res.status(400).json({ success: false, field: identity.field, message: identity.message });
    }
    const registeredIso = toSqlDate(req.body.date_registered);
    const regYear = registeredIso
      ? Number(registeredIso.slice(0, 4))
      : new Date().getFullYear();
    const allocated = await allocateRegistrationNumber(pool, regYear);
    conn = allocated.conn;
    const registration_number = allocated.registration_number;
    const createdBy = getAuditBy(req);
    const {
      full_name, age, sex, address, barangay, contact_number, date_registered,
      date_of_exposure, place_of_exposure, type_of_animal, type_of_exposure, site_of_exposure,
      category, washing_of_bite, rig_date_given, route, vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28, brand_name,
      vaccinator_d0, vaccinator_d3, vaccinator_d7, vaccinator_d14, vaccinator_d28,
      outcome, biting_animal_status, remarks,
      tt_given, tt_dose_ml, tt_injection_site, tt_date_given, tt_given_by, tt_route, tt_anst_result,
      ats_given, ats_dose_ml, ats_injection_site, ats_date_given, ats_given_by, ats_route, ats_anst_result,
      htig_given, htig_dose_ml, htig_injection_site, htig_date_given, htig_given_by, htig_route, htig_anst_result,
      rig_equine_given, rig_equirab, rig_vinrab, rig_equine_up_to_ml, rig_equine_anst, rig_equine_date, rig_equine_given_by,
      rig_human_given, rig_berirab, rig_human_up_to_ml, rig_human_date, rig_human_given_by,
      meds_given, meds_description,
    } = req.body;

    if (!(await isValidAntiRabiesBrand(pool, brand_name))) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: invalidBrandMessage() });
    }

    // Validate reference-image fields
    const VALID_ANIMAL_TYPES = ['D', 'SD', 'C', 'O'];
    if (type_of_animal && !VALID_ANIMAL_TYPES.includes(type_of_animal)) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Invalid animal type. Use: D (Pet Dog), SD (Stray Dog), C (Cat), O (Others).' });
    }
    const VALID_EXPOSURE_TYPES = ['B', 'NB'];
    if (type_of_exposure && !VALID_EXPOSURE_TYPES.includes(type_of_exposure)) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Invalid exposure type. Use: B (Bite) or NB (Non-Bite).' });
    }
    const VALID_CATEGORIES = ['1', '2', '3', 1, 2, 3];
    if (category && !VALID_CATEGORIES.includes(category)) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Invalid category. Must be 1, 2, or 3.' });
    }
    if (washing_of_bite && !['Y', 'N'].includes(washing_of_bite)) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Invalid washing of bite value. Use Y or N.' });
    }
    if (route && !['ID', 'IM'].includes(route)) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Invalid route. Use ID or IM.' });
    }
    if (!category) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Category is required.' });
    }

    const autoOutcome = computeOutcome(category, {
      vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28,
    });

    await lockPatientIdAllocation(conn);
    const patientId = await nextPatientId(conn);
    const patientIdDisplay = generatePatientId(patientId);

    const [result] = await conn.query(
      `INSERT INTO patients (
        patient_id, registration_number, full_name, age, sex, address, barangay, contact_number, date_registered,
        date_of_exposure, place_of_exposure, type_of_animal, type_of_exposure, site_of_exposure,
        category, washing_of_bite, rig_date_given, route, vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28, brand_name,
        outcome, biting_animal_status, remarks,
        tt_given, tt_dose_ml, tt_injection_site, tt_date_given, tt_given_by,
        ats_given, ats_dose_ml, ats_injection_site, ats_date_given, ats_given_by, ats_anst_result,
        htig_given, htig_dose_ml, htig_injection_site, htig_date_given, htig_given_by, htig_route,
        rig_equine_given, rig_equirab, rig_vinrab, rig_equine_up_to_ml, rig_equine_anst, rig_equine_date, rig_equine_given_by,
        rig_human_given, rig_berirab, rig_human_up_to_ml, rig_human_date, rig_human_given_by,
        meds_given, meds_description,
        created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        patientId, registration_number, full_name, identity.age, sex, address, barangay, identity.contact_number, toSqlDate(date_registered),
        toSqlDate(date_of_exposure), place_of_exposure, type_of_animal, type_of_exposure, site_of_exposure,
        category, washing_of_bite, toSqlDate(rig_date_given), route, toSqlDate(vaccine_d0), toSqlDate(vaccine_d3), toSqlDate(vaccine_d7), toSqlDate(vaccine_d14), toSqlDate(vaccine_d28), brand_name,
        autoOutcome, biting_animal_status, remarks,
        tt_given || 0, tt_dose_ml || null, tt_injection_site || null, toSqlDate(tt_date_given), tt_given_by || null,
        ats_given || 0, ats_dose_ml || null, ats_injection_site || null, toSqlDate(ats_date_given), ats_given_by || null, ats_anst_result || null,
        htig_given || 0, htig_dose_ml || null, htig_injection_site || null, toSqlDate(htig_date_given), htig_given_by || null, htig_route || null,
        rig_equine_given || 0, rig_equirab || 0, rig_vinrab || 0, rig_equine_up_to_ml || null, rig_equine_anst || null, toSqlDate(rig_equine_date), rig_equine_given_by || null,
        rig_human_given || 0, rig_berirab || 0, rig_human_up_to_ml || null, toSqlDate(rig_human_date), rig_human_given_by || null,
        meds_given || 0, meds_description || null,
        createdBy,
      ]
    );

    // Portal account stores a bcrypt hash of the lowercase clinic temporary password.
    const tempPlain = CLINIC_TEMP_PASSWORD;
    const tempHash = await bcrypt.hash(tempPlain, 10);
    const tempCipher = encryptSecret(tempPlain);
    await conn.query(
      'UPDATE patients SET password = ?, is_temp_password = 1, temp_password_cipher = ? WHERE patient_id = ?',
      [tempHash, tempCipher, patientId]
    );
    await conn.query(
      `INSERT INTO patient_accounts (patient_id, username, password_hash, first_login, account_status)
       VALUES (?, ?, ?, 1, 'Active')
       ON DUPLICATE KEY UPDATE username = VALUES(username), password_hash = VALUES(password_hash), first_login = 1`,
      [patientId, patientIdDisplay, tempHash]
    );

    await conn.commit();

    // Mirror Patient Records into exposure #1 + PEP treatment #1 (non-fatal)
    try {
      const { episodeId } = await syncPrimaryRecord(pool, patientId, {
        date_of_exposure, place_of_exposure, barangay,
        type_of_animal, type_of_exposure, site_of_exposure,
        category, washing_of_bite, biting_animal_status, remarks,
        vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28,
        vaccinator_d0: vaccinator_d0 || null,
        vaccinator_d3: vaccinator_d3 || null,
        vaccinator_d7: vaccinator_d7 || null,
        vaccinator_d14: vaccinator_d14 || null,
        vaccinator_d28: vaccinator_d28 || null,
        brand_name, route, rig_date_given, outcome, date_registered,
      }, createdBy);

      const patientIdForSync = patientId;
      if (tt_given) {
        await pool.query(
          `INSERT INTO tetanus_records (episode_id, patient_id, type, given, dose_ml, injection_site, route, anst_result, date_given, given_by)
           VALUES (?,?, 'TT', ?,?,?, ?,?,?,?)
           ON DUPLICATE KEY UPDATE given=VALUES(given), dose_ml=VALUES(dose_ml), injection_site=VALUES(injection_site), route=VALUES(route), anst_result=VALUES(anst_result), date_given=VALUES(date_given), given_by=VALUES(given_by)`,
          [episodeId, patientIdForSync, 1, tt_dose_ml || null, tt_injection_site || null, tt_route || 'IM', tt_anst_result || null, tt_date_given || null, tt_given_by || null]
        ).catch(() => {});
      }
      if (ats_given) {
        await pool.query(
          `INSERT INTO tetanus_records (episode_id, patient_id, type, given, dose_ml, injection_site, route, anst_result, date_given, given_by)
           VALUES (?,?, 'ATS', ?,?,?, ?,?,?,?)
           ON DUPLICATE KEY UPDATE given=VALUES(given), dose_ml=VALUES(dose_ml), injection_site=VALUES(injection_site), route=VALUES(route), anst_result=VALUES(anst_result), date_given=VALUES(date_given), given_by=VALUES(given_by)`,
          [episodeId, patientIdForSync, 1, ats_dose_ml || null, ats_injection_site || null, ats_route || 'IM', ats_anst_result || null, ats_date_given || null, ats_given_by || null]
        ).catch(() => {});
      }
      if (htig_given) {
        await pool.query(
          `INSERT INTO tetanus_records (episode_id, patient_id, type, given, dose_ml, injection_site, route, anst_result, date_given, given_by)
           VALUES (?,?, 'HTIG', ?,?,?, ?,?,?,?)
           ON DUPLICATE KEY UPDATE given=VALUES(given), dose_ml=VALUES(dose_ml), injection_site=VALUES(injection_site), route=VALUES(route), anst_result=VALUES(anst_result), date_given=VALUES(date_given), given_by=VALUES(given_by)`,
          [episodeId, patientIdForSync, 1, htig_dose_ml || null, htig_injection_site || null, htig_route || null, htig_anst_result || null, htig_date_given || null, htig_given_by || null]
        ).catch(() => {});
      }
      if (rig_equine_given || rig_equirab || rig_vinrab) {
        const rigBrand = rig_equirab ? 'Equirab' : (rig_vinrab ? 'Vinrab' : null);
        await pool.query(
          `INSERT INTO rig_records (episode_id, patient_id, rig_given, rig_type, rig_brand, concentration, volume_ml, anst_result, injection_site, date_given, given_by)
           VALUES (?,?,1,'Equine',?, '200 IU/mL',?,?, 'Wound site',?,?)
           ON DUPLICATE KEY UPDATE rig_given=1, rig_brand=VALUES(rig_brand), volume_ml=VALUES(volume_ml), anst_result=VALUES(anst_result), date_given=VALUES(date_given), given_by=VALUES(given_by)`,
          [episodeId, patientIdForSync, rigBrand, rig_equine_up_to_ml || null, rig_equine_anst || null, rig_equine_date || null, rig_equine_given_by || null]
        ).catch(() => {});
      }
      if (rig_human_given || rig_berirab) {
        await pool.query(
          `INSERT INTO rig_records (episode_id, patient_id, rig_given, rig_type, rig_brand, concentration, volume_ml, injection_site, date_given, given_by)
           VALUES (?,?,1,'Human','Berirab','300 IU/mL',?, 'Wound site',?,?)
           ON DUPLICATE KEY UPDATE rig_given=1, volume_ml=VALUES(volume_ml), date_given=VALUES(date_given), given_by=VALUES(given_by)`,
          [episodeId, patientIdForSync, rig_human_up_to_ml || null, rig_human_date || null, rig_human_given_by || null]
        ).catch(() => {});
      }
      if (meds_given && meds_description) {
        await pool.query(
          `INSERT INTO medication_records (episode_id, patient_id, medication_name, dosage, remarks)
           VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE dosage=VALUES(dosage), remarks=VALUES(remarks)`,
          [episodeId, patientIdForSync, 'Prescribed Medications', null, meds_description]
        ).catch(() => {});
      }
      await insertDynamicTetanus(pool, episodeId, patientIdForSync, req.body.dynamic_tetanus);
      await insertDynamicRig(pool, episodeId, patientIdForSync, req.body.dynamic_rig);
    } catch (epErr) {
      console.warn('[patients.js POST] Episode creation warning (non-fatal):', epErr.message);
    }

    logActivity(req, {
      action: ACTIONS.ADD,
      module: MODULES.PATIENTS,
      reference_id: patientId,
      description: `Added patient: ${full_name} (Reg. No. ${registration_number})`,
    });

    res.json({
      success: true,
      message: 'Patient added successfully. Login credentials are printed on the Patient Card and are not sent by SMS.',
      patientId,
      patient_id_display: patientIdDisplay,
      registration_number,
      credentials_on_patient_card: true,
    });
  } catch (error) {
    if (conn) {
      try { await conn.rollback(); } catch (_) { /* ignore */ }
    }
    console.error('Add patient error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      const duplicateId = /PRIMARY|patient_id/i.test(String(error.message || ''));
      return res.status(duplicateId ? 409 : 400).json({
        success: false,
        message: duplicateId
          ? 'Could not assign a unique Patient ID. Please try again.'
          : 'Registration number already exists',
      });
    }
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (conn) {
      await unlockPatientIdAllocation(conn);
      conn.release();
    }
  }
});

router.put('/:id', async (req, res) => {
  try {
    const [existing] = await pool.query(
      'SELECT registration_number, full_name, brand_name FROM patients WHERE patient_id = ?',
      [req.params.id]
    );
    if (!existing.length) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    const registration_number = existing[0].registration_number;
    const updatedBy = getAuditBy(req);

    const {
      full_name, age, sex, address, barangay, contact_number, date_registered,
      date_of_exposure, place_of_exposure,
      type_of_animal, type_of_exposure, site_of_exposure,
      category, washing_of_bite, rig_date_given, route, vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28, brand_name,
      vaccinator_d0, vaccinator_d3, vaccinator_d7, vaccinator_d14, vaccinator_d28,
      outcome, biting_animal_status, remarks,
      tt_given, tt_dose_ml, tt_injection_site, tt_date_given, tt_given_by, tt_route, tt_anst_result,
      ats_given, ats_dose_ml, ats_injection_site, ats_date_given, ats_given_by, ats_route, ats_anst_result,
      htig_given, htig_dose_ml, htig_injection_site, htig_date_given, htig_given_by, htig_route, htig_anst_result,
      rig_equine_given, rig_equirab, rig_vinrab, rig_equine_up_to_ml, rig_equine_anst, rig_equine_date, rig_equine_given_by,
      rig_human_given, rig_berirab, rig_human_up_to_ml, rig_human_date, rig_human_given_by,
      meds_given, meds_description,
    } = req.body;

    if (!(await isValidAntiRabiesBrand(pool, brand_name, { allowCurrent: existing[0].brand_name }))) {
      return res.status(400).json({ success: false, message: invalidBrandMessage() });
    }

    // Validate reference-image fields
    const VALID_ANIMAL_TYPES_PUT = ['D', 'SD', 'C', 'O'];
    if (type_of_animal && !VALID_ANIMAL_TYPES_PUT.includes(type_of_animal)) {
      return res.status(400).json({ success: false, message: 'Invalid animal type. Use: D (Pet Dog), SD (Stray Dog), C (Cat), O (Others).' });
    }
    if (type_of_exposure && !['B', 'NB'].includes(type_of_exposure)) {
      return res.status(400).json({ success: false, message: 'Invalid exposure type. Use: B (Bite) or NB (Non-Bite).' });
    }
    if (category && !['1','2','3',1,2,3].includes(category)) {
      return res.status(400).json({ success: false, message: 'Invalid category. Must be 1, 2, or 3.' });
    }
    if (washing_of_bite && !['Y','N'].includes(washing_of_bite)) {
      return res.status(400).json({ success: false, message: 'Invalid washing of bite value. Use Y or N.' });
    }
    if (route && !['ID','IM'].includes(route)) {
      return res.status(400).json({ success: false, message: 'Invalid route. Use ID or IM.' });
    }
    if (!category) {
      return res.status(400).json({ success: false, message: 'Category is required.' });
    }

    const identity = validatePatientIdentity(req.body);
    if (!identity.ok) {
      return res.status(400).json({ success: false, field: identity.field, message: identity.message });
    }

    const autoOutcome = computeOutcome(category, {
      vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28,
    });

    const patientId = req.params.id;
    const actor = actorFromReq(req);
    try {
      await assertCurrentCaseDoseEntry(pool, patientId, {
        vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28,
      }, actor);
    } catch (guardErr) {
      if (guardErr instanceof WorkflowError) {
        return res.status(guardErr.status).json({ success: false, code: guardErr.code, message: guardErr.message });
      }
      throw guardErr;
    }

    await pool.query(
      `UPDATE patients SET 
        registration_number=?, full_name=?, age=?, sex=?, address=?, barangay=?, contact_number=?, date_registered=?,
        date_of_exposure=?, place_of_exposure=?,
        type_of_animal=?, type_of_exposure=?, site_of_exposure=?,
        category=?, washing_of_bite=?, rig_date_given=?, route=?, vaccine_d0=?, vaccine_d3=?, vaccine_d7=?, vaccine_d14=?, vaccine_d28=?, brand_name=?,
        outcome=?, biting_animal_status=?, remarks=?,
        tt_given=?, tt_dose_ml=?, tt_injection_site=?, tt_date_given=?, tt_given_by=?,
        ats_given=?, ats_dose_ml=?, ats_injection_site=?, ats_date_given=?, ats_given_by=?, ats_anst_result=?,
        htig_given=?, htig_dose_ml=?, htig_injection_site=?, htig_date_given=?, htig_given_by=?, htig_route=?,
        rig_equine_given=?, rig_equirab=?, rig_vinrab=?, rig_equine_up_to_ml=?, rig_equine_anst=?, rig_equine_date=?, rig_equine_given_by=?,
        rig_human_given=?, rig_berirab=?, rig_human_up_to_ml=?, rig_human_date=?, rig_human_given_by=?,
        meds_given=?, meds_description=?,
        updated_by=?
      WHERE patient_id=?`,
      [
        registration_number, full_name, identity.age, sex, address, barangay, identity.contact_number, toSqlDate(date_registered),
        toSqlDate(date_of_exposure), place_of_exposure,
        type_of_animal, type_of_exposure, site_of_exposure,
        category, washing_of_bite, toSqlDate(rig_date_given), route, toSqlDate(vaccine_d0), toSqlDate(vaccine_d3), toSqlDate(vaccine_d7), toSqlDate(vaccine_d14), toSqlDate(vaccine_d28), brand_name,
        autoOutcome, biting_animal_status, remarks,
        tt_given || 0, tt_dose_ml || null, tt_injection_site || null, toSqlDate(tt_date_given), tt_given_by || null,
        ats_given || 0, ats_dose_ml || null, ats_injection_site || null, toSqlDate(ats_date_given), ats_given_by || null, ats_anst_result || null,
        htig_given || 0, htig_dose_ml || null, htig_injection_site || null, toSqlDate(htig_date_given), htig_given_by || null, htig_route || null,
        rig_equine_given || 0, rig_equirab || 0, rig_vinrab || 0, rig_equine_up_to_ml || null, rig_equine_anst || null, toSqlDate(rig_equine_date), rig_equine_given_by || null,
        rig_human_given || 0, rig_berirab || 0, rig_human_up_to_ml || null, toSqlDate(rig_human_date), rig_human_given_by || null,
        meds_given || 0, meds_description || null,
        updatedBy,
        patientId,
      ]
    );

    // Mirror Patient Records into exposure #1 + PEP treatment #1 (create if missing)
    try {
      const { episodeId: epId } = await syncPrimaryRecord(pool, patientId, {
        date_of_exposure, place_of_exposure, barangay,
        type_of_animal, type_of_exposure, site_of_exposure,
        category, washing_of_bite, biting_animal_status, remarks,
        vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28,
        vaccinator_d0: vaccinator_d0 || null,
        vaccinator_d3: vaccinator_d3 || null,
        vaccinator_d7: vaccinator_d7 || null,
        vaccinator_d14: vaccinator_d14 || null,
        vaccinator_d28: vaccinator_d28 || null,
        brand_name, route, rig_date_given, outcome, date_registered,
      }, updatedBy, actor);

      // Helper: delete + re-insert Cat III sub-table records for a given episode
      const saveCat3ForEpisode = async (targetEpId) => {
        await pool.query('DELETE FROM tetanus_records WHERE episode_id = ?',    [targetEpId]).catch(() => {});
        await pool.query('DELETE FROM rig_records WHERE episode_id = ?',         [targetEpId]).catch(() => {});
        await pool.query('DELETE FROM medication_records WHERE episode_id = ?',  [targetEpId]).catch(() => {});
        if (tt_given) {
          await pool.query(
            `INSERT INTO tetanus_records (episode_id, patient_id, type, given, dose_ml, injection_site, route, anst_result, date_given, given_by)
             VALUES (?,?, 'TT', ?,?,?, ?,?,?,?)`,
            [targetEpId, patientId, 1, tt_dose_ml || null, tt_injection_site || null, tt_route || 'IM', tt_anst_result || null, tt_date_given || null, tt_given_by || null]
          ).catch(() => {});
        }
        if (ats_given) {
          await pool.query(
            `INSERT INTO tetanus_records (episode_id, patient_id, type, given, dose_ml, injection_site, route, anst_result, date_given, given_by)
             VALUES (?,?, 'ATS', ?,?,?, ?,?,?,?)`,
            [targetEpId, patientId, 1, ats_dose_ml || null, ats_injection_site || null, ats_route || 'IM', ats_anst_result || null, ats_date_given || null, ats_given_by || null]
          ).catch(() => {});
        }
        if (htig_given) {
          await pool.query(
            `INSERT INTO tetanus_records (episode_id, patient_id, type, given, dose_ml, injection_site, route, anst_result, date_given, given_by)
             VALUES (?,?, 'HTIG', ?,?,?, ?,?,?,?)`,
            [targetEpId, patientId, 1, htig_dose_ml || null, htig_injection_site || null, htig_route || null, htig_anst_result || null, htig_date_given || null, htig_given_by || null]
          ).catch(() => {});
        }
        if (rig_equine_given || rig_equirab || rig_vinrab) {
          const rigBrand = rig_equirab ? 'Equirab' : (rig_vinrab ? 'Vinrab' : null);
          await pool.query(
            `INSERT INTO rig_records (episode_id, patient_id, rig_given, rig_type, rig_brand, concentration, volume_ml, anst_result, injection_site, date_given, given_by)
             VALUES (?,?,1,'Equine',?, '200 IU/mL',?,?, 'Wound site',?,?)`,
            [targetEpId, patientId, rigBrand, rig_equine_up_to_ml || null, rig_equine_anst || null, rig_equine_date || null, rig_equine_given_by || null]
          ).catch(() => {});
        }
        if (rig_human_given || rig_berirab) {
          await pool.query(
            `INSERT INTO rig_records (episode_id, patient_id, rig_given, rig_type, rig_brand, concentration, volume_ml, injection_site, date_given, given_by)
             VALUES (?,?,1,'Human','Berirab','300 IU/mL',?, 'Wound site',?,?)`,
            [targetEpId, patientId, rig_human_up_to_ml || null, rig_human_date || null, rig_human_given_by || null]
          ).catch(() => {});
        }
        if (meds_given && meds_description) {
          await pool.query(
            `INSERT INTO medication_records (episode_id, patient_id, medication_name, dosage, remarks)
             VALUES (?,?,?,?,?)`,
            [targetEpId, patientId, 'Prescribed Medications', null, meds_description]
          ).catch(() => {});
        }
        await insertDynamicTetanus(pool, targetEpId, patientId, req.body.dynamic_tetanus);
        await insertDynamicRig(pool, targetEpId, patientId, req.body.dynamic_rig);
      };

      // Always write Cat III to episode #1 (the primary record synced above)
      if (epId) {
        await saveCat3ForEpisode(epId);
      }

      // Also write Cat III to the LATEST (current) episode when it is a different case.
      // For patients with multiple cases, syncPrimaryRecord returns episode #1 but the
      // nurse is editing the current case — we must keep them in sync.
      const [[latestEpRow]] = await pool.query(
        'SELECT episode_id FROM treatment_episodes WHERE patient_id = ? ORDER BY episode_number DESC LIMIT 1',
        [patientId]
      ).catch(() => [[null]]);
      const latestEpId = latestEpRow ? latestEpRow.episode_id : null;
      if (latestEpId && latestEpId !== epId) {
        await saveCat3ForEpisode(latestEpId);
      }

    } catch (syncErr) {
      console.warn('[patients.js PUT] Sync exposure/episode warning (non-fatal):', syncErr.message);
    }

    logActivity(req, {
      action: ACTIONS.EDIT,
      module: MODULES.PATIENTS,
      reference_id: patientId,
      description: `Edited patient: ${full_name || existing[0].full_name} (Reg. No. ${registration_number})`,
    });

    const [[fresh]] = await pool.query('SELECT * FROM patients WHERE patient_id = ?', [patientId]);
    const data = await attachCurrentCaseFromDb(pool, { ...fresh });
    data.patient_id_display = generatePatientId(data.patient_id);

    res.json({ success: true, message: 'Patient updated successfully', data: omitCredentialFields(data) });
  } catch (error) {
    console.error('Update patient error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [[existing]] = await pool.query(
      'SELECT patient_id, full_name, registration_number FROM patients WHERE patient_id = ?',
      [req.params.id]
    );
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    await pool.query('DELETE FROM patients WHERE patient_id = ?', [req.params.id]);

    logActivity(req, {
      action: ACTIONS.DELETE,
      module: MODULES.PATIENTS,
      reference_id: req.params.id,
      description: `Deleted patient: ${existing.full_name} (Reg. No. ${existing.registration_number})`,
    });

    res.json({ success: true, message: 'Patient deleted successfully' });
  } catch (error) {
    console.error('Delete patient error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
