'use strict';

const express = require('express');
const router = express.Router();
const pool = require('../config/database').pool;
const { requireAuth, requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../utils/permissions');
const { logActivity, MODULES, ACTIONS } = require('../utils/activityLogger');
const { loadSmsSettings, publicSmsSettings } = require('../utils/smsConfig');
const { sendSms } = require('../services/smsService');
const { normalizePhMobile, maskPhMobile } = require('../utils/phonePh');
const { getNextDueDose, computeTreatmentStatus } = require('../utils/treatmentStatus');
const { localTodayIso, toSqlDate } = require('../utils/dateOnly');
const { reminderTypeForDaysBefore } = require('../utils/smsReminders');
const { dayDiff, isIncompleteStatus } = require('../utils/missedDose');
const {
  REMINDER_TYPES,
  previewSms,
  sendDoseReminderSms,
  listPatientSmsLogs,
  evaluateDoseEligibility,
  manualSmsContext,
  sendManualSms,
  NO_VALID_CONTACT,
} = require('../utils/smsReminders');
const { smsContainsCredentials } = require('../utils/smsTemplates');
const { generatePatientId } = require('../utils/idFormats');

router.use(requireAuth);

function smsHttpResult(res, result, okMessage) {
  if (result && result.ok) {
    return res.json({ success: true, data: result, message: okMessage });
  }
  const code = result && result.skipped ? 409 : 502;
  return res.status(code).json({
    success: false,
    data: result || null,
    message: (result && result.reason) || 'SMS was not sent.',
  });
}

router.get('/settings', requirePermission(PERMISSIONS.SMS_ADMIN), async (req, res) => {
  try {
    const cfg = await loadSmsSettings(pool);
    res.json({ success: true, data: publicSmsSettings(cfg) });
  } catch (err) {
    console.error('[SMS] settings get:', err.message);
    res.status(500).json({ success: false, message: 'Could not load SMS settings.' });
  }
});

router.put('/settings', requirePermission(PERMISSIONS.SMS_ADMIN), async (req, res) => {
  try {
    const enabled = req.body.enabled === true || req.body.enabled === 1 || req.body.enabled === '1';
    const portalUrl = String(req.body.portal_url || '').trim();
    const clinicContact = String(req.body.clinic_contact || '').trim().slice(0, 80);

    await pool.query(
      `INSERT INTO sms_settings (setting_id, enabled, portal_url, clinic_contact)
       VALUES (1, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         enabled = VALUES(enabled),
         portal_url = VALUES(portal_url),
         clinic_contact = VALUES(clinic_contact)`,
      [enabled ? 1 : 0, portalUrl, clinicContact]
    );

    logActivity(req, {
      action: ACTIONS.UPDATE,
      module: MODULES.SMS,
      description: `Updated SMS settings (enabled=${enabled ? 'yes' : 'no'})`,
    });

    const cfg = await loadSmsSettings(pool);
    res.json({ success: true, data: publicSmsSettings(cfg) });
  } catch (err) {
    console.error('[SMS] settings save:', err.message);
    res.status(500).json({ success: false, message: 'Could not save SMS settings.' });
  }
});

router.get('/logs', requirePermission(PERMISSIONS.SMS_ADMIN), async (req, res) => {
  try {
    const { status, reminder_type, search, failed_only } = req.query;
    let sql = `
      SELECT s.sms_log_id, s.patient_id, s.episode_id, s.dose_label, s.scheduled_date,
             s.reminder_type, s.phone_masked, s.message_ref, s.status, s.api_status,
             s.error_message, s.provider, s.provider_message_id, s.philsms_message_id,
             s.source, s.attempt_count, s.sent_at, s.created_at,
             p.full_name
        FROM sms_logs s
        JOIN patients p ON p.patient_id = s.patient_id
       WHERE 1=1`;
    const params = [];
    if (failed_only === '1' || failed_only === 'true') {
      sql += ` AND s.status = 'Failed'`;
    } else if (status) {
      sql += ` AND s.status = ?`;
      params.push(status);
    }
    if (reminder_type) {
      sql += ` AND s.reminder_type = ?`;
      params.push(reminder_type);
    }
    if (search) {
      sql += ` AND (p.full_name LIKE ? OR s.phone_masked LIKE ? OR CONCAT('PAT-', LPAD(s.patient_id, 6, '0')) LIKE ?)`;
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    sql += ` ORDER BY s.created_at DESC LIMIT 200`;
    const [rows] = await pool.query(sql, params);
    res.json({
      success: true,
      data: rows.map(r => ({ ...r, patient_id_display: generatePatientId(r.patient_id) })),
    });
  } catch (err) {
    console.error('[SMS] logs:', err.message);
    res.status(500).json({ success: false, message: 'Could not load SMS logs.' });
  }
});

router.get('/patient/:id/logs', requirePermission(PERMISSIONS.SMS_SEND), async (req, res) => {
  try {
    const rows = await listPatientSmsLogs(pool, req.params.id, 30);
    const [[patient]] = await pool.query(
      `SELECT p.patient_id, p.full_name, p.contact_number, p.category,
              COALESCE(te.status, p.treatment_status) AS treatment_status,
              COALESCE(te.schedule_suspended, p.schedule_suspended) AS schedule_suspended,
              te.treatment_cycle, te.cycle_started_on,
              te.vaccine_d0, te.vaccine_d3, te.vaccine_d7, te.vaccine_d14, te.vaccine_d28,
              te.missed_dose, te.missed_date, te.episode_id AS current_case_id
         FROM patients p
         LEFT JOIN treatment_episodes te
           ON te.patient_id = p.patient_id
          AND te.episode_number = (
            SELECT MAX(te2.episode_number) FROM treatment_episodes te2
            WHERE te2.patient_id = p.patient_id
          )
        WHERE p.patient_id = ? LIMIT 1`,
      [req.params.id]
    );
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found.' });
    const computed = computeTreatmentStatus(patient);
    const incomplete = isIncompleteStatus(computed.treatmentStatus);
    const next = incomplete ? null : getNextDueDose(patient);
    const phoneValid = Boolean(normalizePhMobile(patient.contact_number));
    let blockReason = null;
    if (incomplete) {
      blockReason = computed.missedDose
        ? `This treatment is incomplete because ${computed.missedDose} was missed. An ordinary next-dose reminder cannot be sent.`
        : 'This treatment is incomplete. An ordinary next-dose reminder cannot be sent.';
    } else if (!next || !next.dateDue) {
      blockReason = 'There is no active upcoming dose to remind.';
    } else if (!phoneValid) {
      blockReason = 'A valid Philippine mobile number is required before SMS can be sent.';
    }
    res.json({
      success: true,
      data: rows,
      patient: {
        patient_id: patient.patient_id,
        patient_id_display: generatePatientId(patient.patient_id),
        full_name: patient.full_name,
        phone_masked: maskPhMobile(patient.contact_number),
        phone_valid: phoneValid,
        treatment_status: computed.treatmentStatus,
        missed_dose: computed.missedDose || null,
        next_dose: next,
        block_reason: blockReason,
      },
    });
  } catch (err) {
    console.error('[SMS] patient logs:', err.message);
    res.status(500).json({ success: false, message: 'Could not load SMS status.' });
  }
});

router.post('/preview', requirePermission(PERMISSIONS.SMS_SEND), async (req, res) => {
  try {
    let reminderType = req.body.reminder_type;
    if (!reminderType && req.body.scheduled_date) {
      const days = dayDiff(localTodayIso(), toSqlDate(req.body.scheduled_date));
      reminderType = reminderTypeForDaysBefore(days) || REMINDER_TYPES.SAME_DAY;
    }
    reminderType = reminderType || REMINDER_TYPES.SAME_DAY;
    const result = await previewSms(pool, {
      patientId: req.body.patient_id,
      reminderType,
      doseDay: req.body.dose_label || req.body.dose_day,
      scheduledDate: req.body.scheduled_date,
    });
    if (!result.ok) return res.status(404).json({ success: false, message: result.message });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[SMS] preview:', err.message);
    res.status(500).json({ success: false, message: 'Could not build SMS preview.' });
  }
});

router.post('/manual', requirePermission(PERMISSIONS.SMS_SEND), async (req, res) => {
  try {
    const patientId = req.body.patient_id;
    if (!patientId) return res.status(400).json({ success: false, message: 'Patient ID is required.' });
    const result = await sendManualSms(pool, {
      patientId,
      staffId: req.session?.staffId || null,
    });
    if (result && result.reason === 'Patient not found.') {
      return res.status(404).json({ success: false, message: result.reason });
    }
    logActivity(req, {
      action: ACTIONS.SEND_SMS,
      module: MODULES.SMS,
      reference_id: patientId,
      description: `Manual SMS for patient ${generatePatientId(patientId)} — ${result.status || 'Failed'}`,
      status: result.ok ? 'Success' : 'Failed',
    });
    if (result && result.code === 'invalid_phone') {
      return res.status(400).json({ success: false, message: NO_VALID_CONTACT });
    }
    return smsHttpResult(res, result, 'IPROG SMS accepted this reminder.');
  } catch (err) {
    console.error('[SMS] manual:', err.message);
    res.status(500).json({ success: false, message: 'Could not send the SMS.' });
  }
});

router.get('/manual/:patientId', requirePermission(PERMISSIONS.SMS_SEND), async (req, res) => {
  try {
    const data = await manualSmsContext(pool, req.params.patientId);
    if (!data) return res.status(404).json({ success: false, message: 'Patient not found.' });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[SMS] manual context:', err.message);
    res.status(500).json({ success: false, message: 'Could not load the SMS form.' });
  }
});

router.post('/send', requirePermission(PERMISSIONS.SMS_SEND), async (req, res) => {
  try {
    const patientId = req.body.patient_id;
    if (!patientId) return res.status(400).json({ success: false, message: 'Patient ID is required.' });

    const [[patient]] = await pool.query(
      `SELECT p.*,
              te.status AS episode_status,
              te.schedule_suspended AS episode_suspended,
              te.treatment_cycle AS episode_cycle,
              te.cycle_started_on AS episode_cycle_started_on,
              te.vaccine_d0 AS episode_d0, te.vaccine_d3 AS episode_d3,
              te.vaccine_d7 AS episode_d7, te.vaccine_d14 AS episode_d14, te.vaccine_d28 AS episode_d28,
              te.category AS episode_category, te.missed_dose AS episode_missed_dose,
              te.missed_date AS episode_missed_date, te.episode_id AS episode_id
         FROM patients p
         LEFT JOIN treatment_episodes te
           ON te.patient_id = p.patient_id
          AND te.episode_number = (
            SELECT MAX(te2.episode_number) FROM treatment_episodes te2
            WHERE te2.patient_id = p.patient_id
          )
        WHERE p.patient_id = ? LIMIT 1`,
      [patientId]
    );
    if (!patient) return res.status(404).json({ success: false, message: 'Patient not found.' });
    if (patient.episode_id) {
      patient.treatment_status = patient.episode_status || patient.treatment_status;
      patient.schedule_suspended = patient.episode_suspended;
      patient.treatment_cycle = patient.episode_cycle;
      patient.cycle_started_on = patient.episode_cycle_started_on;
      patient.category = patient.episode_category || patient.category;
      patient.vaccine_d0 = patient.episode_d0;
      patient.vaccine_d3 = patient.episode_d3;
      patient.vaccine_d7 = patient.episode_d7;
      patient.vaccine_d14 = patient.episode_d14;
      patient.vaccine_d28 = patient.episode_d28;
      patient.missed_dose = patient.episode_missed_dose;
      patient.missed_date = patient.episode_missed_date;
      patient.current_case_id = patient.episode_id;
    }

    const computed = computeTreatmentStatus(patient);
    if (isIncompleteStatus(computed.treatmentStatus)) {
      return res.status(409).json({
        success: false,
        message: 'Reminders are stopped because this treatment is incomplete due to a missed dose.',
      });
    }
    const next = getNextDueDose(patient);
    if (!next || !next.dateDue) {
      return res.status(409).json({ success: false, message: 'There is no active upcoming dose to remind.' });
    }

    const today = localTodayIso();
    const days = dayDiff(today, next.dateDue);
    const reminderType = reminderTypeForDaysBefore(days);
    if (!reminderType) {
      return res.status(409).json({
        success: false,
        message: 'The next dose is not in a reminder window yet.',
      });
    }

    const check = evaluateDoseEligibility({
      treatmentStatus: computed.treatmentStatus,
      scheduleSuspended: computed.scheduleSuspended ? 1 : patient.schedule_suspended,
      doseStatus: 'Pending',
      contactNumber: patient.contact_number,
      scheduledDate: next.dateDue,
    });
    if (!check.eligible) {
      return res.status(409).json({ success: false, message: check.reasons[0] });
    }

    const result = await sendDoseReminderSms(pool, {
      patientId,
      reminderType,
      doseLabel: next.label,
      scheduledDate: toSqlDate(next.dateDue),
      episodeId: patient.current_case_id || null,
      source: 'staff',
      staffId: req.session?.staffId || null,
    });

    logActivity(req, {
      action: ACTIONS.SEND_SMS,
      module: MODULES.SMS,
      reference_id: patientId,
      description: `Manual ${reminderType} SMS for ${patient.full_name} (${next.label}) — ${result.status}`,
      status: result.ok ? 'Success' : 'Failed',
    });

    return smsHttpResult(res, result, 'IPROG SMS accepted this reminder.');
  } catch (err) {
    console.error('[SMS] send:', err.message);
    res.status(500).json({ success: false, message: 'Could not send the reminder SMS.' });
  }
});

router.post('/account-access', requirePermission(PERMISSIONS.SMS_SEND), (req, res) => {
  res.status(409).json({
    success: false,
    message: 'Temporary passwords are printed on the Patient Card and are never sent by SMS. SMS is only used for vaccination reminders.',
  });
});

router.post('/test', requirePermission(PERMISSIONS.SMS_ADMIN), async (req, res) => {
  try {
    const recipient = req.body.recipient;
    if (!normalizePhMobile(recipient)) {
      return res.status(400).json({ success: false, message: 'Enter a valid Philippine mobile number.' });
    }
    const customMessage = String(req.body.message || '').trim();
    if (smsContainsCredentials(customMessage)) {
      return res.status(400).json({
        success: false,
        message: 'SMS cannot include a temporary password or login credentials.',
      });
    }
    const result = await sendSms(pool, {
      recipient,
      message: customMessage || `HOPECARE REMIS connectivity check ${new Date().toISOString()}. Do not reply.`,
    });
    const safeTestMessage = String(result.reason || result.status || '').slice(0, 240);
    await pool.query(
      `INSERT INTO sms_settings (setting_id, enabled, last_test_at, last_test_ok, last_test_message)
       VALUES (1, 0, NOW(), ?, ?)
       ON DUPLICATE KEY UPDATE
         last_test_at = NOW(),
         last_test_ok = VALUES(last_test_ok),
         last_test_message = VALUES(last_test_message)`,
      [result.ok ? 1 : 0, safeTestMessage]
    ).catch(() => {});
    logActivity(req, {
      action: ACTIONS.SEND_SMS,
      module: MODULES.SMS,
      description: `Test SMS to ${maskPhMobile(recipient)} — ${result.status}`,
      status: result.ok ? 'Success' : 'Failed',
    });
    if (result && result.ok) {
      return res.json({
        success: true,
        data: {
          ok: true,
          status: result.status,
          delivered: false,
          provider: result.provider || 'iprog',
          provider_message_id: result.messageId || null,
        },
        message: 'SMS sent successfully.',
      });
    }
    return res.status(result && result.skipped ? 409 : 502).json({
      success: false,
      data: {
        ok: false,
        status: result && result.status,
        skipped: Boolean(result && result.skipped),
        provider: (result && result.provider) || 'iprog',
        reason: (result && result.reason) || null,
      },
      message: (result && result.reason) || 'SMS failed to send. Please check the SMS configuration and IPROG response.',
    });
  } catch (err) {
    console.error('[SMS] test:', err.message);
    res.status(500).json({ success: false, message: 'SMS failed to send. Please check the SMS configuration and IPROG response.' });
  }
});

module.exports = router;
