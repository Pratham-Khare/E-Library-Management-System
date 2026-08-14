/**
 * ---------------------------------------------------------------------------
 * MACHINE-READABLE ERROR CODES
 * ---------------------------------------------------------------------------
 * Every failure response carries a stable `code` alongside its human message:
 *
 *     { "success": false, "message": "No copies available",
 *       "code": "NO_COPY_AVAILABLE", "requestId": "0f3a…" }
 *
 * The message is for people and may be reworded at any time. The CODE is the
 * contract a client programs against — so a frontend can branch on
 * NO_COPY_AVAILABLE without string-matching English prose, and so error rates
 * can be grouped meaningfully in logs.
 *
 * Codes are grouped by domain and never reused or renamed once shipped.
 * ---------------------------------------------------------------------------
 */

export const ERROR_CODES = Object.freeze({
  /* --- Generic ------------------------------------------------------- */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  CONFLICT: 'CONFLICT',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  /** A route exists but the feature is switched off in config. */
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  /** Malformed ObjectId in a path or query parameter. */
  INVALID_ID: 'INVALID_ID',
  /** A unique index rejected the write. */
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  /* --- Authentication -------------------------------------------------- */
  /** No Authorization header, or it is not a well-formed Bearer token. */
  MISSING_TOKEN: 'MISSING_TOKEN',
  /** Signature failed, or issuer/audience did not match. */
  INVALID_TOKEN: 'INVALID_TOKEN',
  /** Well-formed and correctly signed, but past its exp claim. */
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  /** Email or password did not match. Deliberately vague — never reveal which. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** The refresh token was already rotated. Whole token family is revoked. */
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  REFRESH_TOKEN_EXPIRED: 'REFRESH_TOKEN_EXPIRED',
  /** The password-reset token is unknown, already used, or expired. */
  RESET_TOKEN_INVALID: 'RESET_TOKEN_INVALID',
  /** Correct current password required to change it. */
  INCORRECT_PASSWORD: 'INCORRECT_PASSWORD',
  /** Registration attempted with an email that already exists. */
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',

  /* --- Authorisation ---------------------------------------------------- */
  /** Authenticated, but the role is insufficient for this route. */
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  /** Trying to act on a resource belonging to someone else. */
  NOT_RESOURCE_OWNER: 'NOT_RESOURCE_OWNER',
  /** Login refused because staff suspended the account. */
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  /** An admin tried to demote or delete the last remaining admin. */
  LAST_ADMIN_PROTECTED: 'LAST_ADMIN_PROTECTED',

  /* --- Users ------------------------------------------------------------ */
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  /** STUDENT / FACULTY membership requires studentProfile details. */
  STUDENT_PROFILE_REQUIRED: 'STUDENT_PROFILE_REQUIRED',
  /** Enrolment number already belongs to another member. */
  ENROLLMENT_NUMBER_TAKEN: 'ENROLLMENT_NUMBER_TAKEN',
  /** Email domain is not on the college allow-list for a student account. */
  INVALID_COLLEGE_EMAIL: 'INVALID_COLLEGE_EMAIL',

  /* --- Catalogue -------------------------------------------------------- */
  BOOK_NOT_FOUND: 'BOOK_NOT_FOUND',
  BOOK_ARCHIVED: 'BOOK_ARCHIVED',
  /** ISBN-10 / ISBN-13 checksum failed. */
  INVALID_ISBN: 'INVALID_ISBN',
  ISBN_ALREADY_EXISTS: 'ISBN_ALREADY_EXISTS',
  AUTHOR_NOT_FOUND: 'AUTHOR_NOT_FOUND',
  PUBLISHER_NOT_FOUND: 'PUBLISHER_NOT_FOUND',
  CATEGORY_NOT_FOUND: 'CATEGORY_NOT_FOUND',
  /** Setting this parent would make the category tree cyclic. */
  CATEGORY_CYCLE_DETECTED: 'CATEGORY_CYCLE_DETECTED',
  /** Refusing to delete a taxonomy record still referenced by books. */
  CATEGORY_HAS_BOOKS: 'CATEGORY_HAS_BOOKS',
  AUTHOR_HAS_BOOKS: 'AUTHOR_HAS_BOOKS',
  PUBLISHER_HAS_BOOKS: 'PUBLISHER_HAS_BOOKS',
  COPY_NOT_FOUND: 'COPY_NOT_FOUND',
  /** Accession numbers are the physical barcode — they must be unique. */
  ACCESSION_NUMBER_TAKEN: 'ACCESSION_NUMBER_TAKEN',
  /** Cannot remove a copy that is currently out with a borrower. */
  COPY_ON_LOAN: 'COPY_ON_LOAN',

  /* --- Circulation ------------------------------------------------------ */
  LOAN_NOT_FOUND: 'LOAN_NOT_FOUND',
  /** Every physical copy is out. Response carries the earliest due date. */
  NO_COPY_AVAILABLE: 'NO_COPY_AVAILABLE',
  /** All concurrent digital licences are in use. */
  NO_LICENSE_AVAILABLE: 'NO_LICENSE_AVAILABLE',
  /** This book has no ebook attached. */
  NO_DIGITAL_EDITION: 'NO_DIGITAL_EDITION',
  /** Member already has this title on loan. */
  ALREADY_BORROWED: 'ALREADY_BORROWED',
  /** At the concurrent-loan cap for their membership type. */
  LOAN_LIMIT_REACHED: 'LOAN_LIMIT_REACHED',
  /** Borrowing blocked: the member is holding an overdue item. */
  HAS_OVERDUE_ITEMS: 'HAS_OVERDUE_ITEMS',
  /** Borrowing blocked: unpaid fines exceed the configured threshold. */
  OUTSTANDING_FINES: 'OUTSTANDING_FINES',
  /** Already renewed the maximum number of times. */
  RENEWAL_LIMIT_REACHED: 'RENEWAL_LIMIT_REACHED',
  /** Renewal refused because the loan is already overdue — a renewal must
   *  never be a way to escape a fine that is already accruing. */
  CANNOT_RENEW_OVERDUE: 'CANNOT_RENEW_OVERDUE',
  /** The loan is already closed (returned, lost or expired). */
  LOAN_NOT_ACTIVE: 'LOAN_NOT_ACTIVE',
  /** Two concurrent requests raced for the last copy and this one lost. */
  COPY_CLAIM_FAILED: 'COPY_CLAIM_FAILED',

  /* --- Fines ------------------------------------------------------------ */
  FINE_NOT_FOUND: 'FINE_NOT_FOUND',
  FINE_ALREADY_SETTLED: 'FINE_ALREADY_SETTLED',
  /** Waiving a fine requires an explanatory note for the audit log. */
  WAIVER_NOTE_REQUIRED: 'WAIVER_NOTE_REQUIRED',

  /* --- Reviews ---------------------------------------------------------- */
  REVIEW_NOT_FOUND: 'REVIEW_NOT_FOUND',
  /** One review per member per book. */
  REVIEW_ALREADY_EXISTS: 'REVIEW_ALREADY_EXISTS',
  /** Held back by the moderation pass. */
  REVIEW_BLOCKED_BY_MODERATION: 'REVIEW_BLOCKED_BY_MODERATION',
  CANNOT_VOTE_OWN_REVIEW: 'CANNOT_VOTE_OWN_REVIEW',

  /* --- Reading lists ----------------------------------------------------- */
  LIST_NOT_FOUND: 'LIST_NOT_FOUND',
  /** The four default shelves cannot be renamed or deleted. */
  CANNOT_MODIFY_DEFAULT_LIST: 'CANNOT_MODIFY_DEFAULT_LIST',
  BOOK_ALREADY_IN_LIST: 'BOOK_ALREADY_IN_LIST',
  BOOK_NOT_IN_LIST: 'BOOK_NOT_IN_LIST',

  /* --- Files ------------------------------------------------------------- */
  FILE_REQUIRED: 'FILE_REQUIRED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  /** Declared MIME type is not on the allow-list. */
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  /** The file's magic-number signature contradicts its declared type —
   *  i.e. something was renamed to sneak past the extension check. */
  FILE_SIGNATURE_MISMATCH: 'FILE_SIGNATURE_MISMATCH',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  /** Reading an ebook requires an active digital loan for it. */
  NO_READ_ACCESS: 'NO_READ_ACCESS',
  /** Signed download link is malformed, expired, or its nonce was already used. */
  INVALID_DOWNLOAD_TOKEN: 'INVALID_DOWNLOAD_TOKEN',
  INVALID_RANGE: 'INVALID_RANGE',

  /* --- AI ----------------------------------------------------------------- */
  /** This AI capability is switched off in config/ai.js. */
  AI_FEATURE_DISABLED: 'AI_FEATURE_DISABLED',
  /** The shared 100-call budget is spent and nothing is cached. */
  AI_QUOTA_EXHAUSTED: 'AI_QUOTA_EXHAUSTED',
  /** This member hit their own daily generation cap. */
  AI_USER_LIMIT_REACHED: 'AI_USER_LIMIT_REACHED',
  /** Upstream rejected the token (401 invalid_api_key). */
  AI_INVALID_TOKEN: 'AI_INVALID_TOKEN',
  /** Upstream unreachable, timed out, or the circuit breaker is open. */
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  AI_TIMEOUT: 'AI_TIMEOUT',
  /** The model returned something that did not parse as expected. */
  AI_MALFORMED_RESPONSE: 'AI_MALFORMED_RESPONSE',
  /** AI_MOCK_MODE=never and no live call was possible. */
  AI_MOCK_DISABLED: 'AI_MOCK_DISABLED',
  /** Not enough source material (no description, no extracted text). */
  AI_INSUFFICIENT_CONTEXT: 'AI_INSUFFICIENT_CONTEXT',

  /* --- Bulk import / export ------------------------------------------------ */
  CSV_PARSE_ERROR: 'CSV_PARSE_ERROR',
  CSV_MISSING_COLUMNS: 'CSV_MISSING_COLUMNS',
  CSV_ROW_LIMIT_EXCEEDED: 'CSV_ROW_LIMIT_EXCEEDED',
});

export default ERROR_CODES;
