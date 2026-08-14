/**
 * Borrowing policy and fine arithmetic.
 *
 * `calculateOverdueFine` is the single source of truth for money owed — the
 * cron job, the return handler and the seeder all call it. If it is wrong,
 * members are charged wrongly, so these tests pin down the boundaries rather
 * than just the happy path.
 */

import { describe, test, expect } from '@jest/globals';
import {
  policies,
  getPolicy,
  fines,
  chargeableDays,
  calculateOverdueFine,
  digital,
  catalog,
} from '../../src/config/library.js';
import { MEMBERSHIP_TYPES } from '../../src/constants/roles.js';

describe('the policy matrix', () => {
  test('PUBLIC gets 14 days, 3 loans, 2 renewals', () => {
    expect(policies.PUBLIC).toEqual({ loanPeriodDays: 14, maxActiveLoans: 3, maxRenewals: 2 });
  });

  test('STUDENT gets 21 days, 5 loans, 2 renewals', () => {
    expect(policies.STUDENT).toEqual({ loanPeriodDays: 21, maxActiveLoans: 5, maxRenewals: 2 });
  });

  test('FACULTY gets 30 days, 8 loans, 2 renewals', () => {
    expect(policies.FACULTY).toEqual({ loanPeriodDays: 30, maxActiveLoans: 8, maxRenewals: 2 });
  });

  /**
   * Each renewal grants a FRESH full period, so the total fine-free window is
   * period × (1 + renewals). This is the number quoted to members.
   */
  test.each([
    [MEMBERSHIP_TYPES.PUBLIC, 42],
    [MEMBERSHIP_TYPES.STUDENT, 63],
    [MEMBERSHIP_TYPES.FACULTY, 90],
  ])('%s gets %i fine-free days in total', (membershipType, expected) => {
    const policy = getPolicy(membershipType);
    expect(policy.loanPeriodDays * (1 + policy.maxRenewals)).toBe(expected);
  });
});

describe('getPolicy', () => {
  test('returns the tier asked for', () => {
    expect(getPolicy(MEMBERSHIP_TYPES.STUDENT).loanPeriodDays).toBe(21);
  });

  /**
   * FAILING CLOSED MATTERS HERE. An unrecognised tier must never grant
   * unlimited borrowing, so the fallback is the most restrictive tier rather
   * than undefined (which would make every comparison against it succeed).
   */
  test('falls back to the MOST RESTRICTIVE tier for an unknown value', () => {
    expect(getPolicy('PLATINUM_ELITE')).toEqual(policies.PUBLIC);
    expect(getPolicy(undefined)).toEqual(policies.PUBLIC);
    expect(getPolicy(null)).toEqual(policies.PUBLIC);
  });
});

describe('chargeableDays', () => {
  test('the grace period absorbs the first days entirely', () => {
    expect(chargeableDays(0)).toBe(0);
    expect(chargeableDays(1)).toBe(0);
    expect(chargeableDays(2)).toBe(0); // exactly at the grace boundary
  });

  test('counting starts the day after grace runs out', () => {
    expect(chargeableDays(3)).toBe(1);
    expect(chargeableDays(12)).toBe(10);
  });

  /** Never negative — a book returned early must not produce a credit. */
  test('is never negative', () => {
    expect(chargeableDays(-5)).toBe(0);
  });
});

describe('calculateOverdueFine', () => {
  test('nothing is owed within the grace period', () => {
    expect(calculateOverdueFine(0)).toBe(0);
    expect(calculateOverdueFine(1)).toBe(0);
    expect(calculateOverdueFine(2)).toBe(0);
  });

  test('the first chargeable day costs one daily rate', () => {
    expect(calculateOverdueFine(3)).toBe(5); // (3 − 2) × 5
  });

  test.each([
    [5, 15], // (5 − 2) × 5
    [12, 50], // (12 − 2) × 5
    [30, 140], // (30 − 2) × 5
  ])('%i days late owes %i', (days, expected) => {
    expect(calculateOverdueFine(days)).toBe(expected);
  });

  /**
   * The cap is what stops a forgotten book accruing forever. Without it a book
   * lost for two years would show a five-figure debt.
   */
  test('the amount is capped per loan', () => {
    expect(calculateOverdueFine(200)).toBe(fines.maxPerLoan);
    expect(calculateOverdueFine(10_000)).toBe(fines.maxPerLoan);
  });

  test('the cap is reached at exactly the expected day', () => {
    // maxPerLoan / perDay chargeable days, plus the grace days.
    const daysToCap = fines.maxPerLoan / fines.perDay + fines.graceDays;
    expect(calculateOverdueFine(daysToCap)).toBe(fines.maxPerLoan);
    expect(calculateOverdueFine(daysToCap - 1)).toBeLessThan(fines.maxPerLoan);
  });

  test('rounds to 2 decimal places, so no fraction of a paisa is owed', () => {
    const amount = calculateOverdueFine(7);
    expect(Number(amount.toFixed(2))).toBe(amount);
  });

  test('negative input yields zero rather than a credit', () => {
    expect(calculateOverdueFine(-10)).toBe(0);
  });
});

describe('fine thresholds', () => {
  /**
   * A block threshold above the per-loan cap could never be reached by a
   * single overdue loan, which would make the borrowing block unreachable in
   * the common case. config/env.js rejects that combination at startup.
   */
  test('the borrowing block is reachable within the per-loan cap', () => {
    expect(fines.blockBorrowingAbove).toBeLessThanOrEqual(fines.maxPerLoan);
  });

  test('the configured values match the documented policy', () => {
    expect(fines.graceDays).toBe(2);
    expect(fines.perDay).toBe(5);
    expect(fines.maxPerLoan).toBe(500);
    expect(fines.blockBorrowingAbove).toBe(200);
    expect(fines.currency).toBe('INR');
  });
});

describe('digital lending', () => {
  test('digital loans are shorter than any physical loan period', () => {
    const shortestPhysical = Math.min(...Object.values(policies).map((p) => p.loanPeriodDays));
    expect(digital.loanDays).toBeLessThanOrEqual(shortestPhysical);
  });

  test('at least one concurrent licence, or nothing could ever be borrowed', () => {
    expect(digital.defaultConcurrentLicenses).toBeGreaterThan(0);
  });
});

describe('catalogue limits', () => {
  /**
   * The page-size cap is a denial-of-service guard: without it,
   * `?limit=999999` loads an entire collection into memory.
   */
  test('a hard maximum page size exists and exceeds the default', () => {
    expect(catalog.maxPageSize).toBeGreaterThan(catalog.defaultPageSize);
    expect(catalog.maxPageSize).toBeLessThanOrEqual(100);
  });
});
