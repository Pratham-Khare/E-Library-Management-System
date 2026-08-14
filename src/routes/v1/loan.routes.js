/**
 * LOAN ROUTES  —  /api/v1/loans
 * Everything here requires authentication — there is no anonymous borrowing.
 */

import { Router } from 'express';
import * as loanController from '../../controllers/loan.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { requireStaff } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import {
  borrowSchema,
  issueSchema,
  loanIdParam,
  returnSchema,
  markLostSchema,
  listLoansQuery,
} from '../../validators/circulation.validator.js';
import { z } from 'zod';
import { objectId } from '../../validators/common.js';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * /loans/me:
 *   get:
 *     tags: [Loans]
 *     summary: Your loans
 *     description: >
 *       Every response includes SERVER-COMPUTED `daysRemaining`, `daysOverdue`
 *       and `isOverdue`. Deliberately not left to the client: date arithmetic
 *       done on a device uses that device's clock, and a phone set a day fast
 *       would show a book as overdue when the library does not agree.
 *     parameters:
 *       - $ref: '#/components/parameters/PageParam'
 *       - $ref: '#/components/parameters/LimitParam'
 *       - in: query
 *         name: open
 *         schema: { type: boolean }
 *         description: Only items still out (ACTIVE or OVERDUE).
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [ACTIVE, RETURNED, OVERDUE, LOST, EXPIRED] }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [PHYSICAL, DIGITAL] }
 *     responses:
 *       200: { description: 'Your loans.' }
 */
router.get('/me', validate({ query: listLoansQuery }), loanController.myLoans);

/**
 * @openapi
 * /loans/eligibility:
 *   get:
 *     tags: [Loans]
 *     summary: Can you borrow this book right now?
 *     description: >
 *       Returns 200 either way, with `eligible: true|false` and — when false —
 *       the specific reason and code.
 *       This exists so a client can disable a Borrow button with an accurate
 *       explanation rather than letting the member click it and get an error.
 *     parameters:
 *       - in: query
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The verdict, with a reason when refused.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     eligible: { type: boolean }
 *                     reason:   { type: string, example: 'You have an overdue item...' }
 *                     code:     { type: string, example: HAS_OVERDUE_ITEMS }
 */
router.get(
  '/eligibility',
  validate({ query: z.object({ bookId: objectId }) }),
  loanController.checkEligibility
);

/**
 * @openapi
 * /loans:
 *   get:
 *     tags: [Loans]
 *     summary: List all loans (staff only)
 *     parameters:
 *       - $ref: '#/components/parameters/PageParam'
 *       - in: query
 *         name: overdue
 *         schema: { type: boolean }
 *         description: Everything currently past its due date — the desk's default view.
 *       - in: query
 *         name: userId
 *         schema: { type: string }
 *       - in: query
 *         name: bookId
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Loans, including borrower details.' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     tags: [Loans]
 *     summary: Borrow a book
 *     description: |
 *       Borrow for yourself. The request is refused with a SPECIFIC code when
 *       you are not eligible:
 *
 *       - `LOAN_LIMIT_REACHED` — at your tier's concurrent-loan cap
 *       - `HAS_OVERDUE_ITEMS` — something is already late
 *       - `OUTSTANDING_FINES` — you owe more than the threshold
 *       - `ALREADY_BORROWED` — you already hold this title
 *       - `NO_COPY_AVAILABLE` — every copy is out (response carries the
 *         earliest expected return date)
 *       - `NO_LICENSE_AVAILABLE` — every digital licence is in use
 *
 *       The copy claim is a single atomic compare-and-swap, so two members
 *       borrowing the last copy simultaneously cannot both succeed.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bookId]
 *             properties:
 *               bookId: { type: string }
 *               type:   { type: string, enum: [PHYSICAL, DIGITAL], default: PHYSICAL }
 *     responses:
 *       201:
 *         description: Borrowed, with the due date and remaining renewals.
 *       403: { description: 'Your account cannot borrow (suspended or inactive).' }
 *       409: { description: 'Not eligible, or nothing available — see the error code.' }
 */
router
  .route('/')
  .get(requireStaff, validate({ query: listLoansQuery }), loanController.listAll)
  .post(validate({ body: borrowSchema }), loanController.borrow);

/**
 * @openapi
 * /loans/issue:
 *   post:
 *     tags: [Loans]
 *     summary: Issue a book to a member (staff only)
 *     description: >
 *       The circulation desk. Runs the SAME eligibility checks as self-service
 *       borrowing — a librarian may set a different due date, but cannot
 *       bypass loan limits, overdue blocks or fine thresholds. Those are
 *       library policy, not a desk preference.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bookId, userId]
 *             properties:
 *               bookId: { type: string }
 *               userId: { type: string }
 *               type:   { type: string, enum: [PHYSICAL, DIGITAL] }
 *               dueAt:  { type: string, format: date-time, description: 'Override the computed due date.' }
 *               note:   { type: string }
 *     responses:
 *       201: { description: 'Issued.' }
 *       409: { description: 'The member is not eligible, or nothing is available.' }
 */
router.post('/issue', requireStaff, validate({ body: issueSchema }), loanController.issue);

/**
 * @openapi
 * /loans/{loanId}:
 *   get:
 *     tags: [Loans]
 *     summary: Get a loan
 *     description: Members may view their own; staff may view any.
 *     parameters:
 *       - in: path
 *         name: loanId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'The loan.' }
 *       403: { description: 'Not your loan.' }
 */
router.get('/:loanId', validate({ params: loanIdParam }), loanController.getLoan);

/**
 * @openapi
 * /loans/{loanId}/return:
 *   post:
 *     tags: [Loans]
 *     summary: Return a borrowed item
 *     description: >
 *       Releases the copy and closes the loan. If it is late, a fine is
 *       assessed — after the grace period, at the daily rate, capped per loan.
 *       The response includes the fine and the arithmetic behind it.
 *       For a DIGITAL loan this simply ends it early and releases the licence.
 *     parameters:
 *       - in: path
 *         name: loanId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               condition: { type: string, enum: [NEW, GOOD, FAIR, POOR], description: 'Recorded against the copy.' }
 *               note:      { type: string }
 *     responses:
 *       200: { description: 'Returned, with any fine raised.' }
 *       409: { description: 'The loan is already closed (LOAN_NOT_ACTIVE).' }
 */
router.post(
  '/:loanId/return',
  validate({ params: loanIdParam, body: returnSchema }),
  loanController.returnLoan
);

/**
 * @openapi
 * /loans/{loanId}/renew:
 *   post:
 *     tags: [Loans]
 *     summary: Renew a loan
 *     description: |
 *       Grants a FRESH full loan period from today — not an extension of the
 *       old due date, so renewing early does not cost you the unused days.
 *
 *       Refused in exactly two cases:
 *       - `RENEWAL_LIMIT_REACHED` — already renewed the maximum for your tier
 *       - `CANNOT_RENEW_OVERDUE` — the item is ALREADY late
 *
 *       The second rule matters: without it, renewing after the fact would be
 *       a way to escape a fine that is already accruing.
 *     parameters:
 *       - in: path
 *         name: loanId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Renewed, with the new due date and renewals remaining.' }
 *       409: { description: 'At the renewal cap, or already overdue.' }
 */
router.post('/:loanId/renew', validate({ params: loanIdParam }), loanController.renew);

/**
 * @openapi
 * /loans/{loanId}/lost:
 *   post:
 *     tags: [Loans]
 *     summary: Mark a loan as lost (staff only)
 *     description: >
 *       Closes the loan, retires the copy, and charges replacement cost — the
 *       book's recorded price where known, otherwise the per-loan fine ceiling.
 *       Charging a flat fee for a lost reference volume and a lost paperback
 *       alike is not defensible.
 *     parameters:
 *       - in: path
 *         name: loanId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               note: { type: string }
 *     responses:
 *       200: { description: 'Marked lost, with the replacement charge.' }
 */
router.post(
  '/:loanId/lost',
  requireStaff,
  validate({ params: loanIdParam, body: markLostSchema }),
  loanController.markLost
);

export default router;
