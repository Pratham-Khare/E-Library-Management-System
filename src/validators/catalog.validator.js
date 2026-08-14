/**
 * Books, copies, authors, publishers, categories and search.
 */

import { z } from 'zod';
import {
  objectId,
  nonEmptyString,
  optionalString,
  listQuery,
  queryBoolean,
  csvStrings,
  objectIdList,
  year,
  searchTerm,
} from './common.js';
import { isValidIsbn } from '../utils/isbn.js';
import {
  BOOK_STATUS_VALUES,
  COPY_STATUS_VALUES,
  COPY_CONDITION_VALUES,
} from '../constants/enums.js';

/** Either format is accepted; the model normalises to both and verifies the
 *  check digit, so a transposed pair is rejected rather than stored. */
const isbn = z
  .string()
  .trim()
  .refine(isValidIsbn, 'Not a valid ISBN — the check digit does not match, which usually means a mistyped or transposed digit');

/* Books */

const bookCore = {
  title: nonEmptyString('Title', { min: 1, max: 500 }),
  subtitle: optionalString(500),
  isbn13: isbn.optional(),
  isbn10: isbn.optional(),
  authors: z.array(objectId).max(20, 'A book cannot have more than 20 authors').optional(),
  publisher: objectId.optional(),
  categories: z.array(objectId).max(10, 'A book cannot have more than 10 categories').optional(),
  language: z.string().trim().toLowerCase().min(2).max(10).optional(),
  edition: optionalString(100),
  publishedYear: year.optional(),
  pageCount: z.coerce.number().int().min(1).max(50_000).optional(),
  description: optionalString(10_000),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(60)).max(30).optional(),
  price: z.coerce.number().min(0).optional(),
  status: z.enum(BOOK_STATUS_VALUES).optional(),
};

export const createBookSchema = z.object({
  ...bookCore,
  /**
   * Create the physical copies in the same request. Cataloguing a title and
   * then adding its three copies separately is two calls for one real-world
   * action, and forgetting the second leaves a book nobody can borrow.
   */
  copies: z.coerce.number().int().min(0).max(100).optional().default(0),
});

/** Every field optional — this is a PATCH. */
export const updateBookSchema = z
  .object(bookCore)
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

export const bookIdParam = z.object({
  /** Accepts an ObjectId or a slug, so `/books/things-fall-apart` works. */
  bookId: z.string().trim().min(1),
});

export const listBooksQuery = listQuery.extend({
  status: z.enum(BOOK_STATUS_VALUES).optional(),
});

export const feedParam = z.object({
  feed: z.enum(['new-arrivals', 'most-borrowed', 'top-rated', 'trending', 'available']),
});

export const feedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/* Copies */

export const addCopiesSchema = z.object({
  count: z.coerce.number().int().min(1).max(100).default(1),
  shelfLocation: optionalString(50),
  condition: z.enum(COPY_CONDITION_VALUES).optional(),
  cost: z.coerce.number().min(0).optional(),
  source: optionalString(200),
});

export const copyIdParam = z.object({ copyId: objectId });

export const updateCopyStatusSchema = z.object({
  status: z.enum(COPY_STATUS_VALUES),
  condition: z.enum(COPY_CONDITION_VALUES).optional(),
  note: optionalString(500),
});

export const listCopiesQuery = z.object({
  status: z.enum(COPY_STATUS_VALUES).optional(),
});

/* Authors */

export const createAuthorSchema = z.object({
  name: nonEmptyString('Author name', { min: 2, max: 200 }),
  bio: optionalString(5000),
  nationality: optionalString(100),
  birthYear: year.optional(),
  deathYear: year.optional(),
  website: optionalString(500),
});

export const updateAuthorSchema = createAuthorSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });

/* Publishers */

export const createPublisherSchema = z.object({
  name: nonEmptyString('Publisher name', { min: 2, max: 200 }),
  description: optionalString(2000),
  website: optionalString(500),
  foundedYear: z.coerce.number().int().min(1400).max(new Date().getFullYear()).optional(),
  address: z.object({ city: optionalString(100), country: optionalString(100) }).optional(),
  contactEmail: z.string().trim().toLowerCase().email().optional(),
});

export const updatePublisherSchema = createPublisherSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });

/* Categories */

export const createCategorySchema = z.object({
  name: nonEmptyString('Category name', { min: 2, max: 120 }),
  description: optionalString(1000),
  /** null makes it a top-level category. */
  parent: objectId.nullable().optional(),
  icon: optionalString(60),
  color: optionalString(20),
  displayOrder: z.coerce.number().int().optional(),
});

export const updateCategorySchema = createCategorySchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });

export const listCategoriesQuery = listQuery.extend({
  search: optionalString(200),
  depth: z.coerce.number().int().min(0).max(10).optional(),
  /** `root` is how a client asks for top-level categories, since an empty
   *  query parameter cannot express "null". */
  parent: z.union([objectId, z.literal('root')]).optional(),
});

/* Shared taxonomy queries */

export const identifierParam = z.object({ identifier: z.string().trim().min(1) });

export const listTaxonomyQuery = listQuery.extend({
  search: optionalString(200),
  hasBooks: queryBoolean.optional(),
});

export const taxonomyBooksQuery = listQuery.extend({
  includeDescendants: queryBoolean.optional(),
});

export const mergeSchema = z.object({
  /** The duplicate to retire; its books are repointed at the record in the path. */
  source: z.string().trim().min(1),
});

/* Search */

/**
 * The search query.
 */
export const searchQuery = z.object({
  /** The free-text term. Omit for a filtered browse. */
  q: searchTerm.optional(),

  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),

  category: z.string().trim().optional(),
  categories: objectIdList.optional(),
  includeSubcategories: queryBoolean.optional(),

  author: objectId.optional(),
  authors: objectIdList.optional(),
  publisher: objectId.optional(),

  language: z.string().trim().toLowerCase().length(2).optional(),
  yearFrom: year.optional(),
  yearTo: year.optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),

  available: queryBoolean.optional(),
  format: z.enum(['physical', 'digital', 'any']).optional(),
  tags: csvStrings(10).optional(),

  sort: z
    .enum(['relevance', 'title', '-title', 'newest', 'oldest', 'rating', 'popular', 'recent'])
    .optional(),
})
  /** A reversed range returns nothing and looks like a system fault; catch it
   *  here and say so plainly. */
  .refine((data) => data.yearFrom === undefined || data.yearTo === undefined || data.yearFrom <= data.yearTo, {
    path: ['yearFrom'],
    message: 'yearFrom must not be later than yearTo',
  });

export const suggestQuery = z.object({
  q: z.string().trim().min(2, 'Type at least 2 characters').max(100),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

export default {
  createBookSchema,
  updateBookSchema,
  bookIdParam,
  listBooksQuery,
  feedParam,
  feedQuery,
  addCopiesSchema,
  copyIdParam,
  updateCopyStatusSchema,
  listCopiesQuery,
  createAuthorSchema,
  updateAuthorSchema,
  createPublisherSchema,
  updatePublisherSchema,
  createCategorySchema,
  updateCategorySchema,
  listCategoriesQuery,
  identifierParam,
  listTaxonomyQuery,
  taxonomyBooksQuery,
  mergeSchema,
  searchQuery,
  suggestQuery,
};
