-- ============================================================
-- MIGRATION 006: Add unique constraint on vaccines.name
-- HopeCare Animal Bite Center – Gingoog City
--
-- Purpose: Prevent duplicate vaccine records at the database
--          level, regardless of how the insert originates.
--
-- Run this script ONCE against the animal_bite_system database.
-- It is safe to run again — the IF NOT EXISTS guard prevents errors.
-- ============================================================

USE animal_bite_system;

-- Step 1: Deduplicate any existing rows that share the same name
-- (keep the lowest vaccine_id, delete the rest).
DELETE v1
FROM vaccines v1
INNER JOIN vaccines v2
  ON LOWER(v1.name) = LOWER(v2.name)
 AND v1.vaccine_id > v2.vaccine_id;

-- Step 2: Add a unique index on the name column (case-insensitive via
-- utf8mb4_unicode_ci collation which the table already uses).
-- The DROP+ADD pattern is used because MySQL < 8.0.3 does not support
-- "CREATE UNIQUE INDEX IF NOT EXISTS".
-- The IGNORE on DROP prevents an error if the index does not yet exist.
DROP INDEX IF EXISTS uq_vaccine_name ON vaccines;
CREATE UNIQUE INDEX uq_vaccine_name ON vaccines (name);

-- Verification query — should return 0 rows after migration:
-- SELECT name, COUNT(*) AS cnt
-- FROM vaccines
-- GROUP BY LOWER(name)
-- HAVING cnt > 1;
