/**
 * ---------------------------------------------------------------------------
 * ENGAGEMENT REQUEST SCHEMAS — reviews, reading lists, notifications
 * ---------------------------------------------------------------------------
 */

import { z } from 'zod';
import { objectId, optionalString, nonEmptyString, listQuery, queryBoolean } from './common.js';
import { REVIEW_STATUS_VALUES, NOTIFICATION_TYPE_VALUES } from '../constants/enums.js';

/* --- Reviews ------------------------------------------------------------- */

export const createReviewSchema = z
  .object({
    /** Whole stars only — half-stars complicate the histogram for no gain. */
    rating: z.coerce.number().int().min(1, 'Rating must be 1-5').max(5, 'Rating must be 1-5'),
    title: optionalString(200),
    body: optionalString(5000),
  })
  /** A bare star rating is fine; a review with only a title is not useful. */
  .refine((data) => !data.title || data.body, {
    path: ['body'],
    message: 'Please write a review body to go with your title',
  });

export const updateReviewSchema = z
  .object({
    rating: z.coerce.number().int().min(1).max(5).optional(),
    title: optionalString(200),
    body: optionalString(5000),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });

export const reviewIdParam = z.object({ reviewId: objectId });

export const listReviewsQuery = listQuery.extend({
  rating: z.coerce.number().int().min(1).max(5).optional(),
  verifiedOnly: queryBoolean.optional(),
});

export const moderateReviewSchema = z.object({
  status: z.enum([REVIEW_STATUS_VALUES[1], REVIEW_STATUS_VALUES[2]]), // APPROVED | REJECTED
  note: optionalString(500),
});

/* --- Reading lists -------------------------------------------------------- */

export const createListSchema = z.object({
  name: nonEmptyString('List name', { min: 1, max: 100 }),
  description: optionalString(500),
  isPublic: z.boolean().optional(),
});

export const updateListSchema = z
  .object({
    name: nonEmptyString('List name', { min: 1, max: 100 }).optional(),
    description: optionalString(500),
    isPublic: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update' });

export const listIdParam = z.object({ listId: objectId });
export const listBookParams = z.object({ listId: objectId, bookId: objectId });
export const shareSlugParam = z.object({ slug: z.string().trim().min(8).max(64) });

export const addToListSchema = z.object({
  bookId: objectId,
  note: optionalString(500),
});

export const bookIdBodySchema = z.object({ bookId: objectId });

/* --- Notifications --------------------------------------------------------- */

export const listNotificationsQuery = listQuery.extend({
  unread: queryBoolean.optional(),
  type: z.enum(NOTIFICATION_TYPE_VALUES).optional(),
});

export const notificationIdParam = z.object({ notificationId: objectId });

/**
 * Mark specific notifications read, or all of them.
 * An empty body means "all" — the common case for a "mark all read" button.
 */
export const markReadSchema = z.object({
  notificationIds: z.array(objectId).max(200).optional(),
});

export default {
  createReviewSchema,
  updateReviewSchema,
  reviewIdParam,
  listReviewsQuery,
  moderateReviewSchema,
  createListSchema,
  updateListSchema,
  listIdParam,
  listBookParams,
  shareSlugParam,
  addToListSchema,
  bookIdBodySchema,
  listNotificationsQuery,
  notificationIdParam,
  markReadSchema,
};
