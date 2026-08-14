/**
 * ---------------------------------------------------------------------------
 * REQUEST ID
 * ---------------------------------------------------------------------------
 * Stamps every request with a unique id, exposes it on `req.id`, and returns
 * it in the `X-Request-Id` response header and in every error body.
 *
 * This is what turns "the app gave me an error" into a single log query. A
 * user reports the id from their failed response; you grep for it and get
 * every log line that request produced, in order.
 *
 * An inbound `X-Request-Id` is honoured so a trace started by a gateway or a
 * frontend carries through — but it is validated first. Echoing an arbitrary
 * client-supplied string straight into logs and headers invites header
 * injection and log forging.
 * ---------------------------------------------------------------------------
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
