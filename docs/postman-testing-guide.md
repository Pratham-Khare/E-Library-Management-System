# Testing the API with Postman

A step-by-step walkthrough for exercising all **130 endpoints** of the E-Library API.

The collection in [`docs/postman/`](postman/) is not a flat list of URLs — it is ordered so that
running it from top to bottom performs a complete library workflow: register a member, catalogue a
book, add copies, borrow it, renew it, return it, fine someone, review the book, and read the
analytics. Ids and tokens are captured from each response and fed into the next request, so almost
nothing has to be typed by hand.

---

## Table of contents

- [Before you start](#before-you-start)
- [Step 1 — import the collection and environment](#step-1--import-the-collection-and-environment)
- [Step 2 — check the server is reachable](#step-2--check-the-server-is-reachable)
- [Step 3 — sign in](#step-3--sign-in)
- [Step 4 — how the collection chains itself](#step-4--how-the-collection-chains-itself)
- [Step 5 — run the folders in order](#step-5--run-the-folders-in-order)
- [Step 6 — the two folders that need a file](#step-6--the-two-folders-that-need-a-file)
- [Running everything at once](#running-everything-at-once)
- [Running it from the command line](#running-it-from-the-command-line)
- [What a clean run looks like](#what-a-clean-run-looks-like)
- [Testing the things a happy path never reaches](#testing-the-things-a-happy-path-never-reaches)
- [Troubleshooting](#troubleshooting)

---

## Before you start

Three things must be true.

**1. MongoDB is running.**

```bash
powershell -Command "Get-Service MongoDB"
```

**2. The database has sample data.** Almost every request needs a book, a member or a loan to
already exist. Seed before your first run, and again whenever you want a clean slate:

```bash
npm run seed:fresh
```

This prints the demo accounts. All of them share the password `Password@123`:

| Role | Email |
|---|---|
| ADMIN | `admin@library.test` |
| LIBRARIAN | `librarian@library.test` |
| MEMBER (student) | `ananya@student.test` |
| MEMBER (second student, for review votes) | `rohan@student.test` |

**3. The server is up.**

```bash
npm run dev
```

Wait for `Server listening on http://localhost:5000`.

> **Testing against a different port or host?** Change `baseUrl` in the Postman environment. Nothing
> else needs editing — every URL is built from `{{baseUrl}}{{apiPrefix}}`.

---

## Step 1 — import the collection and environment

In Postman: **Import** → **Files**, and select **both**:

```
docs/postman/E-Library.postman_collection.json
docs/postman/E-Library.postman_environment.json
```

Then — and this is the step most often missed — pick **E-Library — Local** in the environment
selector at the top right. Without it, `{{baseUrl}}` is undefined and every request fails with
*"Invalid URL"*.

---

## Step 2 — check the server is reachable

Open the **Health** folder and send all three:

| Request | Expect |
|---|---|
| `GET /` | API name and version |
| `GET /health` | `{"status":"ok"}` — liveness only, no dependencies touched |
| `GET /health/ready` | Readiness, including what the dependencies are actually doing |

`/health/ready` is the one worth reading, because it tells you the two things that most often
confuse a first run:

```json
"mail": { "provider": "console", "configured": false,
          "reason": "MAIL_PROVIDER=sendgrid but SENDGRID_API_KEY is missing or invalid —
                     emails will be written to the log instead." },
"ai":   { "mode": "live", "model": "gpt-4o-mini", "quotaTotal": 100 }
```

Emails go to the terminal, not an inbox. And if `ai.mode` is `live` but the token is rejected by the
provider, AI requests still return `200` — they fall back to a mock response, flagged
`"source": "mock"`. That is the designed behaviour, not a failure.

---

## Step 3 — sign in

Open the **Setup** folder. It holds one request per role:

- **Sign in as ADMIN**
- **Sign in as LIBRARIAN**
- **Sign in as MEMBER**

Send **Sign in as ADMIN**. Its test script writes `accessToken` into the environment, and every
protected request in the collection sends `Authorization: Bearer {{accessToken}}` — so this single
request decides who the whole collection is acting as.

You will not usually need to come back here. The folders that require a different role switch by
themselves; see the next step.

---

## Step 4 — how the collection chains itself

Three mechanisms mean you rarely type an id.

**Test scripts capture ids.** `GET /books` stores the first result's id as `bookId`; every later
request that needs a book uses `{{bookId}}`. The same pattern covers authors, publishers,
categories, copies, loans, fines, reviews, lists, notifications and sessions.

**Pre-request scripts switch role automatically.** Twenty requests need an identity different from
the folder before them — `POST /loans/issue` is a desk action, `POST /reviews/{id}/helpful` must
come from someone other than the review's author. Each signs in as the account it needs, and caches
that token so a full run makes four sign-ins rather than twenty. (Twenty would trip the auth rate
limit of 10 per 15 minutes mid-run.)

**Pre-request scripts build missing prerequisites.** Merging two authors needs a second author to
merge, and waiving a fine needs one that has not already been paid. Those requests create what they
need first, so any of them can be sent on its own without hand-made test data.

**Writes never touch seeded data.** Reads target the seeded catalogue; `PATCH` and `DELETE` target
records the collection created moments earlier — `{{newAuthorId}}`, `{{newBookId}}`, `{{newCopyId}}`.
A full run therefore leaves the sample library intact.

---

## Step 5 — run the folders in order

Send the requests top to bottom within each folder, and the folders in this order. The role column
is informational — the collection handles the switching.

| # | Folder | Acts as | What it proves |
|---|---|---|---|
| 1 | **Health** | — | The server and its dependencies are up |
| 2 | **Setup** | — | Token capture works |
| 3 | **Auth** | member → admin | Registration, refresh rotation, sessions, password reset, change-password |
| 4 | **Users** | admin | Own profile, staff creation, role and membership changes, suspend/reactivate |
| 5 | **Authors** | admin | Taxonomy CRUD, books-by-author, duplicate merging |
| 6 | **Publishers** | admin | Same surface, without merge |
| 7 | **Categories** | admin | The tree — children, breadcrumb, subtree book listing |
| 8 | **Books** | admin | Catalogue CRUD, soft delete and restore, similar-titles |
| 9 | **Copies** | admin | Per-copy inventory: add, change status, remove |
| 10 | **Search** | — | Weighted text search, facet counts, autocomplete |
| 11 | **Files** | admin | Uploads and secured streaming — **needs files attached**, see below |
| 12 | **Loans** | member → librarian | **The core engine**: eligibility, borrow, renew, return, desk issue, write-off |
| 13 | **Fines** | member → librarian | Ledger, raising, payment, waiver |
| 14 | **Reviews** | member → other member → librarian | Publish, edit, vote, report, moderate, delete |
| 15 | **Reading Lists** | member | Lists, public sharing, favourites toggle |
| 16 | **Notifications** | member | Centre, unread count, mark read |
| 17 | **AI** | member → admin | Summaries, takeaways, Q&A, recommendations, quota status |
| 18 | **Admin** | admin | Dashboard, five reports, audit log, CSV export, manual job run |
| 19 | **Cleanup** | throwaway member | Closes the account registered in step 3 |

### The three worth slowing down for

**Loans** is where the interesting logic lives. `GET /loans/eligibility` returns the seven checks
that gate borrowing. `POST /loans` claims a copy atomically. `POST /loans/{id}/renew` is refused
once a loan is overdue, so renewal cannot be used to dodge a fine.

**AI** demonstrates the cost design. Send `GET /ai/books/{bookId}/summary` twice and watch the
response time: the first is around a second, the second is milliseconds, because summaries are
cached per `(book, kind, length, language, promptVersion)`. `GET /ai/status` shows how much of the
100-call lifetime budget remains.

**Admin** proves the audit trail. `GET /admin/audit-log` should already list the role change,
suspension and fine waiver performed by the folders above.

---

## Step 6 — the two folders that need a file

Postman cannot attach a file from a shared collection — file paths are local, so the `src` field is
deliberately left empty. Three requests need one picking manually.

In **Files**, on the `Body` tab of each request, click **Select Files**:

| Request | Field | Attach |
|---|---|---|
| `POST /files/books/{bookId}/cover` | `cover` | Any `.jpg` or `.png` |
| `POST /files/books/{bookId}/ebook` | `ebook` | Any `.pdf` or `.epub` |
| `POST /files/avatar` | `avatar` | Any `.jpg` or `.png` |

Once the ebook is uploaded the rest of the folder chains on its own — `GET .../assets` captures the
`assetId`, and `POST .../download-link` captures the signed token that the download request uses in
its query string.

Without an attachment those three return `400 FILE_REQUIRED`, and the five requests that follow
return `404` because there is no asset to act on. That is a missing attachment, not a broken API —
with real files the whole folder returns `200`/`201` end to end.

The same applies to **Admin → `POST /admin/books/import`**, which needs a `.csv`. Get a valid one by
sending `GET /admin/books/export` first and saving the response.

> **Worth trying:** rename a `.txt` to `.pdf` and upload it. The API reads the file's magic number
> rather than trusting the extension, and refuses it with `FILE_SIGNATURE_MISMATCH`.

---

## Running everything at once

Use the Collection Runner for a full sweep: **… → Run collection → Run E-Library Management System**.

**Turn off rate limiting first.** A full run is roughly 140 requests, and the global limiter allows
300 per 15 minutes per IP — so a second run inside the same window returns `429` for everything. In
`.env`:

```
RATE_LIMIT_ENABLED=false
```

Restart the server. Turn it back on when you want to test the limiter itself.

Reseed between runs (`npm run seed:fresh`) if you want each one to start from identical data.

---

## Running it from the command line

The same collection runs headlessly through [Newman](https://github.com/postmanlabs/newman), which is
already a dev dependency:

```bash
npm run test:api
```

A single folder:

```bash
npm run test:api -- --folder Loans
```

Fail the process on the first error, which is what you want in CI:

```bash
npm run test:api -- --bail
```

An HTML report:

```bash
npx newman run docs/postman/E-Library.postman_collection.json -e docs/postman/E-Library.postman_environment.json -r cli,html
```

---

## What a clean run looks like

Against a freshly seeded database, with no files attached:

```
requests           141 executed, 0 failed
test-scripts        34 executed, 0 failed
prerequest-scripts  27 executed, 0 failed
total run duration  ~17s
```

(141 rather than 133, because eight of the pre-request scripts issue a request of their own — the
sign-ins and the two that build a prerequisite.)

Eleven requests return a non-2xx status, and every one of them is expected:

| Count | Request | Status | Why |
|---|---|---|---|
| 3 | `POST /files/*` | 400 | No file attached — see step 6 |
| 5 | `/files/ebooks/*` | 404 | Cascades from the above: no ebook, so no asset |
| 1 | `POST /admin/books/import` | 400 | No CSV attached |
| 1 | `POST /ai/sync-usage` | 503 | The supplied AI token is rejected upstream, so usage cannot be reconciled |
| 1 | `DELETE /users/me` | 409 | The throwaway member owes the fine the Fines folder raised — closing an account with debts is refused, correctly |

Attach the three files and a CSV and the first nine turn green, leaving only the two that depend on a
working AI token and a settled ledger.

---

## Testing the things a happy path never reaches

Running the collection proves the API works. These prove it fails correctly.

**A member cannot reach an admin route.** Send `Setup → Sign in as MEMBER`, then `Admin → GET /admin/dashboard`:

```json
403 Forbidden
{ "success": false,
  "message": "This action requires one of the LIBRARIAN or ADMIN roles",
  "code": "INSUFFICIENT_ROLE" }
```

**A missing token is refused with an instruction, not a bare 401.** Clear `accessToken` in the
environment and send `GET /users/me`:

```json
401 Unauthorized
{ "message": "Authentication required. Send your access token as: Authorization: Bearer <token>",
  "code": "MISSING_TOKEN" }
```

**Validation reports every problem at once.** Send `POST /auth/register` with
`{"email":"not-an-email","password":"x"}`:

```json
422 Unprocessable Entity
{ "message": "Validation failed for 4 fields",
  "code": "VALIDATION_ERROR",
  "errors": [
    { "field": "name",     "message": "Required", "code": "required" },
    { "field": "email",    "message": "Please provide a valid email address" },
    { "field": "password", "message": "Password must be at least 8 characters" }
  ] }
```

**Nothing available is a clean 409, not an empty list.** Borrow every copy of a title, then borrow
once more:

```json
409 Conflict
{ "message": "Every copy of this book is currently on loan",
  "code": "NO_COPY_AVAILABLE",
  "details": { "totalCopies": 1, "earliestExpectedReturn": "2026-09-04T18:29:59.999Z" } }
```

`earliestExpectedReturn` is the useful part — it lets a client say *"try again after the 4th"*
without a reservation system.

**The auth limiter trips.** With `RATE_LIMIT_ENABLED=true`, send `POST /auth/login` eleven times
with a wrong password. The eleventh returns `429` with a `Retry-After` header.

**A replayed refresh token kills the whole session family.** Send `POST /auth/refresh`, then send it
again with the *old* token from the environment history. Rotation means the old one is already
spent; presenting it is treated as theft and every session for that user is revoked.

**Twenty people cannot borrow one copy.** This is the check that proves the atomic claim, and it
needs concurrency the Postman UI cannot produce — the Collection Runner is sequential. Run it from a
terminal instead against a book with a single available copy:

```bash
node -e "const b='PASTE_BOOK_ID',t='PASTE_TOKEN';Promise.all(Array.from({length:20},()=>fetch('http://localhost:5000/api/v1/loans',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({bookId:b,type:'PHYSICAL'})}).then(r=>r.status))).then(s=>console.log(s.join(' ')))"
```

Exactly one `201`; the rest `409`. Afterwards `available` is `0` — never negative. The same scenario
is asserted automatically in [`tests/integration/circulation.test.js`](../tests/integration/circulation.test.js).

---

## Troubleshooting

**Everything returns `429 Too Many Requests`.** You have run the collection more than once inside 15
minutes. Set `RATE_LIMIT_ENABLED=false` and restart, or wait out the window. Restarting the server
also clears the counters — the store is in-memory.

**Everything returns `401`.** No environment is selected, or `accessToken` is empty. Check the
selector at the top right, then send a request from **Setup**.

**`Invalid URL` before any request leaves.** Same cause: `{{baseUrl}}` is unresolved because no
environment is selected.

**A request 404s with a doubled slash, like `/books//copies`.** The variable in that path was never
captured — usually because the list request that sets it was skipped. Send the folder's first
request, or set the variable by hand in the environment.

**`409 DUPLICATE_ISBN` on `POST /books`.** Only if you edited the body. As shipped, a pre-request
script generates a fresh ISBN-13 each run, check digit included.

**Uploads fail with `413`.** The file is over `MAX_FILE_SIZE_MB` (default 10). Raise it in `.env`.

**AI requests are slow the first time and instant afterwards.** Working as designed — the first call
generates, the rest come from the cache. `GET /ai/status` shows cache hits against live calls.

**`GET /ai/*` returns `"source": "mock"`.** The AI token is missing, invalid, or the 100-call quota
is spent. The response is still well-formed and book-specific; see
[`ai-pipeline.md`](ai-pipeline.md).

---

## See also

- [`api-reference.md`](api-reference.md) — every endpoint with its role, parameters, and mock request/response
- **Swagger UI** at <http://localhost:5000/api-docs> — the same API, executable in the browser
- [`borrowing-lifecycle.md`](borrowing-lifecycle.md) — loan states and fine arithmetic, for interpreting what the Loans folder returns
- [`../README.md#running-the-tests`](../README.md#running-the-tests) — the Jest suite, which asserts automatically what this guide checks by hand
