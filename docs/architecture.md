# Architecture

How the system is put together, and why.

---

## Layers

```
Route  →  Middleware  →  Controller  →  Service  →  Model
              │              │            │          │
   auth, RBAC │      thin    │  all the   │  schemas, indexes,
   validate   │      HTTP    │  business  │  invariants
   rate-limit │     adapter  │   rules    │
                             ↓
                        Serializer  →  JSON envelope
```

MVC with a service layer. Because this is a JSON API the "View" is the response-shaping layer, so
`serializers/` is a real folder rather than a fiction.

| Layer | Responsibility | Never does |
|---|---|---|
| **Model** | Schema, indexes, invariants that must hold on every write path | Orchestrate other models |
| **Service** | All business rules. The only layer allowed to touch several models | Know about HTTP |
| **Controller** | Read validated input, call ONE service, serialise | Contain logic |
| **Serializer** | Shape the response, strip secrets, decide what each audience sees | Query the database |

**Why controllers stay thin.** The same borrowing logic is used by the HTTP route, the seeder and a
cron job. If it lived in a controller, the seeder would have to fake an Express request.

**Why serializers exist.** Returning `user.toJSON()` publishes every field added to the schema
tomorrow. Each serializer is an explicit allow-list, so a new field is invisible until someone
decides it should be visible. Three audiences: `toPublic` (anyone), `toSelf` (the account holder),
`toAdmin` (staff).

---

## Request lifecycle

Middleware order in [`src/app.js`](../src/app.js) is not arbitrary — each layer depends on the ones
before it.

```
 1  trust proxy      must precede anything reading req.ip
 2  requestId        so every later log line can be correlated
 3  helmet           security headers before any response can be sent
 4  cors             must precede routes to answer OPTIONS preflights
 5  compression      must wrap the response stream before it is written
 6  body parsers     populate req.body for the sanitiser
 7  sanitise         strip $-operators BEFORE any handler reads them
 8  hpp              collapse duplicated query parameters
 9  request log      after the id exists, before handlers run
10  rate limit       reject excess traffic before it reaches business logic
11  static files     cheap, no auth needed
12  routes           the actual API
13  404              only reached when nothing above matched
14  error handler    must be LAST; Express identifies it by arity
```

Every error converges on one handler, which translates Mongoose, JWT, Multer and Zod errors into the
standard envelope. Raw driver messages leak database and index names — `E11000 duplicate key error
collection: elibrary.books index: isbn13_1` tells an attacker more than it tells a user.

---

## Concurrency: the copy claim

**The single most important design decision in the system.**

The obvious way to borrow a book:

```js
const copy = await BookCopy.findOne({ book, status: 'AVAILABLE' });
copy.status = 'ON_LOAN';
await copy.save();
```

That is a read-then-write. Two members clicking "borrow" on the last copy both read it as
`AVAILABLE` before either writes. Both succeed. One physical book, two people told it is theirs.

The usual fix is a transaction — but **MongoDB only offers those on a replica set**, and a default
local install is standalone. Code that requires them crashes on a developer's laptop.

So the claim is a single atomic compare-and-swap:

```js
BookCopy.findOneAndUpdate(
  { book: bookId, status: 'AVAILABLE' },   // ← the COMPARE
  { $set: { status: 'ON_LOAN', currentLoan: loanId } },   // ← the SWAP
  { new: true, sort: { loanCount: 1 } }
);
```

MongoDB guarantees single-document atomicity on **every** deployment. Of two concurrent claims
exactly one matches; the other receives `null` and is told honestly. There is no window between
reading and writing.

**Verified:** twenty simultaneous borrow requests against a one-copy title → exactly one loan
created, availability lands on 0 rather than −19.

The `sort: { loanCount: 1 }` picks the least-circulated copy, so wear spreads across the stock
instead of destroying whichever one sorts first.

Digital licences use the same shape, with `$expr` so the filter can compare two fields of one
document:

```js
{ $expr: { $lt: ['$digital.activeLicenses', '$digital.concurrentLicenses'] } }
```

### Ordering, and why the loan is created first

```
1. check eligibility        cheap reads, fail fast
2. create the Loan          so the claim has an id to point at
3. ATOMICALLY claim a copy  ← the operation that cannot be raced
4. if no copy was free      delete the loan, report NO_COPY_AVAILABLE
5. update counters
```

Creating the loan before the claim looks backwards. The alternative — claim, then create — leaves a
copy marked `ON_LOAN` with no loan pointing at it if the create fails. An orphaned loan is trivially
deleted; an orphaned `ON_LOAN` copy is invisible and permanently unborrowable.

### Transactions where available

[`utils/transaction.js`](../src/utils/transaction.js) detects the deployment at boot and adapts:

- **replica set** → a real session, atomic rollback
- **standalone** → run directly, with compensating actions on failure

Compensation is *not* equivalent to a transaction — there is a window where a reader sees partial
state. Which is exactly why the one operation that must be correct does not depend on it.

**To enable real transactions locally:** stop MongoDB, add `replication: { replSetName: rs0 }` to
`mongod.cfg`, restart, then `mongosh --eval "rs.initiate()"`.

---

## Denormalisation, and keeping it honest

Several counters are caches of something derivable:

| Field | Derived from | Read on |
|---|---|---|
| `Book.inventory.availableCopies` | `BookCopy` count | every search result |
| `Book.rating.average` / `distribution` | `Review` aggregate | every book card |
| `User.stats.outstandingFine` | `Fine` aggregate | every borrow attempt |
| `Author.bookCount` | `Book` count | every author listing |

A 20-book search page would otherwise need 60 aggregations to render.

**Two rules keep them honest:**

1. **Recompute, don't adjust.** `recalculateInventory()` counts from `BookCopy` rather than
   decrementing. An incremental update that misses one code path drifts permanently; a recount is
   self-correcting.
2. **Reconcile nightly.** The cleanup job rebuilds counters for anything touched in the last day, so
   drift is bounded to one day rather than forever.

The authoritative answer is always the source collection. A borrow decision sums `Fine` directly
rather than trusting `User.stats.outstandingFine`, because that decision must be right even if the
cache is stale.

---

## Security

**Two-layer NoSQL injection defence.** `{ "email": { "$gt": "" } }` reaching `User.findOne(req.body)`
matches every document and logs the attacker in as whoever sorts first.

1. **Zod validators** whitelist known fields and coerce types. A schema expecting `email: string`
   cannot pass an operator object — the type check rejects it. Precise, but only covers routes with
   a schema.
2. **A recursive sanitiser** strips `$`-prefixed keys, dotted paths and `__proto__` from body, params
   and query. Broad, and covers routes added later by someone who forgot the validator.

> `express-mongo-sanitize` is not used: Express 5 made `req.query` a getter, and that package works
> by reassigning it. Rather than pin to Express 4 for one dependency,
> [`utils/sanitize.js`](../src/utils/sanitize.js) does the same job and handles the getter correctly.

**Four JWT secrets, not one.** A password-reset token is emailed in plaintext and may sit in an inbox
for years. Under a shared secret, anyone holding an old reset email could mint API credentials.
`config/env.js` refuses to start if two secrets match.

**Refresh-token rotation with reuse detection.** Every exchange mints a new token and revokes the
old. A legitimate client always holds the newest, so presenting a *rotated* one means two parties
hold tokens from the same family — theft. We cannot tell which is which, so the entire family is
revoked. The real user signs in again; the attacker is finished.

**Authorisation is two questions.** `authorize(...roles)` asks "may this role do this at all?".
`requireOwnerOrStaff()` asks "is this record yours?". Role checks alone leave
`GET /users/:id/loans` readable by anyone who changes a number in the URL.

**Magic-number file verification.** The declared MIME type is client-supplied. The first bytes of
every upload are checked against the format's real signature, so `payload.exe` renamed to `book.pdf`
is rejected.

**Ebooks are never served statically.** A static mount means anyone with a URL takes the collection
without borrowing. Reads go through a controller that verifies an active digital loan on **every
request**, then streams with Range support.

---

## The AI subsystem

The token allows **100 calls for its entire lifetime**. That single constraint shapes everything.

```
1. CACHE  → keyed (book, kind, length, language, promptVersion)   0 calls
2. LIVE   → token + budget + under the member's daily cap         1 of 100
3. MOCK   → deterministic offline content, clearly labelled       0 calls
```

A book's summary costs **one call ever**, no matter how many members read it. Bumping
`AI_PROMPT_VERSION` invalidates the whole cache without a migration.

Mock content is generated from the book's own metadata — not filler — and is deterministic, seeded
from the book id. It is never presented as model output: `source: "mock"`, `aiGenerated: false`, and
an explicit notice that travels with cached mocks too.

**Selection is not generation.** Recommendations are chosen by a database aggregation over shared
authors and categories — instant, free, available to everyone. The model is asked only to write the
one-sentence rationale, and only when `?explain=true`.

**Moderation is heuristic-first.** A keyword and pattern filter decides the obvious cases for free;
the model is consulted only on the ambiguous middle. Spending a call per review would exhaust the
budget in a day and moderate *worse*, since the heuristic is more consistent on clear-cut cases.

Full detail: [ai-pipeline.md](ai-pipeline.md).

---

## Configuration

`config/env.js` is the only file that reads `process.env`. It validates everything against a Zod
schema at boot and **refuses to start** on a problem, naming the exact key.

Cross-field rules catch combinations that are individually valid but wrong together: two JWT secrets
matching, a reminder scheduled after the shortest loan period, a fine threshold above the per-loan
cap so the borrowing block could never trigger.

**Graceful degradation is configured, not coded around.** Two subsystems resolve their behaviour at
boot and report it:

- **Mail** — SendGrid requested but no key → falls back to console rendering, logs one warning.
  Password-reset links in the log are fully usable.
- **AI** — no token, or one the provider rejects → mock mode.

Both surface in `GET /health/ready`, so the *resolved* state is never a guess.

---

## Failure handling

| Failure | Response |
|---|---|
| Database unreachable | `503`, readiness fails, instance leaves rotation |
| AI provider down | Cached content, else mock. **Never** an error the member sees |
| SendGrid down | Notification still recorded in-app; delivery outcome logged |
| Text extraction fails | Book works; summaries fall back to metadata |
| Live AI call fails mid-request | Falls through to mock, with the reason carried forward |
| Two concurrent borrows | One wins atomically; the other gets `COPY_CLAIM_FAILED` |
| Cron job throws | Contained per-job; one bad record does not abort the sweep |

Email failure never fails an operation. If SendGrid is down during registration, the account is still
created — the account is the point, the welcome email is a courtesy. The one deliberate exception is
password reset, which checks the result: a reset the user can never receive is worse than an error.

---

## Scheduled jobs

| Job | Schedule | Does |
|---|---|---|
| `overdue-check` | 00:30 daily | Mark overdue, accrue fines, notify |
| `due-reminders` | 09:00 daily | Warn 3 days ahead, **grouped per member** |
| `digital-expiry` | hourly | Release expired licences |
| `ai-usage-sync` | every 6h | Reconcile the call count with the provider |
| `cleanup` | 03:00 daily | Purge tokens, reconcile counters |

**Every job is idempotent.** A cron task eventually runs twice — a restart at the wrong moment, a
manual trigger, two instances overlapping. A fine-accrual job that is not idempotent doubles
someone's debt when that happens. The overdue job *updates* an existing fine rather than creating a
second. Verified: running it twice leaves the total unchanged.

Jobs also guard against overlapping runs, and contain their own errors — an unhandled rejection in a
cron callback would otherwise take the process down at 00:30 with nobody watching.

---

## What was deliberately left out

| Not built | Why |
|---|---|
| Reservations / waitlist | Explicitly out of scope. When nothing is available the API returns `NO_COPY_AVAILABLE` with the earliest expected return date. |
| Redis | Single instance. In-memory rate limiting is correct here; `config/rateLimit.js` documents the one-line swap. |
| Payment gateway | Fines are settled at a desk. `paymentReference` records the receipt from whatever handled the money. |
| Automated tests | Not requested. Verified instead by 451 end-to-end checks against a running server. |
| Docker | Not requested. |
| EPUB text extraction | EPUB is a ZIP of XHTML needing a different parser. Marked `SKIPPED`, not `FAILED` — nothing went wrong, the format is simply not handled yet. |
