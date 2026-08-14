/**
 * NoSQL INJECTION SANITISER
 * MongoDB queries are documents, not strings, so there is no SQL-style quote
 * escaping to get wrong. The equivalent attack is passing an OBJECT where the
 * code expected a scalar:
 */

/** Keys starting with `$` are MongoDB query/update operators. */
const isOperatorKey = (key) => key.startsWith('$');

/** Keys containing `.` address nested paths and can escape their object. */
const isDottedKey = (key) => key.includes('.');

/**
 * Prototype-polluting keys. Assigning to `__proto__` on a parsed JSON body can
 * alter Object.prototype for the entire process — a different attack from
 * NoSQL injection, arriving through the same door.
 */
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively copy `value`, dropping every dangerous key.
 */
export const sanitizeValue = (value, report = { removed: [] }, depth = 0) => {
  // A deeply nested body is itself a denial-of-service vector.
  if (depth > 10) return undefined;

  if (value === null || typeof value !== 'object') return value;

  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, report, depth + 1));
  }

  const clean = Object.create(null);

  for (const [key, item] of Object.entries(value)) {
    if (PROTOTYPE_KEYS.has(key)) {
      report.removed.push(key);
      continue;
    }
    if (isOperatorKey(key)) {
      report.removed.push(key);
      continue;
    }
    if (isDottedKey(key)) {
      report.removed.push(key);
      continue;
    }
    clean[key] = sanitizeValue(item, report, depth + 1);
  }

  // Convert back to a normal object literal. `Object.create(null)` protected
  // the build-up from prototype pollution; downstream code (and JSON
  // serialisation) expects an ordinary object.
  return { ...clean };
};

/**
 * Sanitise an object in place where possible.
 */
export const sanitizeInPlace = (target) => {
  const report = { removed: [] };
  if (!target || typeof target !== 'object') return report;

  for (const key of Object.keys(target)) {
    if (PROTOTYPE_KEYS.has(key) || isOperatorKey(key) || isDottedKey(key)) {
      report.removed.push(key);
      delete target[key];
      continue;
    }
    const value = target[key];
    if (value && typeof value === 'object') {
      target[key] = sanitizeValue(value, report, 1);
    }
  }

  return report;
};

/**
 * Escape the regex metacharacters in a user-supplied search term.
 */
export const escapeRegex = (input) => String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Normalise a free-text search term: trim, collapse runs of whitespace, escape
 * regex metacharacters, and cap the length so an enormous string cannot be
 * used to build a pathological pattern.
 */
export const sanitizeSearchTerm = (term, maxLength = 200) => {
  if (typeof term !== 'string') return '';
  return escapeRegex(term.trim().replace(/\s+/g, ' ').slice(0, maxLength));
};

export default { sanitizeValue, sanitizeInPlace, escapeRegex, sanitizeSearchTerm };
