# Data Model

19 collections. Every schema file carries per-field comments; this is the map.

---

## Entity relationships

```
                    ┌──────────┐
                    │   User   │──┐
                    └────┬─────┘  │
       ┌─────────────────┼────────┼──────────────┬───────────────┐
       │                 │        │              │               │
  ┌────▼─────┐    ┌──────▼───┐  ┌─▼──────────┐ ┌─▼───────────┐ ┌─▼──────────────┐
  │RefreshTok│    │   Loan   │  │   Review   │ │ ReadingList │ │ Notification   │
  └──────────┘    └────┬─────┘  └─────┬──────┘ └──────┬──────┘ └────────────────┘
                       │              │               │
  ┌──────────┐    ┌────▼─────┐        │               │
  │   Fine   │◄───┤          │        │               │
  └──────────┘    │          ▼        ▼               ▼
                  │        ┌───────────────────────────────┐
                  │        │            Book               │
                  │        └──┬────┬────┬─────────┬────────┘
                  │           │    │    │         │
       ┌──────────▼──┐   ┌────▼─┐ ┌▼────────┐ ┌──▼───────┐ ┌──────────────┐
       │  BookCopy   │   │Author│ │Publisher│ │ Category │ │ DigitalAsset │
       └─────────────┘   └──────┘ └─────────┘ └────┬─────┘ └──────┬───────┘
                                                    │ self         │
                                                    ▼ (ancestors)  ▼
                                              ┌──────────┐   ┌──────────┐
                                              │ Category │   │AiSummary │
                                              └──────────┘   └──────────┘

    AiUsageLog ── every AI request        AuditLog ── every privileged mutation
    PasswordResetToken ── single-use      ReadingProgress ── resume position
```

---

## The central distinction: Book vs BookCopy

A **Book** is a *title*. A **BookCopy** is an *object on a shelf*.

Six copies of "Things Fall Apart" is **one** Book document and **six** BookCopy documents.

Collapsing them would mean either duplicating the description six times, or having nowhere to record
which specific copy is damaged. A review is about the title; a due date belongs to the copy someone
took home.

---

## Collections

### Identity

| Collection | Purpose | Key indexes |
|---|---|---|
| **User** | Everyone. `role` (MEMBER/LIBRARIAN/ADMIN) × `membershipType` (PUBLIC/STUDENT/FACULTY) | `email` unique · `studentProfile.enrollmentNo` **partial** unique · `(role, status, isDeleted)` |
| **RefreshToken** | One per issued token. Hashed, with a `familyId` for reuse detection | `tokenHash` unique · `expiresAt` TTL · `(familyId, revokedAt)` |
| **PasswordResetToken** | Single-use, hashed, time-limited | `tokenHash` unique · `expiresAt` TTL |

**Why role and membershipType are separate axes.** A librarian borrows books too. `role` is *what you
may do*; `membershipType` is *what borrowing privileges you get*. One field would force nonsense
hybrids like `STUDENT_LIBRARIAN`.

`studentProfile` is present only for college members — absent, not empty — which is what lets the
partial unique index on the enrolment number work.

### Catalogue

| Collection | Purpose | Key indexes |
|---|---|---|
| **Book** | The bibliographic record | **weighted text index** · `isbn13`/`isbn10` **partial** unique · `(categories, status, rating.average)` |
| **BookCopy** | One physical item | `accessionNumber` unique · **`(book, status)`** |
| **DigitalAsset** | An ebook file | `(book, isPreview)` · `checksum` |
| **Author** / **Publisher** | Named entities | `slug` unique · text |
| **Category** | Subject tree with materialised ancestors | **`ancestors`** · `(parent, displayOrder)` |

**`(book, status)` on BookCopy** is the most important index in the circulation path — the atomic
copy claim queries exactly that shape on every borrow.

**The weighted text index** is what makes search useful: title ×10, subtitle ×5, tags ×3,
description ×1. Without weights, MongoDB scores every field equally and a book *titled* "Algorithms"
ranks alongside one that mentions the word once. MongoDB permits only one text index per collection,
so every searchable field lives in that one.

### Circulation

| Collection | Purpose | Key indexes |
|---|---|---|
| **Loan** | Who has what, when it is due | `(user, status)` · **`(status, dueAt)`** · `(user, book, status)` |
| **Fine** | A charge — overdue, damage, lost | `(user, status)` · `(status, createdAt)` |

`(status, dueAt)` makes the nightly overdue sweep an index range scan rather than a collection scan
that grows with the library's entire history.

### Engagement

| Collection | Purpose | Key indexes |
|---|---|---|
| **Review** | One per member per book | **`(user, book)` unique** · `(book, status, createdAt)` |
| **ReadingList** | Favourites and shelves | `(user, name)` unique · `shareSlug` **partial** unique |
| **ReadingProgress** | Resume position for digital reads | `(user, book)` |
| **Notification** | The in-app centre | `(user, readAt, createdAt)` · `expiresAt` TTL |

### AI & audit

| Collection | Purpose | Key indexes |
|---|---|---|
| **AiSummary** | **The cache.** | `(book, kind, length, language, promptVersion)` **partial** unique · `(book, questionHash, promptVersion)` |
| **AiUsageLog** | Every AI request — including free ones | `(source, createdAt)` · `(user, source, createdAt)` |
| **AuditLog** | Every privileged mutation, with diffs | `(actor, createdAt)` · `(entity, entityId, createdAt)` · TTL |

---

## `sparse` vs `partialFilterExpression` — a bug worth knowing

Four indexes here are **partial**, not sparse, and the distinction is easy to get wrong.

`sparse: true` skips documents where the field is **absent**. But these fields have `default: null` —
so every document *has* them, and under a sparse unique index the **second** document collides with
the first on `null`.

The consequences were real:

| Field | The bug it caused |
|---|---|
| `Book.isbn13` / `isbn10` | The catalogue could hold **exactly one** book with no ISBN — breaking on the first thesis, pre-1970 title, or locally bound item |
| `ReadingList.shareSlug` | A member could have **exactly one** reading list |
| `User.studentProfile.enrollmentNo` | Only one public member could exist |

```js
// WRONG — every document has the field, so nulls collide
schema.index({ isbn13: 1 }, { unique: true, sparse: true });

// RIGHT — the constraint applies only where the value is real
schema.index(
  { isbn13: 1 },
  { unique: true, partialFilterExpression: { isbn13: { $type: 'string' } } }
);
```

---

## Denormalised fields

Each is a cache of something derivable, kept because it is read on a hot path.

| Field | Derived from | Maintained by | Reconciled by |
|---|---|---|---|
| `Book.inventory.availableCopies` | `BookCopy` count | borrow / return | `recalculateInventory()`, nightly |
| `Book.rating.average` + `distribution` | `Review` aggregate | review write | `recalculateRating()` |
| `Book.stats.loanCount` | `Loan` count | borrow | — |
| `User.stats.activeLoans` | open `Loan` count | borrow / return | cleanup job |
| `User.stats.outstandingFine` | pending `Fine` sum | fine change | `refreshUserFineTotal()` |
| `Author.bookCount` | `Book` count | book write | cleanup job |

**The rule: recompute, don't adjust.** An incremental update that misses one code path drifts
permanently. A recount is self-correcting.

**The authoritative source is always the collection.** A borrow decision sums `Fine` directly rather
than reading `User.stats.outstandingFine`, because that decision must be right even if the cache is
stale.

`rating.distribution` stores the full 1–5 histogram because a 4.0 from forty 4-star reviews means
something quite different from a 4.0 from twenty 5-star and twenty 3-star ones.

---

## The category tree

Categories nest, and `ancestors[]` stores the **full root-first chain** alongside `parentId`.

```
Science                    ancestors: []
  └─ Computer Science      ancestors: [Science]
       └─ Algorithms       ancestors: [Science, Computer Science]
```

With only `parentId`, "every book under Science at any depth" needs one query per level and the depth
is unknown in advance. The materialised path makes it **one indexed query**:

```js
Category.find({ ancestors: scienceId })
```

The cost is that **moving** a node rewrites the ancestors of everything beneath it —
`rebuildDescendantAncestors()`, one bulk write. Reads vastly outnumber reorganisations in a library
catalogue, so that is the right way round.

Because a parent carries its own full chain, **cycle detection is a single membership test** rather
than a traversal: re-parenting a node under its own descendant is rejected with
`CATEGORY_CYCLE_DETECTED`.

---

## Soft deletes

Users, books, authors, publishers and categories are **never hard-deleted**.

Loans, fines and reviews reference them. Removing a book with loan history orphans the library's
circulation record — which is the library's permanent record, not a cataloguer's to erase.

The one exception: a `BookCopy` that has **never been borrowed** can be hard-deleted, because that is
a mis-scanned barcode rather than history. A copy *with* loans is marked `WITHDRAWN` instead.

Delete is also **refused while references exist** — an author with books, a category with children —
with the count in the error, so the message says what to do rather than just refusing.

---

## Frozen-at-write values

Some fields deliberately do **not** track their configuration source.

| Field | Frozen at | Why |
|---|---|---|
| `Loan.dueAt` | issue | A borrower was quoted a date. Changing `LOAN_PERIOD_DAYS` later must not retroactively make them overdue |
| `Fine.amount` | assessment | A member's debt must not change because an administrator edited `FINE_PER_DAY` |
| `Fine.ratePerDay` | assessment | Records the rate actually applied, so the charge can be explained |
| `Loan.daysOverdueAtReturn` | return | After a book is back, "how late was it?" must stop growing |
| `Review.isVerifiedBorrower` | write | Someone who read the book last year is no less a real reader |
