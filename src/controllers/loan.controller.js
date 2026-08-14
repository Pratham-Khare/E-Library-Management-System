/**
 * ---------------------------------------------------------------------------
 * LOAN CONTROLLER
 * ---------------------------------------------------------------------------
 * Self-service borrowing for members, and the circulation desk for staff.
 *
 * The two paths differ in WHO the loan belongs to, not in the rules applied:
 * a librarian issuing a book on someone's behalf runs the same eligibility
 * checks. Staff can override the due date; they cannot override the limits.
 * ---------------------------------------------------------------------------
 */

import * as loanService from '../services/loan.service.js';
import { User } from '../models/User.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, paginated } from '../utils/ApiResponse.js';
import { toLoan, listLoans, toBorrowResponse, toFine } from '../serializers/circulation.serializer.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { LOAN_TYPE } from '../constants/enums.js';

const isStaff = (user) => Boolean(user) && ['LIBRARIAN', 'ADMIN'].includes(user.role);

/* ===========================================================================
 * Borrowing
 * ======================================================================== */

/** Borrow for yourself. */
export const borrow = asyncHandler(async (req, res) => {
  const { bookId, type } = req.body;

  const result =
    type === LOAN_TYPE.DIGITAL
      ? await loanService.borrowDigital(req.user, bookId)
      : await loanService.borrowPhysical(req.user, bookId);

  return created(
    res,
    toBorrowResponse(result, req.user),
    type === LOAN_TYPE.DIGITAL
      ? `Digital loan issued. It expires on ${new Date(result.loan.dueAt).toDateString()}.`
      : `Borrowed. Please return it by ${new Date(result.loan.dueAt).toDateString()}.`
  );
});

/**
 * Circulation desk: issue on behalf of a member.
 *
 * Runs the SAME eligibility checks as self-service. A librarian may set a
 * different due date, but cannot bypass loan limits, overdue blocks or fine
 * thresholds — those are library policy, not a desk preference.
 */
export const issue = asyncHandler(async (req, res) => {
  const { bookId, userId, type, dueAt, note } = req.body;

  const member = await User.findById(userId);
  if (!member) throw ApiError.notFound('No such member', ERROR_CODES.USER_NOT_FOUND);

  const result =
    type === LOAN_TYPE.DIGITAL
      ? await loanService.borrowDigital(member, bookId)
      : await loanService.borrowPhysical(member, bookId, {
          issuedBy: req.user.id,
          dueAtOverride: dueAt,
        });

  if (note) {
    result.loan.notes = note;
    await result.loan.save();
  }

  return created(
    res,
    toBorrowResponse(result, member),
    `Issued to ${member.name}. Due ${new Date(result.loan.dueAt).toDateString()}.`
  );
});

/* ===========================================================================
 * Returning
 * ======================================================================== */

/**
 * Return a book.
 *
 * Members may return their own; staff may return anyone's — which is the
 * normal case, since returns happen at a desk.
 */
export const returnLoan = asyncHandler(async (req, res) => {
  const loan = await loanService.getById(req.params.loanId);

  const isOwner = String(loan.user._id ?? loan.user) === String(req.user.id);
  if (!isOwner && !isStaff(req.user)) {
    throw ApiError.forbidden('This is not your loan', ERROR_CODES.NOT_RESOURCE_OWNER);
  }

  // Digital loans expire on their own; "returning" one just releases the
  // licence early so someone else can read it.
  if (loan.type === LOAN_TYPE.DIGITAL) {
    const expired = await loanService.returnDigital(req.params.loanId, loan.user._id ?? loan.user);
    return ok(res, { loan: toLoan(expired) }, 'Digital loan ended and the licence released');
  }

  const { loan: returned, fine, daysOverdue } = await loanService.returnPhysical(req.params.loanId, {
    returnedTo: isStaff(req.user) ? req.user.id : null,
    condition: req.body.condition,
    note: req.body.note,
  });

  return ok(
    res,
    {
      loan: toLoan(returned),
      fine: fine ? toFine(fine) : null,
      daysOverdue,
    },
    fine
      ? `Returned ${daysOverdue} day(s) late. A fine of ${fine.currency} ${fine.amount.toFixed(2)} has been added to the account.`
      : 'Returned. Thank you.'
  );
});

/* ===========================================================================
 * Renewing
 * ======================================================================== */

export const renew = asyncHandler(async (req, res) => {
  const loan = await loanService.getById(req.params.loanId);

  const isOwner = String(loan.user._id ?? loan.user) === String(req.user.id);
  if (!isOwner && !isStaff(req.user)) {
    throw ApiError.forbidden('This is not your loan', ERROR_CODES.NOT_RESOURCE_OWNER);
  }

  const result = await loanService.renew(req.params.loanId, {
    renewedBy: isStaff(req.user) && !isOwner ? req.user.id : null,
  });

  return ok(
    res,
    {
      loan: toLoan(result.loan),
      previousDueAt: result.previousDueAt,
      newDueAt: result.newDueAt,
      renewalsRemaining: result.renewalsRemaining,
    },
    `Renewed until ${new Date(result.newDueAt).toDateString()}. ${result.renewalsRemaining} renewal(s) remaining.`
  );
});

/* ===========================================================================
 * Lost items
 * ======================================================================== */

export const markLost = asyncHandler(async (req, res) => {
  const { loan, fine } = await loanService.markLost(req.params.loanId, {
    markedBy: req.user.id,
    note: req.body.note,
  });

  return ok(
    res,
    { loan: toLoan(loan), fine: toFine(fine) },
    `Marked lost. A replacement charge of ${fine.currency} ${fine.amount.toFixed(2)} has been added.`
  );
});

/* ===========================================================================
 * Reading
 * ======================================================================== */

/** The caller's own loans. */
export const myLoans = asyncHandler(async (req, res) => {
  const { items, meta } = await loanService.listForUser(req.user.id, req.query);
  return paginated(res, listLoans(items), meta, 'Your loans');
});

/** Staff-facing list across all members. */
export const listAll = asyncHandler(async (req, res) => {
  const { items, meta } = await loanService.listAll(req.query);
  return paginated(res, listLoans(items, { includeUser: true }), meta, 'Loans fetched');
});

export const getLoan = asyncHandler(async (req, res) => {
  const loan = await loanService.getById(req.params.loanId);

  const isOwner = String(loan.user._id ?? loan.user) === String(req.user.id);
  if (!isOwner && !isStaff(req.user)) {
    throw ApiError.forbidden('This is not your loan', ERROR_CODES.NOT_RESOURCE_OWNER);
  }

  return ok(res, toLoan(loan, { includeUser: isStaff(req.user) }), 'Loan fetched');
});


/**
 * Can the caller borrow right now, and if not, why?
 *
 * Lets a client disable a "Borrow" button with an accurate explanation instead
 * of letting the member click it and receive an error. The eligibility rules
 * live in one place and are simply queried here.
 */
export const checkEligibility = asyncHandler(async (req, res) => {
  try {
    const result = await loanService.assertEligibleToBorrow(req.user, req.query.bookId);
    return ok(
      res,
      {
        eligible: true,
        currentLoans: result.openLoans,
        maxLoans: result.policy.maxActiveLoans,
        outstandingFines: result.outstanding,
      },
      'You can borrow this book'
    );
  } catch (error) {
    // A refusal is not an error HERE — it is the answer to the question.
    if (error.statusCode === 409 || error.statusCode === 403) {
      return ok(
        res,
        { eligible: false, reason: error.message, code: error.code, details: error.details },
        'You cannot borrow this book at the moment'
      );
    }
    throw error;
  }
});

export default {
  borrow,
  issue,
  returnLoan,
  renew,
  markLost,
  myLoans,
  listAll,
  getLoan,
  checkEligibility,
};
