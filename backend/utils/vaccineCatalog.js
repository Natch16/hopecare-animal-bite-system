'use strict';

const VALID_VACCINE_CATEGORIES = [
  'Anti-Rabies Vaccine',
  'ERIG',
  'HRIG',
  'Tetanus Prophylaxis',
];

const DEFAULT_BRANDS = ['Abhayrab', 'Vaxirab'];
const DEFAULT_TETANUS = ['TT', 'ATS', 'HTIG'];
const DEFAULT_ERIG = ['Equirab', 'Vinrab'];
const DEFAULT_HRIG = ['Berirab'];

const CATALOG_SQL = `
  SELECT vaccine_id, name, type, category, concentration, has_route, has_anst,
         has_dose, has_injection_site, has_date_given, has_given_by,
         default_dose_ml, default_injection_site, status
  FROM vaccines
  WHERE status = 'Available'
    AND category IN ('Anti-Rabies Vaccine','ERIG','HRIG','Tetanus Prophylaxis')
  ORDER BY FIELD(category, 'Anti-Rabies Vaccine','ERIG','HRIG','Tetanus Prophylaxis'), name ASC
`;

function groupCatalog(rows) {
  const grouped = {
    'Anti-Rabies Vaccine': [],
    ERIG: [],
    HRIG: [],
    'Tetanus Prophylaxis': [],
  };
  for (const row of rows || []) {
    if (grouped[row.category]) grouped[row.category].push(row);
  }
  return {
    antiRabies: grouped['Anti-Rabies Vaccine'],
    erig: grouped.ERIG,
    hrig: grouped.HRIG,
    tetanus: grouped['Tetanus Prophylaxis'],
    all: rows || [],
  };
}

async function fetchAvailableCatalog(pool) {
  try {
    const [rows] = await pool.query(CATALOG_SQL);
    return groupCatalog(rows);
  } catch (_) {
    const [rows] = await pool.query(`
      SELECT vaccine_id, name, type, category, concentration, has_route, has_anst,
             default_dose_ml, default_injection_site, status
      FROM vaccines
      WHERE status = 'Available'
        AND category IN ('Anti-Rabies Vaccine','ERIG','HRIG','Tetanus Prophylaxis')
      ORDER BY FIELD(category, 'Anti-Rabies Vaccine','ERIG','HRIG','Tetanus Prophylaxis'), name ASC
    `);
    return groupCatalog(rows);
  }
}

function hasValue(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/**
 * Anti-Rabies brand must exist as an Available vaccine in Vaccine Management.
 * If the catalog cannot be read (tests / missing table), fall back to Abhayrab/Vaxirab.
 */
async function isValidAntiRabiesBrand(pool, brandName, options = {}) {
  if (!hasValue(brandName)) return true;
  const name = String(brandName).trim();
  const allowCurrent = options.allowCurrent ? String(options.allowCurrent).trim() : '';
  if (allowCurrent && name.toLowerCase() === allowCurrent.toLowerCase()) return true;

  try {
    const [rows] = await pool.query(
      `SELECT name FROM vaccines
       WHERE category = 'Anti-Rabies Vaccine' AND status = 'Available'`
    );
    if (Array.isArray(rows) && rows.length > 0) {
      return rows.some((r) => String(r.name).toLowerCase() === name.toLowerCase());
    }
  } catch (_) {
    /* fall through to defaults */
  }
  return DEFAULT_BRANDS.includes(name);
}

function invalidBrandMessage() {
  return 'Invalid vaccine brand. Use an available Anti-Rabies Vaccine from Vaccine Management (e.g. Abhayrab or Vaxirab).';
}

async function insertDynamicTetanus(pool, episodeId, patientId, dynamicTetanus) {
  const list = Array.isArray(dynamicTetanus) ? dynamicTetanus : [];
  for (const dv of list) {
    if (!dv.given || !dv.vaccine_id) continue;
    await pool.query(
      `INSERT INTO tetanus_records
         (episode_id, patient_id, type, given, dose_ml, injection_site, route, anst_result, date_given, given_by, vaccine_id, vaccine_name)
       VALUES (?,?,'Other',1,?,?,?,?,?,?,?,?)`,
      [
        episodeId, patientId,
        dv.dose_ml || null,
        dv.injection_site || null,
        dv.route || null,
        dv.anst_result || null,
        dv.date_given || null,
        dv.given_by || null,
        parseInt(dv.vaccine_id, 10),
        dv.vaccine_name || null,
      ]
    ).catch((err) => {
      console.warn('[insertDynamicTetanus]', err.message);
    });
  }
}

async function insertDynamicRig(pool, episodeId, patientId, dynamicRig) {
  const list = Array.isArray(dynamicRig) ? dynamicRig : [];
  for (const dv of list) {
    if (!dv.given || !dv.vaccine_name) continue;
    const rigType = dv.rig_type === 'Human' || dv.category === 'HRIG' ? 'Human' : 'Equine';
    const concentration = dv.concentration
      || (rigType === 'Human' ? '300 IU/mL' : '200 IU/mL');
    await pool.query(
      `INSERT INTO rig_records
         (episode_id, patient_id, rig_given, rig_type, rig_brand, concentration,
          volume_ml, anst_result, injection_site, date_given, given_by)
       VALUES (?,?,1,?,?,?,?,?,'Wound site',?,?)`,
      [
        episodeId, patientId,
        rigType,
        dv.vaccine_name,
        concentration,
        dv.volume_ml || null,
        dv.anst_result || null,
        dv.date_given || null,
        dv.given_by || null,
      ]
    ).catch(() => {});
  }
}

const GENERIC_INVENTORY_EXCLUDE = ['ERIG', 'HRIG', 'PCEC', 'PVRV'];
const CATEGORY_SORT = ['Anti-Rabies Vaccine', 'ERIG', 'HRIG', 'Tetanus Prophylaxis'];

function isExcludedGenericVaccineName(name) {
  return GENERIC_INVENTORY_EXCLUDE.includes(String(name || '').trim().toUpperCase());
}

function sortManagedVaccines(a, b) {
  const ia = CATEGORY_SORT.indexOf(a && a.category);
  const ib = CATEGORY_SORT.indexOf(b && b.category);
  const ca = ia === -1 ? 99 : ia;
  const cb = ib === -1 ? 99 : ib;
  if (ca !== cb) return ca - cb;
  const na = String((a && a.name) || '');
  const nb = String((b && b.name) || '');
  const byName = na.localeCompare(nb, undefined, { sensitivity: 'base' });
  if (byName !== 0) return byName;
  return Number(a.vaccine_id || 0) - Number(b.vaccine_id || 0);
}

/**
 * Vaccine Management is the catalog source for inventory + daily reports.
 * Active (Available) vaccines always appear. Disabled vaccines appear only when
 * extraIds includes them (historical lots, daily rows, or transactions).
 */
function pickManagedVaccines(vaccines, extraIds = []) {
  const extra = new Set([...extraIds].map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0));
  return (vaccines || [])
    .filter((v) => {
      if (!v || isExcludedGenericVaccineName(v.name)) return false;
      if (String(v.status || '') === 'Available') return true;
      return extra.has(Number(v.vaccine_id));
    })
    .sort(sortManagedVaccines);
}

async function fetchInventoryCatalog(pool, { activeOnly = true, extraIds = [] } = {}) {
  const [rows] = await pool.query(
    `SELECT vaccine_id, name, type, category, status
     FROM vaccines
     WHERE UPPER(TRIM(name)) NOT IN ('ERIG','HRIG','PCEC','PVRV')`
  );
  if (activeOnly) return pickManagedVaccines(rows, extraIds);
  return pickManagedVaccines(
    rows,
    (rows || []).map((v) => v.vaccine_id)
  );
}

async function requireActiveManagedVaccine(conn, vaccineId) {
  const [[v]] = await conn.query(
    `SELECT vaccine_id, name, status FROM vaccines WHERE vaccine_id = ? LIMIT 1`,
    [vaccineId]
  );
  if (!v) {
    const err = new Error('Vaccine not found in Vaccine Management');
    err.status = 400;
    throw err;
  }
  if (isExcludedGenericVaccineName(v.name)) {
    const err = new Error('This vaccine is not available for inventory recording');
    err.status = 400;
    throw err;
  }
  if (String(v.status) !== 'Available') {
    const err = new Error(
      'This vaccine is disabled in Vaccine Management and cannot be used for new inventory transactions'
    );
    err.status = 400;
    throw err;
  }
  return v;
}

module.exports = {
  VALID_VACCINE_CATEGORIES,
  DEFAULT_BRANDS,
  DEFAULT_TETANUS,
  DEFAULT_ERIG,
  DEFAULT_HRIG,
  GENERIC_INVENTORY_EXCLUDE,
  fetchAvailableCatalog,
  fetchInventoryCatalog,
  pickManagedVaccines,
  requireActiveManagedVaccine,
  isExcludedGenericVaccineName,
  groupCatalog,
  isValidAntiRabiesBrand,
  invalidBrandMessage,
  insertDynamicTetanus,
  insertDynamicRig,
};
