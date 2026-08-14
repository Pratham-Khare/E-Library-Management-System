/**
 * The offline AI mock provider.
 *
 * Two properties matter and are easy to lose: output must be DETERMINISTIC
 * (so a cached mock and a fresh one agree) and BOOK-SPECIFIC (so the feature
 * demonstrates something rather than emitting filler).
 */

import { describe, test, expect } from '@jest/globals';
import {
  mockSummary,
  mockKeyTakeaways,
  mockSimplified,
  mockAnswer,
  mockRecommendationReason,
  mockModeration,
  mockMetadataSuggestions,
} from '../../src/integrations/ai/mockProvider.js';
import { AI_SUMMARY_LENGTH } from '../../src/constants/enums.js';

const achebe = {
  _id: '6a7e0aac482cc9b7814ab700',
  title: 'Things Fall Apart',
  authors: [{ name: 'Chinua Achebe' }],
  categories: [{ name: 'Literary Fiction' }],
  publishedYear: 1958,
  pageCount: 209,
  language: 'en',
  description:
    'Okonkwo is a wealthy and respected warrior of the Umuofia clan. The novel traces the collision between traditional Igbo society and colonial administration.',
};

const cormen = {
  _id: '6a7e0aac482cc9b7814ab701',
  title: 'Introduction to Algorithms',
  authors: [{ name: 'Thomas H. Cormen' }],
  categories: [{ name: 'Algorithms' }],
  publishedYear: 2022,
  pageCount: 1312,
};

const bare = { _id: '6a7e0aac482cc9b7814ab702', title: 'An Untitled Thesis' };

describe('mockSummary — book specificity', () => {
  test('mentions the actual title', () => {
    expect(mockSummary(achebe)).toContain('Things Fall Apart');
  });

  test('mentions the actual author', () => {
    expect(mockSummary(achebe)).toContain('Chinua Achebe');
  });

  test('uses the catalogue description when there is one', () => {
    expect(mockSummary(achebe)).toContain('Okonkwo');
  });

  test('mentions the publication year', () => {
    expect(mockSummary(achebe)).toContain('1958');
  });

  /** Filler would make the endpoint "work" while demonstrating nothing. */
  test('is not lorem ipsum', () => {
    expect(mockSummary(achebe)).not.toMatch(/lorem|ipsum|placeholder|sample text|foo bar/i);
  });

  test('two different books produce different summaries', () => {
    expect(mockSummary(achebe)).not.toBe(mockSummary(cormen));
  });

  test('each summary mentions its OWN title, not the other', () => {
    expect(mockSummary(cormen)).toContain('Introduction to Algorithms');
    expect(mockSummary(cormen)).not.toContain('Things Fall Apart');
  });
});

describe('mockSummary — determinism', () => {
  /**
   * A seeded PRNG derived from the book id. Without this a cached mock and a
   * freshly generated one would differ, and a demo would change wording on
   * every refresh.
   */
  test('the same book always produces identical text', () => {
    const first = mockSummary(achebe);
    for (let i = 0; i < 5; i += 1) expect(mockSummary(achebe)).toBe(first);
  });

  test('determinism holds per length', () => {
    expect(mockSummary(achebe, { length: AI_SUMMARY_LENGTH.SHORT })).toBe(
      mockSummary(achebe, { length: AI_SUMMARY_LENGTH.SHORT })
    );
  });
});

describe('mockSummary — length', () => {
  test('SHORT < MEDIUM < LONG', () => {
    const short = mockSummary(achebe, { length: AI_SUMMARY_LENGTH.SHORT });
    const medium = mockSummary(achebe, { length: AI_SUMMARY_LENGTH.MEDIUM });
    const long = mockSummary(achebe, { length: AI_SUMMARY_LENGTH.LONG });

    expect(short.length).toBeLessThan(medium.length);
    expect(medium.length).toBeLessThan(long.length);
  });

  test('the three lengths are genuinely different text', () => {
    const short = mockSummary(achebe, { length: AI_SUMMARY_LENGTH.SHORT });
    const long = mockSummary(achebe, { length: AI_SUMMARY_LENGTH.LONG });
    expect(short).not.toBe(long);
  });
});

describe('mockSummary — grammar', () => {
  /**
   * Regression test. An earlier version opened with a dangling clause and
   * produced "Written by Chinua Achebe, Things Fall Apart Okonkwo is a wealthy
   * warrior…" — the attribution ran straight into the blurb.
   */
  test('the attribution is a complete sentence, not a dangling clause', () => {
    const summary = mockSummary(achebe);
    expect(summary).toMatch(/Things Fall Apart (is|was written) by Chinua Achebe\./);
  });

  test('does not run the attribution into the description', () => {
    expect(mockSummary(achebe)).not.toMatch(/Achebe, Things Fall Apart Okonkwo/);
  });

  test('every sentence ends with punctuation', () => {
    for (const paragraph of mockSummary(achebe).split('\n\n')) {
      expect(paragraph.trim()).toMatch(/[.!?]$/);
    }
  });
});

describe('mockSummary — thin records', () => {
  test('produces something usable from a title alone', () => {
    const summary = mockSummary(bare);
    expect(summary).toContain('An Untitled Thesis');
    expect(summary.length).toBeGreaterThan(20);
  });

  test('does not emit "undefined" or "null" into prose', () => {
    const summary = mockSummary(bare);
    expect(summary).not.toMatch(/undefined|null|NaN/);
  });
});

describe('mockKeyTakeaways', () => {
  test('returns an array of 5 to 7 points', () => {
    const takeaways = mockKeyTakeaways(achebe);
    expect(Array.isArray(takeaways)).toBe(true);
    expect(takeaways.length).toBeGreaterThanOrEqual(5);
    expect(takeaways.length).toBeLessThanOrEqual(7);
  });

  test('is deterministic', () => {
    expect(mockKeyTakeaways(achebe)).toEqual(mockKeyTakeaways(achebe));
  });

  test('each point is a non-empty sentence', () => {
    for (const point of mockKeyTakeaways(achebe)) {
      expect(point.length).toBeGreaterThan(10);
      expect(point).toMatch(/[.!?]$/);
    }
  });

  test('references the book’s own author and category', () => {
    const joined = mockKeyTakeaways(achebe).join(' ');
    expect(joined).toContain('Chinua Achebe');
    expect(joined).toContain('Literary Fiction');
  });
});

describe('mockSimplified', () => {
  test('mentions the title and is deterministic', () => {
    expect(mockSimplified(achebe)).toContain('Things Fall Apart');
    expect(mockSimplified(achebe)).toBe(mockSimplified(achebe));
  });

  test('differs from the standard summary', () => {
    expect(mockSimplified(achebe)).not.toBe(mockSummary(achebe));
  });
});

describe('mockAnswer', () => {
  test('answers a question about the author factually', () => {
    expect(mockAnswer(achebe, 'Who wrote this book?')).toContain('Chinua Achebe');
  });

  test('answers a question about the year factually', () => {
    expect(mockAnswer(achebe, 'When was it published?')).toContain('1958');
  });

  test('answers a question about length factually', () => {
    expect(mockAnswer(achebe, 'How many pages is it?')).toContain('209');
  });

  /**
   * A mock cannot know what page 40 says. Inventing a confident answer would
   * be worse than useless — it must stay within what the metadata supports.
   */
  test('declines rather than inventing detail it cannot know', () => {
    const answer = mockAnswer(achebe, 'What happens in chapter 12 on page 140?');
    expect(answer.toLowerCase()).toMatch(/not enough detail|beyond what|does not say|borrowing the book/);
  });

  test('says so plainly when the record lacks the fact', () => {
    const answer = mockAnswer(bare, 'When was it published?');
    expect(answer.toLowerCase()).toContain('not recorded');
  });

  test('is deterministic for the same question', () => {
    const question = 'What is this about?';
    expect(mockAnswer(achebe, question)).toBe(mockAnswer(achebe, question));
  });
});

describe('mockModeration', () => {
  /**
   * The mock deliberately declines to judge. The heuristic pre-filter has
   * already caught the blatant cases; the ambiguous middle is exactly where a
   * mock has nothing useful to add, and guessing would mis-moderate real
   * reviews.
   */
  test('never BLOCKS — it defers to a human', () => {
    const verdict = mockModeration();
    expect(verdict.verdict).toBe('FLAGGED');
    expect(verdict.verdict).not.toBe('BLOCKED');
  });

  test('says why it deferred', () => {
    expect(mockModeration().reasons.join(' ')).toMatch(/unavailable|librarian/i);
  });
});

describe('mockRecommendationReason', () => {
  test('references what the member already borrowed', () => {
    const reason = mockRecommendationReason(cormen, ['Clean Code']);
    expect(reason).toContain('Clean Code');
  });

  test('falls back gracefully with no history', () => {
    const reason = mockRecommendationReason(cormen, []);
    expect(reason.length).toBeGreaterThan(10);
    expect(reason).not.toMatch(/undefined|null/);
  });
});

describe('mockMetadataSuggestions', () => {
  test('suggests tags derived from the book', () => {
    const suggestions = mockMetadataSuggestions(achebe);
    expect(Array.isArray(suggestions.suggestedTags)).toBe(true);
    expect(suggestions.suggestedTags).toContain('literary-fiction');
  });

  test('classifies an old book as classic and a new one as contemporary', () => {
    expect(mockMetadataSuggestions(achebe).suggestedTags).toContain('classic');
    expect(mockMetadataSuggestions(cormen).suggestedTags).toContain('contemporary');
  });

  test('flags a long book as a long read', () => {
    expect(mockMetadataSuggestions(cormen).suggestedTags).toContain('long-read');
  });

  test('marks the output as offline, so nothing is applied blindly', () => {
    expect(mockMetadataSuggestions(achebe).note).toMatch(/offline|review before/i);
  });
});
