/**
 * HopeCare Administrator — shared sidebar navigation
 */
(function (global) {
  const ADMIN_NAV = [
    { id: 'admin-dashboard',      href: '/admin/admin-dashboard.html',     icon: 'fa-gauge-high',       label: 'Dashboard',               perm: 'admin_dashboard' },
    { id: 'staff-management',     href: '/admin/staff-management.html',    icon: 'fa-user-shield',      label: 'Staff Management',        perm: 'staff_management' },
    { id: 'patient-accounts',     href: '/admin/patient-accounts.html',    icon: 'fa-users-gear',       label: 'Patient Accounts',        perm: 'patient_accounts' },
    { id: 'inventory',            href: '/admin/inventory.html',           icon: 'fa-boxes-stacked',    label: 'Vaccine Inventory',       perm: 'inventory' },
    { id: 'inventory-history',    href: '/admin/inventory-history.html',   icon: 'fa-clock-rotate-left',label: 'Inventory History',       perm: 'inventory_history' },
    { id: 'ai-predictive',        href: '/admin/ai-predictive.html',       icon: 'fa-brain',            label: 'AI Inventory Analytics',  perm: 'ai_analytics' },
    { id: 'inventory-reports',    href: '/admin/inventory-reports.html',   icon: 'fa-file-lines',       label: 'Inventory Reports',       perm: 'inventory_reports' },
    { id: 'activity-logs',        href: '/shared/activity-logs.html',      icon: 'fa-clipboard-check',  label: 'Activity Logs',           perm: 'activity_logs' },
    { id: 'settings',             href: '/shared/settings.html',           icon: 'fa-gear',             label: 'Settings',                perm: 'system_settings' },
  ];

  const NURSE_NAV = [
    { id: 'dashboard',    href: '/nurse/dashboard.html',         icon: 'fa-gauge-high',      label: 'Dashboard',        perm: 'dashboard' },
    { id: 'patients',     href: '/nurse/patients.html',          icon: 'fa-user-injured',    label: 'Patient Records',  perm: 'patients' },
    { id: 'followup',     href: '/nurse/followup.html',          icon: 'fa-clipboard-list',  label: 'Patient Monitoring', perm: 'followup' },
    { id: 'map',          href: '/nurse/map.html',               icon: 'fa-map-location-dot',label: 'Geographic Map',   perm: 'map' },
    { id: 'analytics',    href: '/nurse/analytics.html',         icon: 'fa-chart-simple',    label: 'Analytics',        perm: 'analytics' },
    { id: 'reports',      href: '/nurse/reports.html',           icon: 'fa-file-lines',      label: 'Reports',          perm: 'reports' },
    { id: 'activity-logs',href: '/shared/activity-logs.html',    icon: 'fa-clipboard-check', label: 'Activity Logs',    perm: 'activity_logs_view' },
    { id: 'settings',     href: '/shared/settings.html',         icon: 'fa-gear',            label: 'Settings',         perm: 'settings_profile' },
  ];

  const STAFF_CARD_CSS = `
    .staff-card { margin:0 14px 16px; padding:13px 12px; border-radius:14px;
      background:rgba(255,255,255,.1); border:1px solid rgba(255,255,255,.18); }
    .staff-card-inner { display:flex; align-items:center; gap:11px; }
    .staff-avatar { width:42px;height:42px;border-radius:50%;
      background:linear-gradient(135deg,#4274D9,#95CCDD);color:#fff;font-weight:800;
      display:flex;align-items:center;justify-content:center; }
    .staff-name { font-size:13px;font-weight:700;color:#fff; }
    .staff-role { font-size:11px;color:rgba(255,255,255,.72); }
    .staff-role-badge { display:inline-block;font-size:9px;font-weight:700;padding:2px 6px;border-radius:99px;margin-top:4px; }
    .role-admin { background:rgba(251,191,36,.25);color:#fcd34d; }
    .role-nurse { background:rgba(149,204,221,.2);color:#95CCDD; }
  `;

  const LOGOUT_MODAL_CSS = `
    #logoutConfirmModal{display:none;position:fixed;inset:0;z-index:99999;align-items:center;justify-content:center;background:rgba(15,23,42,.48);backdrop-filter:blur(3px);padding:20px;}
    #logoutConfirmModal.lco-open{display:flex;}
    .lco-card{position:relative;background:#fff;border-radius:22px;max-width:420px;width:100%;padding:28px 26px 22px;text-align:center;box-shadow:0 24px 60px rgba(15,23,42,.22);overflow:hidden;}
    .lco-card::before{content:"";position:absolute;inset:0;border-radius:inherit;background-image:radial-gradient(rgba(148,163,184,.42) 1.15px,transparent 1.15px);background-size:16px 16px;pointer-events:none;}
    .lco-card>*:not(.lco-close){position:relative;z-index:1;}
    .lco-card>.lco-close{position:absolute;top:14px;right:14px;width:28px;height:28px;border:none;background:transparent;color:#94a3b8;font-size:16px;cursor:pointer;border-radius:8px;display:flex;align-items:center;justify-content:center;z-index:2;}
    .lco-close:hover{background:rgba(241,245,249,.9);color:#64748b;}
    .lco-icon{width:78px;height:78px;margin:6px auto 16px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle,#fff 0 22px,#ffe4e6 23px 34px,rgba(254,226,226,.55) 35px 46px,rgba(254,226,226,0) 47px);box-shadow:0 0 0 10px rgba(254,226,226,.38),0 0 28px rgba(239,68,68,.16);}
    .lco-icon i{font-size:26px;color:#ef4444;}
    .lco-title{font-size:22px;font-weight:800;color:#0f172a;margin:0 0 8px;letter-spacing:-.02em;line-height:1.25;}
    .lco-title span{color:#ef4444;}
    .lco-sub{margin:0;font-size:14px;color:#94a3b8;line-height:1.5;}
    .lco-notice{display:flex;align-items:flex-start;gap:10px;text-align:left;background:#eef5ff;border-radius:12px;padding:12px 14px;margin-top:18px;color:#3b6cb5;font-size:13px;line-height:1.45;font-weight:500;}
    .lco-notice i{color:#3b82f6;font-size:16px;margin-top:1px;flex-shrink:0;}
    .lco-btn-row{display:flex;gap:12px;margin-top:18px;}
    .lco-btn-cancel,.lco-btn-confirm{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 14px;border-radius:12px;font-weight:700;font-size:14px;font-family:inherit;cursor:pointer;line-height:1;}
    .lco-btn-cancel{background:#fff;color:#3b82f6;border:1.5px solid #60a5fa;}
    .lco-btn-cancel:hover{background:#f8fbff;border-color:#3b82f6;}
    .lco-btn-confirm{background:#ef4444;color:#fff;border:none;box-shadow:0 6px 16px rgba(239,68,68,.28);}
    .lco-btn-confirm:hover{background:#dc2626;}
    .lco-btn-confirm:disabled{opacity:.88;cursor:default;}
    .lco-spinner{width:14px;height:14px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;display:inline-block;animation:lco-spin .7s linear infinite;}
    @keyframes lco-spin{to{transform:rotate(360deg);}}
  `;

  function getInitials(name) {
    if (!name) return 'U';
    const p = String(name).trim().split(/\s+/);
    return p.length === 1 ? p[0][0].toUpperCase() : (p[0][0] + p[p.length-1][0]).toUpperCase();
  }

  function getNavForRole(role, permissions) {
    const items = role === 'Administrator' ? ADMIN_NAV : NURSE_NAV;
    if (!permissions?.length) return items;
    return items.filter(item => permissions.includes(item.perm));
  }

  function buildStaffCardHtml() {
    return `<div class="staff-card"><div class="staff-card-inner">
      <div class="staff-avatar" id="staffAvatar">--</div>
      <div><div class="staff-name" id="staffName">Loading…</div>
      <div class="staff-role" id="staffRole">—</div>
      <div class="staff-role-badge role-nurse" id="staffRoleBadge">Staff</div>
      <div id="staffIdDisplay" style="font-size:10px;color:rgba(255,255,255,.55);margin-top:2px;"></div></div></div></div>`;
  }

  function buildSidebarHtml(active, role, permissions) {
    const items = getNavForRole(role, permissions);
    const menu = items.map(item => {
      const cls = item.id === active ? 'menu-item active' : 'menu-item';
      return `<a href="${item.href}" class="${cls}"><i class="fa-solid ${item.icon}"></i> ${item.label}</a>`;
    }).join('');
    return `<div class="sidebar">
      <div class="sidebar-logo"><img src="/images/logo.png" alt="HopeCare" class="logo-img"></div>
      ${buildStaffCardHtml()}
      <div class="sidebar-menu" id="sidebarMenu">${menu}</div>
      <div class="sidebar-footer">
        <button type="button" class="sidebar-logout-btn" onclick="logout()"><i class="fa-solid fa-right-from-bracket"></i> Logout</button>
      </div></div>`;
  }

  async function populateStaffCard() {
    try {
      const res = await fetch('/api/auth/check');
      const data = await res.json();
      if (!data.loggedIn) return;
      const avatar = document.getElementById('staffAvatar');
      const nameEl = document.getElementById('staffName');
      const roleEl = document.getElementById('staffRole');
      const badgeEl = document.getElementById('staffRoleBadge');
      const name = data.full_name || data.username;
      const role = data.role || 'Nurse';
      if (avatar) avatar.textContent = getInitials(name);
      if (nameEl) nameEl.textContent = name;
      if (roleEl) roleEl.textContent = data.designation || role;
      if (badgeEl) { badgeEl.textContent = role; badgeEl.className = 'staff-role-badge ' + (role === 'Administrator' ? 'role-admin' : 'role-nurse'); }
      const idEl = document.getElementById('staffIdDisplay');
      if (idEl) idEl.textContent = data.staff_id_display || '';
      if (role === 'Administrator' || location.pathname.includes('/admin/')) {
        applyAdminShell();
      }
      const menu = document.getElementById('sidebarMenu');
      if (menu && data.permissions) {
        const active = resolveActiveNav();
        menu.innerHTML = getNavForRole(role, data.permissions).map(item => {
          const cls = item.id === active ? 'menu-item active' : 'menu-item';
          return `<a href="${item.href}" class="${cls}"><i class="fa-solid ${item.icon}"></i> ${item.label}</a>`;
        }).join('');
      }
    } catch (_) {}
  }

  function resolveActiveNav() {
    const fromBody = document.body?.getAttribute('data-nav');
    if (fromBody) return fromBody;
    return (location.pathname.split('/').pop() || 'dashboard.html').replace(/\.html$/i, '');
  }

  function applyAdminShell() {
    document.body.classList.add('hc-admin');
    if (!document.getElementById('admin-css-link')) {
      const already = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
        .some(l => (l.getAttribute('href') || '').includes('/css/admin.css'));
      if (!already) {
        const link = document.createElement('link');
        link.id = 'admin-css-link';
        link.rel = 'stylesheet';
        link.href = '/css/admin.css';
        document.head.appendChild(link);
      }
    }
    if (document.getElementById('hcAdminHamburger')) return;
    const btn = document.createElement('button');
    btn.id = 'hcAdminHamburger';
    btn.type = 'button';
    btn.className = 'hc-admin-hamburger';
    btn.setAttribute('aria-label', 'Open navigation');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<i class="fa-solid fa-bars"></i>';
    const overlay = document.createElement('div');
    overlay.id = 'hcAdminOverlay';
    overlay.className = 'hc-admin-overlay';
    const closeNav = () => {
      document.body.classList.remove('hc-nav-open');
      document.querySelector('.sidebar')?.classList.remove('open');
      overlay.classList.remove('show');
      btn.setAttribute('aria-expanded', 'false');
    };
    const toggleNav = () => {
      const open = !document.body.classList.contains('hc-nav-open');
      document.body.classList.toggle('hc-nav-open', open);
      document.querySelector('.sidebar')?.classList.toggle('open', open);
      overlay.classList.toggle('show', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    btn.addEventListener('click', toggleNav);
    overlay.addEventListener('click', closeNav);
    document.body.appendChild(overlay);
    document.body.appendChild(btn);
  }

  function initAppSidebar() {
    if (!document.getElementById('lco-modal-style')) {
      const s = document.createElement('style');
      s.id = 'lco-modal-style';
      s.textContent = LOGOUT_MODAL_CSS + STAFF_CARD_CSS;
      document.head.appendChild(s);
    }
    document.write(buildSidebarHtml(resolveActiveNav(), null, null));
    document.addEventListener('DOMContentLoaded', () => {
      if (location.pathname.includes('/admin/')) applyAdminShell();
      if (location.pathname.includes('/nurse/')) applyAdminShell(); // Apply hamburger for nurse too
      if (location.pathname.includes('/shared/')) applyAdminShell(); // Apply hamburger for shared pages too
      populateStaffCard();
      if (!document.getElementById('logoutConfirmModal')) {
        document.body.insertAdjacentHTML('beforeend', `
          <div id="logoutConfirmModal" role="dialog" aria-modal="true" aria-labelledby="lcoTitle">
            <div class="lco-card">
              <button type="button" class="lco-close" onclick="_closeLogoutModal()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
              <div class="lco-icon" aria-hidden="true"><i class="fa-solid fa-right-from-bracket"></i></div>
              <h3 id="lcoTitle" class="lco-title">Ready to <span>Sign Out?</span></h3>
              <p class="lco-sub">Are you sure you want to log out of your account?</p>
              <div class="lco-notice">
                <i class="fa-solid fa-shield-halved" aria-hidden="true"></i>
                <span>For your security, please sign in again to access your account.</span>
              </div>
              <div class="lco-btn-row">
                <button type="button" class="lco-btn-cancel" onclick="_closeLogoutModal()"><i class="fa-solid fa-xmark"></i> Cancel</button>
                <button type="button" class="lco-btn-confirm" onclick="_confirmLogout()"><i class="fa-solid fa-right-from-bracket"></i> Yes, Sign Out</button>
              </div>
            </div>
          </div>`);
        const modal = document.getElementById('logoutConfirmModal');
        modal.addEventListener('click', (e) => {
          if (e.target === modal && typeof _closeLogoutModal === 'function') _closeLogoutModal();
        });
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && modal.classList.contains('lco-open') && typeof _closeLogoutModal === 'function') {
            _closeLogoutModal();
          }
        });
      }
    });
  }

  global.initAppSidebar = initAppSidebar;
  global.populateStaffCard = populateStaffCard;
  global.applyAdminShell = applyAdminShell;
  global.getInitials = getInitials;
  global.ADMIN_NAV = ADMIN_NAV;
  global.NURSE_NAV = NURSE_NAV;
})(window);
