const express = require('express');
const router = express.Router();
const pool = require('../config/database').pool;
const { requirePatientAuth } = require('../middleware/patientAuth');
const { generatePatientId } = require('../utils/idFormats');
const { computeTreatmentStatus } = require('../utils/treatmentStatus');
const { loadPortalCase, listPortalCases, todayIso } = require('../utils/patientPortalData');
const { needsPasswordChange } = require('../utils/patientTempPassword');

function daysFromToday(dateStr) {
  if (!dateStr) return null;
  const iso = String(dateStr).slice(0, 10);
  const dueDate = new Date(`${iso}T00:00:00`);
  const t0 = new Date(`${todayIso()}T00:00:00`);
  return Math.round((dueDate - t0) / (1000 * 60 * 60 * 24));
}

router.use(requirePatientAuth);

async function portalCaseOr404(req, res) {
  const requested = req.query.episode_id || req.query.case_id || null;
  const ctx = await loadPortalCase(pool, req.session.patientId, requested);
  if (!ctx) {
    res.status(404).json({ success: false, message: 'Patient not found' });
    return null;
  }
  if (ctx.notFound) {
    res.status(404).json({ success: false, message: 'Case not found' });
    return null;
  }
  return ctx;
}

router.get('/cases', async (req, res) => {
  try {
    const cases = await listPortalCases(pool, req.session.patientId);
    res.json({ success: true, data: cases });
  } catch (err) {
    console.error('Patient cases error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const ctx = await portalCaseOr404(req, res);
    if (!ctx) return;
    const p = ctx.patient;
    let account = {};
    try {
      const [[row]] = await pool.query(
        'SELECT first_login FROM patient_accounts WHERE patient_id = ? LIMIT 1',
        [p.patient_id]
      );
      account = row || {};
    } catch (_) { /* account row is optional */ }
    res.json({
      success: true,
      data: {
        patient_id: p.patient_id,
        registration_number: p.registration_number,
        full_name: p.full_name,
        date_registered: p.date_registered,
        is_temp_password: needsPasswordChange(p, account),
        patient_id_display: generatePatientId(p.patient_id),
      }
    });
  } catch (err) {
    console.error('Patient me error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/dashboard-stats', async (req, res) => {
  try {
    const ctx = await portalCaseOr404(req, res);
    if (!ctx) return;
    const { computed, pepRows, nextPep } = ctx;
    const pepCompleted = pepRows.filter(r => r.date_given).length;
    const pepTotal = pepRows.length || computed.totalDoses || 0;
    const pepPct = pepTotal > 0 ? Math.round((pepCompleted / pepTotal) * 100) : 0;
    const nextLabel = (nextPep && nextPep.day_label) || computed.nextDoseLabel || computed.missedDose;
    const nextDate = (nextPep && nextPep.date_due) || computed.nextSchedule;
    const daysLeft = nextPep ? daysFromToday(nextPep.date_due) : computed.daysRemaining;

    const [notifCount] = await pool.query(
      'SELECT COUNT(*) as unread FROM patient_notifications WHERE patient_id = ? AND is_read = 0',
      [req.session.patientId]
    );

    res.json({
      success: true,
      data: {
        current_dose: nextLabel,
        treatment_status: computed.treatmentStatus,
        completed_percent: computed.completionPct,
        pep_completed_percent: pepPct,
        completed_doses: computed.completedDoses,
        total_doses: computed.totalDoses,
        remaining_doses: Math.max(0, (computed.totalDoses || 0) - (computed.completedDoses || 0)),
        next_dose_label: nextLabel,
        upcoming_schedule: nextDate,
        days_remaining: daysLeft,
        missed_dose: computed.missedDose,
        missed_doses: ctx.missedDoses,
        schedule_suspended: computed.scheduleSuspended,
        interrupted_warning: computed.treatmentStatus === 'Incomplete' || computed.treatmentStatus === 'Treatment Interrupted'
          ? 'Your treatment has been marked incomplete because a scheduled dose was missed. Please return to HOPECARE Animal Bite Center for assessment and updated vaccination instructions.'
          : null,
        unread_notifications: notifCount[0]?.unread || 0,
        episode_id: ctx.episodeId,
        exposure_id: ctx.exposureId,
        case_number: ctx.selectedCase ? ctx.selectedCase.case_number : null,
        is_current_case: !!ctx.isCurrent,
        cases: ctx.cases || [],
      }
    });
  } catch (err) {
    console.error('Patient dashboard-stats error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/prep', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM patient_prep_schedule WHERE patient_id = ? ORDER BY prep_id ASC',
      [req.session.patientId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Patient prep error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/pep', async (req, res) => {
  try {
    const ctx = await portalCaseOr404(req, res);
    if (!ctx) return;
    res.json({ success: true, data: ctx.pepRows });
  } catch (err) {
    console.error('Patient pep error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/booster', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM patient_booster_schedule WHERE patient_id = ? ORDER BY booster_id ASC',
      [req.session.patientId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Patient booster error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/exposure-details', async (req, res) => {
  try {
    const ctx = await portalCaseOr404(req, res);
    if (!ctx) return;
    const p = ctx.patient;
    res.json({
      success: true,
      data: {
        patient_id: p.patient_id,
        registration_number: p.registration_number,
        full_name: p.full_name,
        date_of_exposure: p.date_of_exposure,
        place_of_exposure: p.place_of_exposure,
        region_of_exposure: p.region_of_exposure,
        type_of_animal: p.type_of_animal,
        type_of_exposure: p.type_of_exposure,
        nature_of_exposure: p.nature_of_exposure,
        site_of_exposure: p.site_of_exposure,
        category: p.category,
        washing_of_bite: p.washing_of_bite,
        biting_animal_status: p.biting_animal_status,
        condition_of_animal: p.condition_of_animal,
        signs_symptoms: p.signs_symptoms,
        remarks: p.remarks,
        current_case_number: p.current_case_number || null,
        episode_id: ctx.episodeId,
        exposure_id: ctx.exposureId,
        barangay: p.barangay || null,
        is_current_case: !!ctx.isCurrent,
      }
    });
  } catch (err) {
    console.error('Patient exposure-details error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/vaccine-used', async (req, res) => {
  try {
    const ctx = await portalCaseOr404(req, res);
    if (!ctx) return;
    const p = ctx.patient;
    const pepRows = ctx.pepRows;

    res.json({
      success: true,
      data: {
        anti_rabies: {
          brand_name: p.brand_name,
          route: p.route,
          rig_date_given: p.rig_date_given,
          pvrv_brand: ctx.arvClass === 'PVRV' ? p.brand_name : null,
          pcec_brand: ctx.arvClass === 'PCEC' ? p.brand_name : null,
          arv_class: ctx.arvClass,
          dose_ml: (ctx.vaccineMeta && ctx.vaccineMeta.default_dose_ml) || null,
          doses: pepRows.filter(r => r.date_given).map(r => ({
            day_label: r.day_label,
            date_given: r.date_given,
            vaccine_brand: r.vaccine_brand || p.brand_name,
            route: r.route || p.route,
            site_right: r.site_right,
            site_left: r.site_left,
            vaccinated_by: r.vaccinated_by,
          })),
        },
        rabies_ig: ctx.rig,
      }
    });
  } catch (err) {
    console.error('Patient vaccine-used error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/tetanus', async (req, res) => {
  try {
    const ctx = await portalCaseOr404(req, res);
    if (!ctx) return;
    res.json({ success: true, data: ctx.tetanus });
  } catch (err) {
    console.error('Patient tetanus error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/treatment-progress', async (req, res) => {
  try {
    const ctx = await portalCaseOr404(req, res);
    if (!ctx) return;
    const { computed, pepRows, patient, nextPep } = ctx;
    const remaining = Math.max(0, (computed.totalDoses || 0) - (computed.completedDoses || 0));
    const nextDate = (nextPep && nextPep.date_due) || computed.nextSchedule;
    const nextLabel = (nextPep && nextPep.day_label) || computed.nextDoseLabel;

    res.json({
      success: true,
      data: {
        treatment_status: computed.treatmentStatus,
        completion_percent: computed.completionPct,
        completed_doses: computed.completedDoses,
        total_doses: computed.totalDoses,
        remaining_doses: remaining,
        missed_doses: ctx.missedDoses,
        next_dose: nextLabel
          ? { label: nextLabel, date: nextDate, days_remaining: nextPep ? daysFromToday(nextPep.date_due) : computed.daysRemaining }
          : null,
        outcome: patient.outcome,
        pep_schedule: pepRows,
        episode_id: ctx.episodeId,
        case_number: ctx.selectedCase ? ctx.selectedCase.case_number : null,
        is_current_case: !!ctx.isCurrent,
      }
    });
  } catch (err) {
    console.error('Patient treatment-progress error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/upcoming', async (req, res) => {
  try {
    const ctx = await portalCaseOr404(req, res);
    if (!ctx) return;
    const today = todayIso();

    const incomplete = ctx.computed.treatmentStatus === 'Incomplete' || ctx.computed.treatmentStatus === 'Treatment Interrupted';
    const pepRows = ctx.pepRows
      .filter(r => !r.date_given && r.date_due && !['Missed', 'Stopped', 'Cancelled'].includes(r.status) && !incomplete)
      .map(r => ({
        id: r.pep_id || r.day_label,
        day_label: r.day_label,
        date_due: r.date_due,
        date_given: r.date_given,
        vaccine_brand: r.vaccine_brand,
        route: r.route,
        schedule_type: 'PEP',
        status: r.status,
        episode_id: ctx.episodeId,
      }));

    const allUpcoming = pepRows.sort((a, b) => new Date(a.date_due) - new Date(b.date_due));

    allUpcoming.forEach(item => {
      const dueDate = new Date(`${item.date_due}T00:00:00`);
      const t0 = new Date(`${today}T00:00:00`);
      const diff = Math.round((dueDate - t0) / (1000 * 60 * 60 * 24));
      item.days_remaining = diff;
      if (diff < 0) item.status = 'Overdue';
      else if (diff === 0) item.status = 'Due Today';
      else if (diff === 1) item.status = 'Due Tomorrow';
      else item.status = 'Upcoming';
    });

    res.json({ success: true, data: allUpcoming });
  } catch (err) {
    console.error('Patient upcoming error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/profile', async (req, res) => {
  try {
    const ctx = await portalCaseOr404(req, res);
    if (!ctx) return;
    const p = ctx.patient;
    res.json({
      success: true,
      data: {
        patient_id: p.patient_id,
        registration_number: p.registration_number,
        full_name: p.full_name,
        age: p.age,
        sex: p.sex,
        contact_number: p.contact_number,
        address: p.address,
        date_registered: p.date_registered,
        patient_id_display: generatePatientId(p.patient_id),
      }
    });
  } catch (err) {
    console.error('Patient profile error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/notifications', async (req, res) => {
  try {
    // Read only. Opening the dashboard or this list must not create a reminder.
    const [rows] = await pool.query(
      `SELECT *, type AS notification_type
       FROM patient_notifications WHERE patient_id = ? ORDER BY created_at DESC, notif_id DESC`,
      [req.session.patientId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Patient notifications error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/notifications/:id/read', async (req, res) => {
  try {
    const patientId = req.session.patientId;
    const notifId = req.params.id;

    const [result] = await pool.query(
      'UPDATE patient_notifications SET is_read = 1 WHERE notif_id = ? AND patient_id = ?',
      [notifId, patientId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    res.json({ success: true, message: 'Notification marked as read' });
  } catch (err) {
    console.error('Patient mark notification read error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/notifications/read-all', async (req, res) => {
  try {
    await pool.query(
      'UPDATE patient_notifications SET is_read = 1 WHERE patient_id = ?',
      [req.session.patientId]
    );
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    console.error('Patient read-all notifications error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/exposures', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM patient_exposures WHERE patient_id = ? ORDER BY exposure_number ASC',
      [req.session.patientId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Patient exposures error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/episodes', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM treatment_episodes WHERE patient_id = ? ORDER BY episode_number ASC',
      [req.session.patientId]
    );
    const enriched = rows.map(ep => ({ ...ep, ...computeTreatmentStatus(ep) }));
    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('Patient episodes error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/episodes/:episodeId/pep', async (req, res) => {
  try {
    const patientId = req.session.patientId;
    const [rows] = await pool.query(
      'SELECT * FROM patient_pep_schedule WHERE patient_id = ? AND episode_id = ? ORDER BY pep_id ASC',
      [patientId, req.params.episodeId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Patient episode pep error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
