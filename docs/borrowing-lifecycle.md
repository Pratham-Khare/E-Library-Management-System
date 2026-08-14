# Borrowing Lifecycle

How a book gets from the shelf to a member and back, and what it costs if it does not.

---

## Policy

All values live in [`src/config/library.js`](../src/config/library.js), driven from `.env`.
Changing library behaviour never means changing code.

| Membership | Loan period | Concurrent loans | Renewals | Total fine-free window |
|---|---|---|---|---|
| `PUBLIC` | 14 days | 3 | 2 | **42 days** |
| `STUDENT` | 21 days | 5 | 2 | **63 days** |
| `FACULTY` | 30 days | 8 | 2 | **90 days** |

Each renewal grants a **fresh full period**, which is where the fine-free window comes from.

**Fines** — 2-day grace, then ₹5/day, capped at ₹500 per loan. Borrowing blocked above ₹200 owed.

**Digital** — 7 days, expires automatically, 3 simultaneous licences per title by default.

---

## Loan states

```
                    ┌──────────┐
      borrow  ─────▶│  ACTIVE  │
                    └────┬─────┘
                         │
        ┌────────────────┼────────────────┬──────────────────┐
        │                │                │                  │
   returned in     due date passes    staff marks      digital term
      time          (nightly job)        lost            elapses
        │                │                │                  │
        ▼                ▼                ▼                  ▼
  ┌──────────┐    ┌───────────┐    ┌──────────┐      ┌───────────┐
  │ RETURNED │    │  OVERDUE  │    │   LOST   │      │  EXPIRED  │
  └──────────┘    └─────┬─────┘    └──────────┘      └───────────┘
                        │           + replacement      licence
                    returned          charge           released
                        │
                        ▼
                  ┌──────────┐
                  │ RETURNED │ + overdue fine
                  └──────────┘
```

`ACTIVE` and `OVERDUE` are **open** — the item is still out. The other three are terminal.

### Copy states

```
AVAILABLE ⇄ ON_LOAN          the atomic compare-and-swap
    │
    ├──▶ DAMAGED    (repairable, out of circulation)
    ├──▶ LOST       (never coming back)
    └──▶ WITHDRAWN  (weeded from the collection)
```

Only `AVAILABLE` counts toward `inventory.availableCopies`. A copy that is `ON_LOAN` cannot be moved
to any other state directly — that transition belongs to the circulation engine, which also closes
the loan and raises any fine.

---

## Borrowing

### Eligibility, in order

Each check returns a **specific** code, because "you have a book overdue" and "you owe ₹250" call for
completely different actions from the member.

| # | Check | Code on failure |
|---|---|---|
| 1 | Account is `ACTIVE` | `ACCOUNT_INACTIVE` |
| 2 | Not already holding this title | `ALREADY_BORROWED` |
| 3 | Under the concurrent-loan cap | `LOAN_LIMIT_REACHED` |
| 4 | Nothing currently overdue | `HAS_OVERDUE_ITEMS` |
| 5 | Fines ≤ ₹200 | `OUTSTANDING_FINES` |
| 6 | A copy is free | `NO_COPY_AVAILABLE` |
| 7 | Won the claim | `COPY_CLAIM_FAILED` |

Checks 4 and 5 query the source collections **live**, not the cached counters on `User` — a book that
went overdue this morning must block a borrow this afternoon, not tomorrow.

`GET /loans/eligibility?bookId=` runs the same checks and returns **200 either way**, with the reason
and code when refused. That is what lets a client disable a Borrow button with an accurate
explanation rather than letting the member click it and get an error.

### The sequence

```
1. Load the book                     404 if unknown
2. assertEligibleToBorrow()          fail fast, cheap reads
3. Count available copies            409 NO_COPY_AVAILABLE + earliest due date
4. Create the Loan                   so the claim has an id to point at
5. ATOMIC claim                      ← the operation that cannot be raced
6. If it failed                      delete the loan, 409 COPY_CLAIM_FAILED
7. Recompute counters
```

**Why step 4 precedes step 5.** Claim-then-create leaves a copy marked `ON_LOAN` with no loan
pointing at it if the create fails. An orphaned loan is trivially deleted; an orphaned `ON_LOAN` copy
is invisible and permanently unborrowable.

**Step 5** is a single `findOneAndUpdate` filtered on `status: 'AVAILABLE'`. Of twenty simultaneous
requests for one copy, exactly one matches. See [architecture.md](architecture.md#concurrency-the-copy-claim).

A refusal at step 3 carries the **earliest expected return date** — the single most useful thing to
tell someone who cannot borrow.

---

## Renewing

Two conditions, and only two:

1. `renewalCount < maxRenewals` for the member's tier
2. **The loan is not already overdue**

Rule 2 is the one that matters. Without it, a member could dodge an accruing fine indefinitely by
renewing after the fact, which would make the entire overdue system decorative.

A renewal grants a **fresh full period from today**, not an extension of the old due date — renewing
three days early should not quietly cost the member three days.

```
RENEWAL_LIMIT_REACHED   already renewed the maximum
CANNOT_RENEW_OVERDUE    the item is already late
LOAN_NOT_ACTIVE         already returned, lost or expired
```

Each renewal is **recorded**, not just counted — `renewalHistory` holds when, from what, to what, and
by whom. A bare counter cannot answer "when was this extended?", which is exactly what gets asked
when a member disputes a fine.

---

## Returning

```
1. Verify the loan is open           409 LOAN_NOT_ACTIVE if not
2. FREEZE daysOverdue                stops it growing after return
3. Assess a fine if late
4. Close the loan
5. Release the copy                  filtered on status: ON_LOAN
6. Recompute counters
```

**Step 2** matters: after a book is back, "how late was it?" must stop changing. A value derived from
`dueAt` and the current date would keep growing forever.

**Step 5** is filtered on `ON_LOAN`, so a double-return is a no-op rather than incrementing
availability twice and inventing a copy the library does not own.

---

## Fines

### The arithmetic

```
chargeable days = max(0, daysOverdue − graceDays)
amount          = min(chargeable × ratePerDay, maxPerLoan)
```

| Days late | Working | Owed |
|---|---|---|
| 1 | grace absorbs it | ₹0 |
| 2 | grace absorbs it | ₹0 |
| 3 | (3 − 2) × ₹5 | **₹5** |
| 5 | (5 − 2) × ₹5 | **₹15** |
| 12 | (12 − 2) × ₹5 | **₹50** |
| 200 | (200 − 2) × ₹5 = ₹990 | **₹500** (capped) |

One function — `calculateOverdueFine()` — is the single source of truth. The cron job, the return
handler and the seeder all call it, so they cannot disagree.

Every fine records its own working: `daysOverdue`, `graceDays`, `chargeableDays`, `ratePerDay`,
`cappedAtMaximum`. **A fine nobody can explain is a fine nobody can defend** — the API returns the
arithmetic so "₹15" becomes "5 days late, 2 forgiven as grace, 3 × ₹5".

### Idempotent accrual

The nightly job **updates** an existing `OVERDUE` fine rather than creating a second one. A cron task
eventually runs twice; without this, someone's debt doubles.

A fine already `PAID` or `WAIVED` is never revised — someone paid, or staff forgave it.

### Settlement

- **Pay** — records that money changed hands at the desk. No gateway; `paymentReference` carries the
  receipt from whatever handled it.
- **Waive** — **requires a written reason**, minimum 5 characters. A waiver writes off money the
  library was owed; without a recorded reason it cannot be told apart from a mistake or a favour. The
  note is permanent and the action is audited.

Both recompute `User.stats.outstandingFine` from the `Fine` collection rather than adjusting it —
that number gates borrowing, so being wrong means blocking someone who owes nothing or letting
someone borrow who owes a fortune.

---

## Lost items

Staff mark a loan lost. The copy becomes `LOST` (excluded from availability), the loan closes, and a
replacement charge is raised at **the book's recorded price**, falling back to the per-loan cap.

Charging a flat fee for a lost reference volume and a lost paperback alike is not defensible.

---

## Digital lending

An ebook is not consumed by being read, so instead of copies it has **concurrent licences** — a cap
on simultaneous readers.

```
borrow  → atomic $expr claim: activeLicenses < concurrentLicenses
        → loan created with a 7-day term
read    → every request verifies an ACTIVE digital loan, then streams
expire  → hourly job releases the licence
return  → member can release it early
```

The licence release uses `$max: [0, …]` rather than a bare `$inc: -1`. An unguarded decrement that
ran twice would push the count negative and permanently over-issue licences for that title.

Runs **hourly**, not nightly: a licence held 23 extra hours is a licence nobody else can use, and
digital stock is deliberately scarce.

---

## The circulation desk

Staff can issue on a member's behalf, return anything, override a due date, and mark items lost.

**Staff cannot bypass eligibility.** A librarian issuing a book runs the *same* checks — loan limits,
overdue blocks, fine thresholds are library policy, not a desk preference. The one thing staff may
override is the due date, for a reading-week extension or a title reserved for a class.

Verified: issuing to a member with overdue items is refused with `HAS_OVERDUE_ITEMS`, even for an
admin.

---

## Scheduled jobs

| Job | When | Effect |
|---|---|---|
| `overdue-check` | 00:30 | `ACTIVE` → `OVERDUE`, accrue fines, notify (max once/day per loan) |
| `due-reminders` | 09:00 | Warn 3 days ahead, **one email per member** listing all their books |
| `digital-expiry` | hourly | Release expired licences |
| `cleanup` | 03:00 | Purge tokens, reconcile counters |

Trigger any of them on demand: `POST /admin/jobs/{job}/run` (admin only) — useful for verifying a
policy change without waiting until midnight.

The overdue job uses a **cursor**, not an array: a library with years of history could have thousands
of overdue items, and there is no reason to hold them all in memory. One bad record is logged and
skipped rather than aborting the sweep for everyone else.

---

## Exercising it

`npm run seed:fresh` creates loans already 5, 12 and 40 days overdue with fines accrued — so every
path below is reachable immediately, without waiting days or editing documents by hand.

| To see | Do this |
|---|---|
| A fine explained | `GET /fines/me` as `rohan@student.test` — ₹15 from 5 days late |
| Overdue blocking | Try to borrow as `rohan@student.test` → `HAS_OVERDUE_ITEMS` |
| Fine-threshold blocking | Raise a ₹250 charge, then try to borrow → `OUTSTANDING_FINES` |
| Renewal refused | Renew an overdue loan → `CANNOT_RENEW_OVERDUE` |
| Renewal cap | Renew three times → `RENEWAL_LIMIT_REACHED` |
| **The concurrency guarantee** | Fire 20 simultaneous borrows at *Artificial Intelligence* (1 copy) → exactly one succeeds |
| Idempotent accrual | `POST /admin/jobs/overdue-check/run` twice → the total does not move |
