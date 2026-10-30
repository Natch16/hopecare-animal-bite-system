const pool = require('../config/database').pool;
const { localTodayIso, toSqlDate } = require('../utils/dateOnly');
const {
  detectAndMarkEpisode, findMissedDose, dayDiff, PATIENT_MISSED_NOTICE,
} = require('../utils/missedDose');
const { sendDoseReminderSms, followUpReminderForRecord } = require('../utils/smsReminders');
const {
  vaccinationReminderCopy, ensureVaccinationNotification, insertPatientNotificationOnce,
} = require('../utils/patientNotifications');

const REMINDER_TYPES = {
  THREE_DAYS: '3_DAYS_BEFORE',
  ONE_DAY: '1_DAY_BEFORE',
  SAME_DAY: 'SAME_DAY',
};

function buildReminderMessage(patient, doseLabel, scheduledDate) {
  return vaccinationReminderCopy({
    fullName: patient.full_name,
    doseLabel,
    scheduledDate,
  }).message;
}

async function sendPatientReminder(patient, doseLabel, scheduledDate, reminderType, episodeId = null) {
  const scheduled = toSqlDate(scheduledDate);
  const copy = vaccinationReminderCopy({
    fullName: patient.full_name,
    doseLabel,
    scheduledDate: scheduled,
  });
  const [[existing]] = await pool.query(
    `SELECT reminder_id FROM vaccination_reminders
      WHERE patient_id = ? AND dose_label = ? AND reminder_type = ? AND scheduled_date = ?
        AND (episode_id = ? OR episode_id IS NULL OR ? IS NULL)
      LIMIT 1`,
    [patient.patient_id, doseLabel, reminderType, scheduled, episodeId || null, episodeId || null]
  );
  if (!existing) {
    try {
      await pool.query(
        `INSERT INTO vaccination_reminders
           (patient_id, episode_id, dose_label, scheduled_date, reminder_type, reminder_status, message, sent_at)
         VALUES (?, ?, ?, ?, ?, 'Sent', ?, NOW())`,
        [patient.patient_id, episodeId || null, doseLabel, scheduled, reminderType, copy.message]
      );
    } catch (err) {
      if (!err || err.code !== 'ER_DUP_ENTRY') throw err;
    }
  }

  await ensureVaccinationNotification(pool, {
    patientId: patient.patient_id,
    fullName: patient.full_name,
    episodeId: episodeId || null,
    doseLabel,
    scheduledDate: scheduled,
    reminderType,
  });

  await pool.query(
    `UPDATE patients SET reminder_status = 'Sent', reminder_sent_date = CURDATE(), reminder_type = ? WHERE patient_id = ?`,
    [reminderType, patient.patient_id]
  );
}

/** Legacy path: patients with no case/episode rows yet. */
async function markMissedDose(patient, doseLabel, missedDateStr) {
  const [upd] = await pool.query(
    `UPDATE patients SET
       treatment_status = 'Incomplete', outcome = 'Inc',
       missed_dose = ?,
       missed_date = ?,
       schedule_suspended = 1,
       interrupted_status = 1,
       reminder_status = 'Stopped',
       next_schedule = NULL
     WHERE patient_id = ? AND COALESCE(schedule_suspended, 0) = 0`,
    [doseLabel, missedDateStr, patient.patient_id]
  );
  if (!upd.affectedRows) return;

  await pool.query(
    `UPDATE patient_pep_schedule SET status = 'Missed'
     WHERE patient_id = ? AND day_label = ? AND date_given IS NULL`,
    [patient.patient_id, doseLabel]
  );
  await pool.query(
    `UPDATE patient_pep_schedule SET status = 'Stopped'
     WHERE patient_id = ? AND day_label <> ? AND date_given IS NULL`,
    [patient.patient_id, doseLabel]
  );

  await insertPatientNotificationOnce(pool, {
    patientId: patient.patient_id,
    episodeId: null,
    type: 'TREATMENT_INTERRUPTED',
    title: 'Treatment Incomplete',
    message: PATIENT_MISSED_NOTICE,
    relatedDate: missedDateStr,
    doseLabel,
    reminderType: 'MISSED_DOSE',
  });

  await pool.query(
    `INSERT INTO staff_notifications (patient_id, type, title, message, missed_dose, missed_date, days_overdue)
     VALUES (?, 'MISSED_DOSE', 'Treatment Incomplete — Missed Dose', ?, ?, ?, ?)`,
    [
      patient.patient_id,
      `${doseLabel} due ${missedDateStr} was missed. Treatment is incomplete; restart from Day 0 requires nurse confirmation.`,
      doseLabel,
      missedDateStr,
      Math.max(1, dayDiff(missedDateStr, localTodayIso()) || 1),
    ]
  );
}

async function processRemindersAndMissed() {
  const conn = await pool.getConnection();
  try {
    const todayIso = localTodayIso();

    // ── 1. Process active treatment episodes (multi-episode path) ──
    const [activeEpisodes] = await conn.query(`
      SELECT te.*, p.full_name, p.contact_number
      FROM treatment_episodes te
      JOIN patients p ON te.patient_id = p.patient_id
      WHERE te.status NOT IN ('Completed', 'Incomplete', 'Treatment Interrupted')
        AND te.schedule_suspended = 0
        AND (te.vaccine_d0 IS NOT NULL OR te.treatment_cycle > 1)
        AND te.episode_number = (
          SELECT MAX(te2.episode_number) FROM treatment_episodes te2
          WHERE te2.patient_id = te.patient_id
        )
    `);

    for (const ep of activeEpisodes) {
      const marked = await detectAndMarkEpisode(pool, ep, { today: todayIso });
      if (marked.changed) continue;

      const plan = followUpReminderForRecord(ep, todayIso);
      if (!plan.send) continue;
      const next = plan.next;
      await sendPatientReminder(
        { patient_id: ep.patient_id, full_name: ep.full_name, contact_number: ep.contact_number },
        next.label,
        toSqlDate(next.dateDue),
        plan.reminderType,
        ep.episode_id
      );
      try {
        await sendDoseReminderSms(pool, {
          patientId: ep.patient_id,
          reminderType: plan.reminderType,
          doseLabel: next.label,
          scheduledDate: toSqlDate(next.dateDue),
          episodeId: ep.episode_id,
          source: 'system',
        });
      } catch (smsErr) {
        console.error('[ReminderScheduler] SMS:', smsErr.message);
      }
    }

    // ── 2. Legacy: patients without episode records (backward compat) ──
    const [patients] = await conn.query(`
      SELECT p.patient_id, p.full_name, p.contact_number, p.brand_name,
             p.vaccine_d0, p.vaccine_d3, p.vaccine_d7, p.vaccine_d14, p.vaccine_d28,
             p.outcome, p.treatment_status, p.schedule_suspended, p.missed_dose
      FROM patients p
      WHERE p.vaccine_d0 IS NOT NULL
        AND (p.outcome IS NULL OR p.outcome != 'C')
        AND COALESCE(p.schedule_suspended, 0) = 0
        AND COALESCE(p.treatment_status, '') NOT IN ('Treatment Interrupted', 'Incomplete')
        AND NOT EXISTS (
          SELECT 1 FROM treatment_episodes te
          WHERE te.patient_id = p.patient_id
        )
    `);

    for (const patient of patients) {
      const missed = findMissedDose(patient, todayIso);
      if (missed) {
        await markMissedDose(patient, missed.label, missed.due);
        continue;
      }
      const plan = followUpReminderForRecord(patient, todayIso);
      if (!plan.send) continue;
      const next = plan.next;
      await sendPatientReminder(
        patient, next.label,
        toSqlDate(next.dateDue),
        plan.reminderType,
        null
      );
      try {
        await sendDoseReminderSms(pool, {
          patientId: patient.patient_id,
          reminderType: plan.reminderType,
          doseLabel: next.label,
          scheduledDate: toSqlDate(next.dateDue),
          source: 'system',
        });
      } catch (smsErr) {
        console.error('[ReminderScheduler] SMS:', smsErr.message);
      }
    }

    return { success: true, processed: activeEpisodes.length + patients.length };
  } finally {
    conn.release();
  }
}

function startReminderScheduler() {
  const INTERVAL_MS = 60 * 60 * 1000;

  setTimeout(() => {
    processRemindersAndMissed().catch(err => console.error('[ReminderScheduler]', err.message));
  }, 10000);

  setInterval(() => {
    processRemindersAndMissed().catch(err => console.error('[ReminderScheduler]', err.message));
  }, INTERVAL_MS);

  console.log('✅  Follow-up reminder scheduler started (hourly).');
}

module.exports = {
  startReminderScheduler,
  processRemindersAndMissed,
  buildReminderMessage,
  REMINDER_TYPES,
};
