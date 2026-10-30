/**
 * Sequential registration number allocation for patient records.
 * Format: ABC-YYYY-NNNNNN
 *   - YYYY = 4-digit calendar year (from date_registered or current year)
 *   - NNNNNN = 6-digit zero-padded counter, resets per year
 * Uses MAX(existing sequence) + 1 — deleted numbers are never reused.
 */

const ORDER_BY_REGISTRATION =
  'ORDER BY SUBSTRING_INDEX(registration_number, \'-\', 2) DESC, CAST(SUBSTRING_INDEX(registration_number, \'-\', -1) AS UNSIGNED) ASC';

/**
 * Returns the next available registration number for the given year.
 * @param {object} conn - Active database connection (must be inside a transaction)
 * @param {number|string} [year] - 4-digit year; defaults to current year
 * @returns {Promise<string>} e.g. "ABC-2026-000001"
 */
async function getNextRegistrationNumber(conn, year) {
  const yr = year || new Date().getFullYear();
  const prefix = `ABC-${yr}-`;
  const [rows] = await conn.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(registration_number, '-', -1) AS UNSIGNED)), 0) + 1 AS next_num
     FROM patients
     WHERE registration_number LIKE ?`,
    [`${prefix}%`]
  );
  const seq = String(rows[0].next_num).padStart(6, '0');
  return `${prefix}${seq}`;
}

/**
 * Opens a connection, begins a transaction, and allocates the next
 * registration number for the given year.
 * @param {object} pool - mysql2 connection pool
 * @param {number|string} [year] - 4-digit year extracted from date_registered; defaults to current year
 * @returns {Promise<{conn: object, registration_number: string}>}
 */
async function allocateRegistrationNumber(pool, year) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const yr = year || new Date().getFullYear();
    const registration_number = await getNextRegistrationNumber(conn, yr);
    return { conn, registration_number };
  } catch (err) {
    conn.release();
    throw err;
  }
}

module.exports = {
  ORDER_BY_REGISTRATION,
  getNextRegistrationNumber,
  allocateRegistrationNumber,
};
