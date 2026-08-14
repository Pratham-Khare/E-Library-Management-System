/**
 * ---------------------------------------------------------------------------
 * FINE ROUTES  —  /api/v1/fines
 * ---------------------------------------------------------------------------
 */

import { Router } from 'express';
import * as fineController from '../../controllers/fine.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { requireStaff } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import {
  fineIdParam,
  listFinesQuery,
  payFineSchema,
  waiveFineSchema,
  createFineSchema,
  fineSummaryQuery,
} from '../../validators/circulation.validator.js';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * /fines/me:
 *   get:
 *     tags: [Fines]
 *     summary: Your fines
 *     description: >
 *       The `meta.summary` block carries what a member actually needs: the
 *       total outstanding, the threshold, and whether they are currently
 *       BLOCKED from borrowing.
 *       Each fine includes the arithmetic behind it — days late, days forgiven
 *       as grace, the daily rate — so a charge can be explained rather than
 *       merely asserted.
 *     parameters:
 *       - $ref: '#/components/parameters/PageParam'
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, PAID, WAIVED] }
 *     responses:
 *       200:
 *         description: Your fines, with a summary.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 meta:
 *                   type: object
 *                   properties:
 *                     summary:
 *                       type: object
 *                       properties:
 *                         outstanding:    { type: number, example: 40 }
 *                         blockThreshold: { type: number, example: 200 }
 *                         isBlocked:      { type: boolean, example: false }
 *                         currency:       { type: string, example: INR }
 */
router.get('/me', validate({ query: listFinesQuery }), fineController.myFines);

/**
 * @openapi
 * /fines/summary:
 *   get:
 *     tags: [Fines]
 *     summary: Collection totals (staff only)
 *     description: >
 *       Outstanding, collected and waived totals, broken down by reason, plus
 *       the members who owe the most. Computed in a single aggregation pass so
 *       the figures cannot disagree with one another.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: 'The summary.' }
 */
router.get(
  '/summary',
  requireStaff,
  validate({ query: fineSummaryQuery }),
  fineController.getSummary
);

/**
 * @openapi
 * /fines:
 *   get:
 *     tags: [Fines]
 *     summary: List all fines (staff only)
 *     parameters:
 *       - $ref: '#/components/parameters/PageParam'
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, PAID, WAIVED] }
 *       - in: query
 *         name: userId
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Fines.' }
 *   post:
 *     tags: [Fines]
 *     summary: Raise a charge by hand (staff only)
 *     description: For damage found after return, or a replacement charged directly.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, amount, description]
 *             properties:
 *               userId:      { type: string }
 *               bookId:      { type: string }
 *               reason:      { type: string, enum: [OVERDUE, DAMAGE, LOST, MANUAL] }
 *               amount:      { type: number, example: 150 }
 *               description: { type: string, example: 'Torn dust jacket, replaced' }
 *     responses:
 *       201: { description: 'Charge added.' }
 */
router
  .route('/')
  .get(requireStaff, validate({ query: listFinesQuery }), fineController.listAll)
  .post(requireStaff, validate({ body: createFineSchema }), fineController.createFine);

/**
 * @openapi
 * /fines/{fineId}:
 *   get:
 *     tags: [Fines]
 *     summary: Get a fine
 *     parameters:
 *       - in: path
 *         name: fineId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'The fine, including how it was calculated.' }
 *       403: { description: 'Not your fine.' }
 */
router.get('/:fineId', validate({ params: fineIdParam }), fineController.getFine);

/**
 * @openapi
 * /fines/{fineId}/pay:
 *   post:
 *     tags: [Fines]
 *     summary: Record payment of a fine (staff only)
 *     description: >
 *       Records that money changed hands at the desk — no payment gateway is
 *       integrated, which is how library fines are usually settled.
 *       `paymentReference` carries the receipt number from whatever did handle
 *       the money.
 *     parameters:
 *       - in: path
 *         name: fineId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               paymentMethod:    { type: string, enum: [CASH, CARD, UPI, BANK_TRANSFER, OTHER] }
 *               paymentReference: { type: string }
 *     responses:
 *       200: { description: 'Payment recorded.' }
 *       409: { description: 'Already paid or waived (FINE_ALREADY_SETTLED).' }
 */
router.post(
  '/:fineId/pay',
  requireStaff,
  validate({ params: fineIdParam, body: payFineSchema }),
  fineController.payFine
);

/**
 * @openapi
 * /fines/{fineId}/waive:
 *   post:
 *     tags: [Fines]
 *     summary: Waive a fine (staff only)
 *     description: >
 *       A REASON IS REQUIRED. A waiver writes off money the library was owed;
 *       without a recorded reason it cannot be told apart from a mistake or a
 *       favour, and nobody can answer "why was this cancelled?" months later.
 *       The note is stored permanently on the fine, and the action is written
 *       to the audit log.
 *     parameters:
 *       - in: path
 *         name: fineId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [note]
 *             properties:
 *               note: { type: string, minLength: 5, example: 'Book was returned on time; the drop-box was not emptied.' }
 *     responses:
 *       200: { description: 'Waived.' }
 *       409: { description: 'Already settled.' }
 *       422: { description: 'No reason given (WAIVER_NOTE_REQUIRED).' }
 */
router.post(
  '/:fineId/waive',
  requireStaff,
  validate({ params: fineIdParam, body: waiveFineSchema }),
  fineController.waiveFine
);

export default router;
