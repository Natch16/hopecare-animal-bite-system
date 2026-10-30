-- ============================================================
-- MIGRATION 015: Per-Dose Vaccinator Tracking on patient_pep_schedule
-- ============================================================
-- Safe to run multiple times (uses IF NOT EXISTS guards).
--
-- Purpose:
--   1. Add vaccinator_staff_id (FK → staff_account.id) to
--      patient_pep_schedule so each dose row records the exact
--      staff member who administered it.
--   2. vaccinated_by VARCHAR(100) already exists — keep it as
--      the denormalised display name so history is readable even
--      if the staff account is later deactivated.
--   3. Add episode_id index safety net (idempotent).
-- ============================================================

USE animal_bite_system;

-- 1. Add vaccinator_staff_id to patient_pep_schedule
ALTER TABLE patient_pep_schedule
  ADD COLUMN IF NOT EXISTS vaccinator_staff_id INT NULL
    COMMENT 'FK to staff_account.id — nurse who administered this dose',
  ADD INDEX IF NOT EXISTS idx_pep_vaccinator (vaccinator_staff_id);

-- 2. Add FK constraint only if it does not exist yet
-- (wraps in a procedure so it is safe to re-run)
DROP PROCEDURE IF EXISTS _add_pep_vaccinator_fk;
DELIMITER $$
CREATE PROCEDURE _add_pep_vaccinator_fk()
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME         = 'patient_pep_schedule'
      AND CONSTRAINT_NAME    = 'fk_pep_vaccinator_staff'
      AND CONSTRAINT_TYPE    = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE patient_pep_schedule
      ADD CONSTRAINT fk_pep_vaccinator_staff
        FOREIGN KEY (vaccinator_staff_id)
        REFERENCES staff_account(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE;
  END IF;
END$$
DELIMITER ;
CALL _add_pep_vaccinator_fk();
DROP PROCEDURE IF EXISTS _add_pep_vaccinator_fk;
