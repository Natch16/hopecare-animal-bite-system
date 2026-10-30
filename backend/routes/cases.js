/**
 * cases.js — Case-scoped endpoints for Patient Case Management
 * Handles: create new case, fetch cases by patient, fetch/update single case
 */
const express = require('express');
const router = express.Router();
const pool = require('../config/database').pool;
const { requireAuth, getAuditBy } = require('../middleware/auth');
const { logActivity, MODULES, ACTIONS } = require('../utils/activityLogger');
const { generatePatientId } = require('../utils/idFormats');
const { omitCredentialFields } = require('../utils/patientTempPassword');
const { computeTreatmentStatus } = require('../utils/treatmentStatus');
const {
  createNewCase,
  validateCasePayload,
  computeOutcome,
  overlayPrimaryCaseFromPatient,
  updateCaseTreatment,
  pepDaysForCategory,
  toSqlDate,
} = require('../utils/patientRecordSync');
const { isValidAntiRabiesBrand, invalidBrandMessage, insertDynamicTetanus, insertDynamicRig } = require('../utils/vaccineCatalog');
const { actorFromReq, detectForPatient, attachWorkflow, sendWorkflowError } = require('../utils/missedDose');

function attachDoseMeta(episode) {
  if (!episode) return episode;
  const required_doses = pepDaysForCategory(episode.category);
  return {
    ...episode,
    required_doses,
    required_dose_count: required_doses.length,
    outcome: computeOutcome(episode.category, episode),
  };
}

router.use(requireAuth);

// GET /api/cases/patient/:patientId — all cases for a patient
// MUST be defined BEFORE any GET /:caseId route to avoid Express route shadowing
router.get('/patient/:patientId', async (req, res) => {
  try {
    const patientId = req.params.patientId;

    // Step 1: Look up patient
    const [[patient]] = await pool.query(
      'SELECT * FROM patients WHERE patient_id = ? LIMIT 1',
      [patientId]
    );
    if (!patient) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    await detectForPatient(pool, patientId, { actor: actorFromReq(req) }).catch((e) => {
      console.error('[cases] missed-dose detection failed:', e.message);
    });

    // Step 2: Fetch all exposures for this patient
    const [exposures] = await pool.query(
      'SELECT * FROM patient_exposures WHERE patient_id = ? ORDER BY exposure_number ASC',
      [patientId]
    );

    // Step 3: Fetch all treatment episodes for this patient
    const [episodes] = await pool.query(
      'SELECT * FROM treatment_episodes WHERE patient_id = ? ORDER BY episode_number ASC',
      [patientId]
    );

    // Step 4: Enrich each episode with computed status and related records
    const enrichedEpisodes = await Promise.all(episodes.map(async (ep) => {
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

    // Step 5: Overlay primary case data from patient (recalculates outcomes/statuses consistently)
    overlayPrimaryCaseFromPatient(patient, exposures, enrichedEpisodes);
    await attachWorkflow(pool, enrichedEpisodes);

    // Current case = most recently created case (highest episode/exposure number)
    const current_case =
      enrichedEpisodes.slice().sort((a, b) => Number(a.episode_number) - Number(b.episode_number)).pop()
      || null;
    const active_episode = current_case;

    // Step 7: Log activity
    logActivity(req, {
      action: ACTIONS.VIEW,
      module: MODULES.PATIENTS,
      reference_id: patientId,
      description: `Viewed case history for ${patient.full_name} (${generatePatientId(patientId)})`,
    });

    // Step 8: Return response
    return res.status(200).json({
      success: true,
      data: {
        patient: omitCredentialFields({ ...patient, patient_id_display: generatePatientId(patient.patient_id) }),
        exposures,
        episodes: enrichedEpisodes,
        active_episode,
        current_case,
      },
    });
  } catch (err) {
    console.error('Get cases by patient error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/cases/:caseId — fetch full detail for a single case by episode_id
router.get('/:caseId', async (req, res) => {
  try {
    const caseId = req.params.caseId;

    // Step 1: Fetch the episode joined with its linked exposure
    const [[row]] = await pool.query(
      `SELECT te.*, pe.date_of_exposure, pe.place_of_exposure, pe.barangay,
              pe.type_of_animal, pe.type_of_exposure, pe.site_of_exposure,
              pe.biting_animal_status,
              pe.notes AS exposure_notes, pe.exposure_id AS pe_exposure_id,
              pe.exposure_number
       FROM treatment_episodes te
       LEFT JOIN patient_exposures pe ON pe.exposure_id = te.exposure_id
       WHERE te.episode_id = ?
       LIMIT 1`,
      [caseId]
    );

    if (!row) {
      return res.status(404).json({ success: false, message: 'Case not found' });
    }

    // Step 2: Fetch the current treatment cycle's pep_schedule rows for this episode
    const [pepRows] = await pool.query(
      'SELECT * FROM patient_pep_schedule WHERE episode_id = ? AND treatment_cycle = ? ORDER BY pep_id ASC',
      [caseId, Number(row.treatment_cycle) || 1]
    );

    // Step 3: Compute a fresh outcome
    const freshOutcome = computeOutcome(row.category, row);

    // Step 4: Build the structured response
    const episode = attachDoseMeta({ ...row });
    const exposure = {
      exposure_id:         row.pe_exposure_id || row.exposure_id,
      exposure_number:     row.exposure_number,
      date_of_exposure:    row.date_of_exposure,
      place_of_exposure:   row.place_of_exposure,
      barangay:            row.barangay,
      type_of_animal:      row.type_of_animal,
      type_of_exposure:    row.type_of_exposure,
      site_of_exposure:    row.site_of_exposure,
      biting_animal_status: row.biting_animal_status,
      notes:               row.exposure_notes,
    };

    return res.status(200).json({
      success: true,
      data: { episode, exposure, pep_schedule: pepRows },
    });
  } catch (err) {
    console.error('Get case by ID error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/cases/:caseId — update exposure and/or PEP fields for a specific case
router.put('/:caseId', async (req, res) => {
  try {
    const caseId = req.params.caseId;

    // Step 1: Require patient_id in body for ownership validation
    const { patient_id } = req.body;
    if (!patient_id) {
      return res.status(400).json({ success: false, message: 'patient_id is required' });
    }

    // Step 2: Look up the episode to confirm it exists
    const [[episode]] = await pool.query(
      'SELECT * FROM treatment_episodes WHERE episode_id = ? LIMIT 1',
      [caseId]
    );
    if (!episode) {
      return res.status(404).json({ success: false, message: 'Case not found' });
    }

    // Step 3: Ownership check — patient_id in body must match the episode
    if (Number(episode.patient_id) !== Number(patient_id)) {
      return res.status(400).json({
        success: false,
        message: 'Dose records must belong to the correct patient and case.',
      });
    }

    // Step 4: Validate payload — allow category to be optional if already set on the episode
    const payloadForValidation = { ...req.body, category: req.body.category || episode.category };
    const errors = validateCasePayload(payloadForValidation);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, message: errors[0] });
    }
    if (!(await isValidAntiRabiesBrand(pool, req.body.brand_name, { allowCurrent: episode.brand_name }))) {
      return res.status(400).json({ success: false, message: invalidBrandMessage() });
    }

    // Step 5: Update patient_exposures for the linked exposure (if it exists)
    if (episode.exposure_id) {
      await pool.query(
        `UPDATE patient_exposures SET
          date_of_exposure      = COALESCE(?, date_of_exposure),
          place_of_exposure     = COALESCE(?, place_of_exposure),
          type_of_animal        = COALESCE(?, type_of_animal),
          type_of_exposure      = COALESCE(?, type_of_exposure),
          site_of_exposure      = COALESCE(?, site_of_exposure),
          washing_of_bite       = COALESCE(?, washing_of_bite),
          biting_animal_status  = COALESCE(?, biting_animal_status),
          notes                 = COALESCE(?, notes)
         WHERE exposure_id = ?`,
        [
          toSqlDate(req.body.date_of_exposure),
          req.body.place_of_exposure    || null,
          req.body.type_of_animal       || null,
          req.body.type_of_exposure     || null,
          req.body.site_of_exposure     || null,
          req.body.washing_of_bite      || null,
          req.body.biting_animal_status || null,
          req.body.notes                || null,
          episode.exposure_id,
        ]
      );
    }

    // Step 6: Delegate treatment_episodes update, pep_schedule rebuild, and promotion
    await updateCaseTreatment(pool, caseId, req.body, patient_id, actorFromReq(req));

    // Step 6b: Update Category III treatment data if provided
    const b = req.body;
    const hasCategory3Data = b.tt_given !== undefined || b.ats_given !== undefined || 
                             b.htig_given !== undefined || b.rig_equine_given !== undefined || 
                             b.rig_human_given !== undefined || b.meds_given !== undefined;

    if (hasCategory3Data) {
      const ttGiven = b.tt_given ? 1 : 0;
      const atsGiven = b.ats_given ? 1 : 0;
      const htigGiven = b.htig_given ? 1 : 0;
      const equineGiven = (b.rig_equine_given || b.rig_equirab || b.rig_vinrab) ? 1 : 0;
      const humanGiven = (b.rig_human_given || b.rig_berirab) ? 1 : 0;
      const medsGiven = b.meds_given ? 1 : 0;

      await pool.query(
        `UPDATE patients SET
          tt_given = COALESCE(?, tt_given),
          tt_dose_ml = COALESCE(?, tt_dose_ml),
          tt_injection_site = COALESCE(?, tt_injection_site),
          tt_date_given = COALESCE(?, tt_date_given),
          tt_given_by = COALESCE(?, tt_given_by),
          tt_route = COALESCE(?, tt_route),
          tt_anst_result = COALESCE(?, tt_anst_result),
          ats_given = COALESCE(?, ats_given),
          ats_dose_ml = COALESCE(?, ats_dose_ml),
          ats_injection_site = COALESCE(?, ats_injection_site),
          ats_date_given = COALESCE(?, ats_date_given),
          ats_given_by = COALESCE(?, ats_given_by),
          ats_route = COALESCE(?, ats_route),
          ats_anst_result = COALESCE(?, ats_anst_result),
          htig_given = COALESCE(?, htig_given),
          htig_dose_ml = COALESCE(?, htig_dose_ml),
          htig_injection_site = COALESCE(?, htig_injection_site),
          htig_date_given = COALESCE(?, htig_date_given),
          htig_given_by = COALESCE(?, htig_given_by),
          htig_route = COALESCE(?, htig_route),
          htig_anst_result = COALESCE(?, htig_anst_result),
          rig_equine_given = COALESCE(?, rig_equine_given),
          rig_equirab = COALESCE(?, rig_equirab),
          rig_vinrab = COALESCE(?, rig_vinrab),
          rig_equine_up_to_ml = COALESCE(?, rig_equine_up_to_ml),
          rig_equine_anst = COALESCE(?, rig_equine_anst),
          rig_equine_date = COALESCE(?, rig_equine_date),
          rig_equine_given_by = COALESCE(?, rig_equine_given_by),
          rig_human_given = COALESCE(?, rig_human_given),
          rig_berirab = COALESCE(?, rig_berirab),
          rig_human_up_to_ml = COALESCE(?, rig_human_up_to_ml),
          rig_human_date = COALESCE(?, rig_human_date),
          rig_human_given_by = COALESCE(?, rig_human_given_by),
          meds_given = COALESCE(?, meds_given),
          meds_description = COALESCE(?, meds_description)
        WHERE patient_id = ?`,
        [
          b.tt_given !== undefined ? ttGiven : null,
          b.tt_dose_ml || null,
          b.tt_injection_site || null,
          b.tt_date_given || null,
          b.tt_given_by || null,
          b.tt_route || null,
          b.tt_anst_result || null,
          b.ats_given !== undefined ? atsGiven : null,
          b.ats_dose_ml || null,
          b.ats_injection_site || null,
          b.ats_date_given || null,
          b.ats_given_by || null,
          b.ats_route || null,
          b.ats_anst_result || null,
          b.htig_given !== undefined ? htigGiven : null,
          b.htig_dose_ml || null,
          b.htig_injection_site || null,
          b.htig_date_given || null,
          b.htig_given_by || null,
          b.htig_route || null,
          b.htig_anst_result || null,
          b.rig_equine_given !== undefined || b.rig_equirab !== undefined || b.rig_vinrab !== undefined ? equineGiven : null,
          b.rig_equirab !== undefined ? (b.rig_equirab ? 1 : 0) : null,
          b.rig_vinrab !== undefined ? (b.rig_vinrab ? 1 : 0) : null,
          b.rig_equine_up_to_ml || null,
          b.rig_equine_anst || null,
          b.rig_equine_date || null,
          b.rig_equine_given_by || null,
          b.rig_human_given !== undefined || b.rig_berirab !== undefined ? humanGiven : null,
          b.rig_berirab !== undefined ? (b.rig_berirab ? 1 : 0) : null,
          b.rig_human_up_to_ml || null,
          b.rig_human_date || null,
          b.rig_human_given_by || null,
          b.meds_given !== undefined ? medsGiven : null,
          b.meds_description || null,
          patient_id
        ]
      ).catch(e => {
        console.error('[PUT /api/cases/:caseId] Category III update failed:', e.message);
        throw new Error('Failed to update Category III treatment information');
      });

      console.log(`[PUT /api/cases/:caseId] Category III treatment updated for patient ${patient_id}`);
    }

    // Step 7: Re-fetch the updated case (same JOIN as GET /:caseId)
    const [[updatedRow]] = await pool.query(
      `SELECT te.*, pe.date_of_exposure, pe.place_of_exposure, pe.barangay,
              pe.type_of_animal, pe.type_of_exposure, pe.site_of_exposure,
              pe.biting_animal_status,
              pe.notes AS exposure_notes, pe.exposure_id AS pe_exposure_id,
              pe.exposure_number
       FROM treatment_episodes te
       LEFT JOIN patient_exposures pe ON pe.exposure_id = te.exposure_id
       WHERE te.episode_id = ? LIMIT 1`,
      [caseId]
    );

    // Step 8: Fetch updated pep_schedule rows (current treatment cycle)
    const [pepRows] = await pool.query(
      'SELECT * FROM patient_pep_schedule WHERE episode_id = ? AND treatment_cycle = ? ORDER BY pep_id ASC',
      [caseId, Number(updatedRow.treatment_cycle) || 1]
    );

    // Step 9: Compute fresh outcome
    const freshOutcome = computeOutcome(updatedRow.category, updatedRow);
    const updatedEpisode = { ...updatedRow, outcome: freshOutcome };

    // Step 10: Build structured response
    const exposure = {
      exposure_id:         updatedRow.pe_exposure_id || updatedRow.exposure_id,
      exposure_number:     updatedRow.exposure_number,
      date_of_exposure:    updatedRow.date_of_exposure,
      place_of_exposure:   updatedRow.place_of_exposure,
      barangay:            updatedRow.barangay,
      type_of_animal:      updatedRow.type_of_animal,
      type_of_exposure:    updatedRow.type_of_exposure,
      site_of_exposure:    updatedRow.site_of_exposure,
      biting_animal_status: updatedRow.biting_animal_status,
      notes:               updatedRow.exposure_notes,
    };

    return res.status(200).json({
      success: true,
      outcome: freshOutcome,
      data: {
        episode: updatedEpisode,
        exposure,
        pep_schedule: pepRows,
      },
    });
  } catch (err) {
    if (sendWorkflowError(res, err)) return;
    console.error('Update case error:', err);
    if (err.status === 400 || err.status === 404) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/cases — create a new case for an existing patient
router.post('/', async (req, res) => {
  try {
    const { patient_id } = req.body;

    // Step 1: Validate patient_id presence
    if (!patient_id) {
      return res.status(400).json({ success: false, message: 'patient_id is required' });
    }

    // Step 2: Confirm patient exists
    const [[patient]] = await pool.query(
      'SELECT patient_id, full_name FROM patients WHERE patient_id = ? LIMIT 1',
      [patient_id]
    );
    if (!patient) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    // Step 3: Validate case payload fields
    const errors = validateCasePayload(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, message: errors[0] });
    }
    if (!(await isValidAntiRabiesBrand(pool, req.body.brand_name))) {
      return res.status(400).json({ success: false, message: invalidBrandMessage() });
    }

    // Step 4: Extract case data fields — log date_of_exposure to help debug date sync issues
    console.log(`[POST /api/cases] patient=${patient_id} received date_of_exposure=${JSON.stringify(req.body.date_of_exposure)}`);
    const caseData = {
      date_of_exposure:    toSqlDate(req.body.date_of_exposure),
      place_of_exposure:   req.body.place_of_exposure   || null,
      barangay:            req.body.barangay            || null,
      type_of_animal:      req.body.type_of_animal      || null,
      type_of_exposure:    req.body.type_of_exposure    || null,
      site_of_exposure:    req.body.site_of_exposure    || null,
      category:            req.body.category            || null,
      washing_of_bite:     req.body.washing_of_bite     || null,
      biting_animal_status: req.body.biting_animal_status || null,
      brand_name:          req.body.brand_name          || null,
      route:               req.body.route               || null,
      rig_date_given:      req.body.rig_date_given      || null,
      vaccine_d0:          req.body.vaccine_d0          || null,
      vaccine_d3:          req.body.vaccine_d3          || null,
      vaccine_d7:          req.body.vaccine_d7          || null,
      vaccine_d14:         req.body.vaccine_d14         || null,
      vaccine_d28:         req.body.vaccine_d28         || null,
      // Per-dose vaccinator names — manually entered by nurse, never copied from session
      vaccinator_d0:       req.body.vaccinator_d0       || null,
      vaccinator_d3:       req.body.vaccinator_d3       || null,
      vaccinator_d7:       req.body.vaccinator_d7       || null,
      vaccinator_d14:      req.body.vaccinator_d14      || null,
      vaccinator_d28:      req.body.vaccinator_d28      || null,
      remarks:             req.body.remarks             || null,
    };

    // Step 5: Get audit identity
    const auditBy = getAuditBy(req);

    // Step 6: Create the new case (inserts exposure + episode + pep_schedule, promotes to current)
    const result = await createNewCase(pool, patient_id, caseData, auditBy);
    // result: { exposureId, episodeId, caseNumber, outcome }

    // Step 6b: Save Category III treatment data to patients table
    // All Category III fields are stored in the patients table (migration_003 + migration_018)
    const b = req.body; // shorthand

    const ttGiven  = b.tt_given  ? 1 : 0;
    const atsGiven = b.ats_given ? 1 : 0;
    const htigGiven = b.htig_given ? 1 : 0;
    const equineGiven = (b.rig_equine_given || b.rig_equirab || b.rig_vinrab
      || (Array.isArray(b.dynamic_rig) && b.dynamic_rig.some((r) => r.given && (r.rig_type === 'Equine' || r.category === 'ERIG')))) ? 1 : 0;
    const humanGiven  = (b.rig_human_given  || b.rig_berirab
      || (Array.isArray(b.dynamic_rig) && b.dynamic_rig.some((r) => r.given && (r.rig_type === 'Human' || r.category === 'HRIG')))) ? 1 : 0;
    const medsGiven   = b.meds_given ? 1 : 0;

    // Update patients table with all Category III treatment information
    await pool.query(
      `UPDATE patients SET
        tt_given = ?,
        tt_dose_ml = ?,
        tt_injection_site = ?,
        tt_date_given = ?,
        tt_given_by = ?,
        tt_route = ?,
        tt_anst_result = ?,
        ats_given = ?,
        ats_dose_ml = ?,
        ats_injection_site = ?,
        ats_date_given = ?,
        ats_given_by = ?,
        ats_route = ?,
        ats_anst_result = ?,
        htig_given = ?,
        htig_dose_ml = ?,
        htig_injection_site = ?,
        htig_date_given = ?,
        htig_given_by = ?,
        htig_route = ?,
        htig_anst_result = ?,
        rig_equine_given = ?,
        rig_equirab = ?,
        rig_vinrab = ?,
        rig_equine_up_to_ml = ?,
        rig_equine_anst = ?,
        rig_equine_date = ?,
        rig_equine_given_by = ?,
        rig_human_given = ?,
        rig_berirab = ?,
        rig_human_up_to_ml = ?,
        rig_human_date = ?,
        rig_human_given_by = ?,
        meds_given = ?,
        meds_description = ?
      WHERE patient_id = ?`,
      [
        ttGiven,
        b.tt_dose_ml || null,
        b.tt_injection_site || null,
        b.tt_date_given || null,
        b.tt_given_by || null,
        b.tt_route || null,
        b.tt_anst_result || null,
        atsGiven,
        b.ats_dose_ml || null,
        b.ats_injection_site || null,
        b.ats_date_given || null,
        b.ats_given_by || null,
        b.ats_route || null,
        b.ats_anst_result || null,
        htigGiven,
        b.htig_dose_ml || null,
        b.htig_injection_site || null,
        b.htig_date_given || null,
        b.htig_given_by || null,
        b.htig_route || null,
        b.htig_anst_result || null,
        equineGiven,
        b.rig_equirab ? 1 : 0,
        b.rig_vinrab ? 1 : 0,
        b.rig_equine_up_to_ml || null,
        b.rig_equine_anst || null,
        b.rig_equine_date || null,
        b.rig_equine_given_by || null,
        humanGiven,
        b.rig_berirab ? 1 : 0,
        b.rig_human_up_to_ml || null,
        b.rig_human_date || null,
        b.rig_human_given_by || null,
        medsGiven,
        b.meds_description || null,
        patient_id
      ]
    ).catch(e => {
      console.error('[POST /api/cases] Category III save failed:', e.message);
      throw new Error('Failed to save Category III treatment information');
    });

    console.log(`[POST /api/cases] Category III treatment saved for patient ${patient_id}`);

    // Handle dynamic tetanus and RIG entries if the catalog system is being used
    if (typeof insertDynamicTetanus === 'function') {
      await insertDynamicTetanus(pool, result.episodeId, patient_id, b.dynamic_tetanus).catch(e => {
        console.warn('[POST /api/cases] Dynamic tetanus warning:', e.message);
      });
    }
    if (typeof insertDynamicRig === 'function') {
      await insertDynamicRig(pool, result.episodeId, patient_id, b.dynamic_rig).catch(e => {
        console.warn('[POST /api/cases] Dynamic RIG warning:', e.message);
      });
    }

    // Step 7: Re-fetch full case row (episode joined with exposure)
    const [[caseRow]] = await pool.query(
      `SELECT te.*, pe.date_of_exposure, pe.place_of_exposure, pe.type_of_animal,
              pe.type_of_exposure, pe.site_of_exposure, pe.biting_animal_status, pe.notes
       FROM treatment_episodes te
       LEFT JOIN patient_exposures pe ON pe.exposure_id = te.exposure_id
       WHERE te.episode_id = ? LIMIT 1`,
      [result.episodeId]
    );

    // Step 8: Re-fetch pep_schedule rows for the new episode
    const [pepRows] = await pool.query(
      'SELECT * FROM patient_pep_schedule WHERE episode_id = ? ORDER BY pep_id ASC',
      [result.episodeId]
    );

    // Step 9: Log the activity
    logActivity(req, {
      action: ACTIONS.ADD,
      module: MODULES.PATIENTS,
      reference_id: patient_id,
      description: `New case #${result.caseNumber} created for patient ${generatePatientId(patient_id)}`,
    });

    // Step 10: Return 201 with full case data
    return res.status(201).json({
      success: true,
      case_id: result.episodeId,
      exposure_id: result.exposureId,
      episode_id: result.episodeId,
      case_number: result.caseNumber,
      outcome: result.outcome,
      data: {
        episode: attachDoseMeta(caseRow),
        pep_schedule: pepRows,
      },
    });
  } catch (err) {
    console.error('Create case error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
