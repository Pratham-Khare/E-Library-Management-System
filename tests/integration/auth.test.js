/**
 * Authentication, end to end through the real Express app.
 *
 * The properties worth testing here are the security ones — mass-assignment
 * defence, user-enumeration resistance, and refresh-token reuse detection —
 * because each is invisible in a happy-path test and expensive to get wrong.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import request from 'supertest';
import { connect, clearDatabase, disconnect } from '../helpers/db.js';
import { createMember, createAdmin, login, auth, TEST_PASSWORD } from '../helpers/fixtures.js';

let app;

beforeAll(async () => {
  await connect();
  // Imported after the connection exists so model registration is settled.
  app = (await import('../../src/app.js')).default;
});

afterAll(async () => {
  await disconnect();
});

beforeEach(async () => {
  await clearDatabase();
});

describe('POST /auth/register', () => {
  test('creates a member and returns a token pair', async () => {
    const response = await request(app).post('/api/v1/auth/register').send({
      name: 'Ananya Sharma',
      email: 'ananya@test.local',
      password: TEST_PASSWORD,
    });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.tokens.accessToken).toBeDefined();
    expect(response.body.data.tokens.refreshToken).toBeDefined();
    expect(response.body.data.user.email).toBe('ananya@test.local');
  });

  test('assigns a membership number', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Test', email: 'membership@test.local', password: TEST_PASSWORD });

    expect(response.body.data.user.membershipNumber).toMatch(/^LIB-\d{4}-\d{6}$/);
  });

  test('never serialises the password hash', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Test', email: 'hash@test.local', password: TEST_PASSWORD });

    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    expect(JSON.stringify(response.body)).not.toContain('$2a$');
  });

  /**
   * MASS-ASSIGNMENT DEFENCE.
   *
   * `role` is stripped by the validator and hard-coded in the service, so
   * sending it is a silent no-op rather than a privilege escalation.
   */
  test('cannot self-promote to ADMIN', async () => {
    const response = await request(app).post('/api/v1/auth/register').send({
      name: 'Sneaky',
      email: 'sneaky@test.local',
      password: TEST_PASSWORD,
      role: 'ADMIN',
    });

    expect(response.status).toBe(201);
    expect(response.body.data.user.role).toBe('MEMBER');
  });

  test('cannot inject statistics', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({
        name: 'Sneaky',
        email: 'stats@test.local',
        password: TEST_PASSWORD,
        stats: { outstandingFine: -9999 },
      });

    expect(response.body.data.user.stats.outstandingFine).toBe(0);
  });

  test('the borrowing policy reflects the membership tier', async () => {
    const response = await request(app).post('/api/v1/auth/register').send({
      name: 'Student',
      email: 'student@test.local',
      password: TEST_PASSWORD,
      membershipType: 'STUDENT',
      studentProfile: { enrollmentNo: 'CS2023001', department: 'Computer Science' },
    });

    expect(response.body.data.user.borrowingPolicy).toMatchObject({
      loanPeriodDays: 21,
      maxActiveLoans: 5,
      maxRenewals: 2,
    });
  });

  test('a STUDENT without an enrolment number is rejected, naming the field', async () => {
    const response = await request(app).post('/api/v1/auth/register').send({
      name: 'No Enrolment',
      email: 'noenrol@test.local',
      password: TEST_PASSWORD,
      membershipType: 'STUDENT',
    });

    expect(response.status).toBe(422);
    expect(response.body.errors.some((e) => e.field === 'studentProfile.enrollmentNo')).toBe(true);
  });

  test('rejects a duplicate email', async () => {
    await createMember({ email: 'taken@test.local' });

    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Duplicate', email: 'taken@test.local', password: TEST_PASSWORD });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  test('reports every invalid field at once', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'X', email: 'not-an-email', password: 'weak' });

    expect(response.status).toBe(422);
    expect(response.body.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('POST /auth/login', () => {
  test('signs in with correct credentials', async () => {
    await createMember({ email: 'login@test.local' });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'login@test.local', password: TEST_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.data.tokens.accessToken).toBeDefined();
  });

  /**
   * USER-ENUMERATION RESISTANCE.
   *
   * Distinguishing "no such account" from "wrong password" turns the login
   * endpoint into a membership-list oracle: submit addresses, read which come
   * back differently.
   */
  test('an unknown email and a wrong password are INDISTINGUISHABLE', async () => {
    await createMember({ email: 'real@test.local' });

    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'real@test.local', password: 'WrongPass1' });

    const unknownEmail = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@test.local', password: 'WrongPass1' });

    expect(wrongPassword.status).toBe(unknownEmail.status);
    expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
    expect(wrongPassword.body.code).toBe(unknownEmail.body.code);
    expect(wrongPassword.body.code).toBe('INVALID_CREDENTIALS');
  });

  test('a suspended account is refused, with the reason', async () => {
    await createMember({
      email: 'suspended@test.local',
      status: 'SUSPENDED',
      suspensionReason: 'Unpaid replacement charges',
    });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'suspended@test.local', password: TEST_PASSWORD });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ACCOUNT_SUSPENDED');
    expect(response.body.message).toContain('Unpaid replacement charges');
  });
});

describe('refresh token rotation', () => {
  test('exchanging a refresh token issues a DIFFERENT one', async () => {
    await createMember({ email: 'rotate@test.local' });
    const session = await login(request, app, 'rotate@test.local');

    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken });

    expect(response.status).toBe(200);
    expect(response.body.data.tokens.refreshToken).not.toBe(session.refreshToken);
  });

  /**
   * REUSE DETECTION — the property that makes a stolen refresh token useful
   * only until its rightful owner next refreshes.
   *
   * A legitimate client always holds the newest token, so presenting a rotated
   * one means two parties hold tokens from the same family. We cannot tell
   * which is the thief, so the whole family is revoked.
   */
  test('replaying a rotated token revokes the ENTIRE session family', async () => {
    await createMember({ email: 'reuse@test.local' });
    const session = await login(request, app, 'reuse@test.local');

    // Rotate twice: original → A → B
    const first = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken });
    const tokenA = first.body.data.tokens.refreshToken;

    const second = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: tokenA });
    const tokenB = second.body.data.tokens.refreshToken;
    expect(second.status).toBe(200);

    // Replay the ORIGINAL, rotated away two exchanges ago.
    const replay = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken });

    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('REFRESH_TOKEN_REUSED');

    // The currently-valid token is now dead too — the whole family went.
    const afterReuse = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: tokenB });
    expect(afterReuse.status).toBe(401);
  });

  test('an unknown refresh token is rejected', async () => {
    const response = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: 'not-a-real-token' });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('REFRESH_TOKEN_INVALID');
  });
});

describe('GET /auth/me', () => {
  test('returns the caller', async () => {
    await createMember({ email: 'me@test.local' });
    const session = await login(request, app, 'me@test.local');

    const response = await request(app).get('/api/v1/auth/me').set(auth(session.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.email).toBe('me@test.local');
  });

  test('requires a token', async () => {
    const response = await request(app).get('/api/v1/auth/me');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('MISSING_TOKEN');
  });

  test('rejects a malformed token', async () => {
    const response = await request(app).get('/api/v1/auth/me').set(auth('garbage.token.here'));
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('INVALID_TOKEN');
  });

  /**
   * The authenticate middleware re-reads the user on every request, so a
   * suspension takes effect immediately rather than when the token expires.
   */
  test('a token stops working the moment the account is suspended', async () => {
    const user = await createMember({ email: 'midsession@test.local' });
    const session = await login(request, app, 'midsession@test.local');

    expect((await request(app).get('/api/v1/auth/me').set(auth(session.accessToken))).status).toBe(200);

    user.status = 'SUSPENDED';
    await user.save();

    const after = await request(app).get('/api/v1/auth/me').set(auth(session.accessToken));
    expect(after.status).toBe(403);
    expect(after.body.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('password reset', () => {
  test('forgot-password returns 200 for an UNKNOWN email too', async () => {
    const known = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody@test.local' });

    expect(known.status).toBe(200);
  });

  test('the reset token is single-use', async () => {
    await createMember({ email: 'reset@test.local' });

    const forgot = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'reset@test.local' });

    // Exposed in development so the flow is testable without a mail provider.
    const token = forgot.body.data.devToken;
    expect(token).toBeDefined();

    const first = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'NewStr0ngPass', confirmPassword: 'NewStr0ngPass' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, password: 'AnotherPass1', confirmPassword: 'AnotherPass1' });

    expect(second.status).toBe(400);
    expect(second.body.code).toBe('RESET_TOKEN_INVALID');
  });

  /**
   * `passwordChangedAt` invalidates any token minted before the change, so a
   * reset takes effect instantly rather than after the access token's window.
   */
  test('a reset invalidates access tokens issued beforehand', async () => {
    await createMember({ email: 'invalidate@test.local' });
    const session = await login(request, app, 'invalidate@test.local');

    /**
     * The comparison is at ONE-SECOND granularity, because a JWT's `iat` claim
     * is whole seconds. A token minted in the same second as the reset is
     * deliberately allowed — flooring both sides is what stops a token issued
     * microseconds *before* the change from being wrongly rejected.
     *
     * Tests run far faster than a human clicking a reset link, so this waits
     * past the boundary rather than asserting on a window that cannot occur in
     * practice.
     */
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const forgot = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'invalidate@test.local' });

    await request(app).post('/api/v1/auth/reset-password').send({
      token: forgot.body.data.devToken,
      password: 'NewStr0ngPass',
      confirmPassword: 'NewStr0ngPass',
    });

    const stale = await request(app).get('/api/v1/auth/me').set(auth(session.accessToken));
    expect(stale.status).toBe(401);
  });
});

describe('the response envelope', () => {
  test('errors carry a stable code and a requestId', async () => {
    const response = await request(app).get('/api/v1/auth/me');

    expect(response.body).toMatchObject({
      success: false,
      code: expect.any(String),
      requestId: expect.any(String),
    });
  });

  test('the requestId matches the X-Request-Id header', async () => {
    const response = await request(app).get('/api/v1/auth/me');
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });
});
