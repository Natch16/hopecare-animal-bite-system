'use strict';

const { toLocalPhMobile } = require('./phonePh');

const CONTACT_MESSAGE =
  'Invalid contact number. Please enter a valid 11-digit Philippine mobile number (e.g., 09123456789).';
const AGE_MESSAGE = 'Please enter a valid age between 0 and 120.';

function validatePatientAge(age) {
  if (age == null || String(age).trim() === '') {
    return { ok: false, field: 'age', message: AGE_MESSAGE };
  }
  const raw = String(age).trim();
  if (!/^\d+$/.test(raw)) {
    return { ok: false, field: 'age', message: AGE_MESSAGE };
  }
  const years = Number(raw);
  if (!Number.isInteger(years) || years < 0 || years > 120) {
    return { ok: false, field: 'age', message: AGE_MESSAGE };
  }
  return { ok: true, age: years };
}

function validatePatientContact(value) {
  if (value == null || String(value).trim() === '') {
    return { ok: false, field: 'contact_number', message: CONTACT_MESSAGE };
  }
  const contact = toLocalPhMobile(value);
  if (!contact || !/^09\d{9}$/.test(contact)) {
    return { ok: false, field: 'contact_number', message: CONTACT_MESSAGE };
  }
  return { ok: true, contact_number: contact };
}

function validatePatientIdentity(body) {
  const age = validatePatientAge(body && body.age);
  if (!age.ok) return age;
  const contact = validatePatientContact(body && body.contact_number);
  if (!contact.ok) return contact;
  return { ok: true, age: age.age, contact_number: contact.contact_number };
}

module.exports = {
  CONTACT_MESSAGE,
  AGE_MESSAGE,
  validatePatientAge,
  validatePatientContact,
  validatePatientIdentity,
};
