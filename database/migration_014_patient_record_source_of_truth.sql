-- migration_014_patient_record_source_of_truth.sql
-- Safely backfill exposure #1 and treatment #1 from existing patients rows.
-- Does NOT delete or overwrite existing multi-case history.

INSERT INTO patient_exposures (
  patient_id, exposure_number, date_of_exposure, place_of_exposure,
  type_of_animal, type_of_exposure, site_of_exposure,
  category, washing_of_bite, biting_animal_status, notes
)
SELECT
  p.patient_id, 1, p.date_of_exposure, p.place_of_exposure,
  p.type_of_animal, p.type_of_exposure, p.site_of_exposure,
  p.category, p.washing_of_bite, p.biting_animal_status, p.remarks
FROM patients p
WHERE NOT EXISTS (
  SELECT 1 FROM patient_exposures pe
  WHERE pe.patient_id = p.patient_id AND pe.exposure_number = 1
)
AND (
  p.date_of_exposure IS NOT NULL
  OR p.category IS NOT NULL
  OR p.vaccine_d0 IS NOT NULL
  OR p.place_of_exposure IS NOT NULL
  OR p.type_of_animal IS NOT NULL
);

INSERT INTO treatment_episodes (
  patient_id, exposure_id, episode_number, treatment_type, category,
  status, date_started, brand_name, route, washing_of_bite,
  vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28,
  rig_date_given, outcome, notes
)
SELECT
  p.patient_id,
  pe.exposure_id,
  1,
  'PEP',
  p.category,
  CASE
    WHEN p.vaccine_d28 IS NOT NULL THEN 'Completed'
    WHEN p.vaccine_d0 IS NOT NULL THEN 'Ongoing'
    ELSE 'Ongoing'
  END,
  COALESCE(p.vaccine_d0, p.date_registered, p.date_of_exposure),
  p.brand_name,
  p.route,
  p.washing_of_bite,
  p.vaccine_d0, p.vaccine_d3, p.vaccine_d7, p.vaccine_d14, p.vaccine_d28,
  p.rig_date_given, p.outcome, p.remarks
FROM patients p
JOIN patient_exposures pe
  ON pe.patient_id = p.patient_id AND pe.exposure_number = 1
WHERE NOT EXISTS (
  SELECT 1 FROM treatment_episodes te
  WHERE te.patient_id = p.patient_id AND te.episode_number = 1
);

-- Refresh dose dates on treatment #1 from Patient Records without touching later cases
UPDATE treatment_episodes te
JOIN patients p ON p.patient_id = te.patient_id
SET
  te.vaccine_d0 = COALESCE(p.vaccine_d0, te.vaccine_d0),
  te.vaccine_d3 = COALESCE(p.vaccine_d3, te.vaccine_d3),
  te.vaccine_d7 = COALESCE(p.vaccine_d7, te.vaccine_d7),
  te.vaccine_d14 = COALESCE(p.vaccine_d14, te.vaccine_d14),
  te.vaccine_d28 = COALESCE(p.vaccine_d28, te.vaccine_d28),
  te.brand_name = COALESCE(p.brand_name, te.brand_name),
  te.route = COALESCE(p.route, te.route),
  te.rig_date_given = COALESCE(p.rig_date_given, te.rig_date_given),
  te.washing_of_bite = COALESCE(p.washing_of_bite, te.washing_of_bite),
  te.category = COALESCE(p.category, te.category),
  te.outcome = COALESCE(p.outcome, te.outcome)
WHERE te.episode_number = 1;

UPDATE patient_exposures pe
JOIN patients p ON p.patient_id = pe.patient_id
SET
  pe.date_of_exposure = COALESCE(p.date_of_exposure, pe.date_of_exposure),
  pe.place_of_exposure = COALESCE(p.place_of_exposure, pe.place_of_exposure),
  pe.type_of_animal = COALESCE(p.type_of_animal, pe.type_of_animal),
  pe.type_of_exposure = COALESCE(p.type_of_exposure, pe.type_of_exposure),
  pe.site_of_exposure = COALESCE(p.site_of_exposure, pe.site_of_exposure),
  pe.category = COALESCE(p.category, pe.category),
  pe.washing_of_bite = COALESCE(p.washing_of_bite, pe.washing_of_bite),
  pe.biting_animal_status = COALESCE(p.biting_animal_status, pe.biting_animal_status),
  pe.notes = COALESCE(p.remarks, pe.notes)
WHERE pe.exposure_number = 1;
