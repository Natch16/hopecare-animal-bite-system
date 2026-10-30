const express = require('express');
const router  = express.Router();
const pool    = require('../config/database').pool;
const { requireAuth, getAuditBy } = require('../middleware/auth');
const { logActivity, MODULES, ACTIONS } = require('../utils/activityLogger');
const { ORDER_BY_REGISTRATION } = require('../utils/registrationNumber');
const { generatePatientId, parsePatientIdDisplay } = require('../utils/idFormats');
const { omitCredentialFields } = require('../utils/patientTempPassword');
const { computeTreatmentStatus } = require('../utils/treatmentStatus');
const { overlayPatientListFromDb, attachCurrentCaseFromDb } = require('../utils/patientRecordSync');
const { isIncompleteStatus } = require('../utils/missedDose');
const { localTodayIso, addDaysIso } = require('../utils/dateOnly');

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const { search, filter, vaccine } = req.query;

    const [rawPatients] = await pool.query(`
      SELECT p.*,
             f.followup_id, f.followup_status,
             f.last_contacted, f.staff_name
      FROM patients p
      LEFT JOIN patient_followup f ON p.patient_id = f.patient_id
      ${ORDER_BY_REGISTRATION}
    `);
    const patients = await overlayPatientListFromDb(pool, rawPatients);

    const todayIso   = localTodayIso();
    const weekEndIso = addDaysIso(todayIso, 7);

    let rows = patients.map(p => {
        const computed = computeTreatmentStatus(p);
        return {
          patient_id:       p.patient_id,
          patient_id_display: generatePatientId(p.patient_id),
          registration_number: p.registration_number,
          full_name:        p.full_name,
          age:              p.age,
          sex:              p.sex,
          barangay:         p.barangay,
          address:          p.address,
          contact_number:   p.contact_number,
          type_of_animal:   p.type_of_animal,
          type_of_exposure: p.type_of_exposure,
          category:         p.category,
          site_of_exposure: p.site_of_exposure,
          date_of_exposure: p.date_of_exposure,
          brand_name:       p.brand_name,
          vaccine_d0:       p.vaccine_d0,
          vaccine_d3:       p.vaccine_d3,
          vaccine_d7:       p.vaccine_d7,
          vaccine_d14:      p.vaccine_d14,
          vaccine_d28:      p.vaccine_d28,
          outcome:          p.outcome,
          missed_dose:      p.missed_dose,
          missed_date:      p.missed_date,
          schedule_suspended: p.schedule_suspended,
          interrupted_reviewed: p.interrupted_reviewed,
          interrupted_reason: p.interrupted_reason,
          current_case_id:  p.current_case_id || null,
          current_case_number: p.current_case_number || null,
          treatment_cycle:  p.treatment_cycle || 1,
          followup_status:  p.followup_status || 'Pending',
          last_contacted:   p.last_contacted,
          staff_name:       p.staff_name,
          ...computed,
        };
      });

    if (search) {
      const q = search.toLowerCase();
      const qUpper = search.toUpperCase();
      rows = rows.filter(r => {
        if (qUpper.startsWith('PAT-')) {
          const num = parsePatientIdDisplay(search);
          return num !== null && r.patient_id === num;
        }
        if (qUpper.startsWith('ABC-')) {
          return (r.registration_number || '').toUpperCase().startsWith(qUpper);
        }
        return (
          r.full_name?.toLowerCase().includes(q) ||
          r.contact_number?.toLowerCase().includes(q) ||
          r.barangay?.toLowerCase().includes(q) ||
          (r.patient_id_display || '').toLowerCase().includes(q) ||
          (r.registration_number || '').toLowerCase().includes(q)
        );
      });
    }
    if (filter) {
      if      (filter === 'due-today')    rows = rows.filter(r => r.treatmentStatus === 'Due Today');
      else if (filter === 'due-tomorrow') rows = rows.filter(r => r.treatmentStatus === 'Upcoming' && r.daysRemaining === 1);
      else if (filter === 'overdue' || filter === 'incomplete')
        rows = rows.filter(r => isIncompleteStatus(r.treatmentStatus));
      else if (filter === 'completed')    rows = rows.filter(r => r.treatmentStatus === 'Completed');
      else if (filter === 'ongoing')      rows = rows.filter(r => r.treatmentStatus === 'Ongoing');
      else if (filter === 'interrupted')  rows = rows.filter(r => isIncompleteStatus(r.treatmentStatus));
      else if (filter === 'due-this-week') {
        rows = rows.filter(r => {
          if (!r.nextSchedule) return false;
          const ns = String(r.nextSchedule).slice(0, 10);
          return ns >= todayIso && ns <= weekEndIso;
        });
      }
    }
    if (vaccine) {
      rows = rows.filter(r => r.brand_name?.toLowerCase().includes(vaccine.toLowerCase()));
    }

    const allRows = patients.map(p => computeTreatmentStatus(p));
    const summary = {
      total:     allRows.length,
      dueToday:  allRows.filter(r => r.treatmentStatus === 'Due Today').length,
      dueTomorrow: allRows.filter(r => r.treatmentStatus === 'Upcoming' && r.daysRemaining === 1).length,
      overdue:   allRows.filter(r => isIncompleteStatus(r.treatmentStatus)).length,
      incomplete: allRows.filter(r => isIncompleteStatus(r.treatmentStatus)).length,
      completed: allRows.filter(r => r.treatmentStatus === 'Completed').length,
      ongoing:   allRows.filter(r => r.treatmentStatus === 'Ongoing').length,
      interrupted: allRows.filter(r => isIncompleteStatus(r.treatmentStatus)).length,
      missedToday: allRows.filter(r => isIncompleteStatus(r.treatmentStatus) && r.missedDose).length,
    };

    res.json({ success: true, data: rows, summary });
    logActivity(req, {
      action: ACTIONS.VIEW,
      module: MODULES.MONITORING,
      reference_id: 'monitoring-list',
      description: `Viewed Patient Monitoring list${filter ? ' — filter: ' + filter : ''}${search ? ' — search: ' + search : ''}`,
    });
  } catch (err) {
    console.error('Follow-up list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/interrupted', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.patient_id, p.full_name, p.contact_number, p.registration_number,
             p.missed_dose, p.missed_date, p.brand_name, p.interrupted_reviewed,
             p.interrupted_reason, p.interrupted_reviewed_by, p.interrupted_reviewed_at
      FROM patients p
      WHERE p.treatment_status IN ('Incomplete', 'Treatment Interrupted') OR p.schedule_suspended = 1
      ORDER BY p.missed_date DESC
    `);
    const data = rows.map(r => {
      const computed = computeTreatmentStatus(r);
      return {
        ...r,
        patient_id_display: generatePatientId(r.patient_id),
        days_overdue: computed.daysOverdue || computed.daysDelayed || 0,
        days_delayed: computed.daysDelayed || computed.daysOverdue || 0,
        treatmentStatus: 'Incomplete',
        restartStatus: computed.restartStatus,
        missedDose: computed.missedDose,
        missedDate: computed.missedDate,
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error('Interrupted list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/notifications', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT sn.*, p.full_name, p.contact_number, p.registration_number
      FROM staff_notifications sn
      JOIN patients p ON sn.patient_id = p.patient_id
      WHERE sn.is_read = 0
      ORDER BY sn.created_at DESC LIMIT 50
    `);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Staff notifications error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/notifications/:id/read', async (req, res) => {
  try {
    await pool.query('UPDATE staff_notifications SET is_read = 1 WHERE notif_id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [[patient]] = await pool.query(
      'SELECT * FROM patients WHERE patient_id = ?', [req.params.id]
    );
    if (!patient) return res.status(404).json({ success: false, message: 'Not found' });
    await attachCurrentCaseFromDb(pool, patient);

    const [[followup]] = await pool.query(
      'SELECT * FROM patient_followup WHERE patient_id = ?', [req.params.id]
    );

    // Count automated reminders sent to this patient from vaccination_reminders
    const [[reminderCount]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN reminder_status = 'Sent' THEN 1 ELSE 0 END) AS sent_count,
              MAX(sent_at) AS last_sent_at,
              MAX(reminder_type) AS last_type
       FROM vaccination_reminders WHERE patient_id = ?`,
      [req.params.id]
    ).catch(() => [[{ total: 0, sent_count: 0, last_sent_at: null, last_type: null }]]);

    res.json({
      success: true,
      data: omitCredentialFields({
        ...patient,
        patient_id_display: generatePatientId(patient.patient_id),
        ...computeTreatmentStatus(patient),
        followup_status:      followup?.followup_status  || 'Pending',
        last_contacted:       followup?.last_contacted   || null,
        staff_name:           followup?.staff_name       || '',
        created_by:           followup?.created_by       || null,
        updated_by:           followup?.updated_by       || null,
        followup_attempts:    Number(reminderCount?.sent_count) || 0,
        last_reminder_sent:   reminderCount?.last_sent_at  || null,
        last_reminder_type:   reminderCount?.last_type     || null,
      }),
    });
    logActivity(req, {
      action: ACTIONS.VIEW,
      module: MODULES.MONITORING,
      reference_id: req.params.id,
      description: `Viewed monitoring details for patient #${req.params.id} — ${patient?.full_name || ''}`,
    });
  } catch (err) {
    console.error('Follow-up detail error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/:id/status', async (req, res) => {
  try {
    const { followup_status, staff_name } = req.body;
    const today = new Date().toISOString().slice(0,10);
    const updatedBy = getAuditBy(req);

    const [[patient]] = await pool.query(
      'SELECT full_name, registration_number FROM patients WHERE patient_id = ? LIMIT 1',
      [req.params.id]
    );

    await pool.query(`
      INSERT INTO patient_followup (patient_id, followup_status, last_contacted, staff_name, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        followup_status = VALUES(followup_status),
        last_contacted  = VALUES(last_contacted),
        staff_name      = VALUES(staff_name),
        updated_by      = VALUES(updated_by),
        updated_at      = CURRENT_TIMESTAMP
    `, [req.params.id, followup_status, today, staff_name || null, updatedBy, updatedBy]);

    logActivity(req, {
      action: ACTIONS.UPDATE,
      module: MODULES.MONITORING,
      reference_id: req.params.id,
      description: `Updated follow-up status to "${followup_status}" for patient: ${patient?.full_name || '#' + req.params.id} (${patient?.registration_number || ''})`,
    });

    res.json({ success: true, message: 'Follow-up status updated' });
  } catch (err) {
    console.error('Update status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/:id/review-interrupted', async (req, res) => {
  try {
    const { action, reason, next_schedule, resume } = req.body;
    const patientId = req.params.id;
    const updatedBy = getAuditBy(req);

    const [[patient]] = await pool.query('SELECT * FROM patients WHERE patient_id = ?', [patientId]);
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found' });

    if (action === 'review') {
      await pool.query(
        `UPDATE patients SET interrupted_reviewed = 1, interrupted_reason = ?,
           interrupted_reviewed_by = ?, interrupted_reviewed_at = NOW()
         WHERE patient_id = ?`,
        [reason || null, updatedBy, patientId]
      );
      logActivity(req, {
        action: ACTIONS.REVIEW,
        module: MODULES.MONITORING,
        reference_id: patientId,
        description: `Reviewed interrupted treatment for ${patient.full_name}. Reason: ${reason || 'N/A'}`,
      });
      return res.json({ success: true, message: 'Interrupted treatment marked as reviewed' });
    }

    if (action === 'resume' && resume) {
      return res.status(409).json({
        success: false,
        code: 'RESTART_REQUIRED',
        message: 'A missed-dose schedule cannot be resumed. Confirm a restart from Day 0 on the existing case.',
      });
    }

    if (action === 'reschedule' && next_schedule) {
      await pool.query(
        `UPDATE patients SET next_schedule = ?, reminder_status = 'Pending' WHERE patient_id = ?`,
        [next_schedule, patientId]
      );
      logActivity(req, {
        action: ACTIONS.UPDATE,
        module: MODULES.MONITORING,
        reference_id: patientId,
        description: `Rescheduled next vaccination to ${next_schedule} for ${patient.full_name}`,
      });
      return res.json({ success: true, message: 'Next vaccination rescheduled' });
    }

    res.status(400).json({ success: false, message: 'Invalid review action' });
  } catch (err) {
    console.error('Review interrupted error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/widget/summary', async (req, res) => {
  try {
    const [patients] = await pool.query('SELECT * FROM patients');
    const computed   = patients.map(p => computeTreatmentStatus(p));

    const [recent] = await pool.query(`
      SELECT f.*, p.full_name, p.contact_number
      FROM patient_followup f
      JOIN patients p ON f.patient_id = p.patient_id
      ORDER BY f.updated_at DESC LIMIT 5
    `);

    const [interrupted] = await pool.query(`
      SELECT p.patient_id, p.full_name, p.missed_dose, p.missed_date, p.contact_number
      FROM patients p
      WHERE p.treatment_status IN ('Incomplete', 'Treatment Interrupted') OR p.schedule_suspended = 1
      ORDER BY p.missed_date DESC LIMIT 10
    `);

    res.json({
      success: true,
      data: {
        dueToday:    computed.filter(r => r.treatmentStatus === 'Due Today').length,
        dueTomorrow: computed.filter(r => r.treatmentStatus === 'Upcoming' && r.daysRemaining === 1).length,
        overdue:     computed.filter(r => isIncompleteStatus(r.treatmentStatus)).length,
        incomplete:  computed.filter(r => isIncompleteStatus(r.treatmentStatus)).length,
        interrupted: computed.filter(r => isIncompleteStatus(r.treatmentStatus)).length,
        completed:   computed.filter(r => r.treatmentStatus === 'Completed').length,
        missedToday: computed.filter(r => isIncompleteStatus(r.treatmentStatus)).length,
        recentActivity: recent,
        interruptedPatients: interrupted.map(p => ({
          ...p,
          patient_id_display: generatePatientId(p.patient_id),
          days_overdue: p.missed_date
            ? Math.max(0, Math.round((new Date() - new Date(p.missed_date)) / 86400000))
            : 0,
        })),
      }
    });
  } catch (err) {
    console.error('Widget summary error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
