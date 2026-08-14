/**
 * ---------------------------------------------------------------------------
 * DOMAIN ENUMERATIONS
 * ---------------------------------------------------------------------------
 * Every fixed value set used by the Mongoose schemas lives here, in one place,
 * so that a schema, a validator and a service can never drift apart on what
 * counts as a valid status.
 *
 * Each enum exports both the object (for readable references such as
 * LOAN_STATUS.OVERDUE) and a frozen `_VALUES` array (for `enum:` in a schema
 * and `z.enum()` in a validator).
 *
 * Roles, membership types and user status live in ./roles.js.
 * ---------------------------------------------------------------------------
 */

/* ===========================================================================
 * CATALOGUE
 * ======================================================================== */

/**
 * Whether a book is visible and borrowable.
 * ARCHIVED keeps history intact while removing the title from circulation —
 * we never hard-delete a book that has loans pointing at it.
 */
export const BOOK_STATUS = Object.freeze({
  /** Live in the catalogue and borrowable. */
  ACTIVE: 'ACTIVE',
  /** Staff-only. Being catalogued, not yet published to members. */
  DRAFT: 'DRAFT',
  /** Withdrawn from circulation but retained for loan history. */
  ARCHIVED: 'ARCHIVED',
});
export const BOOK_STATUS_VALUES = Object.freeze(Object.values(BOOK_STATUS));

/**
 * The lifecycle of a single physical copy on the shelf.
 *
 * AVAILABLE -> ON_LOAN is the compare-and-swap that makes borrowing safe under
 * concurrency: the claim is a single atomic findOneAndUpdate filtered on
 * `status: AVAILABLE`, so two simultaneous requests cannot both win.
 */
export const COPY_STATUS = Object.freeze({
  /** On the shelf, ready to be borrowed. */
  AVAILABLE: 'AVAILABLE',
  /** Currently borrowed by a member. */
  ON_LOAN: 'ON_LOAN',
  /** Reported lost. Excluded from availability counts. */
  LOST: 'LOST',
  /** Physically damaged and pulled from circulation pending repair. */
  DAMAGED: 'DAMAGED',
  /** Permanently retired (weeded) from the collection. */
  WITHDRAWN: 'WITHDRAWN',
});
export const COPY_STATUS_VALUES = Object.freeze(Object.values(COPY_STATUS));

/** Copy statuses that count toward a book's available-copy total. */
export const BORROWABLE_COPY_STATUSES = Object.freeze([COPY_STATUS.AVAILABLE]);

/** Physical condition, recorded at acquisition and updated on return. */
export const COPY_CONDITION = Object.freeze({
  NEW: 'NEW',
  GOOD: 'GOOD',
  FAIR: 'FAIR',
  POOR: 'POOR',
});
export const COPY_CONDITION_VALUES = Object.freeze(Object.values(COPY_CONDITION));

/* ===========================================================================
 * DIGITAL ASSETS
 * ======================================================================== */

/** Ebook file formats the system accepts. */
export const EBOOK_FORMAT = Object.freeze({
  PDF: 'PDF',
  EPUB: 'EPUB',
});
export const EBOOK_FORMAT_VALUES = Object.freeze(Object.values(EBOOK_FORMAT));

/**
 * Progress of the background text extraction that feeds the AI summariser.
 * FAILED is not fatal: summaries fall back to book metadata.
 */
export const EXTRACTION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  /** Skipped by configuration (EXTRACT_EBOOK_TEXT=false) or unsupported format. */
  SKIPPED: 'SKIPPED',
});
export const EXTRACTION_STATUS_VALUES = Object.freeze(Object.values(EXTRACTION_STATUS));

/* ===========================================================================
 * CIRCULATION
 * ======================================================================== */

/** Physical (a copy leaves the shelf) vs digital (a licence is consumed). */
export const LOAN_TYPE = Object.freeze({
  PHYSICAL: 'PHYSICAL',
  DIGITAL: 'DIGITAL',
});
export const LOAN_TYPE_VALUES = Object.freeze(Object.values(LOAN_TYPE));

/**
 * Loan lifecycle.
 *
 *   ACTIVE ──(returned in time)──> RETURNED
 *     │
 *     ├──(due date passes, cron)──> OVERDUE ──(returned)──> RETURNED (+ fine)
 *     ├──(staff marks lost)───────> LOST (+ replacement fine)
 *     └──(digital term elapses)───> EXPIRED
 */
export const LOAN_STATUS = Object.freeze({
  /** Out with the borrower, not yet past due. */
  ACTIVE: 'ACTIVE',
  /** Given back. Terminal. */
  RETURNED: 'RETURNED',
  /** Past the due date and still out. Set by the nightly cron job. */
  OVERDUE: 'OVERDUE',
  /** Declared lost by staff. Terminal, with a replacement fine. */
  LOST: 'LOST',
  /** A digital loan whose term elapsed; the licence was released. Terminal. */
  EXPIRED: 'EXPIRED',
});
export const LOAN_STATUS_VALUES = Object.freeze(Object.values(LOAN_STATUS));

/** Statuses where the item is still in the borrower's hands. */
export const OPEN_LOAN_STATUSES = Object.freeze([LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE]);

/** Statuses where the loan is finished and the copy/licence is free. */
export const CLOSED_LOAN_STATUSES = Object.freeze([
  LOAN_STATUS.RETURNED,
  LOAN_STATUS.LOST,
  LOAN_STATUS.EXPIRED,
]);

/* ===========================================================================
 * FINES
 * ======================================================================== */

/** Why a fine was raised. */
export const FINE_REASON = Object.freeze({
  /** Accrued per day past the due date, after the grace period. */
  OVERDUE: 'OVERDUE',
  /** Returned in materially worse condition. */
  DAMAGE: 'DAMAGE',
  /** Never returned — charged at replacement cost. */
  LOST: 'LOST',
  /** Manually raised by staff, with a mandatory note. */
  MANUAL: 'MANUAL',
});
export const FINE_REASON_VALUES = Object.freeze(Object.values(FINE_REASON));

/**
 * Fine settlement state. PENDING fines are what count toward the
 * borrowing-block threshold.
 */
export const FINE_STATUS = Object.freeze({
  /** Owed. Still accruing if the loan is open. */
  PENDING: 'PENDING',
  /** Settled at the desk. */
  PAID: 'PAID',
  /** Forgiven by staff. Requires a note and is written to the audit log. */
  WAIVED: 'WAIVED',
});
export const FINE_STATUS_VALUES = Object.freeze(Object.values(FINE_STATUS));

/* ===========================================================================
 * REVIEWS
 * ======================================================================== */

/** Moderation state. Only APPROVED reviews are publicly visible and counted. */
export const REVIEW_STATUS = Object.freeze({
  /** Awaiting moderation (auto-set when AI or heuristics flag it). */
  PENDING: 'PENDING',
  /** Published and included in the book's rating aggregate. */
  APPROVED: 'APPROVED',
  /** Rejected by a moderator or by the AI moderation pass. */
  REJECTED: 'REJECTED',
});
export const REVIEW_STATUS_VALUES = Object.freeze(Object.values(REVIEW_STATUS));

/** Verdict from the AI (or heuristic) moderation pass on a review. */
export const MODERATION_VERDICT = Object.freeze({
  CLEAN: 'CLEAN',
  /** Borderline — published but surfaced in the moderation queue. */
  FLAGGED: 'FLAGGED',
  /** Clearly abusive or spam — held back from publication. */
  BLOCKED: 'BLOCKED',
  /** Moderation did not run (feature disabled or unavailable). */
  NOT_CHECKED: 'NOT_CHECKED',
});
export const MODERATION_VERDICT_VALUES = Object.freeze(Object.values(MODERATION_VERDICT));

/* ===========================================================================
 * READING LISTS
 * ======================================================================== */

/**
 * The four default shelves are created automatically for every new member;
 * CUSTOM covers anything the member names themselves.
 */
export const READING_LIST_TYPE = Object.freeze({
  FAVORITES: 'FAVORITES',
  WANT_TO_READ: 'WANT_TO_READ',
  READING: 'READING',
  FINISHED: 'FINISHED',
  CUSTOM: 'CUSTOM',
});
export const READING_LIST_TYPE_VALUES = Object.freeze(Object.values(READING_LIST_TYPE));

/** Shelves auto-created on registration. Cannot be renamed or deleted. */
export const DEFAULT_READING_LISTS = Object.freeze([
  { type: READING_LIST_TYPE.FAVORITES, name: 'Favorites' },
  { type: READING_LIST_TYPE.WANT_TO_READ, name: 'Want to Read' },
  { type: READING_LIST_TYPE.READING, name: 'Currently Reading' },
  { type: READING_LIST_TYPE.FINISHED, name: 'Finished' },
]);

/* ===========================================================================
 * NOTIFICATIONS
 * ======================================================================== */

/**
 * Every notification the system can raise. Members can mute any of these
 * per channel through their notification preferences.
 */
export const NOTIFICATION_TYPE = Object.freeze({
  WELCOME: 'WELCOME',
  PASSWORD_RESET: 'PASSWORD_RESET',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  /** Fires DUE_REMINDER_DAYS_BEFORE days ahead of the due date. */
  DUE_SOON: 'DUE_SOON',
  OVERDUE: 'OVERDUE',
  BOOK_BORROWED: 'BOOK_BORROWED',
  BOOK_RETURNED: 'BOOK_RETURNED',
  LOAN_RENEWED: 'LOAN_RENEWED',
  DIGITAL_LOAN_EXPIRING: 'DIGITAL_LOAN_EXPIRING',
  DIGITAL_LOAN_EXPIRED: 'DIGITAL_LOAN_EXPIRED',
  FINE_ISSUED: 'FINE_ISSUED',
  FINE_PAID: 'FINE_PAID',
  FINE_WAIVED: 'FINE_WAIVED',
  REVIEW_APPROVED: 'REVIEW_APPROVED',
  REVIEW_REJECTED: 'REVIEW_REJECTED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ACCOUNT_REACTIVATED: 'ACCOUNT_REACTIVATED',
  /** A new title arrived in a category the member has favourites in. */
  NEW_BOOK_IN_INTEREST: 'NEW_BOOK_IN_INTEREST',
});
export const NOTIFICATION_TYPE_VALUES = Object.freeze(Object.values(NOTIFICATION_TYPE));

/** Delivery channels. IN_APP is always on; EMAIL respects user preferences. */
export const NOTIFICATION_CHANNEL = Object.freeze({
  IN_APP: 'IN_APP',
  EMAIL: 'EMAIL',
});
export const NOTIFICATION_CHANNEL_VALUES = Object.freeze(Object.values(NOTIFICATION_CHANNEL));

/** Outcome of an attempted delivery, recorded per notification. */
export const DELIVERY_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  /** Suppressed by the member's notification preferences. */
  SKIPPED: 'SKIPPED',
});
export const DELIVERY_STATUS_VALUES = Object.freeze(Object.values(DELIVERY_STATUS));

/* ===========================================================================
 * AI
 * ======================================================================== */

/** The kinds of generated content cached in the AiSummary collection. */
export const AI_SUMMARY_KIND = Object.freeze({
  /** Prose summary of the book. */
  SUMMARY: 'SUMMARY',
  /** 5-7 bullet points. */
  KEY_TAKEAWAYS: 'KEY_TAKEAWAYS',
  /** Plain-language version aimed at a 15-year-old reader. */
  SIMPLIFIED: 'SIMPLIFIED',
  /** An answer to a specific member question about the book. */
  QA: 'QA',
});
export const AI_SUMMARY_KIND_VALUES = Object.freeze(Object.values(AI_SUMMARY_KIND));

/** Requested summary length. Part of the cache key. */
export const AI_SUMMARY_LENGTH = Object.freeze({
  SHORT: 'SHORT',
  MEDIUM: 'MEDIUM',
  LONG: 'LONG',
});
export const AI_SUMMARY_LENGTH_VALUES = Object.freeze(Object.values(AI_SUMMARY_LENGTH));

/** Approximate word budget per length, injected into the prompt. */
export const AI_LENGTH_WORD_TARGET = Object.freeze({
  [AI_SUMMARY_LENGTH.SHORT]: 90,
  [AI_SUMMARY_LENGTH.MEDIUM]: 220,
  [AI_SUMMARY_LENGTH.LONG]: 450,
});

/** Named AI capabilities, used for feature flags, rate limits and usage logs. */
export const AI_FEATURE = Object.freeze({
  SUMMARY: 'SUMMARY',
  KEY_TAKEAWAYS: 'KEY_TAKEAWAYS',
  SIMPLIFIED: 'SIMPLIFIED',
  QA: 'QA',
  RECOMMENDATIONS: 'RECOMMENDATIONS',
  REVIEW_MODERATION: 'REVIEW_MODERATION',
  METADATA_ENRICHMENT: 'METADATA_ENRICHMENT',
});
export const AI_FEATURE_VALUES = Object.freeze(Object.values(AI_FEATURE));

/** Where a piece of AI content actually came from. Always surfaced to callers. */
export const AI_SOURCE = Object.freeze({
  /** A real call to the upstream model. */
  LIVE: 'live',
  /** Served from the AiSummary cache — cost zero calls. */
  CACHE: 'cache',
  /** Generated offline by the deterministic mock provider. */
  MOCK: 'mock',
});
export const AI_SOURCE_VALUES = Object.freeze(Object.values(AI_SOURCE));

/* ===========================================================================
 * AUDIT LOG
 * ======================================================================== */

/** Entities whose mutations are recorded in the audit log. */
export const AUDIT_ENTITY = Object.freeze({
  USER: 'USER',
  BOOK: 'BOOK',
  BOOK_COPY: 'BOOK_COPY',
  AUTHOR: 'AUTHOR',
  PUBLISHER: 'PUBLISHER',
  CATEGORY: 'CATEGORY',
  LOAN: 'LOAN',
  FINE: 'FINE',
  REVIEW: 'REVIEW',
  DIGITAL_ASSET: 'DIGITAL_ASSET',
  AI_SUMMARY: 'AI_SUMMARY',
  SYSTEM: 'SYSTEM',
});
export const AUDIT_ENTITY_VALUES = Object.freeze(Object.values(AUDIT_ENTITY));

/** Coarse action verbs. The detail lives in the before/after diff. */
export const AUDIT_ACTION = Object.freeze({
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  RESTORE: 'RESTORE',
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  ROLE_CHANGE: 'ROLE_CHANGE',
  SUSPEND: 'SUSPEND',
  REACTIVATE: 'REACTIVATE',
  ISSUE: 'ISSUE',
  RETURN: 'RETURN',
  RENEW: 'RENEW',
  MARK_LOST: 'MARK_LOST',
  FINE_WAIVE: 'FINE_WAIVE',
  FINE_PAY: 'FINE_PAY',
  MODERATE: 'MODERATE',
  BULK_IMPORT: 'BULK_IMPORT',
  AI_GENERATE: 'AI_GENERATE',
});
export const AUDIT_ACTION_VALUES = Object.freeze(Object.values(AUDIT_ACTION));

/* ===========================================================================
 * SHARED
 * ======================================================================== */

/** Sort directions accepted by list endpoints. */
export const SORT_ORDER = Object.freeze({ ASC: 'asc', DESC: 'desc' });
export const SORT_ORDER_VALUES = Object.freeze(Object.values(SORT_ORDER));
