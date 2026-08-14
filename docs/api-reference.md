# API Reference

Complete catalogue of every endpoint, with a mock request and response for each.

**Base URL** `http://localhost:5000/api/v1`
**Interactive docs** <http://localhost:5000/api-docs> · **Raw spec** <http://localhost:5000/api-docs.json>

**130 operations across 17 modules.**

---

## Contents

[Conventions](#conventions) · [Auth](#auth) · [Users](#users) · [Books](#books) · [Copies](#copies) ·
[Authors](#authors) · [Publishers](#publishers) · [Categories](#categories) · [Search](#search) ·
[Files](#files) · [Loans](#loans) · [Fines](#fines) · [Reviews](#reviews) ·
[Reading Lists](#reading-lists) · [Notifications](#notifications) · [AI](#ai) · [Admin](#admin) ·
[Health](#health) · [Error codes](#error-codes)

---

## Conventions

### Response envelope

Every response uses the same shape.

**Success**
```json
{
  "success": true,
  "message": "Books fetched",
  "data": [ ],
  "meta": { "page": 1, "limit": 20, "total": 137, "totalPages": 7, "hasNext": true, "hasPrev": false }
}
```

**Failure**
```json
{
  "success": false,
  "message": "No copies of this book are currently available",
  "code": "NO_COPY_AVAILABLE",
  "errors": [],
  "details": { "totalCopies": 4, "earliestExpectedReturn": "2026-09-03T18:29:59.999Z" },
  "requestId": "3f9a1c2e-7b4d-4a11-9c3e-1f2b8a6d5e04"
}
```

`message` is for people and may be reworded at any time. **`code` is the stable contract** — branch on
that, never on the message text. `requestId` also appears in the `X-Request-Id` header and in the
server logs, so any error a user reports can be traced to its exact log entry.

### Authentication

Send `Authorization: Bearer <accessToken>`. Access tokens last 15 minutes; exchange the refresh token
at `POST /auth/refresh`. Refresh tokens are **single-use and rotate on every exchange** — replaying a
rotated one revokes the entire session family.

### Roles

| Role | Can |
|---|---|
| `MEMBER` | Browse, borrow, review, manage own data |
| `LIBRARIAN` | + catalogue, circulation desk, moderation, fines |
| `ADMIN` | + user management, audit log, job triggers |

### Rate limits

| Group | Limit | Keyed by |
|---|---|---|
| Global | 300 / 15 min | IP |
| Auth | 10 / 15 min | IP (failed attempts only) |
| Search | 60 / min | IP |
| Upload | 20 / hour | user |
| **AI** | **5 / day** | user |

Staff are exempt from the AI and upload limits.

### Common parameters

`page` (default 1) · `limit` (default 20, **max 100**) · `sort` (prefix `-` for descending)

---

## Auth

### `POST /auth/register`
Create a `MEMBER` account. **`role` cannot be set here** — it is stripped from the body, so
self-promotion to staff is impossible. `STUDENT` registration requires `studentProfile.enrollmentNo`.

<details><summary>Request / response</summary>

```json
POST /api/v1/auth/register
{
  "name": "Ananya Sharma",
  "email": "ananya@student.test",
  "password": "Str0ngPass",
  "membershipType": "STUDENT",
  "studentProfile": {
    "enrollmentNo": "CS2023001",
    "department": "Computer Science",
    "course": "B.Tech",
    "year": 3
  }
}
```
```json
201 Created
{
  "success": true,
  "message": "Registration successful. Welcome to the library.",
  "data": {
    "user": {
      "id": "6a7e0aac482cc9b7814ab612",
      "name": "Ananya Sharma",
      "email": "ananya@student.test",
      "role": "MEMBER",
      "membershipType": "STUDENT",
      "membershipNumber": "LIB-2026-000004",
      "borrowingPolicy": {
        "maxActiveLoans": 5, "loanPeriodDays": 21, "maxRenewals": 2,
        "canBorrow": true, "finesBlockThreshold": 200, "currency": "INR"
      },
      "stats": { "activeLoans": 0, "totalBorrowed": 0, "outstandingFine": 0 }
    },
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1NiIs...",
      "refreshToken": "9f3c1e2a7b4d...",
      "tokenType": "Bearer", "expiresIn": "15m", "refreshExpiresIn": "7d"
    }
  }
}
```
</details>

**Errors** `409 EMAIL_ALREADY_REGISTERED` · `409 ENROLLMENT_NUMBER_TAKEN` · `422 VALIDATION_ERROR`

---

### `POST /auth/login`
An unknown email and a wrong password return the **identical** error, so this endpoint cannot be used
to discover which addresses are registered.

<details><summary>Request / response</summary>

```json
POST /api/v1/auth/login
{ "email": "admin@library.test", "password": "Password@123" }
```
```json
200 OK
{ "success": true, "message": "Signed in successfully",
  "data": { "user": { }, "tokens": { } } }
```
```json
401 Unauthorized
{ "success": false, "message": "Incorrect email or password", "code": "INVALID_CREDENTIALS" }
```
</details>

**Errors** `401 INVALID_CREDENTIALS` · `403 ACCOUNT_SUSPENDED` · `429`

---

### `POST /auth/refresh`
Exchange a refresh token for a new pair. **The old token is revoked.** Replaying a rotated token is
treated as theft and revokes the whole session family.

<details><summary>Request / response</summary>

```json
POST /api/v1/auth/refresh
{ "refreshToken": "9f3c1e2a7b4d..." }
```
```json
200 OK   → a NEW accessToken and a NEW refreshToken
```
```json
401 Unauthorized
{ "success": false,
  "message": "This session has been terminated for security reasons. Please sign in again.",
  "code": "REFRESH_TOKEN_REUSED" }
```
</details>

---

### Remaining auth endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /auth/logout` | — | Revoke the supplied refresh token. Idempotent. |
| `POST /auth/logout-all` | Member | Revoke every session. |
| `GET /auth/sessions` | Member | Active sessions, with IP and user agent; the current one is flagged `isCurrent`. |
| `DELETE /auth/sessions/{sessionId}` | Member | Sign out one device. |
| `POST /auth/forgot-password` | — | Email a reset link. **Always returns 200**, whether or not the account exists. In development the URL is also returned as `devResetUrl`. |
| `POST /auth/reset-password` | — | Consume the token, set a new password, revoke all sessions. |
| `POST /auth/change-password` | Member | Requires the current password. Revokes all other sessions. |
| `GET /auth/me` | Member | The current user. |

<details><summary>Forgot / reset password</summary>

```json
POST /api/v1/auth/forgot-password
{ "email": "ananya@student.test" }
```
```json
200 OK
{ "success": true,
  "message": "If an account exists for that email address, a password reset link has been sent to it.",
  "data": {
    "message": "If an account exists...",
    "devResetUrl": "http://localhost:5000/reset-password?token=a1b2c3...",
    "devToken": "a1b2c3..."
  } }
```
```json
POST /api/v1/auth/reset-password
{ "token": "a1b2c3...", "password": "NewStr0ngPass", "confirmPassword": "NewStr0ngPass" }
```
```json
400 Bad Request   (on a second use — the token is single-use)
{ "success": false,
  "message": "This password reset link is invalid or has expired. Please request a new one.",
  "code": "RESET_TOKEN_INVALID" }
```
</details>

---

## Users

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /users/me` | Member | Own profile. |
| `PATCH /users/me` | Member | Update name, phone, address, language, academic details. `email`, `role`, `status` are stripped. |
| `PATCH /users/me/notification-preferences` | Member | Partial update — only the types you send change. |
| `DELETE /users/me` | Member | Close account (soft delete). Refused with loans or fines outstanding. |
| `GET /users` | Staff | Search and filter members. |
| `POST /users/staff` | Admin | **The only way to create a LIBRARIAN or ADMIN.** |
| `GET /users/{userId}` | Owner / Staff | Accepts `me`. Response shape depends on who is asking. |
| `PATCH /users/{userId}/role` | Admin | Revokes all that member's sessions. |
| `PATCH /users/{userId}/membership` | Staff | Changes borrowing entitlements. |
| `POST /users/{userId}/suspend` | Staff | **Reason required.** Revokes sessions immediately. |
| `POST /users/{userId}/reactivate` | Staff | Lift a suspension. |
| `POST /users/{userId}/verify-student` | Staff | Mark academic details checked. |
| `DELETE /users/{userId}/sessions` | Admin | Force sign-out everywhere. |

<details><summary>List, update, suspend</summary>

```
GET /api/v1/users?membershipType=STUDENT&hasOutstandingFines=true&sort=-stats.outstandingFine
```
```json
200 OK
{ "success": true, "message": "Members fetched",
  "data": [ { "id": "...", "name": "Rohan Gupta", "membershipNumber": "LIB-2026-000005",
              "membershipType": "STUDENT",
              "stats": { "activeLoans": 2, "outstandingFine": 65 },
              "suspension": null } ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 } }
```
```json
PATCH /api/v1/users/me
{ "name": "Ananya Sharma-Rao", "phone": "+91 90000 10001" }
```
```json
POST /api/v1/users/{userId}/suspend
{ "reason": "Three items reported lost and unpaid" }
```
```json
409 Conflict   (demoting the last admin)
{ "success": false,
  "message": "This is the only administrator account. Promote another before demoting it.",
  "code": "LAST_ADMIN_PROTECTED" }
```
</details>

**Errors** `403 NOT_RESOURCE_OWNER` · `403 INSUFFICIENT_ROLE` · `409 LAST_ADMIN_PROTECTED`

---

## Books

Reading is **public**. Writing requires staff. `{bookId}` accepts an **ID or a slug**.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /books` | — | Plain catalogue listing. |
| `POST /books` | Staff | Catalogue a title. Optionally creates copies. |
| `GET /books/{bookId}` | — | Full detail. |
| `PATCH /books/{bookId}` | Staff | Update. |
| `DELETE /books/{bookId}` | Staff | Soft delete. Refused while copies are on loan. |
| `POST /books/{bookId}/restore` | Staff | Restore. |
| `GET /books/{bookId}/similar` | — | Shared authors and categories. A database heuristic, **not an AI call**. |
| `GET /books/feeds/{feed}` | — | `new-arrivals` · `most-borrowed` · `top-rated` · `trending` · `available` |

<details><summary>Create a book</summary>

```json
POST /api/v1/books
Authorization: Bearer <librarian>
{
  "title": "Things Fall Apart",
  "isbn13": "9780385474542",
  "authors": ["6a7e0aac482cc9b7814ab620"],
  "publisher": "6a7e0aac482cc9b7814ab640",
  "categories": ["6a7e0aac482cc9b7814ab650"],
  "publishedYear": 1958,
  "pageCount": 209,
  "price": 399,
  "tags": ["classic", "africa"],
  "description": "Okonkwo is a wealthy and respected warrior of the Umuofia clan...",
  "copies": 4
}
```
```json
201 Created
{ "success": true, "message": "Book catalogued with 4 copies",
  "data": {
    "id": "6a7e0aac482cc9b7814ab700",
    "title": "Things Fall Apart",
    "slug": "things-fall-apart",
    "isbn": { "isbn10": "0385474547", "isbn13": "9780385474542" },
    "authors": [ { "id": "...", "name": "Chinua Achebe", "slug": "chinua-achebe" } ],
    "availability": {
      "physical": { "total": 4, "available": 4, "isAvailable": true },
      "digital":  { "hasEbook": false, "licenses": 0, "available": 0, "isAvailable": false },
      "canBorrowNow": true
    },
    "rating": { "average": 0, "count": 0, "distribution": { "1":0,"2":0,"3":0,"4":0,"5":0 } }
  } }
```
</details>

<details><summary>ISBN validation — the check digit is verified</summary>

```json
POST /api/v1/books
{ "title": "Bad ISBN", "isbn13": "9780385474543" }
```
```json
422 Unprocessable Entity
{ "success": false, "message": "Validation failed for 1 field", "code": "VALIDATION_ERROR",
  "errors": [ { "field": "isbn13",
    "message": "Not a valid ISBN — the check digit does not match, which usually means a mistyped or transposed digit" } ] }
```

An **ISBN-10 is converted to ISBN-13 automatically**, and both are stored, so a search on either
format finds the book.
</details>

**Errors** `404 BOOK_NOT_FOUND` · `409 ISBN_ALREADY_EXISTS` · `409 COPY_ON_LOAN` · `422` unknown author/category IDs

---

## Copies

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /books/{bookId}/copies` | Member | Members see shelf location and status; **staff additionally see who holds each copy**. |
| `POST /books/{bookId}/copies` | Staff | Add copies. Accession numbers generated as `ACC-YYYY-NNNNNN`. |
| `PATCH /books/copies/{copyId}` | Staff | Mark `DAMAGED` / `LOST` / `WITHDRAWN`. Refused while `ON_LOAN`. |
| `DELETE /books/copies/{copyId}` | Staff | Hard delete — **only for a copy never borrowed**. |

<details><summary>Add and update copies</summary>

```json
POST /api/v1/books/{bookId}/copies
{ "count": 3, "shelfLocation": "A-12-3", "condition": "NEW", "cost": 399 }
```
```json
201 Created
{ "success": true, "message": "3 copies added",
  "data": { "copies": [ { "id": "...", "accessionNumber": "ACC-2026-000043",
                          "shelfLocation": "A-12-3", "status": "AVAILABLE", "condition": "NEW" } ],
            "inventory": { "totalCopies": 3, "availableCopies": 3 } } }
```
```json
PATCH /api/v1/books/copies/{copyId}
{ "status": "DAMAGED", "condition": "POOR", "note": "Water damage to the spine" }
```
```json
200 OK
{ "data": { "copy": { "status": "DAMAGED" },
            "inventory": { "totalCopies": 3, "availableCopies": 2 } } }
```
Note that `totalCopies` stays at 3 — a damaged copy is still owned.
</details>

---

## Authors

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /authors` | — | List. `?search=` matches partial names. |
| `POST /authors` | Staff | Create. A slug is generated. |
| `GET /authors/{identifier}` | — | ID or slug. |
| `PATCH /authors/{identifier}` | Staff | Update. |
| `DELETE /authors/{identifier}` | Staff | **Refused while books reference it.** |
| `GET /authors/{identifier}/books` | — | Their books. |
| `POST /authors/{identifier}/merge` | Staff | Fold a duplicate into this one. |

<details><summary>Merge duplicates, and the delete guard</summary>

Catalogues accumulate duplicates — "J.R.R. Tolkien" and "J. R. R. Tolkien" arrive from different
import sources.

```json
POST /api/v1/authors/chinua-achebe/merge
{ "source": "achebe-chinua" }
```
```json
200 OK
{ "success": true, "message": "Merged into \"Chinua Achebe\" — 3 book(s) reassigned",
  "data": { "author": { "id": "...", "name": "Chinua Achebe", "bookCount": 5 },
            "booksReassigned": 3 } }
```
```json
409 Conflict   (deleting an author who still has books)
{ "success": false,
  "message": "Cannot delete this author: 3 books still reference it. Reassign or remove those books first.",
  "code": "AUTHOR_HAS_BOOKS",
  "details": { "bookCount": 3 } }
```
</details>

---

## Publishers

Identical surface to Authors: `GET`/`POST /publishers`, `GET`/`PATCH`/`DELETE /publishers/{identifier}`,
`GET /publishers/{identifier}/books`, `POST /publishers/{identifier}/merge`.

<details><summary>Create</summary>

```json
POST /api/v1/publishers
{ "name": "Penguin Books", "foundedYear": 1935, "website": "https://www.penguin.co.uk",
  "address": { "city": "London", "country": "United Kingdom" } }
```
```json
201 Created
{ "data": { "id": "...", "name": "Penguin Books", "slug": "penguin-books", "bookCount": 0 } }
```
</details>

---

## Categories

Hierarchical, with a materialised ancestor path — so a subtree is **one indexed query at any depth**.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /categories/tree` | — | The whole tree, nested. |
| `GET /categories` | — | Flat list. `?parent=root` for top level. |
| `POST /categories` | Staff | Create. Omit `parent` for top level. |
| `GET /categories/{identifier}` | — | One category, with its ancestor path. |
| `PATCH /categories/{identifier}` | Staff | Update, or **move** by changing `parent`. |
| `DELETE /categories/{identifier}` | Staff | Refused with subcategories or books. |
| `GET /categories/{identifier}/books` | — | **Includes descendants by default.** |
| `GET /categories/{identifier}/children` | — | Immediate children. |
| `GET /categories/{identifier}/breadcrumb` | — | Root-first trail. |

<details><summary>Subtree browsing and cycle detection</summary>

```
GET /api/v1/categories/science/books
```
```json
200 OK
{ "data": [ ],
  "meta": { "total": 5, "includedCategories": 7,
            "category": { "name": "Science", "slug": "science", "depth": 0 } } }
```
Browsing "Science" surfaces a machine-learning textbook filed three levels down.
`?includeDescendants=false` narrows to an exact tag match.

```
GET /api/v1/categories/algorithms/breadcrumb
→ [ "Science", "Computer Science", "Algorithms" ]
```
```json
PATCH /api/v1/categories/{scienceId}
{ "parent": "{computerScienceId}" }
```
```json
400 Bad Request
{ "success": false,
  "message": "That parent is a descendant of this category — the change would create a cycle in the tree",
  "code": "CATEGORY_CYCLE_DETECTED" }
```
</details>

---

## Search

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /search` | — | Weighted full-text search with filters. |
| `GET /search/facets` | — | Counts per filter value, in one aggregation pass. |
| `GET /search/suggest` | — | Type-ahead. Minimum 2 characters. |

**Ranking** title ×10 · subtitle ×5 · tags ×3 · description ×1

**Filters** `q` `category` `includeSubcategories` `author` `publisher` `language` `yearFrom` `yearTo`
`minRating` `available` `format` `tags` `sort`

**Sort** `relevance` (default) · `title` · `-title` · `newest` · `oldest` · `rating` · `popular` · `recent`

<details><summary>Search, the fuzzy fallback, and facets</summary>

```
GET /api/v1/search?q=algorithms&available=true&sort=relevance
```
```json
200 OK
{ "data": [ { "id": "...", "title": "Introduction to Algorithms",
              "authors": [ { "name": "Thomas H. Cormen" } ],
              "relevanceScore": 1.83,
              "availability": { "physical": { "available": 6 }, "canBorrowNow": true } } ],
  "meta": { "page": 1, "total": 2, "searchTerm": "algorithms", "exactMatch": true } }
```

**The fuzzy fallback.** MongoDB's text index matches whole stemmed words, so `?q=algo` would find
nothing. When text search returns zero results the query is retried as a substring match:

```
GET /api/v1/search?q=algo
```
```json
{ "meta": { "total": 2, "exactMatch": false,
            "note": "No exact matches were found, so these are the closest titles." } }
```

`exactMatch: false` lets a client label the results honestly rather than presenting weaker matches as
exact hits.

```
GET /api/v1/search/facets?q=science
```
```json
{ "data": {
    "categories": [ { "name": "Computer Science", "slug": "computer-science", "count": 4 } ],
    "authors":    [ { "name": "Thomas H. Cormen", "count": 1 } ],
    "languages":  [ { "language": "en", "count": 6 } ],
    "decades":    [ { "decade": 2020, "count": 2 }, { "decade": 1990, "count": 1 } ],
    "availability": { "available": 5, "unavailable": 1, "digital": 0 },
    "total": 6 } }
```
</details>

**Errors** `422` reversed year range · `429` rate limit

---

## Files

Covers and avatars are served **statically**. **Ebooks are not** — every read verifies an active
digital loan and streams the bytes.

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /files/books/{bookId}/cover` | Staff | Upload a cover. JPEG/PNG/WebP. |
| `POST /files/books/{bookId}/ebook` | Staff | Upload PDF/EPUB. Deduplicated by SHA-256. |
| `POST /files/avatar` | Member | Own profile picture. |
| `GET /files/books/{bookId}/assets` | Member | List ebook files, with extraction status. |
| `DELETE /files/ebooks/{assetId}` | Staff | Remove. The file survives if another record shares it. |
| `POST /files/ebooks/{assetId}/extract` | Staff | Re-run text extraction. |
| `GET /files/ebooks/{assetId}/read` | Loan required | **Stream with HTTP Range support.** |
| `POST /files/ebooks/{assetId}/download-link` | Loan required | Mint a short-lived signed URL. |
| `GET /files/ebooks/{assetId}/download` | Signed token | Download without an Authorization header. |

<details><summary>Upload, and magic-number verification</summary>

```
POST /api/v1/files/books/{bookId}/ebook
Content-Type: multipart/form-data
  ebook: <sample.pdf>
  isPreview: false
```
```json
201 Created
{ "success": true, "message": "Ebook uploaded",
  "data": {
    "asset": { "id": "...", "format": "PDF", "originalName": "sample.pdf",
               "sizeBytes": 618, "sizeFormatted": "0.6 KB",
               "extraction": { "status": "PENDING", "characters": 0, "error": null } },
    "book": { "digital": { "hasEbook": true, "concurrentLicenses": 3, "activeLicenses": 0 } },
    "note": "Text extraction is running in the background and will improve AI summaries for this book."
  } }
```

**The declared MIME type is not trusted.** The file's magic number is checked against it, so an
executable renamed to `.png` is rejected:

```json
415 Unsupported Media Type
{ "success": false,
  "message": "This file's contents do not match its declared type (image/png). It may be corrupted, or renamed from another format.",
  "code": "FILE_SIGNATURE_MISMATCH" }
```
</details>

<details><summary>Reading an ebook, with range requests</summary>

```
GET /api/v1/files/ebooks/{assetId}/read
Authorization: Bearer <member>
Range: bytes=0-99
```
```
206 Partial Content
Content-Type:   application/pdf
Content-Range:  bytes 0-99/618
Content-Length: 100
Accept-Ranges:  bytes
Cache-Control:  private, no-store
X-Access-Reason: loan
<binary>
```

Supported forms: `bytes=0-1023` · `bytes=1024-` (open-ended) · `bytes=-500` (suffix — used by PDF
readers to fetch the trailer first).

```json
403 Forbidden   (no active digital loan)
{ "success": false,
  "message": "You need an active digital loan for this book in order to read it",
  "code": "NO_READ_ACCESS" }
```
```
416 Range Not Satisfiable
Content-Range: bytes */618
```
</details>

<details><summary>Signed download links</summary>

For contexts that cannot send an Authorization header — an `<a download>` link, or a native PDF
viewer. The token is scoped to **one asset** and expires in minutes.

```json
POST /api/v1/files/ebooks/{assetId}/download-link
```
```json
200 OK
{ "data": { "token": "eyJhbGciOiJIUzI1NiIs...",
            "url": "http://localhost:5000/api/v1/files/ebooks/{assetId}/download?token=eyJ...",
            "expiresIn": "5m" } }
```
Presenting that token for a **different** asset returns `403 INVALID_DOWNLOAD_TOKEN`.
</details>

---

## Loans

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /loans/me` | Member | Own loans, with server-computed `daysRemaining` / `daysOverdue`. |
| `GET /loans/eligibility?bookId=` | Member | **Can I borrow, and if not why?** Returns 200 either way. |
| `POST /loans` | Member | Borrow. |
| `GET /loans` | Staff | All loans. `?overdue=true` for the desk view. |
| `POST /loans/issue` | Staff | Issue on a member's behalf. |
| `GET /loans/{loanId}` | Owner / Staff | One loan. |
| `POST /loans/{loanId}/return` | Owner / Staff | Return; assesses any fine. |
| `POST /loans/{loanId}/renew` | Owner / Staff | Fresh full period from today. |
| `POST /loans/{loanId}/lost` | Staff | Mark lost; charges replacement cost. |

<details><summary>Borrowing</summary>

```json
POST /api/v1/loans
{ "bookId": "6a7e0aac482cc9b7814ab700", "type": "PHYSICAL" }
```
```json
201 Created
{ "success": true, "message": "Borrowed. Please return it by Wed Sep 03 2026.",
  "data": {
    "loan": { "id": "...", "type": "PHYSICAL", "status": "ACTIVE",
              "issuedAt": "2026-08-13T18:22:00.000Z",
              "dueAt": "2026-09-03T18:29:59.999Z",
              "daysRemaining": 21, "daysOverdue": 0, "isOverdue": false,
              "renewals": { "count": 0, "history": [] } },
    "copy": { "accessionNumber": "ACC-2026-000043", "shelfLocation": "A-12-3" },
    "loanPeriodDays": 21, "renewalsAllowed": 2,
    "availability": { "remainingCopies": 3 } } }
```

`daysRemaining` and `daysOverdue` are **computed server-side**. Date arithmetic on a client uses the
device's clock, so a phone set a day fast would show a book as overdue when the library does not
agree — and the server is what charges the fine.
</details>

<details><summary>Refusals, each with a specific code</summary>

```json
409 { "code": "NO_COPY_AVAILABLE",
      "message": "Every copy of this book is currently on loan",
      "details": { "totalCopies": 4, "earliestExpectedReturn": "2026-09-03T18:29:59.999Z" } }

409 { "code": "LOAN_LIMIT_REACHED",
      "message": "You already have 3 items on loan, which is the limit for PUBLIC membership...",
      "details": { "currentLoans": 3, "maxLoans": 3 } }

409 { "code": "HAS_OVERDUE_ITEMS",
      "message": "You have an overdue item. Please return it before borrowing anything else." }

409 { "code": "OUTSTANDING_FINES",
      "message": "You owe INR 250.00 in fines, which is over the INR 200 limit...",
      "details": { "outstanding": 250, "threshold": 200, "currency": "INR" } }

409 { "code": "ALREADY_BORROWED", "message": "You already have this book on loan" }

409 { "code": "COPY_CLAIM_FAILED",
      "message": "Someone else borrowed the last copy a moment ago. Please try again." }
```

The last one is the concurrency path: the copy claim is a single atomic compare-and-swap, so of twenty
simultaneous borrows of one copy **exactly one succeeds** and the rest are told honestly.
</details>

<details><summary>Eligibility check — 200 either way</summary>

```
GET /api/v1/loans/eligibility?bookId=6a7e0aac482cc9b7814ab700
```
```json
200 OK   (eligible)
{ "data": { "eligible": true, "currentLoans": 1, "maxLoans": 5, "outstandingFines": 0 } }
```
```json
200 OK   (not eligible — still a 200, because this is the ANSWER, not an error)
{ "data": { "eligible": false,
            "reason": "You have an overdue item. Please return it before borrowing anything else.",
            "code": "HAS_OVERDUE_ITEMS" } }
```
This exists so a client can disable a Borrow button with an accurate explanation rather than letting
the member click it and receive an error.
</details>

<details><summary>Return, renew, lost</summary>

```json
POST /api/v1/loans/{loanId}/return
{ "condition": "FAIR" }
```
```json
200 OK
{ "success": true,
  "message": "Returned 5 day(s) late. A fine of INR 15.00 has been added to the account.",
  "data": { "loan": { "status": "RETURNED", "daysOverdue": 5 },
            "fine": { "id": "...", "amount": 15, "currency": "INR", "reason": "OVERDUE",
                      "calculation": { "daysOverdue": 5, "graceDays": 2,
                                       "chargeableDays": 3, "ratePerDay": 5,
                                       "cappedAtMaximum": false } },
            "daysOverdue": 5 } }
```
```json
409 { "code": "CANNOT_RENEW_OVERDUE",
      "message": "This item is already 5 day(s) overdue and cannot be renewed. Please return it and settle any fine.",
      "details": { "daysOverdue": 5, "dueAt": "..." } }

409 { "code": "RENEWAL_LIMIT_REACHED",
      "details": { "renewalCount": 2, "maxRenewals": 2 } }

409 { "code": "LOAN_NOT_ACTIVE", "message": "This loan is already returned" }
```
</details>

---

## Fines

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /fines/me` | Member | Own fines, with a `summary` block. |
| `GET /fines/summary` | Staff | Collection totals and top debtors. |
| `GET /fines` | Staff | All fines. |
| `POST /fines` | Staff | Raise a charge by hand. |
| `GET /fines/{fineId}` | Owner / Staff | One fine. |
| `POST /fines/{fineId}/pay` | Staff | Record payment taken at the desk. |
| `POST /fines/{fineId}/waive` | Staff | **A written reason is required.** |

<details><summary>Own fines — the arithmetic is shown</summary>

```
GET /api/v1/fines/me
```
```json
200 OK
{ "data": [ { "id": "...", "reason": "OVERDUE", "amount": 15, "currency": "INR", "status": "PENDING",
              "calculation": { "daysOverdue": 5, "graceDays": 2, "chargeableDays": 3,
                               "ratePerDay": 5, "cappedAtMaximum": false },
              "book": { "title": "Things Fall Apart" } } ],
  "meta": { "total": 2,
            "summary": { "outstanding": 65, "outstandingCount": 2, "currency": "INR",
                         "blockThreshold": 200, "isBlocked": false } } }
```
A fine nobody can explain is a fine nobody can defend — `calculation` shows the working:
5 days late, 2 forgiven as grace, 3 × ₹5 = ₹15.
</details>

<details><summary>Pay and waive</summary>

```json
POST /api/v1/fines/{fineId}/pay
{ "paymentMethod": "CASH", "paymentReference": "RCPT-2026-0912" }
```
```json
200 OK  → { "data": { "status": "PAID", "settlement": { "paidAt": "...", "method": "CASH" } } }
```
```json
POST /api/v1/fines/{fineId}/waive
{ "note": "Book was returned to the drop-box on time; the box was not emptied." }
```
```json
422 Unprocessable Entity   (no reason given)
{ "errors": [ { "field": "note",
    "message": "Please give a reason of at least 5 characters for waiving this fine" } ] }
```
A waiver writes off money the library was owed. Without a recorded reason it cannot be told apart from
a mistake or a favour.
</details>

---

## Reviews

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /reviews/books/{bookId}` | — | Book's reviews. `?verifiedOnly=true`. |
| `POST /reviews/books/{bookId}` | Member | **One review per member per book.** |
| `GET /reviews/me` | Member | Own reviews. |
| `GET /reviews/moderation-queue` | Staff | Reported and flagged reviews. |
| `GET /reviews/{reviewId}` | — | One review. |
| `PATCH /reviews/{reviewId}` | Owner | Edit. |
| `DELETE /reviews/{reviewId}` | Owner / Staff | Delete. |
| `POST /reviews/{reviewId}/helpful` | Member | **Toggle**, not increment. |
| `POST /reviews/{reviewId}/report` | Member | Idempotent. Auto-holds after 3 distinct reporters. |
| `POST /reviews/{reviewId}/moderate` | Staff | Approve or reject. |

<details><summary>Write a review</summary>

```json
POST /api/v1/reviews/books/{bookId}
{ "rating": 5, "title": "Excellent", "body": "One of the best books I have read this year." }
```
```json
201 Created
{ "data": { "id": "...", "rating": 5, "title": "Excellent",
            "isVerifiedBorrower": true,
            "author": { "id": "...", "name": "Ananya Sharma" },
            "helpfulCount": 0, "viewerFoundHelpful": false, "isOwn": true } }
```
`isVerifiedBorrower` is set from the **Loan collection** — it separates people who read the book from
people with an opinion about its cover.
</details>

<details><summary>Moderation — heuristic first</summary>

A cheap keyword and pattern filter runs on every review; the AI model is consulted **only** when that
filter is inconclusive. With a 100-call lifetime AI budget, moderating every review with the model
would exhaust it in a day.

```json
POST /api/v1/reviews/books/{bookId}
{ "rating": 5, "body": "Buy now at http://cheap-books.xyz — free download! WhatsApp 9876543210" }
```
```json
400 Bad Request
{ "success": false,
  "message": "This review could not be published: Contains a web link; Contains contact details; Contains promotional language.",
  "code": "REVIEW_BLOCKED_BY_MODERATION",
  "details": { "reasons": ["Contains a web link", "Contains contact details", "Contains promotional language"] } }
```
**A negative review is not abuse.** The moderation prompt explicitly protects criticism — a one-star
review is legitimate and is never blocked for being harsh.
</details>

**Errors** `409 REVIEW_ALREADY_EXISTS` · `400 CANNOT_VOTE_OWN_REVIEW` · `400 REVIEW_BLOCKED_BY_MODERATION`

---

## Reading Lists

Four default shelves — **Favorites, Want to Read, Currently Reading, Finished** — are created
automatically and cannot be renamed or deleted, so a client can rely on them existing.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /reading-lists` | Member | All own lists, with books. |
| `POST /reading-lists` | Member | Create a custom list. |
| `POST /reading-lists/favourites/toggle` | Member | **What a heart button calls.** |
| `GET /reading-lists/shared/{slug}` | — | A public list, by unguessable slug. |
| `GET /reading-lists/{listId}` | Owner / public | One list. |
| `PATCH /reading-lists/{listId}` | Owner | Rename, describe, share. |
| `DELETE /reading-lists/{listId}` | Owner | Custom lists only. |
| `POST /reading-lists/{listId}/books` | Owner | Add a book, with an optional note. |
| `DELETE /reading-lists/{listId}/books/{bookId}` | Owner | Remove. |

<details><summary>Toggle a favourite, and sharing</summary>

```json
POST /api/v1/reading-lists/favourites/toggle
{ "bookId": "6a7e0aac482cc9b7814ab700" }
```
```json
200 OK  → { "message": "Added to favourites", "data": { "favourited": true } }
```
One request instead of "check whether it is there, then add or remove" — which would be two
round-trips and a race between them.

```json
PATCH /api/v1/reading-lists/{listId}
{ "isPublic": true }
```
```json
200 OK
{ "data": { "isPublic": true, "shareUrl": "/lists/shared/3f9a1c2e7b4d4a119c3e" } }
```
Setting `isPublic: false` clears the slug, so **the old link stops working**.
The slug is random rather than derived from the name, so private lists cannot be found by guessing.

```json
400 { "code": "CANNOT_MODIFY_DEFAULT_LIST", "message": "The default shelves cannot be renamed" }
409 { "code": "BOOK_ALREADY_IN_LIST", "message": "\"Cosmos\" is already in this list" }
```
</details>

---

## Notifications

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /notifications` | Member | The notification centre. |
| `GET /notifications/unread-count` | Member | Badge count. Its own endpoint, because clients poll it. |
| `POST /notifications/read` | Member | Mark specific, or all. |
| `DELETE /notifications/{notificationId}` | Member | Delete one. |

<details><summary>List and mark read</summary>

```
GET /api/v1/notifications?unread=true
```
```json
200 OK
{ "data": [ { "id": "...", "type": "OVERDUE",
              "title": "You have an overdue item",
              "body": "\"Things Fall Apart\" was due on Fri Aug 08 2026.",
              "data": { "loanId": "...", "bookId": "..." },
              "isRead": false, "channels": ["IN_APP", "EMAIL"],
              "createdAt": "2026-08-13T18:22:00.000Z" } ],
  "meta": { "total": 3, "unreadCount": 3 } }
```
`data` carries the ids so a client can render an actionable notification — a "Renew" button rather
than a dead-end line of text.

```json
POST /api/v1/notifications/read
{ }                                    // empty body = mark ALL read
```
```json
200 OK  → { "message": "3 notification(s) marked read", "data": { "marked": 3, "unreadCount": 0 } }
```
</details>

---

## AI

Every generation endpoint carries the **5/member/day** limiter, keyed by user. Staff are exempt.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /ai/books/{bookId}/summary` | — | Summary. `?length=SHORT\|MEDIUM\|LONG` |
| `GET /ai/books/{bookId}/takeaways` | — | 5–7 bullet points. |
| `GET /ai/books/{bookId}/simplified` | — | Explained as to a 15-year-old. |
| `POST /ai/books/{bookId}/ask` | Member | Question answering, grounded in the source. |
| `GET /ai/recommendations` | Member | Personalised. `?explain=true` spends a call. |
| `POST /ai/books/{bookId}/suggest-metadata` | Staff | Categories, tags, reading level. |
| `GET /ai/status` | Staff | Quota, mode, cache and usage statistics. |
| `POST /ai/sync-usage` | Admin | Reconcile with the provider. |
| `POST /ai/upgrade-mocks` | Admin | Regenerate mock entries with real output. Bounded. |

### How every AI response resolves

```
1. CACHE  → already generated? Return it.        cost: 0 calls
2. LIVE   → token + budget + under daily cap?    cost: 1 of 100 (lifetime)
3. MOCK   → deterministic offline content.       cost: 0 calls
```

Every response reports `source` and `aiGenerated`. **Mock content is never presented as model output.**

<details><summary>Summary — live, cached and mock</summary>

```
GET /api/v1/ai/books/{bookId}/summary?length=MEDIUM
```
```json
200 OK   — MOCK (no usable token)
{ "success": true, "message": "Summary generated",
  "data": {
    "content": "Things Fall Apart was written by Chinua Achebe. Okonkwo is a wealthy and respected warrior of the Umuofia clan, a lower Nigerian tribe that is part of a consortium of nine connected villages.\n\nFirst published in 1958, it continues to be borrowed regularly, and is frequently recommended to readers approaching the subject for the first time.",
    "source": "mock",
    "aiGenerated": false,
    "cached": false,
    "model": "mock",
    "isMock": true,
    "notice": "Generated offline because the AI service is unavailable. This is not model-generated content.",
    "book": { "id": "...", "title": "Things Fall Apart", "slug": "things-fall-apart" },
    "length": "MEDIUM",
    "basedOn": "the catalogue record"
  } }
```
```json
200 OK   — LIVE
{ "data": { "content": "...", "source": "live", "aiGenerated": true, "cached": false,
            "model": "gpt-4o-mini", "tokensUsed": 412,
            "basedOn": "the book text" } }
```
```json
200 OK   — CACHE (the same request, second time)
{ "message": "Summary (from cache)",
  "data": { "content": "...(identical)...", "source": "cache", "cached": true } }
```

Measured: **70 ms cached vs 1052 ms first**. Mock content is built from the book's **own** title,
authors and description — not filler — and is deterministic, so the same book always produces the
same text.
</details>

<details><summary>Takeaways, simplified, and Q&A</summary>

```
GET /api/v1/ai/books/{bookId}/takeaways
```
```json
{ "data": { "content": [
    "Chinua Achebe approaches the subject through narrative rather than assertion.",
    "Sits firmly within Literary Fiction, and assumes no prior specialist reading.",
    "Published in 1958; some references have dated, but the central concerns have not.",
    "The middle section is where the substance lies; the opening is largely scene-setting.",
    "Manageable in a single loan period without difficulty."
  ], "source": "mock", "aiGenerated": false } }
```
```json
POST /api/v1/ai/books/{bookId}/ask
{ "question": "Who wrote this book?" }
```
```json
200 OK
{ "data": { "content": { "answer": "Things Fall Apart was written by Chinua Achebe.",
                         "answeredFromSource": true },
            "source": "mock", "question": "Who wrote this book?" } }
```

`answeredFromSource: false` means the model **could not answer from the material** — not that it
invented something. The prompt explicitly forbids guessing: a library publishing fabricated plot
details would be worse than one publishing none.

Answers are cached against a **normalised** question, so "What is the main theme?" and
"what is the main theme" are one question and cost one call between them.
</details>

<details><summary>Recommendations — selection is free</summary>

```
GET /api/v1/ai/recommendations?limit=5
```
```json
200 OK
{ "message": "Recommended for you",
  "data": {
    "recommendations": [
      { "book": { "title": "The Art of Computer Programming, Volume 1" },
        "reason": "Suggested because you borrowed Introduction to Algorithms, and this sits in the same Algorithms area.",
        "score": 6.5, "sharedAuthors": 0, "sharedCategories": 1 } ],
    "basedOn": ["Introduction to Algorithms", "Clean Code"],
    "personalised": true,
    "source": "heuristic"
  } }
```

**Selection is a database query, not an AI call** — instant, free, and available on every request.
`?explain=true` spends one call to write the rationales; `source` then reads `ai-explained`.
A member with no history gets popular titles and `personalised: false`.
</details>

<details><summary>Status and quota</summary>

```
GET /api/v1/ai/status
Authorization: Bearer <librarian>
```
```json
200 OK
{ "data": {
    "mode": "mock",
    "reason": "The AI provider rejected our token: The AI service rejected our credentials — serving mock content",
    "hasToken": true,
    "tokenRejected": true,
    "quota": { "total": 100, "used": 0, "remaining": 0, "reserved": 10, "countedFrom": "local" },
    "perUserDailyLimit": 5,
    "circuitBreaker": "closed",
    "cache": { "entries": 12, "mockEntries": 12, "realEntries": 0 },
    "statistics": {
      "totalRequests": 31, "liveCalls": 0, "cacheHits": 19, "mockResponses": 12,
      "savedByCache": 31, "cacheHitRate": 100,
      "averageLiveLatencyMs": 0, "averageCacheLatencyMs": 3,
      "byFeature": [ { "feature": "SUMMARY", "count": 21 } ]
    } } }
```
`savedByCache` is the number that matters — requests served without spending from the budget.
</details>

**Errors** `429 AI_USER_LIMIT_REACHED` · `429 AI_QUOTA_EXHAUSTED` · `501 AI_FEATURE_DISABLED` ·
`503 AI_UNAVAILABLE` · `400 AI_INSUFFICIENT_CONTEXT`

---

## Admin

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /admin/dashboard` | Staff | Every headline figure, one aggregation pass. |
| `GET /admin/reports/popular` | Staff | Most-borrowed titles. |
| `GET /admin/reports/unborrowed` | Staff | Stock that has never moved. |
| `GET /admin/reports/active-members` | Staff | Members ranked by activity. |
| `GET /admin/reports/inventory-health` | Staff | Copy condition, most-worn items. |
| `GET /admin/audit-log` | Admin | Every privileged mutation, with diffs. |
| `POST /admin/books/import` | Staff | CSV bulk import. **Supports `?dryRun=true`.** |
| `GET /admin/books/export` | Staff | CSV export, in the importer's shape. |
| `POST /admin/jobs/{job}/run` | Admin | Trigger a scheduled job now. |

<details><summary>Dashboard</summary>

```
GET /api/v1/admin/dashboard?days=30
```
```json
200 OK
{ "data": {
    "periodDays": 30,
    "collection": { "titles": 15, "copies": 42, "availableCopies": 33,
                    "titlesWithEbook": 1, "utilisationPercent": 21,
                    "byStatus": { "ACTIVE": 15 },
                    "topLanguages": [ { "language": "en", "count": 15 } ] },
    "circulation": { "openLoans": 9, "overdueLoans": 3, "overdueRatePercent": 33,
                     "issuedInPeriod": 7, "returnedInPeriod": 1,
                     "averageLoanDurationDays": 17.3,
                     "byType": { "PHYSICAL": 12 },
                     "trend": [ { "date": "2026-08-11", "count": 2 } ] },
    "members": { "total": 11, "byMembershipType": { "STUDENT": 4, "PUBLIC": 4, "FACULTY": 3 },
                 "byRole": { "MEMBER": 8, "LIBRARIAN": 2, "ADMIN": 1 },
                 "newInPeriod": 11, "activeInPeriod": 6 },
    "finances": { "currency": "INR", "outstanding": 255, "outstandingCount": 3,
                  "collectedAllTime": 0, "waived": 0,
                  "byReason": [ { "reason": "OVERDUE", "total": 255, "count": 3 } ] },
    "engagement": { "reviews": 45, "averageRating": 4.31,
                    "verifiedReviews": 12, "pendingModeration": 0 } } }
```
</details>

<details><summary>CSV import — dry run first</summary>

Columns: `title` (required), `subtitle`, `isbn13`, `authors`, `publisher`, `categories`, `language`,
`publishedYear`, `pageCount`, `description`, `price`, `tags`, `copies`, `shelfLocation`.
Multiple authors or categories in one cell, separated by `;` or `|`.

```
POST /api/v1/admin/books/import?dryRun=true
Content-Type: multipart/form-data
  file: <catalogue.csv>
```
```json
200 OK
{ "success": true,
  "message": "Dry run: 118 row(s) would be imported, 2 skipped",
  "data": {
    "total": 120, "created": 118, "skipped": 2, "dryRun": true,
    "errors": [
      { "line": 47, "title": "Some Book", "error": "Invalid ISBN \"9780385474543\"" },
      { "line": 92, "title": "Another",   "error": "Already catalogued as \"Another Book\"" }
    ] } }
```

**Run the dry run first.** Importing 800 books and discovering at row 400 that the file was malformed
is a bad afternoon. One bad row is reported and skipped, never fatal — rejecting 799 good rows over a
single typo helps nobody. Every error carries its **source line number**, so it can be found in the
spreadsheet.
</details>

<details><summary>Audit log, and manual job triggers</summary>

```
GET /api/v1/admin/audit-log?entity=FINE&action=FINE_WAIVE
```
```json
200 OK
{ "data": [ { "actorName": "Ravi Menon", "actorRole": "LIBRARIAN",
              "action": "FINE_WAIVE", "entity": "FINE",
              "changes": { "status": { "from": "PENDING", "to": "WAIVED" } },
              "note": "Book was returned to the drop-box on time",
              "ip": "127.0.0.1", "createdAt": "2026-08-13T18:22:00.000Z" } ] }
```
Only the fields that **actually changed** are stored — "updated a book" becomes "changed price from
399 to 39".

```
POST /api/v1/admin/jobs/overdue-check/run
```
```json
200 OK
{ "message": "Job \"overdue-check\" finished in 340ms",
  "data": { "job": "overdue-check", "durationMs": 340,
            "result": { "markedOverdue": 3, "finesAssessed": 3, "notified": 3, "usersAffected": 2 } } }
```
Jobs: `overdue-check` · `due-reminders` · `digital-expiry` · `ai-usage-sync` · `cleanup`.
All are **idempotent** — running the overdue check twice updates the same fine rather than doubling
anyone's debt.
</details>

---

## Health

Mounted at the root, not behind `/api/v1` — a probe should not need to know the API version.

| Endpoint | Purpose |
|---|---|
| `GET /health` | **Liveness.** Checks nothing, so a database blip cannot trigger a restart loop. |
| `GET /health/ready` | **Readiness.** Checks every dependency and reports the resolved configuration. |

<details><summary>Readiness</summary>

```
GET /health/ready
```
```json
200 OK
{ "status": "ready", "environment": "development", "uptime": 42.11,
  "checks": {
    "database": { "status": "up", "latencyMs": 2, "database": "elibrary",
                  "serverVersion": "8.0.3", "topology": "standalone",
                  "transactionsSupported": false },
    "mail": { "status": "up", "provider": "console", "configured": false,
              "reason": "MAIL_PROVIDER=sendgrid but SENDGRID_API_KEY is missing or invalid...",
              "warning": "Falling back to console delivery" },
    "ai": { "status": "up", "mode": "mock", "model": "gpt-4o-mini",
            "quotaTotal": 100, "cacheEnabled": true } } }
```
The mail and AI blocks report what is **actually** in force, which can differ from `.env` because both
fall back when misconfigured. Only the database is a hard dependency — mail and AI degrade by design,
so neither pulls the instance out of rotation.
</details>

---

## Error codes

Branch on these, never on the message text.

### Authentication
`MISSING_TOKEN` · `INVALID_TOKEN` · `TOKEN_EXPIRED` · `INVALID_CREDENTIALS` ·
`REFRESH_TOKEN_REUSED` · `REFRESH_TOKEN_INVALID` · `REFRESH_TOKEN_EXPIRED` · `RESET_TOKEN_INVALID` ·
`INCORRECT_PASSWORD` · `EMAIL_ALREADY_REGISTERED`

### Authorisation
`INSUFFICIENT_ROLE` · `NOT_RESOURCE_OWNER` · `ACCOUNT_SUSPENDED` · `ACCOUNT_INACTIVE` ·
`LAST_ADMIN_PROTECTED`

### Catalogue
`BOOK_NOT_FOUND` · `INVALID_ISBN` · `ISBN_ALREADY_EXISTS` · `AUTHOR_NOT_FOUND` ·
`PUBLISHER_NOT_FOUND` · `CATEGORY_NOT_FOUND` · `CATEGORY_CYCLE_DETECTED` · `CATEGORY_HAS_BOOKS` ·
`AUTHOR_HAS_BOOKS` · `PUBLISHER_HAS_BOOKS` · `COPY_NOT_FOUND` · `ACCESSION_NUMBER_TAKEN` ·
`COPY_ON_LOAN`

### Circulation
`NO_COPY_AVAILABLE` · `NO_LICENSE_AVAILABLE` · `NO_DIGITAL_EDITION` · `ALREADY_BORROWED` ·
`LOAN_LIMIT_REACHED` · `HAS_OVERDUE_ITEMS` · `OUTSTANDING_FINES` · `RENEWAL_LIMIT_REACHED` ·
`CANNOT_RENEW_OVERDUE` · `LOAN_NOT_ACTIVE` · `COPY_CLAIM_FAILED`

### Fines
`FINE_NOT_FOUND` · `FINE_ALREADY_SETTLED` · `WAIVER_NOTE_REQUIRED`

### Reviews & lists
`REVIEW_ALREADY_EXISTS` · `REVIEW_BLOCKED_BY_MODERATION` · `CANNOT_VOTE_OWN_REVIEW` ·
`CANNOT_MODIFY_DEFAULT_LIST` · `BOOK_ALREADY_IN_LIST` · `BOOK_NOT_IN_LIST`

### Files
`FILE_REQUIRED` · `FILE_TOO_LARGE` · `UNSUPPORTED_FILE_TYPE` · `FILE_SIGNATURE_MISMATCH` ·
`NO_READ_ACCESS` · `INVALID_DOWNLOAD_TOKEN` · `INVALID_RANGE`

### AI
`AI_FEATURE_DISABLED` · `AI_QUOTA_EXHAUSTED` · `AI_USER_LIMIT_REACHED` · `AI_INVALID_TOKEN` ·
`AI_UNAVAILABLE` · `AI_TIMEOUT` · `AI_MALFORMED_RESPONSE` · `AI_INSUFFICIENT_CONTEXT`

### Import & generic
`CSV_PARSE_ERROR` · `CSV_MISSING_COLUMNS` · `CSV_ROW_LIMIT_EXCEEDED` · `VALIDATION_ERROR` ·
`NOT_FOUND` · `CONFLICT` · `RATE_LIMIT_EXCEEDED` · `INTERNAL_ERROR`
