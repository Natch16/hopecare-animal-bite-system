/**
 * Missed-dose and treatment-restart workflow (HOPECARE clinic protocol).
 *
 * A required dose that is not given by its due date makes the treatment
 * Incomplete and stops the schedule. The schedule never resumes from the
 * missed dose: an authorized nurse must confirm a restart, which starts a new
 * treatment cycle from Day 0 on the SAME exposure/case. Prior cycles' dose
 * rows are kept in patient_pep_schedule (by treatment_cycle) and restarts are
 * recorded in treatment_restarts; every transition is written to
 * treatment_status_history.
 */

'use strict';

const { toSqlDate, addDaysIso, localTodayIso } = require('./dateOnly');
const { PEP_DAYS, pepDaysForCategory, hasValue } = require('./patientRecordSync');
const { getCurrentShift } = require('./shiftHelper');
const {
  restartNotificationCopy, insertPatientNotificationOnce,
} = require('./patientNotifications');

const TREATMENT_STATUS = {
  ACTIVE: 'Ongoing',
  COMPLETED: 'Completed',
  INCOMPLETE: 'Incomplete',
};

const DOSE_STATUS = {
  PENDING: 'Pending',
  COMPLETED: 'Completed',
  MISSED: 'Missed',
  STOPPED: 'Stopped',
};

const SCHEDULE_STATUS = {
  ACTIVE: 'Active',
  STOPPED: 'Schedule Stopped',
};

const RESTART_STATUS = {
  REQUIRED: 'Restart Required',
  CONFIRMED: 'Restart Confirmed',
};

const EVENTS = {
  MISSED_DOSE_DETECTED: 'MISSED_DOSE_DETECTED',
  TREATMENT_INCOMPLETE: 'TREATMENT_INCOMPLETE',
  SCHEDULE_STOPPED: 'SCHEDULE_STOPPED',
  PATIENT_RETURNED: 'PATIENT_RETURNED',
  RESTART_CONFIRMED: 'RESTART_CONFIRMED',
  NEW_SCHEDULE_CREATED: 'NEW_SCHEDULE_CREATED',
};

const INCOMPLETE_STATUSES = ['Incomplete', 'Treatment Interrupted'];

const NEWER_CASE_RESTART_MESSAGE =
  'This case cannot be restarted because the patient already has a current active treatment case. The current treatment schedule should be managed under the patient\'s latest active case.';

const PATIENT_MISSED_NOTICE =
  'Your treatment has been marked incomplete because a scheduled dose was missed. '
  + 'Please return to HOPECARE Animal Bite Center for assessment and updated vaccination instructions.';

const RESTART_CONFIRM_TEXT =
  "This patient's treatment is incomplete due to a missed scheduled dose. Confirming this action will stop "
  + 'the previous schedule and create a new vaccination schedule starting from Day 0 according to the '
  + 'clinic-approved protocol.';

const SYSTEM_ACTOR = Object.freeze({
  staffId: 0,
  username: 'system',
  fullName: 'REMIS Scheduler',
  role: 'System',
  ip: null,
  source: 'system',
});

const NOTE_MAX = 1000;

class WorkflowError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isIncompleteStatus(status) {
  return INCOMPLETE_STATUSES.includes(String(status || '').trim());
}

function isEpisodeIncomplete(ep) {
  if (!ep) return false;
  return isIncompleteStatus(ep.status) || isIncompleteStatus(ep.treatment_status) || Number(ep.schedule_suspended) === 1;
}

/** Whole calendar days from `fromIso` to `toIso` (positive when `toIso` is later). */
function dayDiff(fromIso, toIso) {
  const a = toSqlDate(fromIso);
  const b = toSqlDate(toIso);
  if (!a || !b) return null;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

function cycleNumber(ep) {
  const n = Number(ep && ep.treatment_cycle);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/**
 * Day 0 of the current cycle: the actual Day 0 date when given; for a
 * restarted cycle, the confirmed restart date until Day 0 is recorded.
 */
function cycleDayZero(ep) {
  const given = toSqlDate(ep && ep.vaccine_d0);
  if (given) return given;
  return cycleNumber(ep) > 1 ? toSqlDate(ep.cycle_started_on) : null;
}

/** Required doses of the current cycle with due/given dates (date-only strings). */
function scheduleForEpisode(ep) {
  const required = pepDaysForCategory(ep && ep.category);
  const givenD0 = toSqlDate(ep && ep.vaccine_d0);
  const anchor = cycleDayZero(ep || {});
  return PEP_DAYS.filter((d) => required.includes(d.days)).map((d) => {
    const given = toSqlDate(ep && ep[d.key]);
    let due = null;
    if (d.days === 0) due = anchor;
    else if (givenD0) due = addDaysIso(givenD0, d.days);
    return { label: d.label, key: d.key, days: d.days, due, given };
  });
}

/**
 * First required dose that was not given and whose due date has passed
 * (today >= due + 1). One day late already counts as missed.
 */
function findMissedDose(ep, todayIso = localTodayIso()) {
  if (!ep) return null;
  for (const dose of scheduleForEpisode(ep)) {
    if (dose.given || !dose.due) continue;
    const delay = dayDiff(dose.due, todayIso);
    if (delay != null && delay >= 1) {
      return { label: dose.label, key: dose.key, days: dose.days, due: dose.due, daysDelayed: delay };
    }
  }
  return null;
}

function nextDueDose(ep) {
  return scheduleForEpisode(ep).find((d) => !d.given && d.due) || null;
}

function actorFromReq(req) {
  const s = (req && req.session) || {};
  const ip = (req && req.headers && req.headers['x-forwarded-for'])
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
    : (req && (req.socket?.remoteAddress || req.ip)) || null;
  return {
    staffId: s.staffId || null,
    username: s.username || null,
    fullName: s.fullName || s.username || null,
    role: s.role || null,
    ip,
    source: 'staff',
  };
}

async function writeHistory(db, ep, entry, actor) {
  await db.query(
    `INSERT INTO treatment_status_history
       (patient_id, exposure_id, episode_id, treatment_cycle, event, dose_label,
        previous_status, new_status, note, staff_id, staff_name, staff_role, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      ep.patient_id, ep.exposure_id || null, ep.episode_id,
      entry.cycle || cycleNumber(ep), entry.event, entry.dose_label || null,
      entry.previous_status || null, entry.new_status || null, entry.note || null,
      actor.staffId || null, actor.fullName || actor.username || null, actor.role || null,
      actor.source || 'staff',
    ]
  );
}

async function writeActivity(db, actor, { action, module, reference_id, description, old_value, new_value }) {
  await db.query(
    `INSERT INTO activity_logs
       (staff_id, username, full_name, role, action, module, reference_id,
        description, old_value, new_value, status, ip_address, shift)
     VALUES (?,?,?,?,?,?,?,?,?,?,'Success',?,?)`,
    [
      actor.staffId || 0, actor.username || 'system', actor.fullName || null, actor.role || null,
      action, module, String(reference_id ?? ''), description,
      old_value != null ? String(old_value) : null,
      new_value != null ? String(new_value) : null,
      actor.ip || null, getCurrentShift(),
    ]
  );
}

async function isLatestEpisodeFor(db, patientId, episodeId) {
  const [[latest]] = await db.query(
    'SELECT episode_id FROM treatment_episodes WHERE patient_id = ? ORDER BY episode_number DESC LIMIT 1',
    [patientId]
  );
  return !!(latest && Number(latest.episode_id) === Number(episodeId));
}

/** Pending reminders belong to the stopped schedule and must not be sent later. */
async function stopPendingReminders(conn, patientId) {
  await conn.query(
    `UPDATE vaccination_reminders SET reminder_status = 'Stopped'
     WHERE patient_id = ? AND reminder_status = 'Pending'`,
    [patientId]
  );
}

/**
 * Run `fn` inside a transaction when given a pool. When given a connection
 * the caller owns the transaction (lets tests roll everything back).
 */
async function withTransaction(db, fn) {
  if (typeof db.getConnection !== 'function') return fn(db);
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Mark the current cycle Incomplete: dose -> Missed, remaining doses -> Stopped,
 * treatment -> Incomplete, schedule stopped. Idempotent: a second call for an
 * already-incomplete episode changes nothing and writes no audit rows.
 */
async function markEpisodeIncomplete(db, episode, missed, actor = SYSTEM_ACTOR, opts = {}) {
  return withTransaction(db, async (conn) => {
    const [[ep]] = await conn.query(
      'SELECT * FROM treatment_episodes WHERE episode_id = ? LIMIT 1 FOR UPDATE',
      [episode.episode_id]
    );
    if (!ep || isEpisodeIncomplete(ep) || ep.status === TREATMENT_STATUS.COMPLETED) {
      return { changed: false };
    }
    const cycle = cycleNumber(ep);
    const previousStatus = ep.status || TREATMENT_STATUS.ACTIVE;
    const today = opts.today || localTodayIso();
    const daysDelayed = missed.daysDelayed != null ? missed.daysDelayed : dayDiff(missed.due, today);

    const [upd] = await conn.query(
      `UPDATE treatment_episodes SET
         status = 'Incomplete', outcome = 'Inc', date_completed = NULL,
         schedule_suspended = 1, missed_dose = ?, missed_date = ?,
         missed_detected_at = NOW(), schedule_stopped_at = NOW(),
         interrupted_reviewed = 0, interrupted_reason = NULL,
         interrupted_reviewed_by = NULL, interrupted_reviewed_at = NULL
       WHERE episode_id = ? AND schedule_suspended = 0
         AND status NOT IN ('Completed', 'Incomplete', 'Treatment Interrupted')`,
      [missed.label, missed.due, ep.episode_id]
    );
    if (!upd.affectedRows) return { changed: false };

    await conn.query(
      `UPDATE patient_pep_schedule SET status = 'Missed'
       WHERE episode_id = ? AND treatment_cycle = ? AND day_label = ? AND date_given IS NULL`,
      [ep.episode_id, cycle, missed.label]
    );
    const [stopped] = await conn.query(
      `UPDATE patient_pep_schedule SET status = 'Stopped'
       WHERE episode_id = ? AND treatment_cycle = ? AND day_label <> ? AND date_given IS NULL`,
      [ep.episode_id, cycle, missed.label]
    );

    if (await isLatestEpisodeFor(conn, ep.patient_id, ep.episode_id)) {
      await conn.query(
        `UPDATE patients SET
           treatment_status = 'Incomplete', outcome = 'Inc',
           missed_dose = ?, missed_date = ?,
           schedule_suspended = 1, interrupted_status = 1,
           interrupted_reviewed = 0, interrupted_reason = NULL,
           interrupted_reviewed_by = NULL, interrupted_reviewed_at = NULL,
           reminder_status = 'Stopped', next_schedule = NULL
         WHERE patient_id = ?`,
        [missed.label, missed.due, ep.patient_id]
      );
    }
    await stopPendingReminders(conn, ep.patient_id, ep.episode_id);

    const detectedBy = actor.source === 'system' ? 'automatic daily check' : `review by ${actor.fullName || 'staff'}`;
    await writeHistory(conn, ep, {
      cycle, event: EVENTS.MISSED_DOSE_DETECTED, dose_label: missed.label,
      previous_status: DOSE_STATUS.PENDING, new_status: DOSE_STATUS.MISSED,
      note: `${missed.label} was due on ${missed.due} and was not given (${daysDelayed} day(s) delayed; detected by ${detectedBy}).`,
    }, actor);
    await writeHistory(conn, ep, {
      cycle, event: EVENTS.TREATMENT_INCOMPLETE, dose_label: missed.label,
      previous_status: previousStatus, new_status: TREATMENT_STATUS.INCOMPLETE,
      note: 'Treatment marked incomplete because a scheduled dose was missed.',
    }, actor);
    await writeHistory(conn, ep, {
      cycle, event: EVENTS.SCHEDULE_STOPPED,
      previous_status: SCHEDULE_STATUS.ACTIVE, new_status: SCHEDULE_STATUS.STOPPED,
      note: `Original schedule stopped; ${stopped.affectedRows || 0} remaining dose(s) will not be continued.`,
    }, actor);

    await insertPatientNotificationOnce(conn, {
      patientId: ep.patient_id,
      episodeId: ep.episode_id,
      type: 'TREATMENT_INTERRUPTED',
      title: 'Treatment Incomplete',
      message: PATIENT_MISSED_NOTICE,
      relatedDate: missed.due,
      doseLabel: missed.label,
      reminderType: 'MISSED_DOSE',
    });
    await conn.query(
      `INSERT INTO staff_notifications
         (patient_id, episode_id, type, title, message, missed_dose, missed_date, days_overdue)
       VALUES (?, ?, 'MISSED_DOSE', 'Treatment Incomplete — Missed Dose', ?, ?, ?, ?)`,
      [
        ep.patient_id, ep.episode_id,
        `Case #${ep.episode_number}: ${missed.label} due ${missed.due} was missed. Treatment is incomplete; restart from Day 0 requires nurse confirmation.`,
        missed.label, missed.due, daysDelayed,
      ]
    );
    await writeActivity(conn, actor, {
      action: 'Missed Dose Detected',
      module: 'Patient Monitoring',
      reference_id: ep.patient_id,
      description: `Treatment marked Incomplete — Case #${ep.episode_number}, cycle ${cycle}: ${missed.label} due ${missed.due} not given (${daysDelayed} day(s) delayed). Schedule stopped.`,
      old_value: previousStatus,
      new_value: TREATMENT_STATUS.INCOMPLETE,
    });

    return { changed: true, episodeId: ep.episode_id, missed: { ...missed, daysDelayed } };
  });
}

/** Detect a missed dose for one episode and mark it Incomplete if found. */
async function detectAndMarkEpisode(db, episode, { actor = SYSTEM_ACTOR, today = localTodayIso() } = {}) {
  if (!episode || isEpisodeIncomplete(episode) || episode.status === TREATMENT_STATUS.COMPLETED) {
    return { changed: false };
  }
  const missed = findMissedDose(episode, today);
  if (!missed) return { changed: false };
  return markEpisodeIncomplete(db, episode, missed, actor, { today });
}

/** Detect missed doses for every active episode of a patient (on-read safety net). */
async function detectForPatient(db, patientId, opts = {}) {
  const [episodes] = await db.query(
    `SELECT * FROM treatment_episodes
     WHERE patient_id = ? AND schedule_suspended = 0
       AND status NOT IN ('Completed', 'Incomplete', 'Treatment Interrupted')`,
    [patientId]
  );
  let changed = 0;
  for (const ep of episodes) {
    const r = await detectAndMarkEpisode(db, ep, opts);
    if (r.changed) changed += 1;
  }
  return changed;
}

function doseKeysChanged(before, after) {
  return PEP_DAYS
    .filter((d) => Object.prototype.hasOwnProperty.call(after || {}, d.key))
    .filter((d) => toSqlDate(before && before[d.key]) !== toSqlDate(after[d.key]))
    .map((d) => d.key);
}

/**
 * Server-side guard for any write that sets dose dates on an episode.
 * - Incomplete/stopped schedules accept no dose changes (restart first).
 * - A dose already overdue marks the treatment Incomplete and is rejected.
 * - A dose dated after its due date cannot continue the schedule.
 */
async function assertDoseEntryAllowed(db, episode, incoming, { actor, today = localTodayIso() } = {}) {
  if (!episode) return;
  const changed = doseKeysChanged(episode, incoming);
  if (!changed.length) return;

  if (isEpisodeIncomplete(episode)) {
    throw new WorkflowError(409, 'TREATMENT_INCOMPLETE',
      'This treatment is incomplete because a scheduled dose was missed. The original schedule is stopped; '
      + 'confirm a restart from Day 0 before recording new doses.');
  }

  const merged = { ...episode };
  for (const k of changed) merged[k] = toSqlDate(incoming[k]);

  const after = scheduleForEpisode(merged);
  for (const key of changed) {
    const dose = after.find((d) => d.key === key);
    if (!dose || !dose.given) continue;
    const due = key === 'vaccine_d0'
      ? (cycleNumber(episode) > 1 ? toSqlDate(episode.cycle_started_on) : null)
      : dose.due;
    if (due && dayDiff(due, dose.given) >= 1) {
      await detectAndMarkEpisode(db, episode, { actor, today });
      throw new WorkflowError(409, 'DOSE_LATE',
        `${dose.label} was due on ${due}. A dose given after its scheduled date cannot continue the schedule; `
        + 'the treatment is incomplete and must restart from Day 0 after nurse confirmation.');
    }
  }

  // Only block when an EARLIER required dose is already missed. Later pending
  // doses may look overdue after a historical Day 0 is saved; those are marked
  // Incomplete by the scheduler, not by this write.
  const earliestChangedDay = Math.min(
    ...changed.map((key) => {
      const d = after.find((row) => row.key === key);
      return d ? d.days : 99;
    })
  );
  const stillMissed = findMissedDose(merged, today);
  if (stillMissed && stillMissed.days < earliestChangedDay) {
    await detectAndMarkEpisode(db, episode, { actor, today });
    throw new WorkflowError(409, 'TREATMENT_INCOMPLETE',
      `${stillMissed.label} was due on ${stillMissed.due} and was not given. The treatment is now incomplete; `
      + 'confirm a restart from Day 0 before recording new doses.');
  }
}

function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

/** Pure validation of a restart request body. Returns a list of messages. */
function validateRestartRequest(body, todayIso = localTodayIso()) {
  const errors = [];
  const b = body || {};
  if (!truthy(b.confirm)) {
    errors.push('Check "I confirm this restart according to the clinic-approved protocol" before confirming the restart.');
  }
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length < 5) errors.push('A restart note (at least 5 characters) is required.');
  if (note.length > NOTE_MAX) errors.push(`Restart note must be ${NOTE_MAX} characters or fewer.`);
  const restartDate = hasValue(b.restart_date) ? toSqlDate(b.restart_date) : todayIso;
  if (!restartDate || !/^\d{4}-\d{2}-\d{2}$/.test(restartDate)) errors.push('Restart date is invalid.');
  else if (dayDiff(todayIso, restartDate) > 0) errors.push('Restart date cannot be in the future.');
  const returnedOn = hasValue(b.patient_returned_on) ? toSqlDate(b.patient_returned_on) : restartDate;
  if (!returnedOn) errors.push('Patient return date is invalid.');
  else if (restartDate && dayDiff(returnedOn, restartDate) < 0) errors.push('Restart date cannot be before the patient returned.');
  return { errors, note, restartDate, returnedOn };
}

async function listRestarts(db, episodeId) {
  const [rows] = await db.query(
    `SELECT restart_id, patient_id, exposure_id, episode_id, previous_cycle, new_cycle,
            missed_dose, missed_due_date, missed_detected_at, days_delayed,
            patient_returned_on, patient_requested, restart_date, protocol_days,
            confirmed_by, confirmed_by_role, note, previous_doses, created_at
     FROM treatment_restarts WHERE episode_id = ? ORDER BY previous_cycle ASC`,
    [episodeId]
  );
  return rows.map((r) => {
    let previous = null;
    try { previous = r.previous_doses ? JSON.parse(r.previous_doses) : null; } catch (_) { previous = null; }
    return { ...r, previous_doses: previous };
  });
}

async function listStatusHistory(db, episodeId) {
  const [rows] = await db.query(
    `SELECT history_id, treatment_cycle, event, dose_label, previous_status, new_status,
            note, staff_name, staff_role, source, created_at
     FROM treatment_status_history WHERE episode_id = ? ORDER BY created_at ASC, history_id ASC`,
    [episodeId]
  );
  return rows;
}

/**
 * Confirm a restart: stop the previous cycle, open cycle N+1 with Day 0 due
 * on the restart date, and keep the same exposure/case. Row-locked and
 * guarded by a unique (episode_id, previous_cycle) key, so refreshes and
 * double submits cannot create two restarts.
 */
function isCompletedCase(row) {
  return row && (row.status === TREATMENT_STATUS.COMPLETED || row.outcome === 'C');
}

function caseSequence(row) {
  const episodeNumber = Number(row && row.episode_number);
  if (Number.isFinite(episodeNumber) && episodeNumber > 0) return episodeNumber;
  const exposureNumber = Number(row && row.exposure_number);
  return Number.isFinite(exposureNumber) ? exposureNumber : 0;
}

function caseStartedOn(row) {
  return toSqlDate(row && row.date_started)
    || toSqlDate(row && row.date_of_exposure)
    || toSqlDate(row && row.created_at)
    || '';
}

/** A later case that is still in treatment blocks a restart of an older case. */
async function findBlockingNewerCase(db, episode) {
  if (!episode || !episode.patient_id) return null;
  const [rows] = await db.query(
    `SELECT te.episode_id, te.episode_number, te.status, te.outcome, te.created_at, te.date_started,
            pe.exposure_number, pe.date_of_exposure
       FROM treatment_episodes te
       LEFT JOIN patient_exposures pe ON pe.exposure_id = te.exposure_id
      WHERE te.patient_id = ? AND te.episode_id <> ?`,
    [episode.patient_id, episode.episode_id]
  );
  const mineNum = caseSequence(episode);
  const mineStarted = caseStartedOn(episode);
  return rows.find((row) => {
    const theirNum = caseSequence(row);
    const newer = theirNum > mineNum || (theirNum === mineNum && caseStartedOn(row) > mineStarted);
    return newer && !isCompletedCase(row);
  }) || null;
}

async function restartTreatment(db, { episodeId, patientId, body, actor, today = localTodayIso() }) {
  const { errors, note, restartDate, returnedOn } = validateRestartRequest(body, today);
  if (errors.length) throw new WorkflowError(400, 'INVALID_REQUEST', errors[0]);

  return withTransaction(db, async (conn) => {
    let [[ep]] = await conn.query(
      'SELECT * FROM treatment_episodes WHERE episode_id = ? LIMIT 1 FOR UPDATE',
      [episodeId]
    );
    if (!ep) throw new WorkflowError(404, 'NOT_FOUND', 'Treatment record not found.');
    if (patientId != null && Number(ep.patient_id) !== Number(patientId)) {
      throw new WorkflowError(400, 'PATIENT_MISMATCH', 'This treatment does not belong to the selected patient.');
    }
    const newerCase = await findBlockingNewerCase(conn, ep);
    if (newerCase) {
      throw new WorkflowError(409, 'NEWER_ACTIVE_CASE', NEWER_CASE_RESTART_MESSAGE);
    }
    if (ep.status === TREATMENT_STATUS.COMPLETED) {
      throw new WorkflowError(409, 'COMPLETED', 'A completed treatment cannot be restarted.');
    }

    if (!isEpisodeIncomplete(ep)) {
      const detected = await detectAndMarkEpisode(conn, ep, { actor, today });
      if (detected.changed) {
        [[ep]] = await conn.query('SELECT * FROM treatment_episodes WHERE episode_id = ? LIMIT 1 FOR UPDATE', [episodeId]);
      }
    }
    if (!isEpisodeIncomplete(ep)) {
      const [[prior]] = await conn.query(
        `SELECT restart_date, confirmed_by FROM treatment_restarts
         WHERE episode_id = ? AND new_cycle = ? LIMIT 1`,
        [episodeId, cycleNumber(ep)]
      );
      if (prior) {
        throw new WorkflowError(409, 'ALREADY_RESTARTED',
          `A restart was already confirmed on ${toSqlDate(prior.restart_date)} by ${prior.confirmed_by || 'staff'}.`);
      }
      throw new WorkflowError(409, 'NOT_INCOMPLETE',
        'This treatment is not marked incomplete. A restart is only allowed after a missed scheduled dose.');
    }

    const missedDue = toSqlDate(ep.missed_date);
    if (missedDue && dayDiff(missedDue, returnedOn) < 1) {
      throw new WorkflowError(400, 'INVALID_DATE', `The patient return date must be after the missed dose due date (${missedDue}).`);
    }

    const previousCycle = cycleNumber(ep);
    const newCycle = previousCycle + 1;
    const protocolDays = pepDaysForCategory(ep.category);

    const [oldRows] = await conn.query(
      `SELECT day_label, date_due, date_given, status, vaccine_brand, vaccinated_by
       FROM patient_pep_schedule WHERE episode_id = ? AND treatment_cycle = ? ORDER BY pep_id ASC`,
      [episodeId, previousCycle]
    );
    const snapshot = {
      cycle: previousCycle,
      cycle_started_on: toSqlDate(ep.cycle_started_on) || toSqlDate(ep.date_started),
      doses: PEP_DAYS.reduce((acc, d) => { acc[d.key] = toSqlDate(ep[d.key]); return acc; }, {}),
      schedule: oldRows.map((r) => ({
        day_label: r.day_label,
        date_due: toSqlDate(r.date_due),
        date_given: toSqlDate(r.date_given),
        status: r.status,
        vaccine_brand: r.vaccine_brand || null,
        vaccinated_by: r.vaccinated_by || null,
      })),
    };

    await conn.query(
      `UPDATE patient_pep_schedule SET status = 'Stopped'
       WHERE episode_id = ? AND treatment_cycle = ? AND date_given IS NULL AND status NOT IN ('Missed', 'Stopped')`,
      [episodeId, previousCycle]
    );

    const staffLabel = actor.fullName || actor.username || null;
    const [upd] = await conn.query(
      `UPDATE treatment_episodes SET
         treatment_cycle = ?, cycle_started_on = ?,
         vaccine_d0 = NULL, vaccine_d3 = NULL, vaccine_d7 = NULL, vaccine_d14 = NULL, vaccine_d28 = NULL,
         status = 'Ongoing', outcome = 'Inc', date_completed = NULL,
         schedule_suspended = 0, missed_dose = NULL, missed_date = NULL,
         missed_detected_at = NULL, schedule_stopped_at = NULL,
         interrupted_reviewed = 1, interrupted_reason = ?,
         interrupted_reviewed_by = ?, interrupted_reviewed_at = NOW()
       WHERE episode_id = ? AND treatment_cycle = ? AND schedule_suspended = 1`,
      [newCycle, restartDate, note, staffLabel, episodeId, previousCycle]
    );
    if (!upd.affectedRows) {
      throw new WorkflowError(409, 'ALREADY_RESTARTED', 'This treatment was already restarted.');
    }

    await stopPendingReminders(conn, ep.patient_id, episodeId);

    try {
      await conn.query(
        `INSERT INTO treatment_restarts
           (patient_id, exposure_id, episode_id, previous_cycle, new_cycle,
            missed_dose, missed_due_date, missed_detected_at, days_delayed,
            patient_returned_on, patient_requested, restart_date, protocol_days,
            confirmed_by, confirmed_by_staff_id, confirmed_by_role, note, previous_doses)
         VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)`,
        [
          ep.patient_id, ep.exposure_id || null, episodeId, previousCycle, newCycle,
          ep.missed_dose || null, missedDue, ep.missed_detected_at || null,
          missedDue ? dayDiff(missedDue, returnedOn) : null,
          returnedOn, restartDate, protocolDays.map((d) => `Day ${d}`).join(', '),
          staffLabel, actor.staffId || null, actor.role || null, note, JSON.stringify(snapshot),
        ]
      );
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        throw new WorkflowError(409, 'ALREADY_RESTARTED', 'This treatment was already restarted.');
      }
      throw err;
    }

    const newSchedule = PEP_DAYS.filter((d) => protocolDays.includes(d.days)).map((d) => ({
      day_label: d.label,
      date_due: addDaysIso(restartDate, d.days),
    }));
    for (const row of newSchedule) {
      await conn.query(
        `INSERT INTO patient_pep_schedule
           (patient_id, episode_id, treatment_cycle, day_label, date_due, date_given,
            vaccine_brand, route, status, vaccinated_by, vaccinator_staff_id)
         VALUES (?,?,?,?,?,NULL,?,?,'Pending',NULL,NULL)`,
        [ep.patient_id, episodeId, newCycle, row.day_label, row.date_due, ep.brand_name || null, ep.route || null]
      );
    }

    if (await isLatestEpisodeFor(conn, ep.patient_id, episodeId)) {
      await conn.query(
        `UPDATE patients SET
           treatment_status = 'Ongoing', outcome = 'Inc',
           vaccine_d0 = NULL, vaccine_d3 = NULL, vaccine_d7 = NULL, vaccine_d14 = NULL, vaccine_d28 = NULL,
           missed_dose = NULL, missed_date = NULL,
           schedule_suspended = 0, interrupted_status = 0,
           interrupted_reviewed = 1, interrupted_reason = ?,
           interrupted_reviewed_by = ?, interrupted_reviewed_at = NOW(),
           next_schedule = ?, reminder_status = 'Pending'
         WHERE patient_id = ?`,
        [note, staffLabel, restartDate, ep.patient_id]
      );
    }

    const baseEp = { ...ep, treatment_cycle: previousCycle };
    await writeHistory(conn, baseEp, {
      cycle: previousCycle, event: EVENTS.PATIENT_RETURNED,
      previous_status: TREATMENT_STATUS.INCOMPLETE, new_status: RESTART_STATUS.REQUIRED,
      note: `Patient returned on ${returnedOn}. Restart confirmed according to the clinic-approved protocol.`,
    }, actor);
    await writeHistory(conn, baseEp, {
      cycle: newCycle, event: EVENTS.RESTART_CONFIRMED, dose_label: ep.missed_dose || null,
      previous_status: TREATMENT_STATUS.INCOMPLETE, new_status: RESTART_STATUS.CONFIRMED,
      note,
    }, actor);
    await writeHistory(conn, baseEp, {
      cycle: newCycle, event: EVENTS.NEW_SCHEDULE_CREATED,
      previous_status: SCHEDULE_STATUS.STOPPED, new_status: SCHEDULE_STATUS.ACTIVE,
      note: `New schedule from Day 0: ${newSchedule.map((r) => `${r.day_label} ${r.date_due}`).join(', ')}.`,
    }, actor);

    const restartNotice = restartNotificationCopy(restartDate);
    await insertPatientNotificationOnce(conn, {
      patientId: ep.patient_id,
      episodeId,
      type: 'SYSTEM',
      title: restartNotice.title,
      message: restartNotice.message,
      relatedDate: restartDate,
      doseLabel: 'Day 0',
      reminderType: `RESTART_${newCycle}`,
    });
    await writeActivity(conn, actor, {
      action: 'Restart Treatment',
      module: 'Patient Records',
      reference_id: ep.patient_id,
      description: `Treatment restart confirmed — Case #${ep.episode_number}: cycle ${previousCycle} stopped (missed ${ep.missed_dose || 'dose'} due ${missedDue || 'N/A'}), cycle ${newCycle} starts Day 0 on ${restartDate}. Note: ${note}`,
      old_value: JSON.stringify({ status: TREATMENT_STATUS.INCOMPLETE, cycle: previousCycle }),
      new_value: JSON.stringify({ status: TREATMENT_STATUS.ACTIVE, cycle: newCycle, restart_date: restartDate }),
    });

    return {
      episodeId: Number(episodeId),
      patientId: ep.patient_id,
      previousCycle,
      newCycle,
      restartDate,
      schedule: newSchedule,
    };
  });
}

/** Workflow fields attached to episode API payloads. */
function workflowSummary(ep, restarts = [], todayIso = localTodayIso()) {
  const incomplete = isEpisodeIncomplete(ep);
  const pendingMiss = !incomplete && ep.status !== TREATMENT_STATUS.COMPLETED ? findMissedDose(ep, todayIso) : null;
  const lastRestart = restarts.length ? restarts[restarts.length - 1] : null;
  const missedDue = incomplete ? toSqlDate(ep.missed_date) : (pendingMiss ? pendingMiss.due : null);
  let restartStatus = null;
  if (incomplete || pendingMiss) restartStatus = RESTART_STATUS.REQUIRED;
  else if (lastRestart && Number(lastRestart.new_cycle) === cycleNumber(ep)) restartStatus = RESTART_STATUS.CONFIRMED;
  return {
    treatment_cycle: cycleNumber(ep),
    workflow_status: incomplete || pendingMiss ? TREATMENT_STATUS.INCOMPLETE : (ep.status || TREATMENT_STATUS.ACTIVE),
    schedule_status: incomplete || pendingMiss ? SCHEDULE_STATUS.STOPPED : SCHEDULE_STATUS.ACTIVE,
    restart_status: restartStatus,
    missed_dose_label: incomplete ? (ep.missed_dose || null) : (pendingMiss ? pendingMiss.label : null),
    missed_due_date: missedDue,
    missed_detected_at: incomplete ? (ep.missed_detected_at || null) : null,
    days_delayed: missedDue ? dayDiff(missedDue, todayIso) : null,
    restart_count: restarts.length,
    last_restart: lastRestart ? {
      restart_date: toSqlDate(lastRestart.restart_date),
      confirmed_by: lastRestart.confirmed_by,
      note: lastRestart.note,
      new_cycle: lastRestart.new_cycle,
    } : null,
  };
}

/** Adds `restarts`, `status_history` and `workflow` to each enriched episode. */
async function attachWorkflow(db, episodes, todayIso = localTodayIso()) {
  for (const ep of episodes || []) {
    const restarts = await listRestarts(db, ep.episode_id).catch(() => []);
    ep.restarts = restarts;
    ep.status_history = await listStatusHistory(db, ep.episode_id).catch(() => []);
    ep.workflow = workflowSummary(ep, restarts, todayIso);
    const newerCase = await findBlockingNewerCase(db, ep).catch(() => null);
    if (newerCase) {
      ep.workflow.restart_blocked = true;
      ep.workflow.restart_block_reason = NEWER_CASE_RESTART_MESSAGE;
      ep.workflow.newer_case_number = newerCase.exposure_number || newerCase.episode_number || null;
    }
    if (Array.isArray(ep.pep_schedule)) {
      const cycle = cycleNumber(ep);
      ep.pep_schedule_history = ep.pep_schedule.filter((r) => (Number(r.treatment_cycle) || 1) !== cycle);
      ep.pep_schedule = ep.pep_schedule.filter((r) => (Number(r.treatment_cycle) || 1) === cycle);
    }
  }
  return episodes;
}

function sendWorkflowError(res, err) {
  if (err instanceof WorkflowError) {
    res.status(err.status).json({ success: false, code: err.code, message: err.message });
    return true;
  }
  return false;
}

module.exports = {
  attachWorkflow,
  sendWorkflowError,
  TREATMENT_STATUS,
  DOSE_STATUS,
  SCHEDULE_STATUS,
  RESTART_STATUS,
  EVENTS,
  INCOMPLETE_STATUSES,
  PATIENT_MISSED_NOTICE,
  RESTART_CONFIRM_TEXT,
  NEWER_CASE_RESTART_MESSAGE,
  findBlockingNewerCase,
  SYSTEM_ACTOR,
  WorkflowError,
  isIncompleteStatus,
  isEpisodeIncomplete,
  dayDiff,
  cycleNumber,
  cycleDayZero,
  scheduleForEpisode,
  findMissedDose,
  nextDueDose,
  actorFromReq,
  markEpisodeIncomplete,
  detectAndMarkEpisode,
  detectForPatient,
  doseKeysChanged,
  assertDoseEntryAllowed,
  validateRestartRequest,
  restartTreatment,
  listRestarts,
  listStatusHistory,
  workflowSummary,
};
