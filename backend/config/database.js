/**
 * database.js — MySQL connection pool with auto-create database
 *
 * On startup:
 *  1. Connects to MySQL WITHOUT specifying a database
 *  2. Creates the database if it doesn't exist
 *  3. Returns a pool that always connects to that database
 */
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { retireGenericDefaultVaccines } = require('../utils/retireGenericVaccines');

const DB_NAME = process.env.DB_NAME || 'animal_bite_system';

// Pool used by all routes
let pool;

async function initPool() {
  // Step 1 — ensure the database exists
  try {
    const bootstrap = await mysql.createConnection({
      host:     process.env.DB_HOST     || 'localhost',
      user:     process.env.DB_USER     || 'root',
      password: process.env.DB_PASSWORD || '',
      multipleStatements: true,
    });
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await bootstrap.end();
    console.log(`✅  Database "${DB_NAME}" is ready.`);
  } catch (err) {
    console.error('❌  Could not create/verify database:', err.message);
    if (err.code === 'ECONNREFUSED') {
      console.error('    Make sure MySQL is running on', process.env.DB_HOST || 'localhost');
    }
    if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('    Check DB_USER and DB_PASSWORD in backend/.env');
    }
    process.exit(1);
  }

  // Step 2 — create the pool that targets the (now-guaranteed) database
  pool = mysql.createPool({
    host:             process.env.DB_HOST     || 'localhost',
    user:             process.env.DB_USER     || 'root',
    password:         process.env.DB_PASSWORD || '',
    database:         DB_NAME,
    waitForConnections: true,
    connectionLimit:  10,
    queueLimit:       0,
    // Return MySQL DATE as 'YYYY-MM-DD' so JSON never serializes them as UTC datetimes
    // (which shifts the calendar day in UTC+ timezones such as Asia/Manila).
    typeCast(field, next) {
      if (field.type === 'DATE' || field.type === 'NEWDATE') {
        const s = field.string();
        return s || null;
      }
      return next();
    },
  });

  // Step 3 — run idempotent migrations (ALTERs for existing installations)
  try {
    await runMigrations(pool);
    console.log('✅  Migrations applied.');
  } catch (err) {
    console.warn('⚠️  Migration step had non-fatal issue:', err.message);
  }

  return pool;
}

async function runMigrations(p) {
  const conn = await p.getConnection();
  try {
    // staff_account: status, designation
    await conn.query(`
      ALTER TABLE staff_account
        ADD COLUMN IF NOT EXISTS status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active' AFTER email,
        ADD COLUMN IF NOT EXISTS designation VARCHAR(100) NULL DEFAULT 'ABC Nurse' AFTER status
    `).catch(() => {});

    // activity_logs table
    await conn.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // patients audit columns
    await conn.query(`
      ALTER TABLE patients
        ADD COLUMN IF NOT EXISTS created_by VARCHAR(100) NULL AFTER updated_at,
        ADD COLUMN IF NOT EXISTS updated_by VARCHAR(100) NULL AFTER created_by
    `).catch(() => {});

    // patient_followup audit columns
    await conn.query(`
      ALTER TABLE patient_followup
        ADD COLUMN IF NOT EXISTS created_by VARCHAR(100) NULL AFTER updated_at,
        ADD COLUMN IF NOT EXISTS updated_by VARCHAR(100) NULL AFTER created_by
    `).catch(() => {});

    // vaccines audit columns
    await conn.query(`
      ALTER TABLE vaccines
        ADD COLUMN IF NOT EXISTS created_by VARCHAR(100) NULL AFTER updated_at,
        ADD COLUMN IF NOT EXISTS updated_by VARCHAR(100) NULL AFTER created_by
    `).catch(() => {});

    // Anti-Rabies brands come from Vaccine Management (not a fixed ENUM)
    await conn.query(`ALTER TABLE patients MODIFY COLUMN brand_name VARCHAR(100) NULL DEFAULT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE treatment_episodes MODIFY COLUMN brand_name VARCHAR(100) NULL`).catch(() => {});
    await conn.query(`UPDATE vaccines SET concentration='200 IU/mL' WHERE name IN ('Equirab','Vinrab') AND (concentration IS NULL OR concentration='')`).catch(() => {});
    await conn.query(`UPDATE vaccines SET concentration='300 IU/mL' WHERE name='Berirab' AND (concentration IS NULL OR concentration='')`).catch(() => {});

    // report_settings audit columns
    await conn.query(`
      ALTER TABLE report_settings
        ADD COLUMN IF NOT EXISTS updated_by VARCHAR(100) NULL AFTER noted_by_designation,
        ADD COLUMN IF NOT EXISTS generated_by VARCHAR(100) NULL AFTER updated_by
    `).catch(() => {});

    // Ensure admin account defaults
    await conn.query(`
      UPDATE staff_account
      SET
        full_name   = COALESCE(NULLIF(full_name,''), 'System Administrator'),
        designation = COALESCE(NULLIF(designation,''), 'ABC Nurse'),
        status      = COALESCE(NULLIF(status,''), 'Active')
      WHERE username = 'admin'
    `).catch(() => {});

    // ========== PATIENT PORTAL MIGRATIONS ==========

    // Patient password and account fields on patients table
    await conn.query(`
      ALTER TABLE patients
        ADD COLUMN IF NOT EXISTS password VARCHAR(255) NULL AFTER remarks,
        ADD COLUMN IF NOT EXISTS is_temp_password TINYINT(1) NOT NULL DEFAULT 1 AFTER password,
        ADD COLUMN IF NOT EXISTS municipality VARCHAR(100) NULL DEFAULT 'Gingoog City' AFTER barangay,
        ADD COLUMN IF NOT EXISTS region_of_exposure VARCHAR(100) NULL AFTER place_of_exposure,
        ADD COLUMN IF NOT EXISTS condition_of_animal ENUM('Well/Alive','Sick/Ill','Stray','Dead') NULL AFTER biting_animal_status,
        ADD COLUMN IF NOT EXISTS signs_symptoms ENUM('None','Yes') NULL DEFAULT 'None' AFTER condition_of_animal,
        ADD COLUMN IF NOT EXISTS nature_of_exposure ENUM('Lacerated','Punctured','Abrasion') NULL AFTER type_of_exposure
    `).catch(() => {});

    // Pre-Exposure Prophylaxis (PrEP) detailed doses
    await conn.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

    // Post-Exposure Prophylaxis (PEP) detailed doses
    await conn.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

    // Booster schedule
    await conn.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

    // Tetanus Toxoid detailed schedule
    await conn.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

    // Patient Notifications
    await conn.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

    // Assign default temp password "hopecare" to existing patients
    try {
      const tempPasswordHash = await bcrypt.hash('hopecare', 10);
      await conn.query(
        `UPDATE patients SET password = COALESCE(password, ?), is_temp_password = COALESCE(is_temp_password, 1) WHERE password IS NULL`,
        [tempPasswordHash]
      );
    } catch (e) {
      console.warn('⚠️  Could not seed temp passwords:', e.message);
    }

    // patient_accounts table for portal login (username = PAT-NNNNNN)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS patient_accounts (
        account_id    INT AUTO_INCREMENT PRIMARY KEY,
        patient_id    INT NOT NULL UNIQUE,
        username      VARCHAR(50) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        first_login   TINYINT(1) NOT NULL DEFAULT 1,
        last_login    DATETIME NULL,
        created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_pa_username (username),
        INDEX idx_pa_patient (patient_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

    // Backfill patient_accounts from existing patients
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
    } catch (e) {
      console.warn('⚠️  Could not backfill patient_accounts:', e.message);
    }

    // Backfill registration numbers to ABC-YYYY-NNNNNN format
    try {
      const [backfillResult] = await conn.query(`
        UPDATE patients
        SET registration_number = CONCAT(
          'ABC-',
          YEAR(COALESCE(date_registered, created_at)),
          '-',
          LPAD(CAST(registration_number AS UNSIGNED), 6, '0')
        )
        WHERE registration_number NOT LIKE 'ABC-%'
          AND registration_number REGEXP '^[0-9]+$'
      `);
      if (backfillResult.affectedRows > 0) {
        console.log(`✅  Registration number format backfill: ${backfillResult.affectedRows} record(s) updated.`);
      }
    } catch (e) {
      console.warn('⚠️  Registration number backfill skipped:', e.message);
    }

    // Seed PEP schedule rows (Day 0, 3, 7, 14, 28) for patients that have PEP dates
    const pepDays = [
      { label: 'Day 0',  field: 'vaccine_d0'  },
      { label: 'Day 3',  field: 'vaccine_d3'  },
      { label: 'Day 7',  field: 'vaccine_d7'  },
      { label: 'Day 14', field: 'vaccine_d14' },
      { label: 'Day 28', field: 'vaccine_d28' },
    ];
    for (const day of pepDays) {
      await conn.query(`
        INSERT IGNORE INTO patient_pep_schedule (patient_id, day_label, date_due, date_given, vaccine_brand, route, vaccinated_by)
        SELECT p.patient_id, ?, p.${day.field}, p.${day.field}, p.brand_name, p.route, p.tt_given_by
        FROM patients p WHERE p.${day.field} IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM patient_pep_schedule ps WHERE ps.patient_id = p.patient_id AND ps.day_label = ?)
      `, [day.label, day.label]).catch(() => {});
    }

    // ========== RBAC & REMINDER SYSTEM MIGRATIONS ==========

    await conn.query(`
      ALTER TABLE staff_account
        ADD COLUMN IF NOT EXISTS role ENUM('Administrator','Nurse') NOT NULL DEFAULT 'Nurse' AFTER designation
    `).catch(() => {});

    await conn.query(`
      UPDATE staff_account SET role = 'Administrator' WHERE username = 'admin'
    `).catch(() => {});

    await conn.query(`
      ALTER TABLE patients
        ADD COLUMN IF NOT EXISTS treatment_status VARCHAR(50) NULL AFTER outcome,
        ADD COLUMN IF NOT EXISTS missed_dose VARCHAR(20) NULL AFTER treatment_status,
        ADD COLUMN IF NOT EXISTS missed_date DATE NULL AFTER missed_dose,
        ADD COLUMN IF NOT EXISTS schedule_suspended TINYINT(1) NOT NULL DEFAULT 0 AFTER missed_date,
        ADD COLUMN IF NOT EXISTS interrupted_status TINYINT(1) NOT NULL DEFAULT 0 AFTER schedule_suspended,
        ADD COLUMN IF NOT EXISTS next_schedule DATE NULL AFTER interrupted_status,
        ADD COLUMN IF NOT EXISTS reminder_status VARCHAR(30) NULL AFTER next_schedule,
        ADD COLUMN IF NOT EXISTS reminder_sent_date DATE NULL AFTER reminder_status,
        ADD COLUMN IF NOT EXISTS reminder_type VARCHAR(30) NULL AFTER reminder_sent_date,
        ADD COLUMN IF NOT EXISTS interrupted_reviewed TINYINT(1) NOT NULL DEFAULT 0 AFTER reminder_type,
        ADD COLUMN IF NOT EXISTS interrupted_reason TEXT NULL AFTER interrupted_reviewed,
        ADD COLUMN IF NOT EXISTS interrupted_reviewed_by VARCHAR(100) NULL AFTER interrupted_reason,
        ADD COLUMN IF NOT EXISTS interrupted_reviewed_at DATETIME NULL AFTER interrupted_reviewed_by
    `).catch(() => {});

    await conn.query(`
      ALTER TABLE activity_logs
        ADD COLUMN IF NOT EXISTS role VARCHAR(50) NULL AFTER full_name,
        ADD COLUMN IF NOT EXISTS shift VARCHAR(20) NULL AFTER ip_address
    `).catch(() => {});

    await conn.query(`
      ALTER TABLE patient_pep_schedule
        ADD COLUMN IF NOT EXISTS status ENUM('Pending','Given','Missed','Suspended') NOT NULL DEFAULT 'Pending' AFTER vaccinated_by
    `).catch(() => {});

    await conn.query(`
      ALTER TABLE patient_accounts
        ADD COLUMN IF NOT EXISTS account_status ENUM('Active','Inactive') NOT NULL DEFAULT 'Active' AFTER first_login,
        ADD COLUMN IF NOT EXISTS is_locked TINYINT(1) NOT NULL DEFAULT 0 AFTER account_status,
        ADD COLUMN IF NOT EXISTS failed_attempts INT NOT NULL DEFAULT 0 AFTER is_locked
    `).catch(() => {});

    await conn.query(`
      CREATE TABLE IF NOT EXISTS vaccination_reminders (
        reminder_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        patient_id INT NOT NULL,
        dose_label VARCHAR(20) NOT NULL,
        scheduled_date DATE NOT NULL,
        reminder_type ENUM('3_DAYS_BEFORE','1_DAY_BEFORE','SAME_DAY') NOT NULL,
        reminder_status ENUM('Pending','Sent','Stopped') NOT NULL DEFAULT 'Pending',
        message TEXT NULL,
        sent_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_vr_patient (patient_id),
        INDEX idx_vr_scheduled (scheduled_date),
        UNIQUE KEY uk_patient_dose_reminder (patient_id, dose_label, reminder_type, scheduled_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

    await conn.query(`
      CREATE TABLE IF NOT EXISTS staff_notifications (
        notif_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        patient_id INT NOT NULL,
        type ENUM('MISSED_DOSE','INTERRUPTED','DUE_TODAY','OVERDUE') NOT NULL,
        title VARCHAR(200) NOT NULL,
        message TEXT NOT NULL,
        missed_dose VARCHAR(20) NULL,
        missed_date DATE NULL,
        days_overdue INT NULL DEFAULT 0,
        is_read TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_sn_read (is_read, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

    await conn.query(`
      CREATE TABLE IF NOT EXISTS patient_login_history (
        history_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        patient_id INT NOT NULL,
        username VARCHAR(50) NOT NULL,
        login_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ip_address VARCHAR(50) NULL,
        user_agent VARCHAR(255) NULL,
        success TINYINT(1) NOT NULL DEFAULT 1,
        FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
        INDEX idx_plh_patient (patient_id, login_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

    await conn.query(`
      CREATE TABLE IF NOT EXISTS vaccine_inventory (
        inventory_id INT AUTO_INCREMENT PRIMARY KEY,
        vaccine_id INT NOT NULL,
        batch_number VARCHAR(100) NULL,
        quantity INT NOT NULL DEFAULT 0,
        expiry_date DATE NULL,
        low_stock_threshold INT NOT NULL DEFAULT 10,
        notes TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (vaccine_id) REFERENCES vaccines(vaccine_id) ON DELETE CASCADE,
        INDEX idx_vi_vaccine (vaccine_id),
        INDEX idx_vi_expiry (expiry_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

    await conn.query(`
      CREATE TABLE IF NOT EXISTS vaccine_transactions (
        transaction_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        inventory_id INT NULL,
        vaccine_id INT NOT NULL,
        transaction_type ENUM('Stock In','Stock Out','Usage') NOT NULL,
        quantity INT NOT NULL,
        staff_id INT NOT NULL,
        staff_name VARCHAR(100) NOT NULL,
        shift ENUM('Morning','Afternoon','Evening') NOT NULL,
        patient_id INT NULL,
        notes TEXT NULL,
        transaction_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (inventory_id) REFERENCES vaccine_inventory(inventory_id) ON DELETE SET NULL,
        FOREIGN KEY (vaccine_id) REFERENCES vaccines(vaccine_id) ON DELETE CASCADE,
        FOREIGN KEY (staff_id) REFERENCES staff_account(id) ON DELETE CASCADE,
        INDEX idx_vt_date (transaction_date),
        INDEX idx_vt_shift (shift)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

    await conn.query(`
      ALTER TABLE patient_notifications
        MODIFY COLUMN type ENUM('UPCOMING_VACCINE','MISSED_SCHEDULE','COMPLETED_DOSE','BOOSTER_REMINDER','SYSTEM','TREATMENT_INTERRUPTED') NOT NULL
    `).catch(() => {});

    await conn.query(`
      ALTER TABLE patient_notifications
        ADD COLUMN IF NOT EXISTS episode_id INT NULL AFTER patient_id,
        ADD COLUMN IF NOT EXISTS dose_label VARCHAR(20) NULL AFTER related_date,
        ADD COLUMN IF NOT EXISTS reminder_type VARCHAR(30) NULL AFTER dose_label
    `).catch(() => {});

    await conn.query(`
      ALTER TABLE patient_notifications
        ADD UNIQUE INDEX IF NOT EXISTS uk_patient_dose_notice
          (patient_id, episode_id, dose_label, related_date, reminder_type)
    `).catch(() => {});

    await conn.query(`
      ALTER TABLE patient_notifications
        ADD COLUMN IF NOT EXISTS event_key VARCHAR(191) NULL AFTER reminder_type
    `).catch(() => {});

    await conn.query(`
      UPDATE patient_notifications
         SET event_key = CONCAT(
           patient_id, '|',
           IFNULL(episode_id, 0), '|',
           dose_label, '|',
           DATE_FORMAT(related_date, '%Y-%m-%d'), '|',
           reminder_type
         )
       WHERE dose_label IS NOT NULL
         AND related_date IS NOT NULL
         AND reminder_type IS NOT NULL
         AND (event_key IS NULL OR event_key = '')
    `).catch((err) => {
      console.warn('⚠️  Notification event-key backfill:', err.message);
    });

    await conn.query(`
      DELETE n1 FROM patient_notifications n1
      INNER JOIN patient_notifications n2
        ON n1.event_key IS NOT NULL
       AND n1.event_key = n2.event_key
       AND n1.notif_id > n2.notif_id
    `).catch((err) => {
      console.warn('⚠️  Notification duplicate cleanup:', err.message);
    });

    await conn.query(`
      ALTER TABLE patient_notifications
        ADD UNIQUE INDEX IF NOT EXISTS uk_notification_event (event_key)
    `).catch(() => {});

    try {
      const { vaccinationReminderCopy } = require('../utils/patientNotifications');
      const [noticeRows] = await conn.query(
        `SELECT n.notif_id, n.dose_label, n.related_date, n.title, n.message, p.full_name
           FROM patient_notifications n
           JOIN patients p ON p.patient_id = n.patient_id
          WHERE n.type = 'UPCOMING_VACCINE'`
      );
      for (const row of noticeRows) {
        const copy = vaccinationReminderCopy({
          fullName: row.full_name,
          doseLabel: row.dose_label,
          scheduledDate: row.related_date,
        });
        if (row.title === copy.title && row.message === copy.message) continue;
        await conn.query(
          `UPDATE patient_notifications
              SET title = ?, message = ?
            WHERE notif_id = ? AND type = 'UPCOMING_VACCINE'`,
          [copy.title, copy.message, row.notif_id]
        );
      }
    } catch (err) {
      console.warn('⚠️  Vaccination notification text refresh:', err.message);
    }

    await conn.query(`
      ALTER TABLE vaccination_reminders
        ADD COLUMN IF NOT EXISTS episode_id INT NULL AFTER patient_id
    `).catch(() => {});

    await conn.query(`
      ALTER TABLE vaccination_reminders
        ADD UNIQUE INDEX IF NOT EXISTS uk_episode_dose_reminder
          (patient_id, episode_id, dose_label, reminder_type, scheduled_date)
    `).catch(() => {});

    // ========== ADMIN INVENTORY MODULE MIGRATIONS ==========

    await conn.query(`
      ALTER TABLE vaccine_inventory
        ADD COLUMN IF NOT EXISTS critical_stock_threshold INT NOT NULL DEFAULT 5 AFTER low_stock_threshold,
        ADD COLUMN IF NOT EXISTS category VARCHAR(100) NULL AFTER notes
    `).catch(() => {});

    await conn.query(`
      ALTER TABLE vaccines
        ADD COLUMN IF NOT EXISTS category VARCHAR(100) NULL AFTER type
    `).catch(() => {});

    await conn.query(`
      ALTER TABLE activity_logs
        ADD COLUMN IF NOT EXISTS old_value TEXT NULL AFTER description,
        ADD COLUMN IF NOT EXISTS new_value TEXT NULL AFTER old_value,
        ADD COLUMN IF NOT EXISTS status VARCHAR(30) NULL DEFAULT 'Success' AFTER new_value
    `).catch(() => {});

    await conn.query(`
      ALTER TABLE vaccine_transactions
        ADD COLUMN IF NOT EXISTS staff_id_display VARCHAR(20) NULL AFTER staff_name,
        ADD COLUMN IF NOT EXISTS remarks TEXT NULL AFTER notes
    `).catch(() => {});

    await conn.query(`
      CREATE TABLE IF NOT EXISTS inventory_daily_records (
        record_id INT AUTO_INCREMENT PRIMARY KEY,
        record_date DATE NOT NULL,
        vaccine_id INT NOT NULL,
        morning_shift_inventory INT NOT NULL DEFAULT 0,
        vaccine_used INT NOT NULL DEFAULT 0,
        remaining_pm_shift INT NOT NULL DEFAULT 0,
        additional_vaccine INT NOT NULL DEFAULT 0,
        expiration_date DATE NULL,
        remarks TEXT NULL,
        shift ENUM('Morning Shift','Afternoon Shift') NOT NULL DEFAULT 'Morning Shift',
        recorded_by INT NOT NULL,
        recorded_by_name VARCHAR(100) NOT NULL,
        recorded_by_id_display VARCHAR(20) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (vaccine_id) REFERENCES vaccines(vaccine_id) ON DELETE CASCADE,
        FOREIGN KEY (recorded_by) REFERENCES staff_account(id) ON DELETE CASCADE,
        INDEX idx_idr_date (record_date),
        INDEX idx_idr_vaccine (vaccine_id),
        UNIQUE KEY uk_daily_vaccine_shift (record_date, vaccine_id, shift)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

    await conn.query(`
      CREATE TABLE IF NOT EXISTS system_config (
        config_key VARCHAR(100) PRIMARY KEY,
        config_value TEXT NULL,
        updated_by VARCHAR(100) NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

    const hopeCareVaccines = [
      ['Abhayrab','Anti-Rabies Vaccine','Anti-Rabies Vaccine'],
      ['Vaxirab','Anti-Rabies Vaccine','Anti-Rabies Vaccine'],
      ['Berirab','Rabies Immunoglobulin','Rabies Immunoglobulin'],
      ['Vinrab','Rabies Immunoglobulin','Rabies Immunoglobulin'],
      ['Equirab','Rabies Immunoglobulin','Rabies Immunoglobulin'],
      ['Tetanus Toxoid','Tetanus','Tetanus'],
      ['ATS','Other Vaccines','Other Vaccines'],
      ['HTIG','Other Vaccines','Other Vaccines'],
    ];
    for (const [name, type, category] of hopeCareVaccines) {
      await conn.query(
        `INSERT INTO vaccines (name, type, category, status)
         SELECT ?, ?, ?, 'Available' FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM vaccines WHERE name = ?)`,
        [name, type, category, name]
      ).catch(() => {});
    }

    const clinicSheetVaccines = [
      ['ATS 1500', 'Anti-Tetanus Serum', 'Tetanus Prophylaxis'],
      ['ATS 3000', 'Anti-Tetanus Serum', 'Tetanus Prophylaxis'],
      ['ATS 5000', 'Anti-Tetanus Serum', 'Tetanus Prophylaxis'],
    ];
    for (const [name, type, category] of clinicSheetVaccines) {
      await conn.query(
        `INSERT INTO vaccines (name, type, category, status)
         SELECT ?, ?, ?, 'Available' FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM vaccines WHERE name = ?)`,
        [name, type, category, name]
      ).catch(() => {});
    }

    await retireGenericDefaultVaccines(conn).catch((e) => {
      console.warn('Generic default vaccine retire skipped:', e.message);
    });

    await conn.query(`
      INSERT IGNORE INTO system_config (config_key, config_value) VALUES
        ('default_low_stock_threshold', '10'),
        ('default_critical_stock_threshold', '5'),
        ('expiry_alert_30_days', '1'),
        ('expiry_alert_15_days', '1'),
        ('expiry_alert_7_days', '1'),
        ('inventory_alerts_enabled', '1')
    `).catch(() => {});

    await conn.query(`
      ALTER TABLE vaccine_transactions
        MODIFY COLUMN transaction_type ENUM('Stock In','Stock Out','Usage','Vaccine Usage','Adjustment','Transfer','Damaged Vaccine','Expired Vaccine','Returned Vaccine','Initial Opening Balance') NOT NULL,
        MODIFY COLUMN shift VARCHAR(30) NOT NULL DEFAULT 'Morning Shift'
    `).catch(() => {});

    await conn.query(`ALTER TABLE vaccine_transactions ADD COLUMN IF NOT EXISTS beginning_stock INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE vaccine_transactions ADD COLUMN IF NOT EXISTS remaining_stock INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE vaccine_transactions ADD COLUMN IF NOT EXISTS expiration_date DATE NULL`).catch(() => {});
    await conn.query(`ALTER TABLE vaccine_transactions ADD COLUMN IF NOT EXISTS original_quantity INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE vaccine_transactions ADD COLUMN IF NOT EXISTS corrected_quantity INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE vaccine_transactions ADD COLUMN IF NOT EXISTS correction_reason VARCHAR(150) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE vaccine_transactions ADD COLUMN IF NOT EXISTS corrected_at DATETIME NULL`).catch(() => {});
    await conn.query(`ALTER TABLE vaccine_transactions ADD COLUMN IF NOT EXISTS corrected_by INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE vaccine_transactions ADD COLUMN IF NOT EXISTS corrected_by_name VARCHAR(100) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE vaccine_transactions ADD COLUMN IF NOT EXISTS original_expiration_date DATE NULL`).catch(() => {});
    await conn.query(`ALTER TABLE vaccine_transactions ADD COLUMN IF NOT EXISTS corrected_expiration_date DATE NULL`).catch(() => {});
    await conn.query(`ALTER TABLE vaccine_inventory ADD COLUMN IF NOT EXISTS original_expiry_date DATE NULL`).catch(() => {});
    await conn.query(`
      UPDATE vaccine_inventory
      SET lot_status = 'Available'
      WHERE lot_status = 'Expired'
        AND quantity > 0
        AND expiry_date IS NOT NULL
        AND expiry_date >= CURDATE()
    `).catch(() => {});

    await conn.query(`ALTER TABLE inventory_daily_records MODIFY COLUMN morning_shift_inventory INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records MODIFY COLUMN remaining_pm_shift INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records MODIFY COLUMN vaccine_used INT NOT NULL DEFAULT 0`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records MODIFY COLUMN recorded_by INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records MODIFY COLUMN recorded_by_name VARCHAR(100) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS opening_recorded TINYINT(1) NOT NULL DEFAULT 0`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS inventory_status VARCHAR(30) NOT NULL DEFAULT 'Pending'`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS shift_status VARCHAR(20) NOT NULL DEFAULT 'Open'`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS late_entry TINYINT(1) NOT NULL DEFAULT 0`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS recorded_at DATETIME NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS physical_count INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS discrepancy INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS needs_reconciliation TINYINT(1) NOT NULL DEFAULT 0`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS reconciled TINYINT(1) NOT NULL DEFAULT 0`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS reconciled_at DATETIME NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS reconciled_by INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS reconciled_by_name VARCHAR(100) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS reconciliation_remarks TEXT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS expected_remaining INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS closed_at DATETIME NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS closed_by INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS closed_by_name VARCHAR(100) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS previous_verified_stock INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS stock_difference INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS difference_status VARCHAR(60) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS verification_reason VARCHAR(255) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records MODIFY COLUMN verification_reason VARCHAR(255) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS verified_at DATETIME NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS verified_by INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS verified_by_name VARCHAR(100) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS additional_receipt_qty INT NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS additional_receipt_date DATE NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS additional_receipt_source VARCHAR(150) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD COLUMN IF NOT EXISTS additional_receipt_expiry DATE NULL`).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records MODIFY COLUMN shift VARCHAR(30) NOT NULL DEFAULT 'Morning Shift'`).catch(() => {});
    await conn.query(`
      UPDATE inventory_daily_records
      SET shift = 'Morning Shift'
      WHERE LOWER(TRIM(shift)) IN ('morning', 'am', 'morning shift')
    `).catch(() => {});
    await conn.query(`
      UPDATE inventory_daily_records
      SET shift = 'Afternoon Shift'
      WHERE LOWER(TRIM(shift)) IN ('afternoon', 'pm', 'evening', 'afternoon shift')
    `).catch(() => {});
    await conn.query(`ALTER TABLE inventory_daily_records ADD UNIQUE KEY uk_daily_vaccine_shift (record_date, vaccine_id, shift)`).catch(() => {});
    await conn.query(`
      UPDATE inventory_daily_records
      SET opening_recorded = 1,
          inventory_status = IF(inventory_status IN ('Late Entry','Adjusted'), inventory_status, 'Recorded'),
          recorded_at = COALESCE(recorded_at, updated_at, created_at)
      WHERE opening_recorded = 0
        AND (recorded_by IS NOT NULL OR (recorded_by_name IS NOT NULL AND recorded_by_name <> ''))
        AND inventory_status IN ('Pending','Not Recorded','')
        AND (
          (shift = 'Morning Shift' AND morning_shift_inventory IS NOT NULL)
          OR (shift = 'Afternoon Shift' AND remaining_pm_shift IS NOT NULL)
          OR physical_count IS NOT NULL
        )
    `).catch(() => {});

    await conn.query(`
      CREATE TABLE IF NOT EXISTS inventory_shift_closures (
        closure_id INT AUTO_INCREMENT PRIMARY KEY,
        shift_date DATE NOT NULL,
        shift VARCHAR(30) NOT NULL,
        shift_status VARCHAR(20) NOT NULL DEFAULT 'Closed',
        closed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_by INT NULL,
        closed_by_name VARCHAR(100) NULL,
        notes TEXT NULL,
        UNIQUE KEY uk_shift_close (shift_date, shift)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

    // ========== MIGRATION 013: CASE-BASED ARCHITECTURE SAFETY NETS ==========

    // Ensure patient_exposures has all clinic form fields
    const _expFormCols013 = [
      `ADD COLUMN IF NOT EXISTS time_of_exposure    VARCHAR(20)  NULL`,
      `ADD COLUMN IF NOT EXISTS animal_ownership    VARCHAR(50)  NULL`,
      `ADD COLUMN IF NOT EXISTS animal_status       VARCHAR(50)  NULL`,
      `ADD COLUMN IF NOT EXISTS wound_type          VARCHAR(100) NULL`,
      `ADD COLUMN IF NOT EXISTS wound_severity      VARCHAR(30)  NULL`,
      `ADD COLUMN IF NOT EXISTS tetanus_vaccine_hx  VARCHAR(200) NULL`,
      `ADD COLUMN IF NOT EXISTS pre_exposure_hx     VARCHAR(200) NULL`,
      `ADD COLUMN IF NOT EXISTS allergy             VARCHAR(200) NULL`,
      `ADD COLUMN IF NOT EXISTS co_morbidities      VARCHAR(200) NULL`,
    ];
    for (const col of _expFormCols013) {
      await conn.query(`ALTER TABLE patient_exposures ${col}`).catch(() => {});
    }
    await conn.query(`ALTER TABLE patient_pep_schedule    ADD INDEX IF NOT EXISTS idx_pep_episode_id (episode_id)`).catch(() => {});
    await conn.query(`ALTER TABLE patient_exposures       ADD INDEX IF NOT EXISTS idx_pe_patient_num (patient_id, exposure_number)`).catch(() => {});
    await conn.query(`ALTER TABLE treatment_episodes      ADD COLUMN IF NOT EXISTS washing_of_bite ENUM('Y','N') NULL`).catch(() => {});
    // Backfill exposure #1 from patients flat record (non-fatal)
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
        pe.tetanus_vaccine_hx = COALESCE(pe.tetanus_vaccine_hx, p.tetanus_vaccine_hx)
      WHERE pe.exposure_number = 1
    `).catch(() => {});
    await conn.query(`
      UPDATE treatment_episodes te
      JOIN patients p ON p.patient_id = te.patient_id
      SET te.washing_of_bite = p.washing_of_bite
      WHERE te.episode_number = 1 AND te.washing_of_bite IS NULL AND p.washing_of_bite IS NOT NULL
    `).catch(() => {});

    // ========== MIGRATION 014: PATIENT RECORDS AS SOURCE OF TRUTH ==========
    await conn.query(`
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
        p.date_of_exposure IS NOT NULL OR p.category IS NOT NULL
        OR p.vaccine_d0 IS NOT NULL OR p.place_of_exposure IS NOT NULL
        OR p.type_of_animal IS NOT NULL
      )
    `).catch(() => {});
    await conn.query(`
      INSERT INTO treatment_episodes (
        patient_id, exposure_id, episode_number, treatment_type, category,
        status, date_started, brand_name, route, washing_of_bite,
        vaccine_d0, vaccine_d3, vaccine_d7, vaccine_d14, vaccine_d28,
        rig_date_given, outcome, notes
      )
      SELECT
        p.patient_id, pe.exposure_id, 1, 'PEP', p.category,
        CASE WHEN p.vaccine_d28 IS NOT NULL THEN 'Completed' ELSE 'Ongoing' END,
        COALESCE(p.vaccine_d0, p.date_registered, p.date_of_exposure),
        p.brand_name, p.route, p.washing_of_bite,
        p.vaccine_d0, p.vaccine_d3, p.vaccine_d7, p.vaccine_d14, p.vaccine_d28,
        p.rig_date_given, p.outcome, p.remarks
      FROM patients p
      JOIN patient_exposures pe ON pe.patient_id = p.patient_id AND pe.exposure_number = 1
      WHERE NOT EXISTS (
        SELECT 1 FROM treatment_episodes te
        WHERE te.patient_id = p.patient_id AND te.episode_number = 1
      )
    `).catch(() => {});
    await conn.query(`
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
      WHERE te.episode_number = 1
    `).catch(() => {});
    await conn.query(`
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
      WHERE pe.exposure_number = 1
    `).catch(() => {});

    await conn.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS ats_date_given DATE NULL`).catch(() => {});
    await conn.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS ats_given_by VARCHAR(100) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS htig_date_given DATE NULL`).catch(() => {});
    await conn.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS htig_given_by VARCHAR(100) NULL`).catch(() => {});
    await conn.query(`ALTER TABLE vaccines ADD COLUMN IF NOT EXISTS has_dose TINYINT(1) NOT NULL DEFAULT 1`).catch(() => {});
    await conn.query(`ALTER TABLE vaccines ADD COLUMN IF NOT EXISTS has_injection_site TINYINT(1) NOT NULL DEFAULT 1`).catch(() => {});
    await conn.query(`ALTER TABLE vaccines ADD COLUMN IF NOT EXISTS has_date_given TINYINT(1) NOT NULL DEFAULT 1`).catch(() => {});
    await conn.query(`ALTER TABLE vaccines ADD COLUMN IF NOT EXISTS has_given_by TINYINT(1) NOT NULL DEFAULT 1`).catch(() => {});
    await conn.query(`UPDATE vaccines SET has_dose=1, has_injection_site=1, has_date_given=1, has_given_by=1
      WHERE category='Tetanus Prophylaxis'`).catch(() => {});
    await conn.query(`UPDATE vaccines SET has_anst=1 WHERE name='ATS' AND category='Tetanus Prophylaxis'`).catch(() => {});
    await conn.query(`UPDATE vaccines SET has_route=1 WHERE name='HTIG' AND category='Tetanus Prophylaxis'`).catch(() => {});

    await conn.query(`
      CREATE TABLE IF NOT EXISTS ai_analysis_cache (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        context       VARCHAR(32)  NOT NULL,
        period_start  VARCHAR(32)  NULL,
        period_end    VARCHAR(32)  NULL,
        data_hash     CHAR(64)     NOT NULL,
        ai_response   JSON         NOT NULL,
        generated_at  DATETIME     NOT NULL,
        expires_at    DATETIME     NOT NULL,
        model         VARCHAR(80)  NULL,
        status        VARCHAR(32)  NOT NULL DEFAULT 'ok',
        INDEX idx_ai_hash_exp (data_hash, expires_at),
        INDEX idx_ai_ctx_exp (context, expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      ALTER TABLE vaccine_inventory
        ADD COLUMN IF NOT EXISTS received_quantity INT NULL AFTER quantity,
        ADD COLUMN IF NOT EXISTS used_quantity INT NOT NULL DEFAULT 0 AFTER received_quantity,
        ADD COLUMN IF NOT EXISTS lot_status VARCHAR(30) NOT NULL DEFAULT 'Available' AFTER used_quantity,
        ADD COLUMN IF NOT EXISTS received_date DATE NULL AFTER lot_status,
        ADD COLUMN IF NOT EXISTS received_by INT NULL AFTER received_date,
        ADD COLUMN IF NOT EXISTS received_by_name VARCHAR(100) NULL AFTER received_by
    `).catch(() => {});
    await conn.query(`
      UPDATE vaccine_inventory
      SET received_quantity = COALESCE(received_quantity, quantity + COALESCE(used_quantity, 0)),
          lot_status = CASE
            WHEN quantity <= 0 THEN 'Depleted'
            WHEN expiry_date IS NOT NULL AND expiry_date < CURDATE() THEN 'Expired'
            ELSE COALESCE(NULLIF(lot_status,''), 'Available')
          END
      WHERE received_quantity IS NULL OR lot_status IS NULL OR lot_status = ''
    `).catch(() => {});

    // ========== MISSED DOSE / TREATMENT RESTART ==========
    await conn.query(`
      ALTER TABLE treatment_episodes
        ADD COLUMN IF NOT EXISTS treatment_cycle INT NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS cycle_started_on DATE NULL,
        ADD COLUMN IF NOT EXISTS missed_detected_at DATETIME NULL,
        ADD COLUMN IF NOT EXISTS schedule_stopped_at DATETIME NULL
    `).catch(() => {});
    await conn.query(`
      ALTER TABLE patient_pep_schedule
        ADD COLUMN IF NOT EXISTS treatment_cycle INT NOT NULL DEFAULT 1
    `).catch(() => {});
    await conn.query(`
      ALTER TABLE patient_pep_schedule
        ADD INDEX IF NOT EXISTS idx_pep_episode_cycle (episode_id, treatment_cycle)
    `).catch(() => {});
    await conn.query(`
      CREATE TABLE IF NOT EXISTS treatment_restarts (
        restart_id            BIGINT AUTO_INCREMENT PRIMARY KEY,
        patient_id            INT NOT NULL,
        exposure_id           INT NULL,
        episode_id            INT NOT NULL,
        previous_cycle        INT NOT NULL,
        new_cycle             INT NOT NULL,
        missed_dose           VARCHAR(20) NULL,
        missed_due_date       DATE NULL,
        missed_detected_at    DATETIME NULL,
        days_delayed          INT NULL,
        patient_returned_on   DATE NOT NULL,
        patient_requested     TINYINT(1) NOT NULL DEFAULT 1,
        restart_date          DATE NOT NULL,
        protocol_days         VARCHAR(50) NULL,
        confirmed_by          VARCHAR(100) NULL,
        confirmed_by_staff_id INT NULL,
        confirmed_by_role     VARCHAR(50) NULL,
        note                  TEXT NOT NULL,
        previous_doses        LONGTEXT NULL,
        created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_restart_episode_cycle (episode_id, previous_cycle),
        INDEX idx_restart_patient (patient_id),
        INDEX idx_restart_exposure (exposure_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});
    await conn.query(`
      CREATE TABLE IF NOT EXISTS treatment_status_history (
        history_id      BIGINT AUTO_INCREMENT PRIMARY KEY,
        patient_id      INT NOT NULL,
        exposure_id     INT NULL,
        episode_id      INT NOT NULL,
        treatment_cycle INT NOT NULL DEFAULT 1,
        event           VARCHAR(50) NOT NULL,
        dose_label      VARCHAR(20) NULL,
        previous_status VARCHAR(50) NULL,
        new_status      VARCHAR(50) NULL,
        note            TEXT NULL,
        staff_id        INT NULL,
        staff_name      VARCHAR(100) NULL,
        staff_role      VARCHAR(50) NULL,
        source          VARCHAR(20) NOT NULL DEFAULT 'staff',
        created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_tsh_episode (episode_id, created_at),
        INDEX idx_tsh_patient (patient_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});
    await conn.query(`UPDATE treatment_episodes SET status = 'Incomplete' WHERE status = 'Treatment Interrupted'`).catch(() => {});
    await conn.query(`UPDATE patients SET treatment_status = 'Incomplete' WHERE treatment_status = 'Treatment Interrupted'`).catch(() => {});

    await conn.query(`
      ALTER TABLE patients
        ADD COLUMN IF NOT EXISTS temp_password_cipher TEXT NULL
    `).catch(() => {});

    await conn.query(`
      CREATE TABLE IF NOT EXISTS sms_settings (
        setting_id      TINYINT NOT NULL PRIMARY KEY DEFAULT 1,
        enabled         TINYINT(1) NOT NULL DEFAULT 0,
        sender_id       VARCHAR(11) NULL,
        portal_url      VARCHAR(255) NULL,
        clinic_contact  VARCHAR(80) NULL,
        updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});
    // Do not seed enabled=0 here. Until an admin saves settings, IPROG_SMS_ENABLED in .env is the switch.
    await conn.query(`
      ALTER TABLE sms_settings
        ADD COLUMN IF NOT EXISTS last_test_at DATETIME NULL,
        ADD COLUMN IF NOT EXISTS last_test_ok TINYINT(1) NULL,
        ADD COLUMN IF NOT EXISTS last_test_message VARCHAR(255) NULL
    `).catch(() => {});
    await conn.query(`
      ALTER TABLE sms_logs
        ADD COLUMN IF NOT EXISTS provider VARCHAR(20) NULL,
        ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(80) NULL,
        ADD COLUMN IF NOT EXISTS message_type VARCHAR(30) NULL
    `).catch(() => {});

    await conn.query(`
      CREATE TABLE IF NOT EXISTS sms_logs (
        sms_log_id          BIGINT AUTO_INCREMENT PRIMARY KEY,
        patient_id          INT NOT NULL,
        episode_id          INT NULL,
        pep_schedule_id     INT NULL,
        dose_label          VARCHAR(20) NULL,
        scheduled_date      DATE NULL,
        reminder_type       VARCHAR(30) NOT NULL,
        message_type        VARCHAR(30) NULL,
        phone_masked        VARCHAR(32) NULL,
        message_ref         TEXT NULL,
        status              VARCHAR(20) NOT NULL DEFAULT 'Pending',
        api_status          VARCHAR(50) NULL,
        error_message       VARCHAR(255) NULL,
        philsms_message_id  VARCHAR(80) NULL,
        provider            VARCHAR(20) NULL,
        provider_message_id VARCHAR(80) NULL,
        source              VARCHAR(20) NOT NULL DEFAULT 'system',
        staff_id            INT NULL,
        attempt_count       INT NOT NULL DEFAULT 1,
        sent_at             DATETIME NULL,
        created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_sms_patient (patient_id, created_at),
        INDEX idx_sms_status (status),
        INDEX idx_sms_type (reminder_type),
        INDEX idx_sms_dose (patient_id, reminder_type, dose_label, scheduled_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

    await conn.query(`
      CREATE TABLE IF NOT EXISTS sms_reminder_claims (
        claim_id        BIGINT AUTO_INCREMENT PRIMARY KEY,
        patient_id      INT NOT NULL,
        episode_id      INT NOT NULL DEFAULT 0,
        dose_label      VARCHAR(20) NOT NULL,
        scheduled_date  DATE NOT NULL,
        reminder_type   VARCHAR(30) NOT NULL,
        status          VARCHAR(20) NOT NULL,
        source          VARCHAR(20) NULL,
        staff_id        INT NULL,
        sms_log_id      BIGINT NULL,
        error_message   VARCHAR(255) NULL,
        claimed_at      DATETIME NULL,
        sent_at         DATETIME NULL,
        created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_sms_reminder_event (patient_id, episode_id, dose_label, scheduled_date, reminder_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(() => {});

  } finally {
    conn.release();
  }
}

// Export a proxy so routes can `require` this module immediately but
// the actual pool is resolved after initPool() has been awaited in server.js
const poolProxy = new Proxy({}, {
  get(_, prop) {
    if (!pool) throw new Error('Database pool used before initPool() completed.');
    return pool[prop];
  }
});

module.exports = { initPool, pool: poolProxy };
