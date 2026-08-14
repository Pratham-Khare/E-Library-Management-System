/**
 * The one error type services and controllers throw. The central error handler
 * recognises it and turns it into a clean response; anything else it catches
 * becomes a generic 500, because an unrecognised error might carry internals
 */

import { HTTP_STATUS, HTTP_STATUS_TEXT } from '../constants/httpStatus.js';
import { ERROR_CODES } from '../constants/errorCodes.js';

export class ApiError extends Error {
  /**
   */
  constructor(statusCode, message, code = ERROR_CODES.INTERNAL_ERROR, options = {}) {
    super(message || HTTP_STATUS_TEXT[statusCode] || 'Error');

    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.errors = options.errors ?? [];
    this.details = options.details ?? null;

    /**
     * Operational errors are the expected ones — a missing book, a bad
     * password, an exhausted quota. Their messages are written for users and
     * are safe to return verbatim.
     */
    this.isOperational = true;
    this.expose = options.expose ?? statusCode < 500;

    // Preserve the original error for the logs without exposing it.
    if (options.cause) this.cause = options.cause;

    // Omit the constructor frame so the stack points at the real throw site.
    Error.captureStackTrace?.(this, this.constructor);
  }

  /* ---------------------------------------------------------------------
   * 4xx factories
   * ------------------------------------------------------------------ */

  /** 400 — the request is malformed or nonsensical. */
  static badRequest(message = 'Bad request', code = ERROR_CODES.BAD_REQUEST, options = {}) {
    return new ApiError(HTTP_STATUS.BAD_REQUEST, message, code, options);
  }

  /** 401 — no credentials, or credentials that are not valid. "Who are you?" */
  static unauthorized(
    message = 'Authentication required',
    code = ERROR_CODES.MISSING_TOKEN,
    options = {}
  ) {
    return new ApiError(HTTP_STATUS.UNAUTHORIZED, message, code, options);
  }

  /** 403 — authenticated, but not allowed. "I know who you are, still no." */
  static forbidden(
    message = 'You do not have permission to perform this action',
    code = ERROR_CODES.INSUFFICIENT_ROLE,
    options = {}
  ) {
    return new ApiError(HTTP_STATUS.FORBIDDEN, message, code, options);
  }

  /** 404 — no such resource. */
  static notFound(message = 'Resource not found', code = ERROR_CODES.NOT_FOUND, options = {}) {
    return new ApiError(HTTP_STATUS.NOT_FOUND, message, code, options);
  }

  /**
   * 409 — valid request, wrong current state. The workhorse of circulation:
   * borrowing a book whose copies are all out is not a client mistake, it is
   * a conflict with reality.
   */
  static conflict(message = 'Request conflicts with the current state', code = ERROR_CODES.CONFLICT, options = {}) {
    return new ApiError(HTTP_STATUS.CONFLICT, message, code, options);
  }

  /** 413 — upload exceeds the configured size cap. */
  static payloadTooLarge(message = 'File is too large', code = ERROR_CODES.FILE_TOO_LARGE, options = {}) {
    return new ApiError(HTTP_STATUS.PAYLOAD_TOO_LARGE, message, code, options);
  }

  /** 415 — file type not allowed, or its signature contradicts its declared type. */
  static unsupportedMediaType(
    message = 'Unsupported file type',
    code = ERROR_CODES.UNSUPPORTED_FILE_TYPE,
    options = {}
  ) {
    return new ApiError(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE, message, code, options);
  }

  /** 416 — an unsatisfiable Range header on a file download. */
  static rangeNotSatisfiable(message = 'Requested range is not satisfiable', options = {}) {
    return new ApiError(
      HTTP_STATUS.RANGE_NOT_SATISFIABLE,
      message,
      ERROR_CODES.INVALID_RANGE,
      options
    );
  }

  /**
   * 422 — syntactically fine, semantically invalid. The standard response to a
   * schema-validation failure; `errors[]` names each offending field.
   */
  static validation(
    message = 'Validation failed',
    errors = [],
    code = ERROR_CODES.VALIDATION_ERROR
  ) {
    return new ApiError(HTTP_STATUS.UNPROCESSABLE_ENTITY, message, code, { errors });
  }

  /** 429 — rate limit tripped, or the AI quota is spent. */
  static tooManyRequests(
    message = 'Too many requests',
    code = ERROR_CODES.RATE_LIMIT_EXCEEDED,
    options = {}
  ) {
    return new ApiError(HTTP_STATUS.TOO_MANY_REQUESTS, message, code, options);
  }

  /* ---------------------------------------------------------------------
   * 5xx factories
   * ------------------------------------------------------------------ */

  /** 500 — an actual bug. The message is replaced before it reaches a client. */
  static internal(message = 'Something went wrong', options = {}) {
    const error = new ApiError(
      HTTP_STATUS.INTERNAL_SERVER_ERROR,
      message,
      ERROR_CODES.INTERNAL_ERROR,
      { ...options, expose: false }
    );
    error.isOperational = false;
    return error;
  }

  /** 501 — the route exists, but the feature is switched off in config. */
  static notImplemented(
    message = 'This feature is currently disabled',
    code = ERROR_CODES.FEATURE_DISABLED,
    options = {}
  ) {
    return new ApiError(HTTP_STATUS.NOT_IMPLEMENTED, message, code, options);
  }

  /** 502 — an upstream dependency (AI provider, SendGrid) failed. */
  static badGateway(
    message = 'An upstream service failed',
    code = ERROR_CODES.SERVICE_UNAVAILABLE,
    options = {}
  ) {
    return new ApiError(HTTP_STATUS.BAD_GATEWAY, message, code, options);
  }

  /** 503 — temporarily unable to serve. Database down, or AI down with no cache. */
  static serviceUnavailable(
    message = 'Service temporarily unavailable',
    code = ERROR_CODES.SERVICE_UNAVAILABLE,
    options = {}
  ) {
    return new ApiError(HTTP_STATUS.SERVICE_UNAVAILABLE, message, code, options);
  }

  /** 504 — an upstream dependency took too long. */
  static gatewayTimeout(
    message = 'An upstream service timed out',
    code = ERROR_CODES.AI_TIMEOUT,
    options = {}
  ) {
    return new ApiError(HTTP_STATUS.GATEWAY_TIMEOUT, message, code, options);
  }

  /* ---------------------------------------------------------------------
   * Serialisation
   * ------------------------------------------------------------------ */

  /**
   * The response body. `requestId` ties the client's error to the exact server
   * log entry, which turns "it broke" into a one-query investigation.
   */
  toJSON(requestId) {
    const body = {
      success: false,
      message: this.expose ? this.message : 'Something went wrong on our end',
      code: this.code,
    };

    if (this.errors.length > 0) body.errors = this.errors;
    if (this.details) body.details = this.details;
    if (requestId) body.requestId = requestId;

    return body;
  }
}

/** True for a genuine ApiError instance. */
export const isApiError = (error) => error instanceof ApiError;

export default ApiError;
