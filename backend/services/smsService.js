'use strict';

/**
 * Common SMS service. Application code should call this module,
 * not a provider implementation directly.
 *
 * REMIS → smsService → iprogSmsService → IPROG SMS REST API
 */
const iprog = require('./iprogSmsService');

async function sendSms(db, opts) {
  return iprog.sendSms(db, opts);
}

module.exports = {
  sendSms,
  parseIprogResponse: iprog.parseIprogResponse,
  classifyIprogFailure: iprog.classifyIprogFailure,
  safeApiError: iprog.safeApiError,
  buildIprogPayload: iprog.buildIprogPayload,
  isOfficialIprogUrl: iprog.isOfficialIprogUrl,
  PROVIDER: iprog.PROVIDER,
};
