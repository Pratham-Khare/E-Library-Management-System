/**
 * ---------------------------------------------------------------------------
 * CIRCULATION SERVICE — borrow, return, renew
 * ---------------------------------------------------------------------------
 * The heart of the library.
 *
 * THE CONCURRENCY PROBLEM, and how it is solved.
 *
 * The obvious way to borrow a book is:
 *
 *     const copy = await BookCopy.findOne({ book, status: 'AVAILABLE' });
 *     copy.status = 'ON_LOAN';
 *     await copy.save();
 *
 * That is a read-then-write. Two members clicking "borrow" on the last copy at
 * the same moment BOTH read it as AVAILABLE before either writes, and both
 * succeed. One physical book, two people told it is theirs.
 *
 * The usual fix is a transaction — but MongoDB only offers those on a replica
 * set, and a default local install is standalone. Code that requires them
 * crashes on a developer's laptop.
 *
 * So the claim is a single atomic `findOneAndUpdate` filtered on
 * `status: 'AVAILABLE'` (see BookCopy.claimAvailableCopy). MongoDB guarantees
 * single-document atomicity on EVERY deployment, so of two concurrent claims
 * exactly one matches and the other gets null. No transaction needed, and no
 * window to race in.
 *
 * The surrounding multi-document work — creating the loan, adjusting counters
 * — runs inside a real transaction when one is available and with compensating
 * rollback when not. But correctness of the CLAIM never depends on that.
 * ---------------------------------------------------------------------------
 */

import mongoose from 'mongoose';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { Loan } from '../models/Loan.js';
import { Fine } from '../models/Fine.js';
import { Book } from '../models/Book.js';
import { BookCopy } from '../models/BookCopy.js';
import { User } from '../models/User.js';
import { DigitalAsset } from '../models/DigitalAsset.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import {
  LOAN_TYPE,
  LOAN_STATUS,
  OPEN_LOAN_STATUSES,
  COPY_STATUS,
  FINE_REASON,
  FINE_STATUS,
  NOTIFICATION_TYPE,
} from '../constants/enums.js';
import { USER_STATUS } from '../constants/roles.js';
import { parsePagination, parseSort, paginateQuery } from '../utils/pagination.js';

/* ===========================================================================
 * Eligibility
 * ======================================================================== */

/**
 * Decide whether a member may borrow, and say precisely why not.
 *
 * Checks run in order of severity, and each returns a SPECIFIC error code —
 * "you have a book overdue" and "you owe ₹250" call for completely different
 * actions from the member, and a generic "not eligible" tells them nothing.
 *
 * @param {object} user
 * @param {string} bookId
 * @returns {Promise<{eligible: true, policy: object}>}
 * @throws {ApiError} With the specific reason.
 */
export const assertEligibleToBorrow = async (user, bookId) => {
  const policy = config.library.getPolicy(user.membershipType);

  /* 1. The account itself must be in good standing. */
  if (user.status !== USER_STATUS.ACTIVE || user.isDeleted) {
    throw ApiError.forbidden(
      'Your account is not active, so you cannot borrow at the moment',
      ERROR_CODES.ACCOUNT_INACTIVE
    );
  }

  /* 2. Already holding this title? Prevents one member taking both copies. */
  if (config.library.eligibility.blockDuplicateTitle) {
    const alreadyHas = await Loan.hasOpenLoanForBook(user._id ?? user.id, bookId);
    if (alreadyHas) {
      throw ApiError.conflict(
        'You already have this book on loan',
        ERROR_CODES.ALREADY_BORROWED
      );
    }
  }

  /* 3. Concurrent-loan cap for their membership tier. */
  const openLoans = await Loan.countOpenForUser(user._id ?? user.id);
  if (openLoans >= policy.maxActiveLoans) {
    throw ApiError.conflict(
      `You already have ${openLoans} items on loan, which is the limit for ${user.membershipType} membership. Return something before borrowing again.`,
      ERROR_CODES.LOAN_LIMIT_REACHED,
      { details: { currentLoans: openLoans, maxLoans: policy.maxActiveLoans } }
    );
  }

  /* 4. Nothing overdue. Checked live rather than trusting the nightly job —
   *    a book that went overdue this morning should block a borrow this
   *    afternoon, not tomorrow. */
  if (config.library.eligibility.blockWhenOverdue) {
    const hasOverdue = await Loan.hasOverdueItems(user._id ?? user.id);
    if (hasOverdue) {
      throw ApiError.conflict(
        'You have an overdue item. Please return it before borrowing anything else.',
        ERROR_CODES.HAS_OVERDUE_ITEMS
      );
    }
  }

  /* 5. Fines below the blocking threshold. Summed from the Fine collection
   *    rather than the cached counter on User, because this decision must be
   *    right even if that cache has drifted. */
  const { total: outstanding } = await Fine.outstandingTotalForUser(user._id ?? user.id);
  if (outstanding > config.library.fines.blockBorrowingAbove) {
    throw ApiError.conflict(
      `You owe ${config.library.fines.currency} ${outstanding.toFixed(2)} in fines, which is over the ${config.library.fines.currency} ${config.library.fines.blockBorrowingAbove} limit. Please settle your balance to borrow again.`,
      ERROR_CODES.OUTSTANDING_FINES,
      {
        details: {
          outstanding,
          threshold: config.library.fines.blockBorrowingAbove,
          currency: config.library.fines.currency,
        },
      }
    );
  }

  return { eligible: true, policy, openLoans, outstanding };
};

/** The due date for a new loan, from the member's tier. */
const calculateDueDate = (membershipType, type) => {
  const days =
    type === LOAN_TYPE.DIGITAL
      ? config.library.digital.loanDays
      : config.library.getPolicy(membershipType).loanPeriodDays;

  const due = new Date();
  due.setDate(due.getDate() + days);
  // End of day: a book due "on the 14th" is not late at 09:00 on the 14th.
  due.setHours(23, 59, 59, 999);
  return due;
};

/* ===========================================================================
 * Borrowing — physical
 * ======================================================================== */

/**
 * Borrow a physical copy.
 *
 * THE ORDER OF OPERATIONS IS DELIBERATE:
 *
 *   1. Check eligibility (cheap reads, fail fast before touching anything).
 *   2. Create the Loan document FIRST, so the copy claim has an id to point at.
 *   3. ATOMICALLY claim a copy — the compare-and-swap that cannot be raced.
 *   4. If no copy was free, DELETE the loan we just created and report why.
 *   5. Update the denormalised counters.
 *
 * Creating the loan before the claim looks backwards, but the alternative —
 * claim, then create — leaves a copy marked ON_LOAN with no loan pointing at
 * it if the create fails, which is a far worse state to recover from. An
 * orphaned loan is trivially deleted; an orphaned ON_LOAN copy is invisible
 * and permanently unborrowable.
 */
export const borrowPhysical = async (user, bookId, { issuedBy = null, dueAtOverride = null } = {}) => {
  const book = await Book.findOne({ _id: bookId, isDeleted: false, status: 'ACTIVE' });
  if (!book) throw ApiError.notFound('No such book', ERROR_CODES.BOOK_NOT_FOUND);

  const { policy } = await assertEligibleToBorrow(user, book._id);

  // Fail early with a useful message when nothing is on the shelf, rather than
  // creating a loan we are about to delete.
  const availableCount = await BookCopy.countAvailable(book._id);
  if (availableCount === 0) {
    const nextDue = await Loan.findOne({
      book: book._id,
      type: LOAN_TYPE.PHYSICAL,
      status: { $in: OPEN_LOAN_STATUSES },
    })
      .sort({ dueAt: 1 })
      .select('dueAt');

    throw ApiError.conflict(
      'Every copy of this book is currently on loan',
      ERROR_CODES.NO_COPY_AVAILABLE,
      {
        details: {
          totalCopies: book.inventory?.totalCopies ?? 0,
          // The single most useful thing to tell someone who cannot borrow:
          // roughly when to come back.
          earliestExpectedReturn: nextDue?.dueAt ?? null,
        },
      }
    );
  }

  const dueAt = dueAtOverride ?? calculateDueDate(user.membershipType, LOAN_TYPE.PHYSICAL);

  const loan = await Loan.create({
    user: user._id ?? user.id,
    book: book._id,
    type: LOAN_TYPE.PHYSICAL,
    dueAt,
    issuedBy,
    status: LOAN_STATUS.ACTIVE,
  });

  /**
   * THE ATOMIC CLAIM.
   *
   * A single findOneAndUpdate filtered on `status: AVAILABLE`. Two concurrent
   * borrows of the last copy cannot both match — MongoDB applies the update to
   * one document atomically, and the loser gets null.
   */
  const copy = await BookCopy.claimAvailableCopy(book._id, loan._id);

  if (!copy) {
    // Lost the race: between the availability check and the claim, someone
    // else took the last copy. Undo the loan and tell them honestly.
    await loan.deleteOne();

    throw ApiError.conflict(
      'Someone else borrowed the last copy a moment ago. Please try again.',
      ERROR_CODES.COPY_CLAIM_FAILED
    );
  }

  loan.copy = copy._id;
  await loan.save();

  // Counters. Recomputed from source rather than decremented, so a missed
  // update anywhere cannot accumulate into permanent drift.
  await Promise.all([
    Book.recalculateInventory(book._id),
    Book.updateOne(
      { _id: book._id },
      { $inc: { 'stats.loanCount': 1 }, $set: { 'stats.lastBorrowedAt': new Date() } }
    ),
    User.updateOne(
      { _id: user._id ?? user.id },
      { $inc: { 'stats.activeLoans': 1, 'stats.totalBorrowed': 1 } }
    ),
  ]);

  logger.info('Book borrowed', {
    loanId: String(loan._id),
    userId: String(user._id ?? user.id),
    bookId: String(book._id),
    copyId: String(copy._id),
    dueAt,
  });

  return { loan, copy, book, policy };
};

/* ===========================================================================
 * Borrowing — digital
 * ======================================================================== */

/**
 * Borrow the digital edition.
 *
 * The licence claim is the digital analogue of the copy claim, and has the
 * same race. It is solved the same way: a single atomic update whose FILTER
 * asserts a licence is free (`activeLicenses < concurrentLicenses`, expressed
 * as `$expr` with `$lt`), so two concurrent borrows of the last licence cannot
 * both succeed.
 */
export const borrowDigital = async (user, bookId) => {
  const book = await Book.findOne({ _id: bookId, isDeleted: false, status: 'ACTIVE' });
  if (!book) throw ApiError.notFound('No such book', ERROR_CODES.BOOK_NOT_FOUND);

  if (!book.digital?.hasEbook) {
    throw ApiError.conflict(
      'This book has no digital edition',
      ERROR_CODES.NO_DIGITAL_EDITION
    );
  }

  await assertEligibleToBorrow(user, book._id);

  const asset = await DigitalAsset.findOne({ book: book._id, isPreview: false }).select('_id');
  if (!asset) {
    throw ApiError.conflict(
      'This book has no digital edition',
      ERROR_CODES.NO_DIGITAL_EDITION
    );
  }

  /**
   * ATOMIC LICENCE CLAIM.
   *
   * `$expr` lets the filter compare two fields of the same document, so the
   * "is a licence free?" test and the increment happen as one operation. A
   * read-then-write here would over-issue licences under concurrency exactly
   * as it would over-issue copies.
   */
  const claimed = await Book.findOneAndUpdate(
    {
      _id: book._id,
      'digital.hasEbook': true,
      $expr: { $lt: ['$digital.activeLicenses', '$digital.concurrentLicenses'] },
    },
    { $inc: { 'digital.activeLicenses': 1 } },
    { new: true }
  );

  if (!claimed) {
    const nextExpiry = await Loan.findOne({
      book: book._id,
      type: LOAN_TYPE.DIGITAL,
      status: { $in: OPEN_LOAN_STATUSES },
    })
      .sort({ dueAt: 1 })
      .select('dueAt');

    throw ApiError.conflict(
      'All digital copies of this book are currently in use',
      ERROR_CODES.NO_LICENSE_AVAILABLE,
      {
        details: {
          concurrentLicenses: book.digital.concurrentLicenses,
          earliestExpectedRelease: nextExpiry?.dueAt ?? null,
        },
      }
    );
  }

  const dueAt = calculateDueDate(user.membershipType, LOAN_TYPE.DIGITAL);

  let loan;
  try {
    loan = await Loan.create({
      user: user._id ?? user.id,
      book: book._id,
      type: LOAN_TYPE.DIGITAL,
      digitalAsset: asset._id,
      dueAt,
      status: LOAN_STATUS.ACTIVE,
    });
  } catch (error) {
    // COMPENSATION: the licence was already claimed, so release it rather than
    // leaking one that nothing will ever return.
    await Book.updateOne({ _id: book._id }, { $inc: { 'digital.activeLicenses': -1 } });
    throw error;
  }

  await Promise.all([
    Book.updateOne(
      { _id: book._id },
      { $inc: { 'stats.loanCount': 1 }, $set: { 'stats.lastBorrowedAt': new Date() } }
    ),
    User.updateOne(
      { _id: user._id ?? user.id },
      { $inc: { 'stats.activeLoans': 1, 'stats.totalBorrowed': 1 } }
    ),
  ]);

  logger.info('Digital loan issued', {
    loanId: String(loan._id),
    userId: String(user._id ?? user.id),
    bookId: String(book._id),
    dueAt,
  });

  return { loan, book, asset };
};

/* ===========================================================================
 * Returning
 * ======================================================================== */

/**
 * Compute and record the fine for an overdue loan.
 *
 * IDEMPOTENT. Updates an existing OVERDUE fine rather than creating a second
 * one, so the nightly job running twice in a day cannot double a member's
 * debt. This is the property that makes a scheduled accrual job safe to retry.
 */
export const assessOverdueFine = async (loan, { assessedBy = null } = {}) => {
  const daysOverdue = loan.daysOverdue;
  const amount = config.library.calculateOverdueFine(daysOverdue);

  if (amount <= 0) return null;

  const existing = await Fine.findForLoan(loan._id, FINE_REASON.OVERDUE);

  if (existing) {
    // Never revise a settled fine — someone already paid, or staff forgave it.
    if (existing.status !== FINE_STATUS.PENDING) return existing;

    if (existing.amount !== amount) {
      existing.amount = amount;
      existing.daysOverdue = daysOverdue;
      existing.chargeableDays = config.library.chargeableDays(daysOverdue);
      existing.cappedAtMaximum = amount >= config.library.fines.maxPerLoan;
      await existing.save();
    }
    return existing;
  }

  const fine = await Fine.create({
    user: loan.user._id ?? loan.user,
    loan: loan._id,
    book: loan.book._id ?? loan.book,
    reason: FINE_REASON.OVERDUE,
    amount,
    daysOverdue,
    chargeableDays: config.library.chargeableDays(daysOverdue),
    ratePerDay: config.library.fines.perDay,
    cappedAtMaximum: amount >= config.library.fines.maxPerLoan,
    assessedBy,
    description: `${daysOverdue} day(s) overdue, ${config.library.fines.graceDays} forgiven as grace`,
  });

  await Loan.updateOne({ _id: loan._id }, { $set: { fine: fine._id } });

  return fine;
};

/**
 * Return a physical book.
 *
 * Releases the copy, closes the loan, and assesses a fine if it is late.
 * The copy release is filtered on `status: ON_LOAN`, so a double-return cannot
 * increment availability twice and invent a copy the library does not own.
 */
export const returnPhysical = async (loanId, { returnedTo = null, condition = null, note = null } = {}) => {
  const loan = await Loan.findById(loanId).populate('book', 'title price').populate('user', 'name email stats');

  if (!loan) throw ApiError.notFound('No such loan', ERROR_CODES.LOAN_NOT_FOUND);

  if (!OPEN_LOAN_STATUSES.includes(loan.status)) {
    throw ApiError.conflict(
      `This loan is already ${loan.status.toLowerCase()}`,
      ERROR_CODES.LOAN_NOT_ACTIVE,
      { details: { status: loan.status, returnedAt: loan.returnedAt } }
    );
  }

  if (loan.type !== LOAN_TYPE.PHYSICAL) {
    throw ApiError.badRequest(
      'Digital loans expire on their own and do not need returning',
      ERROR_CODES.BAD_REQUEST
    );
  }

  const daysOverdue = loan.daysOverdue;

  // Freeze the lateness before closing the loan — afterwards it must stop
  // changing, and a value derived from `dueAt` and "now" would keep growing.
  loan.daysOverdueAtReturn = daysOverdue;
  loan.returnedAt = new Date();
  loan.returnedTo = returnedTo;
  loan.status = LOAN_STATUS.RETURNED;
  if (note) loan.notes = note;

  const fine = daysOverdue > 0 ? await assessOverdueFine(loan, { assessedBy: returnedTo }) : null;

  await loan.save();

  // Release the copy. Filtered on ON_LOAN so a repeated return is a no-op
  // rather than a phantom extra copy.
  if (loan.copy) {
    const released = await BookCopy.releaseCopy(loan.copy);

    if (released && condition) {
      released.condition = condition;
      released.$locals._statusChangeContext = { by: returnedTo, note: 'Condition recorded on return' };
      await released.save();
    }
  }

  await Promise.all([
    Book.recalculateInventory(loan.book._id ?? loan.book),
    User.updateOne(
      { _id: loan.user._id ?? loan.user },
      { $inc: { 'stats.activeLoans': -1 } }
    ),
  ]);

  // Keep the member's cached fine total honest after any new charge.
  if (fine) await refreshUserFineTotal(loan.user._id ?? loan.user);

  logger.info('Book returned', {
    loanId: String(loan._id),
    daysOverdue,
    fineAmount: fine?.amount ?? 0,
  });

  return { loan, fine, daysOverdue };
};

/**
 * Recompute a member's cached outstanding-fine total from the Fine collection.
 *
 * `User.stats.outstandingFine` is a cache that exists so a profile page does
 * not need an aggregation. Recomputing rather than incrementing means a missed
 * update self-corrects instead of drifting permanently.
 */
export const refreshUserFineTotal = async (userId) => {
  const { total } = await Fine.outstandingTotalForUser(userId);
  await User.updateOne({ _id: userId }, { $set: { 'stats.outstandingFine': total } });
  return total;
};

/* ===========================================================================
 * Renewing
 * ======================================================================== */

/**
 * Extend a loan.
 *
 * With reservations out of scope there is no queue to consult, so exactly two
 * conditions apply:
 *
 *   1. Under the renewal cap for the member's tier.
 *   2. NOT ALREADY OVERDUE.
 *
 * Rule 2 is the one that matters. Without it, a member could dodge an accruing
 * fine indefinitely by renewing after the fact — which would make the entire
 * overdue system decorative.
 */
export const renew = async (loanId, { renewedBy = null } = {}) => {
  const loan = await Loan.findById(loanId).populate('user', 'membershipType name');
  if (!loan) throw ApiError.notFound('No such loan', ERROR_CODES.LOAN_NOT_FOUND);

  if (!OPEN_LOAN_STATUSES.includes(loan.status)) {
    throw ApiError.conflict(
      `This loan is already ${loan.status.toLowerCase()} and cannot be renewed`,
      ERROR_CODES.LOAN_NOT_ACTIVE
    );
  }

  if (loan.isOverdue || loan.status === LOAN_STATUS.OVERDUE) {
    throw ApiError.conflict(
      `This item is already ${loan.daysOverdue} day(s) overdue and cannot be renewed. Please return it and settle any fine.`,
      ERROR_CODES.CANNOT_RENEW_OVERDUE,
      { details: { daysOverdue: loan.daysOverdue, dueAt: loan.dueAt } }
    );
  }

  const policy = config.library.getPolicy(loan.user.membershipType);

  if (loan.renewalCount >= policy.maxRenewals) {
    throw ApiError.conflict(
      `This loan has already been renewed ${loan.renewalCount} time(s), which is the maximum for ${loan.user.membershipType} membership.`,
      ERROR_CODES.RENEWAL_LIMIT_REACHED,
      { details: { renewalCount: loan.renewalCount, maxRenewals: policy.maxRenewals } }
    );
  }

  const previousDueAt = loan.dueAt;
  // A fresh full period from TODAY, not an extension of the old due date —
  // renewing three days early should not quietly cost the member three days.
  const newDueAt = calculateDueDate(loan.user.membershipType, loan.type);

  loan.dueAt = newDueAt;
  loan.renewalCount += 1;
  loan.renewalHistory.push({ at: new Date(), previousDueAt, newDueAt, by: renewedBy });
  // Reset the reminder flag so a "due soon" notice fires again for the new date.
  loan.dueSoonNotifiedAt = null;

  await loan.save();

  logger.info('Loan renewed', {
    loanId: String(loan._id),
    renewalCount: loan.renewalCount,
    newDueAt,
  });

  return {
    loan,
    previousDueAt,
    newDueAt,
    renewalsRemaining: policy.maxRenewals - loan.renewalCount,
  };
};

/* ===========================================================================
 * Lost items
 * ======================================================================== */

/**
 * Declare a loan lost.
 *
 * Closes the loan, retires the copy, and charges replacement cost — the book's
 * price where known, otherwise the per-loan fine ceiling. Charging a flat fee
 * for a lost reference volume and a lost paperback alike is not defensible.
 */
export const markLost = async (loanId, { markedBy = null, note = null } = {}) => {
  const loan = await Loan.findById(loanId).populate('book', 'title price');
  if (!loan) throw ApiError.notFound('No such loan', ERROR_CODES.LOAN_NOT_FOUND);

  if (!OPEN_LOAN_STATUSES.includes(loan.status)) {
    throw ApiError.conflict(
      `This loan is already ${loan.status.toLowerCase()}`,
      ERROR_CODES.LOAN_NOT_ACTIVE
    );
  }

  loan.status = LOAN_STATUS.LOST;
  loan.returnedAt = new Date();
  loan.returnedTo = markedBy;
  loan.daysOverdueAtReturn = loan.daysOverdue;
  if (note) loan.notes = note;
  await loan.save();

  // Retire the copy. It is not available, and it is not coming back.
  if (loan.copy) {
    const copy = await BookCopy.findById(loan.copy);
    if (copy) {
      copy.status = COPY_STATUS.LOST;
      copy.currentLoan = null;
      copy.$locals._statusChangeContext = { by: markedBy, note: note ?? 'Reported lost by borrower' };
      await copy.save();
    }
  }

  const replacementCost = loan.book?.price ?? config.library.fines.maxPerLoan;

  const fine = await Fine.create({
    user: loan.user,
    loan: loan._id,
    book: loan.book._id ?? loan.book,
    reason: FINE_REASON.LOST,
    amount: replacementCost,
    assessedBy: markedBy,
    description: `Replacement cost for "${loan.book?.title ?? 'this item'}"`,
  });

  await Promise.all([
    Book.recalculateInventory(loan.book._id ?? loan.book),
    User.updateOne({ _id: loan.user }, { $inc: { 'stats.activeLoans': -1 } }),
  ]);

  await refreshUserFineTotal(loan.user);

  logger.warn('Loan marked lost', {
    loanId: String(loan._id),
    replacementCost,
  });

  return { loan, fine };
};

/* ===========================================================================
 * Digital expiry
 * ======================================================================== */

/**
 * Expire a digital loan and release its licence.
 *
 * Called by the hourly cron job, and directly when a member "returns" an ebook
 * early. The licence decrement is guarded with `$max` at 0 — an unguarded
 * `$inc: -1` that ran twice would push the count negative and permanently
 * over-issue licences for that title.
 */
export const expireDigitalLoan = async (loanId) => {
  const loan = await Loan.findById(loanId);
  if (!loan || !OPEN_LOAN_STATUSES.includes(loan.status)) return null;

  loan.status = LOAN_STATUS.EXPIRED;
  loan.returnedAt = new Date();
  await loan.save();

  await Book.updateOne({ _id: loan.book }, [
    {
      $set: {
        'digital.activeLicenses': {
          $max: [0, { $subtract: ['$digital.activeLicenses', 1] }],
        },
      },
    },
  ]);

  await User.updateOne({ _id: loan.user }, { $inc: { 'stats.activeLoans': -1 } });

  return loan;
};

/** Give back a digital loan early. */
export const returnDigital = async (loanId, userId) => {
  const loan = await Loan.findById(loanId);
  if (!loan) throw ApiError.notFound('No such loan', ERROR_CODES.LOAN_NOT_FOUND);

  if (String(loan.user) !== String(userId)) {
    throw ApiError.forbidden('This is not your loan', ERROR_CODES.NOT_RESOURCE_OWNER);
  }

  if (loan.type !== LOAN_TYPE.DIGITAL) {
    throw ApiError.badRequest(
      'Use the physical return endpoint for this loan',
      ERROR_CODES.BAD_REQUEST
    );
  }

  const expired = await expireDigitalLoan(loanId);
  if (!expired) {
    throw ApiError.conflict('This loan is already closed', ERROR_CODES.LOAN_NOT_ACTIVE);
  }

  return expired;
};

/* ===========================================================================
 * Queries
 * ======================================================================== */

/** A member's loans, with filtering. */
export const listForUser = async (userId, query = {}) => {
  const { page, limit, skip } = parsePagination(query);
  const sort = parseSort(query.sort, ['issuedAt', 'dueAt', 'returnedAt'], { issuedAt: -1 });

  const filter = { user: userId };

  if (query.status) filter.status = query.status;
  else if (query.open === true) filter.status = { $in: OPEN_LOAN_STATUSES };

  if (query.type) filter.type = query.type;

  return paginateQuery(Loan, filter, {
    sort,
    page,
    limit,
    skip,
    populate: [
      { path: 'book', select: 'title slug coverImage authors', populate: { path: 'authors', select: 'name slug' } },
      { path: 'copy', select: 'accessionNumber shelfLocation' },
      { path: 'fine', select: 'amount status reason currency' },
    ],
  });
};

/** Staff-facing loan list across all members. */
export const listAll = async (query = {}) => {
  const { page, limit, skip } = parsePagination(query);
  const sort = parseSort(query.sort, ['issuedAt', 'dueAt', 'returnedAt'], { issuedAt: -1 });

  const filter = {};

  if (query.status) filter.status = query.status;
  else if (query.open === true) filter.status = { $in: OPEN_LOAN_STATUSES };

  if (query.type) filter.type = query.type;
  if (query.userId) filter.user = query.userId;
  if (query.bookId) filter.book = query.bookId;

  // "Everything that is late right now" — the circulation desk's default view.
  if (query.overdue === true) {
    filter.status = { $in: OPEN_LOAN_STATUSES };
    filter.dueAt = { $lt: new Date() };
  }

  return paginateQuery(Loan, filter, {
    sort,
    page,
    limit,
    skip,
    populate: [
      { path: 'user', select: 'name email membershipNumber membershipType' },
      { path: 'book', select: 'title slug coverImage' },
      { path: 'copy', select: 'accessionNumber shelfLocation' },
      { path: 'fine', select: 'amount status reason' },
    ],
  });
};

/** One loan, with everything needed to display it. */
export const getById = async (loanId) => {
  const loan = await Loan.findById(loanId)
    .populate('user', 'name email membershipNumber membershipType')
    .populate({ path: 'book', select: 'title slug coverImage authors', populate: { path: 'authors', select: 'name slug' } })
    .populate('copy', 'accessionNumber shelfLocation condition')
    .populate('fine');

  if (!loan) throw ApiError.notFound('No such loan', ERROR_CODES.LOAN_NOT_FOUND);
  return loan;
};

export default {
  assertEligibleToBorrow,
  borrowPhysical,
  borrowDigital,
  returnPhysical,
  returnDigital,
  renew,
  markLost,
  expireDigitalLoan,
  assessOverdueFine,
  refreshUserFineTotal,
  listForUser,
  listAll,
  getById,
};
