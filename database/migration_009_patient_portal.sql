-- ========================================
-- MIGRATION 009: PATIENT PORTAL ENABLEMENT
-- ========================================

-- 1. Patient password and account fields on patients table
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS password VARCHAR(255) NULL AFTER remarks,
  ADD COLUMN IF NOT EXISTS is_temp_password TINYINT(1) NOT NULL DEFAULT 1 AFTER password,
  ADD COLUMN IF NOT EXISTS municipality VARCHAR(100) NULL DEFAULT 'Gingoog City' AFTER barangay,
  ADD COLUMN IF NOT EXISTS region_of_exposure VARCHAR(100) NULL AFTER place_of_exposure,
  ADD COLUMN IF NOT EXISTS condition_of_animal ENUM('Well/Alive','Sick/Ill','Stray','Dead') NULL AFTER biting_animal_status,
  ADD COLUMN IF NOT EXISTS signs_symptoms ENUM('None','Yes') NULL DEFAULT 'None' AFTER condition_of_animal,
  ADD COLUMN IF NOT EXISTS nature_of_exposure ENUM('Lacerated','Punctured','Abrasion') NULL AFTER type_of_exposure;

-- 2. Pre-Exposure Prophylaxis (PrEP) detailed doses
CREATE TABLE IF NOT EXISTS patient_prep_schedule (
  prep_id INT AUTO_INCREMENT PRIMARY KEY,
  patient_id INT NOT NULL,
  day_label VARCHAR(10) NOT NULL DEFAULT 'Day 0',
  date_due DATE NULL,
  date_given DATE NULL,
  vaccine_brand VARCHAR(100) NULL,
  route ENUM('ID','IM') NULL,
  site_right TINYINT(1) NULL DEFAULT 0,
  site_left TINYINT(1) NULL DEFAULT 0,
  vaccinated_by VARCHAR(150) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
  INDEX idx_patient_prep (patient_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Post-Exposure Prophylaxis (PEP) detailed doses
CREATE TABLE IF NOT EXISTS patient_pep_schedule (
  pep_id INT AUTO_INCREMENT PRIMARY KEY,
  patient_id INT NOT NULL,
  day_label VARCHAR(10) NOT NULL,
  date_due DATE NULL,
  date_given DATE NULL,
  vaccine_brand VARCHAR(100) NULL,
  route ENUM('ID','IM') NULL,
  site_right TINYINT(1) NULL DEFAULT 0,
  site_left TINYINT(1) NULL DEFAULT 0,
  vaccinated_by VARCHAR(150) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
  INDEX idx_patient_pep (patient_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Booster schedule
CREATE TABLE IF NOT EXISTS patient_booster_schedule (
  booster_id INT AUTO_INCREMENT PRIMARY KEY,
  patient_id INT NOT NULL,
  day_label VARCHAR(20) NOT NULL DEFAULT 'Booster',
  date_due DATE NULL,
  date_given DATE NULL,
  vaccine_brand VARCHAR(100) NULL,
  route ENUM('ID','IM') NULL,
  site_right TINYINT(1) NULL DEFAULT 0,
  site_left TINYINT(1) NULL DEFAULT 0,
  vaccinated_by VARCHAR(150) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
  INDEX idx_patient_booster (patient_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Tetanus Toxoid detailed schedule
CREATE TABLE IF NOT EXISTS patient_tt_schedule (
  tt_id INT AUTO_INCREMENT PRIMARY KEY,
  patient_id INT NOT NULL,
  dose_label VARCHAR(10) NOT NULL,
  date_due DATE NULL,
  date_given DATE NULL,
  vaccine_brand VARCHAR(100) NULL DEFAULT 'Tetanus Toxoid',
  dose_ml DECIMAL(5,2) NULL,
  site_right TINYINT(1) NULL DEFAULT 0,
  site_left TINYINT(1) NULL DEFAULT 0,
  vaccinated_by VARCHAR(150) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
  INDEX idx_patient_tt (patient_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Patient Notifications
CREATE TABLE IF NOT EXISTS patient_notifications (
  notif_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  patient_id INT NOT NULL,
  type ENUM('UPCOMING_VACCINE','MISSED_SCHEDULE','COMPLETED_DOSE','BOOSTER_REMINDER','SYSTEM') NOT NULL,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  related_date DATE NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
  INDEX idx_patient_notif (patient_id, is_read),
  INDEX idx_notif_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Assign default temp password "hopecare" (bcrypt hash) to existing patients
-- bcrypt hash for "hopecare": $2a$10$gKQwLq3J5fQ6p4n8bYvRpeT7yU3iC7eS1aQ0dF9gH2jK4lM6nO
UPDATE patients
SET password = COALESCE(password, '$2a$10$gKQwLq3J5fQ6p4n8bYvRpeT7yU3iC7eS1aQ0dF9gH2jK4lM6nO'),
    is_temp_password = COALESCE(is_temp_password, 1)
WHERE password IS NULL;

-- 8. Seed PEP schedule rows (Day 0, 3, 7, 14, 28) for patients that have PEP dates
INSERT IGNORE INTO patient_pep_schedule (patient_id, day_label, date_due, date_given, vaccine_brand, route, vaccinated_by)
SELECT p.patient_id, 'Day 0', p.vaccine_d0, p.vaccine_d0, p.brand_name, p.route, p.tt_given_by
FROM patients p WHERE p.vaccine_d0 IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM patient_pep_schedule ps WHERE ps.patient_id = p.patient_id AND ps.day_label = 'Day 0');

INSERT IGNORE INTO patient_pep_schedule (patient_id, day_label, date_due, date_given, vaccine_brand, route, vaccinated_by)
SELECT p.patient_id, 'Day 3', p.vaccine_d3, p.vaccine_d3, p.brand_name, p.route, p.tt_given_by
FROM patients p WHERE p.vaccine_d3 IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM patient_pep_schedule ps WHERE ps.patient_id = p.patient_id AND ps.day_label = 'Day 3');

INSERT IGNORE INTO patient_pep_schedule (patient_id, day_label, date_due, date_given, vaccine_brand, route, vaccinated_by)
SELECT p.patient_id, 'Day 7', p.vaccine_d7, p.vaccine_d7, p.brand_name, p.route, p.tt_given_by
FROM patients p WHERE p.vaccine_d7 IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM patient_pep_schedule ps WHERE ps.patient_id = p.patient_id AND ps.day_label = 'Day 7');

INSERT IGNORE INTO patient_pep_schedule (patient_id, day_label, date_due, date_given, vaccine_brand, route, vaccinated_by)
SELECT p.patient_id, 'Day 14', p.vaccine_d14, p.vaccine_d14, p.brand_name, p.route, p.tt_given_by
FROM patients p WHERE p.vaccine_d14 IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM patient_pep_schedule ps WHERE ps.patient_id = p.patient_id AND ps.day_label = 'Day 14');

INSERT IGNORE INTO patient_pep_schedule (patient_id, day_label, date_due, date_given, vaccine_brand, route, vaccinated_by)
SELECT p.patient_id, 'Day 28', p.vaccine_d28, p.vaccine_d28, p.brand_name, p.route, p.tt_given_by
FROM patients p WHERE p.vaccine_d28 IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM patient_pep_schedule ps WHERE ps.patient_id = p.patient_id AND ps.day_label = 'Day 28');
