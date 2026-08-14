/**
 * ISBN validation and conversion.
 *
 * The check digit is the point. A length check would accept a transposed pair —
 * which is by far the commonest cataloguing error — so these tests assert on
 * real ISBNs and on the specific corruptions a human actually makes.
 */

import { describe, test, expect } from '@jest/globals';
import {
  normalizeIsbn,
  isValidIsbn,
  isValidIsbn10,
  isValidIsbn13,
  isbn10To13,
  isbn13To10,
  parseIsbn,
  formatIsbn13,
} from '../../src/utils/isbn.js';

describe('normalizeIsbn', () => {
  test('strips hyphens and spaces', () => {
    expect(normalizeIsbn('978-0-385-47454-2')).toBe('9780385474542');
    expect(normalizeIsbn('978 0 385 47454 2')).toBe('9780385474542');
  });

  test('uppercases, because ISBN-10 may end in X', () => {
    expect(normalizeIsbn('080442957x')).toBe('080442957X');
  });

  test('tolerates null and undefined', () => {
    expect(normalizeIsbn(null)).toBe('');
    expect(normalizeIsbn(undefined)).toBe('');
  });
});

describe('isValidIsbn13', () => {
  test.each([
    ['9780385474542', 'Things Fall Apart'],
    ['9780262046305', 'Introduction to Algorithms'],
    ['9780132350884', 'Clean Code'],
    ['9780134610993', 'Artificial Intelligence: A Modern Approach'],
  ])('accepts %s (%s)', (isbn) => {
    expect(isValidIsbn13(isbn)).toBe(true);
  });

  test('accepts a hyphenated ISBN', () => {
    expect(isValidIsbn13('978-0-385-47454-2')).toBe(true);
  });

  /**
   * The reason a checksum is used rather than a length check: a transposed
   * pair keeps the length identical and is the commonest typing mistake.
   */
  test('rejects a transposed digit pair', () => {
    expect(isValidIsbn13('9780385474542')).toBe(true);
    expect(isValidIsbn13('9780385474524')).toBe(false); // last two swapped
  });

  test('rejects a single wrong check digit', () => {
    expect(isValidIsbn13('9780385474543')).toBe(false);
  });

  test('rejects the wrong length', () => {
    expect(isValidIsbn13('978038547454')).toBe(false);
    expect(isValidIsbn13('97803854745421')).toBe(false);
  });

  test('rejects a prefix that is not 978 or 979', () => {
    // 977 is the ISSN range, not ISBN.
    expect(isValidIsbn13('9770385474545')).toBe(false);
  });

  test('rejects non-numeric input', () => {
    expect(isValidIsbn13('978038547454X')).toBe(false);
    expect(isValidIsbn13('not-an-isbn')).toBe(false);
  });
});

describe('isValidIsbn10', () => {
  test('accepts a valid ISBN-10', () => {
    expect(isValidIsbn10('0385474547')).toBe(true);
    expect(isValidIsbn10('0132350882')).toBe(true);
  });

  /** The check value 10 is written 'X', which is why this cannot be a number. */
  test('accepts X as the check digit', () => {
    expect(isValidIsbn10('080442957X')).toBe(true);
  });

  test('rejects a wrong check digit', () => {
    expect(isValidIsbn10('0385474548')).toBe(false);
  });

  test('rejects X anywhere but the final position', () => {
    expect(isValidIsbn10('X385474547')).toBe(false);
  });
});

describe('conversion', () => {
  test('ISBN-10 → ISBN-13 prefixes 978 and recomputes the check digit', () => {
    expect(isbn10To13('0385474547')).toBe('9780385474542');
    expect(isbn10To13('0132350882')).toBe('9780132350884');
  });

  test('ISBN-13 → ISBN-10 round-trips', () => {
    expect(isbn13To10('9780385474542')).toBe('0385474547');
  });

  /**
   * The 979 range has no 10-digit form at all — which is precisely why 13
   * digits were introduced.
   */
  test('a 979-prefixed ISBN-13 has no ISBN-10 equivalent', () => {
    const isbn979 = '9791234567896';
    if (isValidIsbn13(isbn979)) expect(isbn13To10(isbn979)).toBeNull();
  });

  test('conversion of an invalid input returns null rather than nonsense', () => {
    expect(isbn10To13('0385474548')).toBeNull();
    expect(isbn13To10('9780385474543')).toBeNull();
  });
});

describe('parseIsbn', () => {
  /**
   * Both formats are stored so a member can paste the 10-digit ISBN off an old
   * paperback and still find a book catalogued from its 13-digit barcode.
   */
  test('given an ISBN-13, returns both formats', () => {
    expect(parseIsbn('9780385474542')).toEqual({
      isbn10: '0385474547',
      isbn13: '9780385474542',
      valid: true,
      format: '13',
    });
  });

  test('given an ISBN-10, returns both formats', () => {
    expect(parseIsbn('0385474547')).toEqual({
      isbn10: '0385474547',
      isbn13: '9780385474542',
      valid: true,
      format: '10',
    });
  });

  /**
   * The stored PAIR is identical either way — which is what lets a search on
   * one format find a book catalogued under the other. `format` deliberately
   * differs: it records which form the caller actually supplied.
   */
  test('both inputs resolve to the same stored pair', () => {
    const fromThirteen = parseIsbn('9780385474542');
    const fromTen = parseIsbn('0385474547');

    expect(fromThirteen.isbn10).toBe(fromTen.isbn10);
    expect(fromThirteen.isbn13).toBe(fromTen.isbn13);
    expect(fromThirteen.format).toBe('13');
    expect(fromTen.format).toBe('10');
  });

  test('an invalid ISBN reports valid: false with no invented values', () => {
    expect(parseIsbn('9780385474543')).toEqual({
      isbn10: null,
      isbn13: null,
      valid: false,
      format: null,
    });
  });

  test('handles empty input without throwing', () => {
    expect(parseIsbn('').valid).toBe(false);
    expect(parseIsbn(null).valid).toBe(false);
  });
});

describe('isValidIsbn', () => {
  test('accepts either format', () => {
    expect(isValidIsbn('9780385474542')).toBe(true);
    expect(isValidIsbn('0385474547')).toBe(true);
  });

  test('rejects anything else', () => {
    expect(isValidIsbn('12345')).toBe(false);
    expect(isValidIsbn('')).toBe(false);
  });
});

describe('formatIsbn13', () => {
  test('adds conventional hyphens for display', () => {
    expect(formatIsbn13('9780385474542')).toBe('978-0-3854-7454-2');
  });

  test('returns an invalid input unchanged rather than mangling it', () => {
    expect(formatIsbn13('not-an-isbn')).toBe('not-an-isbn');
  });
});
