/**
 * CIRCULATION SERIALIZERS — loans and fines
 * Loan responses carry COMPUTED time fields — `daysRemaining`, `daysOverdue`,
 * `isOverdue` — rather than leaving a client to derive them from `dueAt`.
 */

import config from '../config/index.js';
import { toBookSummary } from './catalog.serializer.js';
import { OPEN_LOAN_STATUSES } from '../constants/enums.js';

const isPopulated = (value) => value && typeof value === 'object' && !value.buffer;

/**
 * Day-granularity difference. Computed in UTC day numbers, not elapsed
 * milliseconds: a book due at 23:59 and checked at 09:00 the same morning is
 * not "0.6 days remaining", it is due today.
 */
const dayDiff = (from, to) => {
  const a = new Date(from);
  const b = new Date(to);
  return Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
      Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) /
      86_400_000
  );
};

/* Loans */

export const toLoan = (loan, { includeUser = false } = {}) => {
  if (!loan) return null;

  const now = new Date();
  const isOpen = OPEN_LOAN_STATUSES.includes(loan.status);

  const daysRemaining = dayDiff(now, loan.dueAt);
  const daysOverdue = isOpen
    ? Math.max(0, -daysRemaining)
    : (loan.daysOverdueAtReturn ?? 0);

  return {
    id: String(loan._id ?? loan.id),
    type: loan.type,
    status: loan.status,

    book: isPopulated(loan.book)
      ? toBookSummary(loan.book)
      : loan.book
        ? { id: String(loan.book) }
        : null,

    copy: isPopulated(loan.copy)
      ? {
          id: String(loan.copy._id),
          accessionNumber: loan.copy.accessionNumber,
          shelfLocation: loan.copy.shelfLocation ?? null,
        }
      : null,

    issuedAt: loan.issuedAt,
    dueAt: loan.dueAt,
    returnedAt: loan.returnedAt ?? null,

    /** Server-computed, so every client agrees on what "late" means. */
    daysRemaining: isOpen ? daysRemaining : null,
    daysOverdue,
    isOverdue: isOpen && daysOverdue > 0,

    renewals: {
      count: loan.renewalCount ?? 0,
      history: (loan.renewalHistory ?? []).map((entry) => ({
        at: entry.at,
        previousDueAt: entry.previousDueAt,
        newDueAt: entry.newDueAt,
      })),
    },

    fine: isPopulated(loan.fine)
      ? {
          id: String(loan.fine._id),
          amount: loan.fine.amount,
          currency: loan.fine.currency ?? config.library.fines.currency,
          status: loan.fine.status,
          reason: loan.fine.reason,
        }
      : loan.fine
        ? { id: String(loan.fine) }
        : null,

    // Staff views need to know whose loan this is; a member's own list does not.
    ...(includeUser && isPopulated(loan.user)
      ? {
          borrower: {
            id: String(loan.user._id),
            name: loan.user.name,
            membershipNumber: loan.user.membershipNumber,
            membershipType: loan.user.membershipType,
          },
        }
      : {}),

    notes: loan.notes ?? null,
  };
};

export const listLoans = (loans, options) => (loans ?? []).map((loan) => toLoan(loan, options));

/**
 * A borrow response.
 */
export const toBorrowResponse = ({ loan, copy, book, policy }, user) => ({
  loan: toLoan(loan),
  ...(copy
    ? { copy: { id: String(copy._id), accessionNumber: copy.accessionNumber, shelfLocation: copy.shelfLocation } }
    : {}),
  dueAt: loan.dueAt,
  loanPeriodDays: policy?.loanPeriodDays ?? config.library.digital.loanDays,
  renewalsAllowed: policy?.maxRenewals ?? 0,
  ...(book
    ? {
        availability: {
          remainingCopies: Math.max(0, (book.inventory?.availableCopies ?? 1) - 1),
        },
      }
    : {}),
});

/* Fines */

export const toFine = (fine, { includeUser = false } = {}) => {
  if (!fine) return null;

  return {
    id: String(fine._id ?? fine.id),
    reason: fine.reason,
    amount: fine.amount,
    currency: fine.currency ?? config.library.fines.currency,
    status: fine.status,
    description: fine.description ?? null,

    /**
     * The arithmetic behind the number.
     */
    calculation: fine.daysOverdue
      ? {
          daysOverdue: fine.daysOverdue,
          graceDays: config.library.fines.graceDays,
          chargeableDays: fine.chargeableDays,
          ratePerDay: fine.ratePerDay,
          cappedAtMaximum: fine.cappedAtMaximum ?? false,
          ...(fine.cappedAtMaximum ? { maximumPerLoan: config.library.fines.maxPerLoan } : {}),
        }
      : null,

    book: isPopulated(fine.book)
      ? { id: String(fine.book._id), title: fine.book.title, slug: fine.book.slug }
      : null,

    loan: isPopulated(fine.loan)
      ? { id: String(fine.loan._id), dueAt: fine.loan.dueAt, returnedAt: fine.loan.returnedAt }
      : fine.loan
        ? { id: String(fine.loan) }
        : null,

    settlement:
      fine.status === 'PAID'
        ? { paidAt: fine.paidAt, method: fine.paymentMethod, reference: fine.paymentReference }
        : fine.status === 'WAIVED'
          ? { waivedAt: fine.waivedAt, note: fine.waiverNote }
          : null,

    ...(includeUser && isPopulated(fine.user)
      ? {
          member: {
            id: String(fine.user._id),
            name: fine.user.name,
            membershipNumber: fine.user.membershipNumber,
          },
        }
      : {}),

    createdAt: fine.createdAt,
  };
};

export const listFines = (fines, options) => (fines ?? []).map((fine) => toFine(fine, options));

export default { toLoan, listLoans, toBorrowResponse, toFine, listFines };
