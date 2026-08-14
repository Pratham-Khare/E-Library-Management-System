/**
 * Every prompt in one place, versioned by AI_PROMPT_VERSION.
 */

import config from '../../../config/index.js';
import { AI_SUMMARY_LENGTH, AI_LENGTH_WORD_TARGET } from '../../../constants/enums.js';

/** Shared framing. Sets the role and, crucially, the honesty requirement. */
const SYSTEM_BASE = `You are a librarian's assistant writing for a library catalogue.
Write in clear, plain British English for an adult general reader.
Be accurate and measured. Do not use marketing language or superlatives.
If the material you are given is thin, say so plainly rather than inventing detail — a short honest summary is far better than a confident invented one.
Never claim to have read the full text unless it is provided to you.`;

/**
 * Build the source block describing a book.
 */
export const buildBookContext = (book, extractedText = null) => {
  const authors = (book.authors ?? []).map((a) => a?.name).filter(Boolean).join(', ');
  const categories = (book.categories ?? []).map((c) => c?.name).filter(Boolean).join(', ');

  const lines = [
    `Title: ${book.title}`,
    book.subtitle ? `Subtitle: ${book.subtitle}` : null,
    authors ? `Author(s): ${authors}` : null,
    book.publishedYear ? `Published: ${book.publishedYear}` : null,
    categories ? `Categories: ${categories}` : null,
    book.pageCount ? `Pages: ${book.pageCount}` : null,
    book.language ? `Language: ${book.language}` : null,
    (book.tags ?? []).length ? `Tags: ${book.tags.join(', ')}` : null,
    book.description ? `\nCatalogue description:\n${book.description}` : null,
  ].filter(Boolean);

  if (extractedText) {
    const excerpt = extractedText.slice(0, config.ai.prompt.maxInputChars);
    lines.push(
      `\nExtract from the book itself (${excerpt.length} characters${excerpt.length < extractedText.length ? ', truncated' : ''}):\n${excerpt}`
    );
  }

  return lines.join('\n');
};

/** Is there enough material to be worth spending a call on? */
export const hasSufficientContext = (book, extractedText = null) => {
  if (extractedText && extractedText.length >= config.ai.prompt.minContextChars) return true;
  const descriptionLength = (book.description ?? '').trim().length;
  // A title and author alone can support a short factual note, but not a
  // meaningful summary — and spending a call to hallucinate one is worse than
  // returning an honest error.
  return descriptionLength >= config.ai.prompt.minContextChars;
};

/* Summary */

export const summaryPrompt = (book, { length = AI_SUMMARY_LENGTH.MEDIUM, extractedText = null } = {}) => {
  const wordTarget = AI_LENGTH_WORD_TARGET[length];
  const hasFullText = Boolean(extractedText);

  return {
    messages: [
      { role: 'system', content: SYSTEM_BASE },
      {
        role: 'user',
        content: `Write a summary of the following book for a library catalogue.

Target length: about ${wordTarget} words.
${hasFullText
  ? 'You have an extract from the book itself. Base the summary on it.'
  : 'You have ONLY the catalogue record — no text from the book. Summarise what the record supports, and do not invent plot details, characters or arguments that are not there.'}

Respond with JSON: { "summary": "..." }

---
${buildBookContext(book, extractedText)}`,
      },
    ],
    // Length-proportional, so a SHORT summary does not pay for LONG capacity.
    maxTokens: Math.min(config.ai.api.maxTokens, Math.round(wordTarget * 2.5)),
    jsonMode: true,
  };
};

/* Key takeaways */

export const keyTakeawaysPrompt = (book, { extractedText = null } = {}) => ({
  messages: [
    { role: 'system', content: SYSTEM_BASE },
    {
      role: 'user',
      content: `Give 5 to 7 key takeaways about the following book, to help a reader decide whether to borrow it.

Each takeaway should be one sentence and say something USEFUL — who it suits, how demanding it is, what it does well or badly. Avoid restating the title.
${extractedText ? '' : 'You have only the catalogue record, so keep the points to what it supports.'}

Respond with JSON: { "takeaways": ["...", "..."] }

---
${buildBookContext(book, extractedText)}`,
    },
  ],
  maxTokens: 600,
  jsonMode: true,
});

/* Simplified summary */

export const simplifiedPrompt = (book, { extractedText = null } = {}) => ({
  messages: [
    { role: 'system', content: SYSTEM_BASE },
    {
      role: 'user',
      content: `Explain what the following book is about, in plain language a 15-year-old would understand.

Use short sentences and everyday words. Do not talk down to the reader, and do not oversimplify to the point of being wrong.
About 120 words.

Respond with JSON: { "summary": "..." }

---
${buildBookContext(book, extractedText)}`,
    },
  ],
  maxTokens: 400,
  jsonMode: true,
});

/* Question answering */

/**
 * Answer a question about a book.
 */
export const questionPrompt = (book, question, { extractedText = null, existingSummary = null } = {}) => ({
  messages: [
    { role: 'system', content: SYSTEM_BASE },
    {
      role: 'user',
      content: `Answer the reader's question about this book, using ONLY the information below.

If the information does not support an answer, say so plainly — for example "The catalogue record does not say." DO NOT GUESS, and do not invent plot details, quotations or page references.

Question: ${question}

Respond with JSON: { "answer": "...", "answeredFromSource": true|false }
Set "answeredFromSource" to false when you could not answer from the material provided.

---
${buildBookContext(book, extractedText)}
${existingSummary ? `\nExisting catalogue summary:\n${existingSummary}` : ''}`,
    },
  ],
  maxTokens: 500,
  jsonMode: true,
});

/* Review moderation */

/**
 * Judge a review.
 */
export const moderationPrompt = (review) => ({
  messages: [
    {
      role: 'system',
      content: `You moderate book reviews for a public library.
Block only genuine abuse: personal attacks, hate speech, sexual content, or spam and advertising.
A NEGATIVE review is not abuse. Strong criticism of a book, its author's ideas, or its quality is legitimate and must be allowed. Do not block a review for being harsh, rude about the writing, or one-star.`,
    },
    {
      role: 'user',
      content: `Assess this review.

Respond with JSON: { "verdict": "CLEAN" | "FLAGGED" | "BLOCKED", "reasons": ["..."], "score": 0.0-1.0 }
  CLEAN   — publish it
  FLAGGED — publish, but a librarian should look
  BLOCKED — do not publish

---
Rating: ${review.rating}/5
Title: ${review.title ?? '(none)'}
Review: ${review.body ?? '(none)'}`,
    },
  ],
  maxTokens: 300,
  jsonMode: true,
});

/* Metadata enrichment */

export const metadataPrompt = (book, availableCategories = []) => ({
  messages: [
    { role: 'system', content: SYSTEM_BASE },
    {
      role: 'user',
      content: `Suggest catalogue metadata for the following book.

${availableCategories.length ? `Choose categories ONLY from this list:\n${availableCategories.join(', ')}\n` : ''}
Suggest 3-6 lowercase, hyphenated tags. Suggest a reading level: General, Undergraduate, or Advanced.

Respond with JSON: { "categories": ["..."], "tags": ["..."], "readingLevel": "...", "confidence": 0.0-1.0 }
Set a low confidence when the record is too thin to judge.

---
${buildBookContext(book)}`,
    },
  ],
  maxTokens: 400,
  jsonMode: true,
});

/* Recommendation rationale */

/**
 * Explain a recommendation.
 */
export const recommendationPrompt = (books, basedOnTitles) => ({
  messages: [
    { role: 'system', content: SYSTEM_BASE },
    {
      role: 'user',
      content: `A library member has borrowed: ${basedOnTitles.join(', ')}.

For each recommended book below, write ONE sentence explaining why it might suit them, referring to what they have already read.

Respond with JSON: { "reasons": [{ "title": "...", "reason": "..." }] }

Recommended books:
${books.map((book, index) => `${index + 1}. ${book.title}${book.authors?.[0]?.name ? ` by ${book.authors[0].name}` : ''}${book.categories?.[0]?.name ? ` (${book.categories[0].name})` : ''}`).join('\n')}`,
    },
  ],
  maxTokens: 600,
  jsonMode: true,
});

/**
 * Parse a JSON response defensively.
 */
export const parseJsonResponse = (content) => {
  if (!content) return null;

  let text = String(content).trim();

  // Strip a ```json fence if present.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fenced) text = fenced[1].trim();

  try {
    return JSON.parse(text);
  } catch {
    // Last resort: take the outermost {...} and try again.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
};

export const PROMPT_VERSION = config.ai.cache.promptVersion;

export default {
  summaryPrompt,
  keyTakeawaysPrompt,
  simplifiedPrompt,
  questionPrompt,
  moderationPrompt,
  metadataPrompt,
  recommendationPrompt,
  buildBookContext,
  hasSufficientContext,
  parseJsonResponse,
  PROMPT_VERSION,
};
