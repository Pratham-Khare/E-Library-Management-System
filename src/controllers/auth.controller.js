/**
 * ---------------------------------------------------------------------------
 * AUTHENTICATION CONTROLLER
 * ---------------------------------------------------------------------------
 * Thin HTTP adapters. Each handler does exactly three things: read validated
 * input off the request, call ONE service function, and serialise the result.
 *
 * No business rules live here. Keeping controllers this thin is what lets the
 * same logic be reused by the seeder and by scheduled jobs without dragging an
 * Express request along with it.
 *
 * The refresh token is ALSO set as an httpOnly cookie alongside being returned
 * in the body. Browser clients get a token JavaScript cannot read, so an XSS
 * flaw cannot exfiltrate it; non-browser clients (Postman, mobile, server-to-
 * server) read it from the body. Both are accepted on the way back in.
 * ---------------------------------------------------------------------------
 */

import config from '../config/index.js';
import * as authService from '../services/auth.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/ApiResponse.js';
import { toAuthResponse, toSelf, toSession } from '../serializers/user.serializer.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { expiryFromDuration } from '../utils/tokens.js';

/** Request metadata recorded on a session and used in security logging. */
const requestContext = (req) => ({
  ip: req.ip,
  userAgent: req.get('user-agent')?.slice(0, 500) ?? null,
});

/**
 * Cookie options for the refresh token.
 *
 *   httpOnly — JavaScript cannot read it, so XSS cannot steal it.
 *   sameSite lax — sent on normal navigation but not on cross-site POSTs,
 *                  which blocks CSRF against the refresh endpoint.
 *   secure   — HTTPS only. Off in development, where there is no TLS.
 *   path     — scoped to the auth routes, so it is not attached to every
 *              request in the app.
 */
const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: config.app.isProduction,
  sameSite: 'lax',
  path: `${config.app.apiPrefix}/auth`,
  expires: expiryFromDuration(config.jwt.tokens.refresh.expiresIn),
});

const setRefreshCookie = (res, token) =>
  res.cookie('refreshToken', token, refreshCookieOptions());

const clearRefreshCookie = (res) =>
  res.clearCookie('refreshToken', { ...refreshCookieOptions(), expires: new Date(0) });

/** Prefer the body, fall back to the cookie. Supports both client styles. */
const readRefreshToken = (req) => req.body?.refreshToken || req.cookies?.refreshToken || null;

/* ===========================================================================
 * Handlers
 * ======================================================================== */

export const register = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.register(req.body, requestContext(req));

  setRefreshCookie(res, tokens.refreshToken);

  return created(
    res,
    toAuthResponse(user, tokens),
    'Registration successful. Welcome to the library.'
  );
});

export const login = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.login(req.body, requestContext(req));

  setRefreshCookie(res, tokens.refreshToken);

  return ok(res, toAuthResponse(user, tokens), 'Signed in successfully');
});

export const refresh = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.refresh(readRefreshToken(req), requestContext(req));

  setRefreshCookie(res, tokens.refreshToken);

  return ok(res, toAuthResponse(user, tokens), 'Token refreshed');
});

export const logout = asyncHandler(async (req, res) => {
  await authService.logout(readRefreshToken(req));

  clearRefreshCookie(res);

  // Always reports success. Logout is idempotent, and a client that has lost
  // its token should not be told it failed to clean up.
  return ok(res, null, 'Signed out successfully');
});

export const logoutAll = asyncHandler(async (req, res) => {
  const result = await authService.logoutAll(req.user.id);

  clearRefreshCookie(res);

  return ok(res, result, `Signed out of ${result.revokedCount} session(s)`);
});

export const listSessions = asyncHandler(async (req, res) => {
  const sessions = await authService.listSessions(req.user.id);

  // Hash the caller's own token so the response can mark one row "this device"
  // — far more useful than a list of anonymous entries.
  const currentToken = readRefreshToken(req);
  const currentHash = currentToken ? RefreshToken.hashToken(currentToken) : null;

  return ok(
    res,
    sessions.map((session) => toSession(session, currentHash)),
    'Active sessions fetched'
  );
});

export const revokeSession = asyncHandler(async (req, res) => {
  const result = await authService.revokeSession(req.user.id, req.params.sessionId);
  return ok(res, result, 'Session revoked');
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const result = await authService.forgotPassword(req.body, requestContext(req));
  return ok(res, result, result.message);
});

export const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body);

  clearRefreshCookie(res);

  return ok(
    res,
    null,
    'Your password has been reset. You have been signed out of all devices — please sign in again.'
  );
});

export const changePassword = asyncHandler(async (req, res) => {
  await authService.changePassword(req.user.id, req.body);

  clearRefreshCookie(res);

  return ok(
    res,
    null,
    'Your password has been changed. You have been signed out of all other devices.'
  );
});

/** The current user. The go-to endpoint for a client restoring session state. */
export const me = asyncHandler(async (req, res) => ok(res, toSelf(req.user), 'Profile fetched'));

export default {
  register,
  login,
  refresh,
  logout,
  logoutAll,
  listSessions,
  revokeSession,
  forgotPassword,
  resetPassword,
  changePassword,
  me,
};
