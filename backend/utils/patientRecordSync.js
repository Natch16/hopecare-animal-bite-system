/**
 * Current-case sync: Patient Records, Edit form, and Treatment History
 * all read/write the same latest case for a patient.
 * Prior cases stay in patient_exposures + treatment_episodes.
 */

'use strict';

const { toSqlDate, addDaysIso, localTodayIso } = require('./dateOnly');

// Lazy: missedDose.js depends on this module's exports.
function workflow() {
  return require('./missedDose');
}

function episodeStatusFor(ep, outcome) {
  if (ep && workflow().isEpisodeIncomplete(ep)) return 'Incomplete';
  return treatmentStatusFromOutcome(outcome);
}

const PEP_DAYS = [
  { label: 'Day 0',  key: 'vaccine_d0',  days: 0  },
  { label: 'Day 3',  key: 'vaccine_d3',  days: 3  },
  { label: 'Day 7',  key: 'vaccine_d7',  days: 7  },
  { label: 'Day 14', key: 'vaccine_d14', days: 14 },
  { label: 'Day 28', key: 'vaccine_d28', days: 28 },
];

const DAY_KEY = {
  0: 'vaccine_d0',
  3: 'vaccine_d3',
  7: 'vaccine_d7',
  14: 'vaccine_d14',
  28: 'vaccine_d28',
};

/** Required clinical sessions by bite category. */
const PEP_SCHEDULE_BY_CATEGORY = {
  '1': [0, 3, 7],
  '2': [0, 3, 7, 14],
  '3': [0, 3],
};

function pepDaysForCategory(category) {
  return PEP_SCHEDULE_BY_CATEGORY[String(category)] || [0, 3, 7];
}

function hasValue(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

const VALID_ROUTES = ['ID', 'IM'];
const VALID_CATEGORIES = ['1', '2', '3'];

/**
 * Validate the payload fields for creating or updating a case.
 * Brand names are checked against Vaccine Management in the route handlers.
 * @param {object} data - The request body / case data object
 * @returns {string[]} Array of error messages; empty array means valid
 */
function validateCasePayload(data) {
  const errors = [];
  if (!hasValue(data.category)) {
    errors.push('Category is required.');
  } else if (!VALID_CATEGORIES.includes(String(data.category))) {
    errors.push('Invalid category. Must be 1, 2, or 3.');
  }
  if (hasValue(data.route) && !VALID_ROUTES.includes(data.route)) {
    errors.push('Invalid route. Use ID or IM.');
  }
  return errors;
}

function requiredDoseKeys(category) {
  return pepDaysForCategory(category).map((d) => DAY_KEY[d]);
}

/**
 * COMPLETED (C) only when every required dose for the category has a date.
 * Otherwise INCOMPLETE (Inc).
 */
function computeOutcome(category, data) {
  if (!hasValue(category)) return 'Inc';
  const keys = requiredDoseKeys(category);
  if (!keys.length) return 'Inc';
  const complete = keys.every((k) => hasValue(data[k]));
  return complete ? 'C' : 'Inc';
}

function treatmentStatusFromOutcome(outcome) {
  return outcome === 'C' ? 'Completed' : 'Ongoing';
}

function applyIfPresent(target, source, fields) {
  for (const f of fields) {
    if (hasValue(source[f])) target[f] = source[f];
  }
}

function latestExposure(exposures) {
  if (!exposures || !exposures.length) return null;
  return exposures.slice().sort((a, b) => Number(b.exposure_number) - Number(a.exposure_number))[0];
}

function treatmentForExposure(episodes, exposure) {
  if (!exposure) return null;
  const list = episodes || [];
  return list.find((e) => Number(e.exposure_id) === Number(exposure.exposure_id))
    || list.find((e) => Number(e.episode_number) === Number(exposure.exposure_number))
    || null;
}

function markCurrentExposure(exposures) {
  const exp = latestExposure(exposures);
  (exposures || []).forEach((e) => {
    e.is_current = !!(exp && Number(e.exposure_id) === Number(exp.exposure_id));
  });
  return exp;
}

/**
 * Copy a specific case onto the denormalized patients row (API/display).
 * Null dose dates are copied so a new case cannot keep leftover dates
 * from a previous case.
 */
function copyCaseOntoPatient(patient, exp, ep) {
  if (!patient) return patient;
  if (exp) {
    patient.date_of_exposure = exp.date_of_exposure ?? null;
    patient.place_of_exposure = exp.place_of_exposure ?? null;
    patient.type_of_animal = exp.type_of_animal ?? null;
    patient.type_of_exposure = exp.type_of_exposure ?? null;
    patient.site_of_exposure = exp.site_of_exposure ?? null;
    patient.biting_animal_status = exp.biting_animal_status ?? null;
    patient.nature_of_exposure = exp.nature_of_exposure ?? null;
    patient.region_of_exposure = exp.region_of_exposure ?? null;
    patient.condition_of_animal = exp.condition_of_animal ?? null;
    patient.signs_symptoms = exp.signs_symptoms ?? null;
    if (exp.barangay != null) patient.barangay = exp.barangay;
    if (exp.notes != null) patient.remarks = exp.notes;
    patient.current_exposure_id = exp.exposure_id;
    patient.current_case_number = exp.exposure_number;
  }
  const cat = (ep && ep.category) || (exp && exp.category) || patient.category;
  patient.category = cat ?? null;
  if (ep) {
    patient.washing_of_bite = ep.washing_of_bite ?? exp?.washing_of_bite ?? null;
    patient.brand_name = ep.brand_name ?? null;
    patient.route = ep.route ?? null;
    patient.rig_date_given = ep.rig_date_given ?? null;
    patient.vaccine_d0 = ep.vaccine_d0 ?? null;
    patient.vaccine_d3 = ep.vaccine_d3 ?? null;
    patient.vaccine_d7 = ep.vaccine_d7 ?? null;
    patient.vaccine_d14 = ep.vaccine_d14 ?? null;
    patient.vaccine_d28 = ep.vaccine_d28 ?? null;
    if (ep.notes != null && !hasValue(patient.remarks)) patient.remarks = ep.notes;
    patient.current_case_id = ep.episode_id;
    patient.treatment_cycle = ep.treatment_cycle ?? 1;
    patient.cycle_started_on = ep.cycle_started_on ?? null;
    if (workflow().isEpisodeIncomplete(ep)) {
      patient.treatment_status = 'Incomplete';
      patient.schedule_suspended = 1;
      patient.missed_dose = ep.missed_dose ?? patient.missed_dose ?? null;
      patient.missed_date = ep.missed_date ?? patient.missed_date ?? null;
    } else if (ep.status) {
      patient.treatment_status = ep.status;
      patient.schedule_suspended = 0;
    }
    patient.outcome = computeOutcome(cat, ep);
    patient.required_doses = pepDaysForCategory(cat);
    patient.required_dose_count = patient.required_doses.length;
  } else if (exp) {
    patient.washing_of_bite = exp.washing_of_bite ?? null;
    patient.outcome = computeOutcome(cat, patient);
  } else {
    patient.outcome = computeOutcome(patient.category, patient);
  }
  return patient;
}

/**
 * Source of truth for reads: case tables win. Patients snapshot is only a cache.
 * Recalculate outcome for every case from its own PEP dates + category.
 */
function overlayPrimaryCaseFromPatient(patient, exposures, episodes) {
  if (!patient) return;
  const exp = markCurrentExposure(exposures);
  (episodes || []).forEach((ep) => {
    const linked = (exposures || []).find((e) => Number(e.exposure_id) === Number(ep.exposure_id))
      || (exposures || []).find((e) => Number(e.exposure_number) === Number(ep.episode_number));
    const cat = ep.category || linked?.category || patient.category;
    ep.outcome = computeOutcome(cat, ep);
    ep.status = episodeStatusFor(ep, ep.outcome);
    ep.required_doses = pepDaysForCategory(cat);
    ep.required_dose_count = ep.required_doses.length;
    const givenByLabel = {};
    for (const dose of PEP_DAYS) {
      if (hasValue(ep[dose.key])) givenByLabel[dose.label] = ep[dose.key];
    }
    const cycle = Number(ep.treatment_cycle) || 1;
    if (Array.isArray(ep.pep_schedule) && ep.pep_schedule.length) {
      ep.pep_schedule = ep.pep_schedule.map((row) => {
        if ((Number(row.treatment_cycle) || 1) !== cycle) return row;
        const given = givenByLabel[row.day_label] || row.date_given || null;
        return {
          ...row,
          date_given: given,
          status: given ? 'Completed' : (row.status || 'Pending'),
          vaccine_brand: hasValue(ep.brand_name) ? ep.brand_name : row.vaccine_brand,
          route: hasValue(ep.route) ? ep.route : row.route,
        };
      });
    }
  });
  const ep = treatmentForExposure(episodes, exp);
  copyCaseOntoPatient(patient, exp, ep);
}

function overlayPatientRowsFromCases(patients, exposures, episodes) {
  const latestByPatient = {};
  for (const e of exposures || []) {
    const pid = Number(e.patient_id);
    if (!latestByPatient[pid] || Number(e.exposure_number) > Number(latestByPatient[pid].exposure_number)) {
      latestByPatient[pid] = e;
    }
  }
  const epByExposure = {};
  for (const ep of episodes || []) {
    if (ep.exposure_id != null) epByExposure[String(ep.exposure_id)] = ep;
  }
  return (patients || []).map((p) => {
    const row = { ...p };
    const exp = latestByPatient[Number(p.patient_id)];
    if (!exp) {
      row.outcome = computeOutcome(row.category, row);
      return row;
    }
    const ep = epByExposure[String(exp.exposure_id)]
      || (episodes || []).find((e) => Number(e.patient_id) === Number(p.patient_id)
        && Number(e.episode_number) === Number(exp.exposure_number));
    copyCaseOntoPatient(row, exp, ep);
    return row;
  });
}

function pickDate(source, fallbackRow, key) {
  if (source && Object.prototype.hasOwnProperty.call(source, key)) {
    return toSqlDate(source[key]);
  }
  return toSqlDate(fallbackRow ? fallbackRow[key] : null);
}

function buildPepInsertRows(patientId, episodeId, data) {
  const requiredDays = pepDaysForCategory(data.category);
  const d0 = toSqlDate(data.vaccine_d0) || toSqlDate(data.date_started);
  return PEP_DAYS.filter((dose) => requiredDays.includes(dose.days)).map((dose) => {
    const given = toSqlDate(data[dose.key]);
    const due = d0 ? addDaysIso(d0, dose.days) : given;
    // Per-dose vaccinator key: vaccinator_d0, vaccinator_d3, vaccinator_d7, vaccinator_d14, vaccinator_d28
    const vaccinatorKey = 'vaccinator_' + dose.key.replace('vaccine_', ''); // e.g. vaccine_d0 → vaccinator_d0
    const vaccinatedBy  = data[vaccinatorKey] || null;
    return {
      patient_id: patientId,
      episode_id: episodeId,
      day_label: dose.label,
      date_due: due,
      date_given: given,
      vaccine_brand: data.brand_name || null,
      route: data.route || null,
      status: given ? 'Completed' : 'Pending',
      vaccinated_by: vaccinatedBy,
    };
  });
}

/**
 * Rewrite the CURRENT treatment cycle's schedule rows only. Rows from earlier
 * cycles (stopped/missed before a restart) are history and never touched.
 */
async function rebuildPepSchedule(pool, patientId, episodeId, data) {
  const [[cycleRow]] = await pool.query(
    'SELECT treatment_cycle, cycle_started_on FROM treatment_episodes WHERE episode_id = ? LIMIT 1',
    [episodeId]
  ).catch(() => [[null]]);
  const cycle = Number(cycleRow && cycleRow.treatment_cycle) || 1;
  const scheduleData = cycle > 1 && cycleRow.cycle_started_on
    ? { ...data, date_started: cycleRow.cycle_started_on }
    : data;

  // Preserve existing vaccinator data before deleting schedule rows
  const [existingRows] = await pool.query(
    `SELECT day_label, vaccinated_by, vaccinator_staff_id, date_given, status
     FROM patient_pep_schedule WHERE episode_id = ? AND treatment_cycle = ?`,
    [episodeId, cycle]
  ).catch(() => [[]]);
  const vaccinatorByLabel = {};
  for (const row of existingRows) {
    vaccinatorByLabel[row.day_label] = {
      vaccinated_by: row.vaccinated_by || null,
      vaccinator_staff_id: row.vaccinator_staff_id || null,
      // Only preserve date_given if new data doesn't explicitly provide one for this dose
      date_given_existing: row.date_given || null,
      status: row.status || null,
    };
  }

  await pool.query(
    'DELETE FROM patient_pep_schedule WHERE episode_id = ? AND treatment_cycle = ?',
    [episodeId, cycle]
  ).catch(() => {});
  const rows = buildPepInsertRows(patientId, episodeId, scheduleData);
  for (const row of rows) {
    const preserved = vaccinatorByLabel[row.day_label] || {};
    if (!row.date_given && (preserved.status === 'Missed' || preserved.status === 'Stopped')) {
      row.status = preserved.status;
    }
    // Determine vaccinator to store:
    //   1. If the incoming row has an explicit vaccinator (typed by nurse), use it.
    //   2. Otherwise restore the previously saved value for already-recorded doses.
    //   3. Never fall back to a session user — null if no value.
    const vaccinatorToSave = row.vaccinated_by || (row.date_given ? (preserved.vaccinated_by || null) : null);
    await pool.query(
      `INSERT INTO patient_pep_schedule
         (patient_id, episode_id, treatment_cycle, day_label, date_due, date_given, vaccine_brand, route, status,
          vaccinated_by, vaccinator_staff_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.patient_id, row.episode_id, cycle, row.day_label,
        row.date_due, row.date_given, row.vaccine_brand, row.route, row.status,
        vaccinatorToSave,
        null, // vaccinator_staff_id: no longer auto-set from session — remains null
      ]
    );
  }
}

async function promoteToCurrentPatient(pool, patientId, data) {
  const [[existing]] = await pool.query(
    'SELECT * FROM patients WHERE patient_id = ? LIMIT 1',
    [patientId]
  ).catch(() => [[null]]);
  const d = { ...(existing || {}), ...(data || {}) };
  const outcome = computeOutcome(d.category, d);
  await pool.query(
    `UPDATE patients SET
      date_of_exposure=?, place_of_exposure=?, type_of_animal=?, type_of_exposure=?, site_of_exposure=?,
      category=?, washing_of_bite=?, rig_date_given=?, route=?, brand_name=?,
      vaccine_d0=?, vaccine_d3=?, vaccine_d7=?, vaccine_d14=?, vaccine_d28=?,
      outcome=?, biting_animal_status=?, remarks=?,
      nature_of_exposure=?, region_of_exposure=?, condition_of_animal=?, signs_symptoms=?
    WHERE patient_id=?`,
    [
      toSqlDate(d.date_of_exposure), d.place_of_exposure || null,
      d.type_of_animal || null, d.type_of_exposure || null, d.site_of_exposure || null,
      d.category || null, d.washing_of_bite || null, toSqlDate(d.rig_date_given),
      d.route || null, d.brand_name || null,
      toSqlDate(d.vaccine_d0), toSqlDate(d.vaccine_d3), toSqlDate(d.vaccine_d7),
      toSqlDate(d.vaccine_d14), toSqlDate(d.vaccine_d28),
      outcome, d.biting_animal_status || null, d.remarks || null,
      d.nature_of_exposure || null, d.region_of_exposure || null,
      d.condition_of_animal || null, d.signs_symptoms || null,
      patientId,
    ]
  );
  return outcome;
}

async function promoteCaseToPatient(pool, patientId, exposureId, episodeId) {
  let exp = null;
  let ep = null;
  if (exposureId) {
    [[exp]] = await pool.query(
      'SELECT * FROM patient_exposures WHERE exposure_id = ? LIMIT 1',
      [exposureId]
    );
  }
  if (episodeId) {
    [[ep]] = await pool.query(
      'SELECT * FROM treatment_episodes WHERE episode_id = ? LIMIT 1',
      [episodeId]
    );
  }
  const payload = {
    ...(exp || {}),
    ...(ep || {}),
    remarks: (exp && exp.notes) || (ep && ep.notes) || null,
  };
  return promoteToCurrentPatient(pool, patientId, payload);
}

async function isLatestEpisode(pool, patientId, episodeId) {
  const [[latest]] = await pool.query(
    `SELECT episode_id FROM treatment_episodes
     WHERE patient_id = ? ORDER BY episode_number DESC LIMIT 1`,
    [patientId]
  );
  return !!(latest && Number(latest.episode_id) === Number(episodeId));
}

async function persistEpisodeOutcome(pool, episode) {
  const [[exp]] = episode.exposure_id
    ? await pool.query(
        'SELECT * FROM patient_exposures WHERE exposure_id = ? LIMIT 1',
        [episode.exposure_id]
      )
    : [[null]];
  const category = episode.category || exp?.category || null;
  const outcome = computeOutcome(category, episode);
  const status = episodeStatusFor(episode, outcome);
  const dateCompleted = outcome === 'C'
    ? (toSqlDate(episode.vaccine_d28) || toSqlDate(episode.vaccine_d14)
      || toSqlDate(episode.vaccine_d7) || toSqlDate(episode.vaccine_d3)
      || toSqlDate(episode.vaccine_d0))
    : null;
  await pool.query(
    `UPDATE treatment_episodes SET outcome = ?, status = ?, date_completed = ?
     WHERE episode_id = ?`,
    [outcome, status, dateCompleted, episode.episode_id]
  );
  if (await isLatestEpisode(pool, episode.patient_id, episode.episode_id)) {
    await promoteCaseToPatient(pool, episode.patient_id, episode.exposure_id, episode.episode_id);
  }
  return { outcome, status, completed: outcome === 'C' };
}

/**
 * Insert a NEW case (exposure + PEP) for an existing patient, then make it current.
 * Prior cases are left untouched.
 */
async function createNewCase(pool, patientId, data, auditBy) {
  const d = data || {};
  if (!hasValue(d.category)) {
    const err = new Error('Category is required.');
    err.status = 400;
    throw err;
  }

  const outcome = computeOutcome(d.category, d);
  const epStatus = treatmentStatusFromOutcome(outcome);

  const [[lastExp]] = await pool.query(
    'SELECT COALESCE(MAX(exposure_number),0) AS last_num FROM patient_exposures WHERE patient_id = ?',
    [patientId]
  );
  const nextExpNum = (lastExp?.last_num || 0) + 1;

  const [[lastEp]] = await pool.query(
    'SELECT COALESCE(MAX(episode_number),0) AS last_num FROM treatment_episodes WHERE patient_id = ?',
    [patientId]
  );
  const nextEpNum = (lastEp?.last_num || 0) + 1;

  const [expRes] = await pool.query(
    `INSERT INTO patient_exposures (
      patient_id, exposure_number, date_of_exposure, place_of_exposure,
      barangay, type_of_animal, type_of_exposure, site_of_exposure,
      category, washing_of_bite, biting_animal_status, notes, created_by,
      nature_of_exposure, region_of_exposure, condition_of_animal, signs_symptoms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      patientId, nextExpNum,
      toSqlDate(d.date_of_exposure), d.place_of_exposure || null,
      d.barangay || null,
      d.type_of_animal || null, d.type_of_exposure || null, d.site_of_exposure || null,
      d.category || null, d.washing_of_bite || null, d.biting_animal_status || null,
      d.remarks || d.notes || null, auditBy || null,
      d.nature_of_exposure || null, d.region_of_exposure || null,
      d.condition_of_animal || null, d.signs_symptoms || null,
    ]
  );
  console.log(`[createNewCase] Inserted patient_exposures #${nextExpNum} for patient ${patientId}: date_of_exposure=${toSqlDate(d.date_of_exposure)} (raw input: ${d.date_of_exposure})`);
  const exposureId = expRes.insertId;

  const dateStarted = toSqlDate(d.vaccine_d0) || toSqlDate(d.date_started) || toSqlDate(d.date_of_exposure) || localTodayIso();

  const [epRes] = await pool.query(
    `INSERT INTO treatment_episodes (
      patient_id, exposure_id, episode_number, treatment_type, category,
      status, date_started, brand_name, route, washing_of_bite,
      vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28,
      rig_date_given, outcome, notes, created_by
    ) VALUES (?,?,?,'PEP',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      patientId, exposureId, nextEpNum, d.category || null,
      epStatus, dateStarted,
      d.brand_name || null, d.route || null, d.washing_of_bite || null,
      toSqlDate(d.vaccine_d0), toSqlDate(d.vaccine_d3), toSqlDate(d.vaccine_d7),
      toSqlDate(d.vaccine_d14), toSqlDate(d.vaccine_d28),
      toSqlDate(d.rig_date_given), outcome, d.remarks || d.notes || null,
      auditBy || null,
    ]
  );
  const episodeId = epRes.insertId;

  await rebuildPepSchedule(pool, patientId, episodeId, d);
  await promoteToCurrentPatient(pool, patientId, {
    ...d,
    outcome,
    remarks: d.remarks || d.notes || null,
  });
  // A genuine new exposure starts its own schedule; the previous case keeps
  // its own status in treatment_episodes.
  await pool.query(
    `UPDATE patients SET
       treatment_status = ?, schedule_suspended = 0, interrupted_status = 0,
       missed_dose = NULL, missed_date = NULL, next_schedule = NULL, reminder_status = NULL
     WHERE patient_id = ?`,
    [epStatus, patientId]
  );
  console.log(`[createNewCase] Done. patient=${patientId} new exposure=${exposureId} date_of_exposure saved=${toSqlDate(d.date_of_exposure)}`);

  return {
    exposureId,
    episodeId,
    caseId: exposureId,
    caseNumber: nextExpNum,
    outcome,
  };
}

/**
 * Reject dose-date changes on the current case while its schedule is stopped
 * (or already overdue). Call before writing anything for the patient.
 */
async function assertCurrentCaseDoseEntry(pool, patientId, data, actor) {
  const [[latest]] = await pool.query(
    'SELECT * FROM treatment_episodes WHERE patient_id = ? ORDER BY episode_number DESC LIMIT 1',
    [patientId]
  );
  if (!latest) return;
  const doseFields = {};
  for (const dose of PEP_DAYS) doseFields[dose.key] = (data || {})[dose.key] ?? null;
  await workflow().assertDoseEntryAllowed(pool, latest, doseFields, { actor });
}

/**
 * Write Patient Records fields onto the CURRENT (latest) case.
 * Creates case #1 when the patient has no cases yet.
 */
async function syncPrimaryRecord(pool, patientId, data, auditBy, actor) {
  const d = data || {};
  await assertCurrentCaseDoseEntry(pool, patientId, d, actor);
  const outcome = computeOutcome(d.category, d);
  d.outcome = outcome;
  const epStatus = treatmentStatusFromOutcome(outcome);

  let [[current]] = await pool.query(
    `SELECT exposure_id, exposure_number FROM patient_exposures
     WHERE patient_id = ? ORDER BY exposure_number DESC LIMIT 1`,
    [patientId]
  );

  if (current) {
    await pool.query(
      `UPDATE patient_exposures SET
        date_of_exposure=?, place_of_exposure=?, barangay=?,
        type_of_animal=?, type_of_exposure=?, site_of_exposure=?,
        category=?, washing_of_bite=?, biting_animal_status=?,
        notes=?, nature_of_exposure=?, region_of_exposure=?,
        condition_of_animal=?, signs_symptoms=?
      WHERE exposure_id=?`,
      [
        toSqlDate(d.date_of_exposure), d.place_of_exposure || null, d.barangay || null,
        d.type_of_animal || null, d.type_of_exposure || null, d.site_of_exposure || null,
        d.category || null, d.washing_of_bite || null, d.biting_animal_status || null,
        d.remarks || null,
        d.nature_of_exposure || null, d.region_of_exposure || null,
        d.condition_of_animal || null, d.signs_symptoms || null,
        current.exposure_id,
      ]
    );
  } else {
    const [ins] = await pool.query(
      `INSERT INTO patient_exposures (
        patient_id, exposure_number, date_of_exposure, place_of_exposure,
        barangay, type_of_animal, type_of_exposure, site_of_exposure,
        category, washing_of_bite, biting_animal_status, notes, created_by,
        nature_of_exposure, region_of_exposure, condition_of_animal, signs_symptoms
      ) VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        patientId,
        toSqlDate(d.date_of_exposure), d.place_of_exposure || null,
        d.barangay || null,
        d.type_of_animal || null, d.type_of_exposure || null, d.site_of_exposure || null,
        d.category || null, d.washing_of_bite || null, d.biting_animal_status || null,
        d.remarks || null, auditBy || null,
        d.nature_of_exposure || null, d.region_of_exposure || null,
        d.condition_of_animal || null, d.signs_symptoms || null,
      ]
    );
    current = { exposure_id: ins.insertId, exposure_number: 1 };
  }

  let [[tx]] = await pool.query(
    `SELECT * FROM treatment_episodes
     WHERE exposure_id = ? ORDER BY episode_number DESC LIMIT 1`,
    [current.exposure_id]
  );
  if (!tx) {
    [[tx]] = await pool.query(
      `SELECT * FROM treatment_episodes
       WHERE patient_id = ? ORDER BY episode_number DESC LIMIT 1`,
      [patientId]
    );
  }

  // date_started is a session-tracking field only — do NOT fall back to date_of_exposure
  // to avoid auto-populating vaccine_d0 based on the exposure or registration date.
  const dateStarted = toSqlDate(d.vaccine_d0) || toSqlDate(d.date_started) || null;

  const txStatus = tx ? episodeStatusFor(tx, outcome) : epStatus;

  if (tx) {
    await pool.query(
      `UPDATE treatment_episodes SET
        exposure_id=COALESCE(?, exposure_id),
        category=?, status=?, brand_name=?, route=?, washing_of_bite=?,
        vaccine_d0=?, vaccine_d3=?, vaccine_d7=?, vaccine_d14=?, vaccine_d28=?,
        rig_date_given=?, outcome=?, notes=?
      WHERE episode_id=?`,
      [
        current.exposure_id,
        d.category || null, txStatus,
        d.brand_name || null, d.route || null, d.washing_of_bite || null,
        d.vaccine_d0 || null, d.vaccine_d3 || null, d.vaccine_d7 || null,
        d.vaccine_d14 || null, d.vaccine_d28 || null,
        d.rig_date_given || null, outcome, d.remarks || null,
        tx.episode_id,
      ]
    );
  } else {
    const [ins] = await pool.query(
      `INSERT INTO treatment_episodes (
        patient_id, exposure_id, episode_number, treatment_type, category,
        status, date_started, brand_name, route, washing_of_bite,
        vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28,
        rig_date_given, outcome, notes, created_by
      ) VALUES (?,?,?,'PEP',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        patientId, current.exposure_id, current.exposure_number || 1,
        d.category || null, epStatus, dateStarted,
        d.brand_name || null, d.route || null, d.washing_of_bite || null,
        d.vaccine_d0 || null, d.vaccine_d3 || null, d.vaccine_d7 || null,
        d.vaccine_d14 || null, d.vaccine_d28 || null,
        d.rig_date_given || null, outcome, d.remarks || null,
        auditBy || null,
      ]
    );
    tx = { episode_id: ins.insertId };
  }

  await rebuildPepSchedule(pool, patientId, tx.episode_id, d);
  await promoteToCurrentPatient(pool, patientId, d);
  return { exposureId: current.exposure_id, episodeId: tx.episode_id, outcome };
}

async function updateCaseTreatment(pool, episodeId, data, expectedPatientId, actor) {
  const [[episode]] = await pool.query(
    'SELECT * FROM treatment_episodes WHERE episode_id = ? LIMIT 1',
    [episodeId]
  );
  if (!episode) {
    const err = new Error('Case treatment record not found');
    err.status = 404;
    throw err;
  }
  if (expectedPatientId != null && Number(episode.patient_id) !== Number(expectedPatientId)) {
    const err = new Error('Dose records must belong to the correct patient and case.');
    err.status = 400;
    throw err;
  }

  const incoming = data || {};
  await workflow().assertDoseEntryAllowed(pool, episode, incoming, { actor });
  const d = { ...episode, ...incoming };
  d.vaccine_d0 = pickDate(incoming, episode, 'vaccine_d0');
  d.vaccine_d3 = pickDate(incoming, episode, 'vaccine_d3');
  d.vaccine_d7 = pickDate(incoming, episode, 'vaccine_d7');
  d.vaccine_d14 = pickDate(incoming, episode, 'vaccine_d14');
  d.vaccine_d28 = pickDate(incoming, episode, 'vaccine_d28');
  d.rig_date_given = Object.prototype.hasOwnProperty.call(incoming, 'rig_date_given')
    ? toSqlDate(incoming.rig_date_given)
    : toSqlDate(episode.rig_date_given);
  const outcome = computeOutcome(d.category, d);
  const status = episodeStatusFor(episode, outcome);
  await pool.query(
    `UPDATE treatment_episodes SET
      category=?, brand_name=?, route=?, washing_of_bite=?,
      vaccine_d0=?, vaccine_d3=?, vaccine_d7=?, vaccine_d14=?, vaccine_d28=?,
      rig_date_given=?, outcome=?, status=?, notes=?
     WHERE episode_id=?`,
    [
      d.category || null, d.brand_name || null, d.route || null, d.washing_of_bite || null,
      d.vaccine_d0, d.vaccine_d3, d.vaccine_d7, d.vaccine_d14, d.vaccine_d28,
      d.rig_date_given, outcome, status, d.notes || d.remarks || null,
      episodeId,
    ]
  );

  await rebuildPepSchedule(pool, episode.patient_id, episodeId, d);
  const [[updated]] = await pool.query(
    'SELECT * FROM treatment_episodes WHERE episode_id = ? LIMIT 1',
    [episodeId]
  );
  return persistEpisodeOutcome(pool, updated || {
    ...d,
    episode_id: episodeId,
    patient_id: episode.patient_id,
  });
}

async function attachCurrentCaseFromDb(pool, patient) {
  if (!patient) return patient;
  try {
    await workflow().detectForPatient(pool, patient.patient_id);
  } catch (_) { /* detection is best-effort on read */ }
  const [exposures] = await pool.query(
    'SELECT * FROM patient_exposures WHERE patient_id = ? ORDER BY exposure_number ASC',
    [patient.patient_id]
  );
  const [episodes] = await pool.query(
    'SELECT * FROM treatment_episodes WHERE patient_id = ? ORDER BY episode_number ASC',
    [patient.patient_id]
  );
  overlayPrimaryCaseFromPatient(patient, exposures, episodes);
  patient.total_cases = (exposures || []).length;
  return patient;
}

async function overlayPatientListFromDb(pool, patients) {
  if (!patients || !patients.length) return patients;
  const ids = patients.map((p) => p.patient_id);
  const [exposures] = await pool.query(
    `SELECT * FROM patient_exposures WHERE patient_id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  const [episodes] = await pool.query(
    `SELECT * FROM treatment_episodes WHERE patient_id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  return overlayPatientRowsFromCases(patients, exposures, episodes);
}

module.exports = {
  PEP_DAYS,
  PEP_SCHEDULE_BY_CATEGORY,
  DAY_KEY,
  pepDaysForCategory,
  requiredDoseKeys,
  hasValue,
  validateCasePayload,
  toSqlDate,
  addDaysIso,
  localTodayIso,
  computeOutcome,
  treatmentStatusFromOutcome,
  overlayPrimaryCaseFromPatient,
  overlayPatientRowsFromCases,
  copyCaseOntoPatient,
  rebuildPepSchedule,
  promoteToCurrentPatient,
  promoteCaseToPatient,
  persistEpisodeOutcome,
  createNewCase,
  syncPrimaryRecord,
  assertCurrentCaseDoseEntry,
  attachCurrentCaseFromDb,
  overlayPatientListFromDb,
  latestExposure,
  isLatestEpisode,
  updateCaseTreatment,
  pickDate,
};
