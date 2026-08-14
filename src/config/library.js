/**
 * This is the file to open to answer "how does this library actually work?".
 */

import env from './env.js';
import { MEMBERSHIP_TYPES } from '../constants/roles.js';

/* Per-membership borrowing policy */

/**
 * The policy matrix.
 */
export const policies = Object.freeze({
  [MEMBERSHIP_TYPES.PUBLIC]: Object.freeze({
    loanPeriodDays: env.LOAN_PERIOD_DAYS_PUBLIC,
    maxActiveLoans: env.MAX_ACTIVE_LOANS_PUBLIC,
    maxRenewals: env.MAX_RENEWALS_PUBLIC,
  }),
  [MEMBERSHIP_TYPES.STUDENT]: Object.freeze({
    loanPeriodDays: env.LOAN_PERIOD_DAYS_STUDENT,
    maxActiveLoans: env.MAX_ACTIVE_LOANS_STUDENT,
    maxRenewals: env.MAX_RENEWALS_STUDENT,
  }),
  [MEMBERSHIP_TYPES.FACULTY]: Object.freeze({
    loanPeriodDays: env.LOAN_PERIOD_DAYS_FACULTY,
    maxActiveLoans: env.MAX_ACTIVE_LOANS_FACULTY,
    maxRenewals: env.MAX_RENEWALS_FACULTY,
  }),
});

/**
 * Look up the policy for a membership type, falling back to the most
 * restrictive tier (PUBLIC) if the value is somehow unrecognised. Failing
 * closed matters here: an unknown tier must never grant unlimited borrowing.
 */
export const getPolicy = (membershipType) =>
  policies[membershipType] ?? policies[MEMBERSHIP_TYPES.PUBLIC];

/* Fines */

/**
 * Overdue charging rules.
 */
export const fines = Object.freeze({
  graceDays: env.FINE_GRACE_DAYS,
  perDay: env.FINE_PER_DAY,
  maxPerLoan: env.FINE_MAX_PER_LOAN,
  blockBorrowingAbove: env.FINE_BLOCK_BORROWING_ABOVE,
  currency: env.FINE_CURRENCY,
});

/**
 * Chargeable days for a loan that is `daysOverdue` days past due.
 * Never negative — the grace period absorbs the first few days entirely.
 */
export const chargeableDays = (daysOverdue) => Math.max(0, daysOverdue - fines.graceDays);

/**
 * The fine owed for a loan `daysOverdue` days past due, after grace and cap.
 * This is the single source of truth for fine arithmetic — the cron job, the
 * return handler and the seeder all call it, so they cannot disagree.
 */
export const calculateOverdueFine = (daysOverdue) => {
  const chargeable = chargeableDays(daysOverdue);
  if (chargeable <= 0) return 0;
  const raw = chargeable * fines.perDay;
  return Math.round(Math.min(raw, fines.maxPerLoan) * 100) / 100;
};

/* Digital lending */

/**
 * Digital loans work like physical ones but consume one of a fixed number of
 * simultaneous licences instead of a copy, and expire on their own — nobody
 * has to bring an ebook back.
 */
export const digital = Object.freeze({
  loanDays: env.DIGITAL_LOAN_DAYS,
  defaultConcurrentLicenses: env.DIGITAL_DEFAULT_CONCURRENT_LICENSES,
  expiryWarningHours: 24,
});

/* Borrowing eligibility */

/**
 * Conditions checked, in order, before a loan is created. Each maps to a
 * specific error code so the caller learns exactly why they were refused.
 */
export const eligibility = Object.freeze({
  /** Refuse borrowing while any item is overdue. */
  blockWhenOverdue: env.BLOCK_BORROWING_WHEN_OVERDUE,
  /** Refuse borrowing when PENDING fines exceed the threshold. */
  blockWhenFinesAbove: env.FINE_BLOCK_BORROWING_ABOVE,
  /** A member may not hold two copies of the same title at once. */
  blockDuplicateTitle: true,
  /** Only ACTIVE accounts may borrow. */
  requireActiveAccount: true,
});

/* Reminders & renewals */

export const reminders = Object.freeze({
  /** "Due soon" email/notification this many days before the due date. */
  dueSoonDaysBefore: env.DUE_REMINDER_DAYS_BEFORE,
});

/**
 * Renewal gate. With reservations out of scope there is no queue to consult,
 * so exactly two conditions apply:
 */
export const renewals = Object.freeze({
  allowWhenOverdue: false,
  /** A renewal restarts the clock from today rather than extending the old due date. */
  resetFromToday: true,
});

/* Catalogue & search defaults */

export const catalog = Object.freeze({
  /** Default page size for list endpoints. */
  defaultPageSize: 20,
  /** Hard ceiling on `?limit=` so nobody can request the whole collection. */
  maxPageSize: 100,
  /** Results returned by the autocomplete/suggest endpoint. */
  suggestionLimit: 10,
  /** Books returned by "similar books" and recommendation endpoints. */
  recommendationLimit: 10,
  /** Max rows accepted in a single CSV bulk import. */
  maxCsvImportRows: 1000,
});

export default Object.freeze({
  policies,
  getPolicy,
  fines,
  chargeableDays,
  calculateOverdueFine,
  digital,
  eligibility,
  reminders,
  renewals,
  catalog,
});
