'use strict';

/**
 * Single calculation path for the Geographic Mapping & AI Analytics Report.
 * Summary cards, rankings, animal distribution, predictions, and the AI
 * payload all read this result. Nothing here is a demo or hardcoded case count.
 *
 * Risk levels use the configured case-count tiers (same legend as the report):
 *   No Cases 0, Low 1–4, Medium 5–9, High 10–19, Critical 20+.
 * A population risk rate (cases / population × 1,000) is used for ranking only
 * when the caller sets riskBasis to "population" and every barangay with cases
 * has a population greater than zero. This installation's configured basis is
 * case count; barangay population is not part of the schema unless a table
 * actually stores it.
 */

const { barangayRiskTier, barangayName, animalBucket } = require('./analyticsFilters');
const { toSqlDate } = require('./dateOnly');
const {
  buildGeoPredictions,
  monthlyCountsBetween,
  predictionBand,
} = require('./remisAi');

const INSUFFICIENT_PREDICTION = 'Insufficient Data for Reliable Prediction';

const RISK_CRITERIA = 'No Cases = 0; Low = 1–4; Medium = 5–9; High = 10–19; Critical = 20 or more recorded cases in the barangay';

function joinNames(names) {
  const list = (names || []).filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return `${list[0]} & ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} & ${list[list.length - 1]}`;
}

function formatPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  const hundredths = Math.round(n * 100);
  if (hundredths % 100 === 0) return String(hundredths / 100);
  const text = (hundredths / 100).toFixed(2);
  return text.replace(/0$/, '').replace(/\.0$/, '');
}

/** Largest-remainder split so the shares add to exactly 100. */
function percentShares(counts) {
  const safe = (counts || []).map((n) => Math.max(0, Number(n) || 0));
  const total = safe.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return safe.map(() => '0');
  const units = 10000;
  const raw = safe.map((n) => (n * units) / total);
  const base = raw.map((n) => Math.floor(n));
  let leftover = units - base.reduce((sum, n) => sum + n, 0);
  const order = raw
    .map((n, index) => ({ index, frac: n - Math.floor(n) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  let cursor = 0;
  while (leftover > 0 && order.length) {
    base[order[cursor % order.length].index] += 1;
    leftover -= 1;
    cursor += 1;
  }
  return base.map((n) => formatPct(n / 100));
}

function enumeratedMonths(startDate, endDate) {
  const start = String(startDate || '').slice(0, 7);
  const end = String(endDate || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(start) || !/^\d{4}-\d{2}$/.test(end)) return [];
  const out = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const endY = Number(end.slice(0, 4));
  const endM = Number(end.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function monthKey(value) {
  const day = toSqlDate(value);
  return day ? day.slice(0, 7) : '';
}

function countByMonth(cases) {
  const map = new Map();
  for (const row of cases || []) {
    const key = monthKey(row.case_date || row.date_of_exposure);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].map(([month, count]) => ({ month, count }));
}

function populationFor(populations, barangay) {
  if (!populations) return null;
  const key = String(barangay || '').trim().toLowerCase();
  if (!key) return null;
  if (typeof populations.get === 'function') {
    const value = populations.get(key);
    return value == null ? null : Number(value);
  }
  const value = populations[key] != null ? populations[key] : populations[barangay];
  return value == null ? null : Number(value);
}

function casesPerThousand(caseCount, population) {
  if (!population || population <= 0) return null;
  return Number(((caseCount / population) * 1000).toFixed(4));
}

function countAnimals(cases) {
  let dog = 0;
  let cat = 0;
  let other = 0;
  for (const row of cases || []) {
    const bucket = animalBucket(row.type_of_animal);
    if (bucket === 'dog') dog += 1;
    else if (bucket === 'cat') cat += 1;
    else other += 1;
  }
  return { dog, cat, other };
}

function assignRanks(rows, score) {
  const ranked = [];
  rows.forEach((row, index) => {
    let rank = index + 1;
    if (index > 0 && score(row) === score(rows[index - 1])) rank = ranked[index - 1].rank;
    ranked.push({ ...row, rank });
  });
  return ranked.map((row) => {
    const tied = ranked.filter((other) => other.rank === row.rank).length > 1;
    return {
      ...row,
      tied,
      rankLabel: tied ? `${row.rank} (Tie)` : String(row.rank),
    };
  });
}

function overallRiskFromRows(rows, totalCases) {
  if (!totalCases) {
    return {
      level: 'No Cases',
      basis: `Configured case-count criteria (${RISK_CRITERIA}). No animal bite cases were recorded in this reporting period.`,
    };
  }
  const withCases = (rows || []).filter((row) => row.case_count > 0 && row.risk_level && row.risk_level !== 'None');
  if (!withCases.length) {
    return {
      level: 'Insufficient Data',
      basis: 'Cases were recorded, but they could not be matched to a barangay, so the configured risk criteria were not applied.',
    };
  }
  const order = { Low: 1, Medium: 2, High: 3, Critical: 4 };
  let level = withCases[0].risk_level;
  for (const row of withCases) {
    if ((order[row.risk_level] || 0) > (order[level] || 0)) level = row.risk_level;
  }
  return {
    level,
    basis: `Configured case-count criteria (${RISK_CRITERIA}). The highest barangay tier in this period is ${level}.`,
  };
}

function presentPrediction(value, series, reliable) {
  if (!reliable || value == null) {
    return {
      value: null,
      range: INSUFFICIENT_PREDICTION,
      display: INSUFFICIENT_PREDICTION,
      estimated: false,
    };
  }
  return { ...predictionBand(value, series), estimated: true };
}

/**
 * @param {object} input
 * @param {object[]} input.periodCases risk-filtered cases for the reporting period
 * @param {object[]} [input.historyCases] same case grain across the lookback window
 * @param {string} [input.historyStart]
 * @param {string} [input.historyEnd]
 * @param {Map<string, number>|object|null} [input.populations] lowercase barangay -> population
 * @param {'case_count'|'population'} [input.riskBasis]
 * @param {string} [input.periodLabel]
 * @param {string} [input.selectedRisk]
 * @param {string[]} [input.zeroBarangays]
 */
function buildGeographicAnalytics(input = {}) {
  const periodCases = input.periodCases || [];
  const selectedRisk = input.selectedRisk || 'all';
  const total = periodCases.length;
  const animalCounts = countAnimals(periodCases);
  const animalPct = percentShares([animalCounts.dog, animalCounts.cat, animalCounts.other]);
  const animalDistribution = {
    dog: { count: animalCounts.dog, pct: animalPct[0] },
    cat: { count: animalCounts.cat, pct: animalPct[1] },
    other: { count: animalCounts.other, pct: animalPct[2] },
    total,
  };

  const animalLeaders = [
    { type: 'Dog', count: animalCounts.dog },
    { type: 'Cat', count: animalCounts.cat },
    { type: 'Other Animals', count: animalCounts.other },
  ];
  const animalMax = Math.max(animalCounts.dog, animalCounts.cat, animalCounts.other);
  const leadingAnimals = animalMax > 0 ? animalLeaders.filter((row) => row.count === animalMax) : [];
  const mostCommonAnimal = leadingAnimals.length
    ? (leadingAnimals.length > 1 ? `${joinNames(leadingAnimals.map((row) => row.type))} (Tie)` : leadingAnimals[0].type)
    : 'N/A';

  const populations = input.populations || null;
  const counted = new Map();
  for (const row of periodCases) {
    const name = barangayName(row);
    counted.set(name, (counted.get(name) || 0) + 1);
  }

  let basis = 'case_count';
  const namedRows = [...counted.entries()].map(([barangay, case_count]) => {
    const population = populationFor(populations, barangay);
    return {
      barangay,
      case_count,
      population: population && population > 0 ? population : null,
      risk_rate: casesPerThousand(case_count, population),
      risk_level: barangayRiskTier(case_count),
    };
  });
  const populationComplete = namedRows.length > 0 && namedRows.every((row) => row.population > 0);
  if (input.riskBasis === 'population' && populationComplete) basis = 'population';

  const score = (row) => (basis === 'population' ? Number(row.risk_rate) : Number(row.case_count));
  namedRows.sort((a, b) => score(b) - score(a) || a.barangay.localeCompare(b.barangay));

  const shares = percentShares(namedRows.map((row) => row.case_count));
  const withShares = namedRows.map((row, index) => ({
    ...row,
    percentage: shares[index],
  }));
  const ranked = assignRanks(withShares, score);

  let brgyCases = ranked;
  if (selectedRisk === 'None') {
    brgyCases = (input.zeroBarangays || []).map((barangay) => ({
      barangay,
      case_count: 0,
      population: populationFor(populations, barangay),
      risk_rate: null,
      risk_level: 'None',
      percentage: '0',
      rank: null,
      tied: false,
      rankLabel: '—',
    }));
  }

  const withCases = ranked.filter((row) => row.case_count > 0);
  const topScore = withCases.length ? score(withCases[0]) : null;
  const leaders = topScore == null ? [] : withCases.filter((row) => score(row) === topScore);
  const leaderNames = leaders.map((row) => row.barangay);
  const highestRiskTied = leaderNames.length > 1;
  let highestRiskBarangay = 'Insufficient Data';
  if (total === 0) highestRiskBarangay = 'No Cases';
  else if (leaderNames.length === 1) highestRiskBarangay = leaderNames[0];
  else if (leaderNames.length > 1) highestRiskBarangay = `${joinNames(leaderNames)} (Tie)`;

  const overall = overallRiskFromRows(withCases, total);
  const topBarangays = selectedRisk === 'None' ? brgyCases.slice(0, 10) : withCases;

  const historyRows = countByMonth(input.historyCases && input.historyCases.length
    ? input.historyCases
    : periodCases);
  const monthKeys = enumeratedMonths(input.historyStart, input.historyEnd);
  const filled = monthKeys.length
    ? monthlyCountsBetween(historyRows, input.historyStart, input.historyEnd)
    : historyRows.map((row) => row.count);
  const keys = monthKeys.length ? monthKeys : historyRows.map((row) => row.month);
  const firstPositive = filled.findIndex((value) => value > 0);
  const usedValues = firstPositive < 0 ? [] : filled.slice(firstPositive);
  const usedMonths = firstPositive < 0
    ? []
    : keys.slice(firstPositive).map((month, index) => ({
      month,
      recordedCases: usedValues[index],
    }));

  const geoPred = buildGeoPredictions(usedValues, total);
  const monthBand = presentPrediction(geoPred.nextMonth, usedValues, geoPred.reliable);
  const quarterBand = presentPrediction(geoPred.nextQuarter, usedValues.map((value) => value * 3), geoPred.reliable);
  const historicalRecordedCases = usedMonths.reduce((sum, row) => sum + row.recordedCases, 0);

  const animalNote = total === 0
    ? 'No animal bite cases were recorded for this reporting period.'
    : `Dog = ${animalCounts.dog} (${animalDistribution.dog.pct}%), Cat = ${animalCounts.cat} (${animalDistribution.cat.pct}%), Other Animals = ${animalCounts.other} (${animalDistribution.other.pct}%).`;

  const aiPayload = {
    reportingPeriod: input.periodLabel || '',
    totalCases: total,
    affectedBarangays: withCases.length,
    highestRiskBarangay,
    highestRiskBarangays: leaderNames,
    highestRiskTied,
    highestRiskCases: leaders[0] ? leaders[0].case_count : 0,
    highestRiskPercentage: leaders[0] ? leaders[0].percentage : '0',
    recordedBarangays: withCases.map((row) => row.barangay),
    topBarangays: topBarangays.map((row) => ({
      barangay: row.barangay,
      cases: row.case_count,
      percentage: row.percentage,
      risk_level: row.risk_level,
      rank: row.rank,
      tied: row.tied,
    })),
    topBarangay: highestRiskBarangay,
    topBarangayCases: leaders[0] ? leaders[0].case_count : 0,
    animalDistribution,
    dogPct: Number(animalDistribution.dog.pct) || 0,
    catPct: Number(animalDistribution.cat.pct) || 0,
    otherPct: Number(animalDistribution.other.pct) || 0,
    mostCommonAnimal,
    mostCommonAnimalTied: leadingAnimals.length > 1,
    overallRiskLevel: overall.level,
    overallRiskBasis: overall.basis,
    riskBasis: basis,
    populationAvailable: populationComplete,
    riskCriteria: RISK_CRITERIA,
    historicalTrend: geoPred.trend,
    predictionReliable: geoPred.reliable === true,
    predictedNextMonth: monthBand.value,
    predictedNextMonthDisplay: monthBand.display,
    predictedNextQuarter: quarterBand.value,
    predictedNextQuarterDisplay: quarterBand.display,
    historicalRecordedCases,
    historicalMonthsWithCases: usedMonths.filter((row) => row.recordedCases > 0).length,
    historicalMonthsUsed: usedMonths.length,
    currentRecordedCases: total,
    historicalMonths: usedMonths,
  };

  return {
    total,
    affectedBarangays: withCases.length,
    highestRiskBarangay,
    highestRiskBarangayCases: leaders[0] ? leaders[0].case_count : 0,
    highestRiskTied,
    highestRiskBarangays: leaderNames,
    mostCommonAnimal,
    animalNote,
    overallRiskLevel: overall.level,
    overallRiskBasis: overall.basis,
    riskBasis: basis,
    populationAvailable: populationComplete,
    topBarangays,
    barangayCases: selectedRisk === 'None' ? brgyCases : ranked,
    animalDistribution,
    predictions: {
      historicalRecordedCases,
      historicalMonthsWithCases: aiPayload.historicalMonthsWithCases,
      historicalMonthsUsed: usedMonths.length,
      historicalMonths: usedMonths,
      currentRecordedCases: total,
      nextMonth: monthBand,
      nextQuarter: quarterBand,
      highestRecordedBarangay: highestRiskBarangay,
      expectedHighestBarangay: highestRiskBarangay,
      highestRecordedNote: total === 0
        ? 'No cases were recorded in this reporting period.'
        : 'Recorded this period. Not a forecast.',
      trend: geoPred.trend,
      reliable: geoPred.reliable === true,
      reliability: geoPred.reliability,
      method: geoPred.reliable ? 'linear_regression' : null,
      regression: geoPred.reliable
        ? { slope: geoPred.slope, intercept: geoPred.intercept, r2: geoPred.r2, n: geoPred.n }
        : null,
    },
    aiPayload,
  };
}

/**
 * Read barangay population only when MySQL actually has a population column
 * on a non-patient reference table. Returns null when it does not.
 */
async function loadBarangayPopulations(pool) {
  if (!pool || typeof pool.query !== 'function') return null;
  try {
    const [popCols] = await pool.query(`
      SELECT TABLE_NAME AS tableName, COLUMN_NAME AS populationColumn
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND LOWER(COLUMN_NAME) IN ('population', 'barangay_population', 'total_population')
    `);
    for (const col of popCols || []) {
      if (String(col.tableName).toLowerCase() === 'patients') continue;
      const [nameCols] = await pool.query(`
        SELECT COLUMN_NAME AS columnName
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
          AND LOWER(COLUMN_NAME) IN ('barangay', 'barangay_name', 'name')
        LIMIT 1
      `, [col.tableName]);
      if (!nameCols.length) continue;
      const nameCol = nameCols[0].columnName;
      const popCol = col.populationColumn;
      const tableName = col.tableName;
      if (!/^[A-Za-z0-9_]+$/.test(tableName) || !/^[A-Za-z0-9_]+$/.test(nameCol) || !/^[A-Za-z0-9_]+$/.test(popCol)) {
        continue;
      }
      const [rows] = await pool.query(
        `SELECT \`${nameCol}\` AS barangay, \`${popCol}\` AS population FROM \`${tableName}\``
      );
      const map = new Map();
      for (const row of rows || []) {
        const name = String(row.barangay || '').trim().toLowerCase();
        const population = Number(row.population);
        if (name && Number.isFinite(population) && population > 0) map.set(name, population);
      }
      if (map.size) return map;
    }
  } catch (err) {
    return null;
  }
  return null;
}

module.exports = {
  INSUFFICIENT_PREDICTION,
  RISK_CRITERIA,
  joinNames,
  formatPct,
  percentShares,
  buildGeographicAnalytics,
  loadBarangayPopulations,
};
