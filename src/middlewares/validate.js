/**
 * Runs a Zod schema over `req.body`, `req.params` and `req.query`, then
 * REPLACES each with the parsed result.
 */

import { ZodError } from 'zod';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';

/**
 * Flatten Zod issues into the flat `{ field, message }` shape used by every
 * error response, so a client handles validation failures identically whether
 * they came from here or from Mongoose.
 */
const formatIssues = (error, source) =>
  error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : source,
    message: issue.message,
    ...(issue.code === 'invalid_type' && issue.received === 'undefined'
      ? { code: 'required' }
      : {}),
  }));

/**
 * Build validation middleware.
 */
export const validate = (schemas) => (req, res, next) => {
  const errors = [];

  /* --- Body ---------------------------------------------------------- */
  if (schemas.body) {
    const result = schemas.body.safeParse(req.body ?? {});
    if (result.success) {
      req.body = result.data; // coerced and whitelisted
    } else {
      errors.push(...formatIssues(result.error, 'body'));
    }
  }

  /* --- Params -------------------------------------------------------- */
  if (schemas.params) {
    const result = schemas.params.safeParse(req.params ?? {});
    if (result.success) {
      // Express 5 keeps req.params writable, but assign key-by-key rather than
      // replacing the object so any reference captured earlier stays valid.
      Object.assign(req.params, result.data);
    } else {
      errors.push(...formatIssues(result.error, 'params'));
    }
  }

  /* --- Query --------------------------------------------------------- */
  if (schemas.query) {
    const result = schemas.query.safeParse(req.query ?? {});
    if (result.success) {
      /**
       * `req.query` is a GETTER in Express 5 — assigning to it throws. Redefine
       * the property instead, so every existing `req.query.page` reader keeps
       * working and now reads a coerced, whitelisted value.
       */
      Object.defineProperty(req, 'query', {
        value: result.data,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      req.validatedQuery = result.data;
    } else {
      errors.push(...formatIssues(result.error, 'query'));
    }
  }

  // Report EVERY problem at once. Returning one error at a time turns fixing a
  // form into a guessing game with one round-trip per field.
  if (errors.length > 0) {
    return next(
      ApiError.validation(
        `Validation failed for ${errors.length} field${errors.length === 1 ? '' : 's'}`,
        errors,
        ERROR_CODES.VALIDATION_ERROR
      )
    );
  }

  return next();
};

/**
 * Validate a value outside the request pipeline — inside a service, or against
 * a row of a CSV import.
 */
export const validateValue = (schema, value, label = 'value') => {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw ApiError.validation(`Invalid ${label}`, formatIssues(error, label));
    }
    throw error;
  }
};

export default validate;
