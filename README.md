# E-Library Management System — Backend

A backend for a digital library: catalogue management, member accounts, physical
and digital lending, fines, search, reviews, notifications, and **AI-generated
book summaries**.

Built with **Node.js**, **Express 5** and **MongoDB** (Mongoose), in JavaScript
with ES Modules. No build step — clone, configure, run.

It serves a **general public library** and also supports a **college library**:
members are `PUBLIC`, `STUDENT` or `FACULTY`, and each tier gets its own
borrowing privileges. Students and faculty carry an academic profile
(enrolment number, department, course, year).

---

## Table of contents

- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuring `.env`](#configuring-env)
- [MongoDB setup](#mongodb-setup)
- [The AI token (and what happens without one)](#the-ai-token-and-what-happens-without-one)
- [Adding the SendGrid key later](#adding-the-sendgrid-key-later)
- [Running the server](#running-the-server)
- [Seeding demo data](#seeding-demo-data)
- [Running the tests](#running-the-tests)
- [Logging in for the first time](#logging-in-for-the-first-time)
- [API documentation](#api-documentation)
- [Library policy](#library-policy)
- [Project structure](#project-structure)
- [npm scripts](#npm-scripts)
- [Environment variable reference](#environment-variable-reference)
- [Troubleshooting](#troubleshooting)
- [Feature list](#feature-list)

---

## Quick start

If you already have Node 20+ and MongoDB running locally:

```bash
npm install
```

```bash
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead.

Then open `.env` and set the three JWT secrets (see below), and run:

```bash
npm run dev
```

Open <http://localhost:5000/api-docs> for the interactive API documentation.

---

## Prerequisites

| Requirement | Minimum | Verified with |
|---|---|---|
| **Node.js** | 20.0.0 | v24.5.0 |
| **npm** | 9 | 11.5.1 |
| **MongoDB** | 6.0 | 8.0.3 (local, standalone) |

Check what you have:

```bash
node -v && npm -v && mongosh --version
```

MongoDB Atlas works too — see [MongoDB setup](#mongodb-setup).

No other services are required. There is no Redis dependency, no Docker
requirement, and the app boots and runs fully without an AI token or a SendGrid
key (both degrade gracefully — details below).

---

## Installation

```bash
git clone https://github.com/Pratham-Khare/E-Library-Management-System.git
```

```bash
cd "E-Library Management System" && npm install
```

`npm install` should complete without native compilation. Password hashing uses
`bcryptjs` (pure JavaScript) rather than `bcrypt` specifically so that installs
never fail on a Windows machine lacking Visual Studio Build Tools.

---

## Configuring `.env`

Copy the template:

```bash
cp .env.example .env
```

`.env.example` documents all 100+ settings with their defaults. **Most can be
left alone.** Only these genuinely need your attention:

### Required — the three JWT secrets

Generate each one separately:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Run it three times and paste the results into `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET` and `JWT_RESET_SECRET`.

They must be **different from each other** and at least 32 characters. The
server refuses to start otherwise, and the reason is not pedantry: a
password-reset token gets emailed in plaintext and may sit in an inbox forever.
If it were signed with the same key as an access token, anyone holding an old
reset email could mint API credentials. Separate keys make that structurally
impossible.

### Usually worth checking

| Variable | Why you might change it |
|---|---|
| `MONGO_URI` | Points at `127.0.0.1:27017` by default. Change for Atlas or an authenticated local instance. |
| `MONGO_DB_NAME` | Defaults to `elibrary`. |
| `PORT` | Defaults to `5000`. |
| `BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` | The first admin account, created on first boot. **Change the password after logging in.** |
| `AI_API_TOKEN` | Leave blank to run in mock mode. See below. |
| `SENDGRID_API_KEY` | Leave blank for now. See below. |

### Configuration is validated at startup

Every variable is checked against a schema before the server starts. A missing
secret or a malformed number produces a readable report naming the exact key,
rather than a confusing failure at request time hours later:

```
┌────────────────────────────────────────────────────────────────────┐
│  ENVIRONMENT CONFIGURATION ERROR — the server cannot start         │
└────────────────────────────────────────────────────────────────────┘

  Found 2 problems in your .env file:

    • JWT_ACCESS_SECRET
        JWT_ACCESS_SECRET must be at least 32 characters — generate one with: …
    • MONGO_DB_NAME
        MONGO_DB_NAME is required
```

Cross-field rules are checked too — reusing one secret across token types, a
reminder scheduled after the loan period ends, a fine threshold that could never
be reached, and similar contradictions that are individually valid but wrong in
combination.

---

## MongoDB setup

### Option A — local (recommended for development)

If MongoDB is installed as a service it is probably already running.

```bash
mongosh --eval "db.runCommand({ping:1})"
```

On Windows, check the service with:

```bash
powershell -Command "Get-Service MongoDB"
```

Default `.env` values work as-is with a stock local install (no authentication):

```
MONGO_URI=mongodb://127.0.0.1:27017
MONGO_DB_NAME=elibrary
```

The database and its collections are created automatically on first write.

### Option B — MongoDB Atlas

Create a free cluster, add your IP to the Network Access allow-list, create a
database user, then:

```
MONGO_URI=mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net
MONGO_DB_NAME=elibrary
```

Keep the database name out of the URI — it belongs in `MONGO_DB_NAME` so one
URI can serve multiple environments.

### Optional — enabling transactions

MongoDB supports multi-document transactions **only on a replica set**. A stock
local install runs standalone, so transactions are unavailable there.

**This does not break anything.** The application detects the deployment type at
startup and adapts. The one place correctness genuinely matters — claiming a
copy when someone borrows a book — never relies on transactions at all: it is a
single atomic compare-and-swap that two simultaneous requests cannot both win,
on any deployment. Other multi-step writes use compensating rollback when no
transaction is available.

You will see this at boot, which is informational rather than a problem:

```
warn: MongoDB is running standalone, so multi-document transactions are
unavailable. Circulation still behaves correctly: the copy claim is a single
atomic compare-and-swap, and multi-step writes use compensating rollback.
```

To enable real transactions locally, convert to a single-node replica set. Stop
the MongoDB service, add this to `mongod.cfg` (on Windows, typically
`C:\Program Files\MongoDB\Server\8.0\bin\mongod.cfg`):

```yaml
replication:
  replSetName: rs0
```

Restart the service, then initiate the set once:

```bash
mongosh --eval "rs.initiate()"
```

Atlas clusters are replica sets already, so transactions work there with no
extra work.

---

## The AI token (and what happens without one)

Book summaries are generated through a proxy to OpenAI's `gpt-4o-mini`. Set the
token in `.env`:

```
AI_API_TOKEN=sk-your-token-here
```

### There is a hard quota of 100 calls, total

Not per day — **in total, for the lifetime of the token.** That single fact
shapes the whole AI subsystem, which is built cache-first with four independent
layers of protection:

1. **Persistent cache.** Generated summaries are stored and keyed on
   `(book, kind, length, language, promptVersion)`. Asking for the same summary
   again is a database read costing **zero** calls. This layer does most of the
   work — 50 books means at most 50 calls, no matter how many members read them.
2. **Global quota guard**, reconciled against the provider's own usage endpoint.
3. **Per-user daily cap** of 5 generations, so one member cannot burn the shared
   budget for everyone.
4. **Heuristic-first features.** Recommendations and review moderation try a
   cheap non-AI path first and only escalate when genuinely inconclusive.

### Running without a token — mock mode

**If `AI_API_TOKEN` is missing, blank, or still the placeholder, every AI
endpoint still works.** They return deterministic mock content instead of
failing, so you can develop and demo the entire application without spending a
single call.

Mock output is genuinely book-specific — it is seeded from the book's own title,
authors, categories and description, so it reads like a real summary of *that*
book rather than filler text. The same book always produces the same output.

It is never disguised as real. Every response reports its origin:

```json
{ "source": "mock", "aiGenerated": false, ... }
```

Control it with `AI_MOCK_MODE`:

| Value | Behaviour |
|---|---|
| `auto` *(default)* | Mock only when a live call is impossible — no token, rejected token, or exhausted quota. |
| `always` | Never touch the network. Offline development and zero-cost demos. |
| `never` | Fail loudly instead of mocking. Correct for production, so a misconfiguration cannot silently serve fabricated content. |

The resolved mode is printed at startup and reported by `GET /health/ready`, so
it is never a mystery which one you are in.

> **The token supplied with this project is rejected by the provider.**
> `GET /v1/usage` returns `401 invalid_api_key` — it appears to have been revoked, expired, or
> truncated when copied. The application therefore runs in **mock mode**, which is exactly what that
> mode exists for: every AI endpoint works, and every response is clearly labelled as offline
> content. Paste a working token into `AI_API_TOKEN` and restart to switch to live generation;
> `GET /api/v1/ai/status` will then report `mode: "live"`.

> **Security note:** treat any API token pasted into a chat, ticket or commit as
> compromised, and rotate it. `.env` is gitignored from the very first commit;
> only `.env.example`, which carries placeholders, is tracked.

---

## Adding the SendGrid key later

Email uses SendGrid. The integration is wired up and ready, but **the key is not
required to run the project.**

Leave it blank:

```
MAIL_PROVIDER=sendgrid
SENDGRID_API_KEY=
```

At boot the app detects the missing key, logs one warning, and falls back to a
console provider that renders each email to the log:

```
warn: Email: MAIL_PROVIDER=sendgrid but SENDGRID_API_KEY is missing or invalid
— emails will be written to the log instead. Add the key to .env to enable real
delivery; no code change is needed.
```

Everything that sends email — password resets, due-date reminders, overdue
notices — continues to work; the messages just land in your terminal. Password
reset links are fully usable from there, which is exactly what you want in
development.

When you have a key, paste it in and restart:

```
SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxxxx
MAIL_FROM_EMAIL=no-reply@yourdomain.com
```

`MAIL_FROM_EMAIL` must be a **verified sender** in your SendGrid account or
delivery is rejected. Set `SENDGRID_SANDBOX_MODE=true` to validate the
integration without actually delivering anything.

No code changes at any point — the provider is selected at runtime from config.

---

## Running the server

Development, with auto-restart on file changes:

```bash
npm run dev
```

Production:

```bash
npm start
```

A successful start prints a banner showing the **resolved** configuration —
including the two settings most likely to differ from what `.env` appears to
say, because both fall back when misconfigured:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  E-Library Management System v1.0.0                                      │
├──────────────────────────────────────────────────────────────────────────┤
│  Environment          development                                        │
│  Server               http://localhost:5000                              │
│  API base             http://localhost:5000/api/v1                       │
│  API docs             http://localhost:5000/api-docs                     │
│  Health               http://localhost:5000/health/ready                 │
│  Database             elibrary (standalone, MongoDB 8.0.3)               │
│  Transactions         unavailable (standalone) — using atomic CAS…       │
│  Mail                 console (fallback)                                 │
│  AI                   live — gpt-4o-mini                                 │
│  Scheduled jobs       enabled                                            │
│  Rate limiting        enabled                                            │
└──────────────────────────────────────────────────────────────────────────┘
```

Verify it is healthy:

```bash
curl http://localhost:5000/health/ready
```

`GET /health` is a **liveness** probe — it checks nothing but that the process
is alive, so a brief database blip cannot trigger a restart loop.
`GET /health/ready` is a **readiness** probe and checks every dependency.

---

## Seeding demo data

```bash
npm run seed
```

This populates a realistic library so every endpoint is immediately usable:
accounts across all roles and membership tiers, ~50 books with authors,
publishers and hierarchical categories, ~120 physical copies, loans in varied
states (including several **already overdue with fines accrued**, so the fine
and borrowing-block logic is visible without waiting days), reviews producing
genuine rating distributions, reading lists, notifications, and pre-generated
mock AI summaries that cost nothing from the AI budget.

Demo account credentials are printed to the console when the seed completes.

| Command | Effect |
|---|---|
| `npm run seed` | Adds demo data. Refuses to run if the database already has data. |
| `npm run seed:fresh` | Wipes all collections, then seeds. Prompts for confirmation outside development. |
| `npm run seed:clear` | Empties collections without seeding. |

---

## Logging in for the first time

If you skip seeding, you still need a privileged account — and every
admin-creating route requires an admin, so there would otherwise be no way in.

On first boot, **if the database contains zero admins**, one is created from
your `.env`:

```
BOOTSTRAP_ADMIN_EMAIL=admin@elibrary.local
BOOTSTRAP_ADMIN_PASSWORD=Admin@12345
```

It is logged once and never runs again. **Change the password immediately after
your first login.**

---

## Running the tests

```bash
npm test
```

**233 tests across 9 suites**, in roughly 17 seconds.

| Command | Runs |
|---|---|
| `npm test` | Everything — unit and integration |
| `npm run test:unit` | Pure functions only. **No database, ~6 seconds** |
| `npm run test:integration` | Real MongoDB + supertest against the Express app |
| `npm run test:watch` | Unit tests, re-running on save |
| `npm run test:coverage` | Everything, with a coverage report in `coverage/` |
| `npm run test:verbose` | Everything, listing each test name |

Run a single file or match by name:

```bash
npm test -- tests/unit/isbn.test.js
```

```bash
npm test -- -t "atomic copy claim"
```

### Prerequisites

**MongoDB must be running** — the integration tests use it. They connect to a
**separate database per Jest worker** (`elibrary_test_1`, `elibrary_test_2`, …),
never to your development database, and drop it afterwards.

`mongodb-memory-server` is deliberately not used: it downloads a ~100MB binary
on first run, which fails on a restricted network and makes a fresh clone's
first `npm test` unpredictable. The local server is already required to run the
app at all.

Nothing else is needed. Tests never send email and never call the AI provider —
`tests/setup-env.js` forces `MAIL_ENABLED=false` and `AI_MOCK_MODE=always`.

### What is covered

**Unit** — the logic where a mistake is expensive and invisible:

- **ISBN** check digits, including the transposed-digit case a length check misses
- **Fine arithmetic** — grace boundary, the per-loan cap, and the exact day it is reached
- **Password** hashing, verification, and failing *closed* on a missing hash
- **NoSQL injection** — operator stripping, prototype pollution, regex escaping
- **JWT** — signature forgery, `alg: none`, and **token type confusion** (a reset token must never work as an access token)
- **Review moderation** — spam and profanity detection, and that **negative reviews are never blocked**
- **AI mock provider** — determinism, book-specificity, and that it declines to invent what it cannot know

**Integration** — real HTTP through the real app:

- Registration, including that `role: "ADMIN"` in a request body is silently stripped
- Login returning **identical** errors for unknown-email and wrong-password
- **Refresh-token reuse detection** revoking the whole session family
- A suspension taking effect **mid-session**, not when the token expires
- Borrowing, eligibility blocks, renewal rules, fine assessment
- **20 simultaneous borrows of one copy → exactly one succeeds**

### A note on ESM

The project is native ESM, so the scripts invoke Jest as

```
node --experimental-vm-modules node_modules/jest/bin/jest.js
```

rather than the `jest` binary. That form works identically on Windows, macOS
and Linux, whereas `NODE_OPTIONS=... jest` does not work on Windows. In
`jest.config.js`, **`transform: {}` must stay** — it disables babel-jest so
Node loads the source as real ES modules.


---

## API documentation

Two forms, kept in sync:

| | Where | Best for |
|---|---|---|
| **Swagger UI** | <http://localhost:5000/api-docs> | Trying requests interactively, with auth |
| **OpenAPI spec** | <http://localhost:5000/api-docs.json> | Importing into Postman, generating a client |
| **API reference** | [`docs/api-reference.md`](docs/api-reference.md) | Reading the full API without running it — every endpoint with mock request and response |
| **Postman collection** | [`docs/postman/`](docs/postman/) | Running an end-to-end flow; the JWT is captured automatically |
| **Postman guide** | [`docs/postman-testing-guide.md`](docs/postman-testing-guide.md) | Step-by-step instructions for testing all 130 endpoints, including the negative cases |
| **API walkthrough** | [`docs/api-walkthrough.md`](docs/api-walkthrough.md) | The whole API explained feature by feature — what each does, a worked example, and its corner cases |

Deeper design documentation lives in [`docs/`](docs/):

- [`architecture.md`](docs/architecture.md) — layers, request lifecycle, the concurrency guarantee, security
- [`data-model.md`](docs/data-model.md) — all 19 collections, indexes, and why each denormalised field exists
- [`borrowing-lifecycle.md`](docs/borrowing-lifecycle.md) — loan states, eligibility, fine arithmetic
- [`ai-pipeline.md`](docs/ai-pipeline.md) — the cache-first design, quota strategy, mock mode

### Response envelope

Every response has the same shape, so a client writes one handler rather than
one per endpoint.

Success:

```json
{
  "success": true,
  "message": "Books fetched",
  "data": [ /* ... */ ],
  "meta": { "page": 1, "limit": 20, "total": 137, "totalPages": 7, "hasNext": true }
}
```

Failure:

```json
{
  "success": false,
  "message": "No copies of this book are currently available",
  "code": "NO_COPY_AVAILABLE",
  "errors": [],
  "requestId": "3f9a1c2e-7b4d-4a11-9c3e-1f2b8a6d5e04"
}
```

`message` is for humans and may be reworded at any time. **`code` is the stable
contract** — branch on that, never on the message text. `requestId` also appears
in the `X-Request-Id` header and in the server logs, so any error a user reports
can be traced to its exact log entry.

### Authentication

Most endpoints need `Authorization: Bearer <accessToken>`.

Access tokens last 15 minutes. Exchange the refresh token at
`POST /api/v1/auth/refresh` for a new pair. Refresh tokens are **single-use and
rotate on every exchange** — replaying an old one is treated as theft and
revokes the entire session family, which is what makes a stolen refresh token
useful only until its rightful owner next uses theirs.

---

## Library policy

All circulation rules live in [`src/config/library.js`](src/config/library.js),
driven from `.env`. Changing library behaviour never means changing code.

| Membership | Loan period | Max concurrent loans | Renewals | Fine-free window |
|---|---|---|---|---|
| `PUBLIC` | 14 days | 3 | 2 | 42 days |
| `STUDENT` | 21 days | 5 | 2 | 63 days |
| `FACULTY` | 30 days | 8 | 2 | 90 days |

Each renewal grants a **fresh full loan period**, which is where the fine-free
window comes from. Renewal is refused once a loan is already overdue — otherwise
it would be a way to escape a fine that is already accruing.

**Fines.** A 2-day grace period after the due date, then ₹5/day, capped at ₹500
per loan. Borrowing is blocked once a member owes more than ₹200.

```
3 days late   →  (3 − 2) × ₹5  =  ₹5
10 days late  →  (10 − 2) × ₹5 =  ₹40
200 days late →  would be ₹990, capped at ₹500
```

**Digital loans** last 7 days and expire automatically — nothing to return. Each
ebook has a limited number of simultaneous licences (3 by default).

---

## Project structure

```
src/
├── server.js          Process lifecycle: connect → bootstrap → listen → graceful shutdown
├── app.js             Express app: middleware chain, routes, error handling
│
├── config/            ALL configuration. The only place process.env is read.
│   ├── env.js           Loads .env, validates it, fails fast with a readable report
│   ├── index.js         The single frozen `config` object the app imports
│   ├── library.js       The business rulebook — loan periods, fines, limits
│   ├── ai.js            Model, quota strategy, mock mode, feature flags
│   ├── rateLimit.js     Five limiter groups and their key strategies
│   ├── mail.js          SendGrid config and the console fallback logic
│   ├── database.js      Connection, plus replica-set / transaction detection
│   ├── jwt.js           Four token types, each with its own secret
│   ├── upload.js        Size caps, MIME allow-lists, magic-number signatures
│   ├── logger.js        Levels, transports, and the secret-redaction deny-list
│   └── swagger.js       OpenAPI base document
│
├── models/            Mongoose schemas. Fields, indexes, invariants — no business logic.
├── services/          All business rules. The only layer that orchestrates several models.
├── controllers/       Thin HTTP adapters: read the request, call a service, serialise.
├── serializers/       The "View" layer — DTO shaping, strips secrets from output.
├── routes/            One router per resource, annotated with Swagger JSDoc.
├── validators/        Zod request schemas — whitelist, coerce, strip unknown fields.
├── middlewares/       auth, RBAC, validation, rate limiting, uploads, errors, sanitising
├── integrations/ai/   AI client, mock provider, quota guard, versioned prompts
├── jobs/              node-cron: overdue + fines, reminders, digital expiry, cleanup
├── seeds/             npm run seed
├── utils/             ApiError, ApiResponse, asyncHandler, pagination, transactions, logger
└── constants/         Roles, enums, error codes, HTTP status codes
```

**Architecture:** MVC with a service layer. Because this is a JSON API, the
"View" is the response-shaping layer, so `serializers/` is a real folder rather
than a fiction.

```
Route → Middleware (auth, RBAC, validate, rate-limit) → Controller → Service → Model
                                                              ↓
                                                        Serializer → JSON envelope
```

---

## npm scripts

| Script | What it does |
|---|---|
| `npm start` | Run in production mode |
| `npm run dev` | Run with nodemon, restarting on file changes |
| `npm run seed` | Populate demo data |
| `npm run seed:fresh` | Wipe, then populate |
| `npm run seed:clear` | Empty all collections |
| `npm run lint` | ESLint |
| `npm run lint:fix` | ESLint with auto-fix |
| `npm run format` | Prettier |

---

## Environment variable reference

`.env.example` is the authoritative reference — every key there is grouped and
commented in place. Summarised by section:

| Section | Keys | Notes |
|---|---|---|
| **Application** | `NODE_ENV`, `PORT`, `HOST`, `API_PREFIX`, `APP_NAME`, `APP_URL`, `TRUST_PROXY`, `BODY_LIMIT`, `SHUTDOWN_TIMEOUT_SECONDS` | `TRUST_PROXY` must match your actual number of reverse proxies, or rate limiting misbehaves |
| **Database** | `MONGO_URI`, `MONGO_DB_NAME`, pool sizes, timeouts, `MONGO_DEBUG` | **`MONGO_URI` and `MONGO_DB_NAME` are required** |
| **Authentication** | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_RESET_SECRET`, expiries, `JWT_ISSUER`, `JWT_AUDIENCE`, `BCRYPT_SALT_ROUNDS` | **All three secrets required, ≥32 chars, all different** |
| **Bootstrap admin** | `BOOTSTRAP_ADMIN_ENABLED`, `_NAME`, `_EMAIL`, `_PASSWORD` | Creates the first admin if none exists |
| **Rate limiting** | `RATE_LIMIT_*`, `AUTH_*`, `SEARCH_*`, `UPLOAD_*`, `AI_*` | Five independent groups |
| **CORS** | `CORS_ORIGINS`, `CORS_CREDENTIALS` | `*` is rejected in production |
| **AI** | `AI_API_TOKEN`, `AI_MOCK_MODE`, `AI_TOTAL_QUOTA`, `AI_CACHE_ENABLED`, `AI_PROMPT_VERSION`, 7 feature flags | Optional — mock mode covers a missing token |
| **Library policy** | Loan periods, loan caps, renewals, fine rules, digital lending, reminders | Per membership type |
| **Uploads** | `STORAGE_PROVIDER`, `STORAGE_ROOT`, size caps, MIME allow-lists, `EXTRACT_EBOOK_TEXT` | Local disk by default |
| **Email** | `MAIL_PROVIDER`, `SENDGRID_API_KEY`, `MAIL_FROM_*`, sandbox, template IDs | Optional — falls back to console |
| **Scheduled jobs** | `CRON_ENABLED`, `CRON_TIMEZONE`, five cron expressions | Disable entirely with `CRON_ENABLED=false` |
| **Logging** | `LOG_LEVEL`, `LOG_DIR`, `LOG_TO_FILE`, `LOG_HTTP_REQUESTS` | Secrets are redacted from all output |
| **Docs** | `SWAGGER_ENABLED`, `SWAGGER_ROUTE` | |

---

## Troubleshooting

**`ENVIRONMENT CONFIGURATION ERROR` on startup**
Read the list it prints — it names each bad key and what is wrong. Usually the
JWT secrets are missing or too short.

**`Port 5000 is already in use`**
Change `PORT` in `.env`, or find the process:

```bash
netstat -ano | findstr :5000
```

**`Failed to connect to MongoDB`**
Confirm the service is running (`Get-Service MongoDB` on Windows), that
`MONGO_URI` is correct, and — on Atlas — that your current IP is on the Network
Access allow-list.

**`MongoDB is running standalone…` warning**
Expected and harmless on a local install. See
[enabling transactions](#optional--enabling-transactions).

**`MAIL_PROVIDER=sendgrid but SENDGRID_API_KEY is missing` warning**
Expected until you add the key. Emails are written to the log meanwhile.

**AI responses say `"source": "mock"`**
No usable `AI_API_TOKEN`, or the quota is exhausted. `GET /health/ready` reports
the reason under `checks.ai`.

**`AI_QUOTA_EXHAUSTED`**
The 100-call budget is spent. Cached summaries still work. Set
`AI_MOCK_MODE=always` to keep demoing without live calls.

**Uploads fail with a permissions error**
The `storage/` directories are created at boot. If that failed, check the
startup logs and the write permissions on the project directory.

**`429 Too Many Requests` while testing**
You tripped a rate limiter. Wait out the window, or raise the relevant
`*_RATE_LIMIT_MAX` in `.env` for local testing.

---

## Feature list

### Authentication & users
Registration for public members and college students · JWT auth with 15-minute
access tokens · **refresh-token rotation with reuse detection** (replaying a
rotated token revokes the whole session family) · logout and log-out-all-devices
· password reset via single-use time-limited token · change password (revokes
all sessions) · profile management · avatar upload · role-based access control
with an ownership guard · account suspension and soft deletion

### Catalogue
Books with full bibliographic metadata · ISBN-10/13 validation with checksum ·
cover images · authors, publishers, and **hierarchical categories** with a
materialised ancestor path · per-copy physical inventory with unique accession
numbers and condition tracking · soft delete and restore · CSV bulk import with
a dry-run mode, and CSV export · trending, new-arrival and most-borrowed feeds ·
similar-books

### Search
Weighted full-text search with relevance scoring · filters on category
(including descendants), author, publisher, language, year range, minimum
rating, availability, format and tags · **faceted counts** so a UI can render
filter sidebars with numbers · autocomplete · fuzzy fallback when text search
finds nothing · sorting by relevance, title, year, rating, popularity or recency

### Circulation
Borrowing with a full eligibility check · **atomic copy claim**, correct under
concurrent requests on any MongoDB deployment · renewals · returns · overdue
detection and **fine accrual with a grace period and a cap** · borrowing blocked
above a fine threshold or while holding an overdue item · **digital lending**
with concurrent licences and automatic expiry · librarian circulation desk
(issue and return on behalf of a member, override due dates, mark items lost) ·
fine payment and waiver with a mandatory audited note

### Digital books
PDF/EPUB upload with size caps and **magic-number verification** (so a renamed
executable cannot masquerade as a PDF) · sha256 checksums for deduplication ·
**ebooks are never served statically** — access requires an active digital loan
and streams with HTTP Range support so browser readers can seek · short-lived
signed download links · automatic text extraction feeding the AI summariser ·
reading-progress tracking

### AI
Book summaries in three lengths · key takeaways · a simplified
"explain-it-simply" version · **ask a question about a book**, grounded in its
text · personalised recommendations · review moderation · metadata enrichment ·
all cached persistently, quota-guarded, rate-limited per user, and backed by a
deterministic mock provider so nothing ever hard-fails

### Engagement
Ratings and reviews, one per member per book · verified-borrower badges ·
rating aggregates with a full 1–5 distribution · helpful votes · moderation
queue · favourites and custom reading lists with sharing · reading history

### Notifications
In-app notification centre with per-type and per-channel preferences · email via
SendGrid with a console fallback · triggers for due-soon, overdue, fines,
borrowing events, review outcomes and account changes

### Administration
Member management with role changes and suspension · full catalogue and
inventory control · **analytics dashboards** — most-borrowed titles, busiest
categories, active members, overdue rate, average loan duration, inventory
health, circulation trends, fine collection, AI usage · **audit log** of every
privileged mutation with before/after diffs

### Security & operations
Helmet security headers · configurable CORS allow-list · **two-layer NoSQL
injection defence** (schema whitelisting plus a recursive key sanitiser) · HTTP
parameter-pollution protection · five independent rate-limit groups keyed by IP
or user · bcrypt password hashing · secret redaction in all log output ·
request-id correlation from client to log line · structured logging · graceful
shutdown draining in-flight requests · scheduled background jobs · liveness and
readiness probes

---

## License

MIT
