/**
 * ---------------------------------------------------------------------------
 * API RESPONSE ENVELOPE
 * ---------------------------------------------------------------------------
 * Every successful response in this API has the same shape:
 *
 *     { "success": true, "message": "...", "data": ..., "meta": { ... } }
 *
 * A consistent envelope is worth the small ceremony. A client writes ONE
 * response handler instead of one per endpoint, `success` is checkable without
 * inspecting the status code, and adding `meta` later never breaks a caller
 * that only reads `data`.
 *
 * Usage in a controller:
 *     return ok(res, book, 'Book fetched');
 *     return created(res, loan, 'Book borrowed successfully');
 *     return paginated(res, books, { page, limit, total }, 'Books fetched');
 * ---------------------------------------------------------------------------
 */

import { HTTP_STATUS } from '../constants/httpStatus.js';

export class ApiResponse {
  /**
   * @param {number} statusCode
   * @param {*} data
   * @param {string} message
   * @param {object|null} meta Pagination or other envelope-level context.
   */
  constructor(statusCode, data, message = 'Success', meta = null) {
    this.statusCode = statusCode;
    this.success = statusCode < 400;
    this.message = message;
    this.data = data;
    this.meta = meta;
  }

  /** The response body. `data` is always present (possibly null) so a client
   *  can destructure it unconditionally; `meta` is omitted when empty. */
  toJSON() {
    const body = {
      success: this.success,
      message: this.message,
      data: this.data ?? null,
    };
    if (this.meta) body.meta = this.meta;
    return body;
  }
}

/* ===========================================================================
 * Send helpers
 * ======================================================================== */

/**
 * 200 OK.
 * @param {import('express').Response} res
 * @param {*} data
 * @param {string} [message]
 * @param {object|null} [meta]
 */
export const ok = (res, data = null, message = 'Success', meta = null) =>
  res.status(HTTP_STATUS.OK).json(new ApiResponse(HTTP_STATUS.OK, data, message, meta).toJSON());

/**
 * 201 Created. Pass `location` to set the Location header — good REST manners
 * and genuinely useful to a client that wants to fetch what it just made.
 */
export const created = (res, data = null, message = 'Created successfully', location = null) => {
  if (location) res.location(location);
  return res
    .status(HTTP_STATUS.CREATED)
    .json(new ApiResponse(HTTP_STATUS.CREATED, data, message).toJSON());
};

/** 202 Accepted — work acknowledged, finishing asynchronously. */
export const accepted = (res, data = null, message = 'Request accepted for processing') =>
  res.status(HTTP_STATUS.ACCEPTED).json(new ApiResponse(HTTP_STATUS.ACCEPTED, data, message).toJSON());

/**
 * 204 No Content. Deliberately sends no body — the correct response to a
 * successful DELETE, and a status code that a client can treat uniformly.
 */
export const noContent = (res) => res.status(HTTP_STATUS.NO_CONTENT).send();

/**
 * 200 with pagination metadata.
 *
 * Computes totalPages/hasNext/hasPrev here rather than making every controller
 * repeat the arithmetic — and rather than making every CLIENT repeat it, which
 * is where off-by-one bugs actually live.
 *
 * @param {import('express').Response} res
 * @param {Array} items
 * @param {{page: number, limit: number, total: number}} pageInfo
 * @param {string} [message]
 * @param {object} [extraMeta] Endpoint-specific extras, e.g. search facets.
 */
export const paginated = (res, items, pageInfo, message = 'Success', extraMeta = {}) => {
  const page = Math.max(1, Number(pageInfo.page) || 1);
  const limit = Math.max(1, Number(pageInfo.limit) || 20);
  const total = Math.max(0, Number(pageInfo.total) || 0);
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;

  const meta = {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    ...extraMeta,
  };

  return res.status(HTTP_STATUS.OK).json(new ApiResponse(HTTP_STATUS.OK, items, message, meta).toJSON());
};

/**
 * Generic sender for a non-standard status code.
 * Prefer a named helper above where one fits — `ok(res, book)` reads better
 * than `send(res, 200, book)`.
 */
export const send = (res, statusCode, data = null, message = 'Success', meta = null) =>
  res.status(statusCode).json(new ApiResponse(statusCode, data, message, meta).toJSON());

export default ApiResponse;
