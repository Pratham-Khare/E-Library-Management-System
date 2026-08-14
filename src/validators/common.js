/**
 * Zod building blocks reused across every resource, so that "what is a valid
 * id" or "how does pagination work" is answered once rather than per file.
 */

import { z } from 'zod';
import mongoose from 'mongoose';
import config from '../config/index.js';
import { SORT_ORDER_VALUES } from '../constants/enums.js';

/* Identifiers */

/**
 * A MongoDB ObjectId.
 */
export const objectId = z
  .string()
  .refine((value) => mongoose.Types.ObjectId.isValid(value), {
    message: 'must be a valid ID',
  });

/** `:id` in a path. */
export const idParam = z.object({ id: objectId });

/** A path parameter that also accepts `me` for the caller's own record. */
export const userIdParam = z.object({
  userId: z.union([objectId, z.literal('me')]),
});

/** A comma-separated list of ids, e.g. `?categories=id1,id2`. */
export const objectIdList = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : value.split(',')))
  .pipe(z.array(objectId).max(50, 'Cannot filter on more than 50 IDs at once'));

/* Primitives */

/**
 * Email. Lowercased and trimmed so that Alice@X.com and alice@x.com resolve to
 * the same account — the User model lowercases on write, and a lookup that
 * does not match it would simply fail to find the user.
 */
export const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Email is required')
  .email('Please provide a valid email address')
  .max(254, 'Email address is too long'); // RFC 5321 maximum

/** A required, trimmed string with sensible bounds. */
export const nonEmptyString = (fieldName, { min = 1, max = 255 } = {}) =>
  z
    .string()
    .trim()
    .min(min, `${fieldName} must be at least ${min} character${min === 1 ? '' : 's'}`)
    .max(max, `${fieldName} cannot exceed ${max} characters`);

/** An optional string; blank input is normalised to undefined, not ''. */
export const optionalString = (max = 255) =>
  z
    .string()
    .trim()
    .max(max, `Cannot exceed ${max} characters`)
    .optional()
    .transform((value) => (value === '' ? undefined : value));

/**
 * A query-string boolean. `?available=true` arrives as the STRING 'true',
 * which is truthy either way — including the string 'false'. Coercing here is
 * what stops `?available=false` from behaving like `?available=true`.
 */
export const queryBoolean = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    return ['true', '1', 'yes'].includes(value);
  });

/** A query-string integer with bounds. */
export const queryInt = ({ min, max } = {}) => {
  let schema = z.coerce.number().int();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return schema;
};

/** A comma-separated list of strings, e.g. `?tags=fiction,classic`. */
export const csvStrings = (maxItems = 20) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (Array.isArray(value) ? value : value.split(',')))
    .pipe(
      z
        .array(z.string().trim().min(1))
        .max(maxItems, `Cannot specify more than ${maxItems} values`)
    );

/** A phone number. Deliberately permissive — formats vary enormously. */
export const phone = z
  .string()
  .trim()
  .regex(/^[+]?[\d\s()-]{7,20}$/, 'Please provide a valid phone number');

/** An ISO date string, coerced to a Date. */
export const dateString = z.coerce.date();

/** A four-digit year within a plausible publishing range. */
export const year = z.coerce
  .number()
  .int()
  .min(1000, 'Year seems too early')
  .max(new Date().getFullYear() + 1, 'Year cannot be in the future');

/* Pagination & sorting */

/**
 * Standard pagination query.
 */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(config.pagination.defaultPage),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(config.pagination.maxLimit, `Cannot request more than ${config.pagination.maxLimit} items per page`)
    .default(config.pagination.defaultLimit),
});

/** Sorting query. The allow-list is applied later, in parseSort(). */
export const sortQuery = z.object({
  sort: z.string().trim().max(100).optional(),
  order: z.enum(SORT_ORDER_VALUES).optional(),
});

/** Pagination and sorting combined — the base for most list endpoints. */
export const listQuery = paginationQuery.merge(sortQuery);

/**
 * Extend `listQuery` with endpoint-specific filters.
 *
 *     const bookListQuery = withListQuery({ language: z.string().optional() });
 */
export const withListQuery = (shape) => listQuery.extend(shape);

/* Search */

/**
 * A free-text search term.
 */
export const searchTerm = z
  .string()
  .trim()
  .min(1, 'Search term cannot be empty')
  .max(200, 'Search term is too long');

export default {
  objectId,
  idParam,
  userIdParam,
  objectIdList,
  email,
  nonEmptyString,
  optionalString,
  queryBoolean,
  queryInt,
  csvStrings,
  phone,
  dateString,
  year,
  paginationQuery,
  sortQuery,
  listQuery,
  withListQuery,
  searchTerm,
};
