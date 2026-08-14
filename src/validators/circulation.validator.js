/**
 * ---------------------------------------------------------------------------
 * CIRCULATION REQUEST SCHEMAS — loans and fines
 * ---------------------------------------------------------------------------
 */

import { z } from 'zod';
import { objectId, optionalString, listQuery, queryBoolean, dateString } from './common.js';
import {
  LOAN_TYPE_VALUES,
  LOAN_STATUS_VALUES,
  FINE_STATUS_VALUES,
  FINE_REASON_VALUES,
  COPY_CONDITION_VALUES,
} from '../constants/enums.js';

/* ===========================================================================
 * Borrowing
 * ======================================================================== */

export const borrowSchema = z.object({
  bookId: objectId,
  /** PHYSICAL takes a copy off the shelf; DIGITAL consumes a licence. */
  type: z.enum(LOAN_TYPE_VALUES).default('PHYSICAL'),
});

/**
 * A staff-desk issue, on behalf of a member.
 *
 * `dueAt` lets a librarian override the computed due date — for a reading-week
 * extension, or a title reserved for a class. Deliberately unavailable to
 * members, who would otherwise set their own due dates.
 */
export const issueSchema = z.object({
  bookId: objectId,
  userId: objectId,
  type: z.enum(LOAN_TYPE_VALUES).default('PHYSICAL'),
  dueAt: dateString.optional(),
  note: optionalString(500),
});

export const loanIdParam = z.object({ loanId: objectId });

export const returnSchema = z.object({
  /** Condition recorded at the desk, so wear is tracked per copy. */
  condition: z.enum(COPY_CONDITION_VALUES).optional(),
  note: optionalString(500),
});

export const markLostSchema = z.object({
  note: optionalString(500),
});

export const listLoansQuery = listQuery.extend({
  status: z.enum(LOAN_STATUS_VALUES).optional(),
  type: z.enum(LOAN_TYPE_VALUES).optional(),
  /** Shorthand for "anything still out", i.e. ACTIVE or OVERDUE. */
  open: queryBoolean.optional(),
  overdue: queryBoolean.optional(),
  userId: objectId.optional(),
  bookId: objectId.optional(),
});

/* ===========================================================================
 * Fines
 * ======================================================================== */

export const fineIdParam = z.object({ fineId: objectId });

export const listFinesQuery = listQuery.extend({
  status: z.enum(FINE_STATUS_VALUES).optional(),
  reason: z.enum(FINE_REASON_VALUES).optional(),
  userId: objectId.optional(),
});

export const payFineSchema = z.object({
  paymentMethod: z.enum(['CASH', 'CARD', 'UPI', 'BANK_TRANSFER', 'OTHER']).default('CASH'),
  paymentReference: optionalString(100),
});

/**
 * Waiving requires a reason.
 *
 * A waiver writes off money the library was owed. Without a recorded reason it
 * cannot be distinguished from a mistake or a favour, and nobody can answer
 * "why was this cancelled?" months later. The minimum length is there because
 * "ok" is not a reason.
 */
export const waiveFineSchema = z.object({
  note: z
    .string()
    .trim()
    .min(5, 'Please give a reason of at least 5 characters for waiving this fine')
    .max(500),
});

export const createFineSchema = z.object({
  userId: objectId,
  bookId: objectId.optional(),
  loanId: objectId.optional(),
  reason: z.enum(FINE_REASON_VALUES).default('MANUAL'),
  amount: z.coerce.number().min(0.01, 'A fine must be greater than zero').max(100_000),
  description: z.string().trim().min(5, 'Please describe what this charge is for').max(500),
});

export const fineSummaryQuery = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
});

export default {
  borrowSchema,
  issueSchema,
  loanIdParam,
  returnSchema,
  markLostSchema,
  listLoansQuery,
  fineIdParam,
  listFinesQuery,
  payFineSchema,
  waiveFineSchema,
  createFineSchema,
  fineSummaryQuery,
};
