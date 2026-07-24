# HTTP-level guard tests for money- and window-adjacent routes

**Date:** 2026-07-23
**Status:** Approved — autonomous run (issue #53, scoped slice). Scope decisions
recorded below; the PR is the human review checkpoint.

## Problem

20 endpoint+method combos have HTTP-level integration tests; entire mutating
groups have none. `full-flow.test.ts` exercises class lifecycle + payments at
the **service** layer only, so the route handlers' auth guards, ownership
checks, and zod parsing are unexercised — exactly the branches that only exist
at the route layer. Highest value (per #53): the guard/ownership paths on
payments and classes (they gate money-adjacent mutations), then the waitlist
window rules (the window/state logic lives in `claimSpot`/`getWaitlistWindow`
and is service-tested; only the `WaitlistPromotionError` → 409 mapping is
route-level).

## Scope (this PR — the highest-value slice)

Cover the **guard/ownership/parsing 4xx branches** (and a representative
success) of three route groups. The full success/pricing paths stay with the
service tests that already own them; this PR pins the route-only branches.

### 1. `payments/[id]/paid` and `/unpaid` — extend `tests/integration/payments-api.test.ts`

Reuses the file's existing fixtures (`teacherToken`, `otherTeacherToken`,
`cookie()`, `teacherId`/`otherTeacherId`, a `pending` `paymentId`, `studentId`).

| Route | Case | Expected |
|---|---|---|
| POST `/paid` | no session cookie | 401 |
| POST `/paid` | unknown payment id (owner cookie) | 404 |
| POST `/paid` | other teacher's cookie | 403 |
| POST `/paid` | owner, invalid body (missing `method`) | 400 |
| POST `/paid` | owner, valid `{method:'cash'}` on the pending payment | 200, status `paid` |
| POST `/paid` | owner, re-posting on the now-paid payment (state guard) | 409 |
| POST `/unpaid` | no session | 401 |
| POST `/unpaid` | unknown payment id (owner cookie) | 404 |
| POST `/unpaid` | other teacher | 403 |
| POST `/unpaid` | owner, on the now-paid payment | 200, status `pending` |
| POST `/unpaid` | owner, on an already-pending payment (state guard) | 409 |

Order the paid→unpaid pair so the paid test runs before the unpaid-success test (serial file, like the existing remind tests). Shipped as: the `/unpaid` describe self-seeds the fixture payment back to `paid` in its own `beforeAll` rather than the `/paid` block restoring it at the end — this keeps each describe's assertions correct regardless of which ran first.

### 2. `classes/[id]/complete` and `classes/[id]/transition` — new `tests/integration/classes-api.test.ts`

Guard/ownership plus the reachable state-409s and the `/transition` cancel
branch — no pricing fixtures needed (the 200/pricing completion path stays
covered by `full-flow.test.ts`). Fixtures: an owner teacher + session, a
second teacher + session, one `Room` + `TeacherRoom`, a draft `Class` owned by
the owner (guard/state-409 probe), and a second draft `Class` dedicated to the
`/transition` cancel tests so cancelling doesn't mutate the fixture the other
tests depend on staying `draft`.

| Route | Case | Expected |
|---|---|---|
| POST `/complete` | no session | 401 |
| POST `/complete` | unknown class id | 404 |
| POST `/complete` | other teacher's cookie | 403 |
| POST `/complete` | owner, draft class (invalid transition to `completed`) | 409 |
| POST `/transition` | no session | 401 |
| POST `/transition` | other teacher | 403 |
| POST `/transition` | unknown class id | 404 |
| POST `/transition` | owner, invalid transition (draft → in_progress) | 409 |
| POST `/transition` | owner, `{status:'completed'}` (excluded from the enum) | 400 |
| POST `/transition` | owner, `{status:'cancelled'}` on a draft class (happy path) | 200, status `cancelled` |
| POST `/transition` | owner, cancelling an already-cancelled class | 409 |

The 409/200/400 rows also pin the exact response text (`validateTransition`'s
message for the state-409s, the route's own guard text for the cancel-409) —
matching only the status would let these pass for the wrong branch.

### 3. `waitlist/claim` — new tests (own file `tests/integration/waitlist-api.test.ts`, or a `claim` describe)

Fixtures: a student + session, a teacher session (for the non-student 403),
and TWO teacher-owned classes each with their own `WaitlistEntry` for the
student — a far-future class (deterministically outside the claim window, for
the window 409) and a class whose start is computed relative to *now* so the
request lands inside the first-come-first-claimed window (for the 201). The
route's `claimSpot` throws `WaitlistPromotionError`, which the route maps to
409; the window/state guards themselves (`wrong_window`, `class_full`, etc.)
live in `claimSpot`/`getWaitlistWindow` in the service and are unit-tested
there — only the exception → 409 mapping is route-level. `claimSpot` itself
had zero HTTP-level *or* service-level coverage before this PR.

| Case | Expected |
|---|---|
| no session | 401 |
| teacher session (non-student) | 403 |
| student, invalid body (missing/blank `classId`) | 400 |
| student, `claimSpot` rejects outside the claim window (`wrong_window`) | 409 |
| student, valid claim inside the window on a freed spot | 201 |
| student, second claim on the same now-filled spot (`class_full`) | 409 |

The two 409 rows also assert which reason fired (`claimSpot` has five
distinct 409 branches) by matching a substring of the real error message.

## Out of scope (deferred — noted in the PR)

Rooms + teacher-rooms, studio-class templates/classes, `classes` create + `[id]` PUT/DELETE + `/registrations` + `/payments`, auth `session`/passkey-options/magic-link-send, `notifications/stream`, and the account routes. Also the full success/pricing completion path (owned by `full-flow.test.ts`). These are lower-value or already service-covered; a follow-up issue can extend the same fixture patterns.

## Conventions

- Follow the existing integration style: real `PrismaClient` fixtures created in `beforeAll`, `fetch(`${BASE_URL}...`)` with a `Cookie: fair_yoga_session=<token>` header, DB assertions where a side-effect matters, `afterAll` cleanup in FK order. `uniqueSuffix` on emails/slugs to avoid cross-run collisions. Sessions created by inserting a `Session` row keyed by `sha256(token)` (the helper the existing files use).
- Assert **status codes** for guards; assert a **DB side-effect absence** on the 403 money mutations (no state change) where cheap, mirroring the remind 403 test.
- These run against the app on `localhost:3000` (same DB the app reads). Known: `signup-api.test.ts` 429s are the local 3/hour rate limiter, unrelated.

## Verification

`tsc` + `eslint` clean; the three integration files green against a running `:3000`; no change to any `src/` file (tests only), so unit/e2e are unaffected.
