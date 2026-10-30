-- ============================================================
-- MIGRATION 002: Restrict vaccine brands to Abhayrab & Vaxirab
-- HopeCare Animal Bite Center – Gingoog City
-- Run this script once against the animal_bite_system database.
-- ============================================================

USE animal_bite_system;

-- Step 1: Migrate any legacy brand values to the closest valid brand.
-- Any brand that is not Abhayrab or Vaxirab is cleared (set to NULL)
-- so records are not lost but invalid brand entries are removed.
UPDATE patients
SET brand_name = NULL
WHERE brand_name IS NOT NULL
  AND brand_name NOT IN ('Abhayrab', 'Vaxirab');

-- Step 2: Alter the column to use an ENUM so the database itself
-- enforces the two valid values going forward.
-- NULL is allowed (vaccine brand is not mandatory at registration time).
ALTER TABLE patients
  MODIFY COLUMN brand_name ENUM('Abhayrab', 'Vaxirab') NULL DEFAULT NULL;

-- Verification query — should return 0 rows after migration:
-- SELECT patient_id, brand_name FROM patients
-- WHERE brand_name IS NOT NULL AND brand_name NOT IN ('Abhayrab','Vaxirab');
