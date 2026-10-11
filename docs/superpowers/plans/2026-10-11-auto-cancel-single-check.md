# Auto-cancel judges a class once — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An open class is judged for auto-cancel exactly once, at
`start − autoCancelCheck`, counting charged registrations (late cancellations
included); the outcome is final.

**Architecture:** A nullable `Class.autoCancelDecidedAt` records that the
decision is made. The auto-cancel sweep only selects undecided classes and,
under the existing class lock, either cancels or stamps. Teacher writes that
put an undecided open class past its check time (publish, schedule edit,
generator insert) stamp it themselves. One pure module owns the check-time
arithmetic.

**Tech Stack:** Next.js 16, TypeScript strict, Prisma + PostgreSQL, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-11-auto-cancel-single-check-design.md`

## Global Constraints

- Both settings stay: `cancelDeadline` and `autoCancelCheck` keep their enums,
  columns and form selects.
- The decision count uses `CHARGED_STATUSES` (`src/services/class-lifecycle.ts`),
  never a new list.
- A decided class is never reopened — no write clears `autoCancelDecidedAt`.
- Migration via `pnpm exec prisma migrate dev --name class_auto_cancel_decided_at`;
  never edit an applied migration, comments included.
- Comments state what is true now; no counts or member rosters in prose
  (CLAUDE.md, *Comment Discipline*). Before/after history goes in the PR body.
- Never `git add -A`/`.`; quote paths containing parentheses.

## Review Focus

1. **A class where every registrant cancelled late** (0 active, ≥ min charged)
   survives its check and is never cancelled — the teacher keeps the class and
   the late cancellers pay. Pinned in Task 2.
2. **The sweep is down across a class's check time.** On the first tick after
   the start, the class is not judged at all (`inCancelWindow` ends at the
   start) — it must not be cancelled after it began. Pinned in Task 2.
3. **The teacher's timezone, not UTC, sets the check time** — a class at 18:00
   Amsterdam with `HOURS_2` is checked at 14:00Z in summer. Pinned in Task 1.
4. **A draft moved into its window, then published** — the publish stamps it,
   so the next tick does not cancel it. Pinned in Task 3.
5. **A registration racing the check** — the existing test "does not cancel a
   class a registration brought up to minimum after the sweep read it" must
   still pass unchanged. Pinned in Task 2 (run, not rewritten).

---

### Task 1: The column and the check-time module

**Files:**
- Modify: `prisma/schema.prisma` (model `Class`, beside `spotBroadcastAt`)
- Create: `prisma/migrations/<timestamp>_class_auto_cancel_decided_at/migration.sql` (generated)
- Create: `src/lib/auto-cancel-check.ts`
- Create: `src/lib/auto-cancel-check.test.ts`
- Modify: `src/services/class-transitions.ts` (lines 28–40 and `inCancelWindow`, 73–83)

**Interfaces:**
- Produces:
  - `CANCEL_CHECK_HOURS: Record<AutoCancelCheck, number>`
  - `MAX_CANCEL_CHECK_HOURS: number` and `DEFAULT_CANCEL_CHECK_HOURS: number`
    (moved here; `class-transitions.ts` re-exports both so existing importers
    and tests keep working)
  - `cancelCheckInstant(entry: { date: Date; startTime: Date }, autoCancelCheck: AutoCancelCheck, timezone: string): Date`
  - `isPastCancelCheck(entry: { date: Date; startTime: Date }, autoCancelCheck: AutoCancelCheck, timezone: string, at: Date): boolean`
    — true when `at >= cancelCheckInstant(...)`. No upper bound: it answers
    "has the check time been reached", not "is it inside the window".

- [ ] **Step 1: Add the column**

In `model Class`, after `spotBroadcastAt DateTime?`:

```prisma
  /// When the auto-cancel decision for this class was made: by the sweep at
  /// the check time, or by a teacher write that put the class past it.
  /// Non-null means the sweep never judges this class again.
  autoCancelDecidedAt DateTime?
```

Run: `pnpm exec prisma migrate dev --name class_auto_cancel_decided_at`
Expected: one migration adding a nullable column, no backfill.

- [ ] **Step 2: Write the failing test** — `src/lib/auto-cancel-check.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { hhmmToTime } from '@/lib/time-of-day';
import { cancelCheckInstant, isPastCancelCheck } from './auto-cancel-check';

const entry = { date: new Date('2026-07-20T00:00:00Z'), startTime: hhmmToTime('18:00') };

describe('cancelCheckInstant', () => {
  it('counts back from the start in the teacher\'s timezone', () => {
    // 18:00 Amsterdam (CEST, UTC+2) is 16:00Z; HOURS_2 puts the check at 14:00Z.
    expect(cancelCheckInstant(entry, 'HOURS_2', 'Europe/Amsterdam').toISOString())
      .toBe('2026-07-20T14:00:00.000Z');
  });
});

describe('isPastCancelCheck', () => {
  it('is false a minute before the check time', () => {
    expect(isPastCancelCheck(entry, 'HOURS_2', 'Europe/Amsterdam', new Date('2026-07-20T13:59:00Z'))).toBe(false);
  });
  it('is true at the check time', () => {
    expect(isPastCancelCheck(entry, 'HOURS_2', 'Europe/Amsterdam', new Date('2026-07-20T14:00:00Z'))).toBe(true);
  });
  it('stays true after the start', () => {
    expect(isPastCancelCheck(entry, 'HOURS_2', 'Europe/Amsterdam', new Date('2026-07-20T17:00:00Z'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit src/lib/auto-cancel-check.test.ts`
Expected: FAIL — cannot resolve `./auto-cancel-check`.

- [ ] **Step 4: Implement** — `src/lib/auto-cancel-check.ts`

```ts
import type { AutoCancelCheck } from '@prisma/client';
import { classStartInstant } from '@/lib/timezone';

/** Hours before the start at which each `autoCancelCheck` value judges a class. */
export const CANCEL_CHECK_HOURS = {
  HOURS_4: 4,
  HOURS_2: 2,
  HOURS_1: 1,
} as const satisfies Record<AutoCancelCheck, number>;

export const DEFAULT_CANCEL_CHECK_HOURS = CANCEL_CHECK_HOURS.HOURS_2;

export const MAX_CANCEL_CHECK_HOURS = Math.max(...Object.values(CANCEL_CHECK_HOURS));

const HOUR_MS = 60 * 60 * 1000;

/** The instant a class is judged for auto-cancel: its local start minus its check hours. */
export function cancelCheckInstant(
  entry: { date: Date; startTime: Date },
  autoCancelCheck: AutoCancelCheck,
  timezone: string,
): Date {
  const start = classStartInstant(entry, timezone);
  return new Date(start.getTime() - CANCEL_CHECK_HOURS[autoCancelCheck] * HOUR_MS);
}

/** Whether `at` has reached the class's check time. */
export function isPastCancelCheck(
  entry: { date: Date; startTime: Date },
  autoCancelCheck: AutoCancelCheck,
  timezone: string,
  at: Date,
): boolean {
  return at >= cancelCheckInstant(entry, autoCancelCheck, timezone);
}
```

Check `DEFAULT_CANCEL_CHECK_HOURS`'s existing consumers before changing its
value's spelling; it must remain `2`.

- [ ] **Step 5: Route `class-transitions.ts` through it**

Delete the local `CANCEL_CHECK_HOURS`, `DEFAULT_CANCEL_CHECK_HOURS` and
`MAX_CANCEL_CHECK_HOURS` definitions; import them from `@/lib/auto-cancel-check`
and re-export `DEFAULT_CANCEL_CHECK_HOURS` and `MAX_CANCEL_CHECK_HOURS`
(`class-transitions.test.ts` imports both from there). Rewrite `inCancelWindow`:

```ts
function inCancelWindow(
  entry: { date: Date; startTime: Date },
  cls: { autoCancelCheck: AutoCancelCheck },
  timezone: string,
  at: Date,
): boolean {
  return (
    isPastCancelCheck(entry, cls.autoCancelCheck, timezone, at) &&
    at < classStartInstant(entry, timezone)
  );
}
```

The `?? DEFAULT_CANCEL_CHECK_HOURS` fallback goes: `cls.autoCancelCheck` is now
typed as the enum, so the lookup cannot miss. Update the docblock above
`inCancelWindow` so it names `isPastCancelCheck` as the shared spelling of the
check time.

- [ ] **Step 6: Run to verify**

Run: `pnpm exec vitest run --project unit src/lib/auto-cancel-check.test.ts && pnpm exec tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Prove the guard bites** — change `>=` to `>` in
  `isPastCancelCheck`, run the test, record the failing case ("is true at the
  check time"), restore, re-run green.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/auto-cancel-check.ts src/lib/auto-cancel-check.test.ts src/services/class-transitions.ts
git commit -m "feat: Class.autoCancelDecidedAt and one module for the check time (#836)"
```

---

### Task 2: The sweep judges once, counting charged registrations

**Files:**
- Modify: `src/services/class-transitions.ts` — `readCancelCandidatePage` (~279–328), `autoCancelClasses` (~352 onward)
- Test: `src/services/class-transitions.test.ts`

**Interfaces:**
- Consumes: `isPastCancelCheck`, `inCancelWindow` (Task 1); `CHARGED_STATUSES` from `./class-lifecycle` (already imported module: `completeClass` comes from there)
- Produces: `autoCancelClasses(db, now?)` with unchanged signature and return (number cancelled).

**Behavior after this task:**
- `readCancelCandidatePage` adds `autoCancelDecidedAt: null` to its `where`, and
  drops the per-page `groupBy` and `activeRegistrations` entirely.
- The registration-count pre-filter in the loop (`if (cls.activeRegistrations >= cls.minStudents) continue;`)
  is deleted. Its justification was cost: every healthy in-window class took a
  lock every minute. With the marker, each class is judged in one transaction
  once, then never selected again, so the cost it saved is gone. The window
  pre-filter (`inCancelWindow`) stays.
- Inside the transaction, after `lockClassRow`: the `fresh` read also selects
  `autoCancelDecidedAt`; return `false` if it is non-null.
- The decision count uses `CHARGED_STATUSES`:
  `tx.registration.count({ where: { classId: cls.id, status: { in: [...CHARGED_STATUSES] } } })`.
- If `count >= fresh.minStudents`: `tx.class.update({ where: { id: cls.id }, data: { autoCancelDecidedAt: currentTime } })` and return `false`.
- Else: the existing cancel path, with the `calendarEntry.updateMany` CAS's
  `classes: { some: { status: 'open' } }` widened to
  `classes: { some: { status: 'open', autoCancelDecidedAt: null } }`, and also
  `tx.class.update` stamping `autoCancelDecidedAt: currentTime` alongside.
  Recipient list stays `ACTIVE_REGISTRATION_STATUSES` (a late canceller of a
  cancelled class pays nothing and is not notified, as today). The teacher
  body's "only X of Y" reports the charged count.
- Rewrite the long comment block in the transaction to state what is true now.
  The `DELETE /api/registrations/[id]` paragraph: `late_cancel` is inside the
  counted set, so a racing late cancel leaves the count unchanged. A racing
  free `cancelled` (an auto-promoted student inside their grace) lowers it;
  `DELETE` takes no `Class` lock, so whether it lands before or after the
  count decides the outcome — the same as if it had arrived a moment earlier
  or later, which is the honest statement of that race. The `PUT` paragraph:
  re-derive from `registrations/[id]/route.ts`'s WHERE whether any move into
  `CHARGED_STATUSES` is possible while the class is `open`, and state only
  what that WHERE shows.
  Delete the "pre-filter" paragraph at the top of the loop and the "An earlier
  version of this comment claimed…" paragraph (history belongs in the PR body).
  Update `readCancelCandidatePage`'s docblock: it no longer counts.

- [ ] **Step 1: Write the failing tests** (in the `autoCancelClasses` describe; reuse `makeClass`, `scopeSweep`, `studentId`, `secondStudentId`, and the `finally` cleanup convention already in that file)

```ts
it('judges a class at its minimum once: a later late cancel does not cancel it', async () => {
  const cls = await makeClass({ autoCancelCheck: 'HOURS_2', minStudents: 1 });
  const reg = await prisma.registration.create({
    data: { classId: cls.id, studentId, status: 'registered', tierAtBooking: 3 },
  });
  try {
    const scoped = scopeSweep(prisma, { Class: { id: { in: [cls.id] } } });
    expect(await autoCancelClasses(scoped.db, new Date('2026-07-20T14:00:30Z'))).toBe(0);
    const judged = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(judged.autoCancelDecidedAt).not.toBeNull();

    // A free cancel would also not matter now; `cancelled` is the strongest case
    // because it leaves the charged count below the minimum.
    await prisma.registration.update({ where: { id: reg.id }, data: { status: 'cancelled' } });
    expect(await autoCancelClasses(scoped.db, new Date('2026-07-20T15:50:00Z'))).toBe(0);

    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
    expect(after.calendarEntry.cancelledAt).toBeNull();
  } finally {
    await prisma.registration.deleteMany({ where: { classId: cls.id } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
  }
});

it('counts late cancellations toward the minimum at the check', async () => {
  const cls = await makeClass({ autoCancelCheck: 'HOURS_2', minStudents: 2 });
  await prisma.registration.create({ data: { classId: cls.id, studentId, status: 'registered', tierAtBooking: 3 } });
  await prisma.registration.create({ data: { classId: cls.id, studentId: secondStudentId, status: 'late_cancel', tierAtBooking: 3 } });
  try {
    const scoped = scopeSweep(prisma, { Class: { id: { in: [cls.id] } } });
    expect(await autoCancelClasses(scoped.db, new Date('2026-07-20T14:00:30Z'))).toBe(0);
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
    expect(after.calendarEntry.cancelledAt).toBeNull();
    expect(after.autoCancelDecidedAt).not.toBeNull();
  } finally {
    await prisma.registration.deleteMany({ where: { classId: cls.id } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
  }
});

it('keeps a class every registrant cancelled late', async () => {
  const cls = await makeClass({ autoCancelCheck: 'HOURS_2', minStudents: 1 });
  await prisma.registration.create({ data: { classId: cls.id, studentId, status: 'late_cancel', tierAtBooking: 3 } });
  try {
    await autoCancelClasses(scopeSweep(prisma, { Class: { id: { in: [cls.id] } } }).db, new Date('2026-07-20T15:00:00Z'));
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
    expect(after.calendarEntry.cancelledAt).toBeNull();
  } finally {
    await prisma.registration.deleteMany({ where: { classId: cls.id } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
  }
});

it('does not judge a class whose check passed while the sweep was down, once it has started', async () => {
  const cls = await makeClass({ autoCancelCheck: 'HOURS_2', minStudents: 4 });
  try {
    expect(await autoCancelClasses(scopeSweep(prisma, { Class: { id: { in: [cls.id] } } }).db, new Date('2026-07-20T16:01:00Z'))).toBe(0);
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
    expect(after.calendarEntry.cancelledAt).toBeNull();
  } finally {
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
  }
});

it('never selects a decided class again', async () => {
  const cls = await makeClass({ autoCancelCheck: 'HOURS_2', minStudents: 4 });
  await prisma.class.update({ where: { id: cls.id }, data: { autoCancelDecidedAt: new Date('2026-07-20T14:00:00Z') } });
  try {
    const scoped = scopeSweep(prisma, { Class: { id: { in: [cls.id] } } });
    expect(await autoCancelClasses(scoped.db, new Date('2026-07-20T15:00:00Z'))).toBe(0);
    expect(scoped.rowsRead('Class')).toBe(0);
  } finally {
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
  }
});
```

Also replace two existing tests whose premise this task removes:
- **"does not open a transaction for a class that already meets its minimum"**
  → rename to **"judges a class that meets its minimum in one transaction, then never again"**:
  same `$extends` counter, but keyed on the `CHARGED_STATUSES` count; tick at
  15:00Z expects `decisionCounts === 1` and the marker set; a second tick at
  15:10Z expects `decisionCounts` still `1`.
- **"still cancels a class whose only registrations are cancelled"** → keep
  the name, but only the `cancelled` registration (drop the `late_cancel` one,
  which now counts); update its docblock to say the decision count is
  filtered so freed seats do not count.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run --project unit-sweeps src/services/class-transitions.test.ts`
(If the file is not in `SERIAL_TESTS`, use `--project unit`; check `vitest.config.*`.)
Expected: FAIL — the new tests on the missing stamp and the late-cancel count.

- [ ] **Step 3: Implement** the behavior listed above.

- [ ] **Step 4: Run to verify**

Same command. Expected: PASS, including the unchanged
"does not cancel a class a registration brought up to minimum after the sweep read it".

- [ ] **Step 5: Prove each guard bites**, recording the failing test name and error per mutation, restoring between:
  1. remove `autoCancelDecidedAt: null` from `readCancelCandidatePage` → "never selects a decided class again" fails;
  2. remove the in-lock `autoCancelDecidedAt !== null` return together with mutation 1 → "judges a class at its minimum once" fails;
  3. drop the survive-branch stamp → "judges a class at its minimum once" fails;
  4. count `ACTIVE_REGISTRATION_STATUSES` instead of `CHARGED_STATUSES` → "counts late cancellations…" and "keeps a class every registrant cancelled late" fail.

- [ ] **Step 6: Commit**

```bash
git add src/services/class-transitions.ts src/services/class-transitions.test.ts
git commit -m "feat: auto-cancel judges a class once, counting late cancellations (#836)"
```

---

### Task 3: Teacher writes past the check time stamp the decision

**Files:**
- Create: `src/services/auto-cancel-decision.ts`
- Modify: `src/services/class-lifecycle.ts` — `transitionClass` (the `$transaction` around the status CAS, ~590–610) and `updateClass` (after the `calendarEntry.updateMany`, ~1680–1700)
- Modify: `src/services/class-generator.ts` — `CLASS_GENERATOR.createChildren`
- Modify: `src/services/entry-generation.ts` — `createChildren`'s `entries` type gains `startTime: Date` (the `createManyAndReturn` rows already carry it)
- Test: `src/services/class-lifecycle.test.ts` (or wherever `transitionClass`/`updateClass` tests live — `grep -ln "transitionClass(\|updateClass(" src/services/*.test.ts`), `src/services/class-generator.test.ts`

**Interfaces:**
- Consumes: `isPastCancelCheck` (Task 1); `autoCancelDecidedAt` column (Task 1)
- Produces:
  `stampIfPastCancelCheck(tx: Prisma.TransactionClient, classId: string, now: Date): Promise<boolean>`
  — stamps `autoCancelDecidedAt = now` on an open, live, undecided class whose
  check time has been reached; returns whether it stamped. Callers must already
  hold the class lock (`lockClassRow`).

- [ ] **Step 1: Write the failing tests**

Publish (`transitionClass`), with a draft fixture whose start is 90 minutes
after a pinned `now` and `autoCancelCheck: 'HOURS_2'` — use whatever clock
control the existing `transitionClass` tests use; if none, pass the time via
`vi.setSystemTime`:

```ts
it('stamps the auto-cancel decision when a class is published inside its check window', async () => {
  // draft created 90 min before start, HOURS_2 check already passed
  const result = await transitionClass(prisma, draft.id, 'open');
  expect(result.ok).toBe(true);
  const after = await prisma.class.findUniqueOrThrow({ where: { id: draft.id } });
  expect(after.autoCancelDecidedAt).not.toBeNull();
});

it('leaves the decision open when a class is published before its check time', async () => {
  // draft starting in 3 days
  await transitionClass(prisma, draft.id, 'open');
  const after = await prisma.class.findUniqueOrThrow({ where: { id: draft.id } });
  expect(after.autoCancelDecidedAt).toBeNull();
});
```

`updateClass`: an open, undecided class 3 days out; move `date`/`startTime`
so the start is 90 minutes ahead → marker set. And a decided class moved a
week later → marker unchanged (still the original instant).

Generator (`class-generator.test.ts`): a template whose next candidate starts
inside its check window → the inserted `Class` has `autoCancelDecidedAt`
set; a candidate days ahead → `null`. Follow that file's existing fixtures
and clock control.

Sweep follow-through (Review Focus 4): after the publish-inside-window test,
`autoCancelClasses` at the same `now` returns `0` and the class is not cancelled.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run --project unit <the two test files>` (or `unit-sweeps` per `vitest.config.*`)
Expected: FAIL — marker stays `null`.

- [ ] **Step 3: Implement** — `src/services/auto-cancel-decision.ts`

```ts
import type { Prisma } from '@prisma/client';
import { isPastCancelCheck } from '@/lib/auto-cancel-check';

/**
 * Marks the auto-cancel decision as made for an open, live, undecided class
 * whose check time has already been reached. A teacher who publishes or
 * reschedules a class inside its own check window has chosen to run it, so the
 * sweep must not judge it. The caller holds the class row lock.
 */
export async function stampIfPastCancelCheck(
  tx: Prisma.TransactionClient,
  classId: string,
  now: Date,
): Promise<boolean> {
  const cls = await tx.class.findUnique({
    where: { id: classId },
    select: {
      status: true,
      autoCancelCheck: true,
      autoCancelDecidedAt: true,
      calendarEntry: {
        select: { date: true, startTime: true, cancelledAt: true, teacher: { select: { defaultTimezone: true } } },
      },
    },
  });
  if (!cls || cls.status !== 'open' || cls.autoCancelDecidedAt !== null) return false;
  if (cls.calendarEntry.cancelledAt !== null) return false;
  if (!isPastCancelCheck(cls.calendarEntry, cls.autoCancelCheck, cls.calendarEntry.teacher.defaultTimezone, now)) {
    return false;
  }
  await tx.class.update({ where: { id: classId }, data: { autoCancelDecidedAt: now } });
  return true;
}
```

Call sites:
- `transitionClass`: inside the transaction, after `if (updated.count !== 1) return false;`,
  add `if (targetStatus === 'open') await stampIfPastCancelCheck(tx, classId, new Date());`
- `updateClass`: inside the transaction, after the `hasEntryEdit` block and
  before the final `findUnique`, add `if (hasEntryEdit) await stampIfPastCancelCheck(tx, classId, new Date());`
- `CLASS_GENERATOR.createChildren`: compute once `const now = new Date();` and
  add to each row
  `autoCancelDecidedAt: isPastCancelCheck(entry, template.autoCancelCheck, template.scheduleRule.teacher.defaultTimezone, now) ? now : null`.
  Widen `createChildren`'s `entries` parameter type in `entry-generation.ts`
  to `readonly { id: string; date: Date; startTime: Date }[]`; the studio
  family's implementation ignores the extra field.

Check `docs/lock-order.md` before committing: the stamp writes only the
`Class` row the caller already locked, so no new lock order is introduced —
confirm, and say so in the commit body.

- [ ] **Step 4: Run to verify** — same command. Expected: PASS.

- [ ] **Step 5: Prove each guard bites** — remove each of the three call sites
  in turn; the matching test fails; record the error; restore.

- [ ] **Step 6: Commit**

```bash
git add src/services/auto-cancel-decision.ts src/services/class-lifecycle.ts src/services/class-generator.ts src/services/entry-generation.ts <the test files>
git commit -m "feat: publishing or rescheduling past the check time decides auto-cancel (#836)"
```

---

### Task 4: Copy and documents

**Files:**
- Modify: `src/lib/class-options.ts` — `autoCancelHint`
- Modify: `src/lib/class-options.test.ts`
- Modify: `docs/product-concept.md` (lines ~118–140)
- Modify: `docs/data-model.md` (`Class` table, ~658–662)
- Sweep: every hit of `grep -rni "auto-cancel\|autoCancel" docs src --include='*.md' --include='*.ts' -l` outside `docs/superpowers/` and `docs/audits/` — give each a verdict (stale under the new rule, or still true)

- [ ] **Step 1: Write the failing test** — in `class-options.test.ts`, assert
  `autoCancelHint('HOURS_2', 4)` ends with
  `' Late cancellations count, because they still pay.'`.

- [ ] **Step 2: Run it** — `pnpm exec vitest run --project unit src/lib/class-options.test.ts`; expect FAIL.

- [ ] **Step 3: Implement** — append `' Late cancellations count, because they still pay.'`
  to both return strings of `autoCancelHint`; update existing exact-string
  assertions in that test file and in `new-class-form.test.tsx` /
  `template-form.test.tsx` if they pin the full text.

- [ ] **Step 4: Docs**
  - `product-concept.md`, Auto-cancel check paragraph: the system checks once,
    at the chosen time; late cancellations count toward the minimum, since
    they still pay; if the minimum is met the class runs, whatever happens
    afterwards; a class published or moved inside its check window is not
    checked.
  - `data-model.md`, `Class` table: add `auto_cancel_decided_at | timestamp, nullable | When the auto-cancel decision was made; set means never judged again`.
  - Each other sweep hit: fix what the new rule makes false; leave the rest.

- [ ] **Step 5: Run** — `pnpm exec vitest run --project unit src/lib/class-options.test.ts && pnpm exec vitest run --project components`; expect PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/class-options.ts src/lib/class-options.test.ts docs/product-concept.md docs/data-model.md <other touched docs and form tests>
git commit -m "docs: auto-cancel is one check, and late cancellations count (#836)"
```

---

### Finish

- [ ] `pnpm run verify` green (dev server on :3000 must already be running — never restart it).
- [ ] `pnpm exec prisma validate` and `pnpm run build` (CI runs both; `verify` does not).
