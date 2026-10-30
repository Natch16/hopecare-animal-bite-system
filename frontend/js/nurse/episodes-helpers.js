/**
 * episodes-helpers.js
 * Pure, DOM-independent helper functions for the Episodes module.
 *
 * Dual-export: available as Node.js module (for testing) and as
 * window.EpHelpers global (for browser use).
 */

'use strict';

// ---------------------------------------------------------------------------
// XSS escaping
// ---------------------------------------------------------------------------

/**
 * Escape a value for safe insertion into innerHTML.
 * Returns empty string for null/undefined.
 * @param {*} v
 * @returns {string}
 */
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

/**
 * Format a date value as "Jan 5, 2025".
 * Returns empty string for null/falsy.
 * @param {string|Date|null|undefined} d
 * @returns {string}
 */
function fmtDate(d) {
  if (!d) return '';
  if (typeof formatDateShort === 'function') return formatDateShort(d, '');
  const iso = String(d).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [y, mo, da] = iso.split('-').map(Number);
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][mo - 1] + ` ${da}, ${y}`;
}

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

/**
 * Human-readable label for type_of_animal code.
 * @param {string} code
 * @returns {string}
 */
function animalLabel(code) {
  const map = {
    D: 'Pet Dog',
    SD: 'Stray Dog',
    C: 'Cat',
    O: 'Other',
  };
  return Object.prototype.hasOwnProperty.call(map, code) ? map[code] : code;
}

/**
 * Human-readable label for type_of_exposure code.
 * @param {string} code
 * @returns {string}
 */
function exposureTypeLabel(code) {
  const map = {
    B: 'Bite',
    NB: 'Non-bite',
    S: 'Scratch',
  };
  return Object.prototype.hasOwnProperty.call(map, code) ? map[code] : code;
}

/**
 * Human-readable label for treatment outcome code.
 * Known codes: C, Inc, N, D.
 * null / undefined / unknown → 'Not recorded'.
 * @param {string|null|undefined} v
 * @returns {string}
 */
function outcomeLabel(v) {
  const map = {
    C: 'Completed',
    Inc: 'Incomplete',
    N: 'None',
    D: 'Died',
  };
  if (v === null || v === undefined) return 'Not recorded';
  if (Object.prototype.hasOwnProperty.call(map, v)) return map[v];
  return 'Not recorded';
}

// ---------------------------------------------------------------------------
// Badge HTML helpers
// ---------------------------------------------------------------------------

/**
 * Returns badge HTML for a treatment status string.
 * @param {string} s
 * @returns {string}
 */
function statusBadge(s) {
  const classMap = {
    Ongoing: 'badge-ongoing',
    Completed: 'badge-completed',
    Overdue: 'badge-overdue',
    Incomplete: 'badge-interrupted',
    'Due Today': 'badge-due-today',
    Upcoming: 'badge-upcoming',
    'Treatment Interrupted': 'badge-interrupted',
    'Schedule Stopped': 'badge-interrupted',
    'Restart Required': 'badge-interrupted',
    'Restart Confirmed': 'badge-ongoing',
  };
  const cls = Object.prototype.hasOwnProperty.call(classMap, s)
    ? classMap[s]
    : 'badge-secondary';
  return `<span class="badge ${esc(cls)}">${esc(s)}</span>`;
}

/**
 * Returns category badge HTML for values 1, 2, or 3.
 * @param {number|string} c
 * @returns {string}
 */
function catBadge(c) {
  return `<span class="badge cat-badge cat${esc(c)}">Category ${esc(c)}</span>`;
}

/**
 * Returns outcome badge HTML using outcomeLabel().
 * @param {string|null|undefined} v
 * @returns {string}
 */
function outcomeBadge(v) {
  const label = outcomeLabel(v);
  const classMap = {
    Completed: 'badge-success',
    Incomplete: 'badge-warning',
    Died: 'badge-danger',
    None: 'badge-secondary',
    'Not recorded': 'badge-light',
  };
  const cls = Object.prototype.hasOwnProperty.call(classMap, label)
    ? classMap[label]
    : 'badge-light';
  return `<span class="badge ${esc(cls)}">${esc(label)}</span>`;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_ROUTES = new Set(['ID', 'IM']);

const BRAND_ERROR = 'Invalid vaccine brand. Use an available Anti-Rabies Vaccine from Vaccine Management (e.g. Abhayrab or Vaxirab).';
const ROUTE_ERROR = 'Invalid route. Only ID and IM are accepted.';

/**
 * Validate a vaccine brand value.
 * Returns null if valid, or an error string otherwise.
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function validateBrand(value) {
  if (window.VaccineCatalog) return window.VaccineCatalog.isValidBrand(value);
  if (value === null || value === undefined) return BRAND_ERROR;
  const trimmed = String(value).trim();
  if (trimmed === '') return BRAND_ERROR;
  if (['Abhayrab', 'Vaxirab'].includes(trimmed)) return null;
  return BRAND_ERROR;
}

/**
 * Validate a route value.
 * Returns null if valid ('ID' or 'IM'), or an error string otherwise.
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function validateRoute(value) {
  if (value === null || value === undefined) return ROUTE_ERROR;
  if (VALID_ROUTES.has(value)) return null;
  return ROUTE_ERROR;
}

// ---------------------------------------------------------------------------
// Case list building
// ---------------------------------------------------------------------------

function pepDaysForCategory(category) {
  const map = {
    '1': [0, 3, 7],
    '2': [0, 3, 7, 14],
    '3': [0, 3, 7, 14, 28],
  };
  return map[String(category)] || [0, 3, 7, 14, 28];
}

/**
 * Join exposures with their linked treatment records and sort by exposure_number.
 * Matches by exposure_id, then falls back to matching numbers so older rows still display.
 */
function buildCaseList(exposures, episodes) {
  const episodeByExposure = {};
  for (const ep of (episodes || [])) {
    if (ep.exposure_id != null && ep.exposure_id !== '') {
      episodeByExposure[String(ep.exposure_id)] = ep;
    }
  }
  return (exposures || [])
    .slice()
    .sort((a, b) => Number(a.exposure_number) - Number(b.exposure_number))
    .map(exp => ({
      exposure: exp,
      episode: episodeByExposure[String(exp.exposure_id)]
        || (episodes || []).find(e => Number(e.episode_number) === Number(exp.exposure_number))
        || null,
    }));
}

// ---------------------------------------------------------------------------
// Legacy flat-record fallback
// ---------------------------------------------------------------------------

/**
 * Synthesise case list from flat patients columns when no sub-records exist.
 *
 * Returns:
 *   null  — if exposures.length > 0 (real data should be used instead)
 *   []    — if exposures is empty AND patient.date_of_exposure is null/falsy
 *   [{exposure, episode}] — one synthetic case object from flat patient columns
 *
 * @param {object} patient  Row from the patients table
 * @param {Array}  exposures  Array from patient_exposures
 * @returns {Array|null}
 */
function getLegacyCases(patient, exposures) {
  if ((exposures || []).length > 0) return null;
  if (!patient || (!patient.date_of_exposure && !patient.vaccine_d0 && !patient.category)) return [];
  return [
    {
      exposure: {
        exposure_number: 1,
        date_of_exposure: patient.date_of_exposure,
        place_of_exposure: patient.place_of_exposure,
        category: patient.category,
        type_of_animal: patient.type_of_animal,
        type_of_exposure: patient.type_of_exposure,
        site_of_exposure: patient.site_of_exposure,
        washing_of_bite: patient.washing_of_bite,
        biting_animal_status: patient.biting_animal_status,
        notes: patient.remarks || patient.notes,
      },
      episode: {
        vaccine_d0: patient.vaccine_d0,
        vaccine_d3: patient.vaccine_d3,
        vaccine_d7: patient.vaccine_d7,
        vaccine_d14: patient.vaccine_d14,
        vaccine_d28: patient.vaccine_d28,
        outcome: patient.outcome,
        brand_name: patient.brand_name,
        route: patient.route,
        rig_date_given: patient.rig_date_given,
        washing_of_bite: patient.washing_of_bite,
        category: patient.category,
        pep_schedule: [],
        rig_records: [],
        tetanus_records: [],
        medication_records: [],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Dual-export
// ---------------------------------------------------------------------------

const EpHelpers = {
  esc,
  fmtDate,
  animalLabel,
  exposureTypeLabel,
  outcomeLabel,
  statusBadge,
  catBadge,
  outcomeBadge,
  validateBrand,
  validateRoute,
  pepDaysForCategory,
  buildCaseList,
  getLegacyCases,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = EpHelpers;
}
if (typeof window !== 'undefined') {
  window.EpHelpers = EpHelpers;
}
