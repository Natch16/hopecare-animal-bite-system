-- migration_012_multi_exposure_indexes.sql
-- Multi-exposure indexes and schema safety nets
-- Safe to run multiple times (uses IF NOT EXISTS guards)

USE animal_bite_system;

-- 1. Add episode_id and dose_label to patient_followup
--    so follow-up can track per-episode, per-dose status.
--    The UNIQUE constraint stays on patient_id to preserve existing ON DUPLICATE KEY behaviour.
ALTER TABLE patient_followup
  ADD COLUMN IF NOT EXISTS episode_id  INT         NULL AFTER patient_id,
  ADD COLUMN IF NOT EXISTS dose_label  VARCHAR(20) NULL AFTER episode_id;

ALTER TABLE patient_followup
  ADD INDEX IF NOT EXISTS idx_pf_episode (episode_id);

-- 2. Ensure patient_pep_schedule carries episode_id, status, and remarks
--    (already added in setup-db.js for new installs; this is a safety net for existing deployments).
ALTER TABLE patient_pep_schedule
  ADD COLUMN IF NOT EXISTS episode_id INT         NULL,
  ADD COLUMN IF NOT EXISTS status     VARCHAR(30) NULL DEFAULT 'Pending',
  ADD COLUMN IF NOT EXISTS remarks    TEXT        NULL;

ALTER TABLE patient_pep_schedule
  ADD INDEX IF NOT EXISTS idx_pep_episode (episode_id);

-- 3. Composite index on patient_exposures used by the enriched search query.
ALTER TABLE patient_exposures
  ADD INDEX IF NOT EXISTS idx_pe_date (patient_id, date_of_exposure);

-- 4. Composite index on treatment_episodes used for latest-status lookup.
ALTER TABLE treatment_episodes
  ADD INDEX IF NOT EXISTS idx_te_created (patient_id, created_at);
