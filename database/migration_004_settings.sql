-- ============================================================
-- MIGRATION 004: Settings tables
-- Run once against the animal_bite_system database.
-- ============================================================
USE animal_bite_system;

-- Extend staff_account with profile fields
ALTER TABLE staff_account
  ADD COLUMN IF NOT EXISTS full_name     VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS position      VARCHAR(100) NULL DEFAULT 'Animal Bite Center Staff',
  ADD COLUMN IF NOT EXISTS email         VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS contact_number VARCHAR(30) NULL;

-- Vaccines table
CREATE TABLE IF NOT EXISTS vaccines (
  vaccine_id   INT AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  type         VARCHAR(100) NOT NULL,
  status       ENUM('Available','Unavailable') NOT NULL DEFAULT 'Available',
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed known brands
INSERT IGNORE INTO vaccines (name, type, status) VALUES
  ('Abhayrab', 'Anti-Rabies Vaccine', 'Available'),
  ('Vaxirab',  'Anti-Rabies Vaccine', 'Available');

-- Report settings table
CREATE TABLE IF NOT EXISTS report_settings (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  center_name     VARCHAR(200) NULL DEFAULT 'HopeCare Animal Bite Center',
  city            VARCHAR(100) NULL DEFAULT 'Gingoog City',
  address         TEXT NULL,
  contact_number  VARCHAR(50)  NULL,
  prepared_by     VARCHAR(100) NULL,
  prepared_by_pos VARCHAR(100) NULL,
  noted_by        VARCHAR(100) NULL,
  prepared_by_signature LONGTEXT NULL,
  noted_by_signature    LONGTEXT NULL,
  approved_by     VARCHAR(100) NULL,
  approved_by_pos VARCHAR(100) NULL,
  logo_path       VARCHAR(255) NULL DEFAULT 'images/logo.png',
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed one default row
INSERT INTO report_settings (id, center_name, city) VALUES (1, 'HopeCare Animal Bite Center', 'Gingoog City')
ON DUPLICATE KEY UPDATE id=id;
