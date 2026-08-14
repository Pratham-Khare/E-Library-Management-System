/**
 * ---------------------------------------------------------------------------
 * HTTP STATUS CODES
 * ---------------------------------------------------------------------------
 * Named constants instead of bare numbers. `res.status(HTTP_STATUS.CONFLICT)`
 * says why; `res.status(409)` makes the reader look it up.
 *
 * Only the codes this API actually returns are listed — an exhaustive table
 * would be noise.
 * ---------------------------------------------------------------------------
 */

export const HTTP_STATUS = Object.freeze({
  /* --- 2xx Success --------------------------------------------------- */
  /** Standard success with a body. */
  OK: 200,
  /** A resource was created. Pair with a Location header where sensible. */
  CREATED: 201,
  /** Accepted for processing that finishes later (e.g. queued text extraction). */
  ACCEPTED: 202,
  /** Success with deliberately no body — used by DELETE. */
  NO_CONTENT: 204,
  /** A byte range of a file. Returned by the ebook streaming reader. */
  PARTIAL_CONTENT: 206,

  /* --- 3xx Redirection ------------------------------------------------ */
  /** Cached representation is still valid. */
  NOT_MODIFIED: 304,

  /* --- 4xx Client error ----------------------------------------------- */
  /** Malformed syntax or a request that makes no sense. */
  BAD_REQUEST: 400,
  /** No credentials, or credentials that are invalid/expired. "Who are you?" */
  UNAUTHORIZED: 401,
  /** Authenticated, but not allowed to do this. "I know who you are, still no." */
  FORBIDDEN: 403,
  /** No such resource. */
  NOT_FOUND: 404,
  /** The HTTP verb is not supported on this route. */
  METHOD_NOT_ALLOWED: 405,
  /**
   * The request is valid but conflicts with current state.
   * This API's main use: borrowing a book with no available copies.
   */
  CONFLICT: 409,
  /** Precondition on a conditional request failed. */
  PRECONDITION_FAILED: 412,
  /** Upload exceeds the configured size cap. */
  PAYLOAD_TOO_LARGE: 413,
  /** Wrong Content-Type, or a file whose real signature is not allowed. */
  UNSUPPORTED_MEDIA_TYPE: 415,
  /** An unsatisfiable Range header on a file download. */
  RANGE_NOT_SATISFIABLE: 416,
  /**
   * Syntactically fine, semantically wrong — the standard code for a request
   * that fails schema validation.
   */
  UNPROCESSABLE_ENTITY: 422,
  /** Rate limit hit, or the AI quota is exhausted. */
  TOO_MANY_REQUESTS: 429,

  /* --- 5xx Server error ------------------------------------------------ */
  /** Unhandled failure. Should be rare and always logged with a request id. */
  INTERNAL_SERVER_ERROR: 500,
  /** Route exists but the feature is switched off by config. */
  NOT_IMPLEMENTED: 501,
  /** An upstream dependency (the AI provider, SendGrid) failed. */
  BAD_GATEWAY: 502,
  /** Temporarily unable to serve — DB down, or AI unavailable with no cache. */
  SERVICE_UNAVAILABLE: 503,
  /** An upstream dependency took too long. */
  GATEWAY_TIMEOUT: 504,
});

/** Human-readable label for a status code, used in default error messages. */
export const HTTP_STATUS_TEXT = Object.freeze({
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  206: 'Partial Content',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
});

export default HTTP_STATUS;
