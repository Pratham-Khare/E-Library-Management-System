/**
 * The last middleware in the chain, and the ONLY place that formats an error
 * response. Everything else throws; this decides what the client sees.
 */

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { ZodError } from 'zod';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { ERROR_CODES } from '../constants/errorCodes.js';

/* Translators — each converts a library-specific error into an ApiError */

/**
 * Mongoose schema validation. Collapses `error.errors` — a map of path to
 * ValidatorError — into the flat `[{ field, message }]` shape used everywhere
 * else, so a client handles validation failures identically whether they came
 * from Zod or from the database layer.
 */
const fromMongooseValidation = (error) => {
  const errors = Object.values(error.errors ?? {}).map((detail) => ({
    field: detail.path,
    message: detail.message,
  }));
  return ApiError.validation('The submitted data is not valid', errors);
};

/**
 * A malformed ObjectId. `GET /books/not-an-id` should be a clean 400 naming
 * the offending parameter, not a 500.
 */
const fromCastError = (error) => {
  if (error.kind === 'ObjectId') {
    return ApiError.badRequest(
      `'${error.value}' is not a valid identifier`,
      ERROR_CODES.INVALID_ID,
      { errors: [{ field: error.path, message: 'must be a valid MongoDB ObjectId' }] }
    );
  }
  return ApiError.badRequest(
    `Invalid value for '${error.path}'`,
    ERROR_CODES.VALIDATION_ERROR,
    { errors: [{ field: error.path, message: `expected type ${error.kind}` }] }
  );
};

/**
 * A unique-index violation (E11000).
 */
const fromDuplicateKey = (error) => {
  const fields = Object.keys(error.keyValue ?? {});
  const field = fields[0] ?? 'value';
  const value = error.keyValue?.[field];

  // Field-specific codes so a client can react precisely.
  const specificCodes = {
    email: ERROR_CODES.EMAIL_ALREADY_REGISTERED,
    isbn13: ERROR_CODES.ISBN_ALREADY_EXISTS,
    isbn10: ERROR_CODES.ISBN_ALREADY_EXISTS,
    accessionNumber: ERROR_CODES.ACCESSION_NUMBER_TAKEN,
    'studentProfile.enrollmentNo': ERROR_CODES.ENROLLMENT_NUMBER_TAKEN,
  };

  return ApiError.conflict(
    `A record with this ${field} already exists${value !== undefined ? ` (${value})` : ''}`,
    specificCodes[field] ?? ERROR_CODES.DUPLICATE_RESOURCE,
    { errors: fields.map((name) => ({ field: name, message: 'must be unique' })) }
  );
};

/**
 * JWT failures. The distinction between "expired" and "invalid" matters to a
 * client: expired means "refresh and retry automatically", invalid means
 * "send the user back to the login screen".
 */
const fromJwtError = (error) => {
  if (error instanceof jwt.TokenExpiredError) {
    return ApiError.unauthorized(
      'Your session has expired. Please refresh your token.',
      ERROR_CODES.TOKEN_EXPIRED,
      { details: { expiredAt: error.expiredAt } }
    );
  }
  if (error instanceof jwt.NotBeforeError) {
    return ApiError.unauthorized('This token is not valid yet', ERROR_CODES.INVALID_TOKEN);
  }
  // Deliberately vague: telling an attacker whether the signature, the issuer
  // or the audience failed helps them forge a better token next time.
  return ApiError.unauthorized('Invalid authentication token', ERROR_CODES.INVALID_TOKEN);
};

/** Multer upload failures, mapped to the correct 4xx and a specific code. */
const fromMulterError = (error) => {
  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return ApiError.payloadTooLarge(
        'The uploaded file exceeds the maximum allowed size',
        ERROR_CODES.FILE_TOO_LARGE
      );
    case 'LIMIT_UNEXPECTED_FILE':
      return ApiError.badRequest(
        `Unexpected file field '${error.field}'`,
        ERROR_CODES.UPLOAD_FAILED
      );
    case 'LIMIT_FILE_COUNT':
      return ApiError.badRequest('Too many files uploaded at once', ERROR_CODES.UPLOAD_FAILED);
    default:
      return ApiError.badRequest(`Upload failed: ${error.message}`, ERROR_CODES.UPLOAD_FAILED);
  }
};

/**
 * Zod validation. `path` is an array (`['studentProfile', 'year']`) because
 * schemas nest; joining with dots gives the client a field path it can map
 * back to its own form.
 */
const fromZodError = (error) => {
  const errors = error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  return ApiError.validation('The submitted data is not valid', errors);
};

/** Body-parser failures on malformed JSON. */
const fromJsonParseError = () =>
  ApiError.badRequest('Request body is not valid JSON', ERROR_CODES.BAD_REQUEST);

/* Normaliser */

/**
 * Reduce any thrown value to an ApiError.
 */
const normaliseError = (error) => {
  if (error instanceof ApiError) return error;
  if (error instanceof ZodError) return fromZodError(error);
  if (error instanceof mongoose.Error.ValidationError) return fromMongooseValidation(error);
  if (error instanceof mongoose.Error.CastError) return fromCastError(error);
  if (error instanceof mongoose.Error.DocumentNotFoundError) {
    return ApiError.notFound('The requested record no longer exists', ERROR_CODES.NOT_FOUND);
  }
  if (error instanceof multer.MulterError) return fromMulterError(error);
  if (error instanceof jwt.JsonWebTokenError) return fromJwtError(error);

  // Duplicate key arrives as a plain MongoServerError, not a mongoose.Error.
  if (error?.code === 11000 || error?.code === 11001) return fromDuplicateKey(error);

  // body-parser marks JSON syntax errors with a `body` property.
  if (error instanceof SyntaxError && 'body' in error) return fromJsonParseError();

  // A driver-level failure means the database is unreachable — a 503, not a
  // 500, because it is a transient infrastructure condition rather than a bug.
  if (error instanceof mongoose.Error.MongooseServerSelectionError) {
    return ApiError.serviceUnavailable(
      'The database is temporarily unreachable. Please try again shortly.',
      ERROR_CODES.SERVICE_UNAVAILABLE,
      { cause: error }
    );
  }

  const fallback = ApiError.internal(error?.message || 'An unexpected error occurred', {
    cause: error,
  });
  fallback.isOperational = false;
  return fallback;
};

/* The handler */

/**
 * Express identifies error middleware by its four-parameter signature, so
 * `next` must stay in the list even though it is unused on most paths.
 */
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  const apiError = normaliseError(err);

  /* --- Logging ------------------------------------------------------- */
  const logContext = {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    statusCode: apiError.statusCode,
    code: apiError.code,
    userId: req.user?.id ?? null,
    ip: req.ip,
  };

  if (apiError.statusCode >= 500) {
    // Server-side failure: log the full original error, stack included.
    logger.error(apiError.message, {
      ...logContext,
      error: apiError.cause ?? err,
      stack: (apiError.cause ?? err)?.stack,
    });
  } else if (apiError.statusCode === HTTP_STATUS.TOO_MANY_REQUESTS) {
    logger.warn(`Rate limited: ${apiError.message}`, logContext);
  } else {
    // Client-side mistakes are expected traffic. Keep them at debug so they
    // do not bury real problems, but keep them for pattern analysis.
    logger.debug(`Client error: ${apiError.message}`, logContext);
  }

  /* --- Response ------------------------------------------------------- */

  // If headers are already sent — a failure mid-stream while serving an ebook,
  // for instance — the response cannot be rewritten. Destroy the socket so the
  // client sees a truncated transfer instead of corrupt JSON appended to a PDF.
  if (res.headersSent) {
    logger.warn('Error occurred after response headers were sent; destroying the connection', logContext);
    return req.socket?.destroy();
  }

  const body = apiError.toJSON(req.id);

  // Stack traces are a development aid and an information leak in production.
  if (config.app.isDevelopment && apiError.statusCode >= 500) {
    body.stack = (apiError.cause ?? err)?.stack?.split('\n').map((line) => line.trim());
  }

  return res.status(apiError.statusCode).json(body);
};

/**
 * Handler for routes that do not exist.
 */
export const notFoundHandler = (req, res, next) => {
  next(
    ApiError.notFound(
      `Cannot ${req.method} ${req.originalUrl} — no such endpoint`,
      ERROR_CODES.NOT_FOUND,
      {
        details: {
          hint: `Browse the available endpoints at ${config.swagger.route}`,
        },
      }
    )
  );
};

export default errorHandler;
