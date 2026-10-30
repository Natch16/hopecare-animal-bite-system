function getCurrentShift(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 6 && hour < 14) return 'Morning Shift';
  return 'Afternoon Shift';
}

function normalizeShift(shift) {
  if (shift == null || shift === '') return getCurrentShift();
  const s = String(shift).toLowerCase().trim();
  if (s === 'all' || s === 'both') return getCurrentShift();
  if (s.includes('morning') || s === 'am') return 'Morning Shift';
  if (s.includes('afternoon') || s.includes('evening') || s === 'pm') return 'Afternoon Shift';
  return getCurrentShift();
}

/** Returns null for All / empty; otherwise Morning Shift or Afternoon Shift. */
function parseShiftQuery(shift) {
  if (shift == null || shift === '') return null;
  const s = String(shift).toLowerCase().trim();
  if (s === 'all' || s === 'both' || s === 'daily' || s === 'daily sheet' || s === 'sheet') return null;
  return normalizeShift(shift);
}

module.exports = { getCurrentShift, normalizeShift, parseShiftQuery };
