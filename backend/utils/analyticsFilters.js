function barangayRiskTier(count) {
  if (!count || count === 0) return 'None';
  if (count >= 20) return 'Critical';
  if (count >= 10) return 'High';
  if (count >= 5) return 'Medium';
  return 'Low';
}

function riskHavingClause(riskLevel) {
  switch (riskLevel) {
    case 'None':     return 'COUNT(*) = 0';
    case 'Low':      return 'COUNT(*) BETWEEN 1 AND 4';
    case 'Medium':   return 'COUNT(*) BETWEEN 5 AND 9';
    case 'High':     return 'COUNT(*) BETWEEN 10 AND 19';
    case 'Critical': return 'COUNT(*) >= 20';
    default:         return null;
  }
}

/**
 * Build SQL WHERE clause and params from analytics query filters.
 * @param {object} query - req.query fields
 * @param {string} [tableAlias] - optional table alias prefix (e.g. 'p') for date_registered, barangay, type_of_animal
 */
function buildAnalyticsWhere(query, tableAlias) {
  const { month, quarter, year, barangay, animalType, dateFrom, dateTo, riskLevel } = query;
  const conditions = [];
  const params = [];

  // Build column references with optional alias prefix
  const col = (name) => tableAlias ? `${tableAlias}.${name}` : name;

  if (dateFrom && dateTo) {
    conditions.push(`${col('date_registered')} BETWEEN ? AND ?`);
    params.push(dateFrom, dateTo);
  } else {
    if (year) {
      conditions.push(`YEAR(${col('date_registered')}) = ?`);
      params.push(parseInt(year, 10));
    }
    if (month) {
      conditions.push(`MONTH(${col('date_registered')}) = ?`);
      params.push(parseInt(month, 10));
    } else if (quarter) {
      const q = parseInt(quarter, 10);
      conditions.push(`MONTH(${col('date_registered')}) BETWEEN ? AND ?`);
      params.push((q - 1) * 3 + 1, q * 3);
    }
  }

  if (barangay && barangay !== 'all') {
    conditions.push(`${col('barangay')} = ?`);
    params.push(barangay);
  }

  if (animalType && animalType !== 'all') {
    const map = { Dog: ['D', 'SD'], Cat: ['C'], Other: ['O'] };
    const codes = map[animalType] || (['D', 'SD', 'C', 'O'].includes(animalType) ? [animalType] : null);
    if (codes) {
      conditions.push(`${col('type_of_animal')} IN (${codes.map(() => '?').join(',')})`);
      params.push(...codes);
    }
  }

  const baseWhere = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const baseParams = [...params];

  const having = riskHavingClause(riskLevel);
  if (having) {
    const inner = buildAnalyticsWhere(
      { month, quarter, year, barangay, animalType, dateFrom, dateTo },
      null
    );
    const innerWhere = inner.baseWhere || 'WHERE 1=1';
    conditions.push(`${col('barangay')} IN (
      SELECT ranked.barangay FROM (
        SELECT barangay FROM patients ${innerWhere}
        GROUP BY barangay
        HAVING ${having}
      ) ranked
    )`);
    params.push(...inner.baseParams);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const andClause = (expr) => (where ? ` AND ${expr}` : `WHERE ${expr}`);

  return { where, andClause, params, baseWhere, baseParams };
}

const RISK_LABELS = {
  all: 'All Risk Levels',
  None: 'No Cases (0)',
  Low: 'Low (1–4)',
  Medium: 'Medium (5–9)',
  High: 'High (10–19)',
  Critical: 'Critical (20+)',
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Last calendar day of a month, using local date parts (not UTC). */
function lastCalendarDay(year, month) {
  const d = new Date(year, month, 0);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Inclusive exposure-date window for the Geographic report.
 * Month applies only when the period is Monthly.
 */
function reportPeriodRange({ reportType = 'quarterly', year, quarter, month } = {}) {
  const y = parseInt(year, 10) || new Date().getFullYear();
  const q = Math.min(4, Math.max(1, parseInt(quarter, 10) || 1));
  const m = parseInt(month, 10);
  if (reportType === 'monthly') {
    const monthNum = m >= 1 && m <= 12 ? m : 1;
    return {
      year: y,
      quarter: q,
      month: monthNum,
      startDate: `${y}-${pad2(monthNum)}-01`,
      endDate: lastCalendarDay(y, monthNum),
      periodLabel: new Date(y, monthNum - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }),
    };
  }
  if (reportType === 'annual') {
    return {
      year: y,
      quarter: q,
      month: null,
      startDate: `${y}-01-01`,
      endDate: `${y}-12-31`,
      periodLabel: `Full Year ${y}`,
    };
  }
  const startMonth = (q - 1) * 3 + 1;
  const endMonth = q * 3;
  const qLabels = {
    1: '1st Quarter (Jan – Mar)',
    2: '2nd Quarter (Apr – Jun)',
    3: '3rd Quarter (Jul – Sep)',
    4: '4th Quarter (Oct – Dec)',
  };
  return {
    year: y,
    quarter: q,
    month: null,
    startDate: `${y}-${pad2(startMonth)}-01`,
    endDate: lastCalendarDay(y, endMonth),
    periodLabel: `${qLabels[q]}, ${y}`,
  };
}

function barangayName(row) {
  return String((row && row.barangay) || 'Unknown').trim() || 'Unknown';
}

/**
 * Keep only cases whose barangay falls in the selected risk tier.
 * Tiers use the same counts the report displays.
 * "None" drops every case and returns official barangays that have zero cases.
 */
function filterCasesByRisk(cases, riskLevel, officialBarangays = []) {
  const level = !riskLevel || riskLevel === 'all' ? null : riskLevel;
  const counts = new Map();
  for (const row of cases || []) {
    const name = barangayName(row);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  if (!level) return { cases: cases || [], zeroBarangays: [] };
  if (level === 'None') {
    const withCases = new Set([...counts.keys()].map((name) => name.toLowerCase()));
    const seen = new Set();
    const zeroBarangays = [];
    for (const name of officialBarangays) {
      const key = String(name).trim().toLowerCase();
      if (!key || withCases.has(key) || seen.has(key)) continue;
      seen.add(key);
      zeroBarangays.push(String(name).trim());
    }
    return { cases: [], zeroBarangays };
  }
  const allowed = new Set();
  for (const [name, count] of counts) {
    if (barangayRiskTier(count) === level) allowed.add(name);
  }
  return {
    cases: (cases || []).filter((row) => allowed.has(barangayName(row))),
    zeroBarangays: [],
  };
}

function riskLevelLabel(riskLevel) {
  return RISK_LABELS[riskLevel] || RISK_LABELS.all;
}

function isoDate(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  }
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

/**
 * Inclusive window for the Data Analytics filters.
 * A custom date range wins. Otherwise a month wins over a quarter.
 * Dates use the exposure date of each bite case.
 */
function resolveAnalyticsWindow(query = {}) {
  const year = parseInt(query.year, 10) || new Date().getFullYear();
  const quarter = parseInt(query.quarter, 10);
  const month = parseInt(query.month, 10);
  const dateFrom = isoDate(query.dateFrom);
  const dateTo = isoDate(query.dateTo);
  if (dateFrom || dateTo) {
    const startDate = dateFrom || `${year}-01-01`;
    const endDate = dateTo || `${year}-12-31`;
    return { year, quarter: quarter >= 1 && quarter <= 4 ? quarter : null, month: null, startDate, endDate };
  }
  if (month >= 1 && month <= 12) {
    return {
      year,
      quarter: quarter >= 1 && quarter <= 4 ? quarter : null,
      month,
      startDate: `${year}-${pad2(month)}-01`,
      endDate: lastCalendarDay(year, month),
    };
  }
  if (quarter >= 1 && quarter <= 4) {
    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth = quarter * 3;
    return {
      year,
      quarter,
      month: null,
      startDate: `${year}-${pad2(startMonth)}-01`,
      endDate: lastCalendarDay(year, endMonth),
    };
  }
  return {
    year,
    quarter: null,
    month: null,
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
  };
}

function animalCodesForFilter(animalType) {
  if (!animalType || animalType === 'all') return null;
  const map = { Dog: ['D', 'SD'], Cat: ['C'], Other: ['O'] };
  return map[animalType] || [String(animalType).toUpperCase()];
}

function sexCode(sex) {
  const value = String(sex || '').trim().toUpperCase();
  if (value === 'M' || value === 'MALE') return 'M';
  if (value === 'F' || value === 'FEMALE') return 'F';
  return null;
}

function recordedAge(age) {
  if (age === null || age === undefined || String(age).trim() === '') return null;
  const years = Number(age);
  if (!Number.isFinite(years) || years < 0 || years > 120) return null;
  return Math.trunc(years);
}

function animalBucket(code) {
  const value = String(code || '').trim().toUpperCase();
  if (!value) return null;
  if (value === 'D' || value === 'SD' || value === 'DOG') return 'dog';
  if (value === 'C' || value === 'CAT') return 'cat';
  if (value === 'O' || value === 'OTHER' || value === 'OTHERS') return 'other';
  return 'other';
}

/**
 * Apply Year, Quarter, Month, Date, Animal, Barangay, and Risk Level
 * to bite cases. Risk uses the case counts in the already filtered set.
 */
function filterAnalyticsCases(cases, query = {}) {
  const window = resolveAnalyticsWindow(query);
  let rows = (cases || []).filter((row) => {
    const date = isoDate(row.date_of_exposure);
    return date && date >= window.startDate && date <= window.endDate;
  });
  const codes = animalCodesForFilter(query.animalType);
  if (codes) {
    rows = rows.filter((row) => codes.includes(String(row.type_of_animal || '').toUpperCase()));
  }
  if (query.barangay && query.barangay !== 'all') {
    const want = String(query.barangay).trim().toLowerCase();
    rows = rows.filter((row) => barangayName(row).toLowerCase() === want);
  }
  const risk = filterCasesByRisk(rows, query.riskLevel, query.officialBarangays || []);
  return { window, cases: risk.cases };
}

function computeRiskDistribution(barangayRows) {
  const dist = { None: 0, Low: 0, Medium: 0, High: 0, Critical: 0 };
  for (const row of barangayRows) {
    const tier = barangayRiskTier(Number(row.case_count));
    dist[tier] = (dist[tier] || 0) + 1;
  }
  return Object.entries(dist).map(([level, count]) => ({ level, count }));
}

module.exports = {
  barangayRiskTier,
  riskHavingClause,
  buildAnalyticsWhere,
  computeRiskDistribution,
  reportPeriodRange,
  barangayName,
  filterCasesByRisk,
  riskLevelLabel,
  lastCalendarDay,
  isoDate,
  resolveAnalyticsWindow,
  animalBucket,
  sexCode,
  recordedAge,
  filterAnalyticsCases,
};
