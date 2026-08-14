/**
 * ---------------------------------------------------------------------------
 * NoSQL INJECTION SANITISER
 * ---------------------------------------------------------------------------
 * MongoDB queries are documents, not strings, so there is no SQL-style quote
 * escaping to get wrong. The equivalent attack is passing an OBJECT where the
 * code expected a scalar:
 *
 *     { "email": { "$gt": "" }, "password": { "$gt": "" } }
 *
 * If that reaches `User.findOne(req.body)` unfiltered, `$gt: ""` matches every
 * document and the attacker is logged in as whoever comes first. Dotted keys
 * are the other half of the problem — `{"profile.role": "ADMIN"}` reaches into
 * a nested field the caller was never meant to touch.
 *
 * TWO LAYERS OF DEFENCE, because either alone has a gap:
 *
 *   1. THIS SANITISER strips `$`-prefixed and dotted keys from request data.
 *      Broad and unconditional.
 *   2. ZOD VALIDATORS whitelist known fields, coerce types and strip anything
 *      unrecognised. Narrow and precise. A body that passes a Zod schema
 *      expecting `email: string` cannot contain an operator object at all,
 *      because the type check itself rejects it.
 *
 * Layer 2 is the stronger guarantee, but only covers routes that have a
 * schema. Layer 1 covers everything, including routes added later by someone
 * who forgot the validator.
 *
 * WHY NOT express-mongo-sanitize? Express 5 made `req.query` a getter with no
 * setter, and that package works by reassigning it — so it throws on startup.
 * Rather than pin the whole project to Express 4 for one dependency, the
 * ~40 lines below do the same job and handle the getter correctly.
 * ---------------------------------------------------------------------------
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
 *
 * Returns a NEW structure rather than mutating in place. That matters for
 * `req.query`, which in Express 5 is a getter — we cannot reassign it, but we
 * can hand the cleaned copy to whatever consumes it.
 *
 * @param {unknown} value
 * @param {{ removed: string[] }} report Accumulates what was stripped, so the
 *   middleware can log suspicious requests rather than silently cleaning them.
 * @param {number} [depth]
 * @returns {unknown}
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
 *
 * Used for `req.body` and `req.params`, which are writable. Keeping the same
 * object identity means middleware that captured a reference earlier still
 * sees the cleaned data.
 *
 * @param {object} target
 * @returns {{ removed: string[] }}
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
 *
 * The catalogue's fuzzy fallback builds a RegExp from whatever the user typed.
 * Without escaping, a search for "C++" is a syntax error, and a search for
 * `(a+)+$` is a catastrophic-backtracking denial of service that can pin a CPU
 * core for minutes on a modest input.
 *
 * @param {string} input
 * @returns {string} Safe to embed in a RegExp.
 */
export const escapeRegex = (input) => String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Normalise a free-text search term: trim, collapse runs of whitespace, escape
 * regex metacharacters, and cap the length so an enormous string cannot be
 * used to build a pathological pattern.
 *
 * @param {string} term
 * @param {number} [maxLength]
 * @returns {string}
 */
export const sanitizeSearchTerm = (term, maxLength = 200) => {
  if (typeof term !== 'string') return '';
  return escapeRegex(term.trim().replace(/\s+/g, ' ').slice(0, maxLength));
};

export default { sanitizeValue, sanitizeInPlace, escapeRegex, sanitizeSearchTerm };
