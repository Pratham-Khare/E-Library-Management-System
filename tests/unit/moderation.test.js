/**
 * The review moderation pre-filter.
 *
 * This runs on EVERY review, and its `conclusive` flag decides whether an AI
 * call is spent. With a 100-call lifetime budget, getting that split wrong
 * either exhausts the budget or lets abuse through — so both the verdicts and
 * the conclusiveness are asserted.
 */

import { describe, test, expect } from '@jest/globals';
import { heuristicModeration } from '../../src/services/review.service.js';
import { MODERATION_VERDICT } from '../../src/constants/enums.js';

describe('clean reviews', () => {
  test.each([
    'A genuinely absorbing read. The pacing takes a while to settle but it is worth staying with.',
    'Clear, well organised, and far more readable than I expected from a book this size.',
    'Useful as a reference, though not something I would read end to end.',
  ])('passes: %s', (text) => {
    const result = heuristicModeration(text);
    expect(result.verdict).toBe(MODERATION_VERDICT.CLEAN);
    expect(result.score).toBe(0);
  });

  /** A clean verdict is conclusive, so no AI call is spent on it. */
  test('a clean verdict is conclusive — no AI call needed', () => {
    expect(heuristicModeration('An excellent book.').conclusive).toBe(true);
  });

  test('empty input is clean and conclusive', () => {
    const result = heuristicModeration('');
    expect(result.verdict).toBe(MODERATION_VERDICT.CLEAN);
    expect(result.conclusive).toBe(true);
  });

  test('null input does not throw', () => {
    expect(() => heuristicModeration(null)).not.toThrow();
  });
});

describe('NEGATIVE reviews are not abuse', () => {
  /**
   * The single most important property here. A moderation system that removes
   * criticism is worthless — a one-star review is legitimate.
   */
  test.each([
    'This is easily the worst book I have read all year. Badly argued and padded.',
    'The writing is turgid, the examples are wrong, and the index is useless.',
    'I would not recommend this to anyone. A complete waste of a loan period.',
    'Disappointing. The author clearly did not check their sources.',
  ])('does not block harsh criticism: %s', (text) => {
    expect(heuristicModeration(text).verdict).not.toBe(MODERATION_VERDICT.BLOCKED);
  });
});

describe('spam detection', () => {
  test('flags a web link', () => {
    const result = heuristicModeration('Great book, get it at http://cheap-books.xyz');
    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons.join(' ')).toContain('web link');
  });

  test('flags contact details', () => {
    const result = heuristicModeration('Message me on WhatsApp 9876543210 for a copy');
    expect(result.reasons.join(' ')).toContain('contact details');
  });

  test('flags promotional language', () => {
    const result = heuristicModeration('Buy now and get free download, click here!');
    expect(result.reasons.join(' ')).toContain('promotional');
  });

  /** Signals accumulate, so obvious spam crosses the blocking threshold. */
  test('BLOCKS a review combining several spam signals', () => {
    const result = heuristicModeration(
      'Buy now at http://cheap-books.xyz — free download, click here! WhatsApp 9876543210'
    );
    expect(result.verdict).toBe(MODERATION_VERDICT.BLOCKED);
    expect(result.conclusive).toBe(true);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe('profanity', () => {
  /**
   * Weighted to block on its own. Leaving it merely flagged would mean the
   * review stayed publicly visible until a librarian happened to look at the
   * queue.
   */
  test('BLOCKS blatant profanity', () => {
    const result = heuristicModeration('This is absolute shit and the author is a bastard');
    expect(result.verdict).toBe(MODERATION_VERDICT.BLOCKED);
    expect(result.conclusive).toBe(true);
  });

  test('a single profane term is enough to block', () => {
    expect(heuristicModeration('what a shit book').verdict).toBe(MODERATION_VERDICT.BLOCKED);
  });

  /** Occurrences are counted, so a sustained tirade scores higher. */
  test('multiple terms score higher than one', () => {
    const one = heuristicModeration('this shit book');
    const many = heuristicModeration('this shit book by that bastard is an asshole of a text');
    expect(many.score).toBeGreaterThan(one.score);
    expect(many.reasons.join(' ')).toMatch(/\d+ terms/);
  });

  test('does not false-positive on words that merely contain a fragment', () => {
    // Word-boundary anchored, so "Scunthorpe" and "classic" are unaffected.
    expect(heuristicModeration('A classic account of Scunthorpe').verdict).toBe(
      MODERATION_VERDICT.CLEAN
    );
  });
});

describe('low-effort signals', () => {
  test('flags shouting', () => {
    const result = heuristicModeration('THIS BOOK IS COMPLETELY AND UTTERLY TERRIBLE');
    expect(result.reasons.join(' ')).toContain('capital letters');
  });

  test('flags repeated characters', () => {
    const result = heuristicModeration('sooooooooo boring');
    expect(result.reasons.join(' ')).toContain('Repeated characters');
  });

  /**
   * These alone are not damning — they land in the inconclusive band and are
   * escalated to the model, which is exactly the intended split.
   */
  test('a weak signal alone is FLAGGED and INCONCLUSIVE', () => {
    const result = heuristicModeration('sooooooooo boring');
    expect(result.verdict).toBe(MODERATION_VERDICT.FLAGGED);
    expect(result.conclusive).toBe(false);
  });
});

describe('the conclusive/inconclusive split', () => {
  /**
   * This split IS the AI budget strategy: only the ambiguous middle costs a
   * call. Anything conclusive is decided for free.
   */
  test('score 0 → CLEAN, conclusive', () => {
    const result = heuristicModeration('A thoughtful and well-made book.');
    expect(result.score).toBe(0);
    expect(result.conclusive).toBe(true);
  });

  test('score ≥ 0.7 → BLOCKED, conclusive', () => {
    const result = heuristicModeration('utter shit');
    expect(result.score).toBeGreaterThanOrEqual(0.7);
    expect(result.conclusive).toBe(true);
  });

  test('0 < score < 0.7 → FLAGGED, inconclusive (escalates to the model)', () => {
    const result = heuristicModeration('Check it out at www.example.com');
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(0.7);
    expect(result.conclusive).toBe(false);
  });

  test('the score never exceeds 1', () => {
    const result = heuristicModeration(
      'shit bastard asshole bitch buy now click here free download http://x.xyz WhatsApp 9876543210 AAAAAAAAAA'
    );
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

describe('reasons are actionable', () => {
  /** The reason is shown to the author, so it has to explain the refusal. */
  test('a blocked review carries human-readable reasons', () => {
    const result = heuristicModeration('Buy now at http://spam.xyz, WhatsApp 9876543210');
    expect(result.reasons.length).toBeGreaterThan(0);
    for (const reason of result.reasons) {
      expect(reason.length).toBeGreaterThan(5);
      expect(reason).not.toMatch(/undefined|null/);
    }
  });

  test('a clean review carries no reasons', () => {
    expect(heuristicModeration('A fine book.').reasons).toEqual([]);
  });
});
