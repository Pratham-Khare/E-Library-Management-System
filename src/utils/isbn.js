/**
 * ---------------------------------------------------------------------------
 * ISBN VALIDATION & CONVERSION
 * ---------------------------------------------------------------------------
 * An ISBN carries a CHECK DIGIT — the last character is a checksum over the
 * preceding ones. That makes it worth validating properly rather than just
 * counting digits, because the overwhelmingly common cataloguing error is a
 * transposition ("9780132350884" typed as "9780132350848"), and a checksum
 * catches transpositions while a length check does not.
 *
 * Two formats:
 *   ISBN-10 — weighted sum mod 11, where a check value of 10 is written 'X'.
 *   ISBN-13 — alternating 1/3 weights mod 10. An EAN-13 barcode.
 *
 * Every ISBN-10 has an ISBN-13 equivalent (prefix 978, recompute the check
 * digit), so both are stored: publishers and users supply whichever they have,
 * and a search on one should find a book catalogued under the other.
 * ---------------------------------------------------------------------------
 */

/** Strip hyphens, spaces and case. ISBNs are printed with hyphens that carry no meaning. */
export const normalizeIsbn = (value) =>
  String(value ?? '')
    .replace(/[\s-]/g, '')
    .toUpperCase();

/**
 * Validate an ISBN-10.
 *
 * Check: sum of digit × (10 down to 1) must be divisible by 11.
 * The final character may be 'X', representing the value 10 — which is why
 * ISBN-10 cannot be stored as a number.
 */
export const isValidIsbn10 = (input) => {
  const isbn = normalizeIsbn(input);
  if (!/^\d{9}[\dX]$/.test(isbn)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    sum += Number(isbn[i]) * (10 - i);
  }
  sum += isbn[9] === 'X' ? 10 : Number(isbn[9]);

  return sum % 11 === 0;
};

/**
 * Validate an ISBN-13.
 *
 * Check: digits weighted 1,3,1,3,… must sum to a multiple of 10.
 * Real ISBNs use the 978 or 979 prefix; 979 was introduced when the 978 space
 * began to fill up, and both are legitimate.
 */
export const isValidIsbn13 = (input) => {
  const isbn = normalizeIsbn(input);
  if (!/^\d{13}$/.test(isbn)) return false;
  if (!isbn.startsWith('978') && !isbn.startsWith('979')) return false;

  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3);
  }

  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === Number(isbn[12]);
};

/** Valid as either format. */
export const isValidIsbn = (input) => isValidIsbn10(input) || isValidIsbn13(input);

/**
 * Convert ISBN-10 to ISBN-13: prefix with 978 and recompute the check digit.
 * @returns {string|null} null when the input is not a valid ISBN-10.
 */
export const isbn10To13 = (input) => {
  const isbn = normalizeIsbn(input);
  if (!isValidIsbn10(isbn)) return null;

  // Drop the ISBN-10 check digit — the ISBN-13 checksum is computed differently.
  const body = `978${isbn.slice(0, 9)}`;

  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  }

  return `${body}${(10 - (sum % 10)) % 10}`;
};

/**
 * Convert ISBN-13 to ISBN-10, where possible.
 * Only 978-prefixed ISBN-13s have an ISBN-10 equivalent — the 979 range has no
 * 10-digit form at all, which is precisely why 13 digits were introduced.
 *
 * @returns {string|null}
 */
export const isbn13To10 = (input) => {
  const isbn = normalizeIsbn(input);
  if (!isValidIsbn13(isbn) || !isbn.startsWith('978')) return null;

  const body = isbn.slice(3, 12);

  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    sum += Number(body[i]) * (10 - i);
  }

  const remainder = (11 - (sum % 11)) % 11;
  return `${body}${remainder === 10 ? 'X' : remainder}`;
};

/**
 * Normalise whatever the caller supplied into both formats.
 *
 * Storing both is what lets a member paste the 10-digit ISBN off an old
 * paperback and still find a book catalogued from its 13-digit barcode.
 *
 * @param {string} input
 * @returns {{ isbn10: string|null, isbn13: string|null, valid: boolean, format: '10'|'13'|null }}
 */
export const parseIsbn = (input) => {
  const isbn = normalizeIsbn(input);

  if (isValidIsbn13(isbn)) {
    return { isbn10: isbn13To10(isbn), isbn13: isbn, valid: true, format: '13' };
  }
  if (isValidIsbn10(isbn)) {
    return { isbn10: isbn, isbn13: isbn10To13(isbn), valid: true, format: '10' };
  }

  return { isbn10: null, isbn13: null, valid: false, format: null };
};

/** Format an ISBN-13 with conventional hyphens, for display. */
export const formatIsbn13 = (input) => {
  const isbn = normalizeIsbn(input);
  if (!isValidIsbn13(isbn)) return input;
  // Approximate grouping: real segment boundaries depend on registrant ranges,
  // which need a lookup table. This is the common shape and reads correctly.
  return `${isbn.slice(0, 3)}-${isbn.slice(3, 4)}-${isbn.slice(4, 8)}-${isbn.slice(8, 12)}-${isbn.slice(12)}`;
};

export default {
  normalizeIsbn,
  isValidIsbn,
  isValidIsbn10,
  isValidIsbn13,
  isbn10To13,
  isbn13To10,
  parseIsbn,
  formatIsbn13,
};
