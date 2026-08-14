/**
 * ---------------------------------------------------------------------------
 * REQUEST VALIDATION MIDDLEWARE
 * ---------------------------------------------------------------------------
 * Runs a Zod schema over `req.body`, `req.params` and `req.query`, then
 * REPLACES each with the parsed result.
 *
 * The replacement is the important part, and it does three jobs at once:
 *
 *   1. TYPE COERCION. Query strings are always strings. After validation
 *      `req.query.page` is a real number and `req.query.available` a real
 *      boolean, so no handler has to remember to call parseInt.
 *
 *   2. WHITELISTING. Zod objects strip unknown keys by default. A request body
 *      carrying `{ name, email, role: 'ADMIN' }` against a schema that permits
 *      only name and email arrives as `{ name, email }`. That single behaviour
 *      closes mass-assignment — the vulnerability where a member promotes
 *      themselves by adding a field the API never intended to accept.
 *
 *   3. INJECTION DEFENCE. A schema expecting `email: string` cannot pass
 *      `{ "$gt": "" }` through, because an object is not a string. This is the
 *      precise half of the two-layer NoSQL defence; middlewares/sanitize.js is
 *      the broad half that covers routes without a schema.
 *
 * Usage:
 *     router.post('/login', validate({ body: loginSchema }), login);
 * ---------------------------------------------------------------------------
 */

import { ZodError } from 'zod';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';

/**
 * Flatten Zod issues into the flat `{ field, message }` shape used by every
 * error response, so a client handles validation failures identically whether
 * they came from here or from Mongoose.
 *
 * `issue.path` is an array because schemas nest — `['studentProfile','year']`
 * becomes `studentProfile.year`, a path the client can map to its own form.
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
 *
 * @param {object} schemas
 * @param {import('zod').ZodTypeAny} [schemas.body]
 * @param {import('zod').ZodTypeAny} [schemas.params]
 * @param {import('zod').ZodTypeAny} [schemas.query]
 * @returns {import('express').RequestHandler}
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
 *
 * @param {import('zod').ZodTypeAny} schema
 * @param {unknown} value
 * @param {string} [label] Used in the error message.
 * @returns {unknown} The parsed value.
 * @throws {ApiError} On failure.
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
