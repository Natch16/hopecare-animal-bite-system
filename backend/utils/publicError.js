'use strict';

const TECHNICAL = /localhost|127\.0\.0\.1|0\.0\.0\.0|:\d{2,5}\/|Column '|ER_[A-Z_]+|SQL|sqlMessage|ECONNREFUSED|ECONNRESET|ENOTFOUND|cannot be null|Duplicate entry|stack:|at Object\.|mysql|sqlite|ENOENT|TypeError|ReferenceError|Unexpected token/i;

function isTechnicalMessage(message) {
  const text = String(message || '');
  if (!text.trim()) return true;
  if (text.length > 220) return true;
  return TECHNICAL.test(text);
}

function publicInventoryError(err, fallback) {
  const status = Number(err && (err.status || err.statusCode)) || 500;
  const raw = String((err && err.message) || '').trim();
  const safeFallback = fallback || (
    status === 401 ? 'Please sign in again to continue.'
      : status === 403 ? 'You do not have permission to complete this action.'
        : status === 400 || status === 409 || status === 422
          ? 'Please review the inventory values before saving.'
          : 'The system is temporarily unavailable. Please try again later.'
  );
  if (status >= 500 || isTechnicalMessage(raw)) {
    return { status: status >= 400 ? status : 500, message: safeFallback };
  }
  return { status, message: raw };
}

function sendPublicInventoryError(res, err, fallback) {
  console.error(err);
  const out = publicInventoryError(err, fallback);
  return res.status(out.status).json({ success: false, message: out.message });
}

module.exports = {
  isTechnicalMessage,
  publicInventoryError,
  sendPublicInventoryError,
};
