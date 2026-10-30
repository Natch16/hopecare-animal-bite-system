-- ========================================
-- MIGRATION 008: STAFF ACCOUNTS & AUDIT TRAIL
-- Individual staff accounts, activity logging, created_by/updated_by
-- ========================================

USE animal_bite_system;

-- ========================================
-- 1. ALTER staff_account TABLE — extend for individual accounts
-- ========================================

-- Add status column (Active/Inactive)
ALTER TABLE staff_account
  ADD COLUMN IF NOT EXISTS status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active'
  AFTER email;

-- Add designation column (e.g. ABC Nurse)
ALTER TABLE staff_account
  ADD COLUMN IF NOT EXISTS designation VARCHAR(100) NULL DEFAULT 'ABC Nurse'
  AFTER status;

-- Add contact_number to staff_account if not exists (already exists per schema, but ensure)
-- (already in schema)

-- Ensure existing admin account has defaults
UPDATE staff_account
SET
  full_name   = COALESCE(NULLIF(full_name,''), 'System Administrator'),
  designation = COALESCE(NULLIF(designation,''), 'ABC Nurse'),
  status    = COALESCE(NULLIF(status,''), 'Active')
WHERE username = 'admin';

-- ========================================
-- 2. CREATE activity_logs TABLE — audit trail
-- ========================================
CREATE TABLE IF NOT EXISTS activity_logs (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  staff_id      INT           NOT NULL,
  username      VARCHAR(50)   NOT NULL,
  full_name     VARCHAR(100)  NULL,
  action        VARCHAR(50)   NOT NULL,
  module        VARCHAR(50)   NOT NULL,
  reference_id  VARCHAR(100)  NULL,
  description   TEXT          NULL,
  ip_address    VARCHAR(50)   NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_staff_id    (staff_id),
  INDEX idx_username    (username),
  INDEX idx_action      (action),
  INDEX idx_module      (module),
  INDEX idx_created_at  (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========================================
-- 3. ALTER patients TABLE — add created_by / updated_by audit columns
-- ========================================
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS created_by VARCHAR(100) NULL
  AFTER updated_at,
  ADD COLUMN IF NOT EXISTS updated_by VARCHAR(100) NULL
  AFTER created_by;

-- ========================================
-- 4. ALTER patient_followup TABLE — audit columns
-- ========================================
ALTER TABLE patient_followup
  ADD COLUMN IF NOT EXISTS created_by VARCHAR(100) NULL
  AFTER updated_at,
  ADD COLUMN IF NOT EXISTS updated_by VARCHAR(100) NULL
  AFTER created_by;

-- ========================================
-- 5. ALTER vaccines TABLE — audit columns
-- ========================================
ALTER TABLE vaccines
  ADD COLUMN IF NOT EXISTS created_by VARCHAR(100) NULL
  AFTER updated_at,
  ADD COLUMN IF NOT EXISTS updated_by VARCHAR(100) NULL
  AFTER created_by;

-- ========================================
-- 6. ALTER report_settings TABLE — generated_by / updated_by
-- ========================================
ALTER TABLE report_settings
  ADD COLUMN IF NOT EXISTS updated_by VARCHAR(100) NULL
  AFTER noted_by_designation,
  ADD COLUMN IF NOT EXISTS generated_by VARCHAR(100) NULL
  AFTER updated_by;
