# AI Pipeline

The supplied token permits **100 calls for its entire lifetime**. Not per day — in total.

That single constraint shaped every decision below. A naive "summarise on every request"
implementation exhausts the budget during the first demo and leaves the feature permanently broken.

---

## How every AI response resolves

```
┌─────────────────────────────────────────────────────────────┐
│  1. CACHE                                       0 calls     │
│     Keyed (book, kind, length, language, promptVersion)     │
│     A repeat request is an indexed DB read.                 │
└────────────────────────┬────────────────────────────────────┘
                         │ miss
┌────────────────────────▼────────────────────────────────────┐
│  2. LIVE                                    1 of 100        │
│     Requires: usable token · budget remaining ·             │
│               member under their daily cap · enough context │
└────────────────────────┬────────────────────────────────────┘
                         │ not possible, or failed
┌────────────────────────▼────────────────────────────────────┐
│  3. MOCK                                        0 calls     │
│     Deterministic, book-specific, clearly labelled.         │
└─────────────────────────────────────────────────────────────┘
```

Every response reports which step produced it:

```json
{ "source": "mock", "aiGenerated": false, "cached": false,
  "notice": "Generated offline because the AI service is unavailable. This is not model-generated content." }
```

---

## Layer 1 — the cache

**This is the layer that makes the feature affordable.** A book's summary costs **one call ever**, no
matter how many members read it. Fifty books means at most fifty calls.

### The cache key

```
(book, kind, length, language, promptVersion)
```

Every component earns its place:

| Component | Why |
|---|---|
| `kind` | A summary and key takeaways are different content |
| `length` | SHORT and LONG are genuinely different text |
| `language` | A Hindi summary is not an English one |
| `promptVersion` | When a prompt improves, old output is stale |

**Bumping `AI_PROMPT_VERSION` invalidates the entire cache** without a migration. Edit a prompt
template, bump the version, redeploy.

Enforced by a **unique index**, so two members requesting the same uncached summary simultaneously
cannot produce two entries — and the loser fails fast rather than spending a second call. That
duplicate-key error is swallowed deliberately: losing the race is harmless, since the winner stored
the same thing.

### Q&A caching

Answers are keyed on a **normalised** question hash — lowercased, punctuation stripped, whitespace
collapsed. "What is the main theme?" and "what is the main theme" are one question and cost one call
between them.

**Measured: 70 ms cached vs 1052 ms first request.**

---

## Layer 2 — the quota guard

Three checks stand between a request and a spent call.

### 1. A usable token

Blank, missing, or still the `.env.example` placeholder → no live call is possible. That is what lets
someone clone the repo, run `npm run dev`, and have every AI endpoint work without touching
configuration.

**A rejected token is latched.** The first `401` records the fact; every subsequent request goes
straight to mock instead of paying a network round-trip and a retry cycle to rediscover it. A
successful usage reconciliation clears the latch, so replacing a bad key takes effect without a
restart.

### 2. The global budget

Counted from `AiUsageLog`, reconciled against the provider's own `/v1/usage` every six hours.

**The lower of the two figures wins.** They can disagree — another deployment might share the token,
or a call might be billed upstream after failing locally — and in a disagreement about a finite budget
the pessimistic number is the safe one.

A **safety margin** (`AI_QUOTA_SAFETY_THRESHOLD=0.9`) stops live calls at 90 of 100, holding ten in
reserve rather than letting whoever clicks next consume the last of them.

### 3. The member's daily share

5 generations per member per day, keyed by **user id**, not IP. Without it, one curious member
clicking "summarise" repeatedly exhausts the shared budget for everyone, permanently. Keying by IP
would be trivially bypassed and would throttle an entire campus behind one NAT address.

Staff are exempt — a librarian backfilling summaries should not be limited by a control designed for
members.

---

## Layer 3 — the mock provider

**Not lorem ipsum.** Output is built from the book's own title, authors, categories, page count and
description.

```
Things Fall Apart was written by Chinua Achebe. Okonkwo is a wealthy and
respected warrior of the Umuofia clan, a lower Nigerian tribe that is part of
a consortium of nine connected villages.

First published in 1958, it continues to be borrowed regularly, and is
frequently recommended to readers approaching the subject for the first time.
```

Filler text would make every AI endpoint technically "work" while demonstrating nothing. This makes
the feature genuinely demonstrable with the network unplugged.

**Deterministic.** A seeded PRNG (mulberry32) derived from the book's id means the same book always
produces the same text — so a cached mock and a fresh one agree, and a demo does not change wording
between refreshes.

**Never disguised as real.** `source: "mock"`, `aiGenerated: false`, `AiSummary.isMock: true`,
`AiUsageLog.wasMock: true`, and an explicit notice — which travels with **cached** mocks too, since
the cached response is the one most people see.

The mock **declines** to moderate reviews. It cannot judge nuance, and pretending otherwise would
silently mis-moderate real content — it returns `FLAGGED` for a librarian to check.

Controlled by `AI_MOCK_MODE`:

| Value | Behaviour |
|---|---|
| `auto` *(default)* | Mock when no live call is possible — no token, rejected token, exhausted budget, or a failed live call |
| `always` | Never touch the network. Offline development and zero-cost demos |
| `never` | Fail loudly. **Correct for production** — a misconfiguration must not silently serve fabricated content |

---

## Layer 4 — heuristic-first features

Two features avoid the model almost entirely.

### Recommendations

**Selection is a database aggregation, not an AI call.** Books are scored by overlap with the
member's borrowing history:

```
score = sharedAuthors × 4      a shared author is a strong signal
      + sharedCategories × 2   categories are broad
      + rating.average × 0.5   breaks ties
      + 1 if available now
```

Instant, free, and available to every member on every request. The model is asked **only** to write
the one-sentence rationale, and only when `?explain=true` — which is the part it is actually good at
and the only part worth paying for.

With no borrowing history, the fallback is popularity, reported honestly as
`personalised: false`.

### Review moderation

A keyword and pattern pre-filter runs on **every** review and returns a verdict *and a confidence*:

| Score | Verdict | Action |
|---|---|---|
| 0 | `CLEAN` | Publish. **Conclusive** — no call spent |
| ≥ 0.7 | `BLOCKED` | Reject with reasons. **Conclusive** — no call spent |
| 0 < s < 0.7 | `FLAGGED` | **Inconclusive** — escalate to the model |

Only the ambiguous middle costs a call. Moderating every review with the model would exhaust the
budget in a day *and* moderate worse, since the heuristic is more consistent on clear-cut cases.

**The prompt explicitly protects negative reviews.** A one-star review is not abuse, and a moderation
system that removes criticism is worthless.

---

## Prompts

All in [`src/integrations/ai/prompts/`](../src/integrations/ai/prompts/), versioned by
`AI_PROMPT_VERSION`.

Two properties are shared by every prompt:

**JSON output is requested.** Parsing structured output is reliable; scraping prose for a verdict or
a rating fails in ways that are hard to detect. `parseJsonResponse()` handles markdown fences and
preambles defensively — throwing away a call we paid for because of three stray backticks would be
absurd.

**The model is told what it does not know.** Each prompt states whether it has the actual book text
or only a catalogue record, and instructs the model to say so rather than invent:

> If the material you are given is thin, say so plainly rather than inventing detail — a short honest
> summary is far better than a confident invented one.

For Q&A this is the most important line in the codebase:

> If the information does not support an answer, say so plainly. **DO NOT GUESS**, and do not invent
> plot details, quotations or page references.

A model asked "what happens in chapter 12?" with only a blurb will happily invent chapter 12. **A
library publishing fabricated plot details is worse than one publishing none.** The response carries
`answeredFromSource: false` so a client can present that differently from a real answer.

### Source material

When an ebook has been uploaded, extracted text feeds the prompt instead of the blurb — and the
response says which via `basedOn`. Extraction failure is not fatal: summaries fall back to metadata.

`hasSufficientContext()` refuses to spend a call on a one-line record, returning
`AI_INSUFFICIENT_CONTEXT` rather than paying to hallucinate.

---

## The client

[`src/integrations/ai/client.js`](../src/integrations/ai/client.js) — Node's built-in `fetch`, no axios.

**Timeout.** An `AbortController` bounds every request. A hung upstream would otherwise hold an
Express handler open indefinitely.

**Selective retry.** Network errors, timeouts and 5xx are retried with exponential backoff and
jitter. **400, 401 and 404 are never retried** — the same request fails identically, and on a
100-call budget a pointless retry is a call we cannot get back. The jitter is not decoration: without
it, requests that failed together retry together against an upstream already struggling.

**Circuit breaker.** After 5 consecutive failures the circuit opens and requests fail immediately for
60 seconds instead of each waiting out a 30-second timeout. One dead upstream should not make every
page slow. One probe is allowed through after the cooldown.

---

## Usage accounting

`AiUsageLog` records **every** request — live, cached and mock.

Logging the free ones is the point. Without them there is no way to answer "how much did the cache
save?", which is the number that justifies the entire design. A log of only live calls shows 40 rows
and tells you nothing about the 400 requests served for free.

```
GET /api/v1/ai/status
```
```json
{ "mode": "mock",
  "reason": "The AI provider rejected our token — serving mock content",
  "tokenRejected": true,
  "quota": { "total": 100, "used": 0, "remaining": 0, "reserved": 10 },
  "circuitBreaker": "closed",
  "cache": { "entries": 12, "mockEntries": 12, "realEntries": 0 },
  "statistics": {
    "totalRequests": 31, "liveCalls": 0, "cacheHits": 19, "mockResponses": 12,
    "savedByCache": 31, "cacheHitRate": 100,
    "averageLiveLatencyMs": 0, "averageCacheLatencyMs": 3
  } }
```

---

## Features

| Feature | Cached | Cost control |
|---|---|---|
| Summary (SHORT/MEDIUM/LONG) | ✓ | One call per book per length. Regeneration is staff-only |
| Key takeaways | ✓ | One call per book |
| Simplified summary | ✓ | One call per book |
| Ask a question | ✓ by normalised question | Per-user cap; repeats are free |
| Recommendations | — | **Selection is free.** Rationales are opt-in |
| Review moderation | — | Heuristic-first; only ambiguous cases escalate |
| Metadata enrichment | — | Staff-triggered only; advisory, never auto-applied |

Each has a flag in `config/ai.js`. A disabled feature returns `501 AI_FEATURE_DISABLED` rather than
silently doing nothing — the caller learns the difference between "off" and "broken".

---

## Failure modes

| Situation | Response |
|---|---|
| No token | Mock, labelled |
| Token rejected (`401`) | Mock, labelled; the rejection is latched and surfaced in `/ai/status` |
| Budget exhausted | Cache if available, else mock |
| Member's daily cap reached | `429 AI_USER_LIMIT_REACHED` — a limit, not a failure |
| Upstream timeout / 5xx | Retried, then mock |
| Circuit open | Mock immediately, no network call |
| Malformed model response | `AI_MALFORMED_RESPONSE`, then mock |
| Too little source material | `400 AI_INSUFFICIENT_CONTEXT` — no call spent |
| `AI_MOCK_MODE=never` | Errors surface. Correct for production |

**The AI never takes the application down.** Cached content is served whenever it exists; otherwise
mock covers the gap. The library keeps working.

---

## Adding a working token

The token shipped with this assignment is **rejected by the provider** (`401 invalid_api_key`) — it
may have been revoked, expired, or truncated in transit. The system runs entirely in mock mode as a
result, which is exactly what that mode is for.

With a valid token:

```bash
AI_API_TOKEN=sk-your-real-token
```

Restart, then confirm with `GET /ai/status` (`mode: "live"`). Existing mock entries can be regenerated
in bulk:

```
POST /api/v1/ai/upgrade-mocks?limit=5
```

**Deliberately bounded.** With a 100-call lifetime budget, an unbounded regeneration would spend
everything in one command. It stops as soon as the budget runs out and reports exactly what it
managed and what it did not.
