'use strict';

/** Generic type names that were seeded as vaccines but are not brand records. */
const GENERIC_DEFAULT_VACCINE_NAMES = ['ERIG', 'HRIG', 'PCEC', 'PVRV'];

function isGenericDefaultVaccineName(name) {
  return GENERIC_DEFAULT_VACCINE_NAMES.includes(String(name || '').trim().toUpperCase());
}

function referenceCount(parts) {
  return Object.values(parts || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
}

/**
 * Remove unused generic default vaccine *names* (ERIG/HRIG/PCEC/PVRV rows).
 * If any inventory, transaction, daily sheet, or patient brand text references
 * the row, keep it and set status to Unavailable instead of deleting.
 * Categories named ERIG/HRIG on Equirab/Vinrab/Berirab are not touched.
 */
async function retireGenericDefaultVaccines(conn) {
  const [rows] = await conn.query(
    `SELECT vaccine_id, name FROM vaccines
     WHERE UPPER(TRIM(name)) IN ('ERIG','HRIG','PCEC','PVRV')`
  ).catch(() => [[]]);

  const results = [];
  for (const v of rows || []) {
    const id = v.vaccine_id;
    const name = v.name;
    const counts = {};
    const q = async (sql, params) => {
      try {
        const [[row]] = await conn.query(sql, params);
        return Number(row && row.n) || 0;
      } catch (_) {
        return 0;
      }
    };
    counts.inventory = await q('SELECT COUNT(*) AS n FROM vaccine_inventory WHERE vaccine_id = ?', [id]);
    counts.transactions = await q('SELECT COUNT(*) AS n FROM vaccine_transactions WHERE vaccine_id = ?', [id]);
    counts.daily = await q('SELECT COUNT(*) AS n FROM inventory_daily_records WHERE vaccine_id = ?', [id]);
    counts.patients = await q(
      'SELECT COUNT(*) AS n FROM patients WHERE LOWER(TRIM(brand_name)) = LOWER(?)',
      [name]
    );
    counts.episodes = await q(
      'SELECT COUNT(*) AS n FROM treatment_episodes WHERE LOWER(TRIM(brand_name)) = LOWER(?)',
      [name]
    );
    counts.pep = await q(
      'SELECT COUNT(*) AS n FROM patient_pep_schedule WHERE LOWER(TRIM(vaccine_brand)) = LOWER(?)',
      [name]
    );
    counts.rig = await q(
      'SELECT COUNT(*) AS n FROM rig_records WHERE LOWER(TRIM(rig_brand)) = LOWER(?)',
      [name]
    );

    const used = referenceCount(counts);
    if (used > 0) {
      await conn.query(
        `UPDATE vaccines SET status = 'Unavailable' WHERE vaccine_id = ?`,
        [id]
      );
      results.push({ name, vaccine_id: id, action: 'deactivated', counts });
    } else {
      await conn.query('DELETE FROM vaccines WHERE vaccine_id = ?', [id]);
      results.push({ name, vaccine_id: id, action: 'deleted', counts });
    }
  }
  return results;
}

module.exports = {
  GENERIC_DEFAULT_VACCINE_NAMES,
  isGenericDefaultVaccineName,
  referenceCount,
  retireGenericDefaultVaccines,
};
