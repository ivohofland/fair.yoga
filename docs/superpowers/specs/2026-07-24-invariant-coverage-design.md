# Behavioural tests for two route-level invariants

**Date:** 2026-07-24
**Status:** Approved (issue #67; scope split agreed with Ivo — `settings_locked`
and the public-room lock here, GDPR erasure deferred to its own PR)

## Problem

Issue #67 split three uncovered routes out of #53 because they carry *business
invariants* rather than the shared auth guards, so they earn behavioural tests
rather than 401/403 ladders (see the "What earns an HTTP guard test" convention
in `docs/technical-architecture.md`).

Investigating the first one changed its shape:

**`settings_locked` is enforced, and enforced well — but the enforcement is
unexercised.** `PUT /api/classes/[id]` rejects economic edits on a locked class
with a friendly 409 (`route.ts:72`), and backs it with a **compare-and-swap** —
`updateMany({ where: { id, settingsLocked: false } })` (`:86`) — so a first
registration landing between the read and the write still blocks the edit. The
*flip* is genuinely covered (`registrations-api.test.ts:168/213`: false before a
real registration, true after). What nothing exercises is the **rejection** —
the half that actually protects a student's booked price.

Worse, `full-flow.test.ts:262-271` is labelled *"Step 11: settingsLocked flips
true after first registration"* but its own comment concedes *"Here we simulate
by updating it as the route would"* — it writes the flag with `prisma.update`
and then asserts it. **A tautology asserting its own write**, creating a false
impression that the invariant is covered.

**The public-room lock** (`PUT /api/rooms/[id]`) is deliberate but surprising:
`if (room.isPublic) return 403` fires *before* the creator check, so a public
room is read-only for **everyone, including its creator**. We confirmed while
deciding #52 that this is intended — public rooms are community property and the
creator may have left the platform; #60's admin surface is what will eventually
mediate changes. Nothing pins that ordering, so a future "fix" letting the
creator through would look like a bug fix while silently reversing a product
decision.

## Scope

### 1. `PUT /api/classes/[id]` — the economic lock

`ECONOMIC_FIELDS` = `roomCost`, `minRate`, `targetRate`, `minStudents`,
`maxStudents`. Cases:

| Case | Expected |
|---|---|
| Unlocked class, economic edit (owner) | 200; the new values persist |
| Locked class, economic edit | 409; message names the sent fields; **DB unchanged** |
| Locked class, *non-economic* edit (e.g. `description`) | 200 — the lock is scoped to economics, not the whole record |
| Locked class, another teacher's cookie | 403 (bespoke ownership guard, so it earns its case) |

The lock is set the way the app sets it — by creating a real registration
through the existing fixture path — not by writing `settingsLocked` directly.
That keeps the test honest about what flips it.

**Deliberately not tested:** the compare-and-swap backstop (`:86`). Reaching
`result.count === 0` requires a registration to land *between* the route's read
and its write, which is not producible over HTTP. It is the second layer behind
the 409 the tests do cover; noted here so its absence is a recorded decision
rather than an oversight.

### 2. `PUT /api/rooms/[id]` — the public-room lock

| Case | Expected |
|---|---|
| Creator edits their own **private** room | 200; the change persists |
| The same creator edits it once **public** | 403 `Public rooms cannot be edited`; **DB unchanged** |
| A non-creator edits a private room | 403 `Only the room creator can update this room` |

The first two together are the point: same actor, same room, different
`isPublic` — that is what pins the ordering. Asserting the distinct messages
matters, because the two 403s mean different things and a reordering would swap
them while both tests still saw "403".

### 3. Remove the tautology

`full-flow.test.ts` "Step 11" writes `settingsLocked: true` and asserts it. First
check whether any later step depends on the class being locked. If not, delete
the step outright — the real flip is covered by `registrations-api.test.ts:213`.
If a later step does depend on it, keep the state mutation as plain setup, drop
the fake assertion, and say in a comment that the genuine coverage lives in
`registrations-api`.

## Out of scope

`DELETE /api/account` (GDPR erasure) — deferred to its own PR. It deserves
deciding *what erasure should guarantee* (which rows are deleted vs anonymised,
what consistency is promised) before writing assertions, and that is a bigger
conversation than a test.

## Conventions

New tests go in `tests/integration/`, on the shared fixtures from
`tests/integration/helpers.ts` (`BASE_URL`, `cookie`, `uniqueSuffix`,
`seedSession`). Semantic fixtures stay local. `afterAll` cleans up in FK order
with truthiness guards on anything assigned in `beforeAll` — an undefined filter
turns `deleteMany` into delete-all.

## Verification

`tsc` + `eslint` clean; the integration project green. Each 403/409 asserts the
DB is unchanged, not just the status code.
