'use strict';

const {
  barangayRiskTier,
  barangayName,
  computeRiskDistribution,
  animalBucket,
  sexCode,
  recordedAge,
  filterAnalyticsCases,
  isoDate,
} = require('./analyticsFilters');
const { computeTreatmentStatus } = require('./treatmentStatus');
const { linearRegression, trendFromSeries } = require('./remisAi');

function ageGroup(age) {
  const years = Number(age);
  if (!Number.isFinite(years)) return null;
  if (years <= 10) return '0-10';
  if (years <= 20) return '11-20';
  if (years <= 30) return '21-30';
  if (years <= 40) return '31-40';
  if (years <= 50) return '41-50';
  return '51+';
}

function overallRiskLabel(barangayCases) {
  const rank = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
  let best = '';
  let bestRank = 0;
  for (const row of barangayCases) {
    const label = barangayRiskTier(row.case_count).toUpperCase();
    if ((rank[label] || 0) > bestRank) {
      best = label;
      bestRank = rank[label];
    }
  }
  return best || 'NONE';
}

function classifyCases(cases) {
  let vaccCompleted = 0;
  let vaccOngoing = 0;
  let vaccOverdue = 0;
  let dueToday = 0;
  let dueThisWeek = 0;
  for (const row of cases) {
    const status = computeTreatmentStatus(row);
    if (status.treatmentStatus === 'Completed') vaccCompleted += 1;
    else if (Number(status.daysOverdue) > 0) vaccOverdue += 1;
    else vaccOngoing += 1;
    if (status.treatmentStatus === 'Due Today' || status.daysRemaining === 0) dueToday += 1;
    else if (status.daysRemaining != null && status.daysRemaining >= 1 && status.daysRemaining <= 7) dueThisWeek += 1;
  }
  return { vaccCompleted, vaccOngoing, vaccOverdue, dueToday, dueThisWeek };
}

function aggregateCases(cases) {
  const patients = new Map();
  const animals = { dog: 0, cat: 0, other: 0 };
  const barangays = new Map();
  const categories = new Map();
  const brands = new Map();
  const months = new Map();
  const quarters = new Map();
  const years = new Map();
  let maleCount = 0;
  let femaleCount = 0;
  let ageLt15 = 0;
  let ageGte15 = 0;
  const ageCounts = new Map();

  for (const row of cases) {
    const bucket = animalBucket(row.type_of_animal);
    if (bucket) animals[bucket] += 1;
    const place = barangayName(row);
    barangays.set(place, (barangays.get(place) || 0) + 1);
    const category = row.category == null || row.category === '' ? '' : String(row.category);
    if (category) categories.set(category, (categories.get(category) || 0) + 1);
    const brand = String(row.brand_name || '').trim();
    if (brand) brands.set(brand, (brands.get(brand) || 0) + 1);
    const date = isoDate(row.date_of_exposure);
    if (date) {
      const month = date.slice(0, 7);
      months.set(month, (months.get(month) || 0) + 1);
      const year = Number(date.slice(0, 4));
      const monthNum = Number(date.slice(5, 7));
      years.set(year, (years.get(year) || 0) + 1);
      const quarter = Math.ceil(monthNum / 3);
      quarters.set(quarter, (quarters.get(quarter) || 0) + 1);
    }
    patients.set(row.patient_id, true);
    const sex = sexCode(row.sex);
    if (sex === 'M') maleCount += 1;
    else if (sex === 'F') femaleCount += 1;
    const yearsOld = recordedAge(row.age);
    if (yearsOld != null) {
      if (yearsOld < 15) ageLt15 += 1;
      else ageGte15 += 1;
      const group = ageGroup(yearsOld);
      if (group) ageCounts.set(group, (ageCounts.get(group) || 0) + 1);
    }
  }
  const ageOrder = ['0-10', '11-20', '21-30', '31-40', '41-50', '51+'];
  const barangayCases = [...barangays.entries()]
    .map(([barangay, case_count]) => ({
      barangay,
      case_count,
      risk_level: barangayRiskTier(case_count),
    }))
    .sort((a, b) => b.case_count - a.case_count || a.barangay.localeCompare(b.barangay));

  return {
    totalPatients: patients.size,
    totalBites: cases.length,
    dogBites: animals.dog,
    catBites: animals.cat,
    otherBites: animals.other,
    maleCount,
    femaleCount,
    ageLt15,
    ageGte15,
    barangayCases,
    categoryData: [...categories.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => String(a.category).localeCompare(String(b.category))),
    ageData: ageOrder
      .filter((group) => ageCounts.has(group))
      .map((age_group) => ({ age_group, count: ageCounts.get(age_group) })),
    brandData: [...brands.entries()]
      .map(([brand_name, count]) => ({ brand_name, count }))
      .sort((a, b) => b.count - a.count || a.brand_name.localeCompare(b.brand_name)),
    monthlyTrend: [...months.entries()]
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    quarterlyData: [...quarters.entries()]
      .map(([quarter, count]) => ({ quarter, count }))
      .sort((a, b) => a.quarter - b.quarter),
    yearlyData: [...years.entries()]
      .map(([yr, count]) => ({ yr, count }))
      .sort((a, b) => a.yr - b.yr),
    ...classifyCases(cases),
  };
}

async function loadBiteCases(pool) {
  const [exposures] = await pool.query(`
    SELECT
      pe.exposure_id,
      pe.patient_id,
      DATE_FORMAT(pe.date_of_exposure, '%Y-%m-%d') AS date_of_exposure,
      COALESCE(NULLIF(TRIM(pe.barangay), ''), NULLIF(TRIM(p.barangay), ''), 'Unknown') AS barangay,
      pe.type_of_animal,
      pe.category AS exposure_category,
      pe.washing_of_bite,
      p.sex,
      p.age,
      p.rig_equirab,
      p.rig_vinrab,
      p.rig_berirab,
      p.rig_equine_given,
      p.rig_human_given,
      DATE_FORMAT(p.rig_equine_date, '%Y-%m-%d') AS rig_equine_date,
      DATE_FORMAT(p.rig_human_date, '%Y-%m-%d') AS rig_human_date
    FROM patient_exposures pe
    JOIN patients p ON p.patient_id = pe.patient_id
  `);
  const [episodes] = await pool.query(`
    SELECT
      exposure_id,
      episode_id,
      episode_number,
      category,
      status,
      outcome,
      brand_name,
      missed_dose,
      schedule_suspended,
      DATE_FORMAT(date_started, '%Y-%m-%d') AS date_started,
      DATE_FORMAT(missed_date, '%Y-%m-%d') AS missed_date,
      DATE_FORMAT(vaccine_d0, '%Y-%m-%d') AS vaccine_d0,
      DATE_FORMAT(vaccine_d3, '%Y-%m-%d') AS vaccine_d3,
      DATE_FORMAT(vaccine_d7, '%Y-%m-%d') AS vaccine_d7,
      DATE_FORMAT(vaccine_d14, '%Y-%m-%d') AS vaccine_d14,
      DATE_FORMAT(vaccine_d28, '%Y-%m-%d') AS vaccine_d28
    FROM treatment_episodes
    WHERE exposure_id IS NOT NULL
    ORDER BY exposure_id, episode_number DESC, episode_id DESC
  `);
  const latest = new Map();
  for (const episode of episodes) {
    if (!latest.has(episode.exposure_id)) latest.set(episode.exposure_id, episode);
  }
  return exposures.map((row) => {
    const episode = latest.get(row.exposure_id) || {};
    return {
      exposure_id: row.exposure_id,
      patient_id: row.patient_id,
      episode_id: episode.episode_id || null,
      date_of_exposure: row.date_of_exposure,
      barangay: row.barangay,
      type_of_animal: row.type_of_animal,
      washing_of_bite: row.washing_of_bite,
      sex: row.sex,
      age: row.age,
      rig_equirab: row.rig_equirab,
      rig_vinrab: row.rig_vinrab,
      rig_berirab: row.rig_berirab,
      rig_equine_given: row.rig_equine_given,
      rig_human_given: row.rig_human_given,
      rig_equine_date: row.rig_equine_date,
      rig_human_date: row.rig_human_date,
      category: episode.category != null ? episode.category : row.exposure_category,
      status: episode.status || null,
      outcome: episode.outcome || null,
      brand_name: episode.brand_name || null,
      missed_dose: episode.missed_dose || null,
      missed_date: episode.missed_date || null,
      schedule_suspended: episode.schedule_suspended || 0,
      date_started: episode.date_started || null,
      vaccine_d0: episode.vaccine_d0 || null,
      vaccine_d3: episode.vaccine_d3 || null,
      vaccine_d7: episode.vaccine_d7 || null,
      vaccine_d14: episode.vaccine_d14 || null,
      vaccine_d28: episode.vaccine_d28 || null,
    };
  });
}

function barangayChoices(cases, officialBarangays) {
  const seen = new Set();
  const names = [];
  const add = (name) => {
    const clean = String(name || '').trim();
    const key = clean.toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    names.push(clean);
  };
  for (const name of officialBarangays || []) add(name);
  for (const row of cases || []) add(row.barangay);
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

/**
 * Quarterly Comparison is a year view. Quarter, month, and custom date
 * filters still apply to the rest of the dashboard, but they must not
 * hide the other quarters of the selected year.
 */
function casesForQuarterComparison(cases, query, officialBarangays) {
  const yearQuery = { ...query, officialBarangays };
  delete yearQuery.month;
  delete yearQuery.quarter;
  delete yearQuery.dateFrom;
  delete yearQuery.dateTo;
  return filterAnalyticsCases(cases, yearQuery).cases;
}

function buildFullAnalytics(cases, query, officialBarangays) {
  const filtered = filterAnalyticsCases(cases, { ...query, officialBarangays });
  const stats = aggregateCases(filtered.cases);
  const quarterlyComparison = aggregateCases(
    casesForQuarterComparison(cases, query, officialBarangays)
  ).quarterlyData;
  const topBarangay = stats.barangayCases[0] || null;
  const mostCommonAnimal = stats.dogBites >= stats.catBites && stats.dogBites >= stats.otherBites
    ? 'Dogs'
    : stats.catBites >= stats.otherBites ? 'Cats' : 'Other Animals';
  const vaccRate = stats.totalBites > 0
    ? Math.round((stats.vaccCompleted / stats.totalBites) * 100)
    : 0;
  return {
    summary: {
      totalPatients: stats.totalPatients,
      totalBites: stats.totalBites,
      dogBites: stats.dogBites,
      catBites: stats.catBites,
      otherBites: stats.otherBites,
      vaccCompleted: stats.vaccCompleted,
      vaccOngoing: stats.vaccOngoing,
      vaccOverdue: stats.vaccOverdue,
      dueToday: stats.dueToday,
      dueThisWeek: stats.dueThisWeek,
      maleCount: stats.maleCount,
      femaleCount: stats.femaleCount,
      ageLt15: stats.ageLt15,
      ageGte15: stats.ageGte15,
      vaccRate,
      affectedBarangays: stats.barangayCases.length,
      highestBarangay: topBarangay ? topBarangay.barangay : 'N/A',
      highestBarangayCases: topBarangay ? topBarangay.case_count : 0,
      mostCommonAnimal,
      overallRisk: overallRiskLabel(stats.barangayCases),
    },
    monthlyTrend: stats.monthlyTrend,
    barangayCases: stats.barangayCases,
    categoryData: stats.categoryData,
    ageData: stats.ageData,
    brandData: stats.brandData,
    quarterlyData: quarterlyComparison,
    periodQuarterlyData: stats.quarterlyData,
    yearlyData: stats.yearlyData,
    riskDistribution: computeRiskDistribution(stats.barangayCases),
    barangayList: barangayChoices(cases, officialBarangays),
    filterMeta: {
      year: filtered.window.year,
      quarter: filtered.window.quarter,
      month: filtered.window.month,
      startDate: filtered.window.startDate,
      endDate: filtered.window.endDate,
      chartYear: Number(String(filtered.window.startDate).slice(0, 4)) || filtered.window.year,
      riskLevel: query.riskLevel || 'all',
      animalType: query.animalType || 'all',
      barangay: query.barangay || 'all',
    },
  };
}

function buildNurseSummary(cases, query) {
  const report = buildFullAnalytics(cases, query || {}, []);
  const s = report.summary;
  const cats = { I: 0, II: 0, III: 0 };
  for (const row of report.categoryData) {
    const category = String(row.category);
    if (category === '1') cats.I += Number(row.count);
    else if (category === '2') cats.II += Number(row.count);
    else if (category === '3') cats.III += Number(row.count);
  }
  const monthlyValues = report.monthlyTrend.map((row) => Number(row.count));
  const regression = linearRegression(monthlyValues);
  const trend = trendFromSeries(monthlyValues);
  const monthlyCases = {};
  for (const row of report.monthlyTrend) monthlyCases[row.month] = Number(row.count);
  return {
    period: {
      year: report.filterMeta.year,
      quarter: report.filterMeta.quarter,
      month: report.filterMeta.month,
      startDate: report.filterMeta.startDate,
      endDate: report.filterMeta.endDate,
    },
    totalPatients: s.totalPatients,
    totalCases: s.totalBites,
    categoryI: cats.I,
    categoryII: cats.II,
    categoryIII: cats.III,
    topAnimal: s.dogBites >= s.catBites && s.dogBites >= s.otherBites ? 'Dog'
      : s.catBites >= s.otherBites ? 'Cat' : 'Other',
    animalDistribution: { dog: s.dogBites, cat: s.catBites, other: s.otherBites },
    highestCaseBarangay: s.highestBarangay === 'N/A' ? null : s.highestBarangay,
    highestCaseBarangayCases: s.highestBarangayCases,
    barangayDistribution: report.barangayCases,
    overduePatients: s.vaccOverdue,
    incompleteVaccinations: s.vaccOngoing,
    completedVaccinations: s.vaccCompleted,
    dueToday: s.dueToday,
    dueThisWeek: s.dueThisWeek,
    vaccinationCompletionRate: s.vaccRate,
    monthlyCases,
    quarterlyCases: report.periodQuarterlyData,
    yearlyCases: report.yearlyData.map((row) => ({ year: row.yr, count: row.count })),
    trend,
    predictedNextMonth: regression.next,
    predictedNextQuarter: Math.max(0, Math.round(regression.next * 3)),
    predictionMethod: 'linear_regression',
    regression: { slope: regression.slope, r2: regression.r2, n: regression.n },
    dataSufficient: monthlyValues.length >= 2 && s.totalBites > 0,
  };
}

module.exports = {
  loadBiteCases,
  buildFullAnalytics,
  buildNurseSummary,
  aggregateCases,
};
