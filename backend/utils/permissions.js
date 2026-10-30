const ROLES = {
  ADMINISTRATOR: 'Administrator',
  NURSE: 'Nurse',
};

const PERMISSIONS = {
  DASHBOARD: 'dashboard',
  ADMIN_DASHBOARD: 'admin_dashboard',
  PATIENTS: 'patients',
  FOLLOWUP: 'followup',
  VACCINATION: 'vaccination',
  MAP: 'map',
  REPORTS: 'reports',
  ACTIVITY_LOGS: 'activity_logs',
  ACTIVITY_LOGS_VIEW: 'activity_logs_view',
  SETTINGS_PROFILE: 'settings_profile',
  ANALYTICS: 'analytics',
  AI_ANALYTICS: 'ai_analytics',
  INVENTORY: 'inventory',
  INVENTORY_HISTORY: 'inventory_history',
  INVENTORY_REPORTS: 'inventory_reports',
  STAFF_MANAGEMENT: 'staff_management',
  PATIENT_ACCOUNTS: 'patient_accounts',
  SYSTEM_SETTINGS: 'system_settings',
  RESET_PATIENT_PASSWORD: 'reset_patient_password',
  TREATMENT_RESTART: 'treatment_restart',
  SMS_SEND: 'sms_send',
  SMS_ADMIN: 'sms_admin',
};

const ADMIN_PERMISSIONS = [
  PERMISSIONS.ADMIN_DASHBOARD,
  PERMISSIONS.STAFF_MANAGEMENT,
  PERMISSIONS.PATIENT_ACCOUNTS,
  PERMISSIONS.INVENTORY,
  PERMISSIONS.INVENTORY_HISTORY,
  PERMISSIONS.ANALYTICS,
  PERMISSIONS.AI_ANALYTICS,
  PERMISSIONS.INVENTORY_REPORTS,
  PERMISSIONS.ACTIVITY_LOGS,
  PERMISSIONS.SYSTEM_SETTINGS,
  PERMISSIONS.SMS_SEND,
  PERMISSIONS.SMS_ADMIN,
];

const ROLE_PERMISSIONS = {
  [ROLES.ADMINISTRATOR]: ADMIN_PERMISSIONS,
  [ROLES.NURSE]: [
    PERMISSIONS.DASHBOARD,
    PERMISSIONS.PATIENTS,
    PERMISSIONS.FOLLOWUP,
    PERMISSIONS.VACCINATION,
    PERMISSIONS.MAP,
    PERMISSIONS.ANALYTICS,
    PERMISSIONS.REPORTS,
    PERMISSIONS.ACTIVITY_LOGS_VIEW,
    PERMISSIONS.SETTINGS_PROFILE,
    PERMISSIONS.RESET_PATIENT_PASSWORD,
    PERMISSIONS.TREATMENT_RESTART,
    PERMISSIONS.SMS_SEND,
  ],
};

const PAGE_PERMISSIONS = {
  // Nurse pages
  'nurse/dashboard.html':            PERMISSIONS.DASHBOARD,
  'nurse/patients.html':             PERMISSIONS.PATIENTS,
  'nurse/patient-episodes.html':     PERMISSIONS.PATIENTS,
  'nurse/followup.html':             PERMISSIONS.FOLLOWUP,
  'nurse/vaccination.html':          PERMISSIONS.VACCINATION,
  'nurse/map.html':                  PERMISSIONS.MAP,
  'nurse/analytics.html':            PERMISSIONS.ANALYTICS,
  'nurse/reports.html':              PERMISSIONS.REPORTS,
  // Admin pages
  'admin/admin-dashboard.html':      PERMISSIONS.ADMIN_DASHBOARD,
  'admin/staff-management.html':     PERMISSIONS.STAFF_MANAGEMENT,
  'admin/patient-accounts.html':     PERMISSIONS.PATIENT_ACCOUNTS,
  'admin/inventory.html':            PERMISSIONS.INVENTORY,
  'admin/inventory-history.html':    PERMISSIONS.INVENTORY_HISTORY,
  'admin/inventory-analytics.html':  PERMISSIONS.ANALYTICS,
  'admin/inventory-reports.html':    PERMISSIONS.INVENTORY_REPORTS,
  'admin/ai-predictive.html':        PERMISSIONS.AI_ANALYTICS,
  // Shared pages
  'shared/activity-logs.html':       PERMISSIONS.ACTIVITY_LOGS,
  'shared/settings.html':            PERMISSIONS.SYSTEM_SETTINGS,
};

function normalizeRole(role) {
  if (!role) return ROLES.NURSE;
  const r = String(role).trim();
  if (r.toLowerCase() === 'administrator' || r.toLowerCase() === 'admin') return ROLES.ADMINISTRATOR;
  return ROLES.NURSE;
}

function getPermissionsForRole(role) {
  const normalized = normalizeRole(role);
  return ROLE_PERMISSIONS[normalized] || ROLE_PERMISSIONS[ROLES.NURSE];
}

function hasPermission(role, permission) {
  return getPermissionsForRole(role).includes(permission);
}

function canAccessPage(role, pageName) {
  const perm = PAGE_PERMISSIONS[pageName];
  if (!perm) return true;
  if (perm === PERMISSIONS.ACTIVITY_LOGS) {
    return hasPermission(role, PERMISSIONS.ACTIVITY_LOGS) ||
      hasPermission(role, PERMISSIONS.ACTIVITY_LOGS_VIEW);
  }
  if (perm === PERMISSIONS.SETTINGS_PROFILE || perm === PERMISSIONS.SYSTEM_SETTINGS) {
    return hasPermission(role, PERMISSIONS.SYSTEM_SETTINGS) ||
      hasPermission(role, PERMISSIONS.SETTINGS_PROFILE);
  }
  return hasPermission(role, perm);
}

function getDefaultHomePage(role) {
  return normalizeRole(role) === ROLES.ADMINISTRATOR
    ? '/admin/admin-dashboard.html'
    : '/nurse/dashboard.html';
}

module.exports = {
  ROLES,
  PERMISSIONS,
  ADMIN_PERMISSIONS,
  ROLE_PERMISSIONS,
  PAGE_PERMISSIONS,
  normalizeRole,
  getPermissionsForRole,
  hasPermission,
  canAccessPage,
  getDefaultHomePage,
};
