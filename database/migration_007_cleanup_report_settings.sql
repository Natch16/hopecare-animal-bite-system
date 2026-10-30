-- ============================================================
-- MIGRATION 007: Remove unused columns from report_settings
-- HopeCare Animal Bite Center – Gingoog City
--
-- Columns confirmed unused after full codebase audit:
--   address          – no UI field, never read or written by any route/frontend
--   contact_number   – removed from Settings UI; route no longer sends/reads it
--   prepared_by_pos  – designation is hardcoded as "ABC Nurse" in HTML; column
--                      is never read by reports.html or settings.html
--   approved_by_pos  – same — never referenced anywhere in source code
--   logo_path        – all pages hardcode src="images/logo.png" directly;
--                      column is never read or written
--
-- SAFE TO RUN MULTIPLE TIMES — each ALTER uses IF EXISTS so it is idempotent.
-- Run once against the animal_bite_system database.
-- ============================================================

USE animal_bite_system;

ALTER TABLE report_settings
  DROP COLUMN IF EXISTS address,
  DROP COLUMN IF EXISTS contact_number,
  DROP COLUMN IF EXISTS prepared_by_pos,
  DROP COLUMN IF EXISTS approved_by_pos,
  DROP COLUMN IF EXISTS logo_path;

-- Verification query — should return 0 for each:
-- SELECT
--   COUNT(CASE WHEN COLUMN_NAME = 'address'         THEN 1 END) AS address_exists,
--   COUNT(CASE WHEN COLUMN_NAME = 'contact_number'  THEN 1 END) AS contact_number_exists,
--   COUNT(CASE WHEN COLUMN_NAME = 'prepared_by_pos' THEN 1 END) AS prepared_by_pos_exists,
--   COUNT(CASE WHEN COLUMN_NAME = 'approved_by_pos' THEN 1 END) AS approved_by_pos_exists,
--   COUNT(CASE WHEN COLUMN_NAME = 'logo_path'       THEN 1 END) AS logo_path_exists
-- FROM information_schema.COLUMNS
-- WHERE TABLE_SCHEMA = 'animal_bite_system'
--   AND TABLE_NAME   = 'report_settings';
