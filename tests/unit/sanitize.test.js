/**
 * NoSQL injection defence.
 *
 * The attack these guard against is passing an OBJECT where a scalar was
 * expected: `{ "email": { "$gt": "" } }` reaching `User.findOne(req.body)`
 * matches every document and logs the attacker in as whoever sorts first.
 */

import { describe, test, expect } from '@jest/globals';
import {
  sanitizeValue,
  sanitizeInPlace,
  escapeRegex,
  sanitizeSearchTerm,
} from '../../src/utils/sanitize.js';

describe('sanitizeValue — MongoDB operators', () => {
  test('strips $-prefixed keys', () => {
    expect(sanitizeValue({ email: { $gt: '' } })).toEqual({ email: {} });
  });

  test('strips operators at any depth', () => {
    const input = { filter: { nested: { $ne: null, keep: 'yes' } } };
    expect(sanitizeValue(input)).toEqual({ filter: { nested: { keep: 'yes' } } });
  });

  test('the classic authentication bypass is neutralised', () => {
    const attack = { email: { $gt: '' }, password: { $gt: '' } };
    const clean = sanitizeValue(attack);

    // What remains cannot match every document.
    expect(clean.email).toEqual({});
    expect(JSON.stringify(clean)).not.toContain('$gt');
  });

  test('leaves legitimate values untouched', () => {
    const input = { email: 'a@b.com', page: 2, active: true, tags: ['x', 'y'] };
    expect(sanitizeValue(input)).toEqual(input);
  });
});

describe('sanitizeValue — dotted paths', () => {
  /**
   * `{"profile.role": "ADMIN"}` reaches into a nested field the caller was
   * never meant to touch.
   */
  test('strips keys containing a dot', () => {
    expect(sanitizeValue({ 'studentProfile.verifiedAt': new Date(), name: 'ok' })).toEqual({
      name: 'ok',
    });
  });
});

describe('sanitizeValue — prototype pollution', () => {
  /**
   * A different attack arriving through the same door: assigning to
   * `__proto__` on a parsed JSON body can alter Object.prototype for the whole
   * process.
   */
  test.each(['__proto__', 'constructor', 'prototype'])('strips %s', (key) => {
    const clean = sanitizeValue({ [key]: { polluted: true }, safe: 1 });
    expect(clean).toEqual({ safe: 1 });
  });

  test('Object.prototype is not polluted afterwards', () => {
    sanitizeValue(JSON.parse('{"__proto__": {"polluted": "yes"}}'));
    expect({}.polluted).toBeUndefined();
  });
});

describe('sanitizeValue — structural safety', () => {
  test('handles arrays', () => {
    expect(sanitizeValue([{ $ne: 1 }, { ok: 2 }])).toEqual([{}, { ok: 2 }]);
  });

  test('preserves Dates rather than walking into them', () => {
    const date = new Date('2026-01-01');
    expect(sanitizeValue({ createdAt: date }).createdAt).toBe(date);
  });

  test('passes primitives through', () => {
    expect(sanitizeValue('text')).toBe('text');
    expect(sanitizeValue(42)).toBe(42);
    expect(sanitizeValue(null)).toBeNull();
    expect(sanitizeValue(undefined)).toBeUndefined();
  });

  /** A deeply nested body is itself a denial-of-service vector. */
  test('stops at a maximum depth instead of recursing forever', () => {
    let deep = { value: 'bottom' };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    expect(() => sanitizeValue(deep)).not.toThrow();
  });

  test('does not mutate its input', () => {
    const input = { email: { $gt: '' } };
    sanitizeValue(input);
    expect(input.email.$gt).toBe(''); // original untouched
  });
});

describe('sanitizeInPlace', () => {
  /**
   * Used for `req.body`, which is writable — keeping the same object identity
   * means middleware that captured a reference earlier sees the cleaned data.
   */
  /**
   * The legitimate `email` KEY survives — it is the operator INSIDE it that is
   * stripped, leaving a value that matches nothing rather than everything.
   * Removing the whole key would break ordinary requests.
   */
  test('mutates the object it was given, stripping operators from within values', () => {
    const body = { email: { $ne: null }, name: 'Ananya' };
    const report = sanitizeInPlace(body);

    expect(body).toEqual({ email: {}, name: 'Ananya' });
    expect(report.removed).toContain('$ne');
  });

  test('removes a dangerous key outright when the KEY itself is the problem', () => {
    const body = { $where: 'this.password.length > 0', name: 'Ananya' };
    const report = sanitizeInPlace(body);

    expect(body).toEqual({ name: 'Ananya' });
    expect(report.removed).toContain('$where');
  });

  test('reports what it removed, so suspicious requests can be logged', () => {
    const report = sanitizeInPlace({ $where: 'x', 'a.b': 1, ok: 2 });
    expect(report.removed).toEqual(expect.arrayContaining(['$where', 'a.b']));
  });

  test('tolerates null and non-objects', () => {
    expect(() => sanitizeInPlace(null)).not.toThrow();
    expect(() => sanitizeInPlace('string')).not.toThrow();
  });
});

describe('escapeRegex', () => {
  /**
   * The catalogue's fuzzy fallback builds a RegExp from whatever the user
   * typed. Without escaping, "C++" is a syntax error and `(a+)+$` is a
   * catastrophic-backtracking denial of service.
   */
  test('escapes regex metacharacters', () => {
    expect(escapeRegex('C++')).toBe('C\\+\\+');
    expect(escapeRegex('(a+)+$')).toBe('\\(a\\+\\)\\+\\$');
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
  });

  test('the escaped form is a valid RegExp that matches literally', () => {
    const pattern = new RegExp(escapeRegex('C++'), 'i');
    expect(pattern.test('Learning C++ Today')).toBe(true);
    expect(pattern.test('Learning CXX Today')).toBe(false);
  });

  test('a crafted backtracking pattern becomes a harmless literal', () => {
    const evil = '(a+)+$';
    const pattern = new RegExp(escapeRegex(evil));
    const started = Date.now();
    pattern.test('a'.repeat(200));
    expect(Date.now() - started).toBeLessThan(100);
  });

  test('leaves ordinary text alone', () => {
    expect(escapeRegex('Things Fall Apart')).toBe('Things Fall Apart');
  });
});

describe('sanitizeSearchTerm', () => {
  test('trims and collapses whitespace', () => {
    expect(sanitizeSearchTerm('  things   fall  apart  ')).toBe('things fall apart');
  });

  test('escapes metacharacters', () => {
    expect(sanitizeSearchTerm('C++')).toBe('C\\+\\+');
  });

  /** Caps the length so an enormous string cannot build a pathological pattern. */
  test('truncates an over-long term', () => {
    expect(sanitizeSearchTerm('a'.repeat(500)).length).toBeLessThanOrEqual(200);
  });

  test('returns an empty string for non-string input', () => {
    expect(sanitizeSearchTerm(null)).toBe('');
    expect(sanitizeSearchTerm({ $ne: 1 })).toBe('');
  });
});
