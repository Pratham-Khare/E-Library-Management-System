/**
 * ---------------------------------------------------------------------------
 * MOCK AI PROVIDER
 * ---------------------------------------------------------------------------
 * Generates AI-shaped content offline, with no network call and no quota cost.
 *
 * THIS IS NOT LOREM IPSUM. Output is built from the book's OWN title, authors,
 * categories, page count and description, so a mock summary of "Things Fall
 * Apart" reads about Things Fall Apart and mentions Chinua Achebe. Filler text
 * would make every AI endpoint technically "work" while demonstrating nothing;
 * this makes the feature genuinely demonstrable with the network unplugged.
 *
 * OUTPUT IS DETERMINISTIC. A seeded PRNG derived from the book's id means the
 * same book always produces the same summary — so a cached mock and a fresh
 * one agree, and a demo does not change wording between refreshes.
 *
 * MOCK CONTENT IS NEVER PRESENTED AS REAL. Every response is marked
 * `source: 'mock'` and persisted with `isMock: true`. That honesty is the
 * whole point: a system that silently fabricates model output is worse than
 * one that admits the model was unavailable.
 * ---------------------------------------------------------------------------
 */

import crypto from 'node:crypto';
import { AI_SUMMARY_LENGTH, AI_LENGTH_WORD_TARGET } from '../../constants/enums.js';

/**
 * A small deterministic PRNG (mulberry32), seeded from a string.
 *
 * `Math.random()` would make every regeneration differ, which is exactly what
 * a cache and a demo both need not to happen.
 */
const seededRandom = (seedString) => {
  const hash = crypto.createHash('sha256').update(String(seedString)).digest();
  let state = hash.readUInt32LE(0);

  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Deterministic pick from a list. */
const pick = (random, options) => options[Math.floor(random() * options.length)];

/** Extract usable facts about a book, tolerating missing fields. */
const describe = (book) => {
  const authors = (book.authors ?? [])
    .map((author) => author?.name ?? null)
    .filter(Boolean);

  const categories = (book.categories ?? [])
    .map((category) => category?.name ?? null)
    .filter(Boolean);

  return {
    title: book.title ?? 'this book',
    subtitle: book.subtitle ?? null,
    authorList:
      authors.length === 0
        ? null
        : authors.length === 1
          ? authors[0]
          : `${authors.slice(0, -1).join(', ')} and ${authors.at(-1)}`,
    primaryCategory: categories[0] ?? null,
    categories,
    year: book.publishedYear ?? null,
    pages: book.pageCount ?? null,
    language: book.language ?? 'en',
    /** Trimmed to one clean sentence, for weaving into generated prose. */
    blurb: book.description
      ? String(book.description).replace(/\s+/g, ' ').trim().split(/(?<=\.)\s/)[0]
      : null,
  };
};

/* ===========================================================================
 * Summary
 * ======================================================================== */

/**
 * A prose summary, built from real metadata.
 *
 * Length is respected — a SHORT summary is genuinely shorter than a LONG one,
 * so a client rendering both sees a real difference rather than the same
 * paragraph twice.
 */
export const mockSummary = (book, { length = AI_SUMMARY_LENGTH.MEDIUM } = {}) => {
  const facts = describe(book);
  const random = seededRandom(`${book._id ?? book.id}-summary-${length}`);

  /**
   * Attribution is a COMPLETE SENTENCE, not a dangling clause.
   *
   * An earlier version opened with "Written by X, <Title> " and then appended
   * the catalogue blurb, producing "Written by Chinua Achebe, Things Fall
   * Apart Okonkwo is a wealthy warrior…" — grammatical nonsense. Keeping the
   * attribution self-contained means anything can follow it cleanly.
   */
  const opener = facts.authorList
    ? pick(random, [
        `${facts.title} is by ${facts.authorList}. `,
        `${facts.title} was written by ${facts.authorList}. `,
      ])
    : '';

  // When a blurb exists it is already a full sentence; otherwise a subject is
  // supplied so the generated clause is not left hanging either.
  const thrust = facts.blurb
    ? `${facts.blurb} `
    : facts.primaryCategory
      ? `${facts.title} ${pick(random, [
          `works within the ${facts.primaryCategory.toLowerCase()} tradition, developing its argument carefully and at length. `,
          `belongs to the ${facts.primaryCategory.toLowerCase()} shelf, and rewards readers willing to follow its structure. `,
        ])}`
      : `${facts.title} develops its subject carefully, building from first principles toward its central argument. `;

  const situate = [
    facts.year ? `First published in ${facts.year}, it ` : 'It ',
    pick(random, [
      'has remained in steady circulation since, ',
      'continues to be borrowed regularly, ',
      'holds a settled place in the collection, ',
    ]),
    pick(random, [
      'and is frequently recommended to readers approaching the subject for the first time.',
      'and repays a second reading as much as a first.',
      'and sits comfortably alongside the standard works in its field.',
    ]),
  ].join('');

  const extend = [
    facts.pages
      ? `Across roughly ${facts.pages} pages, the book moves at a measured pace, `
      : 'The book moves at a measured pace, ',
    pick(random, [
      'giving its ideas room to develop rather than rushing to conclusions. ',
      'returning to its central concerns from several angles. ',
      'and rarely asks the reader to take a claim on trust. ',
    ]),
    facts.categories.length > 1
      ? `It sits across ${facts.categories.slice(0, 2).join(' and ').toLowerCase()}, which accounts for some of its breadth. `
      : '',
    pick(random, [
      'Readers who enjoy a patient argument will find much to like here; those looking for a brisk overview may want something shorter.',
      'It is the kind of book that is easier to admire quickly and harder to finish, which is not a criticism.',
      'The result is a work that repays attention without demanding specialist knowledge.',
    ]),
  ].join('');

  // Assembled to hit the length band the caller asked for.
  const parts = { SHORT: [opener + thrust], MEDIUM: [opener + thrust, situate], LONG: [opener + thrust, situate, extend] };

  return (parts[length] ?? parts.MEDIUM).join('\n\n');
};

/* ===========================================================================
 * Key takeaways
 * ======================================================================== */

export const mockKeyTakeaways = (book) => {
  const facts = describe(book);
  const random = seededRandom(`${book._id ?? book.id}-takeaways`);

  const takeaways = [
    facts.authorList
      ? `${facts.authorList} approaches the subject through ${pick(random, ['narrative', 'close argument', 'accumulated example', 'careful structure'])} rather than assertion.`
      : `The argument is built through ${pick(random, ['narrative', 'close argument', 'accumulated example'])} rather than assertion.`,

    facts.primaryCategory
      ? `Sits firmly within ${facts.primaryCategory}, and assumes no prior specialist reading.`
      : 'Assumes no prior specialist reading.',

    facts.year && facts.year < 2000
      ? `Published in ${facts.year}; some references have dated, but the central concerns have not.`
      : facts.year
        ? `A recent work (${facts.year}), engaging with current debates in the field.`
        : 'Engages directly with the standing debates in its field.',

    pick(random, [
      'The middle section is where the substance lies; the opening is largely scene-setting.',
      'Best read in a few long sittings rather than in short bursts.',
      'The examples do more work than the theory, which is a strength.',
    ]),

    facts.pages && facts.pages > 500
      ? 'Substantial in length — worth borrowing for the full loan period rather than a weekend.'
      : 'Manageable in a single loan period without difficulty.',

    pick(random, [
      'Frequently borrowed alongside other titles in the same category.',
      'A reliable recommendation for readers new to the subject.',
      'Holds up on rereading, which not everything on this shelf does.',
    ]),
  ];

  return takeaways.slice(0, 5 + Math.floor(random() * 2));
};

/* ===========================================================================
 * Simplified summary
 * ======================================================================== */

/** Plain-language version, aimed at a younger or non-specialist reader. */
export const mockSimplified = (book) => {
  const facts = describe(book);
  const random = seededRandom(`${book._id ?? book.id}-simple`);

  return [
    facts.authorList
      ? `${facts.title} was written by ${facts.authorList}${facts.year ? `, and came out in ${facts.year}` : ''}.`
      : `${facts.title}${facts.year ? ` came out in ${facts.year}` : ''}.`,
    facts.primaryCategory
      ? `It is a ${facts.primaryCategory.toLowerCase()} book, which means it is mostly about ${pick(random, ['ideas and how they fit together', 'people and what happens to them', 'how things work and why'])}.`
      : `It is mostly about ${pick(random, ['ideas and how they fit together', 'people and what happens to them'])}.`,
    pick(random, [
      'The writing is clear, so you do not need to know anything about the subject before you start.',
      'Some parts are slower than others, but the important bits are explained properly.',
      'It takes its time, and it explains what it means as it goes.',
    ]),
    facts.pages
      ? `It is about ${facts.pages} pages long, so give yourself a couple of weeks.`
      : 'Give yourself a couple of weeks with it.',
  ].join(' ');
};

/* ===========================================================================
 * Question answering
 * ======================================================================== */

/**
 * Answer a question about a book.
 *
 * Deliberately HEDGED. A mock cannot actually know what page 40 says, and
 * inventing a confident answer would be worse than useless — so the response
 * stays within what the metadata supports and says so plainly.
 */
export const mockAnswer = (book, question) => {
  const facts = describe(book);
  const random = seededRandom(`${book._id ?? book.id}-${question}`);
  const lower = String(question).toLowerCase();

  if (/who\s+(wrote|is the author)/.test(lower)) {
    return facts.authorList
      ? `${facts.title} was written by ${facts.authorList}.`
      : `The author is not recorded in the catalogue entry for ${facts.title}.`;
  }

  if (/when|what year|published/.test(lower)) {
    return facts.year
      ? `${facts.title} was published in ${facts.year}.`
      : `The publication year is not recorded for ${facts.title}.`;
  }

  if (/how long|how many pages/.test(lower)) {
    return facts.pages
      ? `${facts.title} runs to about ${facts.pages} pages.`
      : `The page count is not recorded for ${facts.title}.`;
  }

  if (/what.*(about|theme|subject)/.test(lower)) {
    return facts.blurb
      ? `${facts.blurb} ${facts.primaryCategory ? `It is catalogued under ${facts.primaryCategory}.` : ''}`
      : `${facts.title} is catalogued under ${facts.primaryCategory ?? 'no specific category'}, but the catalogue entry does not carry a description.`;
  }

  return [
    `Based on the catalogue entry for ${facts.title}${facts.authorList ? ` by ${facts.authorList}` : ''}, `,
    pick(random, [
      'there is not enough detail available to answer that specifically. ',
      'this question goes beyond what the record covers. ',
    ]),
    'Borrowing the book and reading the relevant section would give a much better answer than this record can.',
  ].join('');
};

/* ===========================================================================
 * Recommendations & moderation
 * ======================================================================== */

/** A short explanation of why a book was recommended. */
export const mockRecommendationReason = (book, basedOn = []) => {
  const facts = describe(book);
  const random = seededRandom(`${book._id ?? book.id}-rec`);

  if (basedOn.length > 0) {
    return `Suggested because you borrowed ${basedOn[0]}${basedOn.length > 1 ? ` and ${basedOn.length - 1} similar title(s)` : ''}${facts.primaryCategory ? `, and this sits in the same ${facts.primaryCategory} area` : ''}.`;
  }

  return pick(random, [
    `A frequently borrowed title in ${facts.primaryCategory ?? 'the collection'}.`,
    `Well rated by other members${facts.primaryCategory ? ` reading ${facts.primaryCategory}` : ''}.`,
    'A reliable starting point in this part of the catalogue.',
  ]);
};

/**
 * Moderation verdict.
 *
 * Deliberately conservative: a mock cannot judge nuance, so it declines rather
 * than guessing. The heuristic pre-filter has already caught the blatant
 * cases; the ambiguous middle is exactly where a mock has nothing useful to
 * add, and pretending otherwise would silently mis-moderate real reviews.
 */
export const mockModeration = () => ({
  verdict: 'FLAGGED',
  reasons: ['Automated review unavailable — held for a librarian to check'],
  score: 0.5,
});

/** Metadata suggestions for a new book. */
export const mockMetadataSuggestions = (book) => {
  const facts = describe(book);
  const random = seededRandom(`${book._id ?? book.id}-meta`);

  return {
    suggestedTags: [
      facts.primaryCategory?.toLowerCase().replace(/\s+/g, '-'),
      facts.year && facts.year < 1980 ? 'classic' : 'contemporary',
      facts.pages && facts.pages > 500 ? 'long-read' : 'short-read',
      pick(random, ['recommended', 'popular', 'reference', 'accessible']),
    ].filter(Boolean),
    suggestedReadingLevel: pick(random, ['General', 'Undergraduate', 'Advanced']),
    note: 'Generated offline — review before applying.',
  };
};

export default {
  mockSummary,
  mockKeyTakeaways,
  mockSimplified,
  mockAnswer,
  mockRecommendationReason,
  mockModeration,
  mockMetadataSuggestions,
};
