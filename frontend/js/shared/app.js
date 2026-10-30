const API_BASE = '/api';

async function checkAuth() {
  try {
    if (typeof RBAC !== 'undefined') {
      return await RBAC.initRBAC();
    }
    const response = await fetch(`${API_BASE}/auth/check`);
    const data = await response.json();
    if (!data.loggedIn && !window.location.pathname.includes('login')) {
      window.location.href = '/shared/login.html';
    }
    return data;
  } catch (error) {
    console.error('Auth check error:', error);
    if (!window.location.pathname.includes('login')) {
      window.location.href = '/shared/login.html';
    }
  }
}

async function _doLogout() {
  try {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST' });
    window.location.href = '/shared/login.html';
  } catch (error) {
    console.error('Logout error:', error);
    window.location.href = '/shared/login.html';
  }
}

// Opens the confirmation dialog instead of logging out immediately
function logout() {
  const modal = document.getElementById('logoutConfirmModal');
  if (modal) {
    modal.classList.add('lco-open');
    // Focus the Cancel button for keyboard accessibility
    setTimeout(() => {
      const cancel = modal.querySelector('.lco-btn-cancel');
      if (cancel) cancel.focus();
    }, 120);
  } else {
    // Fallback — modal not in DOM yet, proceed directly
    _doLogout();
  }
}

function _closeLogoutModal() {
  const modal = document.getElementById('logoutConfirmModal');
  if (modal) modal.classList.remove('lco-open');
}

function _confirmLogout() {
  const modal = document.getElementById('logoutConfirmModal');
  if (!modal) return;

  // Prevent double-clicks
  const btn = modal.querySelector('.lco-btn-confirm');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="lco-spinner"></span> Signing out…';

  _doLogout();
}

function showAlert(message, type = 'success') {
  const alertDiv = document.createElement('div');
  alertDiv.className = `alert alert-${type}`;
  alertDiv.textContent = message;
  
  const container = document.querySelector('.main-content') || document.querySelector('.login-card');
  container.insertBefore(alertDiv, container.firstChild);
  
  setTimeout(() => alertDiv.remove(), 3000);
}

function openModal(modalId) {
  document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
}

function dateOnlyIso(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date && !isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2} /.test(s)) return s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const dt = new Date(s);
    if (isNaN(dt.getTime())) return '';
    if (dt.getUTCHours() === 0 && dt.getUTCMinutes() === 0 && dt.getUTCSeconds() === 0) {
      return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    }
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function formatDate(dateString) {
  const iso = dateOnlyIso(dateString);
  if (!iso) return dateString ? String(dateString) : '-';
  const [y, mo, d] = iso.split('-').map(Number);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[mo - 1]} ${d}, ${y}`;
}

function formatDateShort(dateString, empty) {
  const iso = dateOnlyIso(dateString);
  if (!iso) return empty != null ? empty : '—';
  const [y, mo, d] = iso.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[mo - 1]} ${d}, ${y}`;
}

function toInputDate(dateString) {
  return dateOnlyIso(dateString) || '';
}

function dateOnlyLocal(value) {
  const iso = dateOnlyIso(value);
  if (!iso) return null;
  const [y, mo, d] = iso.split('-').map(Number);
  return new Date(y, mo - 1, d);
}

function todayDateOnlyIso() {
  return dateOnlyIso(new Date());
}
