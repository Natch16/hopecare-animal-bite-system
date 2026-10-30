const pool = require('../config/database').pool;
const { getCurrentShift } = require('./shiftHelper');

const MODULES = {
  AUTH: 'Authentication',
  PATIENTS: 'Patient Records',
  FOLLOWUP: 'Follow-up',
  MONITORING: 'Patient Monitoring',
  VACCINES: 'Vaccine Management',
  INVENTORY: 'Vaccine Inventory',
  SETTINGS: 'Settings',
  REPORTS: 'Reports',
  ANALYTICS: 'Analytics',
  MAP: 'Geographic Map',
  STAFF: 'Staff Management',
  ACTIVITY_LOGS: 'Activity Logs',
  PATIENT_ACCOUNTS: 'Patient Accounts',
  REMINDERS: 'Follow-up Reminders',
  DASHBOARD: 'Dashboard',
  SMS: 'SMS Reminders',
};

const ACTIONS = {
  LOGIN: 'Login',
  LOGOUT: 'Logout',
  ADD: 'Add',
  EDIT: 'Edit',
  DELETE: 'Delete',
  UPDATE: 'Update',
  RESET_PASSWORD: 'Reset Password',
  ACTIVATE: 'Activate',
  DEACTIVATE: 'Deactivate',
  GENERATE: 'Generate',
  EXPORT_PDF: 'Export PDF',
  EXPORT_EXCEL: 'Export Excel',
  VIEW: 'View',
  REVIEW: 'Review',
  RESUME: 'Resume Treatment',
  STOCK_IN: 'Stock In',
  STOCK_OUT: 'Stock Out',
  USAGE: 'Vaccine Usage',
  UNLOCK: 'Unlock Account',
  SEARCH: 'Search',
  PRINT: 'Print',
  FILTER: 'Filter',
  SEND_SMS: 'Send SMS',
};

async function logActivity(req, {
  action, module, reference_id = null, description = null,
  old_value = null, new_value = null, status = 'Success',
}) {
  try {
    const staff_id = req.session?.staffId || null;
    const username = req.session?.username || 'system';
    const full_name = req.session?.fullName || null;
    const role = req.session?.role || null;

    if (!staff_id) return;

    const ip_address =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.headers['x-real-ip'] ||
      req.socket?.remoteAddress ||
      req.ip ||
      null;

    const shift = getCurrentShift();

    await pool.query(
      `INSERT INTO activity_logs
         (staff_id, username, full_name, role, action, module, reference_id,
          description, old_value, new_value, status, ip_address, shift)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        staff_id, username, full_name, role, action, module,
        String(reference_id ?? ''), description,
        old_value ? String(old_value) : null,
        new_value ? String(new_value) : null,
        status, ip_address, shift,
      ]
    );
  } catch (err) {
    console.error('[logActivity] failed:', err.message);
  }
}

module.exports = { logActivity, MODULES, ACTIONS };
