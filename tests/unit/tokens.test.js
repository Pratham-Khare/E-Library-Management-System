/**
 * JWT signing and verification.
 *
 * The security-relevant assertions here are the TYPE-CONFUSION ones: a
 * password-reset token must never be presentable as an access token. That
 * property is what makes a reset link sitting in an inbox for years harmless.
 */

import { describe, test, expect } from '@jest/globals';
import jwt from 'jsonwebtoken';
import {
  signToken,
  signAccessToken,
  signResetToken,
  signDownloadToken,
  verifyToken,
  verifyAccessToken,
  verifyResetToken,
  extractBearerToken,
  decodeTokenUnsafe,
  expiryFromDuration,
  TOKEN_TYPES,
} from '../../src/utils/tokens.js';
import { ApiError } from '../../src/utils/ApiError.js';

const user = { id: '6a7e0aac482cc9b7814ab700', role: 'MEMBER', membershipType: 'STUDENT' };

describe('signAccessToken', () => {
  test('produces a verifiable token', () => {
    const payload = verifyAccessToken(signAccessToken(user));
    expect(payload.sub).toBe(user.id);
    expect(payload.role).toBe('MEMBER');
    expect(payload.membershipType).toBe('STUDENT');
  });

  test('embeds a type claim', () => {
    expect(decodeTokenUnsafe(signAccessToken(user)).type).toBe(TOKEN_TYPES.ACCESS);
  });

  test('carries issuer and audience claims', () => {
    const decoded = decodeTokenUnsafe(signAccessToken(user));
    expect(decoded.iss).toBeDefined();
    expect(decoded.aud).toBeDefined();
  });

  test('carries iat and exp', () => {
    const decoded = decodeTokenUnsafe(signAccessToken(user));
    expect(decoded.iat).toBeDefined();
    expect(decoded.exp).toBeGreaterThan(decoded.iat);
  });
});

describe('token type confusion', () => {
  /**
   * THE POINT OF FOUR SEPARATE SECRETS.
   *
   * A reset token is emailed in plaintext and may sit in an inbox for years.
   * If it could be replayed as an access token, anyone holding an old reset
   * email would have API credentials.
   */
  test('a RESET token cannot be used as an ACCESS token', () => {
    const resetToken = signResetToken(user.id, 'nonce-123');
    expect(() => verifyAccessToken(resetToken)).toThrow(ApiError);
  });

  test('an ACCESS token cannot be used as a RESET token', () => {
    expect(() => verifyResetToken(signAccessToken(user))).toThrow(ApiError);
  });

  test('a DOWNLOAD token cannot be used as an ACCESS token', () => {
    const downloadToken = signDownloadToken({
      userId: user.id,
      assetId: 'asset-1',
      loanId: 'loan-1',
    });
    expect(() => verifyAccessToken(downloadToken)).toThrow(ApiError);
  });

  test('the refusal is a typed error, not a raw jsonwebtoken error', () => {
    try {
      verifyAccessToken(signResetToken(user.id, 'n'));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error.statusCode).toBe(401);
    }
  });
});

describe('signature verification', () => {
  test('rejects a token signed with a different secret', () => {
    const forged = jwt.sign({ sub: user.id, type: 'access' }, 'some-other-secret-entirely');
    expect(() => verifyAccessToken(forged)).toThrow(ApiError);
  });

  test('rejects a tampered payload', () => {
    const token = signAccessToken(user);
    const [header, , signature] = token.split('.');
    const evilPayload = Buffer.from(
      JSON.stringify({ sub: user.id, role: 'ADMIN', type: 'access' })
    ).toString('base64url');

    expect(() => verifyAccessToken(`${header}.${evilPayload}.${signature}`)).toThrow(ApiError);
  });

  /**
   * `algorithms: ['HS256']` on verify is a real control, not a formality:
   * without it, a token claiming `alg: none` would verify with no signature.
   */
  test('rejects an alg:none token', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: user.id, role: 'ADMIN', type: 'access' })
    ).toString('base64url');

    expect(() => verifyAccessToken(`${header}.${payload}.`)).toThrow(ApiError);
  });

  test('rejects malformed input', () => {
    expect(() => verifyAccessToken('not.a.token')).toThrow(ApiError);
    expect(() => verifyAccessToken('garbage')).toThrow(ApiError);
    expect(() => verifyAccessToken('')).toThrow(ApiError);
  });
});

describe('expiry', () => {
  test('an expired token is rejected with TOKEN_EXPIRED, not INVALID_TOKEN', () => {
    // Signed directly with a negative lifetime so it is already expired.
    const expired = jwt.sign(
      { sub: user.id, type: TOKEN_TYPES.ACCESS },
      process.env.JWT_ACCESS_SECRET,
      {
        expiresIn: '-1s',
        issuer: process.env.JWT_ISSUER ?? 'e-library-api',
        audience: process.env.JWT_AUDIENCE ?? 'e-library-client',
      }
    );

    try {
      verifyAccessToken(expired);
      throw new Error('should have thrown');
    } catch (error) {
      // The distinction matters: expired means "refresh and retry", invalid
      // means "send the user back to the login screen".
      expect(error.code).toBe('TOKEN_EXPIRED');
    }
  });
});

describe('extractBearerToken', () => {
  test('extracts a well-formed Bearer token', () => {
    expect(extractBearerToken({ headers: { authorization: 'Bearer abc123' } })).toBe('abc123');
  });

  test('is case-insensitive on the scheme', () => {
    expect(extractBearerToken({ headers: { authorization: 'bearer abc123' } })).toBe('abc123');
  });

  test('returns null when there is no header', () => {
    expect(extractBearerToken({ headers: {} })).toBeNull();
  });

  test('returns null for a different scheme', () => {
    expect(extractBearerToken({ headers: { authorization: 'Basic abc123' } })).toBeNull();
  });

  test('returns null for a scheme with no token', () => {
    expect(extractBearerToken({ headers: { authorization: 'Bearer' } })).toBeNull();
    expect(extractBearerToken({ headers: { authorization: 'Bearer ' } })).toBeNull();
  });
});

describe('expiryFromDuration', () => {
  test.each([
    ['15m', 15 * 60_000],
    ['7d', 7 * 86_400_000],
    ['30s', 30_000],
    ['1h', 3_600_000],
  ])('parses %s', (duration, expectedMs) => {
    const before = Date.now();
    const expiry = expiryFromDuration(duration);
    // Allow a small window for execution time.
    expect(expiry.getTime() - before).toBeGreaterThanOrEqual(expectedMs - 100);
    expect(expiry.getTime() - before).toBeLessThanOrEqual(expectedMs + 1000);
  });

  test('a bare number is treated as milliseconds', () => {
    const before = Date.now();
    expect(expiryFromDuration('5000').getTime() - before).toBeGreaterThanOrEqual(4900);
  });

  test('throws on an unparseable duration', () => {
    expect(() => expiryFromDuration('not-a-duration')).toThrow();
  });
});

describe('decodeTokenUnsafe', () => {
  test('reads claims without verifying', () => {
    const forged = jwt.sign({ sub: 'anyone', type: 'access' }, 'wrong-secret');
    // Deliberately succeeds — this is for inspection and logging only.
    expect(decodeTokenUnsafe(forged).sub).toBe('anyone');
  });

  test('returns null for garbage rather than throwing', () => {
    expect(decodeTokenUnsafe('garbage')).toBeNull();
  });
});

describe('signToken', () => {
  test('round-trips an arbitrary payload for each token type', () => {
    for (const type of Object.values(TOKEN_TYPES)) {
      const token = signToken(type, { sub: 'x', custom: 'value' });
      expect(verifyToken(type, token).custom).toBe('value');
    }
  });
});
