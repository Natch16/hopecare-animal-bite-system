const { normalizeRole, ROLES } = require('./permissions');

function generatePatientId(id) {
  return 'PAT-' + String(id).padStart(6, '0');
}

function generateStaffId(id, role) {
  // Always use STF- prefix with 6-digit zero-padding for display.
  // Role-based prefixes (ADM/NUR) are kept for internal use via staffIdWithRole().
  return 'STF-' + String(id).padStart(6, '0');
}

function generateStaffIdWithRole(id, role) {
  const r = normalizeRole(role);
  const prefix = r === ROLES.ADMINISTRATOR ? 'ADM' : 'NUR';
  return `${prefix}-${String(id).padStart(4, '0')}`;
}

function parsePatientIdDisplay(display) {
  if (display == null) return null;
  const cleaned = String(display)
    .trim()
    .toUpperCase()
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, '');
  if (!cleaned) return null;
  const prefixed = cleaned.match(/^PAT-?(\d+)$/);
  if (prefixed) return parseInt(prefixed[1], 10);
  if (/^\d+$/.test(cleaned)) return parseInt(cleaned, 10);
  return null;
}

function paddedPatientSerial(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 0) return null;
  return String(n).padStart(6, '0');
}

function parseStaffIdDisplay(display) {
  if (!display || typeof display !== 'string') return null;
  const trimmed = display.trim().toUpperCase();
  let m = trimmed.match(/^(?:ADM|NUR|STF)-(\d+)$/);
  if (m) return parseInt(m[1], 10);
  return null;
}

function staffIdWithRole(row) {
  if (!row) return null;
  const id = row.staff_id ?? row.id;
  const role = row.role || row.designation;
  return generateStaffId(id, role);
}

module.exports = {
  generatePatientId,
  generateStaffId,
  generateStaffIdWithRole,
  parsePatientIdDisplay,
  paddedPatientSerial,
  parseStaffIdDisplay,
  staffIdWithRole,
};
