'use strict';

const REMINDER_TYPES = {
  ACCOUNT_ACCESS: 'ACCOUNT_ACCESS',
  THREE_DAY: '3_DAYS_BEFORE',
  ONE_DAY: '1_DAY_BEFORE',
  SAME_DAY: 'SAME_DAY',
};

const GSM_SINGLE = 160;
const GSM_CONCAT = 153;

const SMS_BANNER = 'HOPECARE ANIMAL BITE CENTER';

function firstNameOf(fullName) {
  const cleaned = String(fullName || '')
    .split(/HOPECARE/i)[0]
    .split(/\bHello\b/i)[0]
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  return parts[0] || 'Patient';
}

/** "Day 3" → "3" so older copy can say "Dose Day 3" without doubling "Day". */
function formatDoseDay(label) {
  const raw = String(label || '').trim();
  const m = raw.match(/^day\s+(\d+)$/i);
  return m ? m[1] : (raw || '—');
}

/** Display label used in next-dose SMS: "Day 3", "Day 7", or the original text. */
function formatDoseLabel(label) {
  const raw = String(label || '').split(/HOPECARE/i)[0].split(/\bHello\b/i)[0].trim();
  if (!raw) return '—';
  const m = raw.match(/^(?:day\s+)?(\d+)$/i);
  if (m) return `Day ${m[1]}`;
  return raw;
}

function formatSmsDate(iso) {
  if (!iso) return '';
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return s;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

function smsSegmentInfo(text) {
  const chars = String(text || '').length;
  const segments = chars === 0 ? 0 : chars <= GSM_SINGLE ? 1 : Math.ceil(chars / GSM_CONCAT);
  return {
    chars,
    segments,
    multiSegment: segments > 1,
    warning: segments > 1
      ? `This message is ${chars} characters and may use ${segments} SMS segments.`
      : null,
  };
}

/** True when a message carries portal login credentials and must not be sent. */
function smsContainsCredentials(message) {
  const text = String(message || '');
  return /temporary password|password\s*:/i.test(text)
    || /patient portal/i.test(text)
    || /patient id\s*:/i.test(text);
}

/**
 * One vaccination reminder sentence for both automatic and manual sends.
 * patient: { full_name }
 * treatmentCase: current case, accepted so callers pass the same record
 * doseSchedule: { label|doseDay, scheduledDate|dateDue }
 */
function generateVaccinationReminderMessage(patient, treatmentCase, doseSchedule) {
  const schedule = doseSchedule || {};
  const person = patient || {};
  const fullName = person.full_name || person.fullName || person.name;
  const first = firstNameOf(fullName);
  const doseDay = formatDoseLabel(schedule.label || schedule.doseDay || schedule.dose_label);
  const scheduledDate = schedule.scheduledDate || schedule.dateDue || schedule.scheduled_date;
  const dateLabel = formatSmsDate(scheduledDate) || 'your scheduled date';
  const body = `HOPECARE REMIS: Hello ${first}, your next vaccination dose (${doseDay}) is scheduled on ${dateLabel}. Please visit HOPECARE Animal Bite Center for your scheduled treatment.`;
  return smsForPatient(body, fullName);
}

const REMINDER_MARKERS = [
  'HOPECARE REMIS:',
  'HOPECARE Patient Portal:',
  'HopeCare Animal Bite Center',
];

function reminderMarkerHits(text) {
  const hits = [];
  for (const marker of REMINDER_MARKERS) {
    let from = 0;
    while (from < text.length) {
      const at = text.indexOf(marker, from);
      if (at < 0) break;
      hits.push(at);
      from = at + marker.length;
    }
  }
  const remis = /HOPECARE REMIS:?/gi;
  let match;
  while ((match = remis.exec(text))) hits.push(match.index);
  hits.sort((a, b) => a - b);
  return hits.filter((index, position) => position === 0 || index !== hits[position - 1]);
}

function greetingStarts(text) {
  const starts = [];
  const re = /\bHello\s+/gi;
  let match;
  while ((match = re.exec(text))) starts.push(match.index);
  return starts;
}

/**
 * Keep the clinic banner and the first reminder only.
 * A second header, a second greeting, or a repeated copy is removed.
 */
function laterBannerStarts(text) {
  const starts = [];
  let from = 0;
  let seen = false;
  while (from < text.length) {
    const at = text.indexOf(SMS_BANNER, from);
    if (at < 0) break;
    if (seen) starts.push(at);
    seen = true;
    from = at + SMS_BANNER.length;
  }
  return starts;
}

function stripClinicBanner(text) {
  return String(text || '')
    .replace(/(?:^|\n)\s*HOPECARE ANIMAL BITE CENTER\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripSampleFooter(text) {
  return String(text || '')
    .replace(/HOPECARE REMIS:?\s*Hello\s+\S+,\s*your vaccination dose is scheduled[^\n]*/gi, '')
    .replace(/\bHello\s+\S+,\s*your vaccination dose is scheduled[^\n]*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function dropForeignHelloLines(text, fullName) {
  const expected = firstNameOf(fullName).toLowerCase();
  if (!expected || expected === 'patient') return text;
  return String(text || '')
    .split('\n')
    .filter((line) => {
      const match = line.match(/\bHello\s+([A-Za-z][A-Za-z'’-]*)/i);
      return !match || match[1].toLowerCase() === expected;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function keepMatchingPatientBlock(text, fullName) {
  const expected = firstNameOf(fullName).toLowerCase();
  if (!expected || expected === 'patient') return text;
  const names = [...String(text).matchAll(/\bHello\s+([A-Za-z][A-Za-z'’-]*)/gi)];
  if (!names.length) return text;
  const match = names.find((item) => item[1].toLowerCase() === expected);
  if (!match) return '';
  let start = match.index;
  const before = String(text).slice(0, start);
  const remisAt = before.toUpperCase().lastIndexOf('HOPECARE REMIS');
  const portalAt = before.lastIndexOf('HOPECARE Patient Portal:');
  const bannerAt = before.lastIndexOf(SMS_BANNER);
  const afterBanner = bannerAt >= 0 ? before.slice(bannerAt).trim() : '';
  const afterPortal = portalAt >= 0 ? before.slice(portalAt).trim() : '';
  if (bannerAt >= 0 && /^HOPECARE ANIMAL BITE CENTER(?:\s+HOPECARE REMIS:?\s*)?$/i.test(afterBanner)) {
    start = bannerAt;
  } else if (portalAt >= 0 && /^HOPECARE Patient Portal:$/i.test(afterPortal)) {
    start = portalAt;
  } else if (remisAt >= 0) {
    start = remisAt;
  }
  return String(text).slice(start).trim();
}

function singleOutgoingSms(message) {
  let out = stripSampleFooter(String(message || '').replace(/\r\n/g, '\n').trim());
  if (!out) return '';
  const markers = reminderMarkerHits(out);
  const cutPoints = [
    ...(markers.length > 1 ? markers.slice(1) : []),
    ...laterBannerStarts(out),
  ].filter((index) => index > 0);
  if (cutPoints.length) {
    out = out.slice(0, Math.min(...cutPoints)).trim();
  }
  const greetings = greetingStarts(out);
  if (greetings.length > 1) {
    out = out.slice(0, greetings[1]).trim();
  }
  const compact = out.replace(/\s+/g, ' ').trim();
  const mid = Math.floor(compact.length / 2);
  if (mid > 40 && compact.slice(0, mid).trim() === compact.slice(mid).trim()) {
    return compact.slice(0, mid).trim();
  }
  return out;
}

function greetingMatchesPatient(message, fullName) {
  const expected = firstNameOf(fullName).toLowerCase();
  const names = [...String(message).matchAll(/\bHello\s+([A-Za-z][A-Za-z'’-]*)/g)]
    .map((match) => match[1].toLowerCase());
  if (!names.length) return true;
  return names.every((name) => name === expected);
}

/** One outgoing SMS for one patient. Another patient's greeting is not sent. */
function smsForPatient(message, fullName) {
  let cleaned = stripClinicBanner(stripSampleFooter(String(message || '')));
  cleaned = keepMatchingPatientBlock(cleaned, fullName);
  cleaned = dropForeignHelloLines(cleaned, fullName);
  cleaned = stripSampleFooter(cleaned);
  cleaned = singleOutgoingSms(cleaned);
  cleaned = stripClinicBanner(cleaned);
  if (!cleaned || cleaned === SMS_BANNER) return '';
  if (fullName && String(fullName).trim() && !greetingMatchesPatient(cleaned, fullName)) return '';
  return cleaned;
}

/**
 * One HOPECARE REMIS header for a nurse-written message.
 * Extra template headers and a repeated copy are removed.
 */
function formatManualSms(raw) {
  let body = String(raw || '').replace(/\r\n/g, '\n').trim();
  body = body.replace(/^(HOPECARE REMIS:\s*)+/i, '').trim();
  body = singleOutgoingSms(body);
  if (!body) return '';
  return singleOutgoingSms(`HOPECARE REMIS: ${body}`);
}

function draftManualSms({ firstName, scheduledDate }) {
  const name = firstNameOf(firstName);
  const when = formatSmsDate(scheduledDate);
  const visit = when
    ? `Please visit the center on ${when} for your scheduled treatment.`
    : 'Please visit the center for your scheduled treatment.';
  return `HOPECARE REMIS: Hello ${name}, this is a reminder from HOPECARE Animal Bite Center regarding your vaccination schedule. ${visit}`;
}

function buildDoseReminderSms(ctx) {
  return generateVaccinationReminderMessage(
    { full_name: ctx.firstName },
    null,
    { label: ctx.doseDay, scheduledDate: ctx.scheduledDate }
  );
}

function buildSmsContext({
  fullName, patientIdDisplay, portalUrl, clinicContact,
  tempPassword = null, doseDay = null, scheduledDate = null, reminderType,
}) {
  return {
    firstName: firstNameOf(fullName),
    patientIdDisplay,
    portalUrl,
    clinicContact,
    tempPassword: tempPassword || null,
    doseDay: formatDoseLabel(doseDay),
    scheduledDate,
    scheduledDateLabel: formatSmsDate(scheduledDate),
    reminderType,
  };
}

function isDoseReminderType(reminderType) {
  return reminderType === REMINDER_TYPES.THREE_DAY
    || reminderType === REMINDER_TYPES.ONE_DAY
    || reminderType === REMINDER_TYPES.SAME_DAY;
}

function buildSmsMessage(reminderType, rawCtx) {
  if (!isDoseReminderType(reminderType)) {
    throw new Error('SMS is only used for vaccination reminders. Login credentials belong on the Patient Card.');
  }
  const ctx = buildSmsContext({
    ...rawCtx,
    reminderType,
    tempPassword: null,
  });
  const message = smsForPatient(buildDoseReminderSms(ctx), rawCtx.fullName);
  if (smsContainsCredentials(message)) {
    throw new Error('Vaccination reminders must not include a temporary password.');
  }

  const info = smsSegmentInfo(message);
  return { message, ...info, concise: null, conciseUsed: false, ctx };
}

function sanitizeSmsMessage(message, tempPassword) {
  let out = String(message || '');
  if (tempPassword) out = out.split(tempPassword).join('[TEMPORARY PASSWORD]');
  return out;
}

module.exports = {
  REMINDER_TYPES,
  firstNameOf,
  formatDoseDay,
  formatDoseLabel,
  formatSmsDate,
  smsSegmentInfo,
  buildSmsContext,
  buildSmsMessage,
  isDoseReminderType,
  SMS_BANNER,
  singleOutgoingSms,
  smsForPatient,
  generateVaccinationReminderMessage,
  formatManualSms,
  draftManualSms,
  sanitizeSmsMessage,
  smsContainsCredentials,
};
