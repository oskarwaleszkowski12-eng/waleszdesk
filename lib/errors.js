'use strict';
// Standard error codes returned to clients. Frontend maps these to user-facing
// Polish messages (see js/errorMessages.js). Keep keys SCREAMING_SNAKE_CASE.

const CODES = {
  // auth
  INVALID_PASSWORD:    'Invalid password',
  TOTP_REQUIRED:       'TOTP code required',
  INVALID_TOTP:        'Invalid TOTP code',
  UNAUTHORIZED:        'Unauthorized',
  FORBIDDEN:           'Forbidden',

  // validation
  VALIDATION_FAILED:   'Validation failed',
  MISSING_FIELD:       'Required field missing',

  // resources
  NOT_FOUND:           'Resource not found',
  ALREADY_EXISTS:      'Resource already exists',
  CONFLICT:            'Conflict',

  // trading / exchange
  INSUFFICIENT_BALANCE:  'Insufficient balance',
  INVALID_KEYS:          'Invalid exchange API keys',
  EXCHANGE_REJECTED:     'Exchange rejected the request',
  EXCHANGE_TIMEOUT:      'Exchange request timed out',
  MIN_CAPITAL:           'Allocated capital below template minimum',
  MAX_CAPITAL:           'Allocated capital exceeds 50% of balance',
  UID_REGISTERED:        'This exchange UID is already registered',

  // invite
  INVALID_INVITE:        'Invalid or already used invite code',

  // rate limit / spam
  RATE_LIMITED:          'Too many requests',

  // generic
  INTERNAL:              'Internal server error',
};

function err(code, message, extra = {}) {
  return { ok: false, errorCode: code, error: message || CODES[code] || 'Error', ...extra };
}

function ok(extra = {}) {
  return { ok: true, ...extra };
}

module.exports = { CODES, err, ok };
