-- RBAC & Follow-up Reminder System Migration
-- Applied automatically via backend/config/database.js on startup

ALTER TABLE staff_account
  ADD COLUMN IF NOT EXISTS role ENUM('Administrator','Nurse') NOT NULL DEFAULT 'Nurse' AFTER designation;

UPDATE staff_account SET role = 'Administrator' WHERE username = 'admin';

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS treatment_status VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS missed_dose VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS missed_date DATE NULL,
  ADD COLUMN IF NOT EXISTS schedule_suspended TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interrupted_status TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_schedule DATE NULL,
  ADD COLUMN IF NOT EXISTS reminder_status VARCHAR(30) NULL,
  ADD COLUMN IF NOT EXISTS reminder_sent_date DATE NULL,
  ADD COLUMN IF NOT EXISTS reminder_type VARCHAR(30) NULL,
  ADD COLUMN IF NOT EXISTS interrupted_reviewed TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interrupted_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS interrupted_reviewed_by VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS interrupted_reviewed_at DATETIME NULL;

ALTER TABLE activity_logs
  ADD COLUMN IF NOT EXISTS role VARCHAR(50) NULL,
  ADD COLUMN IF NOT EXISTS shift VARCHAR(20) NULL;

ALTER TABLE patient_accounts
  ADD COLUMN IF NOT EXISTS account_status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  ADD COLUMN IF NOT EXISTS is_locked TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_attempts INT NOT NULL DEFAULT 0;

-- See database.js runMigrations() for full table definitions:
-- vaccination_reminders, staff_notifications, patient_login_history,
-- vaccine_inventory, vaccine_transactions
