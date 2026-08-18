# Past-Start Guard Implementation Plan (#249)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refuse any write that newly places a `Class`'s start instant in the past — a reschedule through `updateClass`, and a `draft -> open` publish through `transitionClass`.

**Architecture:** One pure predicate in `src/lib/timezone.ts` wrapping the existing `classStartInstant`, called from two service guards. Both refusals are typed values the routes answer as 409. No database trigger and no CHECK constraint: an `open` class whose start has passed is a state the class generator legitimately produces, so there is no invariant for the database to hold — see the spec's §3 before arguing otherwise.

**Tech Stack:** Next.js 14 App Router, TypeScript `strict`, Prisma/PostgreSQL, Vitest (three projects: `unit`, `components`, `integration`), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-18-past-start-guard-design.md`. Read §3 (why this is not a DB constraint), §5 (the two doors), §6 (what is deliberately left alone) and §7 (blast radius) before Task 2.

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types. `noUncheckedIndexedAccess` is on — indexing is `T | undefined`.
- **Test-first.** Every step below writes the test, runs it red, then implements. A guard that has never been seen to fail certifies nothing.
- **Every guard gets a mutation.** Break it, record the exact error text in the task's commit or the PR body, restore, re-run. A mutation must use a value the code under test cannot otherwise produce.
- **No fixture may rely on the current clock.** Past fixtures are dated `2020-01-01`, future fixtures `2099-06-01`. The real clock sits between them for seventy years. Do **not** inject a `now` into any service.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths containing parentheses: `"src/app/(teacher)/…"`.
- **Never start or restart the dev server on :3000.** The user runs it; integration tests need it live.
- **`@/lib/log` is pino and server-only.** `src/lib/timezone.ts` already imports it, which is why Task 1 adds nothing new there — but do not import `timezone.ts` into a `'use client'` component value-side.
- **Commit per task.** The PR is rebase-merged, so the per-task history is the record.
- **Run `npm run verify` before pushing** — typecheck, lint, and all three vitest projects. It needs the app running on :3000.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/timezone.ts` | `startsInPast` — the one predicate, beside the `classStartInstant` it wraps | 1 |
| `src/lib/timezone.test.ts` | Its timezone/boundary tests, including the fixture that a naive implementation answers backwards | 1 |
| `src/services/class-lifecycle.ts` | Both guards + the two result types they extend | 2, 3 |
| `src/app/api/classes/[id]/route.ts` | Maps `past_start` -> 409 `CLASS_STARTS_IN_PAST` (compiler-forced) | 2 |
| `src/services/class-lifecycle.test.ts` | Service tests for both guards; three fixture re-datings | 2, 3 |
| `tests/integration/full-flow.test.ts` | One fixture re-dating | 3 |
| `src/components/class/class-edit-form.tsx` | `min` on the date input | 4 |
| `src/app/(teacher)/class/new/page.tsx` | `min` on the wizard's date input | 4 |
| `tests/integration/classes-api.test.ts` | The two guards over HTTP | 5 |
| `src/services/waitlist-retention.ts`, the #247 spec, `CLAUDE.md` | Artifact corrections | 6 |

---

### Task 1: The `startsInPast` predicate

**Files:**
- Modify: `src/lib/timezone.ts` (append after `classStartInstant`, currently ending at `:144`)
- Test: `src/lib/timezone.test.ts` (append a new `describe` after the `classStartInstant` block)

**Interfaces:**
- Consumes: `classStartInstant(classDate: Date, startTime: string, timeZone: string): Date` — already exported from the same module.
- Produces: `startsInPast(classDate: Date, startTime: string, timeZone: string, now: Date): boolean`. Tasks 2 and 3 both import it from `@/lib/timezone`.

**Why `now` is a required parameter:** a caller that wants to shift the clock has to say so, the same reasoning `CompletionTiming` uses in `class-lifecycle.ts`. It also lets this task's tests sit on both sides of one instant without stubbing `Date`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/timezone.test.ts`. Add `startsInPast` to the existing import on line 2.

```ts
/**
 * #249. The predicate both past-start guards share.
 *
 * The Auckland case is the one that matters and the one that can be written so
 * it cannot fail. `Class.date` is stored at UTC midnight, so a guard that
 * compared the stored column against `now` — the obvious wrong implementation —
 * agrees with the correct answer at most hours of most days. These numbers are
 * chosen so the two disagree: 2026-06-15 23:00 NZST is 2026-06-15T11:00Z, which
 * is AFTER the `now` below, while the stored column reads 2026-06-15T00:00Z,
 * which is BEFORE it. Re-derive them if the fixture changes; do not adjust them
 * until a test passes.
 */
describe('startsInPast', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  it('is false for a class still to come in a zone far ahead of UTC', () => {
    expect(
      startsInPast(
        day('2026-06-15'),
        '23:00',
        'Pacific/Auckland',
        new Date('2026-06-15T06:00:00.000Z'),
      ),
    ).toBe(false);
  });

  it('is true once the start instant has passed', () => {
    // 09:00 CEST = 07:00Z, and `now` is five hours later.
    expect(
      startsInPast(
        day('2026-06-15'),
        '09:00',
        'Europe/Amsterdam',
        new Date('2026-06-15T12:00:00.000Z'),
      ),
    ).toBe(true);
  });

  it('is false at exactly the start instant', () => {
    // Strictly `<`: a class starting this instant has not started in the past.
    expect(
      startsInPast(
        day('2026-06-15'),
        '09:00',
        'Europe/Amsterdam',
        new Date('2026-06-15T07:00:00.000Z'),
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
npx vitest run --project unit src/lib/timezone.test.ts -t startsInPast
```

Expected: all three fail at import/compile — `startsInPast` is not exported from `./timezone`.

- [ ] **Step 3: Implement**

Append to `src/lib/timezone.ts`:

```ts
/**
 * Whether a class's start instant has already passed at `now` (#249).
 *
 * Thin on purpose. It exists so the rule has one name, one docblock and one
 * place to pin timezone behaviour, rather than two call sites that drift — and
 * so the wrong implementation has somewhere to be refused. That wrong
 * implementation is comparing `Class.date` (stored at UTC midnight) against
 * `now`: it agrees with this one at most hours of most days, which is precisely
 * why `timezone.test.ts` pins a case where the two disagree.
 *
 * `now` is required rather than defaulted. A caller that wants to shift the
 * clock has to say so — the same reasoning `CompletionTiming` gives in
 * `class-lifecycle.ts` for why skipping a timing check cannot be silent.
 *
 * Strictly `<`: a class starting this instant has not started in the past.
 */
export function startsInPast(
  classDate: Date,
  startTime: string,
  timeZone: string,
  now: Date,
): boolean {
  return classStartInstant(classDate, startTime, timeZone) < now;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npx vitest run --project unit src/lib/timezone.test.ts -t startsInPast
```

Expected: 3 passed.

- [ ] **Step 5: Mutation — prove the Auckland test bites**

Temporarily replace the function body with the naive comparison this test exists to refuse:

```ts
  return classDate < now;
```

Run the same command. Expected: **`is false for a class still to come in a zone far ahead of UTC` FAILS** with `expected true to be false`. The other two still pass, which is the point — they could not have caught it.

Record the exact failure text. Then restore the real body and re-run: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/timezone.ts src/lib/timezone.test.ts
git commit -m "feat: the predicate both past-start guards share (#249)"
```

---

### Task 2: The `updateClass` guard — the data-loss door

**Files:**
- Modify: `src/services/class-lifecycle.ts` — `UpdateClassResult` (`:678-685`), `updateClass`'s opening read (`:741`), the guard's insertion point (after `:756`)
- Modify: `src/app/api/classes/[id]/route.ts` — new branch before the `never` check at `:110-112`
- Modify: `src/services/class-lifecycle.test.ts` — `makeClass` (`:1260-1279`), `stubDb` (`:1659-1698`), the re-pointed test at `:1793`
- Test: `src/services/class-lifecycle.test.ts` (same `updateClass` describe block)

**Interfaces:**
- Consumes: `startsInPast` from Task 1.
- Produces: `UpdateClassResult` gains `| { ok: false; reason: 'past_start' }`. Task 5 asserts the route answers it 409 with code `CLASS_STARTS_IN_PAST`.

**Read before starting:** spec §5.1 (placement and why one enforcement point), §7.2 (the one test that must be re-pointed, and the trap in repairing it).

- [ ] **Step 1: Give the fixture helper a past-dated mode**

`makeClass` at `:1260` hard-codes `FIXTURE_DATE`. Add an optional third parameter. Do not change the default.

```ts
  /**
   * #249 needs fixtures on both sides of "now". `FIXTURE_DATE` (2099) is the
   * default and stays the default; `PAST_FIXTURE_DATE` is unambiguously behind
   * every clock this suite will ever run under, so no test here needs an
   * injected `now`.
   */
  const PAST_FIXTURE_DATE = '2020-01-01';
  const makeClass = (
    settingsLocked: boolean,
    status: ClassStatus = 'draft',
    date: string = FIXTURE_DATE,
  ) => {
    makeClassCounter += 1;
    return prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date(date),
        startTime: slotTime(makeClassCounter),
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status,
        settingsLocked,
      },
    });
  };
```

- [ ] **Step 2: Write the three failing tests**

Add to the same `describe` block that owns `makeClass`.

```ts
  it('refuses a date edit that moves a live class into the past (#249)', async () => {
    const cls = await makeClass(false, 'open');

    const result = await updateClass(prisma, cls.id, { date: new Date('2020-01-01') });
    expect(result).toEqual({ ok: false, reason: 'past_start' });

    // "Refused" has to mean "did not write" — the same assertion #247's tests
    // make, for the same reason. A refusal that still moved the column is what
    // leaves `waitlist-retention`'s sweep a class dated 2020 to reap, and the
    // sweep is a `deleteMany`.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.date.toISOString().slice(0, 10)).toBe(FIXTURE_DATE);
  });

  it('leaves a non-scheduling edit alone on a class that has already started (#249)', async () => {
    // The conjunct test. An `open` class whose start has passed is a state the
    // system legitimately produces — the generator makes one every time it runs
    // after a template's own weekday start time, and every class is in it for
    // up to the 60 seconds before the transition sweep. Editing its description
    // must stay legal; only a write that MOVES the start is refused.
    const cls = await makeClass(false, 'open', PAST_FIXTURE_DATE);

    const result = await updateClass(prisma, cls.id, { description: 'Updated' });
    expect(result.ok).toBe(true);
  });

  it('checks a startTime-only edit against the stored date (#249)', async () => {
    // The other conjunct. The obvious wrong guard fires only when `date` is
    // sent; this class's date is already past, so moving only its startTime
    // still lands in the past and must still be refused.
    const cls = await makeClass(false, 'open', PAST_FIXTURE_DATE);

    const result = await updateClass(prisma, cls.id, { startTime: '10:00' });
    expect(result).toEqual({ ok: false, reason: 'past_start' });

    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.startTime).not.toBe('10:00');
  });
```

- [ ] **Step 3: Run them and watch them fail**

```bash
npx vitest run --project unit src/services/class-lifecycle.test.ts -t '#249'
```

Expected: the two refusal tests fail (they get `{ ok: true, cls: … }`); the description test passes already. Note that the third test passing at this point proves nothing yet — it is the mutation in Step 8 that gives it teeth.

- [ ] **Step 4: Add the result variant and the route branch**

In `src/services/class-lifecycle.ts`, extend `UpdateClassResult` (`:678-685`):

```ts
  | { ok: false; reason: 'past_start' }
```

Add to that type's docblock, after the paragraph explaining why `terminal` carries a status:

```
 * `past_start` carries NOTHING, and the asymmetry with its two neighbours is
 * deliberate. `locked` and `terminal` carry data because their callers' MESSAGE
 * VARIES with it — `terminal`'s 409 renders "completed" or "cancelled" from one
 * branch, and an integration test exists to pin that variance. This refusal has
 * one sentence for every past start, whether the offending value arrived as
 * `date`, as `startTime`, or as both. A carried instant would be a payload
 * nothing reads.
```

Now build. `src/app/api/classes/[id]/route.ts` **will not compile**: `const unhandled: never = result` at `:112` rejects the new variant. That failure is the point — the route mapping is enforced by the compiler, not by a test someone has to remember. Add the branch immediately above it:

```ts
  // #249. Not a validation failure: `isoDate` accepted the value and the
  // calendar has that day. 409 for the same reason `terminal` is 409 and this
  // handler already argues above — the request is well-formed and the teacher
  // owns the class, so it conflicts with where the class sits in time rather
  // than with the shape of the input. Coded like its neighbours so a client can
  // tell "already started" from "frozen" and from "slot taken" without matching
  // on English.
  if (result.reason === 'past_start') {
    return respondError(
      'Cannot move a class to a date and time that has already passed.',
      409,
      'CLASS_STARTS_IN_PAST',
    );
  }
```

- [ ] **Step 5: Implement the guard**

In `updateClass`, change the opening read at `:741` to carry the teacher's timezone — the same shape `completeClass` (`:337-343`) and both transition sweeps already use:

```ts
  const cls = await db.class.findUnique({
    where: { id: classId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
```

Then insert the guard immediately after the terminal early return's closing brace (after `:756`), before the `ECONOMIC_FIELDS` destructure:

```ts
  // #249. A write may not newly place this class's start in the past.
  //
  // AFTER the terminal check, not before. A completed class edited with a 2020
  // date is refused because it is frozen, which is the older and stronger
  // reason; answering "that date has passed" there would be true, unhelpful,
  // and a regression on #247's two tests. Before the economic check because
  // this is a whole-request refusal like `terminal`, where `locked` is a
  // field-level one.
  //
  // GATED ON THE FIELDS SENT, and the conjunct is load-bearing rather than an
  // optimisation. An `open` class whose start has already passed is a state the
  // system produces legitimately — `generateClassInstances` creates one every
  // time it runs later in the day than its template's own start time, and every
  // class is in it for up to the 60 seconds before the transition sweep. Its
  // description must stay editable. Only a write that MOVES the start is
  // refused.
  //
  // ONE ENFORCEMENT POINT, not two, and the contrast with the terminal freeze
  // above is the reason to say so: that one needs a CAS conjunct as well
  // because a completion can commit between this read and the write. This one
  // cannot lose that race. The incoming `date`/`startTime` are fixed by the
  // request, and the stored values they fall back to can only be moved by a
  // writer that is itself this guard.
  if (data.date !== undefined || data.startTime !== undefined) {
    const effectiveDate = data.date ?? cls.date;
    const effectiveStartTime = data.startTime ?? cls.startTime;
    if (
      startsInPast(effectiveDate, effectiveStartTime, cls.teacher.defaultTimezone, new Date())
    ) {
      return { ok: false, reason: 'past_start' };
    }
  }
```

Add the import at the top of the file:

```ts
import { classStartInstant, startsInPast } from '@/lib/timezone';
```

(`classStartInstant` is already imported there; extend the existing statement rather than adding a second.)

- [ ] **Step 6: Re-point the one existing test the guard would answer first**

`src/services/class-lifecycle.test.ts:1793` publishes a stub `open` class with `date: new Date('2020-01-01')` to prove #247's CAS disambiguation branch is reachable. The new guard answers before any write, so its `toEqual` comparison now fails.

**Change the payload, not the expectation.** Repairing it the other way — updating the expected reason to `past_start` — makes it green while deleting all coverage of the branch that keeps #247's most likely request from being a 500.

```ts
    // A date-only edit, so `sentEconomic` is null. FUTURE-dated deliberately:
    // #249's guard sits above this path and would answer a past date first,
    // which would leave this branch untested while the test still looked green.
    const result = await updateClass(db, 'stub-class', { date: new Date('2099-07-01') });
```

- [ ] **Step 7: Teach `stubDb` the fields the opening read now selects**

`stubDb` (`:1659-1698`) returns `{ id, settingsLocked, status }` from the first read. The guard needs three more. Add them to the first-read branch only:

```ts
          if (reads === 1) {
            return {
              id: 'stub-class',
              settingsLocked: opts.settingsLocked,
              status: statusOnRead,
              // #249's guard reads these. Future-dated and UTC so every
              // existing case in this block behaves exactly as it did: no stub
              // test sends a past date, so the guard never fires here.
              date: new Date('2099-06-01T00:00:00.000Z'),
              startTime: '09:00',
              teacher: { defaultTimezone: 'UTC' },
            };
          }
```

- [ ] **Step 8: Run the whole file and the mutations**

```bash
npx vitest run --project unit src/services/class-lifecycle.test.ts
```

Expected: all pass.

Then three mutations, each restored before the next:

| Mutation | Must turn red |
|---|---|
| Delete the whole `if (data.date !== undefined \|\| …)` block | `refuses a date edit that moves a live class into the past` |
| Drop the field gate — make the guard unconditional | `leaves a non-scheduling edit alone on a class that has already started` |
| Narrow the gate to `data.date !== undefined` only | `checks a startTime-only edit against the stored date` |

Record each failure's exact text. Restore and re-run after each.

- [ ] **Step 9: Commit**

```bash
git add src/services/class-lifecycle.ts src/services/class-lifecycle.test.ts "src/app/api/classes/[id]/route.ts"
git commit -m "feat: a reschedule may not move a live class into the past (#249)"
```

---

### Task 3: The publish guard — the door that needs no typo

**Files:**
- Modify: `src/services/class-lifecycle.ts` — `TransitionFailureReason` (`:113-117`), `transitionClass` (`:215-262`)
- Modify: `src/services/class-lifecycle.test.ts` — fixture dates at `:358` and in `makeClass` (`:268`)
- Modify: `tests/integration/full-flow.test.ts` — fixture date at `:170`
- Test: `src/services/class-lifecycle.test.ts` (the `transitionClass` describe block)

**Interfaces:**
- Consumes: `startsInPast` from Task 1; `sourceStatesFor(to: ClassStatus): ClassStatus[]` from `:159-163` in the same file.
- Produces: `TransitionFailureReason` gains `'STARTS_IN_PAST'`. `POST /api/classes/[id]/transition` needs **no change** — `:129` already maps every reason but `NOT_FOUND` to 409.

**Read before starting:** spec §5.2 and §7.3. The fall-through ordering is the part that is easy to get wrong.

- [ ] **Step 1: Re-date the three aged fixtures, and confirm the suite is still green**

These were future-dated when written and have since aged into the past. Nothing in their tests depends on the date; a clock-reading guard would turn that aging into failures. Do this first so the only red in this task is the guard's own new test.

- `src/services/class-lifecycle.test.ts:358` — `date: new Date('2026-06-01')` becomes `date: new Date('2099-06-01')`
- `src/services/class-lifecycle.test.ts:268` (inside `makeClass`) — `date: new Date('2026-06-05')` becomes `date: new Date('2099-06-05')`
- `tests/integration/full-flow.test.ts:170` — `date: new Date('2026-07-01')` becomes `date: new Date('2099-07-01')`

Leave `:502` (`2026-06-04`, a `completed` class) alone. Its test asserts `/Invalid transition/`, and the guard must fall through for it — that test is now load-bearing proof of the ordering, so its fixture staying past is a feature.

Add above the `makeClass` at `:261`:

```ts
  /**
   * 2099, not "a couple of months out". #249's publish guard reads the clock,
   * so a fixture dated in what was the future when it was written fails once
   * enough time passes. These were `2026-06-0X` and had already aged into the
   * past by the time that guard was added.
   */
```

```bash
npx vitest run --project unit src/services/class-lifecycle.test.ts
npx vitest run --project integration tests/integration/full-flow.test.ts
```

Expected: both green, no behaviour change.

- [ ] **Step 2: Write the two failing tests**

Add to the `transitionClass (DB)` describe block (`:249-552`), which is where
`teacherId` and `teacherRoomId` are in scope.

These two use literal `startTime`s rather than the block's `slotTime(makeClassCounter)`
helper, and can: they are the only fixtures in the file dated `2020-01-01`, and
`Class_teacher_slot_unique` is `(teacherId, date, startTime)`, so a distinct date
makes a collision impossible. Two different times only so the two cannot collide
with each other.

```ts
  it('refuses to publish a draft whose start has already passed (#249)', async () => {
    // No typo needed for this one — a draft written for last Friday and
    // published the following week is enough. `transitionClass` had no date
    // predicate at all before #249.
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Vinyasa',
        date: new Date('2020-01-01'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'draft',
      },
    });

    const result = await transitionClass(prisma, cls.id, 'open');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('STARTS_IN_PAST');

    // Refused means not written.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.status).toBe('draft');
  });

  it('still starts an open class whose time has come (#249)', async () => {
    // The target conjunct. `open -> in_progress` is a class starting, so its
    // start instant being in the past is not merely allowed, it is the whole
    // precondition. A guard that fired on every target would stop every class
    // in the product from ever starting.
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Vinyasa',
        date: new Date('2020-01-01'),
        startTime: '10:00',
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'open',
      },
    });

    const result = await transitionClass(prisma, cls.id, 'in_progress');
    expect(result.ok).toBe(true);
  });
```

- [ ] **Step 3: Run them and watch the first fail**

```bash
npx vitest run --project unit src/services/class-lifecycle.test.ts -t '#249'
```

Expected: `refuses to publish a draft whose start has already passed` FAILS with `expected true to be false` — the publish currently succeeds. The second passes already; Step 6's mutation is what gives it teeth.

- [ ] **Step 4: Add the reason**

Extend `TransitionFailureReason` (`:113-117`):

```ts
export type TransitionFailureReason =
  | 'NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'NOT_ENDED_YET'
  | 'CONCURRENT_MODIFICATION'
  | 'STARTS_IN_PAST';
```

Add to its docblock:

```
 * A SUPERSET over two functions, not a contract either one satisfies alone.
 * `NOT_ENDED_YET` is returned only by `completeClass` and never by
 * `transitionClass`; `STARTS_IN_PAST` (#249) is the mirror — only
 * `transitionClass` returns it, and only for a `draft -> open` publish.
 * Both functions declare `TransitionDbResult`, so each type is wider than its
 * function's real range. That was already true before #249; this member does
 * not introduce the looseness, it follows it.
```

- [ ] **Step 5: Implement the guard**

Insert at the top of `transitionClass`, before the `db.$transaction` call at `:220`:

```ts
  // #249. A draft whose start has already passed cannot be published. This
  // needs no typo to reach: a draft written for Friday and published the
  // following week is enough.
  //
  // IT FALLS THROUGH RATHER THAN REFUSING for a missing row or a status the CAS
  // would reject anyway, and that is the whole subtlety. A `completed` class
  // targeted at `open` is illegal whatever its date; answering "it starts in
  // the past" there would be true and misleading, and would break the test that
  // pins `ILLEGAL_TRANSITION`. The older, stronger reason wins — the same
  // precedence `updateClass` gives `terminal` over `past_start`.
  //
  // Decided with `sourceStatesFor`, the same helper the CAS below uses, so this
  // guard can never disagree with the write it precedes. Spelling the source
  // set out here by hand would be a second copy of `VALID_TRANSITIONS` to keep
  // in sync.
  //
  // Read before the transaction rather than inside it. The stale window is
  // milliseconds and runs only in the safe direction: since #249's other guard
  // a class's stored start can never be moved into the past, so this read
  // cannot understate it. It can be overtaken by the clock — read at 08:59:59.9
  // for a 09:00 class, CAS at 09:00:00.1 — which publishes a class whose start
  // has just passed, exactly as publishing it a second earlier legally would.
  if (targetStatus === 'open') {
    const cls = await db.class.findUnique({
      where: { id: classId },
      select: {
        status: true,
        date: true,
        startTime: true,
        teacher: { select: { defaultTimezone: true } },
      },
    });
    if (
      cls &&
      sourceStatesFor(targetStatus).includes(cls.status) &&
      startsInPast(cls.date, cls.startTime, cls.teacher.defaultTimezone, new Date())
    ) {
      return {
        ok: false,
        reason: 'STARTS_IN_PAST',
        error: `Class ${classId} cannot be published: it started at ${classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone).toISOString()}`,
      };
    }
  }
```

- [ ] **Step 6: Run the file and the mutations**

```bash
npx vitest run --project unit src/services/class-lifecycle.test.ts
```

Expected: all pass.

Then three mutations, each restored before the next:

| Mutation | Must turn red |
|---|---|
| Delete the whole `if (targetStatus === 'open')` block | `refuses to publish a draft whose start has already passed` |
| Drop the `targetStatus === 'open'` gate (guard every target) | `still starts an open class whose time has come` |
| Drop the `sourceStatesFor(...).includes(cls.status)` conjunct | `reports a missing class differently from an illegal transition` (`:496`) — it gets `STARTS_IN_PAST` instead of `/Invalid transition/` |

The third mutation is the one worth dwelling on: **an existing #182 test is the only thing standing between this guard and a wrong answer**, and nothing in that test says so. Add a line to it while you are here:

```ts
    // Also #249's fall-through: this class is dated in the past AND targeted at
    // `open`, so a publish guard that refused instead of falling through would
    // answer STARTS_IN_PAST here. Its fixture stays past-dated for that reason.
```

- [ ] **Step 7: Run the integration file you re-dated**

```bash
npx vitest run --project integration tests/integration/full-flow.test.ts
```

Expected: green.

- [ ] **Step 8: Commit**

```bash
git add src/services/class-lifecycle.ts src/services/class-lifecycle.test.ts tests/integration/full-flow.test.ts
git commit -m "feat: a draft whose start has passed cannot be published (#249)"
```

---

### Task 4: `min` on the two class date inputs

**Files:**
- Modify: `src/components/class/class-edit-form.tsx:164-168`
- Modify: `src/app/(teacher)/class/new/page.tsx:382-390`
- Test: `src/components/class/class-edit-form.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks. `Input` (`src/components/ui/input.tsx`) extends `InputHTMLAttributes<HTMLInputElement>` and spreads `...props` onto the `<input>`, so `min` passes through with no component change.

**This is a convenience, never a guard.** #247 exists because a page-level control is not a service guard, and the services added in Tasks 2 and 3 refuse independently. Deleting everything in this task changes no service test outcome.

**Not the studio-class form.** `src/app/(teacher)/studio-class/new/page.tsx:161` is deliberately unbounded — a studio class is a record of teaching already done, and logging last Tuesday's is the normal flow. Spec §6.

- [ ] **Step 1: Write the failing component test**

Append to `src/components/class/class-edit-form.test.tsx`:

```tsx
  it('bounds the date picker at today, so the year-typo needs deliberate effort (#249)', () => {
    render(<ClassEditForm classId="cls-1" settingsLocked={false} initial={initial} />);

    const dateInput = screen.getByLabelText('Date');
    // A hint, not the guard — `updateClass` refuses independently, and #247 is
    // the reason that distinction is worth a comment. Compared against a
    // freshly computed day rather than a literal, so the assertion cannot rot
    // the way the fixtures in `class-lifecycle.test.ts` did.
    expect(dateInput).toHaveAttribute('min', new Date().toISOString().slice(0, 10));
  });
```

Verified against the file as it stands: it renders `<ClassEditForm classId="cls-1"
settingsLocked={…} initial={initial} />` (`:41`, `:92-98`) with a module-level
`initial: ClassEditInitial` at `:26-35`. There is no `defaultProps`. `toHaveAttribute`
is available — `tests/setup/components.ts:18` imports `@testing-library/jest-dom/vitest`.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --project components src/components/class/class-edit-form.test.tsx -t '#249'
```

Expected: FAIL — `expected element to have attribute min`.

- [ ] **Step 3: Implement in both forms**

`src/components/class/class-edit-form.tsx`:

```tsx
          <Input
            label="Date"
            type="date"
            // A hint, not a guard (#249). `updateClass` refuses a past start
            // independently and answers 409; #247 is the standing reminder that
            // a page-level control is not a service guard. Computed per render
            // rather than hoisted, so a form left open across midnight bounds
            // to the right day.
            min={new Date().toISOString().slice(0, 10)}
            value={form.date}
            onChange={(e) => set('date', e.target.value)}
          />
```

`src/app/(teacher)/class/new/page.tsx` — the same `min` on the `id="date"` input. Note that creation is **not** service-guarded (spec §6: a past-dated class is created `draft`, no sweep selects drafts, and the publish it would need is guarded by Task 3), so here the hint is the only bound and the comment should say exactly that rather than pointing at a guard that does not exist:

```tsx
            // A hint only, and unlike the edit form there is no service guard
            // behind it (#249, spec §6): a past-dated class is created `draft`,
            // which no sweep selects and no registration can attach to. What is
            // guarded is publishing it.
            min={new Date().toISOString().slice(0, 10)}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run --project components src/components/class/class-edit-form.test.tsx
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/class/class-edit-form.tsx src/components/class/class-edit-form.test.tsx "src/app/(teacher)/class/new/page.tsx"
git commit -m "feat: bound both class date pickers at today (#249)"
```

---

### Task 5: Both refusals over HTTP

**Files:**
- Modify: `tests/integration/classes-api.test.ts` — new cases in the `PUT /api/classes/[id]` describe (`:754`) and near the transition cases (`:355-372`)

**Interfaces:**
- Consumes: `past_start` -> 409 `CLASS_STARTS_IN_PAST` from Task 2; `STARTS_IN_PAST` -> 409 from Task 3.

**Why this task exists separately:** the service tests prove the guards; these prove the *routes* answer 409 rather than 500, which is the acceptance criterion #249 names explicitly. The app must be running on :3000 — do not start it yourself.

- [ ] **Step 1: Add a past-dated live fixture**

Alongside `completedClassId` / `cancelledTerminalClassId` (declared at `:39-40`, built in the same `beforeAll`), add a live class dated in the past. `makeClass` in this file (`:102-118`) hard-codes `2099-06-01`, so create this one inline:

```ts
  // #249. Live, and dated behind every clock this suite will run under. The
  // sibling fixtures are 2099; this is the other side of "now".
  const pastLive = await prisma.class.create({
    data: {
      teacherId: ownerId,
      teacherRoomId: teacherRoom.id,
      classType: 'Past Live',
      date: new Date('2020-01-01'),
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      status: 'draft',
    },
  });
  pastDraftClassId = pastLive.id;
```

Declare `let pastDraftClassId: string;` beside the others at `:39-40`, and delete the row in whatever `afterAll` the file already uses for its fixtures.

- [ ] **Step 2: Write the two failing tests**

In the `PUT /api/classes/[id]` describe:

```ts
  it('open class: a date edit into the past is refused with 409, not 500 (#249)', async () => {
    const target = await prisma.class.findUniqueOrThrow({ where: { id: economicsClassId } });
    expect(target.status).toBe('open'); // sanity: a LIVE class, so #247's freeze is not what refuses

    const res = await put(ownerToken, economicsClassId, { date: '2020-01-01' });
    expect(res.status).toBe(409);

    const json = (await res.json()) as { error: { code: string; message: string } };
    // Coded distinctly from CLASS_TERMINAL: a client has to tell "already
    // started" from "frozen" without matching on English.
    expect(json.error.code).toBe('CLASS_STARTS_IN_PAST');

    const after = await prisma.class.findUniqueOrThrow({ where: { id: economicsClassId } });
    expect(after.date.toISOString().slice(0, 10)).toBe('2099-06-01');
  });
```

Verified: `economicsClassId` is built by `makeClass('Classes API Lock (unlocked)', 'open', '09:30')` at `:143`, so the sanity assertion holds as written. If a future edit changes that fixture, adapt the test visibly — do not delete the assertion.

Near the transition cases:

```ts
  it('publishing a draft whose start has passed is refused with 409 (#249)', async () => {
    const res = await transition(ownerToken, pastDraftClassId, { status: 'open' });
    expect(res.status).toBe(409);

    const after = await prisma.class.findUniqueOrThrow({ where: { id: pastDraftClassId } });
    expect(after.status).toBe('draft');
  });
```

- [ ] **Step 3: Run them**

```bash
npx vitest run --project integration tests/integration/classes-api.test.ts
```

Expected: both pass — the services already refuse and the routes already map. If either returns 500, the route branch from Task 2 is missing or the transition route's `:129` mapping was changed.

- [ ] **Step 4: Mutation — prove the status code is pinned**

Change Task 2's route branch to `400`. Expected: `open class: a date edit into the past is refused with 409` FAILS with `expected 400 to be 409`. Restore, re-run.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/classes-api.test.ts
git commit -m "test: both past-start refusals answer 409 over HTTP (#249)"
```

---

### Task 6: Correct every artifact that says this is open

**Files:**
- Modify: `src/services/waitlist-retention.ts:108-121`
- Modify: `docs/superpowers/specs/2026-08-17-terminal-class-freeze-design.md` §7 (`:443-462`)
- Modify: `CLAUDE.md` — Class Lifecycle section

**A finding that names N locations gets N verdicts.** Three files here, plus the issue comment in Task 7's push step. Do not report this task done having opened two of them.

- [ ] **Step 1: `waitlist-retention.ts` — two corrections, not one**

The residual paragraph currently says the path is "filed as #249, deliberately left open" **and** frames the route to terminality as `autoTransitionToInProgress` then `autoCompleteClasses`. Both are now wrong — the second was already wrong when written, which issue 249's own follow-up comment recorded: a manual cancel reaches a terminal state in one request, with no sweep involved.

Replace the `WHAT IT DOES NOT BUY` paragraph with:

```
 * THE PRE-TERMINAL PATH IS CLOSED TOO, as of #249, and this paragraph used to
 * say the opposite. A teacher could edit a still-live class's `date` into the
 * past, and the class would then reach a terminal status legitimately — by
 * whichever route came first. Naming one route here (the transition sweep, then
 * the completion sweep) understated it: a manual cancel gets there in a single
 * request with no sweep involved, `autoCancelClasses` is a third route, and
 * `POST …/complete` with `finishedEarly` a fourth. That mattered, because a
 * defence designed against the two sweeps would have left the one-request route
 * open while looking complete.
 *
 * #249 guards at the two doors where a past start can be WRITTEN rather than at
 * the routes out of them, which covers all four equally: `updateClass` refuses
 * a `date`/`startTime` edit whose resulting start instant has already passed,
 * and `transitionClass` refuses a `draft -> open` publish of a class whose
 * start has passed. Both are service policy, deliberately not a trigger — an
 * `open` class whose start has passed is a state `generateClassInstances`
 * legitimately produces, so there is no invariant for the database to hold.
 * See `docs/superpowers/specs/2026-08-18-past-start-guard-design.md` §3.
```

- [ ] **Step 2: The #247 spec's §7**

Its "Filed as a decision — issue #249" block and its "Not attempted: bounding `isoDate`" note both need successors. Keep the history — that spec is a record of what was known then — and append rather than rewrite:

```markdown
**Update (2026-08-18, #249 closed).** The decision came back as the issue's
option 1: a write may not newly place a class's start in the past, refused at
`updateClass` and at the `draft -> open` publish. Two things this section got
wrong are worth carrying forward. The route to terminality is not the two-sweep
one described above — a manual cancel gets there in one request. And "how far
back is legal" turned out not to need a number: the backfill capability the
window was meant to preserve does not exist on `Class` (a past-dated class is
created `draft`, and drafts are never swept), while the product's real backfill
surface, `StudioClass`, is deliberately unbounded and structurally out of reach
of all three harms.

`isoDate` was **not** bounded, and deliberately: the rule needs the teacher's
timezone and the stored `startTime`, neither of which a Zod schema can see. It
lives in the services instead. See
`docs/superpowers/specs/2026-08-18-past-start-guard-design.md`.
```

- [ ] **Step 3: `CLAUDE.md`**

In the Class Lifecycle bullet list, after the `settings_locked` line:

```markdown
- A write may not newly place a class's start instant in the past — `updateClass`
  refuses a `date`/`startTime` edit that would (409), and `transitionClass`
  refuses a `draft → open` publish of a class whose start has passed. Service
  policy, not a constraint: the generator legitimately produces an `open` class
  whose start has already gone
```

- [ ] **Step 4: Verify no artifact still calls this open**

```bash
grep -rn "249" src docs CLAUDE.md --include=*.ts --include=*.md | grep -iv "^docs/superpowers/specs/2026-08-18"
```

Read every hit. Each must either describe the guard as shipped or be a historical record explicitly dated. Nothing may still say "filed and unfixed".

- [ ] **Step 5: Commit**

```bash
git add src/services/waitlist-retention.ts docs/superpowers/specs/2026-08-17-terminal-class-freeze-design.md CLAUDE.md
git commit -m "docs: the pre-terminal path is closed, and the one-route framing that outlived it (#249)"
```

---

### Task 7: Verify and push

- [ ] **Step 1: Full verification**

```bash
npm run verify
```

Runs typecheck, lint, and all three vitest projects — `unit`, `components`, `integration`. It needs the app live on :3000; a wall of `ECONNREFUSED` means it is not running. **Do not start it** — ask.

Record the per-project file and test counts, with totals that reconcile. The PR body must show the arithmetic, not a bare number.

- [ ] **Step 2: Baseline comparison**

Compare against the pre-branch counts. Measure the before-figure with `git stash` if it was not recorded at the start — do not infer it from the diff.

- [ ] **Step 3: Push and open the PR**

The PR body must record:
- What was measured, including the four premise corrections in spec §1.1 and that they were the *issue's* errors, not inherited ones.
- Which inherited claims were checked and which held — all five of the issue's measured links held; two of its citations had drifted, both moved by #247's own review.
- The arithmetic behind every count.
- **Which claims of my own were wrong**: the spec's §7 first reported one door's blast radius as the total, and the create-path harm was initially described as immediate when a created class is `draft` and never swept.
- The mutations, each with the error text it produced.
- What this does **not** do: creation stays unbounded, the generator is untouched, and **#247 is unaffected**.

**Never write the phrase "does not close #N".** GitHub's parser matches the keyword and ignores the negation in front of it; it has closed an issue in this repo twice, once from a commit written to document the trap. Write "**#N is unaffected**". The same applies to `fixes`, `resolves`, `fixed`, `resolved`, `closed`.

- [ ] **Step 4: Post prose from a file, never `--body "…"`**

Backticks inside a double-quoted shell string reach zsh as command substitution even escaped, and it fails silently — a published comment on this repo lost two file paths that way. Write the markdown to the scratchpad and pass `--body-file`.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §3 the rule / not a DB constraint | Task 1 docblock, Task 3 comment, Task 6 CLAUDE.md line |
| §4 the shared predicate, `now` required | Task 1 |
| §5.1 `updateClass` guard, placement, one enforcement point | Task 2 steps 4-5 |
| §5.1 route 409 + code | Task 2 step 4, Task 5 |
| §5.2 publish guard, fall-through, `sourceStatesFor` | Task 3 steps 4-5 |
| §6 create / generator / trigger / StudioClass left alone | Task 4 step 3 comment, Task 6 |
| §7.2 the re-pointed test and its trap | Task 2 step 6 |
| §7.3 three re-dated fixtures + ordering | Task 3 step 1, step 6 mutation 3 |
| §8 T1-T7 | T1/T2/T3 -> Task 2; T4/T5 -> Task 3; T6 -> Task 1; T7 -> Task 5 |
| §9 artifacts | Task 6 |
| §10 acceptance | Task 7 |

**Type consistency:** `startsInPast(classDate, startTime, timeZone, now)` — same four parameters in Task 1's definition and both call sites. `past_start` (snake_case, `UpdateClassResult`) and `STARTS_IN_PAST` (SCREAMING_CASE, `TransitionFailureReason`) differ **on purpose**: each matches its own union's existing convention, and neither union spells the other's members.

**Verify-don't-assume pass, run before committing this plan.** Every reference
below was opened and read at `edf3b01`, not recalled:
`transitionClass (DB)` is `:249-552` so `makeClass`/`teacherId` are in scope for
Task 3; `economicsClassId` is an `open` fixture (`classes-api.test.ts:143`);
`class-edit-form.test.tsx` renders with `classId`/`settingsLocked`/`initial` and
has no `defaultProps`; `toHaveAttribute` is registered by
`tests/setup/components.ts:18`; `Input` spreads `...props` onto its `<input>`
(`src/components/ui/input.tsx:27`) so `min` needs no component change.

Two references were corrected during this pass rather than left to fail on a
subagent: the component test's props, and Task 3's use of a counter helper it
did not need.
