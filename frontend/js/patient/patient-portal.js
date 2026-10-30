/* =============================================================================
   patient-portal.js  –  HopeCare Animal Bite Center – Patient Portal
   Complete rewrite: fully database-driven via /api/patient/* endpoints
   ============================================================================= */

'use strict';

/* ── Constants ── */
const PP_API = '/api/patient';

/* ── State ── */
let ppState = {
  patient:       null,
  dashboard:     null,
  pep:           [],
  treatment:     null,
  upcoming:      [],
  profile:       null,
  notifications: [],
  cases:         [],
  selectedEpisodeId: null,
};
let ppCurrentSection = 'dashboard';

/* ── Utility helpers ── */
function esc(v) {
  if (v == null) return '—';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtDate(d) {
  if (!d) return '—';
  const s = String(d).trim();
  const iso = /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
  if (iso) {
    const [y, mo, da] = iso.split('-').map(Number);
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][mo - 1] + ` ${da}, ${y}`;
  }
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  const now = new Date();
  const diff = Math.floor((now - dt) / 1000);
  if (diff < 60)   return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return fmtDate(d);
}

function ppInitials(name) {
  if (!name) return 'P';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'P';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function ppAnimalLabel(code) {
  const map = { D: 'Dog', SD: 'Stray Dog', C: 'Cat', M: 'Monkey', B: 'Bat', O: 'Other' };
  if (code == null || code === '') return '—';
  return map[String(code).toUpperCase()] || String(code);
}

function ppStatusBadge(st) {
  const s = String(st || '').toLowerCase();
  let cls = 'pp-status-pending';
  if (s === 'completed') cls = 'pp-status-completed';
  else if (s === 'overdue' || s === 'missed' || s.includes('interrupt')) cls = 'pp-status-missed';
  else if (s === 'upcoming' || s === 'due today' || s === 'due tomorrow' || s === 'ongoing') cls = 'pp-status-upcoming';
  return `<span class="pp-status-badge ${cls}">${esc(st || '—')}</span>`;
}

/* ── API helper ── */
async function ppFetch(path) {
  try {
    const res = await fetch(`${PP_API}/${path}`, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const json = await res.json();
    return json.success ? json.data : null;
  } catch (e) {
    console.error(`ppFetch /${path}:`, e);
    return null;
  }
}

/* ── Auth ── */
async function ppCheckAuth() {
  try {
    const res  = await fetch(`${PP_API}/auth/check`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.loggedIn) { window.location.href = '/patient/patient-login.html'; return null; }
    return data;
  } catch (e) {
    window.location.href = '/patient/patient-login.html';
    return null;
  }
}

async function ppDoLogout() {
  try { await fetch(`${PP_API}/auth/logout`, { method: 'POST' }); } catch (_) {}
  window.location.href = '/patient/patient-login.html';
}

function ppLogout() {
  const m = document.getElementById('ppLogoutModal');
  if (m) m.classList.add('active'); else ppDoLogout();
}

function ppCaseQs() {
  return ppState.selectedEpisodeId
    ? `?episode_id=${encodeURIComponent(ppState.selectedEpisodeId)}`
    : '';
}

function ppSelectedCase() {
  const id = ppState.selectedEpisodeId;
  return (ppState.cases || []).find(c => Number(c.episode_id) === Number(id)) || null;
}

function ppEpisodeStorageKey() {
  const pid = ppState.patient && ppState.patient.patient_id;
  return pid ? `ppSelectedEpisodeId:${pid}` : 'ppSelectedEpisodeId';
}

function ppRememberEpisode(episodeId) {
  if (!episodeId) return;
  try { sessionStorage.setItem(ppEpisodeStorageKey(), String(episodeId)); } catch (_) {}
}

function ppRecallEpisode(cases) {
  try {
    const saved = Number(sessionStorage.getItem(ppEpisodeStorageKey()));
    if (saved && (cases || []).some(c => Number(c.episode_id) === saved)) return saved;
  } catch (_) {}
  return null;
}

/* ── Load all data in parallel ── */
async function ppLoadData() {
  const auth = await ppCheckAuth();
  if (!auth) return false;

  /* seed minimal patient from session first so UI can show name quickly */
  ppState.patient = {
    patient_id:          auth.patient_id,
    registration_number: auth.registration_number,
    full_name:           auth.full_name,
    is_temp_password:    auth.is_temp_password,
  };
  ppUpdateTopBar();

  const cases = await ppFetch('cases');
  ppState.cases = cases || [];
  const owned = (id) => (ppState.cases || []).some(c => Number(c.episode_id) === Number(id));
  const current = (ppState.cases || []).find(c => c.is_current)
    || ppState.cases[ppState.cases.length - 1]
    || null;
  if (ppState.selectedEpisodeId && !owned(ppState.selectedEpisodeId)) {
    ppState.selectedEpisodeId = null;
  }
  if (!ppState.selectedEpisodeId) {
    ppState.selectedEpisodeId = ppRecallEpisode(ppState.cases)
      || (current && current.episode_id)
      || null;
  }
  if (ppState.selectedEpisodeId) ppRememberEpisode(ppState.selectedEpisodeId);

  const qs = ppCaseQs();
  const [me, stats, pep, treatment, upcoming, profile, notifications] = await Promise.all([
    ppFetch('me' + qs),
    ppFetch('dashboard-stats' + qs),
    ppFetch('pep' + qs),
    ppFetch('treatment-progress' + qs),
    ppFetch('upcoming' + qs),
    ppFetch('profile' + qs),
    ppFetch('notifications'),
  ]);

  const keepCases = ppState.cases;
  const keepEp = ppState.selectedEpisodeId;
  ppState = {
    patient:       { ...(ppState.patient), ...(me || {}), ...(profile || {}) },
    dashboard:     stats     || {},
    pep:           pep       || [],
    treatment:     treatment || {},
    upcoming:      upcoming  || [],
    profile:       profile   || {},
    notifications: notifications || [],
    cases:         (stats && stats.cases && stats.cases.length) ? stats.cases : keepCases,
    selectedEpisodeId: keepEp,
  };
  return true;
}

async function ppSelectCase(episodeId) {
  const id = Number(episodeId);
  if (!id) return;
  ppState.selectedEpisodeId = id;
  ppRememberEpisode(id);
  await ppLoadData();
  ppUpdateTopBar();
  ppRenderCaseBar();
  ppRenderSection(ppCurrentSection);
}

function ppIsTempPassword(patient) {
  const v = patient && patient.is_temp_password;
  return v === true || v === 1 || v === '1';
}

/** Shown only while the temporary password is still active. It is not stored, so it disappears after a password change. */
function ppTempPasswordNotice() {
  if (!ppIsTempPassword(ppState.patient)) return null;
  return {
    notif_id: 'temp-password',
    synthetic: true,
    title: 'Temporary Password',
    message: 'You are still using a temporary password. Please change it to a personal password.',
    notification_type: 'temporary-password',
    is_read: 0,
    created_at: null,
  };
}

function ppVisibleNotifications() {
  const stored = ppState.notifications || [];
  const notice = ppTempPasswordNotice();
  return notice ? [notice, ...stored] : stored;
}

function ppShowTempBanner() {
  const el = document.getElementById('ppTempBanner');
  if (!el) return;
  el.hidden = !ppIsTempPassword(ppState.patient);
}

/* ── Top-bar & sidebar UI ── */
function ppUpdateTopBar() {
  const p    = ppState.patient || {};
  const name = p.full_name          || 'Patient';
  const pid  = p.patient_id_display || (p.patient_id ? 'PAT-' + String(p.patient_id).padStart(6,'0') : '—');
  const ini  = ppInitials(name);

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('ppSidebarName',         name);
  set('ppSidebarPatientIdVal', pid);
  set('ppTopRegNo',            pid);

  ['ppUserAvatar', 'ppSidebarAvatar'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = ini;
  });

  /* notification badge, including the temporary-password warning while it is still active */
  const unread = ppVisibleNotifications().filter(n => !n.is_read).length;
  const badge  = document.getElementById('ppNotifBadge');
  if (badge) {
    badge.textContent   = unread > 99 ? '99+' : String(unread);
    badge.style.display = unread > 0  ? 'flex' : 'none';
  }
  ppRenderCaseBar();
  ppShowTempBanner();
}

function ppRenderCaseBar() {
  const el = document.getElementById('ppCaseBar');
  if (!el) return;
  const cases = ppState.cases || [];
  const hideCaseBar = cases.length < 2
    || ppCurrentSection === 'cases'
    || ppCurrentSection === 'profile'
    || ppCurrentSection === 'notifications'
    || ppCurrentSection === 'change-password';
  if (hideCaseBar) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  el.style.display = 'flex';
  const selected = Number(ppState.selectedEpisodeId);
  el.innerHTML = `<span style="font-size:11px;font-weight:800;color:var(--pp-muted);text-transform:uppercase;letter-spacing:.4px;margin-right:4px;">My Cases</span>` +
    cases.map(c => {
      const active = Number(c.episode_id) === selected;
      const cur = c.is_current ? `<span class="pp-case-current">Current</span>` : '';
      return `<button type="button" class="pp-case-chip ${active ? 'active' : ''}" onclick="ppSelectCase(${Number(c.episode_id)})">
        Case ${esc(c.case_number)} ${cur}
      </button>`;
    }).join('');
}

function renderCaseCard(c, isSel) {
  const st = c.treatment_status || '—';
  const loc = c.barangay || c.place_of_exposure || '—';
  const doses = (c.completed_doses != null && c.total_doses != null)
    ? `${c.completed_doses} of ${c.total_doses} doses completed`
    : '—';
  const pct = (c.completed_doses != null && c.total_doses)
    ? Math.max(0, Math.min(100, Math.round((c.completed_doses / c.total_doses) * 100)))
    : 0;
  const outcome = c.outcome ? (c.outcome === 'C' ? 'Completed' : c.outcome) : '—';
  const field = (label, value, icon) => `
    <div class="pp-case-field">
      <span class="pp-case-label"><i class="fa-solid ${icon}"></i> ${esc(label)}</span>
      <span class="pp-case-value">${value}</span>
    </div>`;
  return `<article class="pp-case-card ${isSel ? 'selected' : ''}" onclick="ppSelectCase(${Number(c.episode_id)})">
    <div class="pp-case-card-hd">
      <div class="pp-case-identity">
        <span class="pp-case-kicker">${isSel ? 'Selected case' : 'Case record'}</span>
        <h3>Case ${esc(c.case_number)}</h3>
      </div>
      <div class="pp-case-badges">
        ${c.is_current ? `<span class="pp-status-badge pp-status-upcoming">Current / Active</span>` : ''}
        ${ppStatusBadge(st)}
      </div>
    </div>
    <div class="pp-case-grid">
      ${field('Date of Exposure', esc(fmtDate(c.date_of_exposure)), 'fa-calendar-day')}
      ${field('Barangay / Location', esc(loc), 'fa-location-dot')}
      ${field('Exposure Category', esc(c.category ? 'Category ' + c.category : '—'), 'fa-layer-group')}
      ${field('Biting Animal', esc(ppAnimalLabel(c.type_of_animal)), 'fa-paw')}
      ${field('Status', esc(st), 'fa-clipboard-check')}
      ${field('Outcome', esc(outcome), 'fa-flag')}
      ${field('Next Dose', esc(c.next_dose_label || '—'), 'fa-syringe')}
      ${field('Vaccine', esc(c.brand_name || '—'), 'fa-vial')}
    </div>
    <div class="pp-case-progress">
      <div class="pp-case-progress-hd">
        <span>Vaccination Progress</span>
        <strong>${esc(doses)}</strong>
      </div>
      <div class="pp-progress-bar" aria-hidden="true"><div style="width:${pct}%;"></div></div>
    </div>
    <div class="pp-case-actions">
      <button type="button" class="pp-case-action" onclick="event.stopPropagation(); ppSelectCase(${Number(c.episode_id)}).then(()=>ppSetActiveSection('vaccination'))">
        <i class="fa-solid fa-syringe"></i> Vaccination History
      </button>
      <button type="button" class="pp-case-action" onclick="event.stopPropagation(); ppSelectCase(${Number(c.episode_id)}).then(()=>ppSetActiveSection('treatment'))">
        <i class="fa-solid fa-chart-pie"></i> Treatment Progress
      </button>
      <button type="button" class="pp-case-action" onclick="event.stopPropagation(); ppSelectCase(${Number(c.episode_id)}).then(()=>ppSetActiveSection('schedule'))">
        <i class="fa-solid fa-calendar-check"></i> Upcoming Schedules
      </button>
    </div>
  </article>`;
}

function renderCases() {
  ppUpdateTopBar();
  const el = document.getElementById('ppCasesList');
  if (!el) return;
  const cases = ppState.cases || [];
  if (!cases.length) {
    el.innerHTML = `<div class="pp-empty"><div class="pp-empty-icon">📁</div>No case records found.</div>`;
    return;
  }
  const selectedId = Number(ppState.selectedEpisodeId);
  const selected = cases.find(c => Number(c.episode_id) === selectedId) || cases[cases.length - 1];
  if (selected && Number(ppState.selectedEpisodeId) !== Number(selected.episode_id)) {
    ppState.selectedEpisodeId = selected.episode_id;
    ppRememberEpisode(selected.episode_id);
  }
  const switcher = cases.length > 1
    ? `<div class="pp-cases-switcher" role="tablist" aria-label="Select a case">
        ${cases.map(c => {
          const active = Number(c.episode_id) === Number(selected.episode_id);
          const cur = c.is_current ? `<span class="pp-case-current">Current</span>` : '';
          return `<button type="button" role="tab" aria-selected="${active ? 'true' : 'false'}"
            class="pp-case-chip ${active ? 'active' : ''}"
            onclick="ppSelectCase(${Number(c.episode_id)})">
            Case ${esc(c.case_number)} ${cur}
          </button>`;
        }).join('')}
      </div>
      <p class="pp-cases-showing">Showing records for <strong>Case ${esc(selected.case_number)}</strong> only.</p>`
    : '';
  el.innerHTML = switcher + renderCaseCard(selected, true);
}

/* ── Section navigation ── */
function ppSetActiveSection(sectionId) {
  ppCurrentSection = sectionId;

  document.querySelectorAll('.pp-section').forEach(sec => {
    sec.classList.toggle('active', sec.id === `pp-${sectionId}`);
  });
  document.querySelectorAll('.pp-menu-item').forEach(item => {
    item.classList.toggle('active', item.dataset.section === sectionId);
  });

  /* close sidebar on mobile */
  if (window.innerWidth <= 1024) {
    document.getElementById('ppSidebar')?.classList.remove('open');
    document.getElementById('ppOverlay')?.classList.remove('show');
  }

  ppRenderSection(sectionId);
}

/* Helper function to make stat cards clickable */
function makeStatCardClickable(statId, onClick) {
  const el = document.getElementById(statId);
  if (!el) return;
  
  const card = el.closest('.pp-stat-card');
  if (!card) return;
  
  card.classList.add('pp-stat-card-clickable');
  card.style.cursor = 'pointer';
  
  /* Remove previous click handler */
  card.onclick = null;
  card.onclick = onClick;
}

function ppRenderSection(id) {
  switch (id) {
    case 'dashboard':        return renderDashboard();
    case 'profile':          return renderProfile();
    case 'cases':            return renderCases();
    case 'vaccination':      return renderVaccination();
    case 'treatment':        return renderTreatment();
    case 'schedule':         return renderSchedule();
    case 'notifications':    return renderNotifications();
    case 'change-password':  return renderChangePassword();
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   1. DASHBOARD
   ───────────────────────────────────────────────────────────────────────────── */
function renderDashboard() {
  ppUpdateTopBar();
  ppRenderCaseBar();
  const d = ppState.dashboard || {};
  const p = ppState.patient   || {};
  const name = p.full_name || 'Patient';

  /* greeting */
  const greetEl = document.getElementById('ppHeaderGreeting');
  if (greetEl) {
    const h  = new Date().getHours();
    const gr = h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
    greetEl.textContent = `${gr}, ${name}!`;
  }

  /* welcome status badge */
  const wc = document.getElementById('ppWelcomeStatus');
  if (wc) {
    const st = String(d.treatment_status || '').toLowerCase();
    if (st === 'completed') {
      wc.innerHTML = `<span class="pp-welcome-status" style="background:var(--pp-success-bg);color:var(--pp-success);border:1px solid rgba(34,197,94,.25);">
        <i class="fa-solid fa-circle-check"></i> Vaccination Schedule Complete</span>`;
    } else if (st.includes('interrupted') || st === 'incomplete') {
      wc.innerHTML = `<span class="pp-welcome-status" style="background:#fee2e2;color:#dc2626;border:1px solid rgba(220,38,38,.35);">
        <i class="fa-solid fa-circle-exclamation"></i> Treatment Incomplete</span>`;
    } else if (st === 'overdue') {
      wc.innerHTML = `<span class="pp-welcome-status" style="background:var(--pp-danger-bg);color:var(--pp-danger);border:1px solid rgba(220,38,38,.25);">
        <i class="fa-solid fa-triangle-exclamation"></i> ${esc(d.treatment_status)}</span>`;
    } else {
      wc.innerHTML = `<span class="pp-welcome-status" style="background:var(--pp-warning-bg);color:var(--pp-warning);border:1px solid rgba(234,88,12,.25);">
        <i class="fa-solid fa-syringe"></i> ${esc(d.treatment_status || 'Ongoing')}</span>`;
    }
  }

  /* stat cards */
  const $ = id => document.getElementById(id);
  const remaining = d.remaining_doses != null
    ? d.remaining_doses
    : ((d.total_doses != null && d.completed_doses != null)
      ? Math.max(0, d.total_doses - d.completed_doses)
      : '—');
  const sel = ppSelectedCase();

  if ($('ppStatCase')) $('ppStatCase').textContent = sel
    ? `Case ${sel.case_number}${sel.is_current ? '' : ''}`
    : '—';
  if ($('ppStatBiteDate'))  $('ppStatBiteDate').textContent  = fmtDate((sel && sel.date_of_exposure) || p.date_of_exposure);
  if ($('ppStatDose')) {
    const label = d.current_dose || d.next_dose_label || '';
    const num = String(label).match(/(\d+)/);
    $('ppStatDose').textContent = num ? `D${num[1]}` : (label || '—');
  }
  if ($('ppStatStatus')) {
    const stColor = { completed: 'var(--pp-success)', overdue: 'var(--pp-danger)' };
    const stBg    = { completed: 'var(--pp-success-bg)', overdue: 'var(--pp-danger-bg)' };
    const stLow   = String(d.treatment_status || '').toLowerCase();
    const color   = stColor[stLow] || 'var(--pp-warning)';
    const bg      = stBg[stLow]    || 'var(--pp-warning-bg)';
    $('ppStatStatus').innerHTML = `
      <div class="pp-stat-val" style="font-size:15px;">${esc(d.treatment_status || '—')}</div>
      <span class="pp-stat-sub" style="background:${bg};color:${color};">${esc(d.treatment_status || '—')}</span>`;
  }
  if ($('ppStatCompletion')) $('ppStatCompletion').textContent = `${d.completed_percent ?? 0}%`;
  if ($('ppStatRemaining'))  $('ppStatRemaining').textContent  = remaining;
  if ($('ppStatUpcoming'))   $('ppStatUpcoming').textContent   = fmtDate(d.upcoming_schedule);
  if ($('ppStatDaysLeft'))   $('ppStatDaysLeft').textContent   =
    d.days_remaining != null ? `${d.days_remaining}d` : '—';

  /* Make stat cards clickable */
  makeStatCardClickable('ppStatCase', () => ppSetActiveSection('cases'));
  makeStatCardClickable('ppStatBiteDate', () => ppSetActiveSection('cases'));
  makeStatCardClickable('ppStatDose', () => ppSetActiveSection('vaccination'));
  makeStatCardClickable('ppStatStatus', () => ppSetActiveSection('treatment'));
  makeStatCardClickable('ppStatCompletion', () => ppSetActiveSection('treatment'));
  makeStatCardClickable('ppStatRemaining', () => ppSetActiveSection('vaccination'));
  makeStatCardClickable('ppStatUpcoming', () => ppSetActiveSection('schedule'));
  makeStatCardClickable('ppStatDaysLeft', () => ppSetActiveSection('schedule'));

  renderQuickProgress();
  renderQuickSchedule();
  renderDashboardNotifications();
  renderInterruptedWarning();
}

function renderInterruptedWarning() {
  const d = ppState.dashboard || {};
  const st = String(d.treatment_status || '').toLowerCase();
  let banner = document.getElementById('ppInterruptedBanner');
  const incomplete = st.includes('interrupted') || st === 'incomplete';
  if (!banner && incomplete) {
    const main = document.querySelector('.pp-main-content') || document.querySelector('.pp-content');
    if (main) {
      main.insertAdjacentHTML('afterbegin', `
        <div id="ppInterruptedBanner" class="pp-interrupted-banner" style="background:#fee2e2;border:2px solid #dc2626;border-radius:12px;padding:16px 20px;margin-bottom:18px;color:#991b1b;">
          <strong><i class="fa-solid fa-circle-exclamation"></i> Treatment Incomplete</strong>
          <p style="margin:8px 0 0;line-height:1.5;">${esc(d.interrupted_warning || 'Your treatment has been marked incomplete because a scheduled dose was missed. Please return to HOPECARE Animal Bite Center for assessment and updated vaccination instructions.')}</p>
        </div>`);
    }
  } else if (banner && !incomplete) {
    banner.remove();
  }
}

function renderQuickProgress() {
  const d     = ppState.dashboard || {};
  const pct   = d.completed_percent ?? 0;
  const total = d.total_doses != null ? d.total_doses : 0;
  const done  = d.completed_doses   ?? 0;
  const left  = total - done;
  const circ  = 2 * Math.PI * 75;
  const off   = circ - (pct / 100) * circ;
  const stLow = String(d.treatment_status || '').toLowerCase();
  const stColor = stLow === 'completed' ? 'var(--pp-success)'
                : stLow === 'overdue'   ? 'var(--pp-danger)'
                : 'var(--pp-warning)';

  const html = `
    <div style="text-align:center;font-size:13px;font-weight:800;color:var(--pp-primary);margin-bottom:8px;">
      ${done} of ${total} doses completed
    </div>
    <div class="pp-progress-bar" style="height:10px;background:#e8edf8;border-radius:999px;overflow:hidden;margin:0 8px 12px;">
      <div style="height:100%;width:${Math.max(0, Math.min(100, pct))}%;background:linear-gradient(90deg,#293681,#4274D9,#95CCDD);"></div>
    </div>
    <div class="pp-donut-wrap">
      <div class="pp-donut-container">
        <svg viewBox="0 0 200 200">
          <defs>
            <linearGradient id="ppDonutGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%"   stop-color="#293681"/>
              <stop offset="50%"  stop-color="#4274D9"/>
              <stop offset="100%" stop-color="#95CCDD"/>
            </linearGradient>
          </defs>
          <circle class="pp-donut-track" cx="100" cy="100" r="75"/>
          <circle class="pp-donut-fill"  cx="100" cy="100" r="75"
                  stroke-dasharray="${circ.toFixed(2)}"
                  stroke-dashoffset="${off.toFixed(2)}"/>
        </svg>
        <div class="pp-donut-center">
          <div class="pp-donut-pct">${pct}%</div>
          <div class="pp-donut-lbl">Complete</div>
        </div>
      </div>
    </div>
    <div class="pp-progress-stats">
      <div class="pp-progress-stat">
        <div class="pps-val">${done}</div>
        <div class="pps-lbl">Completed</div>
      </div>
      <div class="pp-progress-stat">
        <div class="pps-val">${left}</div>
        <div class="pps-lbl">Remaining</div>
      </div>
      <div class="pp-progress-stat">
        <div class="pps-val" style="font-size:13px;">${esc(d.current_dose || '—')}</div>
        <div class="pps-lbl">Current Dose</div>
      </div>
      <div class="pp-progress-stat">
        <div class="pps-val" style="font-size:12px;color:${stColor};">${esc(d.treatment_status || '—')}</div>
        <div class="pps-lbl">Status</div>
      </div>
    </div>`;

  const el = document.getElementById('ppQuickProgress');
  if (el) el.innerHTML = html;
}

function renderQuickSchedule() {
  const d    = ppState.dashboard || {};
  const el   = document.getElementById('ppQuickSchedule');
  if (!el) return;
  const st   = String(d.treatment_status || '').toLowerCase();

  if (st === 'completed') {
    el.innerHTML = `
      <div class="pp-schedule-card pp-schedule-complete">
        <div class="pp-schedule-icon"><i class="fa-solid fa-circle-check"></i></div>
        <div class="pp-schedule-label">Vaccination Schedule</div>
        <div class="pp-schedule-date">All Doses Completed</div>
        <div class="pp-schedule-dose" style="background:rgba(255,255,255,.15);border-color:rgba(255,255,255,.3);color:#dcfce7;">
          <i class="fa-solid fa-shield-halved"></i> Full Protection
        </div>
        <div class="pp-schedule-days">Congratulations! You have completed all recommended anti-rabies vaccinations.<br>
          <strong style="color:#bbf7d0;">Stay safe!</strong></div>
      </div>`;
    return;
  }

  if (st === 'incomplete' || st.includes('interrupted')) {
    el.innerHTML = `
      <div class="pp-schedule-card" style="background:#7f1d1d;">
        <div class="pp-schedule-icon"><i class="fa-solid fa-circle-exclamation"></i></div>
        <div class="pp-schedule-label">Vaccination Schedule</div>
        <div class="pp-schedule-date">Stopped</div>
        <div class="pp-schedule-dose" style="background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.25);">
          <i class="fa-solid fa-ban"></i> ${esc(d.missed_dose || 'Missed dose')}
        </div>
        <div class="pp-schedule-days">Your original schedule has been stopped because a scheduled dose was missed. Please return to HOPECARE Animal Bite Center for assessment.</div>
      </div>`;
    return;
  }

  const days = d.days_remaining;
  let daysHtml = 'Check with the clinic for the exact date.';
  if (days === 0)       daysHtml = `<strong style="color:#ffedd5;">Today</strong> — please visit the clinic now!`;
  else if (days === 1)  daysHtml = `<strong>Tomorrow</strong> is your next dose.`;
  else if (days != null && days > 0) daysHtml = `<strong>${days}</strong> day${days !== 1 ? 's' : ''} until your next dose.`;
  else if (days != null && days < 0) daysHtml = `<strong style="color:#fca5a5;">Overdue by ${Math.abs(days)} day${Math.abs(days)!==1?'s':''}!</strong>`;

  el.innerHTML = `
    <div class="pp-schedule-card">
      <div class="pp-schedule-icon"><i class="fa-solid fa-calendar-day"></i></div>
      <div class="pp-schedule-label">Next Vaccination</div>
      <div class="pp-schedule-date">${fmtDate(d.upcoming_schedule)}</div>
      <div class="pp-schedule-dose">
        <i class="fa-solid fa-syringe"></i> ${esc(d.next_dose_label || '—')}
      </div>
      <div class="pp-schedule-days">${daysHtml}</div>
    </div>`;
}

/* Dashboard notifications — shows 5 most recent in the dashboard panel.
   NOTE: The dashboard panel uses id="ppDashboardNotifList" to avoid conflict
   with the full notifications section (id="ppNotifList"). We inject that ID
   into the HTML panel via JS so we don't need to touch the HTML file. */
function renderDashboardNotifications() {
  const el = document.getElementById('ppDashboardNotifList');
  if (!el) return;

  const notifs = ppVisibleNotifications().slice(0, 5);
  if (!notifs.length) {
    el.innerHTML = `<div class="pp-empty"><div class="pp-empty-icon">🔔</div>No notifications yet.</div>`;
    return;
  }
  el.innerHTML = notifs.map(n => buildNotifItem(n, false)).join('');
}

/* ─────────────────────────────────────────────────────────────────────────────
   2. VACCINATION HISTORY
   ───────────────────────────────────────────────────────────────────────────── */
function renderVaccination() {
  ppUpdateTopBar();
  ppRenderCaseBar();
  const sel = ppSelectedCase();
  const pepLbl = document.getElementById('ppPepCaseLabel');
  if (pepLbl) {
    pepLbl.textContent = sel
      ? `Case ${sel.case_number}${sel.is_current ? ' · Current' : ''}`
      : '';
  }

  const pep = ppState.pep || [];
  const pepRows = pep.length
    ? pep.map(r => vaccRow(r)).join('')
    : `<tr><td colspan="6"><div class="pp-empty">
         <div class="pp-empty-icon">💉</div>No vaccination records for this case.</div></td></tr>`;

  const tb = id => document.getElementById(id);
  if (tb('ppPepTbody')) tb('ppPepTbody').innerHTML = pepRows;
}

function vaccRow(r) {
  const given = r.date_given;
  const givenTxt = given ? fmtDate(given) : '—';
  const vaccinator = given ? (r.vaccinated_by || '—') : '—';
  const vaccCell = vaccinator !== '—'
    ? `<i class="fa-solid fa-user-nurse" style="font-size:10px;color:var(--pp-accent);margin-right:4px;"></i>${esc(vaccinator)}`
    : '—';
  const st = r.status || (given ? 'Completed' : 'Pending');
  return `<tr>
    <td style="font-weight:700;color:var(--pp-primary);">${esc(r.day_label || '—')}</td>
    <td>${esc(r.vaccine_brand || '—')}</td>
    <td>${esc(r.route || '—')}</td>
    <td>${fmtDate(r.date_due)}</td>
    <td style="color:${given ? 'var(--pp-success)' : 'var(--pp-muted)'};font-weight:${given ? '700' : '400'};">${esc(givenTxt)}</td>
    <td>${vaccCell}</td>
    <td>${esc(st)}</td>
  </tr>`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   4. TREATMENT PROGRESS
   ───────────────────────────────────────────────────────────────────────────── */
function renderTreatment() {
  ppUpdateTopBar();
  ppRenderCaseBar();
  const el = document.getElementById('ppTreatmentFull');
  if (!el) return;
  const tr  = ppState.treatment || {};
  const pct  = tr.completion_percent ?? 0;
  const done = tr.completed_doses    ?? 0;
  const tot  = tr.total_doses != null ? tr.total_doses : 0;
  const missed = tr.missed_doses ?? 0;
  const left = Math.max(0, tot - done);
  const nd   = tr.next_dose;
  const st   = tr.treatment_status   || '—';
  const stLow = String(st).toLowerCase();
  const stColor = stLow === 'completed' ? 'var(--pp-success)'
                : stLow === 'overdue'   ? 'var(--pp-danger)'
                : 'var(--pp-warning)';
  const stBg    = stLow === 'completed' ? 'var(--pp-success-bg)'
                : stLow === 'overdue'   ? 'var(--pp-danger-bg)'
                : 'var(--pp-warning-bg)';
  const circ    = 2 * Math.PI * 90;
  const off     = circ - (pct / 100) * circ;

  const nextDoseHtml = nd
    ? `<div style="margin-top:20px;padding:14px 18px;background:var(--pp-info-bg);border:1.5px solid rgba(66,116,217,.2);border-radius:12px;text-align:center;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--pp-muted);margin-bottom:4px;">Current / Next Dose</div>
        <div style="font-size:1.15rem;font-weight:800;color:var(--pp-primary);">${esc(nd.label)}</div>
        <div style="font-size:12px;color:var(--pp-muted);margin-top:4px;">${fmtDate(nd.date)}
          ${nd.days_remaining != null ? `&nbsp;·&nbsp; <strong style="color:${stColor};">${nd.days_remaining >= 0 ? `${nd.days_remaining} days away` : `${Math.abs(nd.days_remaining)} days overdue`}</strong>` : ''}</div>
       </div>`
    : '';

  el.innerHTML = `
    <div style="text-align:center;margin-bottom:8px;">
      <div style="font-size:1.25rem;font-weight:800;color:var(--pp-primary);">${done} of ${tot} doses completed</div>
      <div style="font-size:13px;color:var(--pp-muted);margin-top:4px;">${esc(st)}</div>
    </div>
    <div class="pp-progress-bar" style="height:12px;background:#e8edf8;border-radius:999px;overflow:hidden;margin:12px 0 8px;">
      <div style="height:100%;width:${Math.max(0, Math.min(100, pct))}%;background:linear-gradient(90deg,#293681,#4274D9,#95CCDD);"></div>
    </div>
    <div style="display:flex;justify-content:center;padding:12px 0 10px;">
      <div class="pp-donut-container" style="width:230px;height:230px;">
        <svg viewBox="0 0 200 200">
          <defs>
            <linearGradient id="ppTxGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%"   stop-color="#293681"/>
              <stop offset="50%"  stop-color="#4274D9"/>
              <stop offset="100%" stop-color="#95CCDD"/>
            </linearGradient>
          </defs>
          <circle class="pp-donut-track" cx="100" cy="100" r="90" stroke-width="14"/>
          <circle class="pp-donut-fill"  cx="100" cy="100" r="90" stroke-width="14"
                  stroke-dasharray="${circ.toFixed(2)}"
                  stroke-dashoffset="${off.toFixed(2)}"/>
        </svg>
        <div class="pp-donut-center">
          <div class="pp-donut-pct" style="font-size:44px;">${pct}%</div>
          <div class="pp-donut-lbl">Complete</div>
        </div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:18px;">
      <div class="pp-progress-stat">
        <div class="pps-val" style="color:var(--pp-success);">${done}</div>
        <div class="pps-lbl">Completed</div>
      </div>
      <div class="pp-progress-stat">
        <div class="pps-val" style="color:var(--pp-warning);">${left}</div>
        <div class="pps-lbl">Remaining</div>
      </div>
      <div class="pp-progress-stat">
        <div class="pps-val">${tot}</div>
        <div class="pps-lbl">Total Required</div>
      </div>
      <div class="pp-progress-stat">
        <div class="pps-val" style="font-size:13px;color:${stColor};">${esc(st)}</div>
        <div class="pps-lbl">Status</div>
      </div>
    </div>
    ${missed > 0 ? `<div style="margin-top:12px;text-align:center;font-size:13px;color:var(--pp-danger);font-weight:700;">
      ${missed} missed / overdue dose${missed === 1 ? '' : 's'} — please visit the clinic.
    </div>` : ''}
    ${nextDoseHtml}`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   5. UPCOMING SCHEDULE
   ───────────────────────────────────────────────────────────────────────────── */
function renderSchedule() {
  ppUpdateTopBar();
  ppRenderCaseBar();
  const el = document.getElementById('ppScheduleCard');
  if (!el) return;

  const d   = ppState.dashboard  || {};
  const up  = ppState.upcoming   || [];
  const st  = String(d.treatment_status || '').toLowerCase();
  const sel = ppSelectedCase();
  const caseLbl = sel ? `Case ${sel.case_number}${sel.is_current ? ' · Current' : ''}` : '';

  const rows = (up || []).map(item => {
    const badge = ppStatusBadge(item.status || 'Upcoming');
    return `<tr>
      <td style="font-weight:700;color:var(--pp-primary);">${esc(item.day_label || '—')}</td>
      <td>${fmtDate(item.date_due)}</td>
      <td>${esc(item.vaccine_brand || '—')}</td>
      <td>${badge}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="pp-panel">
      <div class="pp-panel-hd">
        <h3><i class="fa-solid fa-list-check"></i> Upcoming Doses</h3>
        <span style="font-size:12px;color:var(--pp-muted);font-weight:700;">${esc(caseLbl)}</span>
      </div>
      <div class="pp-panel-body">
        ${st === 'completed' && !up.length
          ? `<div class="pp-empty"><div class="pp-empty-icon">✅</div>All required doses for this case are completed.</div>`
          : `<div class="pp-vaccine-wrap"><table class="pp-vaccine-table">
              <thead><tr><th>Dose / Day</th><th>Scheduled Date</th><th>Vaccine Name / Brand</th><th>Status</th></tr></thead>
              <tbody>${rows || `<tr><td colspan="4"><div class="pp-empty"><div class="pp-empty-icon">📅</div>No upcoming doses for this case.</div></td></tr>`}</tbody>
            </table></div>`}
      </div>
    </div>`;
}

function buildDaysHtml(days) {
  if (days == null)  return 'Check with the clinic for the exact date.';
  if (days < 0)      return `<strong style="color:#fca5a5;">Overdue by ${Math.abs(days)} day${Math.abs(days)!==1?'s':''}!</strong>`;
  if (days === 0)    return `<strong style="color:#ffedd5;">Due Today — please visit the clinic!</strong>`;
  if (days === 1)    return `<strong>Due Tomorrow.</strong>`;
  return `<strong>${days}</strong> day${days !== 1 ? 's' : ''} remaining.`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   6. PATIENT PROFILE
   ───────────────────────────────────────────────────────────────────────────── */
function renderProfile() {
  ppUpdateTopBar();
  const el = document.getElementById('ppProfileFull');
  if (!el) return;
  const p  = ppState.profile || ppState.patient || {};

  const field = (label, value) => `
    <div class="pp-profile-field">
      <label>${esc(label)}</label>
      <div class="pp-field-val">${esc(value) || '—'}</div>
    </div>`;

  const sex = p.sex === 'M' ? 'Male' : p.sex === 'F' ? 'Female' : (p.sex || '—');

  el.innerHTML = `
    <div class="pp-panel">
      <div class="pp-panel-hd">
        <h3><i class="fa-regular fa-id-card"></i> Personal Information</h3>
      </div>
      <div class="pp-panel-body">
        <div class="pp-profile-grid">
          ${field('Patient ID',  p.patient_id_display || (p.patient_id ? 'PAT-' + String(p.patient_id).padStart(6,'0') : '—'))}
          ${field('Full Name',   p.full_name)}
          ${field('Age',         p.age != null && p.age !== '' ? p.age : '—')}
          ${field('Sex',         sex)}
          ${field('Contact No.', p.contact_number)}
          ${field('Address',     p.address)}
          ${field('Registration No.', p.registration_number)}
          ${field('Date Registered',     fmtDate(p.date_registered))}
        </div>
        <div style="margin-top:18px;padding:12px 16px;background:var(--pp-info-bg);border:1px solid rgba(66,116,217,.18);border-radius:10px;
                    display:flex;align-items:center;gap:10px;">
          <i class="fa-solid fa-circle-info" style="color:var(--pp-accent);font-size:16px;"></i>
          <span style="font-size:12px;color:var(--pp-muted);">
            Use Change Password to update your login. Case and vaccination details are in My Cases.
          </span>
        </div>
      </div>
    </div>`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   7. CHANGE PASSWORD
   ───────────────────────────────────────────────────────────────────────────── */
function renderChangePassword() {
  ppUpdateTopBar();
  const el = document.getElementById('ppChangePwForm');
  if (!el) return;

  el.innerHTML = `
    <div class="pp-change-pw-card">
      <h3><i class="fa-solid fa-key" style="color:var(--pp-accent);margin-right:8px;"></i>Change Password</h3>
      <p>${ppIsTempPassword(ppState.patient)
        ? 'You are using a temporary password. Please set a new personal password to keep your account secure.'
        : 'Use a strong password to keep your account secure.'}</p>

      <div id="ppPwFeedback" style="display:none;margin-bottom:14px;padding:11px 14px;border-radius:10px;font-size:13px;font-weight:500;"></div>

      <form class="pp-pw-form" id="ppPwChangeForm" novalidate>
        <div class="form-group">
          <label for="ppPwCurrent">Current Password</label>
          <div class="pp-input-wrap">
            <input type="password" id="ppPwCurrent" autocomplete="current-password" placeholder="Enter current password">
            <button type="button" class="pp-pw-toggle" onclick="ppTogglePw('ppPwCurrent', this)" tabindex="-1">
              <i class="fa-regular fa-eye"></i>
            </button>
          </div>
        </div>
        <div class="form-group">
          <label for="ppPwNew">New Password</label>
          <div class="pp-input-wrap">
            <input type="password" id="ppPwNew" autocomplete="new-password" placeholder="Min. 8 characters" oninput="ppValidatePwReqs()">
            <button type="button" class="pp-pw-toggle" onclick="ppTogglePw('ppPwNew', this)" tabindex="-1">
              <i class="fa-regular fa-eye"></i>
            </button>
          </div>
        </div>
        <div class="form-group">
          <label for="ppPwConfirm">Confirm New Password</label>
          <div class="pp-input-wrap">
            <input type="password" id="ppPwConfirm" autocomplete="new-password" placeholder="Re-enter new password" oninput="ppValidatePwReqs()">
            <button type="button" class="pp-pw-toggle" onclick="ppTogglePw('ppPwConfirm', this)" tabindex="-1">
              <i class="fa-regular fa-eye"></i>
            </button>
          </div>
        </div>

        <ul class="pp-pw-requirements" id="ppPwReqs">
          <li id="ppPwReqLen"   class="invalid">At least 8 characters</li>
          <li id="ppPwReqMatch" class="invalid">Passwords match</li>
          <li id="ppPwReqDiff"  class="invalid">Different from current password</li>
        </ul>

        <button type="submit" class="pp-btn pp-btn-primary" id="ppPwSubmitBtn">
          <i class="fa-solid fa-lock"></i> Change Password
        </button>
      </form>
    </div>`;

  document.getElementById('ppPwChangeForm').addEventListener('submit', ppHandleChangePw);
}

function ppTogglePw(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  const isHidden = inp.type === 'password';
  inp.type = isHidden ? 'text' : 'password';
  const icon = btn.querySelector('i');
  if (icon) {
    icon.className = isHidden ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
  }
}

function ppValidatePwReqs() {
  const current = document.getElementById('ppPwCurrent')?.value || '';
  const np      = document.getElementById('ppPwNew')?.value     || '';
  const cp      = document.getElementById('ppPwConfirm')?.value || '';

  const setReq = (id, ok) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('invalid', !ok);
  };
  setReq('ppPwReqLen',   np.length >= 8);
  setReq('ppPwReqMatch', np.length > 0 && np === cp);
  setReq('ppPwReqDiff',  np.length > 0 && np !== current);
}

async function ppHandleChangePw(e) {
  e.preventDefault();
  const current = document.getElementById('ppPwCurrent')?.value  || '';
  const np      = document.getElementById('ppPwNew')?.value      || '';
  const cp      = document.getElementById('ppPwConfirm')?.value  || '';
  const btn     = document.getElementById('ppPwSubmitBtn');
  const fb      = document.getElementById('ppPwFeedback');

  const showMsg = (msg, ok) => {
    fb.textContent     = msg;
    fb.style.display   = 'block';
    fb.style.background = ok ? 'var(--pp-success-bg)' : 'var(--pp-danger-bg)';
    fb.style.color      = ok ? 'var(--pp-success)'    : 'var(--pp-danger)';
    fb.style.border     = ok
      ? '1px solid rgba(34,197,94,.25)' : '1px solid rgba(220,38,38,.25)';
  };

  if (!current || !np || !cp) { showMsg('Please fill in all fields.', false); return; }
  if (np.length < 8)           { showMsg('New password must be at least 8 characters.', false); return; }
  if (np !== cp)                { showMsg('New passwords do not match.', false); return; }
  if (np === current)           { showMsg('New password must be different from the current password.', false); return; }

  btn.disabled     = true;
  btn.innerHTML    = '<i class="fa-solid fa-spinner fa-spin"></i> Changing…';
  fb.style.display = 'none';

  try {
    const res  = await fetch(`${PP_API}/auth/change-password`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body:    JSON.stringify({ current_password: current, new_password: np }),
    });
    const data = await res.json();
    if (data.success) {
      if (ppState.patient) ppState.patient.is_temp_password = false;
      ppShowTempBanner();
      ppUpdateTopBar();
      showMsg('Password changed successfully! Redirecting to login…', true);
      btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Success!';
      setTimeout(() => { window.location.href = '/patient/patient-login.html'; }, 1500);
    } else {
      showMsg(data.message || 'Failed to change password.', false);
      btn.disabled  = false;
      btn.innerHTML = '<i class="fa-solid fa-lock"></i> Change Password';
    }
  } catch (err) {
    showMsg('Network error. Please try again.', false);
    btn.disabled  = false;
    btn.innerHTML = '<i class="fa-solid fa-lock"></i> Change Password';
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   8. NOTIFICATIONS
   ───────────────────────────────────────────────────────────────────────────── */
function renderNotifications() {
  ppUpdateTopBar();
  const el = document.getElementById('ppNotifList');
  if (!el) return;

  /* Inject "Mark All as Read" button before the list if not already there */
  const panel = el.closest('.pp-panel');
  if (panel) {
    const hd = panel.querySelector('.pp-panel-hd');
    if (hd && !hd.querySelector('#ppMarkAllBtn')) {
      const btn = document.createElement('button');
      btn.id        = 'ppMarkAllBtn';
      btn.className = 'pp-action-btn';
      btn.innerHTML = '<i class="fa-solid fa-check-double"></i> Mark All Read';
      btn.onclick   = ppMarkAllRead;
      hd.appendChild(btn);
    }
  }

  ppRenderNotifList();
}

function ppRenderNotifList() {
  const el     = document.getElementById('ppNotifList');
  if (!el) return;
  const notifs = ppVisibleNotifications();

  if (!notifs.length) {
    el.innerHTML = `<div class="pp-empty"><div class="pp-empty-icon">🔔</div>No notifications yet.</div>`;
    return;
  }
  el.innerHTML = notifs.map(n => buildNotifItem(n, true)).join('');
}

function notifIcon(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('temporary')) return { cls: 'warning', icon: 'fa-solid fa-key' };
  if (t.includes('upcoming') || t.includes('calendar')) return { cls: '', icon: 'fa-regular fa-calendar-check' };
  if (t.includes('missed')   || t.includes('overdue'))  return { cls: 'warning', icon: 'fa-solid fa-triangle-exclamation' };
  if (t.includes('completed')|| t.includes('complete')) return { cls: 'success', icon: 'fa-solid fa-circle-check' };
  if (t.includes('booster'))                            return { cls: '', icon: 'fa-solid fa-syringe' };
  return { cls: '', icon: 'fa-regular fa-bell' };
}

function buildNotifItem(n, showMarkRead) {
  const unread = !n.is_read;
  const ic     = notifIcon(n.notification_type || n.title || '');
  const action = n.synthetic
    ? `<button class="pp-notif-markread" type="button" onclick="ppSetActiveSection('change-password')">Change password</button>`
    : ((showMarkRead && unread)
      ? `<button class="pp-notif-markread" onclick="ppMarkRead(${n.notif_id})">Mark as read</button>`
      : '');
  const when = n.synthetic ? 'Action needed' : fmtTime(n.created_at);
  return `
    <div class="pp-notif-item ${unread ? 'unread' : ''}" id="ppNotif-${n.notif_id}">
      <div class="pp-notif-icon ${ic.cls}"><i class="${ic.icon}"></i></div>
      <div class="pp-notif-content">
        <div class="pp-notif-title">${esc(n.title || 'Notification')}</div>
        <div class="pp-notif-message">${esc(n.message || '')}</div>
        <div class="pp-notif-meta">
          <span class="pp-notif-time">${esc(when)}</span>
          ${action}
        </div>
      </div>
    </div>`;
}

async function ppMarkRead(notifId) {
  try {
    const res = await fetch(`${PP_API}/notifications/${notifId}/read`, { method: 'POST' });
    if (!res.ok) return;
    const n = ppState.notifications.find(n => n.notif_id == notifId);
    if (n) n.is_read = 1;
    ppRenderNotifList();
    ppUpdateTopBar();
  } catch (e) {
    console.error('Mark read error:', e);
  }
}

async function ppMarkAllRead() {
  try {
    const res = await fetch(`${PP_API}/notifications/read-all`, { method: 'POST' });
    if (!res.ok) return;
    (ppState.notifications || []).forEach(n => { n.is_read = 1; });
    ppRenderNotifList();
    ppUpdateTopBar();
  } catch (e) {
    console.error('Mark all read error:', e);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   9. SIDEBAR / MOBILE / KEYBOARD
   ───────────────────────────────────────────────────────────────────────────── */
function ppInitSidebarToggle() {
  const hamburger = document.getElementById('ppHamburger');
  const sidebar   = document.getElementById('ppSidebar');
  const overlay   = document.getElementById('ppOverlay');

  if (hamburger && sidebar && overlay) {
    hamburger.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      overlay.classList.toggle('show');
    });
    overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('show');
    });
  }

  /* notification bell → go to notifications section */
  const bell = document.getElementById('ppNotifBell');
  if (bell) bell.addEventListener('click', () => ppSetActiveSection('notifications'));

  /* sidebar menu items */
  document.querySelectorAll('.pp-menu-item[data-section]').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      ppSetActiveSection(item.dataset.section);
    });
  });

  /* logout modal */
  document.getElementById('ppLogoutCancel')?.addEventListener('click',  ppCloseLogoutModal);
  document.getElementById('ppLogoutCloseX')?.addEventListener('click',  ppCloseLogoutModal);
  document.getElementById('ppLogoutConfirm')?.addEventListener('click', ppConfirmLogout);

  /* Escape key */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    /* close logout modal */
    const modal = document.getElementById('ppLogoutModal');
    if (modal && modal.classList.contains('active')) { ppCloseLogoutModal(); return; }
    /* close sidebar */
    document.getElementById('ppSidebar')?.classList.remove('open');
    document.getElementById('ppOverlay')?.classList.remove('show');
  });
}

function ppCloseLogoutModal() {
  document.getElementById('ppLogoutModal')?.classList.remove('active');
}

function ppConfirmLogout() {
  const btn = document.getElementById('ppLogoutConfirm');
  if (btn) {
    btn.disabled   = true;
    btn.innerHTML  = '<i class="fa-solid fa-spinner fa-spin"></i> Signing out…';
  }
  ppDoLogout();
}

/* ─────────────────────────────────────────────────────────────────────────────
   10. BOOTSTRAP
   ───────────────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  ppInitSidebarToggle();

  /* show a loading state in main while fetching */
  const main = document.querySelector('.pp-main');
  /* no full overlay needed — individual sections show "Loading…" placeholders */

  const ok = await ppLoadData();
  if (!ok) return; /* redirect already handled */

  ppUpdateTopBar();
  ppRenderCaseBar();
  if (ppIsTempPassword(ppState.patient)) ppSetActiveSection('change-password');
  else ppRenderSection(ppCurrentSection);
});
