'use strict';

const { barangayRiskTier } = require('./analyticsFilters');

function joinNames(names) {
  const list = (names || []).filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return `${list[0]} & ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} & ${list[list.length - 1]}`;
}

/**
 * Map sidebar facts from barangay case rows already counted for the selected period.
 * A tie keeps every barangay at that count. Lowest-risk names are only barangays
 * with a strictly smaller recorded count than the highest.
 */
function buildMapSummary(barangayCases, trend) {
  const rows = (barangayCases || []).map((row) => {
    const caseCount = Number(row.case_count) || 0;
    return {
      barangay: String(row.barangay || 'Unknown').trim() || 'Unknown',
      case_count: caseCount,
      dog_cases: Number(row.dog_cases) || 0,
      cat_cases: Number(row.cat_cases) || 0,
      other_cases: Number(row.other_cases) || 0,
      risk_level: row.risk_level || barangayRiskTier(caseCount),
    };
  });

  const total = rows.reduce((sum, row) => sum + row.case_count, 0);
  const withCases = rows
    .filter((row) => row.case_count > 0)
    .sort((a, b) => b.case_count - a.case_count || a.barangay.localeCompare(b.barangay));

  const maxCount = withCases.length ? withCases[0].case_count : 0;
  const leaders = withCases.filter((row) => row.case_count === maxCount);
  const minCount = withCases.length ? withCases[withCases.length - 1].case_count : 0;
  const lowest = maxCount > minCount
    ? withCases.filter((row) => row.case_count === minCount)
    : [];

  const dog = rows.reduce((sum, row) => sum + row.dog_cases, 0);
  const cat = rows.reduce((sum, row) => sum + row.cat_cases, 0);
  const other = rows.reduce((sum, row) => sum + row.other_cases, 0);
  const animalMax = Math.max(dog, cat, other);
  const animalLeaders = [
    { type: 'Dog', count: dog },
    { type: 'Cat', count: cat },
    { type: 'Other', count: other },
  ].filter((row) => animalMax > 0 && row.count === animalMax);

  const tierRank = { Low: 1, Medium: 2, High: 3, Critical: 4 };
  let riskLevel = 'No Cases';
  if (total > 0 && withCases.length) {
    riskLevel = withCases[0].risk_level;
    for (const row of withCases) {
      if ((tierRank[row.risk_level] || 0) > (tierRank[riskLevel] || 0)) riskLevel = row.risk_level;
    }
  } else if (total > 0) {
    riskLevel = 'Insufficient Data';
  }

  const highestBarangay = !leaders.length
    ? 'N/A'
    : leaders.length === 1
      ? leaders[0].barangay
      : `${joinNames(leaders.map((row) => row.barangay))} (Tie)`;

  return {
    totalCases: total,
    affectedBarangays: withCases.length,
    highestBarangay,
    highestBarangays: leaders.map((row) => row.barangay),
    highestBarangayCases: maxCount,
    highestTied: leaders.length > 1,
    lowestRiskBarangays: lowest.map((row) => ({
      barangay: row.barangay,
      case_count: row.case_count,
      risk_level: row.risk_level,
    })),
    mostCommonAnimal: animalLeaders.length > 1
      ? `${joinNames(animalLeaders.map((row) => row.type))} (Tie)`
      : (animalLeaders[0] ? animalLeaders[0].type : 'N/A'),
    animalCounts: { dog, cat, other },
    riskLevel,
    trend: trend || {
      direction: 'none',
      change: 0,
      previousTotal: null,
      currentTotal: total,
      label: 'No prior period',
    },
  };
}

module.exports = {
  joinNames,
  buildMapSummary,
};
