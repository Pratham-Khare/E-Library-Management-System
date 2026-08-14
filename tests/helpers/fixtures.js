/**
 * ---------------------------------------------------------------------------
 * TEST FIXTURES
 * ---------------------------------------------------------------------------
 * Small builders for the records integration tests need.
 *
 * Records are created THROUGH THE MODELS rather than with `insertMany`, so the
 * pre-save hooks run — that is what generates membership numbers, slugs and
 * accession numbers, and what enforces the studentProfile invariant. A bulk
 * insert would bypass all of it and produce data the application itself would
 * consider invalid.
 * ---------------------------------------------------------------------------
 */

import { User } from '../../src/models/User.js';
import { Author } from '../../src/models/Author.js';
import { Publisher } from '../../src/models/Publisher.js';
import { Category } from '../../src/models/Category.js';
import { Book } from '../../src/models/Book.js';
import { BookCopy } from '../../src/models/BookCopy.js';
import { hashPassword } from '../../src/utils/password.js';
import { ROLES, MEMBERSHIP_TYPES } from '../../src/constants/roles.js';

export const TEST_PASSWORD = 'Str0ngPass';

/** Hashed once and reused — bcrypt is deliberately slow. */
let cachedHash = null;
const passwordHash = async () => {
  cachedHash ??= await hashPassword(TEST_PASSWORD);
  return cachedHash;
};

let counter = 0;
const unique = () => {
  counter += 1;
  return `${Date.now().toString(36)}${counter}`;
};

export const createUser = async (overrides = {}) => {
  const id = unique();

  // `createUnique` retries on a membership-number clash, so fixtures can be
  // created concurrently without flaking.
  return User.createUnique({
    name: overrides.name ?? `Test User ${id}`,
    email: overrides.email ?? `user${id}@test.local`,
    passwordHash: await passwordHash(),
    role: overrides.role ?? ROLES.MEMBER,
    membershipType: overrides.membershipType ?? MEMBERSHIP_TYPES.PUBLIC,
    ...(overrides.membershipType === MEMBERSHIP_TYPES.STUDENT
      ? { studentProfile: { enrollmentNo: `EN${id}`, department: 'Computer Science', ...overrides.studentProfile } }
      : {}),
    ...overrides,
  });
};

export const createMember = (overrides) => createUser({ role: ROLES.MEMBER, ...overrides });
export const createStudent = (overrides) =>
  createUser({ role: ROLES.MEMBER, membershipType: MEMBERSHIP_TYPES.STUDENT, ...overrides });
export const createLibrarian = (overrides) => createUser({ role: ROLES.LIBRARIAN, ...overrides });
export const createAdmin = (overrides) => createUser({ role: ROLES.ADMIN, ...overrides });

export const createAuthor = (overrides = {}) =>
  Author.create({ name: overrides.name ?? `Author ${unique()}`, ...overrides });

export const createPublisher = (overrides = {}) =>
  Publisher.create({ name: overrides.name ?? `Publisher ${unique()}`, ...overrides });

export const createCategory = (overrides = {}) =>
  Category.create({ name: overrides.name ?? `Category ${unique()}`, ...overrides });

/**
 * A book, optionally with physical copies.
 *
 * Copies are created one at a time because each accession number is derived
 * from the current document count — generating them in a batch up front would
 * produce identical numbers that the unique index then rejects.
 */
export const createBook = async ({ copies = 0, ...overrides } = {}) => {
  const book = await Book.create({
    title: overrides.title ?? `Test Book ${unique()}`,
    publishedYear: overrides.publishedYear ?? 2020,
    price: overrides.price ?? 400,
    description:
      overrides.description ??
      'A test book with a description long enough to satisfy the minimum context requirement for AI summarisation.',
    ...overrides,
  });

  for (let i = 0; i < copies; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const accessionNumber = await BookCopy.generateAccessionNumber();
    // eslint-disable-next-line no-await-in-loop
    await BookCopy.create({ book: book._id, accessionNumber, cost: book.price });
  }

  if (copies > 0) await Book.recalculateInventory(book._id);

  return Book.findById(book._id);
};

/** Sign in through the real HTTP API and return the access token. */
export const login = async (request, app, email, password = TEST_PASSWORD) => {
  const response = await request(app).post('/api/v1/auth/login').send({ email, password });

  if (response.status !== 200) {
    throw new Error(`Login failed for ${email}: ${JSON.stringify(response.body)}`);
  }

  return {
    accessToken: response.body.data.tokens.accessToken,
    refreshToken: response.body.data.tokens.refreshToken,
    user: response.body.data.user,
  };
};

/** `Authorization` header for a token. */
export const auth = (token) => ({ Authorization: `Bearer ${token}` });
