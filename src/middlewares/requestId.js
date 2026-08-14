/**
 * Stamps every request with a unique id, exposes it on `req.id`, and returns
 * it in the `X-Request-Id` response header and in every error body.
 */

import { randomUUID } from 'node:crypto';

/** Conservative: UUIDs, and the alphanumeric/dash ids most tracing tools emit. */
const VALID_ID = /^[A-Za-z0-9._-]{8,128}$/;

export const requestId = (req, res, next) => {
  const inbound = req.get('X-Request-Id');

  req.id = inbound && VALID_ID.test(inbound) ? inbound : randomUUID();

  res.setHeader('X-Request-Id', req.id);
  next();
};

export default requestId;
