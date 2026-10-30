const HOPECARE_VACCINE_CATALOG = [
  { name: 'Abhayrab', type: 'Anti-Rabies Vaccine', category: 'Anti-Rabies Vaccine' },
  { name: 'Vaxirab', type: 'Anti-Rabies Vaccine', category: 'Anti-Rabies Vaccine' },
  { name: 'PCEC', type: 'Anti-Rabies Vaccine', category: 'Anti-Rabies Vaccine' },
  { name: 'PVRV', type: 'Anti-Rabies Vaccine', category: 'Anti-Rabies Vaccine' },
  { name: 'ERIG', type: 'Rabies Immunoglobulin', category: 'Rabies Immunoglobulin' },
  { name: 'HRIG', type: 'Rabies Immunoglobulin', category: 'Rabies Immunoglobulin' },
  { name: 'Berirab', type: 'Rabies Immunoglobulin', category: 'Rabies Immunoglobulin' },
  { name: 'Vinrab', type: 'Rabies Immunoglobulin', category: 'Rabies Immunoglobulin' },
  { name: 'Equirab', type: 'Rabies Immunoglobulin', category: 'Rabies Immunoglobulin' },
  { name: 'Tetanus Toxoid', type: 'Tetanus', category: 'Tetanus' },
  { name: 'ATS', type: 'Other Vaccines', category: 'Other Vaccines' },
  { name: 'HTIG', type: 'Other Vaccines', category: 'Other Vaccines' },
];

const TRANSACTION_TYPES = [
  'Stock In', 'Stock Out', 'Vaccine Usage', 'Adjustment',
  'Transfer', 'Damaged Vaccine', 'Expired Vaccine', 'Returned Vaccine',
  'Initial Opening Balance',
];

function getStockLevel(quantity, lowThreshold, criticalThreshold) {
  const qty = Number(quantity) || 0;
  const low = Number(lowThreshold) || 10;
  const critical = Number(criticalThreshold) || Math.max(1, Math.floor(low * 0.5));
  if (qty <= 0) return { level: 'Out of Stock', color: '#991b1b', class: 'stock-out' };
  if (qty <= critical) return { level: 'Critical Stock', color: '#dc2626', class: 'stock-critical' };
  if (qty <= low) return { level: 'Low Stock', color: '#ea580c', class: 'stock-low' };
  return { level: 'Normal Stock', color: '#16a34a', class: 'stock-normal' };
}

const { toSqlDate, localTodayIso } = require('./dateOnly');

function calendarDaysUntil(from, to) {
  const a = toSqlDate(from);
  const b = toSqlDate(to);
  if (!a || !b) return null;
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

function getExpiryStatus(expiryDate, today = null) {
  const exp = toSqlDate(expiryDate);
  if (!exp) return { status: 'Unknown', days: null, class: 'exp-unknown' };
  const todayIso = toSqlDate(today) || localTodayIso();
  const days = calendarDaysUntil(todayIso, exp);
  if (days == null) return { status: 'Unknown', days: null, class: 'exp-unknown' };
  if (days < 0) return { status: 'Expired', days, class: 'exp-expired' };
  if (days <= 7) return { status: 'Expiring within 7 Days', days, class: 'exp-7' };
  if (days <= 15) return { status: 'Expiring within 15 Days', days, class: 'exp-15' };
  if (days <= 30) return { status: 'Expiring within 30 Days', days, class: 'exp-30' };
  return { status: 'Valid', days, class: 'exp-valid' };
}

module.exports = {
  HOPECARE_VACCINE_CATALOG,
  TRANSACTION_TYPES,
  getStockLevel,
  getExpiryStatus,
};
