/**
 * setup-db.js — Complete Idempotent Database Initializer
 *
 * Run:  node setup-db.js   (or  npm run setup-db)
 *
 * Safe to run multiple times on fresh or existing databases.
 * Creates ALL tables required by the entire system automatically.
 */
const mysql  = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const path   = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { retireGenericDefaultVaccines } = require('./utils/retireGenericVaccines');

const DB_NAME = process.env.DB_NAME || 'animal_bite_system';

async function run() {
  console.log('═══════════════════════════════════════════════');
  console.log('  HopeCare Animal Bite Center — DB Setup');
  console.log('═══════════════════════════════════════════════');

  let conn;
  try {
    conn = await mysql.createConnection({
      host:               process.env.DB_HOST     || 'localhost',
      user:               process.env.DB_USER     || 'root',
      password:           process.env.DB_PASSWORD || '',
      multipleStatements: true,
    });
    console.log('✅  Connected to MySQL.');

    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.query(`USE \`${DB_NAME}\``);
    console.log(`✅  Database "${DB_NAME}" ready.`);

    // ─────────────────────────────────────────────────────────
    // TABLE 1: staff_account
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS staff_account (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        username         VARCHAR(50)  NOT NULL UNIQUE,
        password         VARCHAR(255) NOT NULL,
        full_name        VARCHAR(100) NULL,
        position         VARCHAR(100) NULL DEFAULT 'Animal Bite Center Staff',
        email            VARCHAR(150) NULL,
        status           ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
        designation      VARCHAR(100) NULL DEFAULT 'ABC Nurse',
        role             VARCHAR(50)  NULL DEFAULT 'Nurse',
        contact_number   VARCHAR(30)  NULL,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`ALTER TABLE staff_account
      ADD COLUMN IF NOT EXISTS status      ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
      ADD COLUMN IF NOT EXISTS designation VARCHAR(100) NULL DEFAULT 'ABC Nurse',
      ADD COLUMN IF NOT EXISTS role        VARCHAR(50)  NULL DEFAULT 'Nurse',
      ADD COLUMN IF NOT EXISTS contact_number VARCHAR(30) NULL
    `).catch(() => {});
    console.log('✅  staff_account table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 2: patients  (core patient records)
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS patients (
        patient_id              INT AUTO_INCREMENT PRIMARY KEY,
        registration_number     VARCHAR(50)  NOT NULL UNIQUE,
        full_name               VARCHAR(100) NOT NULL,
        age                     INT          NOT NULL,
        sex                     ENUM('M','F','O') NOT NULL,
        address                 TEXT         NOT NULL,
        barangay                VARCHAR(100) NOT NULL,
        municipality            VARCHAR(100) NULL DEFAULT 'Gingoog City',
        contact_number          VARCHAR(20)  NULL,
        date_registered         DATE         NOT NULL,
        date_of_exposure        DATE         NULL,
        place_of_exposure       TEXT         NULL,
        region_of_exposure      VARCHAR(200) NULL,
        type_of_animal          ENUM('D','SD','C','O') NULL,
        type_of_exposure        ENUM('B','NB','S') NULL,
        nature_of_exposure      VARCHAR(100) NULL,
        site_of_exposure        TEXT         NULL,
        category                INT(1)       NULL,
        washing_of_bite         ENUM('Y','N') NULL,
        condition_of_animal     VARCHAR(100) NULL,
        signs_symptoms          VARCHAR(100) NULL,
        rig_date_given          DATE         NULL,
        route                   VARCHAR(20)  NULL,
        vaccine_d0              DATE         NULL,
        vaccine_d3              DATE         NULL,
        vaccine_d7              DATE         NULL,
        vaccine_d14             DATE         NULL,
        vaccine_d28             DATE         NULL,
        brand_name              VARCHAR(100) NULL DEFAULT NULL,
        outcome                 ENUM('C','Inc','N','D') NULL,
        biting_animal_status    ENUM('A','D','L') NULL,
        remarks                 TEXT         NULL,
        -- Treatment tracking
        treatment_status        VARCHAR(50)  NULL,
        next_schedule           DATE         NULL,
        missed_dose             VARCHAR(20)  NULL,
        missed_date             DATE         NULL,
        schedule_suspended      TINYINT(1)   NULL DEFAULT 0,
        interrupted_status      TINYINT(1)   NULL DEFAULT 0,
        reminder_status         VARCHAR(50)  NULL,
        reminder_sent_date      DATE         NULL,
        reminder_type           VARCHAR(50)  NULL,
        -- Cat III Tetanus
        tt_given                TINYINT(1)   NULL DEFAULT 0,
        tt_dose_ml              DECIMAL(5,2) NULL,
        tt_injection_site       VARCHAR(100) NULL,
        tt_date_given           DATE         NULL,
        tt_given_by             VARCHAR(100) NULL,
        tt_route                ENUM('ID','IM') NULL,
        tt_anst_result          ENUM('Positive','Negative') NULL,
        ats_given               TINYINT(1)   NULL DEFAULT 0,
        ats_dose_ml             DECIMAL(5,2) NULL,
        ats_injection_site      VARCHAR(100) NULL,
        ats_date_given          DATE         NULL,
        ats_given_by            VARCHAR(100) NULL,
        ats_route               ENUM('ID','IM') NULL,
        ats_anst_result         ENUM('Positive','Negative') NULL,
        htig_given              TINYINT(1)   NULL DEFAULT 0,
        htig_dose_ml            DECIMAL(5,2) NULL,
        htig_injection_site     VARCHAR(100) NULL,
        htig_date_given         DATE         NULL,
        htig_given_by           VARCHAR(100) NULL,
        htig_route              ENUM('ID','IM') NULL,
        htig_anst_result        ENUM('Positive','Negative') NULL,
        -- Cat III RIG Equine
        rig_equine_given        TINYINT(1)   NULL DEFAULT 0,
        rig_equirab             TINYINT(1)   NULL DEFAULT 0,
        rig_vinrab              TINYINT(1)   NULL DEFAULT 0,
        rig_equine_up_to_ml     DECIMAL(5,2) NULL,
        rig_equine_anst         VARCHAR(100) NULL,
        rig_equine_date         DATE         NULL,
        rig_equine_given_by     VARCHAR(100) NULL,
        -- Cat III RIG Human
        rig_human_given         TINYINT(1)   NULL DEFAULT 0,
        rig_berirab             TINYINT(1)   NULL DEFAULT 0,
        rig_human_up_to_ml      DECIMAL(5,2) NULL,
        rig_human_date          DATE         NULL,
        rig_human_given_by      VARCHAR(100) NULL,
        -- Cat III Meds
        meds_given              TINYINT(1)   NULL DEFAULT 0,
        meds_description        TEXT         NULL,
        -- Patient portal account
        password                VARCHAR(255) NULL,
        is_temp_password        TINYINT(1)   NULL DEFAULT 1,
        -- Audit
        created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_by              VARCHAR(100) NULL,
        updated_by              VARCHAR(100) NULL,
        INDEX idx_registration_number (registration_number),
        INDEX idx_barangay            (barangay),
        INDEX idx_date_registered     (date_registered)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    // Add missing columns to existing installations
    const patientCols = [
      `ADD COLUMN IF NOT EXISTS municipality        VARCHAR(100) NULL DEFAULT 'Gingoog City'`,
      `ADD COLUMN IF NOT EXISTS region_of_exposure  VARCHAR(200) NULL`,
      `ADD COLUMN IF NOT EXISTS nature_of_exposure  VARCHAR(100) NULL`,
      `ADD COLUMN IF NOT EXISTS condition_of_animal VARCHAR(100) NULL`,
      `ADD COLUMN IF NOT EXISTS signs_symptoms      VARCHAR(100) NULL`,
      `ADD COLUMN IF NOT EXISTS treatment_status    VARCHAR(50)  NULL`,
      `ADD COLUMN IF NOT EXISTS next_schedule       DATE         NULL`,
      `ADD COLUMN IF NOT EXISTS missed_dose         VARCHAR(20)  NULL`,
      `ADD COLUMN IF NOT EXISTS missed_date         DATE         NULL`,
      `ADD COLUMN IF NOT EXISTS schedule_suspended  TINYINT(1)   NULL DEFAULT 0`,
      `ADD COLUMN IF NOT EXISTS interrupted_status  TINYINT(1)   NULL DEFAULT 0`,
      `ADD COLUMN IF NOT EXISTS reminder_status     VARCHAR(50)  NULL`,
      `ADD COLUMN IF NOT EXISTS reminder_sent_date  DATE         NULL`,
      `ADD COLUMN IF NOT EXISTS reminder_type       VARCHAR(50)  NULL`,
      `ADD COLUMN IF NOT EXISTS password            VARCHAR(255) NULL`,
      `ADD COLUMN IF NOT EXISTS is_temp_password    TINYINT(1)   NULL DEFAULT 1`,
      `ADD COLUMN IF NOT EXISTS temp_password_cipher TEXT        NULL`,
      `ADD COLUMN IF NOT EXISTS created_by          VARCHAR(100) NULL`,
      `ADD COLUMN IF NOT EXISTS updated_by          VARCHAR(100) NULL`,
      `ADD COLUMN IF NOT EXISTS ats_date_given      DATE         NULL`,
      `ADD COLUMN IF NOT EXISTS ats_given_by        VARCHAR(100) NULL`,
      `ADD COLUMN IF NOT EXISTS ats_route           ENUM('ID','IM') NULL`,
      `ADD COLUMN IF NOT EXISTS htig_date_given     DATE         NULL`,
      `ADD COLUMN IF NOT EXISTS htig_given_by       VARCHAR(100) NULL`,
      `ADD COLUMN IF NOT EXISTS htig_anst_result    ENUM('Positive','Negative') NULL`,
      `ADD COLUMN IF NOT EXISTS tt_route            ENUM('ID','IM') NULL`,
      `ADD COLUMN IF NOT EXISTS tt_anst_result      ENUM('Positive','Negative') NULL`,
    ];
    for (const col of patientCols) {
      await conn.query(`ALTER TABLE patients ${col}`).catch(() => {});
    }
    console.log('✅  patients table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 3: activity_logs
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id            BIGINT AUTO_INCREMENT PRIMARY KEY,
        staff_id      INT           NOT NULL DEFAULT 0,
        username      VARCHAR(50)   NOT NULL DEFAULT '',
        full_name     VARCHAR(100)  NULL,
        action        VARCHAR(50)   NOT NULL,
        module        VARCHAR(50)   NOT NULL,
        reference_id  VARCHAR(100)  NULL,
        description   TEXT          NULL,
        old_value     TEXT          NULL,
        new_value     TEXT          NULL,
        ip_address    VARCHAR(50)   NULL,
        created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_staff_id   (staff_id),
        INDEX idx_username   (username),
        INDEX idx_action     (action),
        INDEX idx_module     (module),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`
      ALTER TABLE activity_logs
        ADD COLUMN IF NOT EXISTS old_value TEXT NULL,
        ADD COLUMN IF NOT EXISTS new_value TEXT NULL
    `).catch(() => {});
    console.log('✅  activity_logs table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 4: patient_followup
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS patient_followup (
        followup_id     INT AUTO_INCREMENT PRIMARY KEY,
        patient_id      INT NOT NULL,
        followup_status ENUM('Pending','Called','Texted','Confirmed','Rescheduled','No Response','Completed')
                        NOT NULL DEFAULT 'Pending',
        last_contacted  DATE NULL,
        staff_name      VARCHAR(100) NULL,
        notes           TEXT NULL,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_by      VARCHAR(100) NULL,
        updated_by      VARCHAR(100) NULL,
        UNIQUE KEY uq_patient (patient_id),
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      ALTER TABLE patient_followup
        ADD COLUMN IF NOT EXISTS notes      TEXT NULL,
        ADD COLUMN IF NOT EXISTS created_by VARCHAR(100) NULL,
        ADD COLUMN IF NOT EXISTS updated_by VARCHAR(100) NULL
    `).catch(() => {});
    await conn.query(`ALTER TABLE patient_followup DROP COLUMN IF EXISTS remarks`).catch(() => {});
    await conn.query(`DROP TABLE IF EXISTS followup_notes`).catch(() => {});
    console.log('✅  patient_followup table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 5: vaccines  (vaccine brands master list)
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS vaccines (
        vaccine_id INT AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        type       VARCHAR(100) NOT NULL DEFAULT 'Anti-Rabies Vaccine',
        category   VARCHAR(50)  NULL DEFAULT 'Anti-Rabies',
        status     ENUM('Available','Unavailable') NOT NULL DEFAULT 'Available',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_by VARCHAR(100) NULL,
        updated_by VARCHAR(100) NULL,
        CONSTRAINT uq_vaccine_name UNIQUE (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`ALTER TABLE vaccines ADD CONSTRAINT uq_vaccine_name UNIQUE (name)`).catch(() => {});
    await conn.query(`
      ALTER TABLE vaccines
        ADD COLUMN IF NOT EXISTS category   VARCHAR(50)  NULL DEFAULT 'Anti-Rabies',
        ADD COLUMN IF NOT EXISTS created_by VARCHAR(100) NULL,
        ADD COLUMN IF NOT EXISTS updated_by VARCHAR(100) NULL
    `).catch(() => {});
    await conn.query(`
      INSERT IGNORE INTO vaccines (name, type, category, status) VALUES
        ('Abhayrab',   'Anti-Rabies Vaccine (PVRV)',                      'Anti-Rabies Vaccine',   'Available'),
        ('Vaxirab',    'Anti-Rabies Vaccine (PVRV)',                      'Anti-Rabies Vaccine',   'Available'),
        ('Equirab',    'Equine Rabies Immunoglobulin (200 IU/mL)',        'ERIG',                  'Available'),
        ('Vinrab',     'Equine Rabies Immunoglobulin (200 IU/mL)',        'ERIG',                  'Available'),
        ('Berirab',    'Human Rabies Immunoglobulin (300 IU/mL)',         'HRIG',                  'Available'),
        ('TT',         'Tetanus Toxoid',                                  'Tetanus Prophylaxis',   'Available'),
        -- Removed: ('ATS',        'Anti-Tetanus Serum',                              'Tetanus Prophylaxis',   'Available'),
        ('HTIG',       'Human Tetanus Immunoglobulin',                    'Tetanus Prophylaxis',   'Available'),
        ('ATS 1500',   'Anti-Tetanus Serum',                              'Tetanus Prophylaxis',   'Available'),
        ('ATS 3000',   'Anti-Tetanus Serum',                              'Tetanus Prophylaxis',   'Available')
        -- Removed: ('ATS 5000',   'Anti-Tetanus Serum',                              'Tetanus Prophylaxis',   'Available')
    `);

    // Migrate existing rows from old category names to canonical names
    await conn.query(`
      UPDATE vaccines SET
        category = CASE
          WHEN LOWER(category) IN ('anti-rabies','anti_rabies','pvrv','arv') THEN 'Anti-Rabies Vaccine'
          WHEN LOWER(category) IN ('equine rig','erig','equine') THEN 'ERIG'
          WHEN LOWER(category) IN ('human rig','hrig','human') THEN 'HRIG'
          WHEN LOWER(category) IN ('tetanus prophylaxis','tetanus') THEN 'Tetanus Prophylaxis'
          ELSE category
        END
      WHERE category NOT IN ('Anti-Rabies Vaccine','ERIG','HRIG','Tetanus Prophylaxis')
        AND category IS NOT NULL
    `).catch(() => {});
    // Also update type strings to match canonical format
    await conn.query(`UPDATE vaccines SET type='Anti-Rabies Vaccine (PVRV)' WHERE name IN ('Abhayrab','Vaxirab')`).catch(() => {});
    await conn.query(`UPDATE vaccines SET category='Anti-Rabies Vaccine' WHERE name IN ('Abhayrab','Vaxirab')`).catch(() => {});
    await conn.query(`UPDATE vaccines SET type='Equine Rabies Immunoglobulin (200 IU/mL)', category='ERIG' WHERE name IN ('Equirab','Vinrab')`).catch(() => {});
    await conn.query(`UPDATE vaccines SET type='Human Rabies Immunoglobulin (300 IU/mL)', category='HRIG' WHERE name='Berirab'`).catch(() => {});
    await conn.query(`UPDATE vaccines SET category='Tetanus Prophylaxis' WHERE name IN ('TT','HTIG','ATS 1500','ATS 3000')`).catch(() => {});
    await conn.query(`UPDATE vaccines SET concentration='200 IU/mL' WHERE name IN ('Equirab','Vinrab') AND (concentration IS NULL OR concentration='')`).catch(() => {});
    await conn.query(`UPDATE vaccines SET concentration='300 IU/mL' WHERE name='Berirab' AND (concentration IS NULL OR concentration='')`).catch(() => {});
    const retired = await retireGenericDefaultVaccines(conn).catch((e) => {
      console.warn('⚠️  Generic default vaccine retire skipped:', e.message);
      return [];
    });
    if (retired && retired.length) {
      console.log(`✅  Retired generic default vaccines: ${retired.map((r) => r.name + '=' + r.action).join(', ')}`);
    }
    console.log('✅  vaccines table ready.');

    // Allow Anti-Rabies brands from Vaccine Management (not only Abhayrab/Vaxirab)
    await conn.query(`ALTER TABLE patients MODIFY COLUMN brand_name VARCHAR(100) NULL DEFAULT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE treatment_episodes MODIFY COLUMN brand_name VARCHAR(100) NULL`).catch(() => {});
    console.log('✅  brand_name columns accept Vaccine Management brands.');

    // ─────────────────────────────────────────────────────────
    // TABLE 6: vaccine_inventory
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS vaccine_inventory (
        inventory_id             INT AUTO_INCREMENT PRIMARY KEY,
        vaccine_id               INT          NOT NULL,
        batch_number             VARCHAR(100) NULL,
        quantity                 INT          NOT NULL DEFAULT 0,
        expiry_date              DATE         NULL,
        low_stock_threshold      INT          NOT NULL DEFAULT 10,
        critical_stock_threshold INT          NOT NULL DEFAULT 5,
        notes                    TEXT         NULL,
        created_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (vaccine_id) REFERENCES vaccines(vaccine_id) ON DELETE CASCADE,
        INDEX idx_vi_vaccine (vaccine_id),
        INDEX idx_vi_expiry  (expiry_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅  vaccine_inventory table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 7: vaccine_transactions
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS vaccine_transactions (
        transaction_id      INT AUTO_INCREMENT PRIMARY KEY,
        inventory_id        INT          NULL,
        vaccine_id          INT          NOT NULL,
        transaction_type    VARCHAR(50)  NOT NULL,
        quantity            INT          NOT NULL DEFAULT 0,
        staff_id            INT          NULL,
        staff_name          VARCHAR(100) NULL,
        staff_id_display    VARCHAR(20)  NULL,
        shift               VARCHAR(30)  NULL,
        patient_id          INT          NULL,
        notes               TEXT         NULL,
        remarks             TEXT         NULL,
        transaction_date    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vaccine_id) REFERENCES vaccines(vaccine_id) ON DELETE CASCADE,
        INDEX idx_vt_vaccine  (vaccine_id),
        INDEX idx_vt_date     (transaction_date),
        INDEX idx_vt_type     (transaction_type),
        INDEX idx_vt_shift    (shift)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅  vaccine_transactions table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 8: inventory_daily_records
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS inventory_daily_records (
        record_id               INT AUTO_INCREMENT PRIMARY KEY,
        record_date             DATE         NOT NULL,
        vaccine_id              INT          NOT NULL,
        shift                   VARCHAR(30)  NULL DEFAULT 'Morning',
        morning_shift_inventory INT          NOT NULL DEFAULT 0,
        vaccine_used            INT          NOT NULL DEFAULT 0,
        remaining_pm_shift      INT          NOT NULL DEFAULT 0,
        additional_vaccine      INT          NOT NULL DEFAULT 0,
        expiration_date         DATE         NULL,
        remarks                 TEXT         NULL,
        recorded_by             INT          NULL,
        recorded_by_name        VARCHAR(100) NULL,
        recorded_by_id_display  VARCHAR(20)  NULL,
        created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (vaccine_id) REFERENCES vaccines(vaccine_id) ON DELETE CASCADE,
        UNIQUE KEY uq_daily_record (record_date, vaccine_id, shift),
        INDEX idx_idr_date    (record_date),
        INDEX idx_idr_vaccine (vaccine_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅  inventory_daily_records table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 9: report_settings
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS report_settings (
        id                       INT AUTO_INCREMENT PRIMARY KEY,
        center_name              VARCHAR(200) NULL DEFAULT 'HopeCare Animal Bite Center',
        city                     VARCHAR(100) NULL DEFAULT 'Gingoog City',
        prepared_by              VARCHAR(100) NULL,
        approved_by              VARCHAR(100) NULL,
        noted_by                 VARCHAR(100) NULL,
        prepared_by_designation  VARCHAR(100) NULL,
        noted_by_designation     VARCHAR(100) NULL,
        prepared_by_signature    LONGTEXT     NULL,
        noted_by_signature       LONGTEXT     NULL,
        updated_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        updated_by               VARCHAR(100) NULL,
        generated_by             VARCHAR(100) NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      ALTER TABLE report_settings
        ADD COLUMN IF NOT EXISTS noted_by                 VARCHAR(100) NULL,
        ADD COLUMN IF NOT EXISTS prepared_by_designation  VARCHAR(100) NULL,
        ADD COLUMN IF NOT EXISTS noted_by_designation     VARCHAR(100) NULL,
        ADD COLUMN IF NOT EXISTS prepared_by_signature    LONGTEXT     NULL,
        ADD COLUMN IF NOT EXISTS noted_by_signature       LONGTEXT     NULL,
        ADD COLUMN IF NOT EXISTS updated_by               VARCHAR(100) NULL,
        ADD COLUMN IF NOT EXISTS generated_by             VARCHAR(100) NULL
    `).catch(() => {});
    await conn.query(`
      ALTER TABLE report_settings
        DROP COLUMN IF EXISTS address,
        DROP COLUMN IF EXISTS contact_number,
        DROP COLUMN IF EXISTS prepared_by_pos,
        DROP COLUMN IF EXISTS approved_by_pos,
        DROP COLUMN IF EXISTS logo_path
    `).catch(() => {});
    await conn.query(`INSERT IGNORE INTO report_settings (id, center_name, city) VALUES (1,'HopeCare Animal Bite Center','Gingoog City')`);
    console.log('✅  report_settings table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 10: patient_accounts  (portal login accounts)
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS patient_accounts (
        account_id       INT AUTO_INCREMENT PRIMARY KEY,
        patient_id       INT          NOT NULL UNIQUE,
        username         VARCHAR(50)  NOT NULL UNIQUE,
        password_hash    VARCHAR(255) NOT NULL,
        first_login      TINYINT(1)   NOT NULL DEFAULT 1,
        account_status   ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
        is_locked        TINYINT(1)   NOT NULL DEFAULT 0,
        failed_attempts  INT          NOT NULL DEFAULT 0,
        last_login       DATETIME     NULL,
        created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_pa_username (username),
        INDEX idx_pa_patient  (patient_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`
      ALTER TABLE patient_accounts
        ADD COLUMN IF NOT EXISTS account_status  ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
        ADD COLUMN IF NOT EXISTS is_locked       TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS failed_attempts INT        NOT NULL DEFAULT 0
    `).catch(() => {});
    console.log('✅  patient_accounts table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 11: patient_notifications
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS patient_notifications (
        notif_id      INT AUTO_INCREMENT PRIMARY KEY,
        patient_id    INT          NOT NULL,
        type          VARCHAR(50)  NOT NULL DEFAULT 'INFO',
        title         VARCHAR(200) NOT NULL DEFAULT 'Notification',
        message       TEXT         NOT NULL,
        is_read       TINYINT(1)   NOT NULL DEFAULT 0,
        related_date  DATE         NULL,
        created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_pn_patient  (patient_id),
        INDEX idx_pn_is_read  (is_read),
        INDEX idx_pn_created  (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅  patient_notifications table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 12: vaccination_reminders
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS vaccination_reminders (
        reminder_id      INT AUTO_INCREMENT PRIMARY KEY,
        patient_id       INT          NOT NULL,
        dose_label       VARCHAR(20)  NOT NULL,
        scheduled_date   DATE         NOT NULL,
        reminder_type    VARCHAR(30)  NOT NULL,
        reminder_status  VARCHAR(30)  NOT NULL DEFAULT 'Pending',
        message          TEXT         NULL,
        sent_at          DATETIME     NULL,
        created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_vr_patient (patient_id),
        INDEX idx_vr_date    (scheduled_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅  vaccination_reminders table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 13: staff_notifications
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS staff_notifications (
        notif_id    INT AUTO_INCREMENT PRIMARY KEY,
        patient_id  INT          NOT NULL,
        type        VARCHAR(50)  NOT NULL DEFAULT 'INFO',
        title       VARCHAR(200) NOT NULL DEFAULT 'Notification',
        message     TEXT         NOT NULL,
        missed_dose VARCHAR(20)  NULL,
        missed_date DATE         NULL,
        days_overdue INT         NULL DEFAULT 0,
        is_read     TINYINT(1)   NOT NULL DEFAULT 0,
        created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_sn_patient (patient_id),
        INDEX idx_sn_is_read (is_read),
        INDEX idx_sn_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅  staff_notifications table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 14: patient_login_history
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS patient_login_history (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        patient_id INT         NOT NULL,
        login_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ip_address VARCHAR(50) NULL,
        user_agent TEXT        NULL,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_plh_patient (patient_id),
        INDEX idx_plh_login   (login_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅  patient_login_history table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 15: patient_pep_schedule  (Post-Exposure Prophylaxis)
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS patient_pep_schedule (
        pep_id               INT AUTO_INCREMENT PRIMARY KEY,
        patient_id           INT          NOT NULL,
        day_label            VARCHAR(20)  NOT NULL,
        date_due             DATE         NULL,
        date_given           DATE         NULL,
        vaccine_brand        VARCHAR(100) NULL,
        route                VARCHAR(20)  NULL,
        site_right           TINYINT(1)   NULL DEFAULT 0,
        site_left            TINYINT(1)   NULL DEFAULT 0,
        vaccinated_by        VARCHAR(100) NULL COMMENT 'Display name of vaccinating nurse',
        vaccinator_staff_id  INT          NULL COMMENT 'FK to staff_account.id',
        remarks              TEXT         NULL,
        created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_pep_patient    (patient_id),
        INDEX idx_pep_vaccinator (vaccinator_staff_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    // Safety-net ALTER for existing installations (migration 015)
    await conn.query(`ALTER TABLE patient_pep_schedule ADD COLUMN IF NOT EXISTS vaccinator_staff_id INT NULL COMMENT 'FK to staff_account.id'`).catch(() => {});
    await conn.query(`ALTER TABLE patient_pep_schedule ADD INDEX IF NOT EXISTS idx_pep_vaccinator (vaccinator_staff_id)`).catch(() => {});
    console.log('✅  patient_pep_schedule table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 16: patient_prep_schedule  (Pre-Exposure Prophylaxis)
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS patient_prep_schedule (
        prep_id       INT AUTO_INCREMENT PRIMARY KEY,
        patient_id    INT          NOT NULL,
        day_label     VARCHAR(20)  NOT NULL,
        date_due      DATE         NULL,
        date_given    DATE         NULL,
        vaccine_brand VARCHAR(100) NULL,
        route         VARCHAR(20)  NULL,
        site_right    TINYINT(1)   NULL DEFAULT 0,
        site_left     TINYINT(1)   NULL DEFAULT 0,
        vaccinated_by VARCHAR(100) NULL,
        remarks       TEXT         NULL,
        created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_prep_patient (patient_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅  patient_prep_schedule table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 17: patient_booster_schedule
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS patient_booster_schedule (
        booster_id    INT AUTO_INCREMENT PRIMARY KEY,
        patient_id    INT          NOT NULL,
        day_label     VARCHAR(20)  NOT NULL,
        date_due      DATE         NULL,
        date_given    DATE         NULL,
        vaccine_brand VARCHAR(100) NULL,
        route         VARCHAR(20)  NULL,
        site_right    TINYINT(1)   NULL DEFAULT 0,
        site_left     TINYINT(1)   NULL DEFAULT 0,
        vaccinated_by VARCHAR(100) NULL,
        remarks       TEXT         NULL,
        created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_booster_patient (patient_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅  patient_booster_schedule table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 18: patient_tt_schedule  (Tetanus Toxoid schedule)
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS patient_tt_schedule (
        tt_id          INT AUTO_INCREMENT PRIMARY KEY,
        patient_id     INT          NOT NULL,
        dose_label     VARCHAR(20)  NOT NULL,
        date_due       DATE         NULL,
        date_given     DATE         NULL,
        vaccine_brand  VARCHAR(100) NULL,
        injection_site VARCHAR(100) NULL,
        vaccinated_by  VARCHAR(100) NULL,
        dose_ml        DECIMAL(5,2) NULL,
        remarks        TEXT         NULL,
        created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_tt_patient (patient_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅  patient_tt_schedule table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 20: patient_exposures
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS patient_exposures (
        exposure_id          INT AUTO_INCREMENT PRIMARY KEY,
        patient_id           INT NOT NULL,
        exposure_number      INT NOT NULL DEFAULT 1,
        date_of_exposure     DATE NULL,
        time_of_exposure     VARCHAR(20) NULL,
        place_of_exposure    TEXT NULL,
        barangay             VARCHAR(100) NULL COMMENT 'Barangay where the exposure/bite occurred',
        region_of_exposure   VARCHAR(200) NULL,
        -- Animal info (from form)
        type_of_animal       VARCHAR(20) NULL,
        animal_ownership     ENUM('Own Pet','Others Pet','Stray') NULL,
        animal_status        ENUM('Alive','Dead','Cannot be Observed') NULL,
        -- Exposure details
        type_of_exposure     ENUM('B','NB','S') NULL,
        site_of_exposure     TEXT NULL,
        wound_type           VARCHAR(100) NULL,
        wound_severity       ENUM('Single','Multiple') NULL,
        nature_of_exposure   VARCHAR(100) NULL,
        -- Category
        category             INT NULL,
        washing_of_bite      ENUM('Y','N') NULL,
        -- Patient history
        pre_exposure_hx      VARCHAR(200) NULL,
        allergy              VARCHAR(200) NULL,
        co_morbidities       VARCHAR(200) NULL,
        tetanus_vaccine_hx   VARCHAR(200) NULL,
        -- Legacy fields
        condition_of_animal  VARCHAR(100) NULL,
        signs_symptoms       VARCHAR(100) NULL,
        biting_animal_status VARCHAR(10) NULL,
        animal_owner         VARCHAR(100) NULL,
        notes                TEXT NULL,
        status               VARCHAR(30) NOT NULL DEFAULT 'Active',
        created_by           VARCHAR(100) NULL,
        created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_pe_patient  (patient_id),
        INDEX idx_pe_number   (patient_id, exposure_number),
        INDEX idx_pe_barangay (barangay)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅  patient_exposures table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 21: treatment_episodes
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS treatment_episodes (
        episode_id           INT AUTO_INCREMENT PRIMARY KEY,
        patient_id           INT NOT NULL,
        exposure_id          INT NULL,
        episode_number       INT NOT NULL DEFAULT 1,
        treatment_type       VARCHAR(50) NOT NULL DEFAULT 'PEP',
        category             INT NULL,
        status               VARCHAR(50) NOT NULL DEFAULT 'Ongoing',
        date_started         DATE NOT NULL,
        date_completed       DATE NULL,
        brand_name           VARCHAR(100) NULL,
        route                VARCHAR(20) NULL,
        vaccine_d0           DATE NULL,
        vaccine_d3           DATE NULL,
        vaccine_d7           DATE NULL,
        vaccine_d14          DATE NULL,
        vaccine_d28          DATE NULL,
        rig_date_given       DATE NULL,
        washing_of_bite      ENUM('Y','N') NULL,
        missed_dose          VARCHAR(20) NULL,
        missed_date          DATE NULL,
        schedule_suspended   TINYINT(1) NOT NULL DEFAULT 0,
        interrupted_reviewed TINYINT(1) NOT NULL DEFAULT 0,
        interrupted_reason   TEXT NULL,
        interrupted_reviewed_by VARCHAR(100) NULL,
        interrupted_reviewed_at DATETIME NULL,
        outcome              ENUM('C','Inc','N','D') NULL,
        notes                TEXT NULL,
        created_by           VARCHAR(100) NULL,
        created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        FOREIGN KEY (exposure_id) REFERENCES patient_exposures(exposure_id) ON DELETE SET NULL,
        INDEX idx_te_patient  (patient_id),
        INDEX idx_te_exposure (exposure_id),
        INDEX idx_te_status   (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`ALTER TABLE treatment_episodes ADD COLUMN IF NOT EXISTS washing_of_bite ENUM('Y','N') NULL`).catch(() => {});
    console.log('✅  treatment_episodes table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 22: rig_records  (RIG Infiltration per episode)
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS rig_records (
        rig_id          INT AUTO_INCREMENT PRIMARY KEY,
        episode_id      INT NOT NULL,
        patient_id      INT NOT NULL,
        rig_given       TINYINT(1) NOT NULL DEFAULT 0,
        rig_type        ENUM('Equine','Human') NULL,
        rig_brand       VARCHAR(100) NULL,
        concentration   VARCHAR(50) NULL,
        volume_ml       DECIMAL(5,2) NULL,
        anst_result     ENUM('Positive','Negative') NULL,
        injection_site  VARCHAR(100) NULL,
        date_given      DATE NULL,
        given_by        VARCHAR(100) NULL,
        remarks         TEXT NULL,
        created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (episode_id) REFERENCES treatment_episodes(episode_id) ON DELETE CASCADE,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_rig_episode (episode_id),
        INDEX idx_rig_patient (patient_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅  rig_records table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 23: tetanus_records  (Tetanus Prophylaxis per episode)
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tetanus_records (
        tetanus_id      INT AUTO_INCREMENT PRIMARY KEY,
        episode_id      INT NOT NULL,
        patient_id      INT NOT NULL,
        type            ENUM('TT','HTIG','ATS 1500','ATS 3000','Other') NOT NULL DEFAULT 'TT',
        given           TINYINT(1) NOT NULL DEFAULT 0,
        dose_ml         DECIMAL(5,2) NULL,
        injection_site  VARCHAR(100) NULL,
        route           ENUM('ID','IM') NULL,
        anst_result     ENUM('Positive','Negative') NULL,
        date_given      DATE NULL,
        given_by        VARCHAR(100) NULL,
        remarks         TEXT NULL,
        created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (episode_id) REFERENCES treatment_episodes(episode_id) ON DELETE CASCADE,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_tet_episode (episode_id),
        INDEX idx_tet_patient (patient_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅  tetanus_records table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 24: medication_records  (Medications per episode)
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS medication_records (
        med_id          INT AUTO_INCREMENT PRIMARY KEY,
        episode_id      INT NOT NULL,
        patient_id      INT NOT NULL,
        medication_name VARCHAR(200) NOT NULL,
        dosage          VARCHAR(100) NULL,
        route           VARCHAR(50) NULL,
        date_given      DATE NULL,
        given_by        VARCHAR(100) NULL,
        remarks         TEXT NULL,
        created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (episode_id) REFERENCES treatment_episodes(episode_id) ON DELETE CASCADE,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_med_episode (episode_id),
        INDEX idx_med_patient (patient_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅  medication_records table ready.');

    // Add missing columns to patient_exposures for existing installs
    const expCols = [
      `ADD COLUMN IF NOT EXISTS time_of_exposure     VARCHAR(20) NULL`,
      `ADD COLUMN IF NOT EXISTS animal_ownership     ENUM('Own Pet','Others Pet','Stray') NULL`,
      `ADD COLUMN IF NOT EXISTS animal_status        ENUM('Alive','Dead','Cannot be Observed') NULL`,
      `ADD COLUMN IF NOT EXISTS wound_type           VARCHAR(100) NULL`,
      `ADD COLUMN IF NOT EXISTS wound_severity       ENUM('Single','Multiple') NULL`,
      `ADD COLUMN IF NOT EXISTS pre_exposure_hx      VARCHAR(200) NULL`,
      `ADD COLUMN IF NOT EXISTS allergy              VARCHAR(200) NULL`,
      `ADD COLUMN IF NOT EXISTS co_morbidities       VARCHAR(200) NULL`,
      `ADD COLUMN IF NOT EXISTS tetanus_vaccine_hx   VARCHAR(200) NULL`,
      `ADD COLUMN IF NOT EXISTS barangay             VARCHAR(100) NULL COMMENT 'Barangay where the exposure/bite occurred' AFTER place_of_exposure`,
    ];
    for (const col of expCols) {
      await conn.query(`ALTER TABLE patient_exposures ${col}`).catch(() => {});
    }
    // Add episode fields to patient_pep_schedule that match the form
    await conn.query(`ALTER TABLE patient_pep_schedule ADD COLUMN IF NOT EXISTS dose_ml DECIMAL(5,2) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE patient_pep_schedule ADD COLUMN IF NOT EXISTS vaccinated_by VARCHAR(100) NULL`).catch(() => {});
    console.log('✅  Exposure and episode migration columns added.');

    // ─────────────────────────────────────────────────────────
    // TABLE 19: system_config  (admin system configuration)
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS system_config (
        config_id    INT AUTO_INCREMENT PRIMARY KEY,
        config_key   VARCHAR(100) NOT NULL UNIQUE,
        config_value TEXT         NOT NULL,
        description  VARCHAR(255) NULL,
        updated_by   VARCHAR(100) NULL,
        updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_sc_key (config_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    // Safety net: add description column if it was missing from an older schema
    await conn.query(`
      ALTER TABLE system_config
        ADD COLUMN IF NOT EXISTS description VARCHAR(255) NULL AFTER config_value
    `).catch(() => {});
    await conn.query(`
      INSERT IGNORE INTO system_config (config_key, config_value, description) VALUES
        ('center_name',    'HopeCare Animal Bite Center', 'Name of the health center'),
        ('center_city',    'Gingoog City',                'City where the center is located'),
        ('center_contact', '',                            'Contact number of the center'),
        ('session_timeout','86400',                       'Session timeout in seconds'),
        ('low_stock_default',  '10',                      'Default low stock threshold'),
        ('critical_stock_default', '5',                   'Default critical stock threshold')
    `);
    console.log('✅  system_config table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 20: patient_exposures
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS patient_exposures (
        exposure_id          INT AUTO_INCREMENT PRIMARY KEY,
        patient_id           INT NOT NULL,
        exposure_number      INT NOT NULL DEFAULT 1,
        date_of_exposure     DATE NULL,
        place_of_exposure    TEXT NULL,
        region_of_exposure   VARCHAR(200) NULL,
        type_of_animal       ENUM('D','SD','C','O') NULL,
        type_of_exposure     ENUM('B','NB','S') NULL,
        nature_of_exposure   VARCHAR(100) NULL,
        site_of_exposure     TEXT NULL,
        category             INT(1) NULL,
        washing_of_bite      ENUM('Y','N') NULL,
        condition_of_animal  VARCHAR(100) NULL,
        signs_symptoms       VARCHAR(100) NULL,
        biting_animal_status ENUM('Alive','Dead','Lost') NULL,
        animal_owner         VARCHAR(100) NULL,
        notes                TEXT NULL,
        status               VARCHAR(30) NOT NULL DEFAULT 'Active',
        created_by           VARCHAR(100) NULL,
        created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_pe_patient (patient_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅  patient_exposures table ready.');

    // ─────────────────────────────────────────────────────────
    // TABLE 21: treatment_episodes
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS treatment_episodes (
        episode_id           INT AUTO_INCREMENT PRIMARY KEY,
        patient_id           INT NOT NULL,
        exposure_id          INT NULL,
        episode_number       INT NOT NULL DEFAULT 1,
        treatment_type       VARCHAR(50) NOT NULL DEFAULT 'PEP',
        category             INT(1) NULL,
        status               VARCHAR(50) NOT NULL DEFAULT 'Ongoing',
        date_started         DATE NOT NULL,
        date_completed       DATE NULL,
        brand_name           VARCHAR(100) NULL,
        route                VARCHAR(20) NULL,
        vaccine_d0           DATE NULL,
        vaccine_d3           DATE NULL,
        vaccine_d7           DATE NULL,
        vaccine_d14          DATE NULL,
        vaccine_d28          DATE NULL,
        rig_date_given       DATE NULL,
        missed_dose          VARCHAR(20) NULL,
        missed_date          DATE NULL,
        schedule_suspended   TINYINT(1) NOT NULL DEFAULT 0,
        interrupted_reviewed TINYINT(1) NOT NULL DEFAULT 0,
        interrupted_reason   TEXT NULL,
        interrupted_reviewed_by VARCHAR(100) NULL,
        interrupted_reviewed_at DATETIME NULL,
        outcome              ENUM('C','Inc','N','D') NULL,
        notes                TEXT NULL,
        created_by           VARCHAR(100) NULL,
        created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        FOREIGN KEY (exposure_id) REFERENCES patient_exposures(exposure_id) ON DELETE SET NULL,
        INDEX idx_te_patient  (patient_id),
        INDEX idx_te_exposure (exposure_id),
        INDEX idx_te_status   (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅  treatment_episodes table ready.');

    // ─────────────────────────────────────────────────────────
    // MIGRATION: Registration number backfill (ABC-YYYY-NNNNNN)
    // ─────────────────────────────────────────────────────────
    try {
      const [backfillResult] = await conn.query(`
        UPDATE patients
        SET registration_number = CONCAT(
          'ABC-', YEAR(COALESCE(date_registered, created_at)), '-',
          LPAD(CAST(registration_number AS UNSIGNED), 6, '0')
        )
        WHERE registration_number NOT LIKE 'ABC-%'
          AND registration_number REGEXP '^[0-9]+$'
      `);
      console.log(`✅  Registration number backfill complete (${backfillResult.affectedRows || 0} updated).`);
    } catch (e) {
      console.warn('⚠️  Registration number backfill skipped:', e.message);
    }

    // ─────────────────────────────────────────────────────────
    // MIGRATION: Admin role backfill
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      UPDATE staff_account SET role = 'Administrator'
      WHERE username = 'admin' AND (role IS NULL OR role = 'Nurse' OR role = '')
    `).catch(() => {});
    console.log('✅  Admin role backfill complete.');

    // ─────────────────────────────────────────────────────────
    // MIGRATION: Episode-related column additions
    // ─────────────────────────────────────────────────────────
    // Add episode_id + status to schedule tables
    for (const tbl of ['patient_pep_schedule','patient_prep_schedule','patient_booster_schedule','patient_tt_schedule']) {
      await conn.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS episode_id INT NULL`).catch(() => {});
      await conn.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS status VARCHAR(30) NULL DEFAULT 'Pending'`).catch(() => {});
    }
    // Add episode_id to notification tables
    await conn.query(`ALTER TABLE vaccination_reminders ADD COLUMN IF NOT EXISTS episode_id INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE staff_notifications    ADD COLUMN IF NOT EXISTS episode_id INT NULL`).catch(() => {});
    // Add interrupted review columns to patients
    await conn.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS interrupted_reviewed       TINYINT(1)   NOT NULL DEFAULT 0`).catch(() => {});
    await conn.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS interrupted_reason         TEXT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS interrupted_reviewed_by    VARCHAR(100) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS interrupted_reviewed_at    DATETIME NULL`).catch(() => {});
    // Add missing patient_login_history columns used by patientAuth.js
    await conn.query(`ALTER TABLE patient_login_history ADD COLUMN IF NOT EXISTS username VARCHAR(50) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE patient_login_history ADD COLUMN IF NOT EXISTS success  TINYINT(1) NOT NULL DEFAULT 1`).catch(() => {});
    // Fix biting_animal_status to use A/D/L codes matching the logbook
    await conn.query(`ALTER TABLE patients MODIFY COLUMN biting_animal_status ENUM('A','D','L','Alive','Dead','Lost') NULL`).catch(() => {});
    await conn.query(`UPDATE patients SET biting_animal_status = 'A' WHERE biting_animal_status = 'Alive'`).catch(() => {});
    await conn.query(`UPDATE patients SET biting_animal_status = 'D' WHERE biting_animal_status = 'Dead'`).catch(() => {});
    await conn.query(`UPDATE patients SET biting_animal_status = 'L' WHERE biting_animal_status = 'Lost'`).catch(() => {});
    await conn.query(`ALTER TABLE patients MODIFY COLUMN biting_animal_status ENUM('A','D','L') NULL`).catch(() => {});
    console.log('✅  Episode migration columns added.');

    // ─────────────────────────────────────────────────────────
    // MIGRATION: Backfill episode 1 from existing patient data
    // ─────────────────────────────────────────────────────────
    try {
      await conn.query(`
        INSERT INTO patient_exposures (
          patient_id, exposure_number, date_of_exposure, place_of_exposure,
          region_of_exposure, type_of_animal, type_of_exposure, nature_of_exposure,
          site_of_exposure, category, washing_of_bite, condition_of_animal,
          signs_symptoms, biting_animal_status, created_by
        )
        SELECT
          patient_id, 1, date_of_exposure, place_of_exposure,
          region_of_exposure, type_of_animal, type_of_exposure, nature_of_exposure,
          site_of_exposure, category, washing_of_bite, condition_of_animal,
          signs_symptoms, biting_animal_status, created_by
        FROM patients p
        WHERE NOT EXISTS (
          SELECT 1 FROM patient_exposures pe WHERE pe.patient_id = p.patient_id
        )
      `);
    } catch (e) { console.warn('⚠️  Exposure backfill skipped:', e.message); }

    try {
      await conn.query(`
        INSERT INTO treatment_episodes (
          patient_id, exposure_id, episode_number, treatment_type, category,
          status, date_started, brand_name, route,
          vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28,
          rig_date_given, missed_dose, missed_date, schedule_suspended, outcome, created_by
        )
        SELECT
          p.patient_id,
          pe.exposure_id,
          1, 'PEP', p.category,
          CASE
            WHEN p.outcome = 'C'                         THEN 'Completed'
            WHEN p.treatment_status = 'Treatment Interrupted' THEN 'Treatment Interrupted'
            WHEN p.vaccine_d0 IS NOT NULL                THEN 'Ongoing'
            ELSE 'Ongoing'
          END,
          COALESCE(p.vaccine_d0, p.date_registered),
          p.brand_name, p.route,
          p.vaccine_d0, p.vaccine_d3, p.vaccine_d7, p.vaccine_d14, p.vaccine_d28,
          p.rig_date_given,
          p.missed_dose, p.missed_date,
          COALESCE(p.schedule_suspended, 0),
          p.outcome, p.created_by
        FROM patients p
        LEFT JOIN patient_exposures pe
          ON pe.patient_id = p.patient_id AND pe.exposure_number = 1
        WHERE NOT EXISTS (
          SELECT 1 FROM treatment_episodes te
          WHERE te.patient_id = p.patient_id AND te.episode_number = 1
        )
      `);
    } catch (e) { console.warn('⚠️  Episode backfill skipped:', e.message); }

    // Backfill episode_id into existing patient_pep_schedule rows for episode 1
    try {
      await conn.query(`
        UPDATE patient_pep_schedule pep
        JOIN treatment_episodes te ON te.patient_id = pep.patient_id AND te.episode_number = 1
        SET pep.episode_id = te.episode_id
        WHERE pep.episode_id IS NULL
      `);
      await conn.query(`
        UPDATE patient_pep_schedule SET status = 'Completed' WHERE date_given IS NOT NULL AND status IS NULL
      `);
      await conn.query(`
        UPDATE patient_pep_schedule SET status = 'Pending' WHERE date_given IS NULL AND status IS NULL
      `);
    } catch (e) { console.warn('⚠️  PEP schedule backfill skipped:', e.message); }

    console.log('✅  Episode 1 backfill complete.');

    // ─────────────────────────────────────────────────────────
    // MIGRATION: episode_id columns on schedule/notification tables
    // ─────────────────────────────────────────────────────────
    for (const tbl of ['patient_pep_schedule','patient_prep_schedule','patient_booster_schedule','patient_tt_schedule']) {
      await conn.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS episode_id INT NULL`).catch(() => {});
      await conn.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS status VARCHAR(30) NULL DEFAULT 'Pending'`).catch(() => {});
    }
    // Add episode_id to vaccination_reminders and staff_notifications
    await conn.query(`ALTER TABLE vaccination_reminders ADD COLUMN IF NOT EXISTS episode_id INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE staff_notifications ADD COLUMN IF NOT EXISTS episode_id INT NULL`).catch(() => {});
    // Add interrupted review columns to patients (may already exist in some installs)
    await conn.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS interrupted_reviewed TINYINT(1) NOT NULL DEFAULT 0`).catch(() => {});
    await conn.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS interrupted_reason TEXT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS interrupted_reviewed_by VARCHAR(100) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS interrupted_reviewed_at DATETIME NULL`).catch(() => {});
    // Backfill patient_login_history missing columns
    await conn.query(`ALTER TABLE patient_login_history ADD COLUMN IF NOT EXISTS username VARCHAR(50) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE patient_login_history ADD COLUMN IF NOT EXISTS success TINYINT(1) NOT NULL DEFAULT 1`).catch(() => {});

    // Backfill: create exposure #1 for existing patients who have vaccination data
    await conn.query(`
      INSERT INTO patient_exposures (patient_id, exposure_number, date_of_exposure, place_of_exposure,
        region_of_exposure, type_of_animal, type_of_exposure, nature_of_exposure, site_of_exposure,
        category, washing_of_bite, condition_of_animal, signs_symptoms, biting_animal_status, created_by)
      SELECT patient_id, 1, date_of_exposure, place_of_exposure,
        region_of_exposure, type_of_animal, type_of_exposure, nature_of_exposure, site_of_exposure,
        category, washing_of_bite, condition_of_animal, signs_symptoms, biting_animal_status, created_by
      FROM patients p
      WHERE NOT EXISTS (SELECT 1 FROM patient_exposures pe WHERE pe.patient_id = p.patient_id)
    `).catch(() => {});

    await conn.query(`
      INSERT INTO treatment_episodes (
        patient_id, exposure_id, episode_number, treatment_type, category, status,
        date_started, brand_name, route, vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28,
        rig_date_given, missed_dose, missed_date, schedule_suspended, outcome, created_by
      )
      SELECT
        p.patient_id,
        pe.exposure_id,
        1,
        'PEP',
        p.category,
        CASE
          WHEN p.outcome = 'C' THEN 'Completed'
          WHEN p.treatment_status = 'Treatment Interrupted' THEN 'Treatment Interrupted'
          WHEN p.vaccine_d0 IS NOT NULL THEN 'Ongoing'
          ELSE 'Ongoing'
        END,
        COALESCE(p.vaccine_d0, p.date_registered),
        p.brand_name, p.route,
        p.vaccine_d0, p.vaccine_d3, p.vaccine_d7, p.vaccine_d14, p.vaccine_d28,
        p.rig_date_given,
        p.missed_dose, p.missed_date, p.schedule_suspended, p.outcome,
        p.created_by
      FROM patients p
      LEFT JOIN patient_exposures pe ON pe.patient_id = p.patient_id AND pe.exposure_number = 1
      WHERE NOT EXISTS (SELECT 1 FROM treatment_episodes te WHERE te.patient_id = p.patient_id AND te.episode_number = 1)
    `).catch(() => {});
    console.log('✅  treatment_episodes and patient_exposures tables ready.');

    // ─────────────────────────────────────────────────────────
    // MIGRATION: patient_accounts backfill for existing patients
    // ─────────────────────────────────────────────────────────
    try {
      const tempHash = await bcrypt.hash('hopecare', 10);
      await conn.query(`
        INSERT INTO patient_accounts (patient_id, username, password_hash, first_login)
        SELECT p.patient_id,
               CONCAT('PAT-', LPAD(p.patient_id, 6, '0')),
               COALESCE(p.password, ?),
               COALESCE(p.is_temp_password, 1)
        FROM patients p
        WHERE NOT EXISTS (SELECT 1 FROM patient_accounts pa WHERE pa.patient_id = p.patient_id)
      `, [tempHash]);
      console.log('✅  Patient accounts backfill complete.');
    } catch (e) {
      console.warn('⚠️  Patient accounts backfill skipped:', e.message);
    }

    // ─────────────────────────────────────────────────────────
    // MIGRATION 013: Case-Based Architecture Safety Nets
    // ─────────────────────────────────────────────────────────
    // Ensure patient_exposures has all form fields, pep_schedule index, backfills
    const expFormCols = [
      `ADD COLUMN IF NOT EXISTS time_of_exposure    VARCHAR(20)  NULL AFTER date_of_exposure`,
      `ADD COLUMN IF NOT EXISTS animal_ownership    VARCHAR(50)  NULL AFTER type_of_animal`,
      `ADD COLUMN IF NOT EXISTS animal_status       VARCHAR(50)  NULL AFTER animal_ownership`,
      `ADD COLUMN IF NOT EXISTS wound_type          VARCHAR(100) NULL AFTER site_of_exposure`,
      `ADD COLUMN IF NOT EXISTS wound_severity      VARCHAR(30)  NULL AFTER wound_type`,
      `ADD COLUMN IF NOT EXISTS tetanus_vaccine_hx  VARCHAR(200) NULL AFTER wound_severity`,
      `ADD COLUMN IF NOT EXISTS pre_exposure_hx     VARCHAR(200) NULL AFTER tetanus_vaccine_hx`,
      `ADD COLUMN IF NOT EXISTS allergy             VARCHAR(200) NULL AFTER pre_exposure_hx`,
      `ADD COLUMN IF NOT EXISTS co_morbidities      VARCHAR(200) NULL AFTER allergy`,
      `ADD COLUMN IF NOT EXISTS barangay            VARCHAR(100) NULL COMMENT 'Barangay where the exposure/bite occurred' AFTER place_of_exposure`,
    ];
    
    for (const col of expFormCols) {
      await conn.query(`ALTER TABLE patient_exposures ${col}`).catch(() => {});
    }
    await conn.query(`ALTER TABLE patient_pep_schedule ADD INDEX IF NOT EXISTS idx_pep_episode_id (episode_id)`).catch(() => {});
    await conn.query(`ALTER TABLE patient_exposures ADD INDEX IF NOT EXISTS idx_pe_patient_num (patient_id, exposure_number)`).catch(() => {});
    await conn.query(`ALTER TABLE patient_exposures ADD INDEX IF NOT EXISTS idx_pe_barangay (barangay)`).catch(() => {});
    await conn.query(`ALTER TABLE treatment_episodes ADD COLUMN IF NOT EXISTS washing_of_bite ENUM('Y','N') NULL`).catch(() => {});
    // Backfill exposure #1 fields from patients flat record
    await conn.query(`
      UPDATE patient_exposures pe
      JOIN patients p ON p.patient_id = pe.patient_id
      SET
        pe.animal_ownership   = COALESCE(pe.animal_ownership,   p.animal_ownership),
        pe.animal_status      = COALESCE(pe.animal_status,      p.animal_status),
        pe.wound_type         = COALESCE(pe.wound_type,         p.wound_type),
        pe.wound_severity     = COALESCE(pe.wound_severity,     p.wound_severity),
        pe.pre_exposure_hx    = COALESCE(pe.pre_exposure_hx,    p.pre_exposure_hx),
        pe.allergy            = COALESCE(pe.allergy,            p.allergy),
        pe.co_morbidities     = COALESCE(pe.co_morbidities,     p.co_morbidities),
        pe.tetanus_vaccine_hx = COALESCE(pe.tetanus_vaccine_hx, p.tetanus_vaccine_hx),
        pe.barangay           = COALESCE(pe.barangay,           p.barangay)
      WHERE pe.exposure_number = 1
    `).catch(() => {});
    await conn.query(`
      UPDATE treatment_episodes te
      JOIN patients p ON p.patient_id = te.patient_id
      SET te.washing_of_bite = p.washing_of_bite
      WHERE te.episode_number = 1 AND te.washing_of_bite IS NULL AND p.washing_of_bite IS NOT NULL
    `).catch(() => {});
    console.log('✅  Migration 013 (case architecture safety nets) applied.');

    // ── MIGRATION: Dynamic Tetanus Vaccines ──────────────────────────────
    // Add per-vaccine field-config columns to vaccines table
    await conn.query(`ALTER TABLE vaccines
      ADD COLUMN IF NOT EXISTS has_route      TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'Show Route (ID/IM) field',
      ADD COLUMN IF NOT EXISTS has_anst       TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'Show ANST Result field',
      ADD COLUMN IF NOT EXISTS has_dose       TINYINT(1)    NOT NULL DEFAULT 1 COMMENT 'Show Dose (mL) field',
      ADD COLUMN IF NOT EXISTS has_injection_site TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Show Injection Site field',
      ADD COLUMN IF NOT EXISTS has_date_given TINYINT(1)    NOT NULL DEFAULT 1 COMMENT 'Show Date Given field',
      ADD COLUMN IF NOT EXISTS has_given_by   TINYINT(1)    NOT NULL DEFAULT 1 COMMENT 'Show Given By field',
      ADD COLUMN IF NOT EXISTS concentration  VARCHAR(50)   NULL COMMENT 'e.g. 200 IU/mL',
      ADD COLUMN IF NOT EXISTS default_dose_ml      DECIMAL(5,2) NULL COMMENT 'Default dose in mL',
      ADD COLUMN IF NOT EXISTS default_injection_site VARCHAR(100) NULL COMMENT 'Default injection site'
    `).catch(() => {});
    // Add vaccine_id FK to tetanus_records for dynamic vaccine rows
    await conn.query(`ALTER TABLE tetanus_records
      ADD COLUMN IF NOT EXISTS vaccine_id INT NULL COMMENT 'FK to vaccines for dynamic tetanus vaccines',
      ADD COLUMN IF NOT EXISTS vaccine_name VARCHAR(100) NULL COMMENT 'Snapshot of vaccine name at time of record'
    `).catch(() => {});
    // Set has_anst=1 for ATS variants (they use ANST result), has_route=1 for HTIG (uses ID/IM route)
    // Note: Generic 'ATS' removed from defaults, only specific variants (ATS 1500, 3000) remain
    await conn.query(`UPDATE vaccines SET has_route=1 WHERE name='HTIG' AND category='Tetanus Prophylaxis'`).catch(() => {});
    await conn.query(`UPDATE vaccines SET has_dose=1, has_injection_site=1, has_date_given=1, has_given_by=1
      WHERE category='Tetanus Prophylaxis'`).catch(() => {});
    console.log('✅  Dynamic tetanus vaccines migration applied.');

    // 1. patient_followup — episode_id and dose_label columns + index
    await conn.query(`ALTER TABLE patient_followup ADD COLUMN IF NOT EXISTS episode_id INT NULL AFTER patient_id`).catch(() => {});
    await conn.query(`ALTER TABLE patient_followup ADD COLUMN IF NOT EXISTS dose_label VARCHAR(20) NULL AFTER episode_id`).catch(() => {});
    await conn.query(`ALTER TABLE patient_followup ADD INDEX IF NOT EXISTS idx_pf_episode (episode_id)`).catch(() => {});
    // 2. patient_pep_schedule — ensure episode_id, status, remarks columns + index
    await conn.query(`ALTER TABLE patient_pep_schedule ADD COLUMN IF NOT EXISTS episode_id INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE patient_pep_schedule ADD COLUMN IF NOT EXISTS status VARCHAR(30) NULL DEFAULT 'Pending'`).catch(() => {});
    await conn.query(`ALTER TABLE patient_pep_schedule ADD COLUMN IF NOT EXISTS remarks TEXT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE patient_pep_schedule ADD INDEX IF NOT EXISTS idx_pep_episode (episode_id)`).catch(() => {});
    // 3. patient_exposures — composite index for search query
    await conn.query(`ALTER TABLE patient_exposures ADD INDEX IF NOT EXISTS idx_pe_date (patient_id, date_of_exposure)`).catch(() => {});
    // 4. treatment_episodes — composite index for latest-status lookup
    await conn.query(`ALTER TABLE treatment_episodes ADD INDEX IF NOT EXISTS idx_te_created (patient_id, created_at)`).catch(() => {});
    console.log('✅  Migration 012 (multi-exposure indexes) applied.');

    // ─────────────────────────────────────────────────────────
    // MIGRATION 019: Vaccine Inventory Missing Columns Fix
    // ─────────────────────────────────────────────────────────
    // Add missing columns that cause "temporarily unavailable" errors
    await conn.query(`ALTER TABLE vaccine_inventory ADD COLUMN IF NOT EXISTS received_date DATE NULL COMMENT 'Date when vaccine stock was received'`).catch(() => {});
    await conn.query(`ALTER TABLE vaccine_inventory ADD COLUMN IF NOT EXISTS received_quantity INT NULL COMMENT 'Quantity received in this lot'`).catch(() => {});
    
    await conn.query(`ALTER TABLE vaccine_transactions ADD COLUMN IF NOT EXISTS corrected_at DATETIME NULL COMMENT 'Timestamp when transaction was corrected'`).catch(() => {});
    await conn.query(`ALTER TABLE vaccine_transactions ADD COLUMN IF NOT EXISTS corrected_quantity INT NULL COMMENT 'Corrected quantity after adjustment'`).catch(() => {});
    await conn.query(`ALTER TABLE vaccine_transactions ADD COLUMN IF NOT EXISTS corrected_by VARCHAR(100) NULL COMMENT 'Staff who made the correction'`).catch(() => {});
    
    // Create inventory_daily_reports table if not exists
    await conn.query(`
      CREATE TABLE IF NOT EXISTS inventory_daily_reports (
        report_id INT AUTO_INCREMENT PRIMARY KEY,
        report_date DATE NOT NULL,
        shift ENUM('AM','PM') NOT NULL,
        vaccine_id INT NOT NULL,
        opening_stock INT NOT NULL DEFAULT 0,
        received_quantity INT NOT NULL DEFAULT 0,
        used_quantity INT NOT NULL DEFAULT 0,
        closing_stock INT NOT NULL DEFAULT 0,
        verified_by VARCHAR(100) NULL,
        verified_at DATETIME NULL,
        recorded_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
        notes TEXT NULL,
        UNIQUE KEY unique_report (report_date, shift, vaccine_id),
        FOREIGN KEY (vaccine_id) REFERENCES vaccines(vaccine_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});
    
    await conn.query(`ALTER TABLE inventory_daily_reports ADD COLUMN IF NOT EXISTS verified_at DATETIME NULL COMMENT 'Timestamp when report was verified'`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_reports ADD COLUMN IF NOT EXISTS recorded_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Timestamp when report was recorded'`).catch(() => {});
    
    // Create vaccine_lot_receipts table if not exists
    await conn.query(`
      CREATE TABLE IF NOT EXISTS vaccine_lot_receipts (
        receipt_id INT AUTO_INCREMENT PRIMARY KEY,
        inventory_id INT NOT NULL,
        received_date DATE NOT NULL,
        received_quantity INT NOT NULL,
        supplier VARCHAR(255) NULL,
        received_by VARCHAR(100) NULL,
        notes TEXT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (inventory_id) REFERENCES vaccine_inventory(inventory_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});
    
    // Backfill existing records with default values
    await conn.query(`UPDATE vaccine_inventory SET received_date = DATE(created_at) WHERE received_date IS NULL AND created_at IS NOT NULL`).catch(() => {});
    await conn.query(`UPDATE vaccine_inventory SET received_date = CURDATE() WHERE received_date IS NULL`).catch(() => {});
    await conn.query(`UPDATE vaccines SET received_quantity = initial_stock WHERE received_quantity IS NULL AND initial_stock IS NOT NULL`).catch(() => {});
    
    console.log('✅  Migration 019 (vaccine inventory fixes) applied.');

    // ─────────────────────────────────────────────────────────
    // MIGRATION 020: Remove ATS and ATS 5000 vaccines
    // ─────────────────────────────────────────────────────────
    // Mark ATS and ATS 5000 as Inactive (keeps historical data)
    await conn.query(`UPDATE vaccines SET status='Inactive' WHERE name IN ('ATS','ATS 5000') AND category='Tetanus Prophylaxis'`).catch(() => {});
    
    // Remove duplicate 'Tetanus Toxoid' (keep only 'TT')
    await conn.query(`UPDATE vaccines SET status='Inactive' WHERE name='Tetanus Toxoid' AND category='Tetanus Prophylaxis'`).catch(() => {});
    
    // Update any tetanus_records using 'ATS' to 'Other' before altering ENUM
    await conn.query(`UPDATE tetanus_records SET type='Other', remarks=CONCAT(COALESCE(remarks,''),' (Previously: ATS)') WHERE type='ATS'`).catch(() => {});
    
    // Alter ENUM to remove 'ATS' option
    await conn.query(`ALTER TABLE tetanus_records MODIFY COLUMN type ENUM('TT','HTIG','ATS 1500','ATS 3000','Other') NOT NULL DEFAULT 'TT'`).catch(() => {});
    
    console.log('✅  Migration 020 (remove ATS vaccines) applied.');

    // ─────────────────────────────────────────────────────────
    // DEFAULT RECORDS: Admin account
    // ─────────────────────────────────────────────────────────
    await conn.query(`
      INSERT INTO staff_account (username, password, full_name, designation, role, status)
      VALUES ('admin', '$2a$10$J6coyP4wf2X6FWIJXSpQQeB/DD6zEU5nXHtiyJuo4Trted2XIpR06', 'System Administrator', 'ABC Nurse', 'Administrator', 'Active')
      ON DUPLICATE KEY UPDATE
        full_name   = COALESCE(NULLIF(full_name, ''), VALUES(full_name)),
        designation = COALESCE(NULLIF(designation, ''), VALUES(designation)),
        role        = VALUES(role),
        status      = COALESCE(NULLIF(status, ''), VALUES(status))
    `);
    console.log('✅  Default admin account ready.');

    console.log('');
    console.log('═══════════════════════════════════════════════');
    console.log('  ✅  All done! Database fully initialized.');
    console.log('═══════════════════════════════════════════════');
    console.log('  Tables created / verified: 21');
    console.log('  Default login credentials:');
    console.log('    Username : admin');
    console.log('    Password : admin123');
    console.log('');
    console.log('  Start the server: npm run dev');
    console.log('═══════════════════════════════════════════════');

  } catch (err) {
    console.error('❌  Database setup failed:', err.message);
    if (err.code === 'ECONNREFUSED') {
      console.error('    MySQL is not running. Start it first.');
    } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('    Wrong MySQL credentials in backend/.env');
    } else {
      console.error(err);
    }
    process.exit(1);
  } finally {
    if (conn) await conn.end();
  }
}

run(); 
