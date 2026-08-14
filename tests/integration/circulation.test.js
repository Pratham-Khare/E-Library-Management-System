/**
 * Circulation, end to end.
 *
 * The test that matters most is at the bottom: twenty simultaneous borrows of
 * a one-copy title must produce exactly one loan. That is the atomic
 * compare-and-swap, and it is the reason borrowing is correct on a standalone
 * MongoDB with no transaction support.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import request from 'supertest';
import { connect, clearDatabase, disconnect } from '../helpers/db.js';
import {
  createMember,
  createStudent,
  createLibrarian,
  createBook,
  login,
  auth,
  TEST_PASSWORD,
} from '../helpers/fixtures.js';
import { Loan } from '../../src/models/Loan.js';
import { Fine } from '../../src/models/Fine.js';
import { Book } from '../../src/models/Book.js';
import { BookCopy } from '../../src/models/BookCopy.js';

let app;

beforeAll(async () => {
  await connect();
  app = (await import('../../src/app.js')).default;
});

afterAll(async () => {
  await disconnect();
});

beforeEach(async () => {
  await clearDatabase();
});

/** A signed-in member plus a book with `copies` copies. */
const setup = async ({ copies = 2, membershipType } = {}) => {
  const member =
    membershipType === 'STUDENT'
      ? await createStudent({ email: `borrower${Date.now()}@test.local` })
      : await createMember({ email: `borrower${Date.now()}@test.local` });

  const book = await createBook({ copies });
  const session = await login(request, app, member.email);

  return { member, book, session };
};

describe('borrowing', () => {
  test('a member can borrow an available book', async () => {
    const { book, session } = await setup();

    const response = await request(app)
      .post('/api/v1/loans')
      .set(auth(session.accessToken))
      .send({ bookId: String(book._id) });

    expect(response.status).toBe(201);
    expect(response.body.data.loan.status).toBe('ACTIVE');
    expect(response.body.data.copy.accessionNumber).toMatch(/^ACC-\d{4}-\d{6}$/);
  });

  test('the due date reflects the membership tier', async () => {
    const { book, session } = await setup({ membershipType: 'STUDENT' });

    const response = await request(app)
      .post('/api/v1/loans')
      .set(auth(session.accessToken))
      .send({ bookId: String(book._id) });

    expect(response.body.data.loanPeriodDays).toBe(21);

    // Compared as CALENDAR days — the due date is set to end-of-day.
    const dueAt = new Date(response.body.data.dueAt);
    const today = new Date();
    const days = Math.round(
      (Date.UTC(dueAt.getFullYear(), dueAt.getMonth(), dueAt.getDate()) -
        Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) /
        86_400_000
    );
    expect(days).toBe(21);
  });

  test('availability decrements', async () => {
    const { book, session } = await setup({ copies: 2 });

    await request(app)
      .post('/api/v1/loans')
      .set(auth(session.accessToken))
      .send({ bookId: String(book._id) });

    const updated = await Book.findById(book._id);
    expect(updated.inventory.availableCopies).toBe(1);
    expect(updated.inventory.totalCopies).toBe(2);
  });

  test('the copy is marked ON_LOAN and points at the loan', async () => {
    const { book, session } = await setup({ copies: 1 });

    const response = await request(app)
      .post('/api/v1/loans')
      .set(auth(session.accessToken))
      .send({ bookId: String(book._id) });

    const copy = await BookCopy.findOne({ book: book._id });
    expect(copy.status).toBe('ON_LOAN');
    expect(String(copy.currentLoan)).toBe(response.body.data.loan.id);
  });

  test('a member cannot borrow the same title twice', async () => {
    const { book, session } = await setup({ copies: 3 });

    await request(app)
      .post('/api/v1/loans')
      .set(auth(session.accessToken))
      .send({ bookId: String(book._id) });

    const second = await request(app)
      .post('/api/v1/loans')
      .set(auth(session.accessToken))
      .send({ bookId: String(book._id) });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ALREADY_BORROWED');
  });

  test('borrowing a book with no free copies reports the earliest return date', async () => {
    const { book, session } = await setup({ copies: 1 });
    await request(app)
      .post('/api/v1/loans')
      .set(auth(session.accessToken))
      .send({ bookId: String(book._id) });

    const other = await createMember({ email: 'other@test.local' });
    const otherSession = await login(request, app, other.email);

    const response = await request(app)
      .post('/api/v1/loans')
      .set(auth(otherSession.accessToken))
      .send({ bookId: String(book._id) });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('NO_COPY_AVAILABLE');
    // The single most useful thing to tell someone who cannot borrow.
    expect(response.body.details.earliestExpectedReturn).toBeDefined();
  });

  test('the concurrent-loan cap is enforced', async () => {
    const member = await createMember({ email: 'capped@test.local' });
    const session = await login(request, app, member.email);

    // PUBLIC members may hold 3.
    for (let i = 0; i < 3; i += 1) {
      const book = await createBook({ copies: 1 });
      const response = await request(app)
        .post('/api/v1/loans')
        .set(auth(session.accessToken))
        .send({ bookId: String(book._id) });
      expect(response.status).toBe(201);
    }

    const fourth = await createBook({ copies: 1 });
    const response = await request(app)
      .post('/api/v1/loans')
      .set(auth(session.accessToken))
      .send({ bookId: String(fourth._id) });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('LOAN_LIMIT_REACHED');
    expect(response.body.details).toMatchObject({ currentLoans: 3, maxLoans: 3 });
  });
});

describe('eligibility blocks', () => {
  test('an overdue item blocks further borrowing', async () => {
    const { member, session } = await setup({ copies: 1 });

    // Back-date a loan so it is overdue.
    const book = await createBook({ copies: 1 });
    const copy = await BookCopy.findOne({ book: book._id });
    await Loan.create({
      user: member._id,
      book: book._id,
      copy: copy._id,
      type: 'PHYSICAL',
      issuedAt: new Date(Date.now() - 30 * 86_400_000),
      dueAt: new Date(Date.now() - 5 * 86_400_000),
      status: 'OVERDUE',
    });

    const another = await createBook({ copies: 1 });
    const response = await request(app)
      .post('/api/v1/loans')
      .set(auth(session.accessToken))
      .send({ bookId: String(another._id) });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('HAS_OVERDUE_ITEMS');
  });

  test('fines above the threshold block borrowing', async () => {
    const { member, session } = await setup();

    await Fine.create({
      user: member._id,
      reason: 'DAMAGE',
      amount: 250, // over the ₹200 threshold
      description: 'Water damage',
    });

    const book = await createBook({ copies: 1 });
    const response = await request(app)
      .post('/api/v1/loans')
      .set(auth(session.accessToken))
      .send({ bookId: String(book._id) });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('OUTSTANDING_FINES');
    expect(response.body.details.threshold).toBe(200);
  });

  /**
   * The eligibility endpoint returns 200 EITHER WAY — a refusal is the answer
   * to the question, not an error. That is what lets a client disable a Borrow
   * button with an accurate reason.
   */
  test('GET /loans/eligibility returns 200 with a reason when refused', async () => {
    const { member, session } = await setup();
    await Fine.create({ user: member._id, reason: 'DAMAGE', amount: 250, description: 'x' });

    const book = await createBook({ copies: 1 });
    const response = await request(app)
      .get(`/api/v1/loans/eligibility?bookId=${book._id}`)
      .set(auth(session.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.eligible).toBe(false);
    expect(response.body.data.code).toBe('OUTSTANDING_FINES');
  });
});

describe('renewing', () => {
  test('a healthy loan can be renewed up to the cap', async () => {
    const { book, session } = await setup({ copies: 1, membershipType: 'STUDENT' });

    const borrow = await request(app)
      .post('/api/v1/loans')
      .set(auth(session.accessToken))
      .send({ bookId: String(book._id) });
    const loanId = borrow.body.data.loan.id;

    const first = await request(app)
      .post(`/api/v1/loans/${loanId}/renew`)
      .set(auth(session.accessToken));
    expect(first.status).toBe(200);
    expect(first.body.data.renewalsRemaining).toBe(1);

    const second = await request(app)
      .post(`/api/v1/loans/${loanId}/renew`)
      .set(auth(session.accessToken));
    expect(second.body.data.renewalsRemaining).toBe(0);

    const third = await request(app)
      .post(`/api/v1/loans/${loanId}/renew`)
      .set(auth(session.accessToken));
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('RENEWAL_LIMIT_REACHED');
  });

  /**
   * Without this rule, renewing after the fact would be a way to escape a fine
   * that is already accruing — making the whole overdue system decorative.
   */
  test('an OVERDUE loan cannot be renewed', async () => {
    const { member, session } = await setup();
    const book = await createBook({ copies: 1 });
    const copy = await BookCopy.findOne({ book: book._id });

    const loan = await Loan.create({
      user: member._id,
      book: book._id,
      copy: copy._id,
      type: 'PHYSICAL',
      issuedAt: new Date(Date.now() - 30 * 86_400_000),
      dueAt: new Date(Date.now() - 5 * 86_400_000),
      status: 'OVERDUE',
    });

    const response = await request(app)
      .post(`/api/v1/loans/${loan._id}/renew`)
      .set(auth(session.accessToken));

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CANNOT_RENEW_OVERDUE');
  });
});

describe('returning and fines', () => {
  test('returning on time raises no fine and frees the copy', async () => {
    const { book, session } = await setup({ copies: 1 });

    const borrow = await request(app)
      .post('/api/v1/loans')
      .set(auth(session.accessToken))
      .send({ bookId: String(book._id) });

    const response = await request(app)
      .post(`/api/v1/loans/${borrow.body.data.loan.id}/return`)
      .set(auth(session.accessToken))
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.data.fine).toBeNull();

    const updated = await Book.findById(book._id);
    expect(updated.inventory.availableCopies).toBe(1);
  });

  test('returning late raises a fine with the arithmetic shown', async () => {
    const librarian = await createLibrarian({ email: 'lib@test.local' });
    const librarianSession = await login(request, app, librarian.email);

    const member = await createMember({ email: 'late@test.local' });
    const book = await createBook({ copies: 1 });
    const copy = await BookCopy.findOne({ book: book._id });
    await BookCopy.updateOne({ _id: copy._id }, { $set: { status: 'ON_LOAN' } });

    // 5 days late → (5 − 2 grace) × ₹5 = ₹15
    const loan = await Loan.create({
      user: member._id,
      book: book._id,
      copy: copy._id,
      type: 'PHYSICAL',
      issuedAt: new Date(Date.now() - 26 * 86_400_000),
      dueAt: new Date(Date.now() - 5 * 86_400_000),
      status: 'OVERDUE',
    });

    const response = await request(app)
      .post(`/api/v1/loans/${loan._id}/return`)
      .set(auth(librarianSession.accessToken))
      .send({ condition: 'FAIR' });

    expect(response.status).toBe(200);
    expect(response.body.data.daysOverdue).toBe(5);
    expect(response.body.data.fine.amount).toBe(15);

    // A fine nobody can explain is a fine nobody can defend.
    expect(response.body.data.fine.calculation).toMatchObject({
      daysOverdue: 5,
      graceDays: 2,
      chargeableDays: 3,
      ratePerDay: 5,
    });
  });

  test('returning twice is refused rather than inventing a copy', async () => {
    const { book, session } = await setup({ copies: 1 });

    const borrow = await request(app)
      .post('/api/v1/loans')
      .set(auth(session.accessToken))
      .send({ bookId: String(book._id) });

    await request(app)
      .post(`/api/v1/loans/${borrow.body.data.loan.id}/return`)
      .set(auth(session.accessToken))
      .send({});

    const second = await request(app)
      .post(`/api/v1/loans/${borrow.body.data.loan.id}/return`)
      .set(auth(session.accessToken))
      .send({});

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('LOAN_NOT_ACTIVE');

    // Availability must not have been incremented twice.
    const updated = await Book.findById(book._id);
    expect(updated.inventory.availableCopies).toBe(1);
  });
});

describe('CONCURRENCY — the atomic copy claim', () => {
  /**
   * THE MOST IMPORTANT TEST IN THE SUITE.
   *
   * A read-then-write implementation lets two members both "win" the last
   * copy. The claim is a single `findOneAndUpdate` filtered on
   * `status: 'AVAILABLE'`, so MongoDB's single-document atomicity guarantees
   * exactly one match — on every deployment, transactions or not.
   */
  test('20 simultaneous borrows of ONE copy → exactly one succeeds', async () => {
    const book = await createBook({ copies: 1 });

    // 20 distinct members, each with their own session.
    const sessions = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const member = await createMember({ email: `racer${i}@test.local` });
        return login(request, app, member.email);
      })
    );

    // Fire them all at once.
    const responses = await Promise.all(
      sessions.map((session) =>
        request(app)
          .post('/api/v1/loans')
          .set(auth(session.accessToken))
          .send({ bookId: String(book._id) })
      )
    );

    const created = responses.filter((r) => r.status === 201);
    const refused = responses.filter((r) => r.status === 409);

    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(19);

    // Every refusal carries a correct, specific code.
    for (const response of refused) {
      expect(['NO_COPY_AVAILABLE', 'COPY_CLAIM_FAILED']).toContain(response.body.code);
    }

    // And the data is consistent: one loan, zero availability — not −19.
    const loans = await Loan.countDocuments({ book: book._id, status: 'ACTIVE' });
    expect(loans).toBe(1);

    const updated = await Book.findById(book._id);
    expect(updated.inventory.availableCopies).toBe(0);

    const onLoan = await BookCopy.countDocuments({ book: book._id, status: 'ON_LOAN' });
    expect(onLoan).toBe(1);
  }, 60_000);

  test('concurrent borrows of a 3-copy book produce exactly 3 loans', async () => {
    const book = await createBook({ copies: 3 });

    const sessions = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const member = await createMember({ email: `multi${i}@test.local` });
        return login(request, app, member.email);
      })
    );

    const responses = await Promise.all(
      sessions.map((session) =>
        request(app)
          .post('/api/v1/loans')
          .set(auth(session.accessToken))
          .send({ bookId: String(book._id) })
      )
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(3);

    const updated = await Book.findById(book._id);
    expect(updated.inventory.availableCopies).toBe(0);
  }, 60_000);
});

describe('staff circulation desk', () => {
  /**
   * A librarian may override a DUE DATE, but not library policy. Loan limits,
   * overdue blocks and fine thresholds are not a desk preference.
   */
  test('staff CANNOT bypass eligibility rules', async () => {
    const librarian = await createLibrarian({ email: 'desk@test.local' });
    const librarianSession = await login(request, app, librarian.email);

    const member = await createMember({ email: 'blocked@test.local' });
    await Fine.create({ user: member._id, reason: 'DAMAGE', amount: 250, description: 'x' });

    const book = await createBook({ copies: 1 });

    const response = await request(app)
      .post('/api/v1/loans/issue')
      .set(auth(librarianSession.accessToken))
      .send({ bookId: String(book._id), userId: String(member._id) });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('OUTSTANDING_FINES');
  });

  test('a member cannot list everyone else’s loans', async () => {
    const { session } = await setup();
    const response = await request(app).get('/api/v1/loans').set(auth(session.accessToken));
    expect(response.status).toBe(403);
  });
});
