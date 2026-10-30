'use strict';

const { computeTreatmentStatus } = require('./treatmentStatus');
const {
  pepDaysForCategory,
  PEP_DAYS,
  toSqlDate,
  addDaysIso,
  hasValue,
  copyCaseOntoPatient,
} = require('./patientRecordSync');

function todayIso() {
  const n = new Date();
  const y = n.getFullYear();
  const m = String(n.getMonth() + 1).padStart(2, '0');
  const d = String(n.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normLabel(v) {
  return String(v || '').toLowerCase().replace(/\s+/g, '');
}

function classifyArv(brand, type) {
  const s = `${brand || ''} ${type || ''}`.toUpperCase();
  if (s.includes('PCEC') || s.includes('VAXIRAB')) return 'PCEC';
  if (s.includes('PVRV') || s.includes('ABHAYRAB')) return 'PVRV';
  return null;
}

function pepStatus(given, due, existing) {
  if (given) return 'Completed';
  const st = String(existing || '').toLowerCase();
  if (st === 'missed') return 'Missed';
  if (st === 'stopped' || st === 'cancelled') return 'Stopped';
  if (due && due < todayIso()) return 'Missed';
  if (due && due > todayIso()) return 'Upcoming';
  if (st === 'completed') return 'Pending';
  return existing || 'Pending';
}

function pickPepRow(rows, label) {
  const wanted = normLabel(label);
  const matches = (rows || []).filter((r) => normLabel(r.day_label) === wanted);
  return matches.length ? matches[matches.length - 1] : {};
}

function currentCycleRows(rows, episode) {
  const cycle = Number(episode && episode.treatment_cycle) || 1;
  const list = rows || [];
  const inCycle = list.filter((r) => (Number(r.treatment_cycle) || 1) === cycle);
  return inCycle.length ? inCycle : list;
}

function buildCurrentPep(patient, pepRows) {
  let days = pepDaysForCategory(patient.category).slice();
  PEP_DAYS.forEach((dose) => {
    const rec = pickPepRow(pepRows, dose.label);
    if ((rec.pep_id || rec.date_given || rec.date_due || hasValue(patient[dose.key])) && !days.includes(dose.days)) {
      days.push(dose.days);
    }
  });
  days = days.slice().sort((a, b) => a - b);

  const rec0 = pickPepRow(pepRows, 'Day 0');
  const d0 = toSqlDate(rec0.date_given) || toSqlDate(patient.vaccine_d0);
  return days.map((dayNum) => {
    const dose = PEP_DAYS.find((d) => d.days === dayNum);
    const rec = pickPepRow(pepRows, dose.label);
    /* Episode PEP rows win. Do not fall back to another case's patients-table dates. */
    const given = rec.pep_id
      ? toSqlDate(rec.date_given)
      : (toSqlDate(rec.date_given) || toSqlDate(patient[dose.key]));
    const due = toSqlDate(rec.date_due) || (d0 ? addDaysIso(d0, dose.days) : given);
    return {
      pep_id: rec.pep_id || null,
      patient_id: patient.patient_id,
      episode_id: rec.episode_id || patient.current_case_id || null,
      day_label: dose.label,
      date_due: due,
      date_given: given,
      vaccine_brand: rec.vaccine_brand || patient.brand_name || null,
      route: rec.route || patient.route || null,
      site_right: rec.site_right || 0,
      site_left: rec.site_left || 0,
      vaccinated_by: rec.vaccinated_by || null,
      remarks: rec.remarks || rec.notes || null,
      status: pepStatus(given, due, rec.status),
    };
  });
}

function mapTetanus(patient, tetanusRows, ttSchedule, usePatientCache) {
  const findType = (type) => (tetanusRows || []).find((r) => String(r.type).toUpperCase() === type);
  const tt = findType('TT');
  const ats = findType('ATS');
  const cache = !!usePatientCache;
  const schedule = (ttSchedule || []).length
    ? ttSchedule
    : (tt && (tt.given || tt.date_given)
      ? [{
          dose_label: 'TT1',
          date_due: tt.date_given || null,
          date_given: tt.date_given || null,
          injection_site: tt.injection_site || (cache ? patient.tt_injection_site : null),
          vaccinated_by: tt.given_by || (cache ? patient.tt_given_by : null),
        }]
      : []);
  return {
    tetanus_toxoid: {
      given: !!(tt ? (tt.given || tt.date_given) : (cache && patient.tt_given)),
      dose_ml: (tt && tt.dose_ml) || (cache ? patient.tt_dose_ml : null) || null,
      injection_site: (tt && tt.injection_site) || (cache ? patient.tt_injection_site : null) || null,
      date_given: (tt && tt.date_given) || (cache ? patient.tt_date_given : null) || null,
      given_by: (tt && tt.given_by) || (cache ? patient.tt_given_by : null) || null,
      schedule,
    },
    ats: {
      given: !!(ats ? (ats.given || ats.date_given) : (cache && patient.ats_given)),
      dose_ml: (ats && ats.dose_ml) || (cache ? patient.ats_dose_ml : null) || null,
      injection_site: (ats && ats.injection_site) || (cache ? patient.ats_injection_site : null) || null,
      date_given: (ats && ats.date_given) || (cache ? patient.ats_date_given : null) || null,
      given_by: (ats && ats.given_by) || (cache ? patient.ats_given_by : null) || null,
      anst_result: (ats && ats.anst_result) || (cache ? patient.ats_anst_result : null) || null,
    },
  };
}

function mapRig(patient, rigRows, tetanusRows, usePatientCache) {
  const cache = !!usePatientCache;
  const htigTet = (tetanusRows || []).find((r) => String(r.type).toUpperCase() === 'HTIG');
  const equine = (rigRows || []).find((r) => String(r.rig_type).toLowerCase() === 'equine' && (r.rig_given || r.date_given));
  const human = (rigRows || []).find((r) => String(r.rig_type).toLowerCase() === 'human' && (r.rig_given || r.date_given));
  const brand = (r) => String((r && r.rig_brand) || '').toLowerCase();
  return {
    htig: {
      given: !!(htigTet ? (htigTet.given || htigTet.date_given) : (cache && patient.htig_given)),
      dose_ml: (htigTet && htigTet.dose_ml) || (cache ? patient.htig_dose_ml : null) || null,
      injection_site: (htigTet && htigTet.injection_site) || (cache ? patient.htig_injection_site : null) || null,
      route: (htigTet && htigTet.route) || (cache ? patient.htig_route : null) || null,
      date_given: (htigTet && htigTet.date_given) || (cache ? patient.htig_date_given : null) || null,
      given_by: (htigTet && htigTet.given_by) || (cache ? patient.htig_given_by : null) || null,
    },
    erig_equine: {
      given: !!(equine || (cache && patient.rig_equine_given)),
      equirab: !!(equine ? brand(equine).includes('equirab') : (cache && patient.rig_equirab)),
      vinrab: !!(equine ? brand(equine).includes('vinrab') : (cache && patient.rig_vinrab)),
      up_to_ml: (equine && equine.volume_ml) || (cache ? patient.rig_equine_up_to_ml : null) || null,
      anst_result: (equine && equine.anst_result) || (cache ? patient.rig_equine_anst : null) || null,
      date_given: (equine && equine.date_given) || (cache ? patient.rig_equine_date : null) || null,
      given_by: (equine && equine.given_by) || (cache ? patient.rig_equine_given_by : null) || null,
    },
    erig_human_berirab: {
      given: !!(human || (cache && (patient.rig_human_given || patient.rig_berirab))),
      berirab: !!(human ? brand(human).includes('berirab') || String(human.rig_type).toLowerCase() === 'human' : (cache && patient.rig_berirab)),
      up_to_ml: (human && human.volume_ml) || (cache ? patient.rig_human_up_to_ml : null) || null,
      date_given: (human && human.date_given) || (cache ? patient.rig_human_date : null) || null,
      given_by: (human && human.given_by) || (cache ? patient.rig_human_given_by : null) || null,
    },
  };
}

const ACTIVE_STATUSES = ['Ongoing', 'Incomplete', 'Treatment Interrupted', 'Due Today', 'Upcoming'];

function pickActiveCase(summaries) {
  if (!summaries || !summaries.length) return null;
  const open = [...summaries].reverse().find((s) => ACTIVE_STATUSES.includes(s.treatment_status));
  return open || summaries[summaries.length - 1];
}

function episodeForExposure(episodes, exp) {
  if (!exp) return null;
  return (episodes || []).find((e) => Number(e.exposure_id) === Number(exp.exposure_id))
    || (episodes || []).find((e) => Number(e.episode_number) === Number(exp.exposure_number))
    || null;
}

function summarizeCase(exp, ep) {
  const category = (ep && ep.category) || (exp && exp.category) || null;
  const view = {
    ...(ep || {}),
    category,
    vaccine_d0: ep ? ep.vaccine_d0 : null,
    vaccine_d3: ep ? ep.vaccine_d3 : null,
    vaccine_d7: ep ? ep.vaccine_d7 : null,
    vaccine_d14: ep ? ep.vaccine_d14 : null,
    vaccine_d28: ep ? ep.vaccine_d28 : null,
  };
  const computed = ep
    ? computeTreatmentStatus(view)
    : { treatmentStatus: 'Upcoming', completionPct: 0, completedDoses: 0, totalDoses: 0, nextDoseLabel: null, nextSchedule: null };
  const completionPct = computed.completionPct
    ?? (computed.totalDoses > 0 ? Math.round((computed.completedDoses / computed.totalDoses) * 100) : 0);
  return {
    case_number: (exp && exp.exposure_number) || (ep && ep.episode_number) || 1,
    exposure_id: exp ? exp.exposure_id : null,
    episode_id: ep ? ep.episode_id : null,
    date_of_exposure: (exp && exp.date_of_exposure) || null,
    barangay: (exp && exp.barangay) || null,
    place_of_exposure: (exp && exp.place_of_exposure) || null,
    category,
    type_of_animal: (exp && exp.type_of_animal) || null,
    type_of_exposure: (exp && exp.type_of_exposure) || null,
    site_of_exposure: (exp && exp.site_of_exposure) || null,
    outcome: ep ? ep.outcome : null,
    treatment_status: computed.treatmentStatus,
    completion_percent: completionPct,
    completed_doses: computed.completedDoses,
    total_doses: computed.totalDoses,
    remaining_doses: Math.max(0, (computed.totalDoses || 0) - (computed.completedDoses || 0)),
    next_dose_label: computed.nextDoseLabel || null,
    brand_name: (ep && ep.brand_name) || null,
    is_current: false,
  };
}

async function listPortalCases(pool, patientId) {
  const [exposures] = await pool.query(
    'SELECT * FROM patient_exposures WHERE patient_id = ? ORDER BY exposure_number ASC',
    [patientId]
  );
  const [episodes] = await pool.query(
    'SELECT * FROM treatment_episodes WHERE patient_id = ? ORDER BY episode_number ASC',
    [patientId]
  );
  const usedEpisode = new Set();
  const summaries = [];
  for (const exp of exposures || []) {
    const ep = episodeForExposure(episodes, exp);
    if (ep) usedEpisode.add(Number(ep.episode_id));
    summaries.push(summarizeCase(exp, ep));
  }
  for (const ep of episodes || []) {
    if (usedEpisode.has(Number(ep.episode_id))) continue;
    summaries.push(summarizeCase(null, ep));
  }
  summaries.sort((a, b) => Number(a.case_number) - Number(b.case_number));
  const active = pickActiveCase(summaries);
  summaries.forEach((s) => {
    s.is_current = !!(active && s.episode_id && Number(s.episode_id) === Number(active.episode_id));
  });
  return summaries;
}

async function loadPortalCase(pool, patientId, requestedEpisodeId) {
  const [[patientRow]] = await pool.query(
    'SELECT * FROM patients WHERE patient_id = ? LIMIT 1',
    [patientId]
  );
  if (!patientRow) return null;

  const patient = { ...patientRow };
  const [exposures] = await pool.query(
    'SELECT * FROM patient_exposures WHERE patient_id = ? ORDER BY exposure_number ASC',
    [patientId]
  );
  const [episodes] = await pool.query(
    'SELECT * FROM treatment_episodes WHERE patient_id = ? ORDER BY episode_number ASC',
    [patientId]
  );
  const cases = await listPortalCases(pool, patientId);

  let episodeId = requestedEpisodeId != null && requestedEpisodeId !== ''
    ? Number(requestedEpisodeId)
    : null;
  if (episodeId) {
    const owned = (episodes || []).some((e) => Number(e.episode_id) === episodeId);
    if (!owned) return { notFound: true, cases };
  } else {
    const active = cases.find((c) => c.is_current) || cases[cases.length - 1] || null;
    episodeId = active && active.episode_id ? Number(active.episode_id) : null;
  }

  const ep = (episodes || []).find((e) => Number(e.episode_id) === Number(episodeId)) || null;
  const exp = ep
    ? ((exposures || []).find((e) => Number(e.exposure_id) === Number(ep.exposure_id))
      || (exposures || []).find((e) => Number(e.exposure_number) === Number(ep.episode_number)))
    : ((exposures || []).slice(-1)[0] || null);
  copyCaseOntoPatient(patient, exp, ep);

  const computed = computeTreatmentStatus(patient);
  const completionPct = computed.completionPct
    ?? (computed.totalDoses > 0 ? Math.round((computed.completedDoses / computed.totalDoses) * 100) : 0);
  computed.completionPct = completionPct;

  let pepAll = [];
  if (episodeId) {
    [pepAll] = await pool.query(
      'SELECT * FROM patient_pep_schedule WHERE patient_id = ? AND episode_id = ? ORDER BY pep_id ASC',
      [patientId, episodeId]
    );
  }
  const pepRows = buildCurrentPep(patient, currentCycleRows(pepAll || [], ep));

  let tetanusRows = [];
  let rigRows = [];
  if (episodeId) {
    [tetanusRows] = await pool.query(
      'SELECT * FROM tetanus_records WHERE patient_id = ? AND episode_id = ? ORDER BY tetanus_id ASC',
      [patientId, episodeId]
    ).catch(() => [[]]);
    [rigRows] = await pool.query(
      'SELECT * FROM rig_records WHERE patient_id = ? AND episode_id = ? ORDER BY rig_id ASC',
      [patientId, episodeId]
    ).catch(() => [[]]);
  }
  const [ttSchedule] = await pool.query(
    'SELECT * FROM patient_tt_schedule WHERE patient_id = ? ORDER BY tt_id ASC',
    [patientId]
  ).catch(() => [[]]);

  let vaccineMeta = null;
  if (patient.brand_name) {
    [[vaccineMeta]] = await pool.query(
      'SELECT name, type, default_dose_ml FROM vaccines WHERE name = ? LIMIT 1',
      [patient.brand_name]
    ).catch(() => [[null]]);
  }

  const isCurrent = !!(cases.find((c) => c.is_current && Number(c.episode_id) === Number(episodeId)));
  const missedDoses = pepRows.filter((r) => !r.date_given && (r.status === 'Missed' || r.status === 'Overdue')).length;
  const selected = cases.find((c) => Number(c.episode_id) === Number(episodeId)) || null;
  const incomplete = computed.treatmentStatus === 'Incomplete' || computed.treatmentStatus === 'Treatment Interrupted';
  const nextPep = incomplete
    ? null
    : (pepRows.find((r) => !r.date_given && !['Missed', 'Stopped', 'Cancelled'].includes(r.status)) || null);

  return {
    patient,
    computed,
    pepRows,
    tetanus: mapTetanus(patient, tetanusRows, ttSchedule, isCurrent),
    rig: mapRig(patient, rigRows, tetanusRows, isCurrent),
    tetanusRows,
    rigRows,
    episodeId,
    exposureId: exp ? exp.exposure_id : null,
    cases,
    selectedCase: selected,
    isCurrent,
    vaccineMeta: vaccineMeta || null,
    arvClass: classifyArv(patient.brand_name, vaccineMeta && vaccineMeta.type),
    missedDoses,
    nextPep,
  };
}

module.exports = {
  loadPortalCase,
  listPortalCases,
  classifyArv,
  todayIso,
};
