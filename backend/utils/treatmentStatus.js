const { pepDaysForCategory, computeOutcome, treatmentStatusFromOutcome } = require('./patientRecordSync');
const { localTodayIso, toSqlDate } = require('./dateOnly');
const {
  isEpisodeIncomplete, findMissedDose, nextDueDose, scheduleForEpisode, dayDiff, cycleNumber,
  RESTART_STATUS, SCHEDULE_STATUS,
} = require('./missedDose');

const DOSE_SCHEDULE = [
  { label: 'Day 0',  key: 'vaccine_d0',  days: 0  },
  { label: 'Day 3',  key: 'vaccine_d3',  days: 3  },
  { label: 'Day 7',  key: 'vaccine_d7',  days: 7  },
  { label: 'Day 14', key: 'vaccine_d14', days: 14 },
  { label: 'Day 28', key: 'vaccine_d28', days: 28 },
];

function requiredSchedule(patient) {
  const days = pepDaysForCategory(patient && patient.category);
  return days.map((d) => DOSE_SCHEDULE.find((s) => s.days === d)).filter(Boolean);
}

function countCompletedDoses(patient) {
  return requiredSchedule(patient).filter((s) => patient[s.key]).length;
}

/**
 * Display status for a patient row or an episode row. A missed dose is
 * reported as Incomplete immediately, even before the scheduler persists it.
 */
function computeTreatmentStatus(patient, todayIso = localTodayIso()) {
  const schedule = requiredSchedule(patient);
  const totalDoses = schedule.length;
  const completedDoses = countCompletedDoses(patient);
  const outcome = computeOutcome(patient && patient.category, patient || {});
  const completionPct = totalDoses > 0 ? Math.round((completedDoses / totalDoses) * 100) : 0;
  const cycle = cycleNumber(patient);

  const persisted = isEpisodeIncomplete(patient);
  const detected = !persisted && outcome !== 'C' ? findMissedDose(patient, todayIso) : null;
  if (persisted || detected) {
    const missedDose = persisted ? (patient.missed_dose || null) : detected.label;
    const missedDate = persisted ? toSqlDate(patient.missed_date) : detected.due;
    const delay = missedDate ? Math.max(0, dayDiff(missedDate, todayIso)) : null;
    return {
      completedDoses,
      totalDoses,
      completionPct,
      nextSchedule: null,
      nextDoseLabel: null,
      treatmentStatus: 'Incomplete',
      scheduleStatus: SCHEDULE_STATUS.STOPPED,
      restartStatus: RESTART_STATUS.REQUIRED,
      missedDose,
      missedDate,
      daysRemaining: null,
      daysOverdue: delay,
      daysDelayed: delay,
      scheduleSuspended: true,
      treatmentCycle: cycle,
    };
  }

  // Check if treatment is completed BEFORE calculating next dose
  if (outcome === 'C' || (totalDoses > 0 && completedDoses === totalDoses)) {
    return {
      completedDoses,
      totalDoses,
      completionPct: 100,
      nextSchedule: null,
      nextDoseLabel: null,
      treatmentStatus: treatmentStatusFromOutcome('C'),
      scheduleStatus: SCHEDULE_STATUS.ACTIVE,
      restartStatus: cycle > 1 ? RESTART_STATUS.CONFIRMED : null,
      missedDose: null,
      missedDate: null,
      daysRemaining: null,
      daysOverdue: null,
      daysDelayed: null,
      scheduleSuspended: false,
      treatmentCycle: cycle,
    };
  }

  const next = nextDueDose(patient);
  const nextSchedule = next ? next.due : null;
  const daysRemaining = nextSchedule ? dayDiff(todayIso, nextSchedule) : null;

  let treatmentStatus;
  if (!nextSchedule) {
    treatmentStatus = completedDoses === 0 ? 'Upcoming' : 'Ongoing';
  } else if (daysRemaining === 0) {
    treatmentStatus = 'Due Today';
  } else if (daysRemaining === 1) {
    treatmentStatus = 'Upcoming';
  } else {
    treatmentStatus = 'Ongoing';
  }

  return {
    completedDoses,
    totalDoses,
    completionPct,
    nextSchedule: nextSchedule || toSqlDate(patient.next_schedule) || null,
    nextDoseLabel: next ? next.label : null,
    treatmentStatus,
    scheduleStatus: SCHEDULE_STATUS.ACTIVE,
    restartStatus: cycle > 1 ? RESTART_STATUS.CONFIRMED : null,
    missedDose: null,
    missedDate: null,
    daysRemaining,
    daysOverdue: null,
    daysDelayed: null,
    scheduleSuspended: false,
    treatmentCycle: cycle,
  };
}

/** Next unadministered dose of the current cycle ({ label, key, dateDue: 'YYYY-MM-DD' }). */
function getNextDueDose(patient) {
  const next = nextDueDose(patient);
  return next ? { label: next.label, key: next.key, dateDue: next.due } : null;
}

module.exports = {
  DOSE_SCHEDULE,
  computeTreatmentStatus,
  countCompletedDoses,
  getNextDueDose,
  scheduleForEpisode,
};
