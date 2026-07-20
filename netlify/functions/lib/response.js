// Small helpers so every function returns a consistent shape and consistent
// CORS/security headers, instead of each handler building its own response.

const ERROR_STATUS = {
  INVALID_REQUEST: 400,
  UNREADABLE_IMAGE: 422,
  UNSUPPORTED_WORKSHEET: 422,
  VALIDATION_FAILED: 502,
  UPSTREAM_ERROR: 502,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_ERROR: 500,
};

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

function ok(body) {
  return {
    statusCode: 200,
    headers: BASE_HEADERS,
    body: JSON.stringify({ ok: true, ...body }),
  };
}

function fail(code, message) {
  const statusCode = ERROR_STATUS[code] || 500;
  return {
    statusCode,
    headers: BASE_HEADERS,
    body: JSON.stringify({ ok: false, error: { code, message } }),
  };
}

class RequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

module.exports = { ok, fail, RequestError, ERROR_STATUS };
