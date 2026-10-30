/**
 * episodes.js — Multi-episode patient management
 * Handles: exposures, treatment episodes, per-episode vaccination recording
 */
const express = require('express');
const router = express.Router();
const pool = require('../config/database').pool;
const { requireAuth, requirePermission, getAuditBy } = require('../middleware/auth');
const { PERMISSIONS } = require('../utils/permissions');
const { logActivity, MODULES, ACTIONS } = require('../utils/activityLogger');
const { generatePatientId } = require('../utils/idFormats');
const { omitCredentialFields } = require('../utils/patientTempPassword');
const { computeTreatmentStatus } = require('../utils/treatmentStatus');
const { overlayPrimaryCaseFromPatient, persistEpisodeOutcome, toSqlDate, addDaysIso, localTodayIso } = require('../utils/patientRecordSync');
const {
  actorFromReq, assertDoseEntryAllowed, detectForPatient, markEpisodeIncomplete, scheduleForEpisode,
  restartTreatment, listRestarts, listStatusHistory, attachWorkflow, sendWorkflowError, workflowSummary,
  isEpisodeIncomplete, dayDiff, findBlockingNewerCase, RESTART_CONFIRM_TEXT, NEWER_CASE_RESTART_MESSAGE,
} = require('../utils/missedDose');
const { isValidAntiRabiesBrand, invalidBrandMessage, insertDynamicTetanus, insertDynamicRig } = require('../utils/vaccineCatalog');
const { toSqlDateTime } = require('../utils/dateOnly');

router.use(requireAuth);

// ── GET /api/episodes/search/duplicate — duplicate detection ──
// Must be before /:id routes
router.get('/search/duplicate', async (req, res) => {
  try {
    const { full_name, contact_number } = req.query;
    if (!full_name && !contact_number) {
      return res.status(400).json({ success: false, message: 'full_name or contact_number required' });
    }
    const conditions = [];
    const params = [];
    if (full_name) {
      conditions.push('full_name LIKE ?');
      params.push(`%${full_name}%`);
    }
    if (contact_number) {
      conditions.push('contact_number = ?');
      params.push(contact_number);
    }
    const where = conditions.join(' OR ');
    const [rows] = await pool.query(
      `SELECT patient_id, full_name, registration_number, contact_number, age, sex, barangay, date_registered
       FROM patients WHERE ${where} LIMIT 10`,
      params
    );
    const data = rows.map(r => ({ ...r, patient_id_display: generatePatientId(r.patient_id) }));
    res.json({ success: true, data, found: data.length > 0 });
  } catch (err) {
    console.error('Duplicate search error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/episodes/patient/:id — all exposures + episodes for a patient ──
router.get('/patient/:id', async (req, res) => {
  try {
    const patientId = req.params.id;
    const [[patient]] = await pool.query(
      'SELECT * FROM patients WHERE patient_id = ? LIMIT 1',
      [patientId]
    );
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found' });

    await detectForPatient(pool, patientId, { actor: actorFromReq(req) }).catch((e) => {
      console.error('[episodes] missed-dose detection failed:', e.message);
    });

    const [exposures] = await pool.query(
      'SELECT * FROM patient_exposures WHERE patient_id = ? ORDER BY exposure_number ASC',
      [patientId]
    );

    const [episodes] = await pool.query(
      'SELECT * FROM treatment_episodes WHERE patient_id = ? ORDER BY episode_number ASC',
      [patientId]
    );

    // For each episode, also fetch its RIG, tetanus, meds, and pep schedule
    const enrichedEpisodes = await Promise.all(episodes.map(async ep => {
      const computed = computeTreatmentStatus(ep);
      const [pepRows] = await pool.query(
        'SELECT * FROM patient_pep_schedule WHERE patient_id = ? AND episode_id = ? ORDER BY pep_id ASC',
        [patientId, ep.episode_id]
      );
      const [rigRows] = await pool.query(
        'SELECT * FROM rig_records WHERE episode_id = ? ORDER BY rig_id ASC',
        [ep.episode_id]
      ).catch(() => [[]]);
      const [tetRows] = await pool.query(
        'SELECT * FROM tetanus_records WHERE episode_id = ? ORDER BY tetanus_id ASC',
        [ep.episode_id]
      ).catch(() => [[]]);
      const [medRows] = await pool.query(
        'SELECT * FROM medication_records WHERE episode_id = ? ORDER BY med_id ASC',
        [ep.episode_id]
      ).catch(() => [[]]);

      return {
        ...ep,
        ...computed,
        pep_schedule: pepRows,
        rig_records: rigRows,
        tetanus_records: tetRows,
        medication_records: medRows,
      };
    }));

    overlayPrimaryCaseFromPatient(patient, exposures, enrichedEpisodes);
    await attachWorkflow(pool, enrichedEpisodes);

    const active = enrichedEpisodes.find(e =>
      ['Ongoing', 'Incomplete', 'Treatment Interrupted', 'Due Today', 'Upcoming'].includes(e.status)
    ) || enrichedEpisodes[enrichedEpisodes.length - 1] || null;

    logActivity(req, {
      action: ACTIONS.VIEW,
      module: MODULES.PATIENTS,
      reference_id: patientId,
      description: `Viewed case history for ${patient.full_name} (${generatePatientId(patientId)})`,
    });

    res.json({
      success: true,
      data: {
        patient: omitCredentialFields({ ...patient, patient_id_display: generatePatientId(patient.patient_id) }),
        exposures,
        episodes: enrichedEpisodes,
        active_episode: active,
      },
    });
  } catch (err) {
    console.error('Episode list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/episodes/:episodeId — single episode detail ──
router.get('/:episodeId', async (req, res) => {
  try {
    const [[episode]] = await pool.query(
      'SELECT * FROM treatment_episodes WHERE episode_id = ? LIMIT 1',
      [req.params.episodeId]
    );
    if (!episode) return res.status(404).json({ success: false, message: 'Episode not found' });

    const computed = computeTreatmentStatus(episode);

    const [[exposure]] = await pool.query(
      'SELECT * FROM patient_exposures WHERE exposure_id = ? LIMIT 1',
      [episode.exposure_id]
    );

    const [pepRows] = await pool.query(
      'SELECT * FROM patient_pep_schedule WHERE patient_id = ? AND episode_id = ? ORDER BY treatment_cycle ASC, pep_id ASC',
      [episode.patient_id, episode.episode_id]
    );
    const cycle = Number(episode.treatment_cycle) || 1;
    const restarts = await listRestarts(pool, episode.episode_id).catch(() => []);

    res.json({
      success: true,
      data: {
        episode: { ...episode, ...computed, workflow: workflowSummary(episode, restarts) },
        exposure: exposure || null,
        pep_schedule: pepRows.filter((r) => (Number(r.treatment_cycle) || 1) === cycle),
        pep_schedule_history: pepRows.filter((r) => (Number(r.treatment_cycle) || 1) !== cycle),
        restarts,
      },
    });
  } catch (err) {
    console.error('Episode detail error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/episodes/exposure — create new exposure ──
router.post('/exposure', async (req, res) => {
  try {
    const {
      patient_id,
      date_of_exposure, place_of_exposure, region_of_exposure,
      type_of_animal, type_of_exposure, nature_of_exposure, site_of_exposure,
      category, washing_of_bite, condition_of_animal, signs_symptoms,
      biting_animal_status, animal_owner, notes,
    } = req.body;

    if (!patient_id) {
      return res.status(400).json({ success: false, message: 'patient_id is required' });
    }

    const [[patient]] = await pool.query(
      'SELECT patient_id, full_name FROM patients WHERE patient_id = ? LIMIT 1',
      [patient_id]
    );
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found' });

    const [[lastExposure]] = await pool.query(
      'SELECT COALESCE(MAX(exposure_number), 0) as last_num FROM patient_exposures WHERE patient_id = ?',
      [patient_id]
    );
    const nextNum = (lastExposure?.last_num || 0) + 1;
    const createdBy = getAuditBy(req);

    const [result] = await pool.query(
      `INSERT INTO patient_exposures (
        patient_id, exposure_number, date_of_exposure, place_of_exposure, region_of_exposure,
        type_of_animal, type_of_exposure, nature_of_exposure, site_of_exposure,
        category, washing_of_bite, condition_of_animal, signs_symptoms,
        biting_animal_status, animal_owner, notes, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        patient_id, nextNum,
        toSqlDate(date_of_exposure), place_of_exposure || null, region_of_exposure || null,
        type_of_animal || null, type_of_exposure || null, nature_of_exposure || null,
        site_of_exposure || null, category || null, washing_of_bite || null,
        condition_of_animal || null, signs_symptoms || null,
        biting_animal_status || null, animal_owner || null, notes || null,
        createdBy,
      ]
    );

    logActivity(req, {
      action: ACTIONS.ADD,
      module: MODULES.PATIENTS,
      reference_id: patient_id,
      description: `New exposure #${nextNum} recorded for ${patient.full_name} (${generatePatientId(patient_id)})`,
    });

    res.status(201).json({
      success: true,
      message: 'New exposure recorded',
      exposure_id: result.insertId,
      exposure_number: nextNum,
    });
  } catch (err) {
    console.error('Create exposure error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/episodes/episode — create new treatment episode ──
router.post('/episode', async (req, res) => {
  try {
    const {
      patient_id, exposure_id, treatment_type = 'PEP',
      category, date_started, brand_name, route,
      washing_of_bite, rig_date_given, notes, outcome,
      vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28,
    } = req.body;

    if (!patient_id || !date_started) {
      return res.status(400).json({ success: false, message: 'patient_id and date_started are required' });
    }

    const [[patient]] = await pool.query(
      'SELECT patient_id, full_name FROM patients WHERE patient_id = ? LIMIT 1',
      [patient_id]
    );
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found' });

    if (!(await isValidAntiRabiesBrand(pool, brand_name))) {
      return res.status(400).json({ success: false, message: invalidBrandMessage() });
    }

    const [[lastEp]] = await pool.query(
      'SELECT COALESCE(MAX(episode_number), 0) as last_num FROM treatment_episodes WHERE patient_id = ?',
      [patient_id]
    );
    const nextEpNum = (lastEp?.last_num || 0) + 1;
    const createdBy = getAuditBy(req);

    const d0Given = toSqlDate(vaccine_d0) || toSqlDate(date_started);
    const [result] = await pool.query(
      `INSERT INTO treatment_episodes (
        patient_id, exposure_id, episode_number, treatment_type, category,
        status, date_started, brand_name, route,
        washing_of_bite, rig_date_given, notes, outcome, created_by,
        vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        patient_id, exposure_id || null, nextEpNum,
        treatment_type, category || null,
        vaccine_d28 ? 'Completed' : 'Ongoing', date_started,
        brand_name || null, route || null,
        washing_of_bite || null, rig_date_given || null,
        notes || null, outcome || null, createdBy,
        // Dose dates: only save what the nurse explicitly provided (null = not yet given)
        vaccine_d0 || null, vaccine_d3 || null, vaccine_d7 || null,
        vaccine_d14 || null, vaccine_d28 || null,
      ]
    );

    const episodeId = result.insertId;

    // Build PEP schedule rows — date_due is calculated from date_started,
    // but date_given is ONLY set if the nurse provided that dose date.
    // NEVER use date_started or calculated dates as the actual date_given.
    if (treatment_type === 'PEP') {
      const doses = [
        { label: 'Day 0',  days: 0,  given: toSqlDate(vaccine_d0)  || null },
        { label: 'Day 3',  days: 3,  given: toSqlDate(vaccine_d3)  || null },
        { label: 'Day 7',  days: 7,  given: toSqlDate(vaccine_d7)  || null },
        { label: 'Day 14', days: 14, given: toSqlDate(vaccine_d14) || null },
        { label: 'Day 28', days: 28, given: toSqlDate(vaccine_d28) || null },
      ];
      for (const dose of doses) {
        await pool.query(
          `INSERT INTO patient_pep_schedule
             (patient_id, episode_id, day_label, date_due, date_given, vaccine_brand, route, status)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            patient_id, episodeId, dose.label,
            addDaysIso(d0Given, dose.days),
            dose.given,           // NULL unless nurse explicitly entered a date
            brand_name || null, route || null,
            dose.given ? 'Completed' : 'Pending',
          ]
        );
      }
    }

    logActivity(req, {
      action: ACTIONS.ADD,
      module: MODULES.PATIENTS,
      reference_id: patient_id,
      description: `New treatment episode #${nextEpNum} (${treatment_type}) created for ${patient.full_name} (${generatePatientId(patient_id)})`,
    });

    res.status(201).json({
      success: true,
      message: 'New treatment episode created',
      episode_id: episodeId,
      episode_number: nextEpNum,
    });
  } catch (err) {
    console.error('Create episode error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/episodes/:episodeId/record-dose ──
router.put('/:episodeId/record-dose', async (req, res) => {
  try {
    const episodeId = req.params.episodeId;
    const {
      dose_label, date_given, vaccine_brand, route,
      site_right, site_left, notes,
    } = req.body;

    // Vaccinator name is always supplied manually by the nurse via the frontend.
    // Never fall back to the session user — store exactly what was typed.
    const vaccinatedBy      = req.body.vaccinated_by      || null;
    const vaccinatorStaffId = req.body.vaccinator_staff_id
      ? Number(req.body.vaccinator_staff_id)
      : null;

    if (!dose_label || !date_given) {
      return res.status(400).json({ success: false, message: 'dose_label and date_given are required' });
    }

    const [[episode]] = await pool.query(
      'SELECT * FROM treatment_episodes WHERE episode_id = ? LIMIT 1',
      [episodeId]
    );
    if (!episode) return res.status(404).json({ success: false, message: 'Episode not found' });

    const [[patient]] = await pool.query(
      'SELECT full_name FROM patients WHERE patient_id = ? LIMIT 1',
      [episode.patient_id]
    );

    if (!(await isValidAntiRabiesBrand(pool, vaccine_brand, { allowCurrent: episode.brand_name }))) {
      return res.status(400).json({ success: false, message: invalidBrandMessage() });
    }

    const doseCols = {
      'Day 0':  'vaccine_d0',
      'Day 3':  'vaccine_d3',
      'Day 7':  'vaccine_d7',
      'Day 14': 'vaccine_d14',
      'Day 28': 'vaccine_d28',
    };
    const col = doseCols[dose_label];
    if (!col) return res.status(400).json({ success: false, message: 'Invalid dose label' });

    try {
      await assertDoseEntryAllowed(pool, episode, { [col]: date_given }, { actor: actorFromReq(req) });
    } catch (guardErr) {
      if (sendWorkflowError(res, guardErr)) return;
      throw guardErr;
    }

    const updatedBy = getAuditBy(req);

    // Update episode date column
    await pool.query(
      `UPDATE treatment_episodes SET ${col} = ?,
         brand_name = COALESCE(?, brand_name), updated_at = NOW()
       WHERE episode_id = ?`,
      [date_given, vaccine_brand || null, episodeId]
    );

    // Update PEP schedule row — write both display name and staff_id FK
    await pool.query(
      `UPDATE patient_pep_schedule
       SET date_given          = ?,
           vaccine_brand       = COALESCE(?, vaccine_brand),
           route               = COALESCE(?, route),
           site_right          = ?,
           site_left           = ?,
           vaccinated_by       = ?,
           vaccinator_staff_id = ?,
           remarks             = ?,
           status              = 'Completed',
           updated_at          = NOW()
       WHERE patient_id = ? AND episode_id = ? AND day_label = ? AND treatment_cycle = ?`,
      [
        date_given,
        vaccine_brand || null,
        route || null,
        site_right ? 1 : 0,
        site_left  ? 1 : 0,
        vaccinatedBy,
        vaccinatorStaffId,
        notes || null,
        episode.patient_id,
        episodeId,
        dose_label,
        Number(episode.treatment_cycle) || 1,
      ]
    );

    // Recalculate outcome and promote latest case to patients cache
    const [[epNow]] = await pool.query(
      'SELECT * FROM treatment_episodes WHERE episode_id = ?',
      [episodeId]
    );
    const { completed } = await persistEpisodeOutcome(pool, epNow);

    // Update follow-up to Confirmed
    await pool.query(
      `INSERT INTO patient_followup
         (patient_id, followup_status, last_contacted, staff_name, created_by, updated_by)
       VALUES (?, 'Confirmed', CURDATE(), ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         followup_status = 'Confirmed',
         last_contacted  = CURDATE(),
         staff_name      = VALUES(staff_name),
         updated_by      = VALUES(updated_by)`,
      [episode.patient_id, updatedBy, updatedBy, updatedBy]
    );

    logActivity(req, {
      action: ACTIONS.UPDATE,
      module: MODULES.PATIENTS,
      reference_id: episode.patient_id,
      description: `Vaccination recorded: ${dose_label} for ${patient?.full_name || '#' + episode.patient_id} — Episode #${episode.episode_number} — Vaccinator: ${vaccinatedBy || 'N/A'}`,
      new_value: JSON.stringify({ dose_label, date_given, vaccine_brand, vaccinated_by: vaccinatedBy }),
    });

    res.json({
      success: true,
      message: `${dose_label} vaccination recorded`,
      vaccinated_by: vaccinatedBy,
      completed,
    });
  } catch (err) {
    console.error('Record dose error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/episodes/:episodeId/mark-missed — staff-reported missed dose ──
router.put('/:episodeId/mark-missed', async (req, res) => {
  try {
    const episodeId = req.params.episodeId;
    const { dose_label } = req.body;

    const [[episode]] = await pool.query(
      'SELECT * FROM treatment_episodes WHERE episode_id = ? LIMIT 1',
      [episodeId]
    );
    if (!episode) return res.status(404).json({ success: false, message: 'Episode not found' });
    if (isEpisodeIncomplete(episode)) {
      return res.status(409).json({ success: false, code: 'TREATMENT_INCOMPLETE', message: 'This treatment is already marked incomplete.' });
    }

    const today = localTodayIso();
    const dose = scheduleForEpisode(episode).find((d) => d.label === dose_label);
    if (!dose) return res.status(400).json({ success: false, message: 'Dose is not part of this treatment schedule.' });
    if (dose.given) return res.status(400).json({ success: false, message: `${dose_label} was already given.` });
    const due = dose.due || toSqlDate(req.body.missed_date);
    if (!due || dayDiff(due, today) < 1) {
      return res.status(400).json({ success: false, message: 'A dose can only be marked missed after its scheduled date has passed.' });
    }

    const result = await markEpisodeIncomplete(pool, episode, {
      label: dose_label, key: dose.key, due, daysDelayed: dayDiff(due, today),
    }, actorFromReq(req));
    if (!result.changed) {
      return res.status(409).json({ success: false, code: 'TREATMENT_INCOMPLETE', message: 'This treatment is already marked incomplete.' });
    }
    res.json({ success: true, message: 'Missed dose recorded. Treatment is incomplete and the schedule is stopped.' });
  } catch (err) {
    console.error('Mark missed error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/episodes/:episodeId/review — record a review note (no schedule change) ──
router.put('/:episodeId/review', async (req, res) => {
  try {
    const episodeId = req.params.episodeId;
    const { reason, action } = req.body;
    const reviewedBy = getAuditBy(req);

    if (action === 'resume' || action === 'reschedule') {
      return res.status(409).json({
        success: false,
        code: 'RESTART_REQUIRED',
        message: 'A missed-dose schedule cannot be resumed. Use Confirm Restart to start a new schedule from Day 0.',
      });
    }

    const [[episode]] = await pool.query(
      'SELECT * FROM treatment_episodes WHERE episode_id = ? LIMIT 1',
      [episodeId]
    );
    if (!episode) return res.status(404).json({ success: false, message: 'Episode not found' });

    await pool.query(
      `UPDATE treatment_episodes SET
         interrupted_reviewed = 1,
         interrupted_reason = ?,
         interrupted_reviewed_by = ?,
         interrupted_reviewed_at = NOW()
       WHERE episode_id = ?`,
      [reason || null, reviewedBy, episodeId]
    );

    const [[latest]] = await pool.query(
      'SELECT episode_id FROM treatment_episodes WHERE patient_id = ? ORDER BY episode_number DESC LIMIT 1',
      [episode.patient_id]
    );
    if (latest && Number(latest.episode_id) === Number(episodeId)) {
      await pool.query(
        `UPDATE patients SET
           interrupted_reviewed = 1,
           interrupted_reason = ?,
           interrupted_reviewed_by = ?,
           interrupted_reviewed_at = NOW()
         WHERE patient_id = ?`,
        [reason || null, reviewedBy, episode.patient_id]
      );
    }

    logActivity(req, {
      action: ACTIONS.REVIEW,
      module: MODULES.FOLLOWUP,
      reference_id: episode.patient_id,
      description: `Missed dose reviewed — Case #${episode.episode_number}. Note: ${reason || 'N/A'}`,
    });

    res.json({ success: true, message: 'Missed dose review recorded' });
  } catch (err) {
    console.error('Review episode error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/episodes/:episodeId/restart-history — restarts + status audit trail ──
router.get('/:episodeId/restart-history', async (req, res) => {
  try {
    const episodeId = req.params.episodeId;
    const [[episode]] = await pool.query(
      `SELECT te.*, pe.exposure_number, pe.date_of_exposure
       FROM treatment_episodes te
       LEFT JOIN patient_exposures pe ON pe.exposure_id = te.exposure_id
       WHERE te.episode_id = ? LIMIT 1`,
      [episodeId]
    );
    if (!episode) return res.status(404).json({ success: false, message: 'Treatment record not found' });

    const restarts = (await listRestarts(pool, episodeId)).map((r) => ({
      ...r,
      missed_due_date: toSqlDate(r.missed_due_date),
      patient_returned_on: toSqlDate(r.patient_returned_on),
      restart_date: toSqlDate(r.restart_date),
      missed_detected_at: toSqlDateTime(r.missed_detected_at),
      created_at: toSqlDateTime(r.created_at),
    }));
    const history = (await listStatusHistory(pool, episodeId)).map((h) => ({
      ...h,
      created_at: toSqlDateTime(h.created_at),
    }));
    const [scheduleRows] = await pool.query(
      `SELECT pep_id, treatment_cycle, day_label, date_due, date_given, status, vaccine_brand, vaccinated_by
       FROM patient_pep_schedule WHERE episode_id = ? ORDER BY treatment_cycle ASC, pep_id ASC`,
      [episodeId]
    );
    const schedule = scheduleRows.map((row) => ({
      ...row,
      date_due: toSqlDate(row.date_due),
      date_given: toSqlDate(row.date_given),
    }));
    const workflow = workflowSummary(episode, restarts);
    const newerCase = await findBlockingNewerCase(pool, episode);
    if (newerCase) {
      workflow.restart_blocked = true;
      workflow.restart_block_reason = NEWER_CASE_RESTART_MESSAGE;
      workflow.newer_case_number = newerCase.exposure_number || newerCase.episode_number || null;
    }

    res.json({
      success: true,
      data: {
        episode_id: episode.episode_id,
        patient_id: episode.patient_id,
        patient_id_display: generatePatientId(episode.patient_id),
        case_number: episode.exposure_number || episode.episode_number,
        date_of_exposure: toSqlDate(episode.date_of_exposure),
        workflow,
        restarts,
        status_history: history,
        schedule,
        confirm_text: RESTART_CONFIRM_TEXT,
      },
    });
  } catch (err) {
    console.error('Restart history error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/episodes/:episodeId/restart — nurse-confirmed restart from Day 0 ──
router.post('/:episodeId/restart', requirePermission(PERMISSIONS.TREATMENT_RESTART), async (req, res) => {
  try {
    const result = await restartTreatment(pool, {
      episodeId: req.params.episodeId,
      patientId: req.body.patient_id,
      body: req.body,
      actor: actorFromReq(req),
    });
    // Restart only updates the schedule and stops old reminders.
    // IPROG SMS is sent later by the reminder scheduler when a new dose is due.
    res.status(201).json({
      success: true,
      message: `Restart confirmed. New schedule starts from Day 0 on ${result.restartDate}.`,
      data: result,
    });
  } catch (err) {
    if (sendWorkflowError(res, err)) return;
    console.error('Restart treatment error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/episodes/:episodeId/rig — save RIG record ──
router.post('/:episodeId/rig', async (req, res) => {
  try {
    const episodeId = req.params.episodeId;
    const [[episode]] = await pool.query('SELECT * FROM treatment_episodes WHERE episode_id = ? LIMIT 1', [episodeId]);
    if (!episode) return res.status(404).json({ success: false, message: 'Episode not found' });

    const {
      rig_given, rig_type, rig_brand, concentration, volume_ml,
      anst_result, injection_site, date_given, given_by, remarks,
    } = req.body;

    // Upsert: delete old RIG for this episode and type, then insert
    await pool.query('DELETE FROM rig_records WHERE episode_id = ? AND rig_type = ?', [episodeId, rig_type || 'Equine']);
    const [result] = await pool.query(
      `INSERT INTO rig_records
         (episode_id, patient_id, rig_given, rig_type, rig_brand, concentration,
          volume_ml, anst_result, injection_site, date_given, given_by, remarks)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        episodeId, episode.patient_id,
        rig_given ? 1 : 0,
        rig_type || 'Equine',
        rig_brand || null, concentration || null,
        volume_ml || null, anst_result || null,
        injection_site || null, date_given || null,
        given_by || null, remarks || null,
      ]
    );

    logActivity(req, {
      action: ACTIONS.UPDATE,
      module: MODULES.PATIENTS,
      reference_id: episode.patient_id,
      description: `RIG record saved for Episode #${episode.episode_number}`,
    });

    res.json({ success: true, message: 'RIG record saved', rig_id: result.insertId });
  } catch (err) {
    console.error('RIG save error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/episodes/:episodeId/tetanus — save tetanus record ──
router.post('/:episodeId/tetanus', async (req, res) => {
  try {
    const episodeId = req.params.episodeId;
    const [[episode]] = await pool.query('SELECT * FROM treatment_episodes WHERE episode_id = ? LIMIT 1', [episodeId]);
    if (!episode) return res.status(404).json({ success: false, message: 'Episode not found' });

    const {
      type = 'TT', given, dose_ml, injection_site,
      route, anst_result, date_given, given_by, remarks,
    } = req.body;

    // Upsert per type
    await pool.query('DELETE FROM tetanus_records WHERE episode_id = ? AND type = ?', [episodeId, type]);
    const [result] = await pool.query(
      `INSERT INTO tetanus_records
         (episode_id, patient_id, type, given, dose_ml, injection_site,
          route, anst_result, date_given, given_by, remarks)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        episodeId, episode.patient_id,
        type, given ? 1 : 0,
        dose_ml || null, injection_site || null,
        route || null, anst_result || null,
        date_given || null, given_by || null, remarks || null,
      ]
    );

    logActivity(req, {
      action: ACTIONS.UPDATE,
      module: MODULES.PATIENTS,
      reference_id: episode.patient_id,
      description: `Tetanus (${type}) record saved for Episode #${episode.episode_number}`,
    });

    res.json({ success: true, message: 'Tetanus record saved', tetanus_id: result.insertId });
  } catch (err) {
    console.error('Tetanus save error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/episodes/:episodeId/medication — add medication ──
router.post('/:episodeId/medication', async (req, res) => {
  try {
    const episodeId = req.params.episodeId;
    const [[episode]] = await pool.query('SELECT * FROM treatment_episodes WHERE episode_id = ? LIMIT 1', [episodeId]);
    if (!episode) return res.status(404).json({ success: false, message: 'Episode not found' });

    const { medication_name, dosage, route, date_given, given_by, remarks } = req.body;
    if (!medication_name) return res.status(400).json({ success: false, message: 'Medication name required' });

    const [result] = await pool.query(
      `INSERT INTO medication_records
         (episode_id, patient_id, medication_name, dosage, route, date_given, given_by, remarks)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        episodeId, episode.patient_id,
        medication_name, dosage || null, route || null,
        date_given || null, given_by || null, remarks || null,
      ]
    );

    logActivity(req, {
      action: ACTIONS.ADD,
      module: MODULES.PATIENTS,
      reference_id: episode.patient_id,
      description: `Medication "${medication_name}" added for Episode #${episode.episode_number}`,
    });

    res.json({ success: true, message: 'Medication added', med_id: result.insertId });
  } catch (err) {
    console.error('Medication save error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE /api/episodes/medication/:medId — remove medication ──
router.delete('/medication/:medId', async (req, res) => {
  try {
    await pool.query('DELETE FROM medication_records WHERE med_id = ?', [req.params.medId]);
    res.json({ success: true, message: 'Medication removed' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE /api/episodes/exposure/:exposureId — guarded delete ──
// MUST be above PUT /exposure/:exposureId to avoid route collision
router.delete('/exposure/:exposureId', async (req, res) => {
  try {
    const [[linked]] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM treatment_episodes WHERE exposure_id = ?',
      [req.params.exposureId]
    );
    if (linked.cnt > 0) {
      return res.status(409).json({
        success: false,
        message: 'Cannot delete exposure with linked treatment episodes.',
      });
    }
    await pool.query('DELETE FROM patient_exposures WHERE exposure_id = ?', [req.params.exposureId]);
    res.json({ success: true, message: 'Exposure deleted' });
  } catch (err) {
    console.error('Delete exposure error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/episodes/exposure/:exposureId — update exposure record ──
router.put('/exposure/:exposureId', async (req, res) => {
  try {
    const expId = req.params.exposureId;
    const [[existing]] = await pool.query('SELECT * FROM patient_exposures WHERE exposure_id = ? LIMIT 1', [expId]);
    if (!existing) return res.status(404).json({ success: false, message: 'Exposure not found' });

    const {
      date_of_exposure, place_of_exposure, region_of_exposure,
      type_of_animal, type_of_exposure, site_of_exposure,
      nature_of_exposure, category, washing_of_bite,
      condition_of_animal, signs_symptoms, biting_animal_status, notes,
    } = req.body;

    await pool.query(
      `UPDATE patient_exposures SET
        date_of_exposure     = COALESCE(?, date_of_exposure),
        place_of_exposure    = COALESCE(?, place_of_exposure),
        region_of_exposure   = ?,
        type_of_animal       = COALESCE(?, type_of_animal),
        type_of_exposure     = COALESCE(?, type_of_exposure),
        site_of_exposure     = COALESCE(?, site_of_exposure),
        nature_of_exposure   = ?,
        category             = COALESCE(?, category),
        washing_of_bite      = ?,
        condition_of_animal  = ?,
        signs_symptoms       = ?,
        biting_animal_status = ?,
        notes                = ?
      WHERE exposure_id = ?`,
      [
        toSqlDate(date_of_exposure),
        place_of_exposure || null, region_of_exposure || null,
        type_of_animal || null,
        type_of_exposure || null, site_of_exposure || null,
        nature_of_exposure || null,
        category || null, washing_of_bite || null,
        condition_of_animal || null, signs_symptoms || null,
        biting_animal_status || null, notes || null,
        expId,
      ]
    );

    logActivity(req, {
      action: ACTIONS.EDIT,
      module: MODULES.PATIENTS,
      reference_id: existing.patient_id,
      description: `Exposure #${existing.exposure_number} updated for patient #${existing.patient_id}`,
    });

    res.json({ success: true, message: 'Exposure record updated' });
  } catch (err) {
    console.error('Update exposure error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

function _enrichCase(exposure, episode, rigRows, tetRows, medRows, patientFlat) {
  const rigEquine = rigRows.find(r => r.rig_type === 'Equine') || {};
  const rigHuman  = rigRows.find(r => r.rig_type === 'Human') || {};
  const tetTT   = tetRows.find(t => t.type === 'TT') || {};
  const tetATS  = tetRows.find(t => t.type === 'ATS') || {};
  const tetHTIG = tetRows.find(t => t.type === 'HTIG') || {};
  const medMeds = medRows.find(m => m.medication_name === 'Prescribed Medications') || {};

  const brandParts = (rigEquine.rig_brand || '').toLowerCase();
  return {
    case_number: exposure?.exposure_number || episode?.episode_number || 1,
    exposure_id: exposure?.exposure_id || null,
    episode_id:  episode?.episode_id || null,

    date_of_exposure: exposure?.date_of_exposure || patientFlat?.date_of_exposure || null,
    time_of_exposure: exposure?.time_of_exposure || patientFlat?.time_of_exposure || null,
    place_of_exposure: exposure?.place_of_exposure || patientFlat?.place_of_exposure || null,
    type_of_animal: exposure?.type_of_animal || patientFlat?.type_of_animal || null,
    animal_ownership: exposure?.animal_ownership || patientFlat?.animal_ownership || null,
    animal_status: exposure?.animal_status || patientFlat?.animal_status || null,
    type_of_exposure: exposure?.type_of_exposure || patientFlat?.type_of_exposure || null,
    wound_type: exposure?.wound_type || patientFlat?.wound_type || null,
    wound_severity: exposure?.wound_severity || patientFlat?.wound_severity || null,
    site_of_exposure: exposure?.site_of_exposure || patientFlat?.site_of_exposure || null,
    pre_exposure_hx: exposure?.pre_exposure_hx || patientFlat?.pre_exposure_hx || null,
    allergy: exposure?.allergy || patientFlat?.allergy || null,
    co_morbidities: exposure?.co_morbidities || patientFlat?.co_morbidities || null,
    tetanus_vaccine_hx: exposure?.tetanus_vaccine_hx || patientFlat?.tetanus_vaccine_hx || null,

    category: exposure?.category || episode?.category || patientFlat?.category || null,
    washing_of_bite: exposure?.washing_of_bite || episode?.washing_of_bite || patientFlat?.washing_of_bite || null,
    brand_name: episode?.brand_name || patientFlat?.brand_name || null,
    route: episode?.route || patientFlat?.route || null,
    rig_date_given: episode?.rig_date_given || patientFlat?.rig_date_given || null,
    vaccine_d0: episode?.vaccine_d0 || patientFlat?.vaccine_d0 || null,
    vaccine_d3: episode?.vaccine_d3 || patientFlat?.vaccine_d3 || null,
    vaccine_d7: episode?.vaccine_d7 || patientFlat?.vaccine_d7 || null,
    vaccine_d14: episode?.vaccine_d14 || patientFlat?.vaccine_d14 || null,
    vaccine_d28: episode?.vaccine_d28 || patientFlat?.vaccine_d28 || null,

    tt_given: !!(tetTT.given ?? patientFlat?.tt_given),
    tt_dose_ml: tetTT.dose_ml ?? patientFlat?.tt_dose_ml ?? null,
    tt_injection_site: tetTT.injection_site || patientFlat?.tt_injection_site || null,
    tt_date_given: tetTT.date_given || patientFlat?.tt_date_given || null,
    tt_given_by: tetTT.given_by || patientFlat?.tt_given_by || null,
    tt_route: tetTT.route || null,
    tt_anst_result: tetTT.anst_result || null,

    ats_given: !!(tetATS.given ?? patientFlat?.ats_given),
    ats_dose_ml: tetATS.dose_ml ?? patientFlat?.ats_dose_ml ?? null,
    ats_injection_site: tetATS.injection_site || patientFlat?.ats_injection_site || null,
    ats_date_given: tetATS.date_given || patientFlat?.ats_date_given || null,
    ats_given_by: tetATS.given_by || patientFlat?.ats_given_by || null,
    ats_route: tetATS.route || null,
    ats_anst_result: tetATS.anst_result || patientFlat?.ats_anst_result || null,

    htig_given: !!(tetHTIG.given ?? patientFlat?.htig_given),
    htig_dose_ml: tetHTIG.dose_ml ?? patientFlat?.htig_dose_ml ?? null,
    htig_injection_site: tetHTIG.injection_site || patientFlat?.htig_injection_site || null,
    htig_date_given: tetHTIG.date_given || patientFlat?.htig_date_given || null,
    htig_given_by: tetHTIG.given_by || patientFlat?.htig_given_by || null,
    htig_route: tetHTIG.route || patientFlat?.htig_route || null,
    htig_anst_result: tetHTIG.anst_result || null,

    rig_equine_given: !!(rigEquine.rig_given ?? patientFlat?.rig_equine_given),
    rig_equirab: brandParts.includes('equirab') ? 1 : (patientFlat?.rig_equirab || 0),
    rig_vinrab: brandParts.includes('vinrab') ? 1 : (patientFlat?.rig_vinrab || 0),
    rig_equine_up_to_ml: rigEquine.volume_ml ?? patientFlat?.rig_equine_up_to_ml ?? null,
    rig_equine_anst: rigEquine.anst_result || patientFlat?.rig_equine_anst || null,
    rig_equine_date: rigEquine.date_given || patientFlat?.rig_equine_date || null,
    rig_equine_given_by: rigEquine.given_by || patientFlat?.rig_equine_given_by || null,

    rig_human_given: !!(rigHuman.rig_given ?? patientFlat?.rig_human_given),
    rig_berirab: (rigHuman.rig_brand || '').toLowerCase().includes('berirab') ? 1 : (patientFlat?.rig_berirab || 0),
    rig_human_up_to_ml: rigHuman.volume_ml ?? patientFlat?.rig_human_up_to_ml ?? null,
    rig_human_date: rigHuman.date_given || patientFlat?.rig_human_date || null,
    rig_human_given_by: rigHuman.given_by || patientFlat?.rig_human_given_by || null,

    meds_given: (medRows.length > 0) ? 1 : (patientFlat?.meds_given || 0),
    meds_description: medMeds.remarks || patientFlat?.meds_description || null,

    outcome: episode?.outcome || patientFlat?.outcome || null,
    biting_animal_status: exposure?.biting_animal_status || patientFlat?.biting_animal_status || null,
    remarks: exposure?.notes || episode?.notes || patientFlat?.remarks || null,

    episode_status: episode?.status || null,
    treatmentStatus: episode?.treatmentStatus || null,
  };
}

router.get('/patient/:id/cases', async (req, res) => {
  try {
    const patientId = req.params.id;
    const [[patient]] = await pool.query(
      `SELECT p.*,
              (SELECT pe.exposure_id FROM patient_exposures pe WHERE pe.patient_id = p.patient_id ORDER BY pe.exposure_number ASC LIMIT 1) as first_exposure_id
       FROM patients p WHERE p.patient_id = ? LIMIT 1`,
      [patientId]
    );
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found' });

    const [exposures] = await pool.query(
      'SELECT * FROM patient_exposures WHERE patient_id = ? ORDER BY exposure_number ASC',
      [patientId]
    );
    const [episodes] = await pool.query(
      'SELECT * FROM treatment_episodes WHERE patient_id = ? ORDER BY episode_number ASC',
      [patientId]
    );

    overlayPrimaryCaseFromPatient(patient, exposures, episodes);

    const maxCount = Math.max(
      exposures.length,
      episodes.length,
      exposures.length === 0 && episodes.length === 0 ? 0 : 1
    );

    const cases = [];
    const count = maxCount || (exposures.length === 0 ? 1 : 0);

    if (exposures.length === 0 && episodes.length === 0) {
      const caseOne = _enrichCase(null, null, [], [], [], patient);
      cases.push(caseOne);
    } else {
      const totalCases = Math.max(exposures.length, episodes.length);
      for (let i = 0; i < totalCases; i++) {
        const exp = exposures[i] || null;
        const ep  = episodes[i] || null;
        const epId = ep?.episode_id;
        let rigs = [], tets = [], meds = [];
        if (epId) {
          [rigs] = await pool.query('SELECT * FROM rig_records WHERE episode_id = ? ORDER BY rig_id ASC', [epId]).catch(() => [[]]);
          [tets] = await pool.query('SELECT * FROM tetanus_records WHERE episode_id = ? ORDER BY tetanus_id ASC', [epId]).catch(() => [[]]);
          [meds] = await pool.query('SELECT * FROM medication_records WHERE episode_id = ? ORDER BY med_id ASC', [epId]).catch(() => [[]]);
        }
        cases.push(_enrichCase(exp, ep, rigs, tets, meds, patient));
      }
    }

    logActivity(req, {
      action: ACTIONS.VIEW,
      module: MODULES.PATIENTS,
      reference_id: patientId,
      description: `Viewed case-based episode history for ${patient.full_name} (${generatePatientId(patientId)})`,
    });

    res.json({
      success: true,
      data: {
        patient: {
          patient_id: patient.patient_id,
          patient_id_display: generatePatientId(patient.patient_id),
          registration_number: patient.registration_number,
          full_name: patient.full_name,
          age: patient.age,
          sex: patient.sex,
          address: patient.address,
          barangay: patient.barangay,
          municipality: patient.municipality,
          contact_number: patient.contact_number,
          date_registered: patient.date_registered,
        },
        cases,
        total_cases: cases.length,
      },
    });
  } catch (err) {
    console.error('Cases list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/case', async (req, res) => {
  try {
    const {
      patient_id,
      date_of_exposure, place_of_exposure,
      type_of_animal, type_of_exposure, site_of_exposure,
      category, washing_of_bite, rig_date_given, route,
      vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28, brand_name,
      tt_given, tt_dose_ml, tt_injection_site, tt_date_given, tt_given_by, tt_route, tt_anst_result,
      ats_given, ats_dose_ml, ats_injection_site, ats_date_given, ats_given_by, ats_route, ats_anst_result,
      htig_given, htig_dose_ml, htig_injection_site, htig_date_given, htig_given_by, htig_route, htig_anst_result,
      rig_equine_given, rig_equirab, rig_vinrab, rig_equine_up_to_ml, rig_equine_anst, rig_equine_date, rig_equine_given_by,
      rig_human_given, rig_berirab, rig_human_up_to_ml, rig_human_date, rig_human_given_by,
      meds_given, meds_description,
      outcome, biting_animal_status, remarks,
    } = req.body;

    if (!patient_id) {
      return res.status(400).json({ success: false, message: 'patient_id is required' });
    }

    const [[patient]] = await pool.query(
      'SELECT patient_id, full_name, date_registered FROM patients WHERE patient_id = ? LIMIT 1',
      [patient_id]
    );
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found' });

    if (!(await isValidAntiRabiesBrand(pool, brand_name))) {
      return res.status(400).json({ success: false, message: invalidBrandMessage() });
    }

    const createdBy = getAuditBy(req);

    const [[lastExp]] = await pool.query(
      'SELECT COALESCE(MAX(exposure_number),0) AS last_num FROM patient_exposures WHERE patient_id = ?',
      [patient_id]
    );
    const nextExpNum = (lastExp?.last_num || 0) + 1;

    const [[lastEp]] = await pool.query(
      'SELECT COALESCE(MAX(episode_number),0) AS last_num FROM treatment_episodes WHERE patient_id = ?',
      [patient_id]
    );
    const nextEpNum = (lastEp?.last_num || 0) + 1;

    const [expRes] = await pool.query(
      `INSERT INTO patient_exposures (
        patient_id, exposure_number, date_of_exposure, place_of_exposure,
        type_of_animal, type_of_exposure, site_of_exposure,
        category, washing_of_bite, biting_animal_status, notes, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        patient_id, nextExpNum,
        toSqlDate(date_of_exposure), place_of_exposure || null,
        type_of_animal || null, type_of_exposure || null, site_of_exposure || null,
        category || null, washing_of_bite || null, biting_animal_status || null,
        remarks || null, createdBy,
      ]
    );
    const exposureId = expRes.insertId;

    const epStatus = vaccine_d0
      ? (vaccine_d28 ? 'Completed' : 'Ongoing')
      : 'Ongoing';

    const [epRes] = await pool.query(
      `INSERT INTO treatment_episodes (
        patient_id, exposure_id, episode_number, treatment_type, category,
        status, date_started, brand_name, route, washing_of_bite,
        vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28,
        rig_date_given, outcome, notes, created_by
      ) VALUES (?,?,?,'PEP',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        patient_id, exposureId, nextEpNum, category || null,
        epStatus,
        toSqlDate(vaccine_d0) || localTodayIso(),
        brand_name || null, route || null, washing_of_bite || null,
        toSqlDate(vaccine_d0), toSqlDate(vaccine_d3), toSqlDate(vaccine_d7),
        toSqlDate(vaccine_d14), toSqlDate(vaccine_d28),
        toSqlDate(rig_date_given), outcome || null, remarks || null,
        createdBy,
      ]
    );
    const episodeId = epRes.insertId;

    if (vaccine_d0) {
      const d0Iso = toSqlDate(vaccine_d0);
      const doses = [
        { label: 'Day 0',  days: 0,  key: toSqlDate(vaccine_d0)  },
        { label: 'Day 3',  days: 3,  key: toSqlDate(vaccine_d3)  },
        { label: 'Day 7',  days: 7,  key: toSqlDate(vaccine_d7)  },
        { label: 'Day 14', days: 14, key: toSqlDate(vaccine_d14) },
        { label: 'Day 28', days: 28, key: toSqlDate(vaccine_d28) },
      ];
      for (const dose of doses) {
        await pool.query(
          `INSERT INTO patient_pep_schedule
             (patient_id, episode_id, day_label, date_due, date_given, vaccine_brand, route, status)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            patient_id, episodeId, dose.label,
            addDaysIso(d0Iso, dose.days),
            dose.key || null, brand_name || null, route || null,
            dose.key ? 'Completed' : 'Pending',
          ]
        );
      }
    }

    if (tt_given) {
      await pool.query(
        `INSERT INTO tetanus_records (episode_id, patient_id, type, given, dose_ml, injection_site, route, anst_result, date_given, given_by)
         VALUES (?,?,'TT',?,?,?,?,?,?,?)`,
        [episodeId, patient_id, 1, tt_dose_ml || null, tt_injection_site || null, tt_route || 'IM', tt_anst_result || null, tt_date_given || null, tt_given_by || null]
      ).catch(() => {});
    }
    if (ats_given) {
      await pool.query(
        `INSERT INTO tetanus_records (episode_id, patient_id, type, given, dose_ml, injection_site, route, anst_result, date_given, given_by)
         VALUES (?,?,'ATS',?,?,?,?,?,?,?)`,
        [episodeId, patient_id, 1, ats_dose_ml || null, ats_injection_site || null, ats_route || 'IM', ats_anst_result || null, ats_date_given || null, ats_given_by || null]
      ).catch(() => {});
    }
    if (htig_given) {
      await pool.query(
        `INSERT INTO tetanus_records (episode_id, patient_id, type, given, dose_ml, injection_site, route, anst_result, date_given, given_by)
         VALUES (?,?,'HTIG',?,?,?,?,?,?,?)`,
        [episodeId, patient_id, 1, htig_dose_ml || null, htig_injection_site || null, htig_route || null, htig_anst_result || null, htig_date_given || null, htig_given_by || null]
      ).catch(() => {});
    }
    if (rig_equine_given || rig_equirab || rig_vinrab) {
      const rigBrand = rig_equirab ? 'Equirab' : (rig_vinrab ? 'Vinrab' : null);
      await pool.query(
        `INSERT INTO rig_records (episode_id, patient_id, rig_given, rig_type, rig_brand, concentration, volume_ml, anst_result, injection_site, date_given, given_by)
         VALUES (?,?,1,'Equine',?, '200 IU/mL',?,?, 'Wound site',?,?)`,
        [episodeId, patient_id, rigBrand, rig_equine_up_to_ml || null, rig_equine_anst || null, rig_equine_date || null, rig_equine_given_by || null]
      ).catch(() => {});
    }
    if (rig_human_given || rig_berirab) {
      await pool.query(
        `INSERT INTO rig_records (episode_id, patient_id, rig_given, rig_type, rig_brand, concentration, volume_ml, injection_site, date_given, given_by)
         VALUES (?,?,1,'Human','Berirab','300 IU/mL',?, 'Wound site',?,?)`,
        [episodeId, patient_id, rig_human_up_to_ml || null, rig_human_date || null, rig_human_given_by || null]
      ).catch(() => {});
    }
    if (meds_given && meds_description) {
      await pool.query(
        `INSERT INTO medication_records (episode_id, patient_id, medication_name, dosage, remarks)
         VALUES (?,?,?,?,?)`,
        [episodeId, patient_id, 'Prescribed Medications', null, meds_description]
      ).catch(() => {});
    }
    await insertDynamicTetanus(pool, episodeId, patient_id, req.body.dynamic_tetanus);
    await insertDynamicRig(pool, episodeId, patient_id, req.body.dynamic_rig);

    logActivity(req, {
      action: ACTIONS.ADD,
      module: MODULES.PATIENTS,
      reference_id: patient_id,
      description: `New Case #${nextExpNum} created for ${patient.full_name} (${generatePatientId(patient_id)}) via Episodes module`,
    });

    res.status(201).json({
      success: true,
      message: `New case #${nextExpNum} created successfully`,
      exposure_id: exposureId,
      episode_id: episodeId,
      case_number: nextExpNum,
    });
  } catch (err) {
    console.error('Create case error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;