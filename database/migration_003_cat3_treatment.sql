-- ============================================================
-- MIGRATION 003: Category III Treatment Information
-- HopeCare Animal Bite Center – Gingoog City
-- Run once against the animal_bite_system database.
-- ============================================================

USE animal_bite_system;

ALTER TABLE patients

  -- ── TETANUS PROPHYLAXIS ──────────────────────────────────
  ADD COLUMN tt_given          TINYINT(1)   NULL DEFAULT 0   COMMENT 'Tetanus-Toxoid checkbox',
  ADD COLUMN tt_dose_ml        DECIMAL(5,2) NULL             COMMENT 'Tetanus-Toxoid dose (mL)',
  ADD COLUMN tt_injection_site VARCHAR(100) NULL             COMMENT 'Tetanus-Toxoid injection site',
  ADD COLUMN tt_date_given     DATE         NULL             COMMENT 'Tetanus-Toxoid date given',
  ADD COLUMN tt_given_by       VARCHAR(100) NULL             COMMENT 'Tetanus-Toxoid given by',

  ADD COLUMN ats_given         TINYINT(1)   NULL DEFAULT 0   COMMENT 'ATS checkbox',
  ADD COLUMN ats_dose_ml       DECIMAL(5,2) NULL             COMMENT 'ATS dose (mL)',
  ADD COLUMN ats_injection_site VARCHAR(100) NULL            COMMENT 'ATS injection site',
  ADD COLUMN ats_anst_result   ENUM('Positive','Negative') NULL COMMENT 'ATS ANST result',

  ADD COLUMN htig_given        TINYINT(1)   NULL DEFAULT 0   COMMENT 'HTIG checkbox',
  ADD COLUMN htig_dose_ml      DECIMAL(5,2) NULL             COMMENT 'HTIG dose (mL)',
  ADD COLUMN htig_injection_site VARCHAR(100) NULL           COMMENT 'HTIG injection site',
  ADD COLUMN htig_route        ENUM('ID','IM') NULL          COMMENT 'HTIG route',

  -- ── RIG INFILTRATION – EQUINE ────────────────────────────
  ADD COLUMN rig_equine_given  TINYINT(1)   NULL DEFAULT 0   COMMENT 'Equine RIG overall checkbox',
  ADD COLUMN rig_equirab       TINYINT(1)   NULL DEFAULT 0   COMMENT 'Equirab 200 IU/mL checkbox',
  ADD COLUMN rig_vinrab        TINYINT(1)   NULL DEFAULT 0   COMMENT 'Vinrab 200 IU/mL checkbox',
  ADD COLUMN rig_equine_up_to_ml DECIMAL(5,2) NULL           COMMENT 'Equine RIG mL infiltrated',
  ADD COLUMN rig_equine_anst   VARCHAR(100) NULL             COMMENT 'Equine ANST result',
  ADD COLUMN rig_equine_date   DATE         NULL             COMMENT 'Equine RIG date given',
  ADD COLUMN rig_equine_given_by VARCHAR(100) NULL           COMMENT 'Equine RIG given by',

  -- ── RIG INFILTRATION – HUMAN ─────────────────────────────
  ADD COLUMN rig_human_given   TINYINT(1)   NULL DEFAULT 0   COMMENT 'Human RIG overall checkbox',
  ADD COLUMN rig_berirab       TINYINT(1)   NULL DEFAULT 0   COMMENT 'Berirab 300 IU/mL checkbox',
  ADD COLUMN rig_human_up_to_ml DECIMAL(5,2) NULL            COMMENT 'Human RIG mL infiltrated',
  ADD COLUMN rig_human_date    DATE         NULL             COMMENT 'Human RIG date given',
  ADD COLUMN rig_human_given_by VARCHAR(100) NULL            COMMENT 'Human RIG given by',

  -- ── MEDS GIVEN ───────────────────────────────────────────
  ADD COLUMN meds_given        TINYINT(1)   NULL DEFAULT 0   COMMENT 'Meds given checkbox',
  ADD COLUMN meds_description  TEXT         NULL             COMMENT 'Medications prescribed/given';
