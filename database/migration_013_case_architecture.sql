-- ============================================================
-- MIGRATION 013: Case-Based Architecture Safety Nets
-- ============================================================
-- Safe to run multiple times (uses IF NOT EXISTS / IGNORE guards).
--
-- Purpose:
--   1. Ensure patient_pep_schedule.episode_id has an index so
--      per-case dose lookups are fast.
--   2. Add time_of_exposure to patient_exposures if missing.
--   3. Add animal_ownership, animal_status, wound_type,
--      wound_severity, pre_exposure_hx, allergy, co_morbidities,
--      tetanus_vaccine_hx to patient_exposures for full form support.
--   4. Add a generated case_display_id view for user-facing CASE-NNNNNN labels.
--   5. Ensure treatment_episodes has washing_of_bite (safety net).
--   6. Add total_cases column to the search result (no table change needed —
--      it is already computed in the SQL query via COUNT DISTINCT).
--
-- DO NOT DROP any existing tables or columns.
-- ============================================================

USE animal_bite_system;

-- ─── patient_exposures: ensure all form fields are present ───────────────────

ALTER TABLE patient_exposures
  ADD COLUMN IF NOT EXISTS time_of_exposure    VARCHAR(20)  NULL AFTER date_of_exposure,
  ADD COLUMN IF NOT EXISTS animal_ownership    VARCHAR(50)  NULL AFTER type_of_animal,
  ADD COLUMN IF NOT EXISTS animal_status       VARCHAR(50)  NULL AFTER animal_ownership,
  ADD COLUMN IF NOT EXISTS wound_type          VARCHAR(100) NULL AFTER site_of_exposure,
  ADD COLUMN IF NOT EXISTS wound_severity      VARCHAR(30)  NULL AFTER wound_type,
  ADD COLUMN IF NOT EXISTS pre_exposure_hx     VARCHAR(200) NULL AFTER tetanus_vaccine_hx,
  ADD COLUMN IF NOT EXISTS allergy             VARCHAR(200) NULL AFTER pre_exposure_hx,
  ADD COLUMN IF NOT EXISTS co_morbidities      VARCHAR(200) NULL AFTER allergy,
  ADD COLUMN IF NOT EXISTS tetanus_vaccine_hx  VARCHAR(200) NULL AFTER wound_severity;

-- ─── patient_pep_schedule: add episode_id index (column already exists) ──────

ALTER TABLE patient_pep_schedule
  ADD INDEX IF NOT EXISTS idx_pep_episode_id (episode_id);

-- ─── treatment_episodes: safety net columns ──────────────────────────────────

ALTER TABLE treatment_episodes
  ADD COLUMN IF NOT EXISTS washing_of_bite ENUM('Y','N') NULL AFTER rig_date_given;

-- ─── patient_exposures: composite index for case history display ─────────────

ALTER TABLE patient_exposures
  ADD INDEX IF NOT EXISTS idx_pe_patient_num (patient_id, exposure_number);

-- ─── Backfill time_of_exposure from patients flat record into exposure #1 ────

UPDATE patient_exposures pe
JOIN patients p ON p.patient_id = pe.patient_id
SET pe.time_of_exposure = p.time_of_exposure
WHERE pe.exposure_number = 1
  AND pe.time_of_exposure IS NULL
  AND p.time_of_exposure IS NOT NULL;

-- ─── Backfill animal_ownership + animal_status from patients into exposure #1 ─

UPDATE patient_exposures pe
JOIN patients p ON p.patient_id = pe.patient_id
SET
  pe.animal_ownership = COALESCE(pe.animal_ownership, p.animal_ownership),
  pe.animal_status    = COALESCE(pe.animal_status,    p.animal_status),
  pe.wound_type       = COALESCE(pe.wound_type,       p.wound_type),
  pe.wound_severity   = COALESCE(pe.wound_severity,   p.wound_severity),
  pe.pre_exposure_hx  = COALESCE(pe.pre_exposure_hx,  p.pre_exposure_hx),
  pe.allergy          = COALESCE(pe.allergy,           p.allergy),
  pe.co_morbidities   = COALESCE(pe.co_morbidities,   p.co_morbidities),
  pe.tetanus_vaccine_hx = COALESCE(pe.tetanus_vaccine_hx, p.tetanus_vaccine_hx)
WHERE pe.exposure_number = 1;

-- ─── Backfill washing_of_bite on treatment_episodes episode #1 ───────────────

UPDATE treatment_episodes te
JOIN patients p ON p.patient_id = te.patient_id
SET te.washing_of_bite = p.washing_of_bite
WHERE te.episode_number = 1
  AND te.washing_of_bite IS NULL
  AND p.washing_of_bite IS NOT NULL;
