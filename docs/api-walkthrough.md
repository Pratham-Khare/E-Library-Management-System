# The E-Library API, end to end

What every part of this API does, why it behaves the way it does, and what to watch out for when
you drive it from Postman.

Every request and response below was **captured from the running server** against a freshly seeded
database — including the failures. Nothing here is illustrative-but-untested.

**Related documents**

| | |
|---|---|
| [`postman-testing-guide.md`](postman-testing-guide.md) | How to import and run the collection, step by step |
| [`api-reference.md`](api-reference.md) | The endpoint catalogue — all 130, with parameters |
| [`architecture.md`](architecture.md) | Layers, request lifecycle, the concurrency guarantee |
| [`borrowing-lifecycle.md`](borrowing-lifecycle.md) | Loan and fine state machines |
| [`ai-pipeline.md`](ai-pipeline.md) | Cache-first AI design and mock mode |

---

## Contents

- [Part 1 — the ground rules](#part-1--the-ground-rules)
- [Part 2 — the fourteen feature areas](#part-2--the-fourteen-feature-areas)
  - [1. Authentication and sessions](#1-authentication-and-sessions)
  - [2. Users and profiles](#2-users-and-profiles)
  - [3. Authors, publishers and categories](#3-authors-publishers-and-categories)
  - [4. Books and the catalogue](#4-books-and-the-catalogue)
  - [5. Physical copies](#5-physical-copies)
  - [6. Search and discovery](#6-search-and-discovery)
  - [7. Files and digital books](#7-files-and-digital-books)
  - [8. Borrowing — the core engine](#8-borrowing--the-core-engine)
  - [9. Fines](#9-fines)
  - [10. Reviews and ratings](#10-reviews-and-ratings)
  - [11. Reading lists and favourites](#11-reading-lists-and-favourites)
  - [12. Notifications](#12-notifications)
  - [13. AI features](#13-ai-features)
  - [14. Admin, analytics and audit](#14-admin-analytics-and-audit)
- [Part 3 — corner cases that cut across everything](#part-3--corner-cases-that-cut-across-everything)
- [Part 4 — one complete story](#part-4--one-complete-story)

---

# Part 1 — the ground rules

Learn these once and every one of the 130 endpoints becomes predictable.

## The envelope

Every response — success or failure — has the same outer shape. A client never has to guess whether
it got data or an error.

**Success:**

```json
{ "success": true, "message": "Borrowed. Please return it by Fri Sep 04 2026.", "data": { … } }
```

**Failure:**

```json
{ "success": false,
  "message": "You have an overdue item. Please return it before borrowing anything else.",
  "code": "HAS_OVERDUE_ITEMS",
  "requestId": "697372bb-e871-4a9f-9a68-26382ba96fa8" }
```

Two fields deserve attention.

**`code`** is the machine-readable reason. `message` is written for a human and may be reworded;
`code` is the contract. Branch on `code`, never on `message`.

**`requestId`** appears on every error and in the `X-Request-Id` header of every response. Paste it
into your server log search and you get that exact request's log lines. When something behaves
oddly in Postman, this is the fastest route to the cause.

**Lists** add a `meta` block:

```json
{ "success": true, "data": [ … ],
  "meta": { "page": 1, "limit": 20, "total": 137, "totalPages": 7, "hasNext": true, "hasPrev": false } }
```

## Authentication

Send the access token on every protected request:

```
Authorization: Bearer <accessToken>
```

Access tokens are short-lived (15 minutes by default). Refresh tokens last much longer and are
exchanged for a new pair — see [feature 1](#1-authentication-and-sessions).

There are **four separate JWT secrets** — access, refresh, reset and download. A token minted for
one purpose cannot be verified as another, so a stolen password-reset link cannot be used as a
session.

## Two orthogonal axes decide what you can do

This is the single most important idea in the API, and the one that most often causes a confusing
403.

**`role`** is what you may do to the *library*:

| Role | Can |
|---|---|
| `MEMBER` | Browse, borrow, review, keep lists |
| `LIBRARIAN` | + the whole catalogue, the circulation desk, fines, moderation |
| `ADMIN` | + user management, analytics, audit log, job triggers |

**`membershipType`** is what the *library* grants you:

| Membership | Loan period | Max active loans | Renewals |
|---|---|---|---|
| `PUBLIC` | 14 days | 3 | 2 |
| `STUDENT` | **21 days** | 5 | 2 |
| `FACULTY` | 30 days | 8 | 2 |

They are independent. A `LIBRARIAN` is also a borrower, and the seeded librarian has `FACULTY`
membership — so they get 30-day loans *and* the circulation desk. Do not expect `role` to tell you
anything about borrowing limits.

Fines: **2-day grace**, then **₹5/day**, capped at **₹500 per loan**. Borrowing is blocked once a
member owes more than **₹200**.

## Ids, slugs, and what a 404 means

Most path parameters take a MongoDB ObjectId. Authors, publishers and categories additionally
accept a **slug**, so both of these work:

```
GET /api/v1/authors/6a7e3afafe7ee3c4c2e594f2
GET /api/v1/authors/chinua-achebe
```

A malformed id is **404, not 400**:

```
GET /api/v1/books/not-a-valid-id   →   404  { "message": "No such book", "code": "BOOK_NOT_FOUND" }
```

That is deliberate. Distinguishing "that id is badly formed" from "no such record" tells an
attacker which ids exist. Both answer the same way.

## Errors you will meet constantly

| Status | Code | Means |
|---|---|---|
| 401 | `MISSING_TOKEN` | No `Authorization` header |
| 401 | `TOKEN_EXPIRED` | Access token aged out — refresh it |
| 403 | `INSUFFICIENT_ROLE` | Signed in, but as the wrong role |
| 403 | `ACCOUNT_SUSPENDED` | Valid token, suspended account |
| 404 | `*_NOT_FOUND` | No such record, or a malformed id |
| 409 | *domain code* | The request is well-formed but the world disagrees |
| 422 | `VALIDATION_ERROR` | The body or query failed validation |
| 429 | `RATE_LIMIT_EXCEEDED` | Too many requests — see the `RateLimit-*` headers |

**422 reports every problem at once**, not the first:

```json
POST /api/v1/auth/register   { "email": "not-an-email", "password": "x" }

422 { "message": "Validation failed for 4 fields",
      "code": "VALIDATION_ERROR",
      "errors": [
        { "field": "name",     "message": "Required", "code": "required" },
        { "field": "email",    "message": "Please provide a valid email address" },
        { "field": "password", "message": "Password must be at least 8 characters" },
        { "field": "password", "message": "At least 8 characters, including an uppercase letter, a lowercase letter and a number." }
      ] }
```

## Rate limits

Five groups, each configurable in `config/rateLimit.js`:

| Group | Limit | Keyed by |
|---|---|---|
| Global | 300 / 15 min | IP |
| Auth (login, register, forgot-password) | **10 / 15 min** | IP |
| Search | 60 / min | IP |
| Upload | 20 / hour | user |
| AI generation | 5 / day | user |

**The auth limit of 10 is the one that will bite you in Postman.** Signing in as four roles a few
times while exploring reaches it quickly. Every response carries the budget:

```
RateLimit-Policy: 10;w=900
RateLimit: limit=10, remaining=1, reset=473
Retry-After: 473        (on the 429 itself)
```

Restarting the server clears the counters — the store is in memory.

---

# Part 2 — the fourteen feature areas

Each section follows the same shape: **what it is → the endpoints → a worked example → corner cases
→ what to watch in Postman**.

---

## 1. Authentication and sessions

### What it is

Registration, sign-in, and a refresh-token scheme with **rotation and reuse detection**. Every
refresh mints a new refresh token and retires the old one. If a retired token is ever presented
again, that is evidence someone copied it — so the entire session family is revoked rather than
just that one token.

### The endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /auth/register` | — | Create a MEMBER account, get a token pair |
| `POST /auth/login` | — | Sign in |
| `POST /auth/refresh` | — | Exchange a refresh token for a new pair |
| `POST /auth/logout` | — | Revoke one refresh token |
| `POST /auth/logout-all` | Member | Revoke every session |
| `GET /auth/sessions` | Member | Where am I signed in? |
| `DELETE /auth/sessions/{id}` | Member | Sign out one device |
| `POST /auth/forgot-password` | — | Email a reset link |
| `POST /auth/reset-password` | — | Consume the token, set a new password |
| `POST /auth/change-password` | Member | Requires the current password |
| `GET /auth/me` | Member | The current user |

### Example — registering a student

```json
POST /api/v1/auth/register
{
  "name": "Walkthrough Member",
  "email": "walkthrough@student.test",
  "password": "Str0ngPass",
  "membershipType": "STUDENT",
  "studentProfile": {
    "enrollmentNo": "WT57538338",
    "department": "Computer Science",
    "course": "B.Tech",
    "year": 3
  }
}
```

```json
201 Created
{ "success": true,
  "message": "Registration successful. Welcome to the library.",
  "data": {
    "user": { "id": "6a7e3b02257825de0aa13a11",
              "name": "Walkthrough Member",
              "membershipNumber": "LIB-2026-000012",
              "role": "MEMBER", "membershipType": "STUDENT",
              "studentProfile": { "enrollmentNo": "WT57538338", "verified": false, … } },
    "tokens": { "accessToken": "eyJ…", "refreshToken": "eyJ…", "expiresIn": "15m" } } }
```

### Example — reuse detection, verified

Refresh once, then present the **old** token a second time:

```json
POST /api/v1/auth/refresh   { "refreshToken": "<the original>" }
200 OK — new pair issued, the original is now retired

POST /api/v1/auth/refresh   { "refreshToken": "<the same original>" }
401 { "message": "This session has been terminated for security reasons. Please sign in again.",
      "code": "REFRESH_TOKEN_REUSED" }
```

Every session in that family is now dead, including the one the thief holds.

### Corner cases

- **`role` cannot be set at registration.** Send `"role": "ADMIN"` and it is silently stripped — the
  validator whitelists fields, so unknown and forbidden keys never reach the model. Staff accounts
  are created by an admin through `POST /users/staff`.
- **`STUDENT` and `FACULTY` registrations require `studentProfile.enrollmentNo`.** `PUBLIC` must not
  send one. The enrolment number is uniquely indexed, so reusing one returns 409.
- **`forgot-password` always returns 200**, whether or not the account exists. Otherwise the endpoint
  is an account-existence oracle. Outside production the response also carries `devToken` and
  `devResetUrl` so you can complete the flow without an inbox.
- **Reset tokens are single-use and hashed at rest.** Consuming one revokes every session.
- **`change-password` invalidates your own access token immediately** — `passwordChangedAt` is
  compared against the token's `iat`. The very next request with the old token returns 401. This is
  correct, and it is why the Postman collection runs this request as a throwaway account.
- **`logout-all` revokes refresh tokens only.** Your current access token keeps working until it
  expires — that is the accepted trade-off of stateless access tokens.

### In Postman

Every sign-in request has a test script that writes `accessToken` into the environment, so you
almost never paste a token. To act as a different role, send the matching request in the **Setup**
folder — that one request changes who the entire collection is.

If a request unexpectedly returns 401, check `accessToken` in the environment before suspecting the
API: something earlier in your run may have rotated or invalidated it.

---

## 2. Users and profiles

### What it is

Self-service profile management for members, and the administrative surface for managing everyone
else — role changes, membership changes, suspension, student verification, forced sign-out.

### The endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /users/me` · `PATCH /users/me` | Member | Own profile |
| `PATCH /users/me/notification-preferences` | Member | Per-type, per-channel toggles |
| `DELETE /users/me` | Member | Close account (soft delete) |
| `GET /users` | Staff | List and filter |
| `POST /users/staff` | Admin | Create a librarian or admin |
| `GET /users/{id}` | Staff | One user, with stats |
| `PATCH /users/{id}/role` · `/membership` | Admin | Change either axis |
| `POST /users/{id}/suspend` · `/reactivate` | Staff | Borrowing privileges |
| `POST /users/{id}/verify-student` | Staff | Confirm academic status |
| `DELETE /users/{id}/sessions` | Admin | Force sign-out everywhere |

### Example — suspension takes effect immediately

```json
POST /api/v1/users/6a7e3b02257825de0aa13a11/suspend
{ "reason": "Demonstrating the suspension flow" }
```

The suspended member's very next request, with a token issued *before* the suspension:

```json
GET /api/v1/loans/eligibility?bookId=…

403 { "success": false,
      "message": "Your account has been suspended: Demonstrating the suspension flow",
      "code": "ACCOUNT_SUSPENDED" }
```

The status is checked on every authenticated request, not baked into the token — so suspension does
not wait 15 minutes for a token to expire.

### Corner cases

- **`PATCH /users/me` cannot escalate.** `email`, `role`, `status` and `membershipType` are stripped
  from the body. Changing those requires the dedicated admin endpoints.
- **`DELETE /users/me` is refused while you owe anything.** With an open loan or an unpaid fine you
  get `409` — the library will not let a debt be deleted. Settle first.
- **Deletion is soft.** The record stays for loan history; it is filtered out of every list.
- **`GET /users` filters combine.** `?role=MEMBER&membershipType=STUDENT&hasOutstandingFines=true&sort=-stats.outstandingFine`
  answers "which students owe the most" in one request.
- **`stats` is denormalised** — `activeLoans`, `totalBorrowed`, `outstandingFine` are maintained on
  write, so listing users does not need an aggregation per row.

### In Postman

The collection's admin operations target the throwaway member created by `POST /auth/register`,
never a seeded one, so a full run leaves the sample data usable. If you retarget `{{memberId}}` at a
seeded member by hand, remember that `PATCH .../role` is not undone anywhere.

---

## 3. Authors, publishers and categories

### What it is

The taxonomy. Authors and publishers are flat; categories form a **tree** with materialised
ancestor paths, so an entire subtree can be fetched in one query rather than by recursion.

### The endpoints

Authors and publishers share a route surface (`GET`, `POST`, `GET/{identifier}`, `PATCH`, `DELETE`,
`GET/{identifier}/books`; authors also have `POST/{identifier}/merge`). Categories add
`GET /categories/tree`, `/children` and `/breadcrumb`.

Reading is **public throughout** — browsing a library's authors should not require an account.
Writing requires staff.

### Example — the tree in three views

```json
GET /api/v1/categories/6a7e…/children
200 { "data": [ { "id": "…", "name": "Algorithms", "slug": "algorithms", "bookCount": 2 }, … ] }

GET /api/v1/categories/6a7e…/breadcrumb
200 { "data": [ { "name": "Computer Science" }, { "name": "Algorithms" } ] }

GET /api/v1/categories/6a7e…/books?includeDescendants=true
```

### Corner cases

- **`includeDescendants` changes the answer completely.** Asking for books in *Computer Science*
  with `includeDescendants=false` returns only titles filed directly against that node — often zero,
  because real books live in the leaves. Default it to `true` unless you specifically want the node.
- **`{identifier}` accepts an id or a slug.** Handy in Postman: `chinua-achebe` is easier to type and
  easier to read in a run history than an ObjectId.
- **Slugs are generated from the name and must stay unique.** Creating a second "New Author" returns
  409, which is why the collection appends a timestamp.
- **`bookCount` is denormalised** and maintained on write.
- **Merging is destructive to the source.** `POST /authors/{keep}/merge` with `{ "source": "<id>" }`
  reassigns the source's books and deletes it. There is no undo.
- **Deleting a category with children or books is refused** — reparent or reassign first.

### In Postman

The collection reads seeded records and writes throwaway ones: `GET /authors/{identifier}` uses
`{{authorId}}` from the list, while `PATCH` and `DELETE` use `{{newAuthorId}}` from the create. Keep
that split if you add requests, or a run will start deleting the sample catalogue.

The merge request builds its own duplicate in a pre-request script, so it is runnable on its own.

---

## 4. Books and the catalogue

### What it is

The bibliographic record — one document per *title*, regardless of how many physical copies exist.
Soft delete with restore, ISBN validation, cover images, and three discovery feeds.

### The endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /books` | — | List, filter, sort |
| `GET /books/{id}` | — | One title |
| `GET /books/{id}/similar` | — | Same categories and authors |
| `GET /books/feeds/{feed}` | — | `new-arrivals`, `trending`, `most-borrowed` |
| `POST /books` | Staff | Create, optionally with copies |
| `PATCH /books/{id}` | Staff | Update |
| `DELETE /books/{id}` | Staff | Soft delete |
| `POST /books/{id}/restore` | Staff | Undelete |

### Example — create a title with its copies in one call

```json
POST /api/v1/books
{ "title": "The Walkthrough Book",
  "isbn13": "9781786575388",
  "authors": ["6a7e3afafe7ee3c4c2e5951f"],
  "publisher": "6a7e3afafe7ee3c4c2e59500",
  "categories": ["6a7e3afafe7ee3c4c2e59537"],
  "publishedYear": 2024, "pageCount": 288, "price": 499,
  "copies": 1,
  "description": "A title created during the walkthrough." }
```

```
201 Created — the book, plus one BookCopy with accession number ACC-2026-000043
```

### Example — soft delete really is soft

```
DELETE /api/v1/books/{id}          →  204 No Content
GET    /api/v1/books/{id}          →  404  (the public no longer sees it)
POST   /api/v1/books/{id}/restore  →  200  (it is back, with its copies and reviews)
```

### Corner cases

- **`DELETE` returns 204 with an empty body.** Postman shows a blank response pane; that is success,
  not a failure.
- **ISBNs are checksum-validated.** A random 13 digits is rejected before it reaches the database.
  Both ISBN-10 and ISBN-13 are accepted, normalised, and stored as a pair.
- **Duplicate ISBN is 409**: `"A book with this ISBN already exists"`. The uniqueness index is
  *partial* — it applies only where the field is a string, so any number of books may have no ISBN
  at all. (A plain `sparse` index would have allowed exactly one.)
- **Staff and the public see different shapes.** As a librarian, `GET /books/{id}` includes
  `isDeleted`, `addedBy` and per-copy detail; anonymously it does not.
- **`availability` is denormalised and always present:**

  ```json
  "availability": {
    "physical": { "total": 4, "available": 3, "isAvailable": true },
    "digital":  { "hasEbook": false, "licenses": 0, "available": 0, "isAvailable": false },
    "canBorrowNow": true }
  ```

  Read `canBorrowNow` rather than computing it.
- **`GET /books` and `GET /search` accept different filters.** `format=digital` is a *search*
  filter. Sent to `/books` it is silently stripped by the whitelist — you get unfiltered results, not
  an error. If a filter seems to be ignored, check which endpoint documents it.

### In Postman

`POST /books` generates a fresh valid ISBN-13 in a pre-request script, including the check digit, so
the request can be sent repeatedly. Its response captures `newBookId`, and `PATCH`, `DELETE` and
`restore` all target that — never the seeded catalogue.

---

## 5. Physical copies

### What it is

One document per item on a shelf. Six copies of a title means six `BookCopy` documents and one
`Book`. Each carries a barcode (`accessionNumber`), a shelf location, a condition, and a status
history.

### The endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /books/{bookId}/copies` | Staff | Every copy, with borrower |
| `POST /books/{bookId}/copies` | Staff | Add copies |
| `PATCH /books/copies/{copyId}` | Staff | Change status or condition |
| `DELETE /books/copies/{copyId}` | Staff | Withdraw |

### Example — adding stock, then writing one off

```json
POST /api/v1/books/{bookId}/copies
{ "count": 2, "shelfLocation": "A-12-3", "condition": "GOOD", "cost": 499 }

201 { "message": "2 copies added",
      "data": { "copies": [ { "id": "…", "accessionNumber": "ACC-2026-000044" }, … ],
                "inventory": { "totalCopies": 3, "availableCopies": 3 } } }
```

```json
PATCH /api/v1/books/copies/{copyId}
{ "status": "DAMAGED", "note": "Water damage to the last twenty pages" }
```

The note is written into that copy's `statusHistory` with who and when. "This copy has been marked
damaged three times this year" is a real acquisitions signal.

### Corner cases

- **Accession numbers come from an atomic counter**, not `count + 1`. Adding copies concurrently —
  which a bulk import does by definition — used to produce duplicate-key errors. See
  [`src/models/Counter.js`](../src/models/Counter.js).
- **A copy on loan cannot be deleted.** Return it first.
- **Statuses**: `AVAILABLE`, `ON_LOAN`, `DAMAGED`, `LOST`, `WITHDRAWN`. Only `AVAILABLE` can be
  borrowed, and the transition to `ON_LOAN` is the atomic claim described in
  [feature 8](#8-borrowing--the-core-engine).
- **The borrow path prefers the least-circulated copy** (`sort: { loanCount: 1 }`), so wear spreads
  across the stock instead of destroying whichever sorts first.
- **`status` and `condition` are different things.** A copy can be `AVAILABLE` and `POOR` — shabby
  but lendable.

### In Postman

`POST .../copies` captures `newCopyId`, and the `PATCH` and `DELETE` that follow act on that copy —
so running the folder does not quietly withdraw seeded stock.

---

## 6. Search and discovery

### What it is

A weighted MongoDB text index — `title` ×10, `subtitle` ×5, `tags` ×3, `description` ×1 — with
filters, faceted counts for building a sidebar, autocomplete, and a fuzzy fallback.

### The endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /search` | — | Full search with filters and relevance scoring |
| `GET /search/facets` | — | Counts per category, author, language, year |
| `GET /search/suggest` | — | Autocomplete |

### Example — search with filters

```
GET /api/v1/search?q=things fall apart&category=…&includeSubcategories=true&minRating=3&language=en
```

```json
200 { "message": "Search complete",
      "data": [ { "title": "Things Fall Apart",
                  "authors": [ { "name": "Chinua Achebe", "slug": "chinua-achebe" } ],
                  "publishedYear": 1958,
                  "rating": { "average": 4.5, "count": 2 },
                  "availability": { "physical": { "total": 4, "available": 3 } } } ] }
```

### Example — facets for a sidebar

```json
GET /api/v1/search/facets

200 { "data": { "categories": [
        { "name": "Literary Fiction",          "slug": "literary-fiction",           "count": 4 },
        { "name": "Indian Writing in English", "slug": "indian-writing-in-english",  "count": 3 },
        { "name": "Algorithms",                "slug": "algorithms",                 "count": 2 } ] } }
```

One `$facet` aggregation returns every count, so a UI can render "Literary Fiction (4)" without a
request per filter.

### Corner cases

- **An empty `q` is not the same as an omitted `q`.** This trips people up constantly:

  ```
  GET /search/facets?q=      →  422  { "field": "q", "message": "Search term cannot be empty" }
  GET /search/facets         →  200  facets across the whole catalogue
  ```

  In Postman that means **untick** the parameter row rather than clearing its value.
- **Fuzzy fallback.** If text search returns nothing, a regex pass runs so a misspelling like
  `achibe` still finds Achebe. Slower, so it is a fallback and not the primary path.
- **Relevance is the default sort** when `q` is present, and recency when it is not — sorting by
  relevance without a search term is meaningless.
- **`limit` is capped server-side.** Asking for 10,000 gets you the maximum, not an error.
- **Search is rate-limited at 60/min per IP** — the tightest of the read limits, because it is the
  most expensive read.

### In Postman

Several query parameters in the search requests ship **disabled** (greyed out) so the request works
as-is. Tick them one at a time to see each filter's effect; ticking `q` with an empty value is the
422 above.

---

## 7. Files and digital books

### What it is

Cover images, avatars, and ebooks. Ebooks are **never served statically** — every read is
authorised, and streamed with HTTP Range support so a browser PDF viewer can seek without
downloading the whole file.

### The endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /files/books/{bookId}/cover` | Staff | Cover image |
| `POST /files/books/{bookId}/ebook` | Staff | PDF or EPUB |
| `POST /files/avatar` | Member | Profile picture |
| `GET /files/books/{bookId}/assets` | Staff | What is attached |
| `POST /files/ebooks/{assetId}/extract` | Staff | Extract text for the AI pipeline |
| `GET /files/ebooks/{assetId}/read` | Member with a digital loan | Stream, Range-aware |
| `POST /files/ebooks/{assetId}/download-link` | Member with a digital loan | Mint a signed URL |
| `GET /files/ebooks/{assetId}/download?token=` | — (the token *is* the credential) | Download |
| `DELETE /files/ebooks/{assetId}` | Staff | Remove |

### Example — upload, extract, read

```json
POST /api/v1/files/books/{bookId}/ebook      (multipart/form-data, field "ebook")

201 { "message": "Ebook uploaded",
      "data": { "asset": { "id": "6a7e3b04257825de0aa13af0", "format": "PDF",
                           "originalName": "sample.pdf", "sizeBytes": 560, "sizeFormatted": "0.5 KB",
                           "extraction": { "status": "PENDING", "characters": 0 } } } }
```

```json
POST /api/v1/files/ebooks/{assetId}/extract
200 { "message": "Extraction finished with status COMPLETED",
      "data": { "status": "COMPLETED", "chars": 33, "pages": 1 } }
```

### Example — Range streaming, verified

```
GET /api/v1/files/ebooks/{assetId}/read
Range: bytes=0-99
```

```
206 Partial Content
Content-Range:  bytes 0-99/560
Accept-Ranges:  bytes
Content-Type:   application/pdf
Content-Disposition: inline; filename="sample.pdf"
→ 100 bytes
```

Without the header the same URL returns `200` and all 560 bytes. `inline` lets the browser render
it; the **download** endpoint sends `attachment` instead, because that endpoint exists to save a
file rather than display one.

### Example — the signed download token

```json
POST /api/v1/files/ebooks/{assetId}/download-link
200 { "data": { "token": "eyJ…", "url": "http://localhost:5000/api/v1/files/ebooks/…/download?token=eyJ…",
                "expiresIn": "5m" } }
```

That URL carries no `Authorization` header — which is the point, since an `<a download>` link and a
native PDF viewer cannot send one. The token is scoped to **one asset**, expires in minutes, and
carries a single-use nonce. Presenting it for a different asset is refused.

### Corner cases

- **Three distinct upload rejections**, and knowing which is which saves time:

  | | Status / code |
  |---|---|
  | No file attached | `400 FILE_REQUIRED` — *"No file was uploaded. Send it as multipart/form-data in the "avatar" field."* |
  | Wrong declared type | `415 UNSUPPORTED_FILE_TYPE` — *"application/octet-stream is not accepted here. Allowed types: image/jpeg, image/png, image/webp"* |
  | Right type, wrong contents | `415 FILE_SIGNATURE_MISMATCH` — *"This file's contents do not match its declared type (image/png). It may be corrupted, or renamed from another format."* |

  The last one is the interesting one: the API reads the file's **magic number** rather than trusting
  the extension or the browser-supplied MIME. Rename a PDF to `.png` and it is still caught.
- **Reading requires an active digital loan.** Without one:
  `403 "You need an active digital loan for this book in order to read it"`. Staff may read without
  a loan, for cataloguing.
- **A bad download token is 401** (`"Invalid or malformed token"`), and a *valid* token presented for
  a different asset is 403 — a widened grant, not a broken one.
- **Uploads are deduplicated by sha256.** Uploading the same file twice reuses the stored blob.
- **Extraction degrades gracefully.** If text cannot be pulled out, the asset stays usable and the AI
  features fall back to the catalogue record.
- **Uploads are limited to 20/hour per user**, and to `MAX_FILE_SIZE_MB` (default 10) — over that is
  `413`.

### In Postman

**These are the only requests that need manual work.** Postman cannot ship a file path in a shared
collection, so on the `Body` tab of each upload you must click **Select Files**. Until you do,
those three return `400 FILE_REQUIRED` and the five requests that follow return `404`, because no
asset exists to act on. That is a missing attachment, not a broken API — with real files attached
the folder runs green end to end.

Setting a `Range` header by hand on the read request is the quickest way to see a `206`.

---

## 8. Borrowing — the core engine

### What it is

The heart of the system. Eligibility, an atomic copy claim, renewals, returns, desk operations, and
write-offs. **There is no reservation or waitlist** anywhere — when nothing is available the API says
so cleanly and tells you when to come back.

### The endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /loans/eligibility?bookId=` | Member | Can I borrow this, and why not |
| `POST /loans` | Member | Borrow for yourself |
| `GET /loans/me` | Member | Your loans |
| `GET /loans` | Staff | The whole library |
| `GET /loans/{id}` | Owner or staff | One loan |
| `POST /loans/{id}/renew` | Owner or staff | Extend |
| `POST /loans/{id}/return` | Owner or staff | Return, assessing any fine |
| `POST /loans/issue` | Staff | Issue on behalf of a member |
| `POST /loans/{id}/lost` | Staff | Write off, optionally charging replacement |

### Example — check first, then borrow

```json
GET /api/v1/loans/eligibility?bookId=6a7e3b03257825de0aa13a8c

200 { "message": "You can borrow this book",
      "data": { "eligible": true, "currentLoans": 2, "maxLoans": 5, "outstandingFines": 0 } }
```

```json
POST /api/v1/loans   { "bookId": "6a7e3b03257825de0aa13a8c", "type": "PHYSICAL" }

201 { "message": "Borrowed. Please return it by Fri Sep 04 2026.",
      "data": {
        "loan": { "id": "6a7e3b04257825de0aa13b1a", "type": "PHYSICAL", "status": "ACTIVE",
                  "issuedAt": "2026-08-13T21:45:40.645Z",
                  "dueAt": "2026-09-04T18:29:59.999Z",
                  "daysRemaining": 21, "isOverdue": false,
                  "renewals": { "count": 0, "history": [] } },
        "copy": { "id": "…", "accessionNumber": "ACC-2026-000043" },
        "loanPeriodDays": 21,
        "renewalsAllowed": 2,
        "availability": { "remainingCopies": 1 } } }
```

21 days, because the borrower is a `STUDENT`. The response names the specific physical copy — that
accession number is what the member walks out with.

### Example — the seven eligibility checks

Each failure has its own code, so a client can say something useful rather than "cannot borrow":

| Code | Meaning |
|---|---|
| `ACCOUNT_SUSPENDED` | Account not active |
| `LOAN_LIMIT_REACHED` | At the cap for the membership type |
| `HAS_OVERDUE_ITEMS` | Something is already overdue |
| `OUTSTANDING_FINES` | Owes more than ₹200 |
| `ALREADY_BORROWED` | Already holds this title |
| `NO_COPY_AVAILABLE` | Every copy is out |
| `NO_LICENSE_AVAILABLE` | Every digital licence is in use |

```json
POST /api/v1/loans
409 { "message": "You have an overdue item. Please return it before borrowing anything else.",
      "code": "HAS_OVERDUE_ITEMS" }
```

And when the shelf is genuinely empty:

```json
409 { "message": "Every copy of this book is currently on loan",
      "code": "NO_COPY_AVAILABLE",
      "details": { "totalCopies": 1, "earliestExpectedReturn": "2026-09-04T18:29:59.999Z" } }
```

`earliestExpectedReturn` is what lets a client say *"try again after the 4th"* without a
reservation system.

### Example — renewal, and its two rules

```json
POST /api/v1/loans/{id}/renew
200 { "message": "Renewed until Fri Sep 04 2026. 1 renewal(s) remaining." }
```

```json
POST /api/v1/loans/{id}/renew        (the third attempt)
409 { "message": "This loan has already been renewed 2 time(s), which is the maximum for STUDENT membership.",
      "code": "RENEWAL_LIMIT_REACHED",
      "details": { "renewalCount": 2, "maxRenewals": 2 } }
```

### Example — digital lending

```json
POST /api/v1/loans   { "bookId": "…", "type": "DIGITAL" }

201 { "message": "Digital loan issued. It expires on Fri Aug 21 2026.",
      "data": { "loan": { "type": "DIGITAL", "dueAt": "2026-08-21T18:29:59.999Z", "daysRemaining": 7 } } }
```

Digital loans run 7 days regardless of membership, consume one of the title's concurrent licences,
and expire on a timer — there is nothing to hand back.

### Example — the desk, and writing an item off

```json
POST /api/v1/loans/issue
{ "bookId": "…", "userId": "…", "note": "Issued at the circulation desk" }

201 { "message": "Issued to Walkthrough Member. Due Fri Sep 04 2026." }
```

```json
POST /api/v1/loans/{id}/lost   { "note": "Member reported it lost", "chargeReplacement": true }

200 { "message": "Marked lost. A replacement charge of INR 549.00 has been added." }
```

The charge is the copy's recorded acquisition cost — which is why `cost` is worth filling in when
adding copies.

### Corner cases

- **Renewing immediately appears to do nothing, and that is correct.** A renewal grants *a fresh full
  period from today*, not an extension bolted onto the old due date — so renewing three days early
  does not quietly cost you three days. Renew in the same minute you borrowed and the new due date
  equals the old one; `renewalHistory` records `previousDueAt` and `newDueAt` as identical. The
  headline "a student can reach 63 fine-free days" therefore assumes you renew *near* the due date.
- **Renewal is refused once a loan is overdue** (`CANNOT_RENEW_OVERDUE`), so it can never be used to
  escape an accrued fine.
- **Returning twice is 409, not a silent success.** The second call reports the loan is already
  returned. The status filter in the update means a double return cannot increment availability
  twice and invent a copy the library does not own.
- **A member cannot read another member's loan**: `403 "This is not your loan"`. Staff can read any.
- **Due dates land at end of day.** `dueAt` is `18:29:59.999Z` — 23:59:59.999 in IST. Compute
  "days remaining" from the API's `daysRemaining` rather than subtracting timestamps, or you will be
  off by one.
- **Borrowing is safe under concurrency without transactions.** The claim is a single atomic
  `findOneAndUpdate` filtered on `status: 'AVAILABLE'` — a compare-and-swap. Twenty simultaneous
  requests for one copy produce exactly one `201`; availability lands on 0, never negative. This
  matters because a standalone `mongod` has no multi-document transactions at all.

### In Postman

The Loans folder switches identity mid-way — it borrows and renews as a member, then signs in as a
librarian for the desk operations. The pre-request scripts do this for you.

**The Collection Runner cannot test the concurrency guarantee**, because it is sequential. That
check needs parallel requests from a terminal; the recipe is in
[`postman-testing-guide.md`](postman-testing-guide.md), and it is asserted automatically in
[`tests/integration/circulation.test.js`](../tests/integration/circulation.test.js).

---

## 9. Fines

### What it is

Money owed. Fines arise automatically from overdue returns, or manually from damage and loss. They
gate borrowing above ₹200.

### The endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /fines/me` | Member | Your ledger |
| `GET /fines` | Staff | Everyone's |
| `GET /fines/summary` | Staff | Collection totals |
| `POST /fines` | Staff | Raise a manual charge |
| `GET /fines/{id}` | Owner or staff | One fine |
| `POST /fines/{id}/pay` | Staff | Record payment |
| `POST /fines/{id}/waive` | Staff | Cancel, with a mandatory note |

### The arithmetic

```
fine = min( ₹5 × max(0, daysOverdue − 2), ₹500 )
```

Two days' grace, ₹5 a day, capped at ₹500 per loan. The calculation lives in exactly one place —
`config/library.js` — and the same function is used by the return path, the overdue cron job and the
tests, so they cannot drift apart.

### Example — raise, then settle

```json
POST /api/v1/fines
{ "userId": "…", "amount": 150, "reason": "DAMAGE", "description": "Torn dust jacket, replaced" }

201 { "message": "Charge added to the account",
      "data": { "id": "…", "reason": "DAMAGE", "amount": 150, "currency": "INR", "status": "PENDING" } }
```

```json
POST /api/v1/fines/{id}/pay   { "paymentMethod": "CASH", "paymentReference": "RCPT-2026-0912" }
200 — status becomes PAID
```

```json
POST /api/v1/fines/{id}/waive   { "note": "…" }
409 { "message": "This fine has already been paid" }
```

A settled fine cannot then be waived. Pay and waive are alternative endings, not a sequence.

### Example — the summary a librarian actually wants

```json
GET /api/v1/fines/summary

200 { "data": { "currency": "INR",
                "outstanding": 804, "outstandingCount": 4,
                "collected": 0, "waived": 0,
                "byReason": [ { "reason": "LOST", "total": 549, "count": 1 },
                              { "reason": "OVERDUE", "total": 255, "count": 3 } ],
                "topDebtors": [ { "name": "Walkthrough Member", "total": 549, "count": 1 } ] } }
```

### Corner cases

- **Waiving requires a note.** Cancelling money without a reason is exactly what an audit is for.
- **Overdue assessment is idempotent.** Running the overdue job repeatedly does not stack fines on
  one loan; it updates the existing one.
- **The ₹500 cap is per loan, not per member.** Someone with three badly overdue items can owe
  ₹1,500.
- **The ₹200 block is on the total.** Reasons do not matter — a damage charge blocks borrowing just
  as an overdue fine does.
- **Fines survive the loan.** Returning an overdue item clears the loan but not the debt.

### In Postman

`POST /fines` captures the new fine's id, so `pay` and `waive` act on a fine the folder created
rather than a seeded member's ledger. Because pay comes first, the waive request raises a **second**
fine in its pre-request script — otherwise it would always hit the 409 above.

---

## 10. Reviews and ratings

### What it is

One review per member per book, enforced by a unique compound index. Ratings roll up into an
average, a count and a 1–5 distribution on the book. Reviews can be voted helpful, reported, and
moderated.

### The endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /reviews/books/{bookId}` | — | Reviews of a book |
| `POST /reviews/books/{bookId}` | Member | Publish |
| `GET /reviews/me` | Member | Your reviews |
| `GET /reviews/{id}` · `PATCH` · `DELETE` | Owner or staff | One review |
| `POST /reviews/{id}/helpful` | Member | Toggle a vote |
| `POST /reviews/{id}/report` | Member | Flag it |
| `GET /reviews/moderation-queue` | Staff | Pending and reported |
| `POST /reviews/{id}/moderate` | Staff | Approve or reject |

### Example — publish, and watch the aggregate move

```json
POST /api/v1/reviews/books/{bookId}
{ "rating": 5, "title": "Excellent", "body": "Clear, well paced and genuinely useful throughout." }

201 { "message": "Review published",
      "data": { "id": "…", "rating": 5, "status": "APPROVED", "isVerifiedBorrower": true } }
```

The book's `rating` block is recomputed on write, so `GET /books/{id}` immediately reflects the new
average, count and distribution.

### Corner cases

- **Reviewing twice is 409**: *"You have already reviewed this book. Edit your existing review
  instead."* Enforced by a unique index on `(user, book)`, so it holds even under concurrent posts.
- **You cannot vote on your own review**: `400 "You cannot mark your own review as helpful"`. In
  Postman this means the helpful and report requests must run as a *different* member — the
  collection signs in as a second seeded student to do exactly that.
- **`helpful` is a toggle.** Sending it twice adds then removes the vote.
- **`isVerifiedBorrower` is derived**, not claimed — it is true only if the reviewer actually has a
  loan for that title.
- **Moderation is a two-step story.** A reported review enters the queue; a librarian approves or
  rejects it. Rejected reviews stop counting toward the book's rating.
- **Deleting a review recomputes the aggregate** — the average must not remember a review that no
  longer exists.

### In Postman

The Reviews folder reviews the **throwaway book** created earlier, not a seeded one, because a
seeded member may already have reviewed a seeded title — which would 409 on the very first run.

---

## 11. Reading lists and favourites

### What it is

Shelves. Four are created automatically for every member — Favourites, Want to Read, Reading,
Finished — and members can add their own. Lists can be made public and shared by slug.

### The endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /reading-lists` | Member | Your lists |
| `POST /reading-lists` | Member | Create |
| `GET /reading-lists/{id}` · `PATCH` · `DELETE` | Owner | One list |
| `POST /reading-lists/{id}/books` | Owner | Add, with a note |
| `DELETE /reading-lists/{id}/books/{bookId}` | Owner | Remove |
| `POST /reading-lists/favourites/toggle` | Member | One-call favourite |
| `GET /reading-lists/shared/{slug}` | — | A public list |

### Example — create a public list and share it

```json
POST /api/v1/reading-lists
{ "name": "Summer reading", "description": "For the holidays", "isPublic": true }

201 { "data": { "id": "6a7e21e003540685c3c63064",
                "name": "Summer reading", "type": "CUSTOM",
                "isPublic": true,
                "shareUrl": "/lists/shared/adbb5cc4d0bdb97e2a00dd8e",
                "bookCount": 0 } }
```

```json
GET /api/v1/reading-lists/shared/adbb5cc4d0bdb97e2a00dd8e     ← no authentication
200 { "message": "Shared list fetched" }
```

### Example — favourites in one call

```json
POST /api/v1/reading-lists/favourites/toggle   { "bookId": "…" }
200 { "message": "Added to favourites" }

POST /api/v1/reading-lists/favourites/toggle   { "bookId": "…" }
200 { "message": "Removed from favourites" }
```

A UI heart button needs one endpoint, not two.

### Corner cases

- **The response gives you `shareUrl`, not `shareSlug`.** The endpoint wants only the last segment.
  The collection's test script splits it for you — worth knowing if you script against this yourself.
- **A slug only exists while the list is public.** Setting `isPublic: false` revokes the link.
- **The share slug is a random 24-hex string**, not the list id — so a public list does not leak an
  internal identifier, and it can be rotated.
- **Default lists cannot be deleted**, only emptied. They are `isDefault: true`.
- **Adding the same book twice is idempotent** — no duplicate entry, no error.

### In Postman

`GET /reading-lists/shared/{slug}` must run **after** `POST /reading-lists`, because that is what
produces the slug. The folder is ordered that way; sending it first gives you a 404 on an empty
path segment.

---

## 12. Notifications

### What it is

An in-app notification centre, plus email delivery through a provider interface. Triggers include
welcome, password reset, due-soon, overdue, fine issued, fine waived, review approved and account
suspended.

### The endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /notifications` | Member | Paginated, with an `unread` filter |
| `GET /notifications/unread-count` | Member | Badge count |
| `POST /notifications/read` | Member | Mark one, several, or all |
| `DELETE /notifications/{id}` | Member | Dismiss |
| `PATCH /users/me/notification-preferences` | Member | Per-type, per-channel |

### Example

```json
POST /api/v1/notifications/read   { "all": true }
200 { "message": "2 notification(s) marked read" }
```

### Corner cases

- **Email goes to your terminal, not an inbox.** `MAIL_PROVIDER=sendgrid` with no valid
  `SENDGRID_API_KEY` falls back to a console provider, logging one warning at boot. `/health/ready`
  reports which provider is live. Adding the key later is a pure `.env` change.
- **Preferences are a partial update** — send only the types you want to change.
- **Read notifications are TTL-expired** after a configured period; unread ones are kept.
- **Delivery outcome is written back** to the notification, including the provider's message id.

### In Postman

Nothing needs setting up — the seeder creates unread notifications for the demo members. If
`unread-count` returns 0, you are signed in as someone who has none; sign in as a seeded member.

---

## 13. AI features

### What it is

Seven model-backed features over a **hard lifetime budget of 100 calls**. The design treats that
constraint as the interesting problem: everything is cache-first, and when the model is unreachable
the API degrades to a deterministic mock rather than failing.

### The endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /ai/books/{id}/summary?length=SHORT\|MEDIUM\|LONG` | Member | Summary |
| `GET /ai/books/{id}/takeaways` | Member | 5–7 bullets |
| `GET /ai/books/{id}/simplified` | Member | "Explain it to a 15-year-old" |
| `POST /ai/books/{id}/ask` | Member | Q&A grounded in the record |
| `GET /ai/recommendations` | Member | From loans and favourites |
| `POST /ai/books/{id}/suggest-metadata` | Staff | Categories, tags, reading level |
| `GET /ai/status` | Staff | Quota, cache and mode |
| `POST /ai/sync-usage` · `/upgrade-mocks` | Admin | Reconcile quota · regenerate mocks |

### Example — the cache, measured

Same request, twice:

```
GET /ai/books/{id}/summary?length=MEDIUM     →  200 in 1472 ms   "cached": false
GET /ai/books/{id}/summary?length=MEDIUM     →  200 in   23 ms   "cached": true
```

**64× faster and zero further calls against the budget.** The cache key is
`(book, kind, length, language, promptVersion)`, so `length=SHORT` is a separate entry — and bumping
`promptVersion` is the deliberate way to invalidate everything.

### Example — a mock response, honestly labelled

```json
GET /api/v1/ai/books/{id}/summary?length=MEDIUM

200 { "data": {
        "content": "The God of Small Things was written by Arundhati Roy. Set in Kerala, the novel
                    tells the story of fraternal twins Rahel and Estha, whose lives are destroyed by
                    the Love Laws that lay down who should be loved, and how, and how much. …",
        "source": "mock",
        "aiGenerated": false,
        "isMock": true,
        "notice": "Generated offline because the AI service is unavailable. This is not model-generated content.",
        "length": "MEDIUM",
        "basedOn": "the catalogue record" } }
```

Note what this is **not**: it is not lorem ipsum. The mock provider seeds off the input hash and
templates the real title, authors, categories and description, so the same book always yields the
same plausible text. And it never pretends to be real — `source`, `aiGenerated`, `isMock` and
`notice` all say otherwise, and `AiUsageLog` records `wasMock: true` so mock traffic never pollutes
the usage dashboard.

### Example — Q&A refuses to invent

```json
POST /api/v1/ai/books/{id}/ask   { "question": "What is the central conflict of this book?" }

200 { "data": { "content": {
        "answer": "Based on the catalogue entry for The God of Small Things by Arundhati Roy, this
                   question goes beyond what the record covers. Borrowing the book and reading the
                   relevant section would give a much better answer than this record can.",
        "answeredFromSource": false } } }
```

`answeredFromSource: false` is the signal that the answer is not grounded in the text.

### Example — where the budget stands

```json
GET /api/v1/ai/status

200 { "data": {
        "mode": "mock",
        "reason": "The AI provider rejected our token: … — serving mock content",
        "hasToken": true, "tokenRejected": true,
        "quota": { "total": 100, "used": 0, "remaining": 90, "reserved": 10 },
        "perUserDailyLimit": 5,
        "circuitBreaker": "half-open",
        "cache": { "entries": 5, "mockEntries": 5, "realEntries": 0 },
        "statistics": { "totalRequests": 7, "liveCalls": 1, "cacheHits": 1, "mockResponses": 5,
                        "savedByCache": 6, "cacheHitRate": 86,
                        "averageLiveLatencyMs": 1426, "averageCacheLatencyMs": 2 } } }
```

### Corner cases

- **The supplied token is rejected by the provider** (`401 invalid_api_key`). The system detects
  this on the first live attempt, latches into mock mode, and every AI endpoint keeps returning
  `200`. That is the designed behaviour — `tokenRejected: true` in `/ai/status` is how you tell.
- **`AI_MOCK_MODE` has three settings.** `auto` (default) falls back when the token is missing,
  rejected, or the quota is spent with nothing cached. `always` never touches the network — best
  while testing, because it costs nothing. `never` fails loudly, so a production misconfiguration
  cannot hide behind fake data.
- **`POST /ai/sync-usage` returns 503 with a dead token**, because it asks the provider for its
  usage figures and cannot get an answer. Expected, not a bug.
- **Per-user cap of 5 generations/day** protects the shared budget from a single account. Cache hits
  do not count.
- **Recommendations are heuristic-first.** Category and author co-occurrence runs before any model
  call; the model is used only for the explanation text, and only when asked with `explain=true`.
- **`reserved: 10`** holds back part of the budget so an admin can still regenerate content after
  members have spent the rest.

### In Postman

Set `AI_MOCK_MODE=always` in `.env` while exploring. Responses stay instant and well-formed, and you
cannot accidentally spend from a 100-call lifetime budget by re-running a folder.

To see the cache work, send the summary request twice and compare the times in Postman's response
pane — the difference is unmistakable.

---

## 14. Admin, analytics and audit

### What it is

The management surface: an analytics dashboard built on aggregation pipelines, four reports, CSV
import/export, manual job triggers, and an audit log viewer.

### The endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /admin/dashboard?days=30` | Admin | Collection, circulation, fines, AI, members |
| `GET /admin/reports/popular` | Admin | Most borrowed |
| `GET /admin/reports/unborrowed` | Admin | Dead stock |
| `GET /admin/reports/active-members` | Admin | Who is using the library |
| `GET /admin/reports/inventory-health` | Admin | Damaged, lost, withdrawn |
| `GET /admin/audit-log` | Admin | Privileged mutations |
| `POST /admin/books/import?dryRun=` | Admin | Bulk CSV import |
| `GET /admin/books/export` | Admin | CSV export |
| `POST /admin/jobs/{job}/run` | Admin | Trigger a cron job now |

### Example — the dashboard

```json
GET /api/v1/admin/dashboard?days=30

200 { "data": {
        "periodDays": 30,
        "collection": { "titles": 16, "copies": 44, "availableCopies": 34,
                        "titlesWithEbook": 1, "utilisationPercent": 23 },
        "circulation": { "openLoans": 10, "overdueLoans": 3, "overdueRatePercent": 30,
                         "issuedInPeriod": 9, "returnedInPeriod": 2,
                         "averageLoanDurationDays": 8.6,
                         "byType": { "PHYSICAL": 14, "DIGITAL": 1 },
                         "trend": [ { "date": "2026-08-13", "count": 3 }, … ] } } }
```

### Example — running a cron job on demand

```json
POST /api/v1/admin/jobs/overdue-check/run
200 { "message": "Job \"overdue-check\" finished in 42ms" }
```

Invaluable for testing: rather than waiting for the scheduler, trigger overdue detection and fine
accrual immediately and watch the fines appear.

### Corner cases

- **`?dryRun=true` on import validates without writing.** Always the first thing to run on a CSV you
  did not generate.
- **Export first, import second.** The quickest way to get a valid CSV is `GET /admin/books/export`
  and save the response — the shapes match exactly.
- **The CSV export is `text/csv`, not JSON.** Postman shows it in the raw pane; the envelope does not
  apply.
- **Reports are aggregation pipelines** and get slower as data grows. They are admin-only partly for
  that reason.
- **⚠️ The audit log is currently almost empty, and that is a real gap.** The `AuditLog` model, the
  viewer endpoint and its filters all work — but the only thing that writes to it today is the manual
  job trigger. Suspending a user, changing a role, deleting a book, **waiving a fine** and moderating
  a review all complete without leaving an audit entry, even though
  [`api-reference.md`](api-reference.md) describes this endpoint as *"every privileged mutation, with
  diffs"*. The plumbing exists (`record()` in `src/services/admin.service.js`); it is simply not
  called from the privileged mutations. Treat the endpoint as working and the coverage as
  outstanding.

### In Postman

The Admin folder is admin-only throughout; its first request signs in as the admin. Run it **last**,
so the dashboard and reports describe the work the earlier folders just did rather than an idle
database.

---

# Part 3 — corner cases that cut across everything

**Rate limits are the number one source of confusing Postman results.** A full collection run is
~140 requests against a global budget of 300 per 15 minutes, and the auth group allows only 10
sign-ins. If *everything* suddenly returns 429, that is the cause. Set `RATE_LIMIT_ENABLED=false`
while exploring, or restart the server to clear the in-memory counters.

**Empty is not the same as absent.** `?q=` fails validation; omitting `q` succeeds. In Postman,
untick the parameter row rather than blanking its value. The same applies to any optional filter.

**Unknown query parameters are silently dropped**, not rejected. That is the mass-assignment defence
working — the validator whitelists — but it means a typo'd or wrong-endpoint filter looks like it
was ignored. If a filter has no effect, check it is documented for *that* endpoint.

**NoSQL injection is blocked twice.** `{"email": {"$ne": null}}` is rejected by the Zod schema with
`Expected string, received object`, and a recursive sanitiser separately strips `$`-prefixed and
dotted keys from bodies and params. Neither layer alone would be enough.

**404 covers both "malformed id" and "no such record."** Do not read a 404 as "my id is wrong" — the
record may simply not exist, or be soft-deleted.

**Soft deletes are everywhere.** Books, users and reviews are marked deleted, not removed. They stay
queryable by staff and keep loan history intact.

**Dates are stored in UTC and land at end of day.** A `dueAt` of `18:29:59.999Z` is 23:59:59.999 in
IST. Trust `daysRemaining` and `isOverdue` over your own arithmetic.

**Denormalised counters are maintained on write** — `availability`, `rating`, `bookCount`,
`user.stats`. They are correct, but they are computed at write time; if you edit MongoDB directly
they will drift.

**Every response carries `X-Request-Id`.** When something is inexplicable, that id ties the Postman
response to the exact server log lines.

**Concurrency is handled with atomic operations, not transactions**, because a standalone `mongod`
has none. The copy claim and the sequence counters are both single-document compare-and-swaps. The
app detects at boot whether it is talking to a replica set and uses real sessions when they are
available.

---

# Part 4 — one complete story

Fifteen requests that exercise the whole system. Run them in this order and every one succeeds.

| # | Request | As | What it establishes |
|---|---|---|---|
| 1 | `GET /health/ready` | — | The server, database, mail provider and AI mode |
| 2 | `POST /auth/login` | admin | A session |
| 3 | `POST /authors` | admin | An author |
| 4 | `POST /publishers` | admin | A publisher |
| 5 | `POST /categories` | admin | A subject |
| 6 | `POST /books` (`copies: 2`) | admin | A title with real stock |
| 7 | `POST /files/books/{id}/cover` | admin | A cover — attach a file |
| 8 | `POST /files/books/{id}/ebook` | admin | An ebook — attach a file |
| 9 | `POST /auth/register` | — | A student member |
| 10 | `GET /loans/eligibility?bookId=` | member | Allowed, 0 of 5 loans used |
| 11 | `POST /loans` | member | Borrowed — 21 days, availability 2 → 1 |
| 12 | `GET /search?q=<title>` | — | It is findable, and shows 1 of 2 available |
| 13 | `POST /reviews/books/{id}` | member | A review — the book's rating moves |
| 14 | `POST /loans/{id}/return` | member | Returned, availability back to 2 |
| 15 | `GET /admin/dashboard` | admin | The loan appears in circulation and the trend |

Then break it deliberately:

| # | Request | Expected |
|---|---|---|
| 16 | Borrow the same title 3× as 3 members (2 copies) | The third: `409 NO_COPY_AVAILABLE` with `earliestExpectedReturn` |
| 17 | `GET /admin/dashboard` as the member | `403 INSUFFICIENT_ROLE` |
| 18 | `POST /reviews/books/{id}` again as the same member | `409` — already reviewed |
| 19 | `POST /loans/{id}/return` twice | `409` — already returned |
| 20 | `GET /files/ebooks/{id}/read` with no digital loan | `403` — needs an active loan |

Twenty requests, and you have seen the catalogue, the file pipeline, the circulation engine,
the review system, the analytics, and the five most important ways the API says no.
