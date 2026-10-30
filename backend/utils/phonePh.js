'use strict';

/**
 * Philippine mobile number helpers for SMS.
 * Accepts 09XXXXXXXXX, 9XXXXXXXXX, +639XXXXXXXXX, 639XXXXXXXXX.
 */

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhMobile(value) {
  let digits = digitsOnly(value);
  if (digits.startsWith('630')) return null;
  if (digits.startsWith('63') && digits.length === 12) digits = digits;
  else if (digits.startsWith('0') && digits.length === 11) digits = `63${digits.slice(1)}`;
  else if (digits.length === 10 && digits.startsWith('9')) digits = `63${digits}`;
  else return null;

  if (!/^639\d{9}$/.test(digits)) return null;
  return digits;
}

function isValidPhMobile(value) {
  return Boolean(normalizePhMobile(value));
}

/** Local display form 09XXXXXXXXX. Accepts 09, 9, 63, and +63 inputs. */
function toLocalPhMobile(value) {
  const intl = normalizePhMobile(value);
  if (!intl) return null;
  return `0${intl.slice(2)}`;
}

function maskPhMobile(value) {
  const n = normalizePhMobile(value) || digitsOnly(value);
  if (!n || n.length < 7) return '***';
  return `${n.slice(0, 4)}****${n.slice(-3)}`;
}

module.exports = { digitsOnly, normalizePhMobile, isValidPhMobile, toLocalPhMobile, maskPhMobile };
