'use strict';

const { normalizePhMobile, maskPhMobile } = require('./phonePh');
const { loadSmsSettings } = require('./smsConfig');
const { sendSms } = require('../services/smsService');
const {
  REMINDER_TYPES, buildSmsMessage, sanitizeSmsMessage,
  generateVaccinationReminderMessage, formatSmsDate, isDoseReminderType, smsForPatient,
  smsContainsCredentials,
} = require('./smsTemplates');
const { generatePatientId } = require('./idFormats');
const { isIncompleteStatus, dayDiff } = require('./missedDose');
const { localTodayIso, toSqlDate } = require('./dateOnly');
const { getNextDueDose, computeTreatmentStatus } = require('./treatmentStatus');
const { ensureVaccinationNotification, reminderEventIdentity } = require('./patientNotifications');

const STOPPED_DOSE = /^(completed|missed|stopped|cancelled|canceled)$/i;
const INACTIVE_ACCOUNT = /^(inactive|locked)$/i;
const NO_VALID_CONTACT = 'Patient has no valid contact number. Please update the patient\'s contact information before sending SMS.';
const ALREADY_SENT_MESSAGE = 'This vaccination reminder has already been sent to the patient. A duplicate SMS will not be sent.';

function messageTypeFor(reminderType, explicit) {
  if (explicit) return explicit;
  if (reminderType === 'MANUAL') return 'MANUAL';
  if (isDoseReminderType(reminderType)) return 'AUTOMATIC_REMINDER';
  return null;
}

function channelMessageType(source) {
  if (source === 'nurse' || source === 'staff') return 'MANUAL';
  if (source === 'system') return 'AUTOMATIC_REMINDER';
  return null;
}

function reminderEventKey(event) {
  const identity = reminderEventIdentity(event);
  return {
    patientId: identity.patientId,
    episodeId: identity.episodeId,
    doseLabel: identity.doseLabel,
    scheduledDate: identity.scheduledDate,
    reminderType: identity.reminderType,
  };
}

function evaluateDoseEligibility({
  treatmentStatus,
  scheduleSuspended,
  doseStatus,
  dateGiven,
  accountStatus,
  isLocked,
  contactNumber,
  today = localTodayIso(),
  scheduledDate,
  skipContact = false,
} = {}) {
  const reasons = [];
  if (/^completed$/i.test(String(treatmentStatus || ''))) {
    reasons.push('Treatment is completed. No further vaccination reminder is due.');
  }
  if (isIncompleteStatus(treatmentStatus) || /schedule stopped/i.test(String(treatmentStatus || ''))) {
    reasons.push('Treatment is incomplete or the original schedule was stopped.');
  }
  if (Number(scheduleSuspended) === 1) {
    reasons.push('The vaccination schedule is suspended.');
  }
  if (dateGiven || STOPPED_DOSE.test(String(doseStatus || ''))) {
    reasons.push('This dose is no longer pending.');
  }
  if (accountStatus && INACTIVE_ACCOUNT.test(accountStatus)) {
    reasons.push('The patient portal account is inactive.');
  }
  if (Number(isLocked) === 1) {
    reasons.push('The patient portal account is locked.');
  }
  if (!skipContact && !normalizePhMobile(contactNumber)) {
    reasons.push('The patient does not have a valid Philippine mobile number.');
  }
  if (scheduledDate && dayDiff(today, String(scheduledDate).slice(0, 10)) < 0) {
    reasons.push('The scheduled date has already passed.');
  }
  return { eligible: reasons.length === 0, reasons };
}

function reminderTypeForDaysBefore(days) {
  if (days === 3) return REMINDER_TYPES.THREE_DAY;
  if (days === 1) return REMINDER_TYPES.ONE_DAY;
  if (days === 0) return REMINDER_TYPES.SAME_DAY;
  return null;
}

async function loadPatientSmsContext(db, patientId) {
  const [[row]] = await db.query(
    `SELECT p.patient_id, p.full_name, p.contact_number,
            COALESCE(te.status, p.treatment_status) AS treatment_status,
            COALESCE(te.schedule_suspended, p.schedule_suspended) AS schedule_suspended,
            te.episode_id AS current_case_id, p.registration_number,
            pa.account_status, pa.is_locked, pa.first_login
       FROM patients p
       LEFT JOIN patient_accounts pa ON pa.patient_id = p.patient_id
       LEFT JOIN treatment_episodes te
         ON te.patient_id = p.patient_id
        AND te.episode_number = (
          SELECT MAX(te2.episode_number) FROM treatment_episodes te2
          WHERE te2.patient_id = p.patient_id
        )
      WHERE p.patient_id = ?
      LIMIT 1`,
    [patientId]
  );
  return row || null;
}

async function findDuplicateDoseSms(db, { patientId, episodeId, reminderType, doseLabel, scheduledDate }) {
  const key = reminderEventKey({ patientId, episodeId, reminderType, doseLabel, scheduledDate });
  const sent = await findSentReminder(db, key);
  return sent;
}

async function findSentReminder(db, key) {
  const [[claim]] = await db.query(
    `SELECT claim_id, status, source FROM sms_reminder_claims
      WHERE patient_id = ? AND episode_id = ? AND dose_label = ? AND scheduled_date = ? AND reminder_type = ?
        AND status = 'Sent'
      LIMIT 1`,
    [key.patientId, key.episodeId, key.doseLabel, key.scheduledDate, key.reminderType]
  );
  if (claim) return { sms_log_id: null, status: 'Sent', source: claim.source || null, claim_id: claim.claim_id };

  const [[row]] = await db.query(
    `SELECT sms_log_id, status, source FROM sms_logs
      WHERE patient_id = ? AND reminder_type = ? AND dose_label = ? AND scheduled_date = ?
        AND status = 'Sent'
        AND (
          (? = 0 AND (episode_id IS NULL OR episode_id = 0))
          OR episode_id = ?
        )
      ORDER BY created_at DESC
      LIMIT 1`,
    [key.patientId, key.reminderType, key.doseLabel, key.scheduledDate, key.episodeId, key.episodeId]
  );
  return row || null;
}

async function ensureSentClaim(db, key, sent) {
  await db.query(
    `INSERT INTO sms_reminder_claims
       (patient_id, episode_id, dose_label, scheduled_date, reminder_type, status, source, sms_log_id, sent_at)
     VALUES (?, ?, ?, ?, ?, 'Sent', ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       status = IF(status = 'Sending', status, 'Sent'),
       sms_log_id = COALESCE(sms_log_id, VALUES(sms_log_id)),
       sent_at = COALESCE(sent_at, NOW())`,
    [key.patientId, key.episodeId, key.doseLabel, key.scheduledDate, key.reminderType, sent.source || null, sent.sms_log_id || null]
  );
}

async function claimReminderEvent(db, event) {
  const key = reminderEventKey(event);
  const sent = await findSentReminder(db, key);
  if (sent) {
    await ensureSentClaim(db, key, sent);
    return { claimed: false, duplicate: true, status: 'Sent', reason: ALREADY_SENT_MESSAGE, key };
  }
  try {
    const [result] = await db.query(
      `INSERT INTO sms_reminder_claims
         (patient_id, episode_id, dose_label, scheduled_date, reminder_type, status, source, staff_id, claimed_at)
       VALUES (?, ?, ?, ?, ?, 'Sending', ?, ?, NOW())`,
      [key.patientId, key.episodeId, key.doseLabel, key.scheduledDate, key.reminderType, event.source || null, event.staffId || null]
    );
    return { claimed: true, claimId: result.insertId, key };
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
  }
  const [updated] = await db.query(
    `UPDATE sms_reminder_claims
        SET status = 'Sending', source = ?, staff_id = ?, error_message = NULL, claimed_at = NOW()
      WHERE patient_id = ? AND episode_id = ? AND dose_label = ? AND scheduled_date = ? AND reminder_type = ?
        AND (
          status = 'Failed'
          OR (status = 'Sending' AND claimed_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE))
        )`,
    [event.source || null, event.staffId || null, key.patientId, key.episodeId, key.doseLabel, key.scheduledDate, key.reminderType]
  );
  if (updated.affectedRows === 1) {
    const [[row]] = await db.query(
      `SELECT claim_id FROM sms_reminder_claims
        WHERE patient_id = ? AND episode_id = ? AND dose_label = ? AND scheduled_date = ? AND reminder_type = ?
        LIMIT 1`,
      [key.patientId, key.episodeId, key.doseLabel, key.scheduledDate, key.reminderType]
    );
    return { claimed: true, claimId: row.claim_id, retry: true, key };
  }
  const [[row]] = await db.query(
    `SELECT status, source FROM sms_reminder_claims
      WHERE patient_id = ? AND episode_id = ? AND dose_label = ? AND scheduled_date = ? AND reminder_type = ?
      LIMIT 1`,
    [key.patientId, key.episodeId, key.doseLabel, key.scheduledDate, key.reminderType]
  );
  if (row && row.status === 'Sent') {
    return { claimed: false, duplicate: true, status: 'Sent', reason: ALREADY_SENT_MESSAGE, key };
  }
  return {
    claimed: false,
    duplicate: true,
    status: row ? row.status : 'Sending',
    reason: 'This vaccination reminder is already being sent.',
    key,
  };
}

async function finishReminderClaim(db, claimId, { status, smsLogId, error }) {
  if (!claimId) return;
  await db.query(
    `UPDATE sms_reminder_claims
        SET status = ?, sms_log_id = ?, error_message = ?, sent_at = IF(? = 'Sent', NOW(), sent_at)
      WHERE claim_id = ? AND status = 'Sending'`,
    [status, smsLogId || null, error || null, status, claimId]
  );
}

function smsLogParams(row) {
  return [
    row.patient_id, row.episode_id || null, row.pep_schedule_id || null,
    row.dose_label || null, row.scheduled_date || null, row.reminder_type,
    messageTypeFor(row.reminder_type, row.message_type),
    row.phone_masked, row.message_ref, row.status, row.api_status || null,
    row.error_message || null, row.provider_message_id || row.philsms_message_id || null,
    row.provider || 'iprog', row.provider_message_id || row.philsms_message_id || null,
    row.source || 'system', row.staff_id || null, row.attempt_count || 1,
    row.sent_at || null,
  ];
}

async function insertSmsLog(db, row) {
  // sms_logs.philsms_message_id is a legacy column kept for historical rows.
  // New IPROG message IDs are also stored in provider_message_id.
  const params = smsLogParams(row);
  try {
    const [result] = await db.query(
      `INSERT INTO sms_logs
         (patient_id, episode_id, pep_schedule_id, dose_label, scheduled_date, reminder_type,
          message_type, phone_masked, message_ref, status, api_status, error_message, philsms_message_id,
          provider, provider_message_id, source, staff_id, attempt_count, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params
    );
    return result.insertId;
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    const [[existing]] = await db.query(
      `SELECT sms_log_id, status FROM sms_logs
        WHERE patient_id = ? AND reminder_type = ? AND dose_label = ? AND scheduled_date = ?
          AND ((? IS NULL AND episode_id IS NULL) OR episode_id = ? OR episode_id IS NULL)
        ORDER BY sms_log_id DESC
        LIMIT 1`,
      [row.patient_id, row.reminder_type, row.dose_label || null, row.scheduled_date || null, row.episode_id || null, row.episode_id || null]
    );
    if (!existing || existing.status === 'Sent') {
      const dup = new Error(ALREADY_SENT_MESSAGE);
      dup.code = 'ALREADY_SENT';
      throw dup;
    }
    await db.query(
      `UPDATE sms_logs
          SET episode_id = ?, message_type = ?, phone_masked = ?, message_ref = ?, status = 'Pending',
              api_status = NULL, error_message = NULL, provider = ?, source = ?, staff_id = ?,
              attempt_count = attempt_count + 1, sent_at = NULL
        WHERE sms_log_id = ? AND status <> 'Sent'`,
      [
        row.episode_id || null,
        messageTypeFor(row.reminder_type, row.message_type),
        row.phone_masked,
        row.message_ref,
        row.provider || 'iprog',
        row.source || 'system',
        row.staff_id || null,
        existing.sms_log_id,
      ]
    );
    return existing.sms_log_id;
  }
}

async function updateSmsLog(db, smsLogId, patch) {
  const fields = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    params.push(v);
  }
  if (!fields.length) return;
  params.push(smsLogId);
  await db.query(`UPDATE sms_logs SET ${fields.join(', ')} WHERE sms_log_id = ?`, params);
}

async function previewSms(db, {
  patientId, reminderType, doseDay, scheduledDate,
}) {
  const patient = await loadPatientSmsContext(db, patientId);
  if (!patient) return { ok: false, message: 'Patient not found.' };
  if (!isDoseReminderType(reminderType)) {
    return { ok: false, message: 'SMS preview is only available for vaccination reminders.' };
  }

  const cfg = await loadSmsSettings(db);
  const built = buildSmsMessage(reminderType, {
    fullName: patient.full_name,
    patientIdDisplay: generatePatientId(patient.patient_id),
    portalUrl: cfg.portalUrl,
    clinicContact: cfg.clinicContact,
    tempPassword: null,
    doseDay,
    scheduledDate,
  });

  const phone = normalizePhMobile(patient.contact_number);
  return {
    ok: true,
    reminder_type: reminderType,
    patient_id: patient.patient_id,
    patient_id_display: generatePatientId(patient.patient_id),
    patient_name: patient.full_name,
    phone_masked: maskPhMobile(patient.contact_number),
    phone_valid: Boolean(phone),
    dose_day: doseDay || null,
    scheduled_date: scheduledDate || null,
    message: built.message,
    contains_temp_password: false,
    chars: built.chars,
    segments: built.segments,
    multi_segment: built.multiSegment,
    warning: built.warning,
    concise_message: null,
    concise_used: false,
    sms_enabled: cfg.enabled,
  };
}

async function dispatchAndLog(db, {
  patient, reminderType, messageType, message, tempPassword, doseLabel, scheduledDate,
  episodeId, pepScheduleId, source, staffId,
}) {
  const phone = normalizePhMobile(patient.contact_number);
  const outgoing = smsForPatient(message, patient && patient.full_name);
  if (tempPassword) {
    return {
      ok: false,
      skipped: true,
      status: 'Skipped',
      reason: 'SMS cannot include a temporary password or login credentials.',
    };
  }
  if (smsContainsCredentials(message) || smsContainsCredentials(outgoing)) {
    return {
      ok: false,
      skipped: true,
      status: 'Skipped',
      reason: 'SMS cannot include a temporary password or login credentials.',
    };
  }
  const logId = await insertSmsLog(db, {
    patient_id: patient.patient_id,
    episode_id: episodeId,
    pep_schedule_id: pepScheduleId,
    dose_label: doseLabel,
    scheduled_date: scheduledDate,
    reminder_type: reminderType,
    message_type: messageType,
    phone_masked: maskPhMobile(patient.contact_number),
    message_ref: sanitizeSmsMessage(outgoing, tempPassword),
    status: 'Pending',
    source,
    staff_id: staffId,
  });

  if (!outgoing) {
    const reason = 'The SMS did not match this patient and was not sent.';
    await updateSmsLog(db, logId, {
      status: 'Failed',
      error_message: reason,
      provider: 'iprog',
    });
    return {
      ok: false,
      skipped: true,
      status: 'Failed',
      sms_log_id: logId,
      reason,
      provider: 'iprog',
    };
  }

  let result;
  try {
    result = await sendSms(db, { recipient: phone, message: outgoing, patientName: patient.full_name });
  } catch (err) {
    result = { ok: false, skipped: false, status: 'Failed', reason: 'Could not reach IPROG SMS.', provider: 'iprog' };
  }
  const status = result.skipped ? 'Skipped' : (result.status || 'Failed');
  await updateSmsLog(db, logId, {
    status,
    api_status: result.apiStatus || null,
    error_message: result.reason || null,
    philsms_message_id: result.messageId || null,
    provider: result.provider || 'iprog',
    provider_message_id: result.messageId || null,
    sent_at: result.ok ? new Date() : null,
  });

  return {
    ok: Boolean(result.ok),
    skipped: Boolean(result.skipped),
    status,
    sms_log_id: logId,
    reason: result.reason || null,
    provider: result.provider || 'iprog',
    provider_message_id: result.messageId || null,
    philsms_message_id: result.messageId || null,
  };
}

async function sendAccountAccessSms() {
  return {
    ok: false,
    skipped: true,
    status: 'Skipped',
    reason: 'Temporary passwords are printed on the Patient Card and are never sent by SMS.',
  };
}

async function sendDoseReminderSms(db, {
  patientId, reminderType, doseLabel, scheduledDate,
  episodeId = null, pepScheduleId = null, doseStatus = 'Pending', dateGiven = null,
  source = 'system', staffId = null,
} = {}) {
  const patient = await loadPatientSmsContext(db, patientId);
  if (!patient) return { ok: false, status: 'Failed', reason: 'Patient not found.' };
  if (!isDoseReminderType(reminderType)) {
    return { ok: false, skipped: true, status: 'Skipped', reason: 'The next dose is not in a reminder window yet.' };
  }

  const reminderGate = {
    treatmentStatus: patient.treatment_status,
    scheduleSuspended: patient.schedule_suspended,
    doseStatus,
    dateGiven,
    accountStatus: patient.account_status,
    isLocked: patient.is_locked,
    scheduledDate,
  };
  const portalGate = evaluateDoseEligibility({ ...reminderGate, skipContact: true });
  if (portalGate.eligible) {
    await ensureVaccinationNotification(db, {
      patientId,
      fullName: patient.full_name,
      episodeId: episodeId || patient.current_case_id,
      doseLabel,
      scheduledDate,
      reminderType,
    });
  }

  const check = evaluateDoseEligibility({
    ...reminderGate,
    contactNumber: patient.contact_number,
  });
  if (!check.eligible) {
    return { ok: false, skipped: true, status: 'Skipped', reason: check.reasons[0] };
  }

  const claim = await claimReminderEvent(db, {
    patientId, episodeId, reminderType, doseLabel, scheduledDate, source, staffId,
  });
  if (!claim.claimed) {
    return {
      ok: false,
      skipped: true,
      status: 'Skipped',
      duplicate: true,
      reason: claim.reason,
    };
  }

  const message = generateVaccinationReminderMessage(
    patient,
    { episode_id: episodeId },
    { label: doseLabel, scheduledDate, reminderType }
  );

  try {
    const result = await dispatchAndLog(db, {
      patient,
      reminderType,
      messageType: channelMessageType(source),
      message,
      tempPassword: null,
      doseLabel,
      scheduledDate,
      episodeId,
      pepScheduleId,
      source,
      staffId,
    });
    await finishReminderClaim(db, claim.claimId, {
      status: result.ok ? 'Sent' : 'Failed',
      smsLogId: result.sms_log_id,
      error: result.ok ? null : result.reason,
    });
    return result;
  } catch (err) {
    const reason = err.code === 'ALREADY_SENT'
      ? ALREADY_SENT_MESSAGE
      : 'Could not reach IPROG SMS.';
    console.error('[SMS] dose reminder:', err.code || 'error');
    await finishReminderClaim(db, claim.claimId, {
      status: 'Failed',
      error: reason,
    });
    return {
      ok: false,
      skipped: err.code === 'ALREADY_SENT',
      duplicate: err.code === 'ALREADY_SENT',
      status: err.code === 'ALREADY_SENT' ? 'Skipped' : 'Failed',
      reason,
    };
  }
}

function followUpReminderForRecord(record, today = localTodayIso()) {
  const computed = computeTreatmentStatus(record, today);
  if (computed.treatmentStatus === 'Incomplete' || computed.scheduleSuspended) {
    return {
      send: false,
      next: null,
      reason: 'Treatment is incomplete or the schedule is stopped.',
    };
  }
  const next = getNextDueDose(record);
  if (!next || !next.dateDue || computed.treatmentStatus === 'Completed') {
    return {
      send: false,
      next: null,
      reason: 'Treatment is completed. No further vaccination reminder is due.',
    };
  }
  const days = dayDiff(today, next.dateDue);
  const reminderType = reminderTypeForDaysBefore(days);
  if (!reminderType) {
    return {
      send: false,
      next,
      reason: 'The next dose is not in a reminder window yet.',
    };
  }
  return { send: true, next, reminderType, days };
}

async function queueFollowUpSmsForEpisode(db, { episodeId, source = 'system', staffId = null } = {}) {
  const [[ep]] = await db.query(
    `SELECT te.*
       FROM treatment_episodes te
      WHERE te.episode_id = ?
      LIMIT 1`,
    [episodeId]
  );
  if (!ep) {
    return { ok: false, skipped: true, status: 'Skipped', reason: 'Episode not found.' };
  }
  const [[latest]] = await db.query(
    `SELECT episode_id FROM treatment_episodes
      WHERE patient_id = ? ORDER BY episode_number DESC LIMIT 1`,
    [ep.patient_id]
  );
  if (latest && Number(latest.episode_id) !== Number(ep.episode_id)) {
    return { ok: false, skipped: true, status: 'Skipped', reason: 'Reminders use the current case only.' };
  }
  const plan = followUpReminderForRecord(ep);
  if (!plan.send) {
    return { ok: false, skipped: true, status: 'Skipped', reason: plan.reason, next: plan.next || null };
  }
  try {
    return await sendDoseReminderSms(db, {
      patientId: ep.patient_id,
      reminderType: plan.reminderType,
      doseLabel: plan.next.label,
      scheduledDate: toSqlDate(plan.next.dateDue),
      episodeId: ep.episode_id,
      source,
      staffId,
    });
  } catch (err) {
    return { ok: false, skipped: false, status: 'Failed', reason: 'Could not reach IPROG SMS.' };
  }
}

async function loadMonitoringPatient(db, patientId) {
  const [[row]] = await db.query(
    `SELECT p.patient_id, p.full_name, p.contact_number, p.brand_name,
            p.treatment_status AS patient_status,
            p.schedule_suspended AS patient_suspended,
            p.category AS patient_category,
            p.vaccine_d0 AS patient_d0, p.vaccine_d3 AS patient_d3,
            p.vaccine_d7 AS patient_d7, p.vaccine_d14 AS patient_d14, p.vaccine_d28 AS patient_d28,
            p.missed_dose AS patient_missed_dose, p.missed_date AS patient_missed_date,
            te.status AS episode_status,
            te.schedule_suspended AS episode_suspended,
            te.treatment_cycle AS episode_cycle,
            te.cycle_started_on AS episode_cycle_started_on,
            te.category AS episode_category,
            te.vaccine_d0 AS episode_d0, te.vaccine_d3 AS episode_d3,
            te.vaccine_d7 AS episode_d7, te.vaccine_d14 AS episode_d14, te.vaccine_d28 AS episode_d28,
            te.missed_dose AS episode_missed_dose, te.missed_date AS episode_missed_date,
            te.episode_id, te.episode_number
       FROM patients p
       LEFT JOIN treatment_episodes te
         ON te.patient_id = p.patient_id
        AND te.episode_number = (
          SELECT MAX(te2.episode_number) FROM treatment_episodes te2
          WHERE te2.patient_id = p.patient_id
        )
      WHERE p.patient_id = ?
      LIMIT 1`,
    [patientId]
  );
  if (!row) return null;
  const patient = {
    patient_id: row.patient_id,
    full_name: row.full_name,
    contact_number: row.contact_number,
    brand_name: row.brand_name,
    current_case_id: row.episode_id || null,
    current_case_number: row.episode_number || null,
  };
  if (row.episode_id) {
    patient.treatment_status = row.episode_status;
    patient.schedule_suspended = row.episode_suspended;
    patient.treatment_cycle = row.episode_cycle;
    patient.cycle_started_on = row.episode_cycle_started_on;
    patient.category = row.episode_category;
    patient.vaccine_d0 = row.episode_d0;
    patient.vaccine_d3 = row.episode_d3;
    patient.vaccine_d7 = row.episode_d7;
    patient.vaccine_d14 = row.episode_d14;
    patient.vaccine_d28 = row.episode_d28;
    patient.missed_dose = row.episode_missed_dose;
    patient.missed_date = row.episode_missed_date;
  } else {
    patient.treatment_status = row.patient_status;
    patient.schedule_suspended = row.patient_suspended;
    patient.treatment_cycle = 1;
    patient.cycle_started_on = null;
    patient.category = row.patient_category;
    patient.vaccine_d0 = row.patient_d0;
    patient.vaccine_d3 = row.patient_d3;
    patient.vaccine_d7 = row.patient_d7;
    patient.vaccine_d14 = row.patient_d14;
    patient.vaccine_d28 = row.patient_d28;
    patient.missed_dose = row.patient_missed_dose;
    patient.missed_date = row.patient_missed_date;
  }
  return patient;
}

function monitoringSnapshot(patient) {
  const computed = computeTreatmentStatus(patient);
  const stopped = isIncompleteStatus(computed.treatmentStatus) || Number(patient.schedule_suspended) === 1;
  const next = stopped ? null : getNextDueDose(patient);
  return {
    treatmentStatus: computed.treatmentStatus,
    next: next && next.dateDue ? next : null,
  };
}

async function manualSmsContext(db, patientId) {
  const patient = await loadMonitoringPatient(db, patientId);
  if (!patient) return null;
  const snap = monitoringSnapshot(patient);
  const phone = normalizePhMobile(patient.contact_number);
  const plan = followUpReminderForRecord(patient);
  const dose = plan.next || snap.next;
  let message = '';
  let alreadySent = false;
  if (plan.send && dose) {
    message = generateVaccinationReminderMessage(
      patient,
      { episode_id: patient.current_case_id },
      { label: dose.label, scheduledDate: dose.dateDue, reminderType: plan.reminderType }
    );
    const sent = await findSentReminder(db, reminderEventKey({
      patientId: patient.patient_id,
      episodeId: patient.current_case_id,
      doseLabel: dose.label,
      scheduledDate: dose.dateDue,
      reminderType: plan.reminderType,
    }));
    alreadySent = Boolean(sent);
  }
  return {
    patient_id: patient.patient_id,
    patient_id_display: generatePatientId(patient.patient_id),
    patient_name: patient.full_name,
    contact_number: String(patient.contact_number || '').trim(),
    phone_valid: Boolean(phone),
    phone_error: phone ? null : NO_VALID_CONTACT,
    current_case_id: patient.current_case_id,
    current_case_label: patient.current_case_number ? `Case #${patient.current_case_number}` : '—',
    treatment_status: snap.treatmentStatus || '—',
    next_dose: dose ? dose.label : '—',
    next_scheduled_date: dose ? toSqlDate(dose.dateDue) : null,
    next_scheduled_label: dose ? formatSmsDate(dose.dateDue) : '—',
    vaccine_brand: patient.brand_name || null,
    reminder_type: plan.reminderType || null,
    already_sent: alreadySent,
    can_send: Boolean(phone && plan.send && !alreadySent),
    block_reason: !phone
      ? NO_VALID_CONTACT
      : (alreadySent ? ALREADY_SENT_MESSAGE : (plan.send ? null : plan.reason)),
    message,
  };
}

async function sendManualSms(db, { patientId, staffId = null } = {}) {
  const patient = await loadMonitoringPatient(db, patientId);
  if (!patient) return { ok: false, status: 'Failed', reason: 'Patient not found.' };
  const phone = normalizePhMobile(patient.contact_number);
  if (!phone) {
    return { ok: false, skipped: true, status: 'Skipped', reason: NO_VALID_CONTACT, code: 'invalid_phone' };
  }
  const plan = followUpReminderForRecord(patient);
  if (!plan.send || !plan.next) {
    return { ok: false, skipped: true, status: 'Skipped', reason: plan.reason || 'The next dose is not in a reminder window yet.' };
  }
  return sendDoseReminderSms(db, {
    patientId: patient.patient_id,
    reminderType: plan.reminderType,
    doseLabel: plan.next.label,
    scheduledDate: toSqlDate(plan.next.dateDue),
    episodeId: patient.current_case_id,
    source: 'nurse',
    staffId,
  });
}

async function listPatientSmsLogs(db, patientId, limit = 20) {
  const [rows] = await db.query(
    `SELECT sms_log_id, patient_id, episode_id, pep_schedule_id, dose_label, scheduled_date,
            reminder_type, message_type, phone_masked, message_ref, status, api_status, error_message,
            philsms_message_id, provider, provider_message_id, source, attempt_count, sent_at, created_at, updated_at
       FROM sms_logs
      WHERE patient_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
    [patientId, Number(limit) || 20]
  );
  return rows;
}

module.exports = {
  REMINDER_TYPES,
  evaluateDoseEligibility,
  reminderTypeForDaysBefore,
  loadPatientSmsContext,
  findDuplicateDoseSms,
  previewSms,
  sendAccountAccessSms,
  sendDoseReminderSms,
  followUpReminderForRecord,
  queueFollowUpSmsForEpisode,
  listPatientSmsLogs,
  manualSmsContext,
  sendManualSms,
  claimReminderEvent,
  NO_VALID_CONTACT,
  ALREADY_SENT_MESSAGE,
};
