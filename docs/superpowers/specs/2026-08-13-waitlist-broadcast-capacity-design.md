# The final-hour waitlist broadcast has no capacity check

**Issue:** 212 · **Date:** 2026-08-13 · **Status:** design agreed

The broadcast branch of `handleSpotFreed` (`src/services/waitlist.ts:658-675`) tells
every waiting student a spot opened without checking whether one exists. This spec
fixes that site, and absorbs the duplication that let it be forgotten.

---

## 1. The issue's premise, checked

**The defect is real and the issue's code quote is accurate.** The broadcast branch
reads the waiting list and notifies; there is no `registration.count` and no
`maxStudents` comparison anywhere in it. Both siblings gate:

| Site | Line | Check |
|---|---|---|
| `promoteNext` | `waitlist.ts:415` | `activeCount >= cls.maxStudents` → throw `class_full` |
| `claimSpot` | `waitlist.ts:553` | `activeCount >= cls.maxStudents` → throw `class_full` |
| broadcast | `waitlist.ts:658` | **nothing** |

**The issue's account of how a student reaches it does not hold.** Its scenario —
"a second cancellation and re-registration, or a walk-in, refills the class; the next
cancel triggers another broadcast" — cannot produce a false broadcast, because that
next cancel frees the very seat it announces. `activeCount` is `maxStudents − 1` the
instant the cancel commits.

For the broadcast to be false, the class must **already be at capacity when the hook
reads**. Three ways that could happen, all measured:

**Walk-in overbooking — impossible in this window.** A walk-in requires
`Date.now() >= classStart − WALK_IN_WINDOW_MS` or `status === 'in_progress'`
(`registrations/route.ts:46,139`), where `WALK_IN_WINDOW_MS` is 15 minutes. The
first-come-first-claimed window is `[start − dh − 1h, start − dh)` for
`dh ∈ {48, 24, 12, 6}` (`getWaitlistWindow`, `waitlist.ts:119-142`), so it *ends* at
earliest `start − 6h`. The two windows are disjoint by at least
`6h − 15min = 5h 45min`, and past the deadline `getWaitlistWindow` returns `frozen`,
which returns before the broadcast at `:645`.

**A teacher shrinking `maxStudents` — impossible.** `maxStudents` is in
`ECONOMIC_FIELDS` (`lib/class-fields.ts:13-19`), immutable once `settingsLocked`,
which flips on the first registration (`class-lifecycle.ts:519,557`). A class holding
a waitlist is locked by definition.

**A refill committing between the cancel and the hook — the only reachable path.**
A booking, or a `claimSpot` triggered by an earlier broadcast, commits in the gap
between the cancel's `updateMany` and the broadcast's `findMany`.

So **this is a race, not an ordinary sequence.** That is not a reason to downgrade it —
it is the reason the fix has to be a locked count rather than a bare one. The window is
one DB round-trip on the cancel route, and materially wider on the erasure path:
`deleteStudentAccount` runs `handleSpotFreed` in a **post-commit loop over N classes**
(`gdpr.ts:645-652`), so the last class's hook can fire seconds after its seat was freed.

**What the issue got right that is worth keeping:** `claimSpot`'s check is the only
thing standing between the message and the truth, and it runs after the student has
been summoned. The harm is bounded — a 409 with an accurate message, no wrong booking,
no money moved — but the notification is wrong *when written*, not stale when read.

**`waiting.length === 0` is not a capacity check.** The issue says so and it is correct:
it asks whether anyone is queued, not whether a seat exists.

---

## 2. Why an unlocked count is not the fix

The issue's option 1 — "count active registrations and return `{ action: 'none' }`" —
is right about the guard and wrong about where it goes. Read outside a transaction, it
moves the race from *cancel-commit → findMany* to *count → createMany*. Since a race is
the **only** way to reach this bug, a fix that leaves a race leaves the bug, smaller.

The count and the notification insert therefore go in one transaction holding the
`Class` row lock — which is exactly what `promoteNext` and `claimSpot` already do, and
what makes their checks sound rather than decorative.

---

## 3. The measured surface

The capacity rule lives at **five write sites**. One forgot it, and that omission is
this issue:

| Site | Line | Policy |
|---|---|---|
| `addToWaitlist` | `waitlist.ts:185-190` | `activeCount < max` → `WaitlistJoinError` (inverse: "book instead") |
| `promoteNext` | `waitlist.ts:412-417` | `>= max` → `WaitlistPromotionError('Class is full')` |
| `claimSpot` | `waitlist.ts:550-555` | `>= max` → `WaitlistPromotionError('already claimed')` |
| booking | `registrations/route.ts:142-148` | `>= max && !isWalkIn` → `ClassFullError` |
| broadcast | `waitlist.ts:658` | **absent** |

Each hand-writes its own `registration.count`. The status list they count is duplicated
across **six non-test sites**:

| Site | Form |
|---|---|
| `waitlist.ts:45` | module-private `as const` tuple (4 usages) |
| `class-transitions.ts:35` | module-private `RegistrationStatus[]` (3 usages) |
| `registrations/route.ts:143` | bare inline literal — the capacity count |
| `registrations/route.ts:156` | bare inline literal — "already registered?" |
| `(student)/bookings/page.tsx:71` | bare inline literal — display query |
| `(teacher)/class/[id]/page.tsx:73` | bare inline literal — display filter |

Neither of the two constants is exported, so the four literal sites had nothing to
import even if their authors had looked. A sixth registration status updates somewhere
between one and six of these depending on who remembers.

**That count corrects my own first census, which said three.** The first pass grepped
`registration.count` call sites and reported the result as a count of *the list* — a
method that structurally cannot see a literal used in a `findMany`, an `.includes()`, or
a page query. The number came out right only for the sites that happen to count. Re-derived
with `grep -rn "'registered'" src | grep attended`, which finds every occurrence
regardless of what it is passed to.

**Ruled out of that census, deliberately, so nobody re-derives them:**

- **Five sites carrying a *different* four-element list** (`+ 'late_cancel'`) —
  `(public)/[slug]/page.tsx:53`, `(public)/[slug]/book/[classId]/page.tsx:32`,
  `(teacher)/page.tsx:46`, `(teacher)/settings/reporting/page.tsx:43`,
  `(teacher)/schedule/past/page.tsx:23`. That is the billing set, not the seat set, and
  it already has a name: `CHARGED_STATUSES` (`class-lifecycle.ts:168`). They are inlining
  *that* constant. A separate duplication with a separate owner — see §4.1.
- **Two test files** (`class-transitions.test.ts:591`,
  `invitations-lock-order.test.ts:527`) keep their literals. A test that imports the
  constant it exists to pin goes green when the constant changes.
- **`registrations/[id]/route.ts`'s `notIn: ['cancelled', 'late_cancel']`** is the
  complement form and a genuinely different question — "not already cancelled", not
  "occupies a seat". It stays a literal because it means what it says. Worth knowing that
  adding a sixth status makes the two forms diverge in meaning; that is correct behaviour
  for each, not drift.

`class-transitions.ts` shares the **list** but not the **question**: its counts
(`:287`, `:302`) compare against `minStudents` — "should this class auto-cancel?" — not
`maxStudents`. It adopts the shared constant and never the seat helper.

**No tracker overlap.** #182 owns "decide from state read under the lock" for three
other sites, all of them `Class.status` writers — the broadcast is not one. #104 owns
the unbounded lock waits. Neither covers this site.

---

## 4. Design

### 4.1 `src/lib/registration-status.ts` (new)

```ts
import type { RegistrationStatus } from '@prisma/client';

export const ACTIVE_REGISTRATION_STATUSES = ['registered', 'attended', 'no_show'] as const
  satisfies readonly RegistrationStatus[];
```

In `lib/` and import-free at runtime — the `class-fields.ts` / `tiers.ts` precedent. The
`import type` erases completely, so nothing here can drag `@/lib/log` (pino,
server-only) into a client bundle if a component ever needs the list.

**The `satisfies` pins membership, deliberately not completeness.** Each string must be
a real enum member, so a renamed status fails `tsc`. The list is a *subset* by design:
`cancelled` and `late_cancel` freed their seat and must stay out. This is the inverse of
#39's defect, where completeness was the property wanted and membership was all that got
pinned — recorded here so the next reader does not "fix" it into a completeness pin.

Both existing constants are deleted and re-pointed at this one, and the four inline
literals in §3's table import it. Both page files are server components (no
`'use client'`), so the import is safe there on any reading — but the module is written
import-free anyway, because that is the property that survives a page later becoming a
client component.

**`CHARGED_STATUSES` deliberately does not move.** Its docblock
(`class-lifecycle.ts:160-167`) already names `waitlist.ts`'s
`ACTIVE_REGISTRATION_STATUSES` as the pattern it follows, so this branch is obliged to
update that pointer to the new home — but relocating the constant itself is a separate
change: four comments across three test files name `class-lifecycle.ts` as its home, one
of them by line number (`class-transitions.test.ts:257` → `class-lifecycle.ts:167`), and
it is used only by server-side services where the client-safety argument buys nothing
today. This branch did not make that split worse; it made one half of it better and
leaves a pointer at the other. Not filed either — the failure mode is "someone looks for
the status sets and finds one", which a cross-reference in both docblocks fixes and a
backlog entry does not.

### 4.2 `src/services/capacity.ts` (new)

```ts
export async function readSeatCount(
  tx: TransactionClientOnly,
  classId: string,
): Promise<{ maxStudents: number; activeCount: number; freeSeats: number }>
```

**It reads the class itself rather than accepting one.** Callers keep their own class
reads — `promoteNext` and `claimSpot` need `teacher.defaultTimezone`, `date`,
`startTime`, `cancelDeadline`; the broadcast needs `classType` — so a shared return
shape would need a generic `select` parameter or leave callers holding two class
objects. The cost of reading `maxStudents` separately is one PK lookup inside a
transaction already holding that row's lock: a buffer hit. The gain is that a
**half-locked comparison is unrepresentable** — the helper never compares a fresh count
against a `maxStudents` someone read before taking the lock.

**It takes the `TransactionClientOnly` brand** (`lib/db-locks.ts`), and that is a
deliberate departure from that module's default. Its register says a helper needs the
brand when it issues a transaction-scoped statement, and lists read-only helpers
(`hasActiveRegistration`, `reorderWaitingEntries`, …) as skips — while stating that the
rule is "sufficient, not necessary", that a read-only helper "can still be wrong on a
bare client, by reading around its caller's uncommitted writes", and that the choice is
"decided per site, not uniformly". This helper exists to count *under the caller's
lock*; on a bare `PrismaClient` it would count outside it, which is the defect being
fixed. Branding makes that misuse a compile error rather than a silent regression.
**That register is written to be read as complete, so it gains a line for this helper**
— an adopt, with a different reason than the others.

**It does not take the lock, and that is the contract.** Every caller already holds the
`Class` row lock when it calls — four via their own inline `FOR UPDATE` (#104's five,
untouched), the new broadcast via `lockClassRow`. A helper that locked would retrofit a
bounded wait onto those four, which `db-locks.ts:139-152` reserves for #104. Its
docblock states the precondition: *the caller must hold the `Class` row lock, or the
count is a snapshot with no meaning.*

**What the brand does not buy, said plainly.** `TransactionClientOnly` makes a bare
`PrismaClient` a compile error. It cannot check that the caller actually took the lock —
a transaction that skipped `lockClassRow` type-checks fine and counts nothing useful.
Nothing in TypeScript or Postgres enforces that, so it is a docblock precondition and a
review obligation, not a guarantee. Overstating it here would be worse than the gap.

**`freeSeats` is not clamped at zero.** Walk-ins deliberately exceed `maxStudents`
(`registrations/route.ts:131-139`), so a negative value is a real state that describes
how overbooked a class is. Callers test `<= 0`.

### 4.3 The five sites adopting the helper

Five sites adopt `readSeatCount`; **six** adopt the constant (§4.1) — the sets differ
because `class-transitions.ts` counts against `minStudents`, and `route.ts:156`,
`bookings/page.tsx:71` and `class/[id]/page.tsx:73` ask about membership rather than
capacity. Only the counting is shared. Every policy stays where it is:

| Site | After |
|---|---|
| `addToWaitlist` | `if (freeSeats > 0) throw new WaitlistJoinError(…)` |
| `promoteNext` | `if (freeSeats <= 0) throw new WaitlistPromotionError('Class is full', 'class_full')` |
| `claimSpot` | `if (freeSeats <= 0) throw new WaitlistPromotionError('The spot has already been claimed', 'class_full')` |
| broadcast | `if (freeSeats <= 0) return []` — **the fix** |
| booking | `if (freeSeats <= 0 && !isWalkIn) throw new ClassFullError()` |

The booking route is a service call from a route handler, which is the documented
direction (CLAUDE.md: "API routes are thin wrappers").

### 4.4 The lock

The broadcast branch becomes:

```ts
// first_come_first_claimed: notify everyone waiting; first claim wins.
const waiting = await db.$transaction(async (tx) => {
  await lockClassRow(tx, classId);

  const { freeSeats } = await readSeatCount(tx, classId);
  if (freeSeats <= 0) return [];   // refilled between the cancel and here

  const entries = await tx.waitlistEntry.findMany({ where: { classId, status: 'waiting' } });
  if (entries.length === 0) return [];

  await createBulkNotifications(tx, entries.map(…));
  return entries;
});
return waiting.length === 0 ? { action: 'none' } : { action: 'broadcast', notified: waiting.length };
```

**`lockClassRow`, not inline SQL.** `db-locks.ts:139-152` names five pre-existing
`FOR UPDATE` sites that deliberately keep inline SQL and unbounded waits — four in
`waitlist.ts`, one in the booking route — because bounding them is #104's subject and
"retrofitting them from here would blur what that issue is accountable for." This is a
**new** site, not on that list, so it takes the bounded (2s) helper from birth: on
#104's target side without entering #104's territory. **#104 is unaffected** and its
five sites are untouched.

**Lock order is unchanged**, by `docs/lock-order.md`'s own reasoning. The transaction
inserts `Notification` rows carrying `relatedClassId`, which take `FOR KEY SHARE` on the
parent `Class` row — a row this transaction already holds `FOR UPDATE` on, in the same
ascending sequence, and exactly one class per transaction. Only the table row at
`lock-order.md:174` changes: "one — `classId`, and outside any transaction" becomes a
locked site.

**`createBulkNotifications` is safe to hold a lock across.** It is one `createMany` plus
in-process bus emits (`notifications.ts:101-125`) — no email send, no network call.
Email is a separate fallback sweep. `promoteNext` and `claimSpot` already call it inside
their own locked transactions.

**No explicit transaction `timeout`.** Prisma's 5s default covers a lock wait bounded to
2s plus three indexed statements, and `lockClassRow`'s `SET LOCAL` governs the whole
transaction. This is not `deleteStudentAccount`, which sizes its own budget because it
locks in a loop; here the loop is *outside*, one transaction per class.

**Nesting is safe.** Both callers invoke `handleSpotFreed` outside any transaction —
`registrations/[id]/route.ts:213` opens none, and `gdpr.ts:647` runs after its erasure
transaction has committed. The auto-promote branch already opens a transaction via
`promoteNext`, so this is established shape.

**A stated consequence: under contention the broadcast is now dropped.** A `Class` row
locked for more than 2s makes `lockClassRow` time out, `handleSpotFreed` throws, and
both callers log-and-swallow (`registrations/[id]/route.ts:215`, `gdpr.ts:649`) — where today the broadcast
always fires. This is the right failure: a class row held that long means another writer
is mid-transaction on it, and the seat is likely gone by the time it commits. It is a
real behaviour change and belongs in the PR body.

### 4.5 Behaviour when the class is already full

Return `{ action: 'none' }` — an existing member of `SpotFreedResult`, so no type
changes — and **log nothing**.

The sibling branch already handles the identical event silently: it catches
`promoteNext`'s `class_full` and returns `{ action: 'none' }` under the comment *"A
concurrent registration may have refilled the spot — that's fine."* (`waitlist.ts:652`).
One event should have one story; a `log.warn` would imply an operator should act on a
benign, expected outcome where both the cancel and the refill did the right thing, and a
`log.info` would make this branch louder than its twin for no reader. The reason it is
benign goes in a comment beside the guard, where the next reader of this function is.

---

## 5. Tests, each with its mutation

Every adopted guard is re-proved, because adoption is where a `<` silently becomes a
`<=`. Per this project's rule, each mutation is run, its exact error recorded, and
reverted.

**The new guard.** Full class, students on the waitlist, clock inside the final-hour
window, then call `handleSpotFreed` directly. That state is reachable *deterministically*
— no race to stage — because `addToWaitlist` only permits queuing on a class that is
already full, so "full class with waiting entries" is the ordinary state of a waitlist.
Assert `{ action: 'none' }` and **zero** `spot_available` rows.
*Mutation:* delete the guard → the test fails on a `spot_available` row that should not
exist.

**The four adopted guards.** Each keeps its existing coverage; the mutation for each is
inverting its own comparison (`>` ↔ `>=`, and `addToWaitlist`'s inverse), proving the
adoption preserved the boundary rather than merely compiling.

**`readSeatCount`.** Unit coverage for the arithmetic including the overbooked case
(`activeCount > maxStudents` → negative `freeSeats`), since a clamp added later would
silently change what four callers mean by `<= 0`.

**The brand.** `db-locks.test.ts` already keeps a permanent `// @ts-expect-error` proving
`lockClassRow` rejects a bare `PrismaClient`; `readSeatCount` gets the same treatment, so
weakening its signature is a failing `tsc --noEmit` rather than a silently-passing suite.

`npm run verify` before pushing — it runs all three vitest projects, so a green run is
the whole integration suite, not a sample.

---

## 6. Documentation

- **`docs/lock-order.md:174`** — the `handleSpotFreed` broadcast row: no longer "outside
  any transaction". The order itself is unchanged, and the entry says why.
- **`src/lib/db-locks.ts`** — the brand register gains `readSeatCount` as an adopt, with
  its reason (§4.2). The register claims completeness, so omitting it would make the
  claim stale.
- **`docs/technical-architecture.md:191-207`** — the Waitlist sketch describes the
  behaviour this branch changes and is already wrong about it in two ways: it names
  `processWaitlist` / `openSpotToAll` / `autoPromoteNext`, none of which exist, and it
  places first-come-first-claimed *"After cancel_deadline"* when the code freezes at the
  deadline and broadcasts in the hour **before** it. Corrected, with the capacity check
  shown. Pre-existing, but this branch edits the exact behaviour it misdescribes.
- **`src/services/class-lifecycle.ts:7`** — "Full is derived (registrations >=
  maxStudents), not a stored state" gains a pointer to `capacity.ts`, now that the
  derivation has one home.
- **`src/services/class-lifecycle.ts:160-167`** — `CHARGED_STATUSES`' docblock cites
  `waitlist.ts`'s `ACTIVE_REGISTRATION_STATUSES` as the spread pattern it follows. That
  constant is moving, so the citation is re-pointed at `lib/registration-status.ts` and
  gains the cross-reference in the other direction. A live claim about another module's
  contents, exactly the kind that goes stale silently.

**Not updated, deliberately:** the project-structure listing at
`technical-architecture.md:66-80`. It already omits roughly ten services; adding
`capacity.ts` there would imply a completeness the list does not have.

---

## 7. Out of scope

- **Re-deriving `status` and `window` under the lock.** `handleSpotFreed:631` still
  decides both from a pre-lock read. Same family of race, but #174's rule is enforced by
  **#182**, which stays open; the harm is far smaller (a spot notice for a class whose
  own cancellation notice is already going out); and that read is shared with the
  auto-promote branch, so changing it changes both. A deliberate exclusion, not an
  oversight. **#182 is unaffected.**
- **Broadcasting only as many notices as there are free seats.** The issue's option 2. It
  changes the contract at `docs/product-concept.md:127` ("everyone remaining on the
  waitlist gets a notification"), so it is a product decision rather than a bug fix. The
  N−1 disappointments from one genuinely free seat remain the intended trade; this spec
  addresses only the case where the seat count is **zero**.
- **Fixing the copy instead of the behaviour.** The issue's option 3, rejected as
  dishonest in the zero-seat case.
- **`registrations/route.ts:100`'s inline unbounded lock.** #104's, and it stays inline.
- **The duplicate-broadcast problem.** Fixed separately by #196 branch 2, which scoped
  the two writes reaching this function so exactly one racer arrives. Orthogonal and
  complete.

---

## 8. Acceptance

1. The broadcast branch notifies nobody when the class has no free seat, and a test
   drives exactly that state.
2. Every guard's mutation is run and its exact error text recorded — the new one, the
   four adoptions, and the brand.
3. `ACTIVE_REGISTRATION_STATUSES` exists in exactly one place, imported by all six sites
   in §3's table. `grep -rn "'registered'" src | grep attended` returns **8 lines**:
   1 definition + 5 `CHARGED_STATUSES` inliners (out of scope, §3) + 2 test files
   (deliberate, §3). Today it returns 13. No production copy of the three-element list
   survives.
4. `readSeatCount` is the only implementation of count-and-compare-against-`maxStudents`
   in `src/`; the four pre-existing sites call it and keep their own policies.
5. `promoteNext`'s and `claimSpot`'s user-visible behaviour is byte-identical — same
   errors, same codes, same boundaries. Adoption is a refactor there, not a change.
6. `docs/lock-order.md`, the `db-locks.ts` register, and
   `docs/technical-architecture.md` agree with the code.
7. `npm run verify` green before push.
