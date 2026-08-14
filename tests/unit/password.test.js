/**
 * Password hashing and strength rules.
 */

import { describe, test, expect } from '@jest/globals';
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  PASSWORD_RULES,
  PASSWORD_PATTERN,
} from '../../src/utils/password.js';

describe('hashPassword', () => {
  test('produces a bcrypt hash, never the password itself', async () => {
    const hash = await hashPassword('Str0ngPass');
    expect(hash).not.toBe('Str0ngPass');
    expect(hash).toMatch(/^\$2[aby]\$/);
  });

  /**
   * Each hash carries its own random salt, so identical passwords produce
   * different hashes and one rainbow table cannot crack two accounts.
   */
  test('the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('Str0ngPass'), hashPassword('Str0ngPass')]);
    expect(a).not.toBe(b);
  });
});

describe('verifyPassword', () => {
  test('accepts the correct password', async () => {
    const hash = await hashPassword('Str0ngPass');
    await expect(verifyPassword('Str0ngPass', hash)).resolves.toBe(true);
  });

  test('rejects a wrong password', async () => {
    const hash = await hashPassword('Str0ngPass');
    await expect(verifyPassword('WrongPass1', hash)).resolves.toBe(false);
  });

  test('is case-sensitive', async () => {
    const hash = await hashPassword('Str0ngPass');
    await expect(verifyPassword('str0ngpass', hash)).resolves.toBe(false);
  });

  /**
   * A user with no stored hash is unreachable through the API but possible via
   * a hand-edited document. It must fail closed rather than throw — or, worse,
   * be treated as a match.
   */
  test('fails closed when there is no stored hash', async () => {
    await expect(verifyPassword('anything', null)).resolves.toBe(false);
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
    await expect(verifyPassword('anything', undefined)).resolves.toBe(false);
  });

  test('rejects a malformed hash rather than throwing', async () => {
    await expect(verifyPassword('anything', 'not-a-bcrypt-hash')).resolves.toBe(false);
  });
});

describe('validatePasswordStrength', () => {
  test('accepts a password meeting every rule', () => {
    expect(validatePasswordStrength('Str0ngPass')).toEqual({ valid: true, errors: [] });
  });

  test.each([
    ['Sh0rt', 'at least 8 characters'],
    ['nouppercase1', 'uppercase'],
    ['NOLOWERCASE1', 'lowercase'],
    ['NoDigitsHere', 'number'],
  ])('rejects %s', (password, expectedFragment) => {
    const result = validatePasswordStrength(password);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain(expectedFragment);
  });

  /**
   * Reporting every failure at once matters: one error at a time turns fixing
   * a password into a guessing game with a round-trip per rule.
   */
  test('reports ALL failures at once, not just the first', () => {
    const result = validatePasswordStrength('short');
    expect(result.errors.length).toBeGreaterThanOrEqual(3); // length, uppercase, digit
  });

  test('rejects common passwords even when they satisfy the character rules', () => {
    const result = validatePasswordStrength('Password123');
    // 'password123' is on the common list, checked case-insensitively.
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('too common');
  });

  /** bcrypt silently truncates past 72 bytes, so a long input is rejected
   *  rather than accepted with most of it ignored. */
  test('rejects an over-long password', () => {
    const result = validatePasswordStrength('A1'.repeat(100));
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('cannot exceed');
  });

  test('handles missing input', () => {
    expect(validatePasswordStrength('').valid).toBe(false);
    expect(validatePasswordStrength(null).valid).toBe(false);
    expect(validatePasswordStrength(undefined).valid).toBe(false);
  });
});

describe('PASSWORD_PATTERN', () => {
  /**
   * The regex is used by Zod schemas and the OpenAPI docs. If it drifted from
   * validatePasswordStrength, the API would advertise one rule and enforce
   * another.
   */
  test('agrees with validatePasswordStrength on the character rules', () => {
    const cases = ['Str0ngPass', 'Abcdefg1', 'short', 'nouppercase1', 'NOLOWER1', 'NoDigits'];

    for (const password of cases) {
      const patternSays = PASSWORD_PATTERN.test(password);
      const validatorSays = validatePasswordStrength(password).errors.every(
        (e) => e.includes('too common') // the only rule the regex cannot express
      );
      expect(patternSays).toBe(validatorSays);
    }
  });
});

describe('PASSWORD_RULES', () => {
  test('the documented minimum is at least 8', () => {
    expect(PASSWORD_RULES.minLength).toBeGreaterThanOrEqual(8);
  });

  test('the maximum is within bcrypt’s meaningful range', () => {
    expect(PASSWORD_RULES.maxLength).toBeLessThanOrEqual(128);
  });
});
