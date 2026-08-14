/**
 * ---------------------------------------------------------------------------
 * FINE CONTROLLER
 * ---------------------------------------------------------------------------
 */

import * as fineService from '../services/fine.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, paginated } from '../utils/ApiResponse.js';
import { toFine, listFines } from '../serializers/circulation.serializer.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';

const isStaff = (user) => ['LIBRARIAN', 'ADMIN'].includes(user.role);

/**
 * The caller's own fines.
 *
 * The `summary` block carries the number that actually matters to a member:
 * whether they are currently blocked from borrowing, and how much they would
 * need to pay to stop being blocked.
 */
export const myFines = asyncHandler(async (req, res) => {
  const { items, meta, summary } = await fineService.listForUser(req.user.id, req.query);
  return paginated(res, listFines(items), meta, 'Your fines', { summary });
});

export const listAll = asyncHandler(async (req, res) => {
  const { items, meta } = await fineService.listAll(req.query);
  return paginated(res, listFines(items, { includeUser: true }), meta, 'Fines fetched');
});

export const getFine = asyncHandler(async (req, res) => {
  const fine = await fineService.getById(req.params.fineId);

  const isOwner = String(fine.user._id ?? fine.user) === String(req.user.id);
  if (!isOwner && !isStaff(req.user)) {
    throw ApiError.forbidden('This is not your fine', ERROR_CODES.NOT_RESOURCE_OWNER);
  }

  return ok(res, toFine(fine, { includeUser: isStaff(req.user) }), 'Fine fetched');
});

/** Record payment taken at the desk. */
export const payFine = asyncHandler(async (req, res) => {
  const fine = await fineService.markPaid(req.params.fineId, {
    collectedBy: req.user.id,
    paymentMethod: req.body.paymentMethod,
    paymentReference: req.body.paymentReference,
  });

  return ok(res, toFine(fine), `Payment of ${fine.currency} ${fine.amount.toFixed(2)} recorded`);
});

/** Forgive a fine. The note is mandatory and is recorded permanently. */
export const waiveFine = asyncHandler(async (req, res) => {
  const fine = await fineService.waive(req.params.fineId, {
    waivedBy: req.user.id,
    note: req.body.note,
  });

  return ok(res, toFine(fine), `Fine of ${fine.currency} ${fine.amount.toFixed(2)} waived`);
});

export const createFine = asyncHandler(async (req, res) => {
  const fine = await fineService.createManual(req.body, req.user.id);
  return created(res, toFine(fine), 'Charge added to the account');
});

/** Collection totals for the admin dashboard. */
export const getSummary = asyncHandler(async (req, res) => {
  const summary = await fineService.getSummary(req.query);
  return ok(res, summary, 'Fine summary');
});

export default { myFines, listAll, getFine, payFine, waiveFine, createFine, getSummary };
