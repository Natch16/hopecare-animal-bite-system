'use strict';

const { toSqlDate } = require('./dateOnly');
const { firstNameOf, formatDoseLabel, formatSmsDate } = require('./smsTemplates');

/**
 * One portal notification per reminder event.
 * The identity matches the SMS claim: patient, case, dose, scheduled date, reminder type.
 * A missing case is stored as 0 so MySQL does not treat NULL as a new event.
 */
function reminderEventIdentity({
  patientId, episodeId = null, doseLabel = null, scheduledDate = null, relatedDate = null, reminderType = null,
} = {}) {
  const formatted = formatDoseLabel(doseLabel);
  const dose = formatted && formatted !== '—' ? formatted : '';
  const reminder = String(reminderType || '').trim();
  const related = toSqlDate(scheduledDate || relatedDate);
  const patient = Number(patientId);
  const episode = Number(episodeId) || 0;
  if (!patient || !dose || !related || !reminder) {
    return { patientId: patient || 0, episodeId: episode, doseLabel: dose, scheduledDate: related, reminderType: reminder, eventKey: null };
  }
  return {
    patientId: patient,
    episodeId: episode,
    doseLabel: dose,
    scheduledDate: related,
    reminderType: reminder,
    eventKey: `${patient}|${episode}|${dose}|${related}|${reminder}`,
  };
}

function notificationEventKey(event) {
  return reminderEventIdentity(event).eventKey;
}

function vaccinationReminderCopy({ fullName, doseLabel, scheduledDate } = {}) {
  const dose = formatDoseLabel(doseLabel);
  const date = formatSmsDate(toSqlDate(scheduledDate)) || String(scheduledDate || '');
  const name = firstNameOf(fullName);
  return {
    title: 'Vaccination Reminder',
    message: `Hello ${name}, your next vaccination dose (${dose}) is scheduled for ${date}. Please visit HOPECARE Animal Bite Center.`,
  };
}

function restartNotificationCopy(restartDate) {
  const date = formatSmsDate(toSqlDate(restartDate)) || String(restartDate || '');
  return {
    title: 'Vaccination Schedule Restarted',
    message: `Your vaccination schedule has been restarted from Day 0 on ${date}. Please follow your new vaccination schedule from HOPECARE Animal Bite Center.`,
  };
}

function storedEpisodeId(episodeId) {
  const episode = Number(episodeId);
  return episode > 0 ? episode : 0;
}

/**
 * Insert one portal notification for a reminder event.
 * A second insert for the same event is ignored. Reading a notification never calls this.
 */
async function insertPatientNotificationOnce(db, {
  patientId, episodeId = null, type, title, message, relatedDate, doseLabel = null, reminderType = null,
} = {}) {
  const identity = reminderEventIdentity({
    patientId, episodeId, doseLabel, scheduledDate: relatedDate, reminderType,
  });
  const related = identity.scheduledDate;
  const dose = identity.doseLabel || null;
  const reminder = identity.reminderType || null;
  const episode = storedEpisodeId(identity.episodeId);
  const eventKey = identity.eventKey;
  const rawDose = String(doseLabel || '').trim().toLowerCase();

  if (!eventKey) return { created: false, notifId: null, eventKey: null };

  const [existing] = await db.query(
    `SELECT notif_id FROM patient_notifications
      WHERE event_key = ?
         OR (
           patient_id = ?
           AND reminder_type = ?
           AND related_date = ?
           AND (episode_id = ? OR (? = 0 AND (episode_id IS NULL OR episode_id = 0)))
           AND (
             LOWER(TRIM(dose_label)) = LOWER(?)
             OR LOWER(TRIM(dose_label)) = ?
             OR CONCAT('day ', LOWER(TRIM(dose_label))) = LOWER(?)
           )
         )
      LIMIT 1`,
    [eventKey, identity.patientId, reminder, related, episode, episode, dose, rawDose, dose]
  );
  if (existing.length) return { created: false, notifId: existing[0].notif_id, eventKey };

  try {
    const [result] = await db.query(
      `INSERT INTO patient_notifications
         (patient_id, episode_id, type, title, message, related_date, dose_label, reminder_type, event_key)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [patientId, episode, type, title, message, related, dose, reminder, eventKey]
    );
    return { created: true, notifId: result.insertId, eventKey };
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      if (!eventKey) return { created: false, notifId: null };
      const [row] = await db.query(
        'SELECT notif_id FROM patient_notifications WHERE event_key = ? LIMIT 1',
        [eventKey]
      );
      return { created: false, notifId: row[0] ? row[0].notif_id : null, eventKey };
    }
    throw err;
  }
}

/** Portal copy of the same vaccination reminder event used for SMS. */
async function ensureVaccinationNotification(db, {
  patientId, fullName, episodeId = null, doseLabel, scheduledDate, reminderType,
} = {}) {
  const copy = vaccinationReminderCopy({ fullName, doseLabel, scheduledDate });
  return insertPatientNotificationOnce(db, {
    patientId,
    episodeId,
    type: 'UPCOMING_VACCINE',
    title: copy.title,
    message: copy.message,
    relatedDate: scheduledDate,
    doseLabel,
    reminderType,
  });
}

module.exports = {
  reminderEventIdentity,
  notificationEventKey,
  vaccinationReminderCopy,
  restartNotificationCopy,
  insertPatientNotificationOnce,
  ensureVaccinationNotification,
};
