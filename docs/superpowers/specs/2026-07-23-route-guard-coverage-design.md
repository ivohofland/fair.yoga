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
window rules (their 4xx branches live only in the route).

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
| POST `/unpaid` | no session | 401 |
| POST `/unpaid` | other teacher | 403 |
| POST `/unpaid` | owner, on the now-paid payment | 200, status `pending` |
| POST `/unpaid` | owner, on an already-pending payment (state guard) | 409 |

Order the paid→unpaid pair so the paid test runs before the unpaid-success test (serial file, like the existing remind tests). Restore the payment to `pending` at the end of the block so `afterAll` cleanup is unaffected.

### 2. `classes/[id]/complete` and `classes/[id]/transition` — new `tests/integration/classes-api.test.ts`

Guard/ownership only — no pricing fixtures needed (the 200/pricing path is covered by `full-flow.test.ts`). Fixtures: an owner teacher + session, a second teacher + session, one `Room` + `TeacherRoom`, and one `Class` owned by the owner in a state the route accepts as a no-op-or-error probe.

| Route | Case | Expected |
|---|---|---|
| POST `/complete` | no session | 401 |
| POST `/complete` | unknown class id | 404 |
| POST `/complete` | other teacher's cookie | 403 |
| POST `/transition` | no session | 401 |
| POST `/transition` | other teacher | 403 |
| POST `/transition` | unknown class id | 404 |

(If `complete`/`transition` also expose a state 409 reachable without a fully-priced class — e.g. completing a `draft`/already-`completed` class — add it; otherwise the ownership guards are the deliverable. The implementer confirms the exact 409 branch against the route.)

### 3. `waitlist/claim` — new tests (own file `tests/integration/waitlist-api.test.ts`, or a `claim` describe)

Fixtures: a student + session, a teacher-owned `Class`, and a `WaitlistEntry` for that student. The route's `claimSpot` throws `WaitlistPromotionError` (→ 409) for the window/state branches that only exist at the route layer.

| Case | Expected |
|---|---|
| no session | 401 |
| teacher session (non-student) | 403 |
| student, invalid body (missing/blank `classId`) | 400 |
| student, `claimSpot` rejects (outside the claim window / not waiting) | 409 |
| student, valid claim inside the window on a freed spot | 201 (if a deterministic in-window fixture is feasible; otherwise assert the 409 window branch and note the 201 path as service-covered) |

## Out of scope (deferred — noted in the PR)

Rooms + teacher-rooms, studio-class templates/classes, `classes` create + `[id]` PUT/DELETE + `/registrations` + `/payments`, auth `session`/passkey-options/magic-link-send, `notifications/stream`, and the account routes. Also the full success/pricing completion path (owned by `full-flow.test.ts`). These are lower-value or already service-covered; a follow-up issue can extend the same fixture patterns.

## Conventions

- Follow the existing integration style: real `PrismaClient` fixtures created in `beforeAll`, `fetch(`${BASE_URL}...`)` with a `Cookie: fair_yoga_session=<token>` header, DB assertions where a side-effect matters, `afterAll` cleanup in FK order. `uniqueSuffix` on emails/slugs to avoid cross-run collisions. Sessions created by inserting a `Session` row keyed by `sha256(token)` (the helper the existing files use).
- Assert **status codes** for guards; assert a **DB side-effect absence** on the 403 money mutations (no state change) where cheap, mirroring the remind 403 test.
- These run against the app on `localhost:3000` (same DB the app reads). Known: `signup-api.test.ts` 429s are the local 3/hour rate limiter, unrelated.

## Verification

`tsc` + `eslint` clean; the three integration files green against a running `:3000`; no change to any `src/` file (tests only), so unit/e2e are unaffected.
