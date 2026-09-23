# Waitlist Promotion Windows Implementation Plan (#236)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anchor the waitlist on class start: auto-promote until start − 1h, broadcast-and-claim in the final hour, frozen from start. Give auto-promoted students a free cancel until `max(deadline, promotedAt + 15 min)`, email every promotion at once, and tell students who lose a claim race.

**Architecture:** `getWaitlistWindow` drops its `cancelDeadline` input and reads only the class start. Each of its consumers follows it unchanged, except the two guards that tighten (`promoteNext`, `claimSpot`). "Who may cancel free, until when" becomes one pure predicate in `src/lib/cancel-deadline.ts`, read by the cancel route, the `/bookings` cancel button and the promotion notification. `spot_taken` is a new `NotificationType`, sent from `activateRegistration`, the function every seat fill already passes through.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma/PostgreSQL, Vitest (`unit`, `components`, `integration` projects).

**Spec:** `docs/superpowers/specs/2026-09-23-waitlist-promotion-windows-design.md`

## Global Constraints

- The claim window is exactly one hour: `[start − 1h, start)`. `'frozen'` from `start` itself (`>=`), never from the `in_progress` status flip.
- Free-cancel grace: `FREE_CANCEL_GRACE_MINUTES = 15`, a fixed constant. It applies only to a registration whose linked `WaitlistEntry.status` is `'promoted'` (auto-promotion). A claim gets none.
- `isPastCancelDeadline` keeps its strict `>`: the free-until instant itself is still free.
- A late canceller's charge is unchanged (`late_cancel` stays in `CHARGED_STATUSES`).
- Error codes are unchanged: `WAITLIST_FROZEN`, `CLAIM_NOT_OPEN`, `SPOT_TAKEN` keep their registered statuses (`src/lib/api-error-codes.ts`). Tests assert codes, not messages.
- Times shown to students are formatted **server-side** in the teacher's `defaultTimezone`. A `'use client'` component never formats an instant itself (it would SSR in UTC).
- *Comment Discipline* (CLAUDE.md): no counts or rosters in comments; comments state what is true now, and what they used to say goes in the PR body.
- Migrations: hand-write the directory from `prisma migrate diff` output and apply with `prisma migrate deploy`. `migrate dev` refuses a non-interactive shell. Migration comments describe only their own SQL.
- Not in production: no backfill, no deploy-backlog handling.
- Stage exact paths; quote paths containing `(student)` / `(public)`.

## Review Focus

1. **Grace boundary on both sides.** At `promotedAt + 15 min` exactly the cancel is free; one second later it is `late_cancel`. Pinned in Task 2 (predicate unit test) and Task 2's integration test.
2. **Promotion before the deadline but within 15 minutes of it** (05:55 for a 06:00 deadline). Free until 06:10, not 06:00. Pinned in Task 2's predicate test.
3. **A claimant who cancels right after claiming.** No grace: `late_cancel` immediately. Pinned in Task 2 (a `'claimed'` entry reads `null` grace).
4. **Two seats free in the final hour, one claimed.** The class is not full, so no `spot_taken` goes out; the remaining waiters keep a true `spot_available`. Pinned in Task 5.
5. **A class whose start is under an hour away when a seat frees.** Broadcast, never auto-promote, even though the old window (deadline-anchored) would have said `frozen`. Pinned in Task 1's `handleSpotFreed` test.

---

## Task order

Task order is load-bearing. Task 1 changes `getWaitlistWindow`'s signature, which every later task compiles against. Task 2 produces `freeCancelUntil`, which Task 3 consumes. Task 5 changes `activateRegistration`'s signature, so it must follow Task 2, which edits `claimSpot` nearby. Run them in order.

---

### Task 1: Anchor the waitlist windows on class start

**Files:**
- Modify: `src/services/waitlist.ts`: module header (lines 1-8), `getWaitlistWindow` + docblock (~183-213), `promoteNext` window guard (~556-568), `claimSpot` docblock + window guards (~659-719), `handleSpotFreed` docblock bullets (~839-849)
- Modify: `src/services/waitlist-reconciliation.ts`: `getWaitlistWindow` call (~554), the "last tick before its cancel deadline" comment (~591-595), `broadcastStillStands` (~700-718)
- Modify: `src/app/(student)/bookings/page.tsx`: `canClaim` (~212-223)
- Modify: `src/lib/scheduler.ts`: the comment that calls the claim window "60 minutes wide" before the deadline (grep `claim window`)
- Test: `src/services/waitlist.test.ts`, `src/services/waitlist-reconciliation.test.ts`, `src/services/class-transitions.test.ts`, `src/services/promote-after-cancel.test.ts` (wherever it lives; grep), `tests/integration/waitlist-api.test.ts`

**Interfaces:**
- Produces:
  - `getWaitlistWindow(entry: { date: Date; startTime: Date }, timeZone: string, now?: Date): WaitlistWindow`
  - `claimWindowStart(entry: { date: Date; startTime: Date }, timeZone: string): Date` (= class start − 1h)
  - `CLAIM_WINDOW_MINUTES = 60` (exported)
  - `WaitlistWindow` keeps its three members.

- [ ] **Step 1: Rewrite the pure `getWaitlistWindow` tests (failing)**

Replace the `describe('getWaitlistWindow')` block's cases with start-anchored ones. The deadline no longer appears:

```ts
describe('getWaitlistWindow', () => {
  // Class starts 2026-04-10 09:00 UTC. Claim window opens 08:00.
  const entry = { date: new Date('2026-04-10'), startTime: hhmmToTime('09:00') };

  it('auto-promotes until one hour before start, whatever the cancel deadline', () => {
    // 3 h before start: past every DEADLINE_HOURS value, still auto_promote.
    expect(getWaitlistWindow(entry, 'UTC', new Date('2026-04-10T06:00:00Z'))).toBe('auto_promote');
    expect(getWaitlistWindow(entry, 'UTC', new Date('2026-04-10T07:59:59Z'))).toBe('auto_promote');
  });

  it('is first_come_first_claimed from start − 1h up to start', () => {
    expect(getWaitlistWindow(entry, 'UTC', new Date('2026-04-10T08:00:00Z'))).toBe('first_come_first_claimed');
    expect(getWaitlistWindow(entry, 'UTC', new Date('2026-04-10T08:59:59Z'))).toBe('first_come_first_claimed');
  });

  it('is frozen from start itself', () => {
    expect(getWaitlistWindow(entry, 'UTC', new Date('2026-04-10T09:00:00Z'))).toBe('frozen');
  });

  it('reads the start in the teacher timezone', () => {
    // 09:00 Amsterdam (CEST, UTC+2) = 07:00 UTC; the window opens 06:00 UTC.
    expect(getWaitlistWindow(entry, 'Europe/Amsterdam', new Date('2026-04-10T06:00:00Z'))).toBe('first_come_first_claimed');
    expect(getWaitlistWindow(entry, 'Europe/Amsterdam', new Date('2026-04-10T05:59:59Z'))).toBe('auto_promote');
  });
});

describe('claim window vs cancel deadline', () => {
  // Every claim happens after the cancel deadline, which is why the claim
  // warning is unconditional. A shorter deadline would make it false.
  it('the shortest cancel deadline is longer than the claim window', () => {
    expect(Math.min(...Object.values(DEADLINE_HOURS)) * 60).toBeGreaterThan(CLAIM_WINDOW_MINUTES);
  });
});
```

Keep any existing DST cases in that block, rewritten against start instead of deadline.

- [ ] **Step 2: Run them. They fail (wrong arity / wrong window)**

Run: `pnpm exec vitest run src/services/waitlist.test.ts -t "getWaitlistWindow|claim window vs"`
Expected: FAIL (a type error in the IDE; at runtime the old function reads `'UTC'` as a deadline enum and returns the wrong window).

- [ ] **Step 3: Implement**

```ts
/** Length of the first-come-first-claimed window that ends at class start. */
export const CLAIM_WINDOW_MINUTES = 60;

/** When the first-come-first-claimed window opens: class start − `CLAIM_WINDOW_MINUTES`. */
export function claimWindowStart(entry: { date: Date; startTime: Date }, timeZone: string): Date {
  const start = classStartInstant(entry, timeZone);
  return new Date(start.getTime() - CLAIM_WINDOW_MINUTES * 60 * 1000);
}

/**
 * Which promotion window the waitlist is in, anchored on class start (#236):
 * - before `claimWindowStart` → 'auto_promote'
 * - from `claimWindowStart` until start → 'first_come_first_claimed'
 * - from start → 'frozen'
 *
 * The cancel deadline plays no part: it decides who pays, not who is asked.
 */
export function getWaitlistWindow(
  entry: { date: Date; startTime: Date },
  timeZone: string,
  now?: Date,
): WaitlistWindow {
  const currentTime = now ?? new Date();
  const start = classStartInstant(entry, timeZone);
  if (currentTime >= start) return 'frozen';
  if (currentTime >= claimWindowStart(entry, timeZone)) return 'first_come_first_claimed';
  return 'auto_promote';
}
```

Rewrite the module header to the three start-anchored windows. Update every call site to `getWaitlistWindow(cls.calendarEntry, cls.calendarEntry.teacher.defaultTimezone, now)`. `pnpm run typecheck` lists them all.

- [ ] **Step 4: Tighten the two guards**

`promoteNext`: refuse anything but `auto_promote`, keeping `window_frozen` for frozen and using `wrong_window` for the claim hour.

```ts
if (window === 'frozen') {
  throw new WaitlistPromotionError('The waitlist is closed — the class has started', 'window_frozen');
}
if (window !== 'auto_promote') {
  throw new WaitlistPromotionError(
    'In the final hour before class a freed spot is offered to everyone waiting, not promoted',
    'wrong_window',
  );
}
```

Check that `wrong_window` is already a member of the `WaitlistPromotionError` reason union. If `promoteNext`'s callers switch exhaustively on it, the compiler will say so.

`claimSpot`: same two checks, the other way round. Messages:
- frozen: `'The class has started, so spots can no longer be claimed.'`
- not in the claim window: `'Spots can be claimed in the final hour before class — before that the queue promotes automatically.'`

Rewrite `claimSpot`'s and `handleSpotFreed`'s docblock bullets to "final hour before class" and "from class start: frozen".

- [ ] **Step 5: Reconciliation**

`broadcastStillStands` compares `cls.spotBroadcastAt >= claimWindowStart(cls.calendarEntry, tz)`, and `cancelDeadlineInstant` drops out of this file if nothing else uses it. Rewrite the "last tick before its cancel deadline" paragraph to the same argument at class start: a class read as full on the last tick before start is `frozen` on the next one. Rewrite the docblock above `broadcastStillStands` wherever it names the deadline.

`/bookings` `canClaim`: pass the entry and the timezone. Its comment becomes "In the final hour before class …".

`scheduler.ts`: rewrite the claim-window sentence to "the final hour before class".

- [ ] **Step 6: Fix every existing test pinned to the old boundary**

Run: `pnpm exec vitest run src/services/waitlist.test.ts src/services/waitlist-reconciliation.test.ts src/services/class-transitions.test.ts`
Each failure is a fixture that set `now` relative to the deadline. Move its `now` so it expresses the same intent against start: `IN_CLAIM_WINDOW` → start − 30 min, `AT_DEADLINE` → `AT_START` (start itself), `BEFORE_CUTOFF` → start − 2 h. Rename constants to match, and rewrite each fixture's boundary comment to name start. A test asserting "past the deadline → frozen" becomes "at start → frozen". Its intent is "the window is closed", and that moved.

- [ ] **Step 7: Add the tests that pin the new behaviour**

In `describe('promoteNext (DB)')`, using that block's existing full-class fixture:

```ts
it('promotes after the cancel deadline while more than an hour remains (#236)', async () => {
  // start 2026-06-01 09:00 UTC, HOURS_24 deadline 2026-05-31 09:00 — now is past it.
  const entry = await promoteNext(prisma, classId, { now: new Date('2026-06-01T06:00:00Z') });
  expect(entry?.status).toBe('promoted');
});

it('refuses in the final hour before class (#236)', async () => {
  await expect(
    promoteNext(prisma, classId, { now: new Date('2026-06-01T08:30:00Z') }),
  ).rejects.toMatchObject({ reason: 'wrong_window' });
});
```

(Use whatever property name `WaitlistPromotionError` exposes for its code; read the class.)

In `describe('handleSpotFreed (DB)')`: a class with a free seat and a waiting queue, `now` = start − 30 min, cancel deadline long past → `{ action: 'broadcast' }` and one `spot_available` per waiter. The same class at start − 2 h → `{ action: 'promoted' }`. (Review Focus 5.)

`tests/integration/waitlist-api.test.ts`: the case "class starting in 5h with HOURS_6 expects `WAITLIST_FROZEN`" now expects `CLAIM_NOT_OPEN`, because 5 h out is the auto-promote window. Add a case for a class starting in 30 min with a free seat: the claim succeeds.

- [ ] **Step 8: Mutation-test the guards**

For each, apply, run the named test, record the exact failure text in the task report, restore, and check `git status` is clean before the next:
1. `promoteNext`: `if (window !== 'auto_promote')` → `if (window === 'frozen')` (the old guard). Expect "refuses in the final hour" to fail.
2. `getWaitlistWindow`: `currentTime >= start` → `currentTime > start`. Expect "is frozen from start itself" to fail.
3. `claimWindowStart`: `- CLAIM_WINDOW_MINUTES` → `- 2 * CLAIM_WINDOW_MINUTES`. Expect the `08:00`/`07:59:59` boundary cases to fail.
4. `broadcastStillStands`: return `cls.spotBroadcastAt !== null` without the window bound. Expect the existing rescheduled-class reconciliation test to fail. If none fails, add one and say so in the report.

- [ ] **Step 9: Run the unit suites, typecheck, commit**

Run: `pnpm run typecheck && pnpm exec vitest run src/services`
Expected: PASS

```bash
git add src/services/waitlist.ts src/services/waitlist.test.ts src/services/waitlist-reconciliation.ts src/services/waitlist-reconciliation.test.ts src/services/class-transitions.test.ts src/lib/scheduler.ts "src/app/(student)/bookings/page.tsx" tests/integration/waitlist-api.test.ts
# plus the promote-after-cancel test file if it changed
git commit -m "feat(waitlist): anchor the promotion windows on class start (#236)"
```

---

### Task 2: Free-cancel grace for auto-promoted students

**Files:**
- Modify: `src/lib/cancel-deadline.ts`: add `FREE_CANCEL_GRACE_MINUTES`, `freeCancelUntil`
- Test: `src/lib/cancel-deadline.test.ts` (create if absent)
- Modify: `src/lib/timezone.ts`: add `formatInstantInZone`
- Test: `src/lib/timezone.test.ts`
- Modify: `src/services/waitlist.ts`: `claimSpot` writes `'claimed'`; `promoteNext`'s `waitlist_promoted` body names the free-until time
- Modify: `src/app/api/registrations/[id]/route.ts`: the student branch reads the grace; rewrite the comment claiming "the waitlist is frozen, so `handleSpotFreed` sends nothing here" (~308)
- Test: `src/services/waitlist.test.ts`, `tests/integration/registrations-api.test.ts` (or whichever integration file holds the late-cancel cases; grep `late_cancel`)

**Interfaces:**
- Consumes: Task 1's `getWaitlistWindow` (no direct use; `promoteNext` runs only in `auto_promote` now)
- Produces:
  - `FREE_CANCEL_GRACE_MINUTES = 15`
  - `freeCancelUntil(deadline: Date, promotedAt: Date | null): Date`
  - `formatInstantInZone(instant: Date, timeZone: string): string`, e.g. `"Thu 14:15"`
  - `WaitlistEntry.status = 'claimed'` for a claim; `'promoted'` means auto-promotion only

- [ ] **Step 1: Failing predicate tests**

```ts
import { freeCancelUntil, isPastCancelDeadline, FREE_CANCEL_GRACE_MINUTES } from './cancel-deadline';

const deadline = new Date('2026-06-01T06:00:00Z');
const at = (iso: string) => new Date(iso);

describe('freeCancelUntil', () => {
  it('is the deadline for a booking that was not auto-promoted', () => {
    expect(freeCancelUntil(deadline, null)).toEqual(deadline);
  });
  it('is the deadline when the promotion was 15+ minutes before it', () => {
    expect(freeCancelUntil(deadline, at('2026-06-01T03:00:00Z'))).toEqual(deadline);
    expect(freeCancelUntil(deadline, at('2026-06-01T05:45:00Z'))).toEqual(deadline);
  });
  it('extends past the deadline for a promotion inside its last 15 minutes', () => {
    expect(freeCancelUntil(deadline, at('2026-06-01T05:55:00Z'))).toEqual(at('2026-06-01T06:10:00Z'));
  });
  it('gives 15 minutes to a promotion after the deadline', () => {
    expect(freeCancelUntil(deadline, at('2026-06-01T14:00:00Z'))).toEqual(at('2026-06-01T14:15:00Z'));
  });
  it('the free-until instant itself is still free; one second later is not', () => {
    const until = freeCancelUntil(deadline, at('2026-06-01T14:00:00Z'));
    expect(isPastCancelDeadline(until, at('2026-06-01T14:15:00Z'))).toBe(false);
    expect(isPastCancelDeadline(until, at('2026-06-01T14:15:01Z'))).toBe(true);
  });
  it('the grace is fifteen minutes', () => {
    expect(FREE_CANCEL_GRACE_MINUTES).toBe(15);
  });
});
```

And for `formatInstantInZone`:

```ts
it('formats weekday and 24h time in the given zone', () => {
  // 2026-06-04 is a Thursday; 12:15 UTC = 14:15 CEST.
  expect(formatInstantInZone(new Date('2026-06-04T12:15:00Z'), 'Europe/Amsterdam')).toBe('Thu 14:15');
});
```

- [ ] **Step 2: Run. Fails (not exported)**

Run: `pnpm exec vitest run src/lib/cancel-deadline.test.ts src/lib/timezone.test.ts`

- [ ] **Step 3: Implement**

```ts
/** How long an auto-promoted student may cancel for free after being promoted. */
export const FREE_CANCEL_GRACE_MINUTES = 15;

/**
 * Until when a booking can be cancelled free: the cancel deadline, or — for a
 * booking an auto-promotion made — the later of that and promotion + grace.
 * `promotedAt` is null for every other booking.
 */
export function freeCancelUntil(deadline: Date, promotedAt: Date | null): Date {
  if (promotedAt === null) return deadline;
  const graceEnd = new Date(promotedAt.getTime() + FREE_CANCEL_GRACE_MINUTES * 60 * 1000);
  return graceEnd > deadline ? graceEnd : deadline;
}
```

`formatInstantInZone` uses `Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone })` and joins the parts as `"Thu 14:15"`. Reuse whatever invalid-timezone fallback `classStartInstant` uses (#145) so a bad stored zone degrades to UTC instead of throwing.

- [ ] **Step 4: `claimSpot` records a claim as `'claimed'` (failing test first)**

In `describe('claimSpot (DB)')`, extend the existing successful-claim test:

```ts
expect(result.outcome).toBe('claimed');
if (result.outcome === 'claimed') expect(result.entry.status).toBe('claimed');
```

Run it, see `'promoted'`, then change `claimSpot`'s entry update to `status: 'claimed'`. Before committing, grep every reader of the two literals (`grep -rn "'promoted'\|'claimed'" src tests` plus `FULFILLED_WAITLIST_STATUSES`, `CLAIMABLE_WAITLIST_STATUSES`, `lib/waitlist-status.ts`). Give each hit a verdict in the task report: unaffected (reads both), or needs a change.

- [ ] **Step 5: The cancel route reads the grace (integration test first)**

In the integration file holding the late-cancel cases, add two cases. The route reads the real clock, so build the class relative to `Date.now()`. Use the file's existing helpers for a student session and a class with a `HOURS_6` deadline starting ~3 h out (so the deadline is already past):

- A registration whose linked `WaitlistEntry` is `status: 'promoted', promotedAt: now − 5 min` → `DELETE` answers `status: 'cancelled'`, and the row is `cancelled` (not charged).
- The same with `promotedAt: now − 16 min` → `late_cancel`.
- The same with `status: 'claimed', promotedAt: now − 1 min` → `late_cancel` (Review Focus 3).

Run: `pnpm exec vitest run --project integration <that file>` (worktree: `pnpm run worktree:up` first). Expected: the first case FAILS (`late_cancel`).

Implement in the student branch of `DELETE`:

```ts
const promotion = await prisma.waitlistEntry.findUnique({
  where: { registrationId: id },
  select: { status: true, promotedAt: true },
});
const until = freeCancelUntil(
  deadline,
  promotion?.status === 'promoted' ? promotion.promotedAt : null,
);
if (isPastCancelDeadline(until, new Date())) {
```

Rewrite the late branch's comment. The "waitlist is frozen" sentence is false now. The scope still exists for money, so keep that half and drop the waitlist half. Keep the `booking_cancelled` body. It still says the deadline passed, which remains true for anyone reaching that branch.

- [ ] **Step 6: The promotion notification names the free-until time**

In `promoteNext`, compute `cancelDeadlineInstant(...)`, then `freeCancelUntil(deadline, promotedAt)` with the same `promotedAt` value written to the entry. Hoist that `new Date()` into one local used for both. Body:

```ts
body: `A spot opened in ${cls.calendarEntry.classType} and you moved off the waitlist. You can cancel for free until ${formatInstantInZone(until, tz)}.`,
```

Test in `describe('promoteNext (DB)')`: with `now` after the deadline, the notification body contains the promotion instant + 15 min formatted in the teacher's zone. The fixture teacher's zone is UTC, so compute the expected string with `formatInstantInZone` on the known instant.

Note: `promotedAt` is written with the wall clock, not `opts.now`. If the test needs a deterministic `promotedAt`, make `promoteNext` use `opts.now ?? new Date()` for the entry's `promotedAt`. Say so in the report; it is the same value the test injects everywhere else.

- [ ] **Step 7: Mutation-test**

1. `freeCancelUntil`: `graceEnd > deadline ? graceEnd : deadline` → `deadline`. Expect the 05:55 and 14:00 cases to fail.
2. Route: `promotion?.status === 'promoted'` → `promotion !== null`. Expect the `claimed` integration case to fail.
3. `claimSpot`: `'claimed'` → `'promoted'`. Expect Step 4's assertion to fail.
Record the failure text; restore; `git status` clean.

- [ ] **Step 8: Run and commit**

Run: `pnpm run typecheck && pnpm exec vitest run src/lib src/services/waitlist.test.ts && pnpm exec vitest run --project integration <late-cancel file>`

```bash
git add src/lib/cancel-deadline.ts src/lib/cancel-deadline.test.ts src/lib/timezone.ts src/lib/timezone.test.ts src/services/waitlist.ts src/services/waitlist.test.ts "src/app/api/registrations/[id]/route.ts" tests/integration/<late-cancel file>
git commit -m "feat(bookings): an auto-promoted student can cancel free for 15 minutes (#236)"
```

---

### Task 3: Student-facing copy on /bookings and in the claim flow

**Files:**
- Modify: `src/app/(student)/bookings/page.tsx`: pass `CancelBookingButton` the free-until instant and a server-formatted label
- Modify: `src/components/student/cancel-booking-button.tsx`
- Modify: `src/components/student/waitlist-entry-actions.tsx`: claim warning, docblocks (lines 11, 16)
- Modify: `src/services/waitlist.ts`: `spot_available` body (~983), `claimSpot`'s `booking_confirmed` body (~770)
- Test: the components tests for both components (grep `cancel-booking-button`, `waitlist-entry-actions` under `src/components` / `tests/components`), `src/services/waitlist.test.ts`

**Interfaces:**
- Consumes: `freeCancelUntil`, `formatInstantInZone` (Task 2)
- Produces: `CancelBookingButton` props become `{ registrationId: string; freeCancelUntilAt: string /* ISO */; freeCancelUntilLabel: string /* e.g. "Thu 14:15" */ }`

- [ ] **Step 1: Failing component tests**

`CancelBookingButton`:
- Rendered with `freeCancelUntilAt` in the future and label `"Thu 14:15"`, tapping **Cancel booking** shows `Cancel this booking? Free until Thu 14:15 — after that the class is still charged.`
- With `freeCancelUntilAt` in the past, it shows the existing past-deadline copy (unchanged).
- The existing #664 "held while open" test keeps passing against the renamed prop.

`WaitlistEntryActions` with `canClaim`: the claim button's surrounding text includes `Claiming books you in, and you'll pay your share even if you can't make it.`

- [ ] **Step 2: Run. Fails**

Run: `pnpm exec vitest run --project components <both files>`

- [ ] **Step 3: Implement**

`CancelBookingButton`: drop `cancelDeadline` and `DEADLINE_LABELS`. The label is computed server-side and covers both the deadline and the grace case. `pastDeadline` reads `isPastCancelDeadline(new Date(freeCancelUntilAt), new Date())` inside the tap handler, as today. The non-past copy is `` `Cancel this booking? Free until ${freeCancelUntilLabel} — after that the class is still charged.` ``. Update the prop docblock to name `freeCancelUntil`.

`/bookings`: extend the registrations query to select the registration's `waitlistEntry { status, promotedAt }` (the relation is `WaitlistEntry.registration` ↔ `Registration.waitlistEntry`; check the relation name in `schema.prisma`). Compute:

```ts
const tz = cls.calendarEntry.teacher.defaultTimezone;
const until = freeCancelUntil(
  cancelDeadlineInstant(cls.calendarEntry, cls.cancelDeadline, tz),
  reg.waitlistEntry?.status === 'promoted' ? reg.waitlistEntry.promotedAt : null,
);
// → freeCancelUntilAt={until.toISOString()} freeCancelUntilLabel={formatInstantInZone(until, tz)}
```

The route (Task 2) and the page must read the same instant. Pull the "find the promotion, compute `until`" pair into one server helper if both sites would otherwise repeat it: `freeCancelUntilForRegistration(...)` in `src/services/`, or wherever `cancelDeadlineInstant` naturally sits. Decide in the task and say which.

`WaitlistEntryActions`: render the warning line above the claim button when `canClaim`. Docblocks: "final hour before class — first claim wins".

Service copy:
- `spot_available` body: `` `A spot opened in ${classType}. Claim it in the app to take it — the first claim gets it.` ``
- claim `booking_confirmed` body: `` `You claimed the open spot in ${classType}. It's past the cancellation deadline, so this class is charged even if you can't make it.` ``
Update the service tests asserting either body.

- [ ] **Step 4: Server-render check for the label**

A `renderToStaticMarkup` test of `CancelBookingButton` shows the label passed in verbatim, proving the component does no formatting of its own. (The confirm copy only appears after a tap, so assert on the prop flow in the page instead if static markup cannot reach it; say which in the report.)

- [ ] **Step 5: Run and commit**

Run: `pnpm run typecheck && pnpm exec vitest run --project components && pnpm exec vitest run src/services/waitlist.test.ts`

```bash
git add "src/app/(student)/bookings/page.tsx" src/components/student/cancel-booking-button.tsx src/components/student/waitlist-entry-actions.tsx src/services/waitlist.ts src/services/waitlist.test.ts <component test files>
git commit -m "feat(bookings): show the free-cancel time and warn before a claim (#236)"
```

---

### Task 4: Email every waitlist promotion without the unread wait

**Files:**
- Modify: `src/services/notification-policy.ts`: `isEmailEligible` gains the notification type
- Modify: `src/services/notifications.ts` (~150-205): pass `n.type`; update the docblock at ~152
- Test: `src/services/notification-policy.test.ts`, and the email-fallback candidate test (grep `isEmailEligible` / `emailFallbackCandidates` in tests)

**Interfaces:**
- Produces: `isEmailEligible(input: { type: NotificationType; createdAt: Date; classStart: Date | null }, now: Date, thresholdMinutes: number): boolean`, and `IMMEDIATE_EMAIL_TYPES: ReadonlySet<NotificationType>` containing `waitlist_promoted`

- [ ] **Step 1: Failing test**

```ts
it('a waitlist promotion is eligible the moment it is created', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  expect(
    isEmailEligible({ type: 'waitlist_promoted', createdAt: now, classStart: new Date('2026-06-02T12:00:00Z') }, now, 30),
  ).toBe(true);
});
it('another type a day before class still waits out the threshold', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  expect(
    isEmailEligible({ type: 'booking_confirmed', createdAt: now, classStart: new Date('2026-06-02T12:00:00Z') }, now, 30),
  ).toBe(false);
});
```

- [ ] **Step 2: Run. Fails.** `pnpm exec vitest run src/services/notification-policy.test.ts`

- [ ] **Step 3: Implement**

```ts
/**
 * Types emailed on the first fallback sweep after they are created, not after
 * the unread threshold. A waitlist promotion is a booking the student did not
 * make at that moment, and its free-cancel window is shorter than the threshold.
 */
export const IMMEDIATE_EMAIL_TYPES: ReadonlySet<NotificationType> = new Set(['waitlist_promoted']);
```

`isEmailEligible` returns `true` first when `IMMEDIATE_EMAIL_TYPES.has(input.type)`. Update existing callers and tests to pass `type`. "Unread only" is unchanged: the candidate query already excludes read rows. Leave it.

- [ ] **Step 4: Mutation-test.** Remove the `IMMEDIATE_EMAIL_TYPES` check. Expect the first test to fail. Record, restore.

- [ ] **Step 5: Run and commit**

Run: `pnpm run typecheck && pnpm exec vitest run src/services/notification-policy.test.ts src/services/notifications.test.ts src/services/email-fallback.test.ts`

```bash
git add src/services/notification-policy.ts src/services/notification-policy.test.ts src/services/notifications.ts <touched tests>
git commit -m "feat(notifications): email a waitlist promotion on the next sweep (#236)"
```

---

### Task 5: Tell the waiting students when a broadcast seat is taken

**Files:**
- Modify: `prisma/schema.prisma`: `NotificationType` gains `spot_taken`
- Create: `prisma/migrations/<timestamp>_spot_taken_notification/migration.sql`
- Modify: `src/lib/notification-retention.ts` (`spot_taken: SHORT_RETENTION_DAYS`), `src/lib/email-templates.ts` (student intro `'A spot you were waiting for has been taken.'`), `src/services/notification-policy.ts` (`ESSENTIAL_NOTIFICATION_TYPES` gains `spot_taken`)
- Modify: `src/services/waitlist.ts`: `activateRegistration` takes the class lock and sends `spot_taken`; its three callers pass `lock`
- Modify: `src/app/api/registrations/route.ts`: pass `lock` to `activateRegistration`
- Test: `src/services/waitlist.test.ts`

**Interfaces:**
- Consumes: `lockClassRow`'s lock token type (`src/lib/db-locks.ts`), `readSeatCount(tx, lock)` (`src/services/capacity.ts`)
- Produces: `activateRegistration(tx, lock, input)`

- [ ] **Step 1: Schema + migration**

Add `spot_taken` to the enum after `spot_available`. Generate the SQL with
`pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`.
Hand-write the migration directory with that output (an `ALTER TYPE "NotificationType" ADD VALUE 'spot_taken';`), plus at most a comment describing that one statement. Apply with `pnpm exec prisma migrate deploy`, then `pnpm exec prisma generate`. The compiler now flags `NOTIFICATION_RETENTION_DAYS` and any other `Record<NotificationType, …>`. Fill each one.

- [ ] **Step 2: Failing service tests**

In `describe('claimSpot (DB)')`, with a class holding **two** waiters, a standing broadcast, and one free seat:

```ts
it('tells the other waiting students when the claim fills the class (#236)', async () => {
  // waiterA claims the one free seat; waiterB is still waiting.
  await claimSpot(prisma, classId, waiterAId, IN_CLAIM_WINDOW);
  const taken = await prisma.notification.findMany({ where: { relatedClassId: classId, type: 'spot_taken' } });
  expect(taken.map((n) => n.recipientId)).toEqual([waiterBId]);
});

it('sends nothing while a seat is still free (#236)', async () => {
  // Two free seats: after one claim, the class is not full.
  await claimSpot(prisma, twoSeatClassId, waiterAId, IN_CLAIM_WINDOW);
  expect(await prisma.notification.count({ where: { relatedClassId: twoSeatClassId, type: 'spot_taken' } })).toBe(0);
});

it('sends nothing when no broadcast stood (#236)', async () => {
  // Auto-promote window: promoteNext fills the seat; spotBroadcastAt was null.
  await promoteNext(prisma, classId, { now: BEFORE_CLAIM_WINDOW });
  expect(await prisma.notification.count({ where: { relatedClassId: classId, type: 'spot_taken' } })).toBe(0);
});
```

Build the fixtures with the describe's existing helpers. Set `spotBroadcastAt` directly on the class to stand for "a broadcast went out". A direct `POST /api/registrations` booking filling a broadcast seat is covered by the same code path. Add one integration case for it if the file already has a booking-with-waitlist fixture, otherwise note it in the report.

- [ ] **Step 3: Run. Fails.**

- [ ] **Step 4: Implement in `activateRegistration`**

```ts
export async function activateRegistration(
  tx: PrismaTransactionClient,
  lock: ClassRowLock, // the token type lockClassRow returns
  input: { classId: string; studentId: string; tierAtBooking: number; isWalkIn?: boolean },
) {
  const before = await tx.class.findUniqueOrThrow({
    where: { id: input.classId },
    select: { spotBroadcastAt: true, calendarEntry: { select: { classType: true } } },
  });
  await tx.class.update({ where: { id: input.classId }, data: { spotBroadcastAt: null } });

  const registration = /* existing upsert, unchanged */;

  // A broadcast stood and this fill used the last seat: everyone still waiting
  // was told a spot exists that no longer does.
  if (before.spotBroadcastAt !== null && (await readSeatCount(tx, lock)).isFull) {
    const waiting = await tx.waitlistEntry.findMany({
      where: { classId: input.classId, status: 'waiting', studentId: { not: input.studentId } },
      select: { studentId: true },
    });
    await createBulkNotifications(tx, waiting.map((w) => ({
      recipientType: 'student' as const,
      recipientId: w.studentId,
      type: 'spot_taken' as const,
      title: 'The spot has been taken',
      body: `The open spot in ${before.calendarEntry.classType} has been taken. You're still on the waitlist.`,
      relatedClassId: input.classId,
    })));
  }
  return registration;
}
```

The claimant's own entry is still `waiting` when `activateRegistration` runs in `claimSpot` (it is updated afterward). The `studentId: { not: … }` filter is what excludes them. A test pins that the claimant receives no `spot_taken`. Extend the first test with `expect(...).not.toContain(waiterAId)`.

Update the `activateRegistration` docblock: it now also sends `spot_taken` when a standing broadcast's last seat fills. Keep the existing paragraph about why the clear is unconditional.

- [ ] **Step 5: Mutation-test**
1. Drop the `.isFull` condition. Expect "sends nothing while a seat is still free" to fail.
2. Drop `studentId: { not: input.studentId }`. Expect the claimant exclusion to fail.
3. Drop `before.spotBroadcastAt !== null`. Expect "sends nothing when no broadcast stood" to fail.
Record, restore, `git status` clean.

- [ ] **Step 6: Run and commit**

Run: `pnpm run typecheck && pnpm exec vitest run src/services src/lib`

```bash
git add prisma/schema.prisma prisma/migrations/<dir>/migration.sql src/lib/notification-retention.ts src/lib/email-templates.ts src/services/notification-policy.ts src/services/waitlist.ts src/services/waitlist.test.ts src/app/api/registrations/route.ts
git commit -m "feat(waitlist): tell the waiting students when the broadcast spot is taken (#236)"
```

---

### Task 6: Join-waitlist copy and the documentation sweep

**Files:**
- Modify: `src/components/booking/booking-flow.tsx`: a line beside **Join the waitlist**
- Modify: `CLAUDE.md` (Waitlist (Hybrid Promotion)), `docs/product-concept.md`, `docs/data-model.md`, `docs/technical-architecture.md`, `docs/implementation-plan.md`
- Modify: any remaining source comment the sweep finds (known: `src/app/api/waitlist/claim/route.ts` docblock, `src/app/api/registrations/[id]/route.ts` ~349, ~510-516, ~545-552, `src/services/gdpr.ts` ~961-963)
- Test: the booking-flow component test

- [ ] **Step 1: Failing component test**

With `isFull`, the booking flow shows: `If a spot opens up until 1 hour before class, you're booked automatically. The usual cancellation deadline applies, with at least 15 minutes to change your mind.`

- [ ] **Step 2: Implement it** as a `type-caption` line under the button, only when `isFull`. Run the component test.

- [ ] **Step 3: Derive the sweep, don't take it from this plan**

Run:
```bash
grep -rniE "final hour before (the )?deadline|frozen after|deadline.{0,40}(waitlist|promot|claim)|(waitlist|promot|claim).{0,40}deadline|60 minutes wide|claim window" src docs CLAUDE.md --include=*.ts --include=*.tsx --include=*.md
```
Give every hit a verdict in the task report: rewritten, or still true (for example a sentence about the cancel deadline's own charge rule). Exclude `docs/superpowers/` (specs and plans are records, not live docs). Also grep for the names Task 1 removed from call sites (`cancelDeadline` arguments to `getWaitlistWindow`) to catch prose describing the old signature.

CLAUDE.md's Waitlist section becomes:
- Until 1 hour before class: auto-promote the next in queue. An auto-promoted student can cancel free until the later of the cancel deadline and 15 minutes after promotion.
- Final hour before class: broadcast to everyone waiting, first to claim gets the seat. A claim is past the cancel deadline and charged.
- From class start: frozen.
Keep the Retention bullet.

- [ ] **Step 4: Commit**

```bash
git add src/components/booking/booking-flow.tsx <its test> CLAUDE.md docs/product-concept.md docs/data-model.md docs/technical-architecture.md docs/implementation-plan.md <each source file the sweep touched>
git commit -m "docs: the waitlist promotes until an hour before class (#236)"
```

---

## After the tasks

- Whole-branch review (6 tasks), one fix wave, one scoped re-review (solve-issue §5).
- `pnpm run verify` in the worktree (`worktree:setup` / `worktree:up`), then push and open the PR. The PR body records the premise corrections from the spec, the before/after of every comment rewritten, and the test arithmetic of the green run.
