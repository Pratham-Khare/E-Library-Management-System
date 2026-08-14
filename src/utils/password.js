/**
 * bcrypt via `bcryptjs`.
 */

import bcrypt from 'bcryptjs';
import { bcryptSaltRounds } from '../config/jwt.js';

/**
 * Hash a plaintext password.
 *
 * @returns {Promise<string>} The bcrypt hash, salt included.
 */
export const hashPassword = async (plainPassword) => bcrypt.hash(plainPassword, bcryptSaltRounds);

/**
 * Verify a password against a stored hash.
 */
export const verifyPassword = async (plainPassword, hash) => {
  // A user with no stored hash (impossible via the API, but reachable through
  // a hand-edited document) must fail closed rather than throw.
  if (!hash) return false;
  return bcrypt.compare(plainPassword, hash);
};

/* Strength requirements */

/**
 * Minimum acceptable password.
 */
export const PASSWORD_RULES = Object.freeze({
  minLength: 8,
  maxLength: 128, // bcrypt silently truncates past 72 bytes; reject long inputs rather than mislead
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecial: false, // length matters more; do not push users toward P@ssw0rd!
});

/**
 * Passwords common enough that an attacker tries them first. Rejecting these
 * blocks the overwhelming majority of credential-stuffing success, and costs a
 * legitimate user nothing.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwerty123', 'admin123', 'letmein1', 'welcome1', 'iloveyou', 'sunshine',
  'princess', 'football', 'monkey123', 'abc12345', 'passw0rd', 'p@ssw0rd',
  'library123', 'admin@123', 'test1234', 'changeme',
]);

/**
 * Check a password against the policy.
 */
export const validatePasswordStrength = (password) => {
  const errors = [];

  if (typeof password !== 'string' || password.length === 0) {
    return { valid: false, errors: ['Password is required'] };
  }

  if (password.length < PASSWORD_RULES.minLength) {
    errors.push(`Password must be at least ${PASSWORD_RULES.minLength} characters`);
  }
  if (password.length > PASSWORD_RULES.maxLength) {
    errors.push(`Password cannot exceed ${PASSWORD_RULES.maxLength} characters`);
  }
  if (PASSWORD_RULES.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (PASSWORD_RULES.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (PASSWORD_RULES.requireNumber && !/\d/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  if (PASSWORD_RULES.requireSpecial && !/[^A-Za-z0-9]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    errors.push('This password is too common. Please choose something less predictable.');
  }

  return { valid: errors.length === 0, errors };
};

/**
 * A regex expressing the same policy, for Zod schemas and OpenAPI docs.
 * Lookaheads assert each required class without consuming input.
 */
export const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,128}$/;

export const PASSWORD_DESCRIPTION =
  'At least 8 characters, including an uppercase letter, a lowercase letter and a number.';

export default { hashPassword, verifyPassword, validatePasswordStrength, PASSWORD_RULES };
