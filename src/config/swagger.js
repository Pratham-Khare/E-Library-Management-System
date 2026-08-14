/**
 * ---------------------------------------------------------------------------
 * OPENAPI / SWAGGER CONFIGURATION
 * ---------------------------------------------------------------------------
 * The base OpenAPI 3.0 document. Individual endpoints are documented with
 * JSDoc `@openapi` blocks on their route definitions, which swagger-jsdoc
 * scans and merges into this skeleton at boot.
 *
 * Documenting routes where they are defined — rather than in a separate spec
 * file — is the only approach that survives contact with a changing codebase:
 * the docs sit three lines above the handler they describe, so they get
 * updated when the handler does.
 *
 * Reusable schemas and responses are declared here once so route annotations
 * stay short and consistent.
 * ---------------------------------------------------------------------------
 */

import path from 'node:path';
import env, { ROOT_DIR } from './env.js';

export const enabled = env.SWAGGER_ENABLED;
export const route = env.SWAGGER_ROUTE;
/** The raw spec, useful for importing into Postman or generating a client. */
export const jsonRoute = `${env.SWAGGER_ROUTE}.json`;

/**
 * Files scanned for @openapi JSDoc blocks.
 *
 * Backslashes are normalised to forward slashes because glob treats `\` as an
 * ESCAPE character, not a path separator. On Windows `path.join` produces
 * `D:\project\src\routes\**\*.js`, which glob reads as escaped literals and
 * silently matches nothing — leaving Swagger UI up but completely empty, with
 * no error to explain why.
 */
const toGlob = (...segments) => path.join(ROOT_DIR, ...segments).replace(/\\/g, '/');

export const apis = Object.freeze([
  toGlob('src/routes/**/*.js'),
  toGlob('src/models/*.js'),
]);

/* Reusable components */

const securitySchemes = {
  bearerAuth: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      'Access token from `POST /auth/login`. Send as `Authorization: Bearer <token>`. Access tokens expire after 15 minutes — use `POST /auth/refresh` to get a new one.',
  },
};

const schemas = {
  /** The envelope every successful response uses. */
  SuccessResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Operation completed successfully' },
      data: { description: 'The payload. Shape varies by endpoint.' },
      meta: { $ref: '#/components/schemas/PaginationMeta' },
    },
    required: ['success', 'message'],
  },

  /** The envelope every failed response uses. */
  ErrorResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: false },
      message: {
        type: 'string',
        description: 'Human-readable explanation. May be reworded at any time.',
        example: 'No copies of this book are currently available',
      },
      code: {
        type: 'string',
        description:
          'Stable machine-readable error code. Program against this, not the message.',
        example: 'NO_COPY_AVAILABLE',
      },
      errors: {
        type: 'array',
        description: 'Per-field detail, populated for validation failures.',
        items: { $ref: '#/components/schemas/FieldError' },
      },
      requestId: {
        type: 'string',
        description: 'Correlates this response with the server log entry.',
        example: '3f9a1c2e-7b4d-4a11-9c3e-1f2b8a6d5e04',
      },
    },
    required: ['success', 'message', 'code'],
  },

  FieldError: {
    type: 'object',
    properties: {
      field: { type: 'string', example: 'email' },
      message: { type: 'string', example: 'must be a valid email address' },
    },
  },

  PaginationMeta: {
    type: 'object',
    properties: {
      page: { type: 'integer', example: 1 },
      limit: { type: 'integer', example: 20 },
      total: { type: 'integer', example: 137 },
      totalPages: { type: 'integer', example: 7 },
      hasNext: { type: 'boolean', example: true },
      hasPrev: { type: 'boolean', example: false },
    },
  },
};

/** Reusable query parameters referenced by list endpoints. */
const parameters = {
  PageParam: {
    in: 'query',
    name: 'page',
    schema: { type: 'integer', minimum: 1, default: 1 },
    description: '1-indexed page number.',
  },
  LimitParam: {
    in: 'query',
    name: 'limit',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    description: 'Results per page. Capped at 100.',
  },
  SortParam: {
    in: 'query',
    name: 'sort',
    schema: { type: 'string' },
    description: 'Sort field. Prefix with `-` for descending, e.g. `-createdAt`.',
  },
};

/** Reusable error responses, so each route annotation stays to a few lines. */
const responses = {
  BadRequest: {
    description: 'Malformed request.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
  },
  Unauthorized: {
    description: 'Missing, invalid or expired access token.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
  },
  Forbidden: {
    description: 'Authenticated, but not permitted to perform this action.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
  },
  NotFound: {
    description: 'The requested resource does not exist.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
  },
  Conflict: {
    description: 'Valid request that conflicts with current state.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
  },
  ValidationError: {
    description: 'Request failed schema validation. `errors[]` names each bad field.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
  },
  TooManyRequests: {
    description: 'Rate limit exceeded, or the AI quota is exhausted.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
  },
};

/* Tag groups — the sidebar ordering in Swagger UI */

const tags = [
  { name: 'Health', description: 'Liveness and readiness probes.' },
  { name: 'Auth', description: 'Registration, login, token refresh and password reset.' },
  { name: 'Users', description: 'Own profile, and staff-facing member management.' },
  { name: 'Books', description: 'The catalogue: create, read, update, archive.' },
  { name: 'Copies', description: 'Physical inventory — individual barcoded copies.' },
  { name: 'Authors', description: 'Author records.' },
  { name: 'Publishers', description: 'Publisher records.' },
  { name: 'Categories', description: 'Hierarchical subject classification.' },
  { name: 'Search', description: 'Full-text search, filtering, facets and suggestions.' },
  { name: 'Loans', description: 'Borrowing, returning and renewing.' },
  { name: 'Fines', description: 'Overdue charges, payment and waivers.' },
  { name: 'Reviews', description: 'Ratings, reviews and moderation.' },
  { name: 'Reading Lists', description: 'Favourites, shelves and reading progress.' },
  { name: 'Notifications', description: 'In-app notification centre and preferences.' },
  { name: 'Files', description: 'Uploads, cover images and the secured ebook reader.' },
  { name: 'AI', description: 'Summaries, takeaways, Q&A and recommendations.' },
  { name: 'Admin', description: 'Analytics, bulk operations and the audit log.' },
];

/* The document */

export const definition = {
  openapi: '3.0.3',
  info: {
    title: `${env.APP_NAME} API`,
    version: '1.0.0',
    description: `
Backend for an E-Library Management System — catalogue, circulation, digital
lending and AI-powered book summaries.

### Response envelope
Every response uses the same shape. Successes carry \`data\` (and \`meta\` when
paginated); failures carry a stable \`code\` you can branch on, plus a
\`requestId\` that matches the server log.

### Authentication
Most endpoints need \`Authorization: Bearer <accessToken>\`. Access tokens last
15 minutes; exchange the refresh token at \`POST /auth/refresh\` for a new pair.
Refresh tokens are single-use and rotate on every exchange — replaying an old
one is treated as theft and revokes the entire session family.

### Roles
\`MEMBER\` browses and borrows · \`LIBRARIAN\` runs the desk and the catalogue ·
\`ADMIN\` additionally manages users, policy and audit logs.

### AI and quota
The AI provider allows a limited number of calls in total, so generated content
is cached aggressively and rate-limited per user. Every AI response reports its
\`source\`: \`live\` (freshly generated), \`cache\` (previously generated, free) or
\`mock\` (deterministic offline output when the provider is unavailable). Mock
content is always labelled and never presented as genuine model output.
    `.trim(),
    contact: { name: 'API Support', email: env.MAIL_FROM_EMAIL },
    license: { name: 'MIT' },
  },
  servers: [
    { url: `${env.APP_URL.replace(/\/+$/, '')}${env.API_PREFIX}`, description: 'This server' },
  ],
  tags,
  components: { securitySchemes, schemas, parameters, responses },
  /** Bearer auth applies by default; public routes override with `security: []`. */
  security: [{ bearerAuth: [] }],
};

/** Options object handed straight to swagger-jsdoc. */
export const options = Object.freeze({ definition, apis });

/** Swagger UI presentation tweaks. */
export const uiOptions = Object.freeze({
  customSiteTitle: `${env.APP_NAME} — API Documentation`,
  swaggerOptions: {
    /** Keep the sidebar collapsed; 100+ endpoints expanded is unusable. */
    docExpansion: 'none',
    /** Let readers filter by tag name. */
    filter: true,
    persistAuthorization: true,
    displayRequestDuration: true,
    tryItOutEnabled: true,
  },
});

export default Object.freeze({ enabled, route, jsonRoute, definition, options, uiOptions, apis });
