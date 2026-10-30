const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/database').pool;
const { requirePatientAuth } = require('../middleware/patientAuth');
const { generatePatientId, parsePatientIdDisplay, paddedPatientSerial } = require('../utils/idFormats');
const {
  needsPasswordChange,
  passwordMatches,
} = require('../utils/patientTempPassword');

const GENERIC_LOGIN_ERROR = 'Invalid Patient ID or password. Please check your credentials and try again.';

function normalizePatientLogin(login) {
  return String(login || '')
    .trim()
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, '');
}

const PATIENT_LOGIN_COLUMNS = `p.patient_id, p.registration_number, p.full_name, p.password,
            p.is_temp_password, p.temp_password_cipher,
            pa.username AS account_username, pa.password_hash, pa.account_status,
            pa.is_locked, pa.failed_attempts, pa.first_login`;

async function findPatientByLogin(login) {
  const trimmed = normalizePatientLogin(login);
  if (!trimmed) return null;

  const fromPatients = `
    SELECT ${PATIENT_LOGIN_COLUMNS}
      FROM patients p
      LEFT JOIN patient_accounts pa ON pa.patient_id = p.patient_id`;

  const patientNum = parsePatientIdDisplay(trimmed);
  if (patientNum !== null) {
    const [[row]] = await pool.query(
      `${fromPatients} WHERE p.patient_id = ? LIMIT 1`,
      [patientNum]
    );
    if (row) return row;
  }

  const [[byAccount]] = await pool.query(
    `${fromPatients} WHERE UPPER(pa.username) = UPPER(?) LIMIT 1`,
    [trimmed]
  ).catch(() => [[]]);
  if (byAccount) return byAccount;

  const [[byReg]] = await pool.query(
    `${fromPatients} WHERE UPPER(p.registration_number) = UPPER(?) LIMIT 1`,
    [trimmed]
  );
  if (byReg) return byReg;

  // PAT-000002 is not a stored patient_id when IDs have gaps; it is often the
  // registration serial ABC-YYYY-000002 for an existing patient (e.g. PAT-000030).
  if (patientNum !== null) {
    const serial = paddedPatientSerial(patientNum);
    const [[bySerial]] = await pool.query(
      `${fromPatients}
       WHERE p.registration_number LIKE CONCAT('%-', ?)
       LIMIT 1`,
      [serial]
    );
    if (bySerial) return bySerial;
  }

  return null;
}

function accountFromPatientRow(patient) {
  if (!patient) return {};
  return {
    password_hash: patient.password_hash,
    account_status: patient.account_status,
    is_locked: patient.is_locked,
    failed_attempts: patient.failed_attempts,
    first_login: patient.first_login,
  };
}

function savePatientSession(req, patient) {
  req.session.patientId = patient.patient_id;
  req.session.registrationNumber = patient.registration_number;
  req.session.fullName = patient.full_name;
  req.session.patientLoggedIn = true;
  delete req.session.loggedIn;
  delete req.session.staffId;
  delete req.session.role;
}

function patientLoginPayload(patient, account) {
  const mustChange = needsPasswordChange(patient, account || {});
  return {
    success: true,
    message: 'Login successful',
    is_temp_password: mustChange,
    patient: {
      patient_id: patient.patient_id,
      patient_id_display: generatePatientId(patient.patient_id),
      registration_number: patient.registration_number,
      full_name: patient.full_name,
      is_temp_password: mustChange,
    },
  };
}

router.post('/login', async (req, res) => {
  try {
    const loginId = req.body.username || req.body.registration_number;
    const { password } = req.body;

    if (!loginId || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please enter both Patient ID and password.',
      });
    }

    const patient = await findPatientByLogin(loginId);

    if (!patient) {
      return res.status(401).json({
        success: false,
        message: GENERIC_LOGIN_ERROR,
      });
    }

    const account = accountFromPatientRow(patient);
    const isMatch = await passwordMatches(password, patient, account);

    if (!isMatch) {
      if (patient.account_username || patient.password_hash) {
        const attempts = Number(account.failed_attempts || 0) + 1;
        const lock = attempts >= 5 ? 1 : 0;
        await pool.query(
          'UPDATE patient_accounts SET failed_attempts = ?, is_locked = ? WHERE patient_id = ?',
          [attempts, lock, patient.patient_id]
        ).catch(() => {});
      }
      await pool.query(
        `INSERT INTO patient_login_history (patient_id, username, ip_address, user_agent, success)
         VALUES (?, ?, ?, ?, 0)`,
        [
          patient.patient_id,
          generatePatientId(patient.patient_id),
          req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null,
          req.headers['user-agent'] || null,
        ]
      ).catch(() => {});
      return res.status(401).json({
        success: false,
        message: GENERIC_LOGIN_ERROR,
      });
    }

    if (account.account_status === 'Inactive') {
      return res.status(403).json({
        success: false,
        message: 'Account is inactive. Please contact HopeCare Animal Bite Center.',
        code: 'INACTIVE_ACCOUNT',
      });
    }

    await pool.query(
      'UPDATE patient_accounts SET last_login = NOW(), failed_attempts = 0, is_locked = 0 WHERE patient_id = ?',
      [patient.patient_id]
    ).catch(() => {});

    await pool.query(
      `INSERT INTO patient_login_history (patient_id, username, ip_address, user_agent, success)
       VALUES (?, ?, ?, ?, 1)`,
      [
        patient.patient_id,
        generatePatientId(patient.patient_id),
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null,
        req.headers['user-agent'] || null,
      ]
    ).catch(() => {});

    const payload = patientLoginPayload(patient, account);
    await new Promise((resolve) => {
      const persist = () => {
        savePatientSession(req, patient);
        if (typeof req.session.save === 'function') {
          req.session.save(() => resolve());
        } else {
          resolve();
        }
      };
      if (typeof req.session.regenerate === 'function') {
        req.session.regenerate(() => persist());
      } else {
        persist();
      }
    });
    return res.json(payload);
  } catch (error) {
    console.error('Patient login error:', error);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Logout failed' });
    }
    res.json({ success: true, message: 'Logout successful' });
  });
});

router.get('/check', async (req, res) => {
  if (!req.session.patientLoggedIn || !req.session.patientId) {
    return res.json({ loggedIn: false });
  }
  let mustChange = false;
  try {
    const [[patient]] = await pool.query(
      'SELECT is_temp_password FROM patients WHERE patient_id = ? LIMIT 1',
      [req.session.patientId]
    );
    const [[account]] = await pool.query(
      'SELECT first_login FROM patient_accounts WHERE patient_id = ? LIMIT 1',
      [req.session.patientId]
    ).catch(() => [[]]);
    mustChange = needsPasswordChange(patient || {}, account || {});
  } catch (_) {
    mustChange = false;
  }
  res.json({
    loggedIn: true,
    patient_id: req.session.patientId,
    patient_id_display: generatePatientId(req.session.patientId),
    registration_number: req.session.registrationNumber,
    full_name: req.session.fullName,
    is_temp_password: mustChange,
  });
});

router.post('/change-password', requirePatientAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide both current and new password.',
      });
    }

    const newPasswordTrimmed = String(new_password).trim();
    if (newPasswordTrimmed.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 8 characters long.',
      });
    }
    if (newPasswordTrimmed === String(current_password).trim()) {
      return res.status(400).json({
        success: false,
        message: 'New password must be different from the current password.',
      });
    }

    const [[patient]] = await pool.query(
      `SELECT patient_id, registration_number, full_name, password, is_temp_password
       FROM patients WHERE patient_id = ? LIMIT 1`,
      [req.session.patientId]
    );

    if (!patient) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    const [[account]] = await pool.query(
      'SELECT first_login, password_hash FROM patient_accounts WHERE patient_id = ? LIMIT 1',
      [req.session.patientId]
    ).catch(() => [[]]);

    const isMatch = await passwordMatches(current_password, patient, account || {});
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect.',
      });
    }

    const hashedNewPassword = await bcrypt.hash(newPasswordTrimmed, 10);

    await pool.query(
      'UPDATE patients SET password = ?, is_temp_password = 0, temp_password_cipher = NULL WHERE patient_id = ?',
      [hashedNewPassword, req.session.patientId]
    );
    await pool.query(
      'UPDATE patient_accounts SET password_hash = ?, first_login = 0 WHERE patient_id = ?',
      [hashedNewPassword, req.session.patientId]
    ).catch(() => {});

    const sessionPatient = {
      patient_id: patient.patient_id,
      registration_number: patient.registration_number,
      full_name: patient.full_name,
    };
    await new Promise((resolve) => {
      const persist = () => {
        savePatientSession(req, sessionPatient);
        if (typeof req.session.save === 'function') {
          req.session.save(() => resolve());
        } else {
          resolve();
        }
      };
      if (typeof req.session.regenerate === 'function') {
        req.session.regenerate(() => persist());
      } else {
        persist();
      }
    });
    return res.json({
      success: true,
      message: 'Password changed successfully.',
      require_relogin: false,
    });
  } catch (error) {
    console.error('Patient change password error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
