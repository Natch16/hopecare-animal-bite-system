-- ============================================================
-- MIGRATION 005: Digital signatures for report settings
-- Run once against the animal_bite_system database.
-- ============================================================
USE animal_bite_system;

ALTER TABLE report_settings
  ADD COLUMN IF NOT EXISTS noted_by VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS prepared_by_signature LONGTEXT NULL,
  ADD COLUMN IF NOT EXISTS noted_by_signature LONGTEXT NULL;

-- Migrate existing approved_by data to noted_by
UPDATE report_settings
SET noted_by = approved_by
WHERE id = 1 AND noted_by IS NULL AND approved_by IS NOT NULL;
