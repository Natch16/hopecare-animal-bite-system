(function (global) {
  const PERMISSIONS = {
    dashboard: 'dashboard', admin_dashboard: 'admin_dashboard',
    patients: 'patients', followup: 'followup', vaccination: 'vaccination',
    map: 'map', reports: 'reports', inventory_reports: 'inventory_reports',
    activity_logs: 'activity_logs', activity_logs_view: 'activity_logs_view',
    settings_profile: 'settings_profile', system_settings: 'system_settings',
    analytics: 'analytics', ai_analytics: 'ai_analytics', inventory: 'inventory',
    inventory_history: 'inventory_history', staff_management: 'staff_management',
    patient_accounts: 'patient_accounts', treatment_restart: 'treatment_restart',
    sms_send: 'sms_send', sms_admin: 'sms_admin',
  };

  // Keyed by the last two path segments (folder/file.html) so it works
  // regardless of which subfolder the current page is served from.
  const PAGE_MAP = {
    'nurse/dashboard.html':            PERMISSIONS.dashboard,
    'admin/admin-dashboard.html':      PERMISSIONS.admin_dashboard,
    'nurse/patients.html':             PERMISSIONS.patients,
    'nurse/patient-episodes.html':     PERMISSIONS.patients,
    'nurse/followup.html':             PERMISSIONS.followup,
    'nurse/vaccination.html':          PERMISSIONS.vaccination,
    'nurse/map.html':                  PERMISSIONS.map,
    'nurse/analytics.html':            PERMISSIONS.analytics,
    'admin/inventory-analytics.html':  PERMISSIONS.analytics,
    'admin/ai-predictive.html':        PERMISSIONS.ai_analytics,
    'nurse/reports.html':              PERMISSIONS.reports,
    'admin/inventory-reports.html':    PERMISSIONS.inventory_reports,
    'shared/activity-logs.html':       PERMISSIONS.activity_logs,
    'shared/settings.html':            PERMISSIONS.system_settings,
    'admin/inventory.html':            PERMISSIONS.inventory,
    'admin/inventory-history.html':    PERMISSIONS.inventory_history,
    'admin/patient-accounts.html':     PERMISSIONS.patient_accounts,
    'admin/staff-management.html':     PERMISSIONS.staff_management,
  };

  let authState = null;

  function hasPermission(perm) {
    return authState?.permissions?.includes(perm);
  }
  function isAdmin() { return authState?.role === 'Administrator'; }
  function isNurse() { return authState?.role === 'Nurse'; }

  function canAccessPage(pageKey) {
    const perm = PAGE_MAP[pageKey];
    if (!perm) return true;
    if (perm === PERMISSIONS.activity_logs) {
      return hasPermission(PERMISSIONS.activity_logs) || hasPermission(PERMISSIONS.activity_logs_view);
    }
    if (perm === PERMISSIONS.system_settings) {
      return hasPermission(PERMISSIONS.system_settings) || hasPermission(PERMISSIONS.settings_profile);
    }
    return hasPermission(perm);
  }

  function homePage() {
    // home_page from server already has a leading slash (e.g. '/nurse/dashboard.html')
    if (authState?.home_page) return authState.home_page;
    return isAdmin() ? '/admin/admin-dashboard.html' : '/nurse/dashboard.html';
  }

  // Derive "folder/file.html" key from current URL path
  function currentPageKey() {
    const parts = location.pathname.split('/').filter(Boolean);
    // e.g. ['nurse', 'dashboard.html'] → 'nurse/dashboard.html'
    if (parts.length >= 2) return parts.slice(-2).join('/');
    return parts.join('/');
  }

  async function initRBAC() {
    try {
      const res = await fetch('/api/auth/check');
      const data = await res.json();
      if (!data.loggedIn) {
        if (!location.pathname.includes('login')) {
          location.href = '/shared/login.html';
        }
        return null;
      }
      authState = data;
      const pageKey = currentPageKey();

      // Redirect admin away from nurse dashboard and vice-versa
      if (pageKey === 'nurse/dashboard.html' && isAdmin()) {
        location.href = '/admin/admin-dashboard.html';
        return null;
      }
      if (pageKey === 'admin/admin-dashboard.html' && isNurse()) {
        location.href = '/nurse/dashboard.html';
        return null;
      }

      if (!pageKey.includes('login') && !canAccessPage(pageKey)) {
        location.href = homePage() + '?denied=1';
        return null;
      }
      return data;
    } catch (e) {
      console.error('RBAC error:', e);
      return null;
    }
  }

  global.RBAC = {
    PERMISSIONS, hasPermission, isAdmin, isNurse,
    canAccessPage, initRBAC, getAuthState: () => authState, homePage,
  };
})(window);
