/**
 * ---------------------------------------------------------------------------
 * FINE SERVICE
 * ---------------------------------------------------------------------------
 * Settling, waiving and reporting on charges.
 *
 * Every state change here recomputes the member's cached outstanding total
 * from the Fine collection rather than adjusting it by the amount involved.
 * That cached number gates borrowing, so it being wrong means either blocking
 * someone who owes nothing or letting someone borrow who owes a fortune —
 * and a recompute is self-correcting where an increment drifts.
 * ---------------------------------------------------------------------------
 */

import config from '../config/index.js';
import logger from '../utils/logger.js';
import { Fine } from '../models/Fine.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { FINE_STATUS, FINE_REASON, NOTIFICATION_TYPE } from '../constants/enums.js';
import { parsePagination, parseSort, paginateQuery } from '../utils/pagination.js';
import { refreshUserFineTotal } from './loan.service.js';

export const getById = async (fineId) => {
  const fine = await Fine.findById(fineId)
    .populate('user', 'name email membershipNumber')
    .populate('book', 'title slug')
    .populate('loan', 'dueAt returnedAt issuedAt');

  if (!fine) throw ApiError.notFound('No such fine', ERROR_CODES.FINE_NOT_FOUND);
  return fine;
};

/** A member's own fines. */
export const listForUser = async (userId, query = {}) => {
  const { page, limit, skip } = parsePagination(query);
  const sort = parseSort(query.sort, ['createdAt', 'amount', 'paidAt'], { createdAt: -1 });

  const filter = { user: userId };
  if (query.status) filter.status = query.status;

  const result = await paginateQuery(Fine, filter, {
    sort,
    page,
    limit,
    skip,
    populate: [
      { path: 'book', select: 'title slug coverImage' },
      { path: 'loan', select: 'dueAt returnedAt' },
    ],
  });

  const { total: outstanding, count } = await Fine.outstandingTotalForUser(userId);

  return {
    ...result,
    summary: {
      outstanding,
      outstandingCount: count,
      currency: config.library.fines.currency,
      blockThreshold: config.library.fines.blockBorrowingAbove,
      // The line a client actually needs: is this member currently blocked?
      isBlocked: outstanding > config.library.fines.blockBorrowingAbove,
    },
  };
};

/** Staff-facing list across all members. */
export const listAll = async (query = {}) => {
  const { page, limit, skip } = parsePagination(query);
  const sort = parseSort(query.sort, ['createdAt', 'amount', 'paidAt'], { createdAt: -1 });

  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.reason) filter.reason = query.reason;
  if (query.userId) filter.user = query.userId;

  return paginateQuery(Fine, filter, {
    sort,
    page,
    limit,
    skip,
    populate: [
      { path: 'user', select: 'name email membershipNumber' },
      { path: 'book', select: 'title slug' },
    ],
  });
};

/**
 * Record payment of a fine.
 *
 * No payment gateway is integrated — this records that money changed hands at
 * the desk, which is how library fines are actually settled. `paymentReference`
 * carries the receipt number from whatever did handle it.
 */
export const markPaid = async (fineId, { collectedBy, paymentMethod = 'CASH', paymentReference = null }) => {
  const fine = await Fine.findById(fineId);
  if (!fine) throw ApiError.notFound('No such fine', ERROR_CODES.FINE_NOT_FOUND);

  if (fine.status !== FINE_STATUS.PENDING) {
    throw ApiError.conflict(
      `This fine has already been ${fine.status.toLowerCase()}`,
      ERROR_CODES.FINE_ALREADY_SETTLED,
      { details: { status: fine.status, paidAt: fine.paidAt, waivedAt: fine.waivedAt } }
    );
  }

  fine.status = FINE_STATUS.PAID;
  fine.paidAt = new Date();
  fine.collectedBy = collectedBy;
  fine.paymentMethod = paymentMethod;
  fine.paymentReference = paymentReference;
  await fine.save();

  await Promise.all([
    refreshUserFineTotal(fine.user),
    User.updateOne({ _id: fine.user }, { $inc: { 'stats.totalFinesPaid': fine.amount } }),
  ]);

  logger.info('Fine paid', {
    fineId: String(fine._id),
    amount: fine.amount,
    collectedBy: String(collectedBy),
  });

  return fine;
};

/**
 * Forgive a fine.
 *
 * The NOTE IS MANDATORY, and that is not bureaucracy: a waiver is staff
 * writing off money the library was owed. Without a recorded reason it is
 * indistinguishable from a mistake or a favour, and there is no way to answer
 * "why was this cancelled?" six months later. The audit log records who did it;
 * the note records why.
 */
export const waive = async (fineId, { waivedBy, note }) => {
  if (!note || note.trim().length < 5) {
    throw ApiError.badRequest(
      'A reason is required when waiving a fine',
      ERROR_CODES.WAIVER_NOTE_REQUIRED
    );
  }

  const fine = await Fine.findById(fineId);
  if (!fine) throw ApiError.notFound('No such fine', ERROR_CODES.FINE_NOT_FOUND);

  if (fine.status !== FINE_STATUS.PENDING) {
    throw ApiError.conflict(
      `This fine has already been ${fine.status.toLowerCase()}`,
      ERROR_CODES.FINE_ALREADY_SETTLED
    );
  }

  fine.status = FINE_STATUS.WAIVED;
  fine.waivedAt = new Date();
  fine.waivedBy = waivedBy;
  fine.waiverNote = note.trim();
  await fine.save();

  await refreshUserFineTotal(fine.user);

  logger.warn('Fine waived', {
    fineId: String(fine._id),
    amount: fine.amount,
    waivedBy: String(waivedBy),
    note: fine.waiverNote,
  });

  return fine;
};

/** Raise a charge by hand — damage found after return, a replaced item. */
export const createManual = async ({ userId, bookId, loanId, reason, amount, description }, assessedBy) => {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('No such member', ERROR_CODES.USER_NOT_FOUND);

  const fine = await Fine.create({
    user: userId,
    book: bookId ?? null,
    loan: loanId ?? null,
    reason: reason ?? FINE_REASON.MANUAL,
    amount,
    description,
    assessedBy,
  });

  await refreshUserFineTotal(userId);

  logger.info('Manual fine raised', {
    fineId: String(fine._id),
    userId: String(userId),
    amount,
    assessedBy: String(assessedBy),
  });

  return fine;
};

/**
 * Fine totals for a period, for the admin dashboard.
 *
 * One `$facet` pass rather than three separate aggregations over the same
 * collection — and the three figures cannot disagree with each other, which
 * they could if a write landed between separate queries.
 */
export const getSummary = async ({ from, to } = {}) => {
  const match = {};
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = new Date(from);
    if (to) match.createdAt.$lte = new Date(to);
  }

  const [result] = await Fine.aggregate([
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    {
      $facet: {
        byStatus: [
          { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } },
          { $project: { _id: 0, status: '$_id', total: 1, count: 1 } },
        ],
        byReason: [
          { $group: { _id: '$reason', total: { $sum: '$amount' }, count: { $sum: 1 } } },
          { $project: { _id: 0, reason: '$_id', total: 1, count: 1 } },
        ],
        topDebtors: [
          { $match: { status: FINE_STATUS.PENDING } },
          { $group: { _id: '$user', total: { $sum: '$amount' }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
          { $limit: 10 },
          { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
          { $unwind: '$user' },
          {
            $project: {
              _id: 0,
              userId: '$_id',
              name: '$user.name',
              membershipNumber: '$user.membershipNumber',
              total: 1,
              count: 1,
            },
          },
        ],
      },
    },
  ]);

  const byStatus = result?.byStatus ?? [];
  const find = (status) => byStatus.find((entry) => entry.status === status);

  return {
    currency: config.library.fines.currency,
    outstanding: find(FINE_STATUS.PENDING)?.total ?? 0,
    outstandingCount: find(FINE_STATUS.PENDING)?.count ?? 0,
    collected: find(FINE_STATUS.PAID)?.total ?? 0,
    collectedCount: find(FINE_STATUS.PAID)?.count ?? 0,
    waived: find(FINE_STATUS.WAIVED)?.total ?? 0,
    waivedCount: find(FINE_STATUS.WAIVED)?.count ?? 0,
    byReason: result?.byReason ?? [],
    topDebtors: result?.topDebtors ?? [],
  };
};

export default { getById, listForUser, listAll, markPaid, waive, createManual, getSummary };
