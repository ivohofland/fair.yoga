# Terminal Class Freeze (#247) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `updateClass` refuse every edit to a `completed` or `cancelled`
class with a typed reason the route answers 409, and back the one column a
deleting sweep reads with a database trigger.

**Architecture:** Two layers of different widths, deliberately. The service
holds the *policy* — the whole class freezes, checked three times (early
return, compare-and-swap in the write, disambiguation of a zero count). The
database holds the *invariant* the retention sweep depends on — `date` alone,
via a `BEFORE UPDATE OF date` trigger following the existing
`class_terminal_status_guard`.

**Tech Stack:** TypeScript strict, Next.js App Router, Prisma + PostgreSQL,
Vitest (three projects: `unit`, `components`, `integration`), hand-authored SQL
migration.

**Spec:** `docs/superpowers/specs/2026-08-17-terminal-class-freeze-design.md`

---

## Global Constraints

- **TypeScript `strict: true`, no `any`, no implicit types.** The compiler is
  the first gate.
- **`noUncheckedIndexedAccess` is on.** `arr[i]` is `T | undefined`. Iterate
  rather than index where possible.
- **Never edit an applied migration.** Task 4 creates a new one.
- **Never start or restart the dev server on `:3000`.** The user runs it, and
  the `integration` project talks to it over HTTP.
- **Stage exact paths.** Never `git add -A` or `git add .`.
- **One commit per task** — the PR is rebase-merged, so the per-task history is
  the record.
- **Every guard gets a mutation that reddens a test**, with the exact error text
  recorded in the task's report. There is no legitimate survivor: deleting the
  early terminal return (§3.4 of the spec) reddens T5 on the DB-backed suite
  alone, and additionally reddens T9 once Task 2 lands.
- **`npm run verify` must be green before pushing.** It needs the app running on
  `:3000`.

---

## Verify Before You Assume

Every line reference below was checked against `b550823` on branch
`terminal-class-freeze`. Run this block first. If a reference has drifted, fix
the plan's reference and **report the drift** — do not silently work around it.

```bash
# 1. The function under change, and the three edit sites.
grep -n "export async function updateClass" src/services/class-lifecycle.ts     # expect 677
grep -n "if (cls.settingsLocked && sentEconomic !== null)" src/services/class-lifecycle.ts  # expect 693
grep -n "result = await db.class.updateMany" src/services/class-lifecycle.ts    # expect 730
grep -n "const stillExists = await db.class.findUnique" src/services/class-lifecycle.ts     # expect 756

# 2. The constant the guard reuses — already exported, do not redeclare it.
grep -n "export const TERMINAL_CLASS_STATUSES" src/services/class-lifecycle.ts  # expect 78

# 3. The route's exhaustiveness pin — adding a variant breaks the build here.
grep -n "const unhandled: never = result" src/app/api/classes/\[id\]/route.ts

# 4. The test fixtures this plan extends.
grep -n "const makeClass = (settingsLocked: boolean)" src/services/class-lifecycle.test.ts  # expect 1233
grep -n "function stubDb" src/services/class-lifecycle.test.ts                  # expect 1429
grep -n "function makeClass(classType: string, status:" tests/integration/classes-api.test.ts  # expect 95

# 5. The sibling trigger Task 4 mirrors, and the test whose title Task 4 narrows.
ls prisma/migrations/20260805120000_class_terminal_status_trigger/
grep -n "leaves non-status updates to a completed class alone" src/services/class-terminal-status.test.ts  # expect 370

# 6. The database container and the app.
docker ps --format '{{.Names}}' | grep fairyoga-db-1
# Expect 307 (the unauthenticated redirect to sign-in). Any HTTP status means
# the server is up; what you are ruling out is a connection failure. Do NOT
# start or restart it yourself — the user runs it, and it serves this checkout.
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/
```

**Measured baseline.** Measured on this branch at `b550823`, not inherited —
`npm run verify` green, then each project run separately for the split:

| Project | Test files | Tests |
|---|---|---|
| `unit` | 56 | 807 |
| `components` | 38 | 207 |
| `integration` | 28 | 410 |
| **Total** | **122** | **1424** |

`56 + 38 + 28 = 122` and `807 + 207 + 410 = 1424`, both matching what
`npm run verify` reports in one run — so a reader can re-derive the split rather
than take it on trust.

**Predicted after this branch: 123 files, 1440 tests.** That is `+1` unit file
(`class-terminal-date.test.ts`), `+15` unit tests (eleven in
`class-lifecycle.test.ts` — five terminal cases, a three-case `it.each`, and
three stub cases — plus four in the new file), and `+1` integration test.

**Measure it anyway at Task 6; do not report this prediction.** The equivalent
prediction on #212 was 1294 against an actual 1296, because that branch's own
review added tests the prediction could not have known about.

To re-measure:

```bash
npm run verify 2>&1 | tail -5
for p in unit components integration; do
  echo "=== $p ==="
  npx vitest run --project $p 2>&1 | grep -E "^ Test Files|^      Tests"
done
```

---

## Task Order Is Load-Bearing

**Tasks 1–3 (service + route) land before Task 4 (trigger), and that order is
chosen, not incidental.**

1. **The route change cannot be deferred.** `const unhandled: never = result`
   means the moment `UpdateClassResult` gains a variant, `tsc` fails on the
   route. The variant and the route branch are therefore in the same task.
2. **Every intermediate commit improves behaviour monotonically.** Today a
   `date` PUT on a completed class silently succeeds. After Task 1 it is a
   clean 409. If the trigger landed first there would be a commit answering
   500 for that request.
3. **The T1 mutation's outcome differs across Task 4, and that is the point.**
   Run in Task 1 (no trigger) it makes the edit *succeed*; re-run in Task 4
   (trigger present) it makes the edit *throw*. Two different reddenings from
   one mutation is the evidence that the two layers are independent rather
   than one guard counted twice. Task 4 has an explicit step to re-run it.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/services/class-lifecycle.ts` | Modify | The `terminal` result variant and the three guard sites |
| `src/app/api/classes/[id]/route.ts` | Modify | Map `terminal` → 409 |
| `src/services/class-lifecycle.test.ts` | Modify | T1–T9 |
| `tests/integration/classes-api.test.ts` | Modify | T10 |
| `prisma/migrations/<ts>_class_terminal_date_trigger/migration.sql` | Create | `class_terminal_date_guard` |
| `src/services/class-terminal-date.test.ts` | Create | T11 and the trigger's mutation recipe |
| `src/services/class-terminal-status.test.ts` | Modify | Narrow one test title (spec §5.2) |
| `src/services/waitlist-retention.ts` | Modify | The residual is closed (spec §6.1) |
| `docs/superpowers/specs/2026-08-16-waitlist-retention-design.md` | Modify | §2.4 dated note (spec §6.2) |
| `docs/data-model.md`, `CLAUDE.md` | Modify | The second freeze point exists |

---

## Task 1: The service guard and the route's 409

**Files:**
- Modify: `src/services/class-lifecycle.ts` (docblocks at `:646-676`; body at `:682-777`)
- Modify: `src/app/api/classes/[id]/route.ts` (after the `locked` branch)
- Test: `src/services/class-lifecycle.test.ts` (`describe('updateClass (DB)')`, from `:1214`)

**Interfaces:**
- Produces: `UpdateClassResult` gains `{ ok: false; reason: 'terminal'; status: ClassStatus }`.
  Tasks 2 and 3 both construct and assert this exact shape.
- Consumes: `TERMINAL_CLASS_STATUSES: readonly ClassStatus[]` — **already exported**
  from `src/services/class-lifecycle.ts:78`. Do not declare a new constant.

- [ ] **Step 1: Extend the test fixture to take a status**

In `src/services/class-lifecycle.test.ts`, replace the counter comment and the
`makeClass` signature. The old comment asserts a call count that this task
falsifies. Also extend the pre-existing `settingsLocked`-is-an-input-shortcut
comment immediately above it — `status` (#247) is now the identical shortcut
for the identical reason, and needs the identical caveat, or a test that later
claims to cover a class actually *reaching* a terminal status (as opposed to
what `updateClass` does once it is already sitting in one) could be written
against this fixture without anyone noticing it proves nothing of the kind:

```ts
  // `settingsLocked` is written directly here because it is an INPUT
  // precondition for this function, not the behaviour under test. The genuine
  // flip — a real registration setting it — is covered by
  // registrations-api's `locks settings atomically with the first
  // registration`. Do not copy this shortcut into a test that claims to cover
  // the flip itself.
  //
  // `status` (#247) is the same shortcut for the same reason: writing a
  // terminal status directly is an INPUT precondition for updateClass's own
  // guard, not the behaviour under test, and it bypasses `completeClass` /
  // `transitionClass` and the state machine's own transition guards entirely.
  // A test that claims to cover a class actually REACHING a terminal status —
  // as opposed to what updateClass does once it is already sitting in one —
  // needs to drive it through those, not through this fixture.
  // Counter-derived startTime: every test in this block shares one teacher and
  // one date, and none of them reads or asserts the created row's literal
  // startTime (the one test that changes it does so via an updateClass() call,
  // asserted against its new value, not this one) — so a distinct minute per
  // call is enough to keep every create legal under Class_teacher_slot_unique
  // without touching any assertion. Deliberately stated without a call count:
  // the previous wording named one ("8 times"), and #247 adding tests here
  // falsified it silently. Routed through the module-level `slotTime` rather
  // than a raw `09:${counter}` literal.
  let makeClassCounter = 0;
  const makeClass = (settingsLocked: boolean, status: ClassStatus = 'draft') => {
    makeClassCounter += 1;
    return prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2026-06-01'),
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

`ClassStatus` is already imported at `:2`. A `cancelled` fixture is free of the
slot key (`Class_teacher_slot_unique` is partial on `status <> 'cancelled'`), and
a `completed` one keeps its distinct minute, so no create collides.

- [ ] **Step 2: Write the failing tests (T1–T6)**

Append inside `describe('updateClass (DB)')`:

```ts
  it('refuses a date edit on a completed class, and writes nothing (#247)', async () => {
    const cls = await makeClass(false, 'completed');

    const result = await updateClass(prisma, cls.id, { date: new Date('2020-01-01') });
    expect(result).toEqual({ ok: false, reason: 'terminal', status: 'completed' });

    // "Refused" has to mean "did not write". #247 is a data-loss issue: the
    // wrong date is what makes waitlist-retention's sweep delete this class's
    // unfulfilled queue, so a refusal that still moved the column would close
    // nothing.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.date.toISOString().slice(0, 10)).toBe('2026-06-01');
  });

  it('refuses a date edit on a cancelled class too', async () => {
    const cls = await makeClass(false, 'cancelled');

    const result = await updateClass(prisma, cls.id, { date: new Date('2020-01-01') });
    expect(result).toEqual({ ok: false, reason: 'terminal', status: 'cancelled' });

    // Same "did not write" check as the completed case above, and not
    // optional here either: `reapClosedWaitlistEntries` reaps a `cancelled`
    // class's queue too, not only a `completed` one, so a refuse-but-write bug
    // on this path is the identical data-loss shape as T1's.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.date.toISOString().slice(0, 10)).toBe('2026-06-01');
  });

  it('freezes the whole class, not a field list — a description edit is refused', async () => {
    const cls = await makeClass(false, 'completed');

    const result = await updateClass(prisma, cls.id, { description: 'Annotated afterwards' });
    expect(result).toEqual({ ok: false, reason: 'terminal', status: 'completed' });

    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.description).toBeNull();
  });

  it('refuses an economic edit on a completed class nobody booked', async () => {
    // settingsLocked is written by the FIRST REGISTRATION, so a class that
    // reached `completed` with no bookings still carries `false` and would
    // otherwise accept this edit — on a row whose totals completeClass has
    // already written. The economic lock and the terminal freeze gate on
    // different events; this is the gap between them.
    const cls = await makeClass(false, 'completed');

    const result = await updateClass(prisma, cls.id, { roomCost: 999 });
    expect(result).toEqual({ ok: false, reason: 'terminal', status: 'completed' });

    // Cheap and consistent with T1/T2: assert the economic column did not move.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(Number(after.roomCost)).toBe(35);
  });

  it('reports terminal, not locked, when the class is both', async () => {
    // Pins the ORDER of the two early checks. `locked` reads as a state the
    // teacher could undo by removing a registration; the terminal freeze never
    // lifts, so it is the truer answer when both apply.
    const cls = await makeClass(true, 'completed');

    const result = await updateClass(prisma, cls.id, { roomCost: 999 });
    expect(result).toEqual({ ok: false, reason: 'terminal', status: 'completed' });

    // Cheap and consistent with T1/T2/T4: assert the economic column did not
    // move — under either refusal reason this class would refuse the write,
    // but only `terminal` is the true one here.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(Number(after.roomCost)).toBe(35);
  });

  it.each(['draft', 'open', 'in_progress'] as const)(
    'still updates a %s class — the freeze starts at terminality, not at "not editable in the UI"',
    async (status) => {
      // `in_progress` is here deliberately. The teacher edit page redirects
      // away from it, but the API allows it and should: the retention sweep
      // reads only terminal classes, and completeClass's `requireEndedBy`
      // already handles a class rescheduled out from under a completion.
      // Without this case a mutation that froze `in_progress` too would pass
      // every other test in this file.
      const cls = await makeClass(false, status);

      const result = await updateClass(prisma, cls.id, { description: `Edited while ${status}` });
      expect(result.ok).toBe(true);

      const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
      expect(after.description).toBe(`Edited while ${status}`);
    },
  );
```

- [ ] **Step 3: Run them and confirm they fail for the right reason**

```bash
# `-t` is a REGEX, not a substring: 'updateClass (DB)' makes (DB) a capture
# group and matches zero tests, silently reporting success. Escape the parens.
npx vitest run --project unit src/services/class-lifecycle.test.ts -t 'updateClass \(DB\)'
```

Expected: the five terminal cases fail because `updateClass` returned
`{ ok: true, cls: {...} }` — **not** because of a type error. The three
`it.each` cases pass already (they are the control).

If a terminal case fails with a *compile* error instead, the `terminal` variant
was added out of order; back the change out and redo Step 2 first.

- [ ] **Step 4: Add the result variant and its docblock sentence**

In `src/services/class-lifecycle.ts`, insert into `UpdateClassResult` directly
after the `locked` member:

```ts
  | { ok: false; reason: 'terminal'; status: ClassStatus }
```

and append to that type's docblock, after the paragraph about `locked`:

```
 * `terminal` carries the status for the same reason `locked` carries fields:
 * the caller owns the wording and needs to name what happened. It is plain
 * `ClassStatus` rather than a narrowed terminal union — the value is only ever
 * read into a message, and narrowing it would cost a type guard at each of the
 * two construction sites (the early return and the disambiguation branch,
 * below) for nothing.
```

- [ ] **Step 5: Rewrite `updateClass`'s summary docblock**

Replace the whole docblock above `export async function updateClass` (`:667-676`):

```ts
/**
 * Apply a partial update to a class, enforcing two independent freezes.
 *
 * They gate on different events and cover different things. The ECONOMIC
 * freeze (`settingsLocked`) starts at the first registration and covers
 * `ECONOMIC_FIELDS`; a teacher could in principle undo it by removing the
 * registration. The TERMINAL freeze (#247) starts when the class reaches
 * `completed` or `cancelled` and covers EVERY field — it is the class that is
 * frozen, not a list of columns — and it never lifts.
 *
 * Both are checked twice, for the same reason. The first check, against the
 * row we just read, is an optimisation: it answers the common case in one
 * query instead of three. The compare-and-swap inside the write is the one
 * that matters — it catches a first registration, or a completion, landing
 * between that read and this write, and on its own it produces the identical
 * result, list of offending fields included. Deleting the ECONOMIC check costs
 * round trips, not correctness, for exactly that reason. Deleting the TERMINAL
 * check is not as free: for a class that is BOTH terminal and settings-locked
 * with an economic field sent, control then reaches the `settingsLocked` check
 * next and answers `locked` — the wrong one of the two true refusals — before
 * the CAS ever runs. Everywhere else it too costs only round trips.
 *
 * The terminal freeze additionally has a database backstop for `date` alone
 * (`class_terminal_date_guard`), because that is the column
 * `waitlist-retention.ts` reads before it deletes.
 */
```

- [ ] **Step 6: Add the early return**

Immediately after `if (!cls) return { ok: false, reason: 'not_found' };`:

```ts
  // Checked BEFORE the economic lock: for every case except one, this is an
  // optimisation only — the CAS below re-derives the same refusal. The
  // exception is a class that is BOTH terminal and settings-locked with an
  // economic field sent: without this early return, `cls.settingsLocked &&
  // sentEconomic !== null` fires next and answers `locked`, so THIS check is
  // what makes `terminal` the true answer when both apply, not the CAS.
  if (TERMINAL_CLASS_STATUSES.includes(cls.status)) {
    return { ok: false, reason: 'terminal', status: cls.status };
  }
```

- [ ] **Step 7: Add the compare-and-swap conjunct**

Directly above `let result: Prisma.BatchPayload;`, with a leading blank `//`
line — the write's existing comment (the `Class_templateId_date_key`
paragraph) ends immediately above this insertion point, and without the
separator the two read as one block, which breaks the catch arm's later
pointer ("see the comment above the write") since it would then mean 10 lines
and a different statement than intended:

```ts
  //
  // Terminality re-checked in the filter for exactly the reason
  // `settingsLocked` is: `completeClass` (this same file) takes a `Class` row
  // lock and re-reads under it — `lockClassRow` at :324, and the
  // `requireEndedBy` comparison at :349-360 — so a completion can commit
  // between this function's opening read and this write. This function takes
  // no lock at all.
  //
  // Spread copy because `TERMINAL_CLASS_STATUSES` is `readonly` and Prisma's
  // `notIn` wants a mutable array — the same reason `gdpr.ts` spreads
  // `CANCELLABLE_STATUSES` into its own status CAS.
  const live = { status: { notIn: [...TERMINAL_CLASS_STATUSES] } };
```

and change the `where` to:

```ts
      where: sentEconomic !== null
        ? { id: classId, settingsLocked: false, ...live }
        : { id: classId, ...live },
```

- [ ] **Step 8: Add the disambiguation branch and correct the throw's reasoning**

Change the re-read's `select` and insert the branch after the not-found return:

```ts
    const stillExists = await db.class.findUnique({
      where: { id: classId },
      select: { id: true, status: true },
    });
    if (!stillExists) return { ok: false, reason: 'not_found' };

    // The class went terminal between the opening read and the write — the
    // race the CAS above exists to lose. This branch is NOT optional cleanup:
    // without it a `date`-only edit on a completed class reaches the throw
    // below (the row exists, and `date` is not economic, so `sentEconomic` is
    // null) and `withErrorHandler` answers 500 — for the single most likely
    // request #247 is about. Adding the conjunct without adding this branch
    // is strictly worse than adding neither.
    if (TERMINAL_CLASS_STATUSES.includes(stillExists.status)) {
      return { ok: false, reason: 'terminal', status: stillExists.status };
    }
```

Then replace the comment above the `throw` — its old wording reasons about a
bare `{ id }` filter that no longer exists:

```ts
    // Unreachable, and still actually so now that a third conjunct is in the
    // filter: `hasEdit` above guarantees Prisma issues a real UPDATE, and
    // every conjunct that UPDATE can fail on has just been re-read — the row
    // exists, it is not terminal, and `settingsLocked: false` is only ever in
    // the filter when economic fields were sent. Loud rather than silently
    // returning a plausible-but-wrong reason.
```

- [ ] **Step 9: Add the route's 409 branch**

In `src/app/api/classes/[id]/route.ts`, after the `locked` branch and before
`slot_conflict`:

```ts
  // #247. A terminal class is frozen whole, not by field list, so this is not
  // a `locked` variant with a different set — the two have different trigger
  // points and only one of them can be undone. 409 rather than 403: the
  // request is well-formed and the teacher does own the class; it conflicts
  // with a state the class has already reached.
  if (result.reason === 'terminal') {
    return respondError(`Cannot edit a class that is ${result.status}`, 409);
  }
```

No error code. The shipped edit form cannot reach a terminal class — the page
redirects (`src/app/(teacher)/class/[id]/edit/page.tsx:21`) — so nothing needs
to branch on it, matching `locked`, which also has none.

- [ ] **Step 10: Fix the two existing stub assertions the CAS just changed**

In `describe('updateClass — the count === 0 branches')`, two tests assert the
`where` shape verbatim and will now fail. Add `TERMINAL_CLASS_STATUSES` to the
`./class-lifecycle` import list at the top of the file, then update both:

```ts
    expect(updateManyCalls[0]?.where).toEqual({
      id: 'stub-class',
      settingsLocked: false,
      status: { notIn: [...TERMINAL_CLASS_STATUSES] },
    });
```

```ts
    expect(updateManyCalls[0]?.where).toEqual({
      id: 'stub-class',
      status: { notIn: [...TERMINAL_CLASS_STATUSES] },
    });
```

These stubs return no `status` from the re-read, so `stillExists.status` is
`undefined`, `.includes(undefined)` is `false`, and both tests keep their
original outcomes. Task 2 extends the stub properly.

- [ ] **Step 11: Run the full unit file and typecheck**

```bash
npx tsc --noEmit
npx vitest run --project unit src/services/class-lifecycle.test.ts
```

Expected: all green, including the two updated stub tests.

- [ ] **Step 12: Mutation M1 — remove both service guards**

Delete the early return (Step 6) **and** the `...live` spread from both `where`
arms (Step 7). Run:

```bash
npx vitest run --project unit src/services/class-lifecycle.test.ts -t 'refuses a date edit on a completed class'
```

Expected: **FAIL.** Record the exact output. At this point in the branch there
is no trigger, so the edit succeeds and the assertion reddens on a value
mismatch (`{ ok: true, cls: … }` vs the expected refusal). Task 4 re-runs this
same mutation with the trigger present and gets a different failure; both are
recorded.

Restore both, re-run, confirm green.

- [ ] **Step 13: Mutation M2 — delete the disambiguation branch**

Delete only the Step 8 branch. Run the whole file. Expected: the five terminal
cases still pass (the early return answers them), which is itself the finding —
**this mutation is invisible to every DB-backed test in the file.** Record that,
and note it is why Task 2's T7 exists. Restore.

- [ ] **Step 14: Mutation M3 — swap the two early checks**

Move the terminal early return to *after* the `settingsLocked` check. Run:

```bash
npx vitest run --project unit src/services/class-lifecycle.test.ts -t 'reports terminal, not locked'
```

Expected: **FAIL** with the received value being
`{ ok: false, reason: 'locked', fields: ['roomCost'] }`. Record it. Restore.

- [ ] **Step 15: Mutation M4 — freeze `in_progress` too**

Change the early return's condition to
`[...TERMINAL_CLASS_STATUSES, 'in_progress'].includes(cls.status)`. Run:

```bash
npx vitest run --project unit src/services/class-lifecycle.test.ts -t 'in_progress class'
```

Expected: **FAIL** — `result.ok` is `false`. Record it. Restore and re-run the
whole file green.

- [ ] **Step 16: Commit**

```bash
git add src/services/class-lifecycle.ts src/services/class-lifecycle.test.ts "src/app/api/classes/[id]/route.ts"
git commit -m "feat: a terminal class refuses every edit, and the route says 409 not 500"
```

---

## Task 2: Pin the construction, not just the outcome

Task 1's DB tests pass whether or not the CAS and the disambiguation branch
exist — the early return alone satisfies them (Task 1 Step 13 measured exactly
that). This task adds the three tests that can tell the difference. Against a
real database the zero-count path is a genuine race with no deterministic
trigger, which is why the stub exists.

**Files:**
- Test: `src/services/class-lifecycle.test.ts` (`describe('updateClass — the count === 0 branches')`, from `:1416`)

**Interfaces:**
- Consumes: the `terminal` variant and all three guard sites from Task 1.

- [ ] **Step 1: Extend `stubDb` to report a status**

Replace the signature and the `findUnique` stub:

```ts
  function stubDb(opts: {
    settingsLocked: boolean;
    rowSurvives: boolean;
    // Reported by updateClass's opening read. Defaults to a non-terminal value
    // so every pre-#247 case in this block behaves exactly as it did.
    status?: ClassStatus;
    // Reported by the re-read inside the `count === 0` branch. Defaults to
    // `status`; set it different to stage the completion race.
    statusAfter?: ClassStatus;
  }) {
    const updateManyCalls: UpdateManyArgs[] = [];
    let reads = 0;
    const db = {
      class: {
        findUnique: async () => {
          reads += 1;
          if (reads === 1) {
            return {
              id: 'stub-class',
              settingsLocked: opts.settingsLocked,
              status: opts.status ?? 'open',
            };
          }
          return opts.rowSurvives
            ? { id: 'stub-class', status: opts.statusAfter ?? opts.status ?? 'open' }
            : null;
        },
```

Leave `updateMany` and `findUniqueOrThrow` untouched.

- [ ] **Step 2: Write the failing tests (T7–T9)**

```ts
  it('reports terminal when the class completed between the read and the write', async () => {
    const stub = stubDb({
      settingsLocked: false,
      rowSurvives: true,
      status: 'open',
      statusAfter: 'completed',
    });
    const { db, updateManyCalls } = stub;

    // A date-only edit, so `sentEconomic` is null. Before #247's
    // disambiguation branch this combination fell through to
    // UpdateClassInvariantError — a 500 for precisely the request the issue
    // was filed about.
    const result = await updateClass(db, 'stub-class', { date: new Date('2020-01-01') });
    expect(result).toEqual({ ok: false, reason: 'terminal', status: 'completed' });

    // Proves the CAS path ran rather than the early return, which is
    // otherwise indistinguishable — it returns the same shape.
    expect(updateManyCalls).toHaveLength(1);
    expect(stub.reads).toBe(2);
  });

  it('constrains the write to non-terminal rows under both filter shapes', async () => {
    // Asserted against the constant, not a `['completed','cancelled']`
    // literal: what this test owns is "the conjunct is present and derived",
    // while the constant's own VALUES are pinned against the trigger SQL by
    // class-terminal-status.test.ts. Restating them here would duplicate that
    // pin badly — it would go stale independently.
    //
    // Task 1's two pre-existing stub tests already pin these same two `where`
    // shapes individually; kept anyway as the only test whose name states the
    // property and the only one showing both arms side by side under the
    // derived constant.
    const live = { status: { notIn: [...TERMINAL_CLASS_STATUSES] } };

    const economic = stubDb({ settingsLocked: false, rowSurvives: false });
    await updateClass(economic.db, 'stub-class', { roomCost: 42 });
    expect(economic.updateManyCalls[0]?.where).toEqual({
      id: 'stub-class',
      settingsLocked: false,
      ...live,
    });

    const plain = stubDb({ settingsLocked: false, rowSurvives: false });
    await updateClass(plain.db, 'stub-class', { description: 'x' });
    expect(plain.updateManyCalls[0]?.where).toEqual({ id: 'stub-class', ...live });
  });

  it('answers a visibly-terminal row from the read, without attempting the write', async () => {
    const { db, updateManyCalls } = stubDb({
      settingsLocked: false,
      rowSurvives: true,
      status: 'completed',
    });

    const result = await updateClass(db, 'stub-class', { date: new Date('2020-01-01') });
    expect(result).toEqual({ ok: false, reason: 'terminal', status: 'completed' });

    // The point of this case, and the mirror of its `locked` sibling above:
    // the pre-check answered it WITHOUT attempting a write. That is the
    // query-count half of the evidence, and this test owns it. It is not the
    // only test that can see the early return, and deleting it does not leave
    // the result identical everywhere: Task 1's `'reports terminal, not
    // locked, when the class is both'` (T5) owns the correctness half — a
    // class that is both terminal and settings-locked with an economic field
    // sent falls through to `locked` once this check is gone, before the CAS
    // ever runs.
    expect(updateManyCalls).toHaveLength(0);
  });
```

- [ ] **Step 3: Run them**

```bash
npx vitest run --project unit src/services/class-lifecycle.test.ts -t 'count === 0'
```

Expected: all pass — Task 1 already implemented what they pin. That is fine and
expected; these are characterisation tests for construction, and their value is
established by the mutations below, not by a red-then-green cycle.

- [ ] **Step 4: Mutation M5 — delete the disambiguation branch**

Delete Task 1 Step 8's branch. Run the file.

Expected: **FAIL** on `'reports terminal when the class completed between the
read and the write'` with `UpdateClassInvariantError: updateClass: class
stub-class matched no rows but still exists`. Record the exact text. This is
the mutation Task 1 Step 13 showed nothing else can catch. Restore.

- [ ] **Step 5: Mutation M6 — drop the conjunct from one arm only**

Remove `...live` from the **non-economic** arm only. Run the file.

Expected: **FAIL in two places.** `'constrains the write to non-terminal rows
under both filter shapes'` (T8) fails on its non-economic assertion, and so
does Task 1's pre-existing `'reports not_found when no economic field was
sent — the row was deleted (#72)'` (test-file `:1605`, assertion `:1616`) —
Task 1 already added the same `notIn` conjunct to that test's own `where`
expectation, so it is independently sensitive to this same arm. Record both.
Restore, then repeat for the economic arm: **FAIL in two places** again —
T8's economic assertion, and Task 1's pre-existing `'reports locked when the
row survives — the compare-and-swap lost its race'` (test-file `:1570`,
assertion `:1581`) — record that pair too. One arm at a time, because
dropping both at once would not show that each is independently pinned.

- [ ] **Step 6: Mutation M7 — delete the early return**

Delete Task 1 Step 6's early return. Run the **whole unit file**, not just this
block — the failure is not contained to it.

Expected: **FAIL in two places.** This block's own `'answers a visibly-terminal
row from the read, without attempting the write'` fails on `updateManyCalls`
having length 1 instead of 0 — the query-count half. Task 1's `'reports
terminal, not locked, when the class is both'` (T5) fails too, on the
*correctness* half: without the early return, `cls.settingsLocked &&
sentEconomic !== null` fires next for a class that is both terminal and locked
with an economic field sent, and answers `locked` before the CAS ever runs.
Record both failures' exact text — there is no predicted survivor here (spec
§3.4 corrects an earlier draft that claimed there was). Restore and re-run
green.

- [ ] **Step 7: Commit**

```bash
git add src/services/class-lifecycle.test.ts
git commit -m "test: three mutations the DB-backed suite could not see"
```

---

## Task 3: The route answers 409 over HTTP

**Files:**
- Test: `tests/integration/classes-api.test.ts`

**Interfaces:**
- Consumes: the route branch from Task 1 Step 9.

**Requires the app running on `:3000`.** Do not start it — confirm it with the
`curl` from the verify block and stop if it is not up.

- [ ] **Step 1: Widen the fixture helper and add a completed fixture**

`makeClass` is declared *inside* `beforeAll` (`:95`), so tests cannot call it;
the file's pattern is a module-level `let` assigned in `beforeAll`. Follow it.

Widen the status parameter at `:95`:

```ts
  function makeClass(classType: string, status: 'draft' | 'open' | 'completed', startTime: string) {
```

Add a module-level declaration beside `economicsClassId` / `lockedClassId`:

```ts
// #247: a terminal fixture for the PUT freeze. `completed` is written directly
// because it is an INPUT precondition, not the behaviour under test — driving
// it through POST …/complete would need registrations and pricing fixtures to
// prove something this test does not claim.
let completedClassId: string;
```

Create it in `beforeAll`, after the `lockedCls` block. `10:15` is the first free
slot — `09:00`, `09:15`, `09:30`, `09:45` and `10:00` are taken:

```ts
  const completedCls = await makeClass('Classes API Terminal (#247)', 'completed', '10:15');
  completedClassId = completedCls.id;
```

Add `completedClassId` to the `allClassIds` array in `afterAll` (`:212-218`).

- [ ] **Step 2: Write the failing test (T10)**

Append inside `describe('PUT /api/classes/[id]')`:

```ts
  it('completed class: the edit is refused with 409 and the stored date does not move (#247)', async () => {
    const before = await prisma.class.findUniqueOrThrow({ where: { id: completedClassId } });
    expect(before.status).toBe('completed'); // sanity: the fixture is the state under test

    // The exact payload from the issue. `isoDate` has no range bound, so this
    // passes schema validation and reaches the service — the refusal has to
    // come from the guard, not from parsing.
    const res = await put(ownerToken, completedClassId, { date: '2020-01-01' });
    expect(res.status).toBe(409);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('completed');

    // The whole point: a refusal that still wrote the column would leave
    // waitlist-retention's sweep with a class dated 2020 to reap.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: completedClassId } });
    expect(after.date.toISOString().slice(0, 10)).toBe('2099-06-01');
  });
```

- [ ] **Step 3: Run it**

```bash
npx vitest run --project integration tests/integration/classes-api.test.ts
```

Expected: PASS (Task 1 shipped the route branch). Confirm the whole file is
green, not just the new case — Step 1 touched a shared helper and the shared
`afterAll`.

- [ ] **Step 4: Mutation M8 — change the mapped status code**

In the route, change the `terminal` branch's `409` to `200`. Run the file.

Expected: **FAIL** — `expected 200 to be 409`. Record it. Restore.

- [ ] **Step 5: Mutation M9 — delete the route branch entirely**

Delete the whole `if (result.reason === 'terminal')` block. Run:

```bash
npx tsc --noEmit
```

Expected: **FAIL** at `const unhandled: never = result` — the exhaustiveness pin
names the unhandled variant. Record the exact compiler error. This shows the
branch cannot be dropped by accident. Restore.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/classes-api.test.ts
git commit -m "test: the PUT freeze over HTTP, and the pin that makes it unskippable"
```

---

## Task 4: The database backstop

**Files:**
- Create: `prisma/migrations/20260817120000_class_terminal_date_trigger/migration.sql`
- Create: `src/services/class-terminal-date.test.ts`
- Modify: `src/services/class-terminal-status.test.ts` (one test title)

**Interfaces:**
- Produces: trigger `class_terminal_date_guard`, function
  `class_reject_terminal_date_change()`, raising `SQLSTATE 23514`.

**Step order here is test-first, per CLAUDE.md.** The trigger test is written
and run to red *before* the migration exists — with no trigger, nothing raises
and the rejection cases fail cleanly. That is a real red-green cycle, so there
is no reason to take the weaker "write it, then characterise it" route.

- [ ] **Step 1: Write the trigger test (T11) and run it to red**

Create `src/services/class-terminal-date.test.ts` with the full contents given
in Step 4 below. Then:

```bash
npx vitest run --project unit src/services/class-terminal-date.test.ts
```

Expected: **3 of the 7 cases FAIL**, for two different reasons, and the count
depends on running this before Step 2 as written:

1. Both rejection cases (`it.each(TERMINAL_CLASS_STATUSES)`), at
   `expect(caughtRaw).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)`
   with `caughtRaw` still `undefined`, because no trigger exists to raise.
   This is the red that matters.
2. `'matches the exact status set the trigger SQL enforces'`, which
   `readFileSync`s the migration — a file Step 2 has not written yet — and so
   dies with `ENOENT`. Expected and uninteresting; it goes green the moment
   Step 2 creates the file, which is BEFORE the trigger is applied in Step 3.
   The two rejection cases stay red until Step 3.

The remaining four (three allow-cases over the non-terminal statuses, and the
unchanged-date case) pass correctly and uninterestingly: with no trigger,
everything is allowed. Record the failure output.

Two things an earlier draft of this step predicted wrongly, both measured
rather than assumed. `Class.id` is Prisma `String @default(uuid())`, which is a
**`text`** column — a `${classId}::uuid` cast makes the comparison `text = uuid`
and the statement dies with `42883` before the trigger is ever consulted, so
the test can never pass with the cast in place. And a `$executeRaw` failure
arrives as `PrismaClientKnownRequestError` (P2010), **not** the
`PrismaClientUnknownRequestError` the typed path produces — the same two-shape
split `src/lib/api-errors.ts` already documents for `55P03`. Only the Unknown
shape is matched by `isTerminalStatusViolation`, so the `409` claim is pinned
against a typed `class.update`, which is also the path production takes.

- [ ] **Step 2: Write the migration**

`prisma/schema.prisma` is **not** changed — the column and its type already
exist, so there is no drift for CI's migration-drift check to find. Create the
directory and file by hand; Prisma cannot express a trigger.

```bash
mkdir -p prisma/migrations/20260817120000_class_terminal_date_trigger
```

`migration.sql`:

```sql
-- Invariant, DB-enforced: a terminal class's `date` never changes.
--
-- The sibling trigger `class_terminal_status_guard`
-- (20260805120000_class_terminal_status_trigger) is BEFORE UPDATE OF status,
-- and says in its own comment that "updates to other columns of a completed
-- class ... are unaffected". That was correct and harmless until #238 shipped
-- `waitlist-retention.ts`, which reads `Class.date` on a terminal class and
-- then DELETES the unfulfilled queue entries it finds. Half that sweep's
-- predicate was trigger-enforced and half was not. This is the other half.
--
-- `date` ONLY, not every column, and the narrowness is deliberate. The service
-- (`updateClass`) freezes the whole class; this freezes the one column a
-- deleting sweep reads. Measured before choosing: of the 13 real
-- `class.update`/`updateMany` sites in `src/`, exactly one writes `date`, and
-- it is `updateClass`. `template-sync.ts` rewrites twelve instance columns and
-- pointedly not this one; `completeClass` writes its totals in the same
-- statement as the status flip, so OLD.status is `in_progress` there and this
-- never fires. A wider trigger would gain nothing and would put
-- `spotBroadcastAt` and the completion write at risk.
--
-- The WHEN clause needs both halves. `UPDATE OF date` fires whenever `date` is
-- in the SET list even if the value is identical, so without the IS DISTINCT
-- FROM a future writer that carries the current date alongside the columns it
-- means to change would be rejected by a guard aimed at something else — the
-- same reasoning the sibling trigger records for its own WHEN.
CREATE OR REPLACE FUNCTION class_reject_terminal_date_change()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Class % is %, which is terminal; cannot change its date from % to %',
    OLD.id, OLD.status, OLD.date, NEW.date
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_terminal_date_guard
  BEFORE UPDATE OF date ON "Class"
  FOR EACH ROW
  WHEN (OLD.status IN ('completed', 'cancelled') AND OLD.date IS DISTINCT FROM NEW.date)
  EXECUTE FUNCTION class_reject_terminal_date_change();
```

`23514` matches the sibling so `classifyApiError` maps both to 409.

- [ ] **Step 3: Apply it to dev and to the test database**

```bash
npx prisma migrate deploy
DATABASE_URL="$DATABASE_URL_TEST" npx prisma migrate deploy
```

Verify it exists in both:

```bash
docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga \
  -c "SELECT tgname FROM pg_trigger WHERE tgname = 'class_terminal_date_guard';"
docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test \
  -c "SELECT tgname FROM pg_trigger WHERE tgname = 'class_terminal_date_guard';"
```

Expected: one row each. If `DATABASE_URL_TEST` is unset, find it in `.env`
rather than guessing the database name.

- [ ] **Step 4: The trigger test in full (written in Step 1)**

Create `src/services/class-terminal-date.test.ts`. The fixture scaffold mirrors
`class-terminal-status.test.ts:136-192` with the student dropped (nothing here
registers). Copy the `slotTime` helper from that file verbatim — it exists
because `startTime` is a plain `String` with no CHECK constraint, so a raw
`09:${counter}` literal would emit `09:60` once the counter crosses 60.

```ts
import { readFileSync } from 'fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma, ClassStatus } from '@prisma/client';
import { classifyApiError } from '@/lib/api-errors';
import { TERMINAL_CLASS_STATUSES } from './class-lifecycle';

/**
 * A pure DB-invariant test for `class_terminal_date_guard` (#247) — no HTTP
 * surface, nothing here calls the app on `:3000` — so it lives in the `unit`
 * project rather than `tests/integration/`. `vitest.config.ts` resolves the
 * unit project's `DATABASE_URL` to `DATABASE_URL_TEST` when that variable is
 * set, so this file reaches the isolated database with no shell override.
 * That matters here specifically: the integration project runs against the
 * DEV database (`docs/test-database.md` §3.4), so proving this trigger by
 * dropping it from there would need a manual override, and getting the
 * override wrong drops the trigger on dev.
 *
 * SEPARATE FROM `class-terminal-status.test.ts`, which already has these
 * fixtures. The duplication is bought deliberately: the two triggers have to
 * be droppable independently. A `DROP TRIGGER class_terminal_date_guard` that
 * reddens tests about the STATUS trigger would prove less than one that
 * reddens only this file, and that independence is the entire argument for
 * having two layers instead of one.
 *
 * WHY A DATABASE TRIGGER AND NOT ONLY `updateClass`. `waitlist-retention.ts`
 * permanently deletes unfulfilled queue entries on classes that are terminal
 * AND more than 365 days past their `date`. `class_terminal_status_guard`
 * enforces the first half; nothing enforced the second until this. The service
 * guard in `updateClass` covers every field and gives the teacher a 409, but
 * it covers one call site — this covers the column.
 *
 * Manual mutation-proof recipe, if this trigger is ever touched again —
 * against `DATABASE_URL_TEST`, never dev:
 *
 *   docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test \
 *     -c 'DROP TRIGGER class_terminal_date_guard ON "Class";'
 *   npx vitest run --project unit src/services/class-terminal-date.test.ts
 *   # the two rejection cases fail: `caughtRaw` stays undefined, no exception
 *   # to catch. The allow-cases and the drift pin stay green — with no trigger
 *   # everything is allowed, and the pin reads a file, not the database.
 *
 * To restore: `CREATE OR REPLACE FUNCTION` is idempotent but `CREATE TRIGGER`
 * is not, so replaying the migration file only works while the trigger is
 * actually gone. Confirm it is, then:
 *
 *   docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test \
 *     < prisma/migrations/20260817120000_class_terminal_date_trigger/migration.sql
 *
 * or reset from scratch: `DATABASE_URL_TEST=... npx prisma migrate reset`.
 */
const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

/**
 * Turns a running total-minutes-from-9am into a valid `HH:MM`, wrapping into
 * the next hour rather than ever emitting an invalid minute like `'09:60'`.
 * `startTime` is a plain `String` with no CHECK constraint and
 * `Class_teacher_slot_unique` compares strings, so a raw `09:${counter}`
 * literal would accept an out-of-range value silently instead of exercising
 * the constraint this counter exists to dodge. Mirrors the helper of the same
 * name in `class-terminal-status.test.ts`.
 */
function slotTime(totalMinutesFrom9am: number): string {
  const hour = 9 + Math.floor(totalMinutesFrom9am / 60);
  const minute = totalMinutesFrom9am % 60;
  const startTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (!/^\d{2}:[0-5]\d$/.test(startTime)) {
    throw new Error(`slotTime produced an invalid startTime: ${startTime}`);
  }
  return startTime;
}

let teacherId: string;
let accountId: string;
let roomId: string;
let teacherRoomId: string;
const classIds: string[] = [];

const ORIGINAL_DATE = '2099-06-01';

/**
 * Derived, not listed. Every `ClassStatus` the trigger must NOT fire on is
 * whatever is left once the terminal set is removed — so adding a sixth
 * status to the enum extends the allow-case below automatically, and widening
 * `TERMINAL_CLASS_STATUSES` removes it from here and adds it to the rejection
 * cases in the same edit. Mirrors the intent of `class-lifecycle.test.ts`'s
 * `['draft', 'open', 'in_progress']` control, which exists so that a mutation
 * freezing a non-terminal status is caught by design rather than by accident;
 * this version cannot fall behind the enum the way that literal can.
 */
const NON_TERMINAL_STATUSES = Object.values(ClassStatus).filter(
  (s) => !TERMINAL_CLASS_STATUSES.includes(s),
);

let makeClassCounter = 0;

async function makeClass(opts: { status: ClassStatus }): Promise<{ classId: string }> {
  makeClassCounter += 1;
  const cls = await prisma.class.create({
    data: {
      teacherId,
      teacherRoomId,
      classType: 'Terminal Date Test',
      date: new Date(ORIGINAL_DATE),
      startTime: slotTime(makeClassCounter),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 8,
      status: opts.status,
    },
  });
  classIds.push(cls.id);
  return { classId: cls.id };
}

beforeAll(async () => {
  await prisma.$connect();

  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Terminal',
      lastName: 'Date',
      email: `terminal-date-${uniqueSuffix}@test.local`,
      account: { create: { email: `terminal-date-${uniqueSuffix}@test.local` } },
      bio: 'Terminal date trigger tests',
      pageSlug: `terminal-date-${uniqueSuffix}`,
    },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;

  const room = await prisma.room.create({
    data: {
      venueName: 'Terminal Date Studio',
      address: `${uniqueSuffix} Trigger St`,
      city: 'Amsterdam',
      postcode: '1234RA',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 20,
      createdById: teacherId,
    },
  });
  roomId = room.id;

  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId, roomId, capacityOverride: 15, rentalRate: 30 },
  });
  teacherRoomId = teacherRoom.id;
});

afterAll(async () => {
  await prisma.class.deleteMany({ where: { id: { in: classIds } } });
  await prisma.teacherRoom.deleteMany({ where: { id: teacherRoomId } });
  await prisma.room.deleteMany({ where: { id: roomId } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: accountId } });
  await prisma.$disconnect();
});

describe('class_terminal_date_guard', () => {
  // Driven by `TERMINAL_CLASS_STATUSES`, not by a `['completed', 'cancelled']`
  // literal. Widen the derived set and these rejection cases widen with it, so
  // a status that the reaper starts treating as unwritable is proved
  // unwritable HERE too, in the same edit. The literal could not: it would go
  // on testing the old two while the reaper deleted rows on the new third.
  it.each(TERMINAL_CLASS_STATUSES)(
    'refuses to move a %s class to a past date, from raw SQL',
    async (status) => {
      const { classId } = await makeClass({ status: 'open' });
      await prisma.class.updateMany({ where: { id: classId, status: 'open' }, data: { status } });

      // Raw SQL, not `updateClass` — the point is that this holds with the
      // service layer, and Prisma's typed layer, entirely out of the picture.
      // `2020-01-01` is the exact date from issue #247: more than 365 days
      // past, so `reapClosedWaitlistEntries` would treat this class as
      // reapable.
      //
      // No `::uuid` cast on the id parameter, here or in the two cases below.
      // `Class.id` is Prisma `String @default(uuid())`, which is a `text`
      // column, not Postgres `uuid` — casting the bound parameter makes the
      // comparison `text = uuid` and the statement dies with `42883` before
      // the trigger is ever consulted.
      let caughtRaw: unknown;
      try {
        await prisma.$executeRaw`UPDATE "Class" SET date = '2020-01-01' WHERE id = ${classId}`;
      } catch (err) {
        caughtRaw = err;
      }

      // A `$executeRaw` failure is a PrismaClientKnownRequestError (P2010)
      // carrying the SQLSTATE in ``Code: `23514` `` framing — NOT the
      // PrismaClientUnknownRequestError the typed path below produces.
      // `src/lib/api-errors.ts` documents both shapes for `55P03` and the
      // split is the same here: the engine has a P-code for "raw query
      // failed" and none for "a trigger fired".
      expect(caughtRaw).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(String(caughtRaw)).toMatch(/23514/);
      expect(String(caughtRaw)).toMatch(/which is terminal/);
      expect(String(caughtRaw)).toMatch(new RegExp(`is ${status}`));

      // The typed path, which is the one production actually takes: of the
      // `class.update`/`updateMany` sites in `src/`, the only one that writes
      // `date` is `updateClass`. It is also the only shape
      // `isTerminalStatusViolation` matches, so the 409 claim has to be
      // pinned against this write rather than the raw one above — asserting
      // it on the raw error would assert something no caller can observe.
      let caught: unknown;
      try {
        await prisma.class.update({
          where: { id: classId },
          data: { date: new Date('2020-01-01') },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
      expect(String(caught)).toMatch(/23514/);
      expect(String(caught)).toMatch(/which is terminal/);
      expect(String(caught)).toMatch(new RegExp(`is ${status}`));

      // The route's own mapping, not a second copy of it: whatever
      // classifyApiError does with this shape is what a caller would see.
      expect(classifyApiError(caught).status).toBe(409);

      const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
      expect(after.date.toISOString().slice(0, 10)).toBe(ORIGINAL_DATE);
    },
  );

  // The cases that prove the trigger CAN pass. Without them, a WHEN clause
  // mutated to fire unconditionally would still satisfy every case above.
  //
  // Every non-terminal status, not just `open`. `in_progress` is the one that
  // earns the sweep: the teacher edit page redirects away from it, so it is
  // easy to assume a freeze there is harmless — but the API allows that edit
  // and should, and a guard widened from `IN ('completed','cancelled')` to
  // "anything past draft" would pass a single-status `open` control while
  // breaking a real write. `draft` covers the same mutation from the other
  // end.
  it.each(NON_TERMINAL_STATUSES)('allows a date change on a %s class', async (status) => {
    const { classId } = await makeClass({ status });

    await prisma.$executeRaw`UPDATE "Class" SET date = '2099-07-01' WHERE id = ${classId}`;

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.date.toISOString().slice(0, 10)).toBe('2099-07-01');
  });

  it('allows a write that carries a terminal class\'s unchanged date alongside another column', async () => {
    // The IS DISTINCT FROM half of the WHEN clause, and the reason it is
    // there: `UPDATE OF date` fires whenever `date` is in the SET list, value
    // unchanged or not. Without this half, any future writer that carries the
    // current date along with the columns it means to change is rejected by a
    // guard aimed at something else — the same failure the sibling trigger
    // records for its own WHEN.
    const { classId } = await makeClass({ status: 'open' });
    await prisma.class.updateMany({
      where: { id: classId, status: 'open' },
      data: { status: 'completed' },
    });

    // `${ORIGINAL_DATE}::date`, NOT `${new Date(ORIGINAL_DATE)}`. Binding a JS
    // Date sends a timestamptz, which Postgres narrows to `date` using the
    // SESSION time zone — so the "unchanged" date silently becomes the
    // previous day under any westward session, the WHEN clause's
    // `IS DISTINCT FROM` then holds, and this case fails claiming the trigger
    // is wrong when only the clock was. It round-trips here because the
    // session is UTC, which is exactly the kind of accident this repo has
    // shipped before (see the warning comment in `prisma/seed.ts`). A plain
    // date string has no zone to misread.
    await prisma.$executeRaw`
      UPDATE "Class" SET date = ${ORIGINAL_DATE}::date, description = 'Unchanged date'
      WHERE id = ${classId}`;

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.description).toBe('Unchanged date');
    expect(after.date.toISOString().slice(0, 10)).toBe(ORIGINAL_DATE);
  });

  /**
   * The same drift pin `class-terminal-status.test.ts` ends with, applied to
   * the other half of the same predicate — and it has to be a SECOND pin, not
   * a reuse of that one, because the two triggers hard-code
   * `('completed','cancelled')` in two different applied migrations that
   * nothing forces to agree.
   *
   * `reapClosedWaitlistEntries` permanently deletes rows on a class that is
   * terminal AND more than 365 days past its `date`. Its safety argument is
   * "no writer can ever touch those rows again", and that argument now rests
   * on two triggers: the sibling freezes `status`, this one freezes `date`.
   * `TERMINAL_CLASS_STATUSES` is DERIVED from `VALID_TRANSITIONS`, while both
   * triggers restate the set as frozen SQL. Widen the transition table and the
   * constant widens silently, the reaper starts reaping a third status — and
   * without this pin the DATE half would go unenforced for it with nothing
   * red. The sibling's pin would still pass: it only reads its own migration.
   *
   * The rejection `it.each` catches the set GROWING (a new terminal status
   * gets a rejection case that fails, because the SQL does not cover it). It
   * cannot catch the set SHRINKING: give `cancelled` an outgoing transition
   * and the set becomes `['completed']`, and every case it still generates
   * passes, because a case that is no longer generated cannot fail.
   *
   * Not the only thing that notices a shrink, and the honest version of this
   * paragraph says so: `NON_TERMINAL_STATUSES` is the enum minus the terminal
   * set, so a status leaving that set arrives in the allow-`it.each` directly
   * above, where the raw date update meets SQL that still names it and throws
   * `23514`. That case reddens too.
   *
   * This pin earns its place on two other grounds. It fails with a NAMED
   * diagnostic — the two sets printed side by side — where the allow-case
   * fails with a bare `23514` that reads as "the trigger is broken" rather
   * than "the constant and the SQL have drifted apart", and misreading that
   * points the next person at the migration instead of at
   * `VALID_TRANSITIONS`. And it covers the limit neither `it.each` reaches:
   * empty the terminal set and BOTH families generate vacuously — no
   * rejection cases at all, and allow-cases that pass honestly — while the
   * reaper stops reaping entirely. That is what the two length assertions are
   * for.
   *
   * Read out of the migration's own SQL rather than restated here, so the
   * enforced set is written down in exactly one place. Regex over SQL is
   * normally fragile; here it inverts, because the file is an APPLIED
   * migration that `CLAUDE.md` forbids editing, so the text is frozen by
   * policy — and the `if (!inList)` guard turns a shape change into a named
   * failure rather than a silent pass. Reads a file; touches no database.
   */
  it('matches the exact status set the trigger SQL enforces', () => {
    const sql = readFileSync(
      new URL(
        '../../prisma/migrations/20260817120000_class_terminal_date_trigger/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    // `noUncheckedIndexedAccess` makes the capture groups possibly-undefined,
    // and the narrowing is kept rather than cast away: a `!` here would turn a
    // shape change into a runtime `undefined` inside the comparison, which is
    // the failure mode this pin exists to make loud.
    const inList = sql.match(/OLD\.status IN \(([^)]+)\)/)?.[1];
    if (!inList) throw new Error('trigger SQL no longer has the shape this pin reads');
    const enforced = [...inList.matchAll(/'([a-z_]+)'/g)]
      .map((x) => x[1])
      .filter((s): s is string => s !== undefined)
      .sort();

    expect(enforced.length).toBeGreaterThan(0);
    expect(TERMINAL_CLASS_STATUSES.length).toBeGreaterThan(0);
    expect([...TERMINAL_CLASS_STATUSES].sort()).toEqual(enforced);
  });
});
```

- [ ] **Step 5: Run it green**

```bash
npx vitest run --project unit src/services/class-terminal-date.test.ts
```

Expected: all **7** cases now pass — two rejection cases (driven by
`TERMINAL_CLASS_STATUSES`, not by a literal), three allow-cases over the
non-terminal statuses, the unchanged-date case, and the SQL drift pin. If the
unchanged-date case fails with `23514`, the `IS DISTINCT FROM` half of the
`WHEN` clause is missing from the migration. If the drift pin fails, the
constant and the trigger's hard-coded status list have drifted apart — look at
`VALID_TRANSITIONS`, not at the migration.

- [ ] **Step 6: Mutation M10 — drop the trigger**

```bash
docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test \
  -c 'DROP TRIGGER class_terminal_date_guard ON "Class";'
npx vitest run --project unit src/services/class-terminal-date.test.ts
```

Expected: **FAIL on the two rejection cases only** — the
`it.each(TERMINAL_CLASS_STATUSES)` family, not the allow-`it.each` below it,
which keeps passing because with no trigger everything is allowed. `caughtRaw`
is `undefined` (the raw write is the first of the two writes in that case, so
it reddens before the typed one is reached), so
`expect(caughtRaw).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)` is the
assertion that fires. The drift pin also keeps passing: it reads the migration
file, which this mutation does not touch. Record the exact output.

Worth running the sibling file too while the trigger is gone —
`class-terminal-status.test.ts` should stay fully green. That is the
independence claim its docblock makes: dropping one trigger must redden only
its own file.

Restore with the recipe in the file's docblock and confirm green:

```bash
docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test \
  < prisma/migrations/20260817120000_class_terminal_date_trigger/migration.sql
npx vitest run --project unit src/services/class-terminal-date.test.ts
```

- [ ] **Step 7: Mutation M11 — drop the `IS DISTINCT FROM` half**

Recreate the trigger in the test DB with only `OLD.status IN (...)` in the
`WHEN`. Run the file.

Expected: **FAIL on exactly one case** — `'allows a write that carries a
terminal class's unchanged date alongside another column'` — with `23514`, and
the error message is the mutation's own confession: `cannot change its date
from <d> to <d>`, the same value on both sides. The other six pass, including
the drift pin, which reads the migration file this mutation deliberately does
not touch. Record it. Restore from the migration file. **Do not edit the
migration** — this mutation is applied directly to the test database and
reverted the same way, and the file is applied, which `CLAUDE.md` forbids
editing.

- [ ] **Step 8: Re-run Task 1's M1 with the trigger present**

Re-apply Task 1 Step 12's mutation (remove the early return and both `...live`
spreads) and run:

```bash
npx vitest run --project unit src/services/class-lifecycle.test.ts -t 'refuses a date edit on a completed class'
```

Expected: **FAIL again, but differently** — now the write reaches the database
and the trigger throws `23514` instead of the edit succeeding. Record both
outcomes side by side. Two different failures from one mutation is the evidence
that the service guard and the trigger are independent layers rather than one
guard counted twice. Restore.

- [ ] **Step 9: Narrow the sibling test's title (spec §5.2)**

In `src/services/class-terminal-status.test.ts:370`, the title `'leaves
non-status updates to a completed class alone'` now over-claims. The test stays
green — it writes `description`, and this branch's trigger is `BEFORE UPDATE OF
date` — but some non-status updates are no longer left alone. Replace the title
and add the pointer:

```ts
  it('leaves a non-status, non-date update to a completed class alone', async () => {
    // Narrowed by #247. `date` is now guarded on a terminal class by a SECOND
    // trigger, `class_terminal_date_guard`, pinned in the sibling file
    // `class-terminal-date.test.ts`. This case is about THIS trigger's `OF
    // status` scope, so it deliberately writes neither column.
```

Its two neighbours were checked and need nothing: `'allows a completeClass-shaped
write…'` writes status plus three totals, and `'allows a no-op status write on a
cancelled class'` writes status alone. Neither names `date`.

- [ ] **Step 10: Run both trigger files together**

```bash
npx vitest run --project unit src/services/class-terminal-status.test.ts src/services/class-terminal-date.test.ts
```

Expected: both green.

- [ ] **Step 11: Commit**

```bash
git add prisma/migrations/20260817120000_class_terminal_date_trigger/migration.sql \
        src/services/class-terminal-date.test.ts \
        src/services/class-terminal-status.test.ts
git commit -m "feat: the database refuses to move a terminal class's date"
```

---

## Task 5: Retire the residual everywhere it is claimed

Six locations. **Each gets its own verdict at review, not one verdict for "the
docs".** The #41 failure mode was a three-location finding marked ADDRESSED on
the strength of the two files the reviewer happened to open.

**Files:**
- Modify: `src/services/waitlist-retention.ts` (the `THE SECOND HALF OF THE PREDICATE IS NOT ENFORCED` section, ~`:56-70`)
- Modify: `docs/superpowers/specs/2026-08-16-waitlist-retention-design.md` (§2.4, ~`:328-345`)
- Modify: `docs/data-model.md` (~`:405`)
- Modify: `CLAUDE.md` (Class Lifecycle section)

- [ ] **Step 1: Rewrite the retention header's residual section**

Locate it and read the current text before replacing — do not paste over a
range by line number alone:

```bash
grep -n "THE SECOND HALF OF THE PREDICATE IS NOT ENFORCED" src/services/waitlist-retention.ts
```

Replace that section with one that says both halves are now enforced and by
what. It must name: `class_terminal_status_guard` for `status`,
`class_terminal_date_guard` plus `updateClass`'s compare-and-swap for `date`,
and that the service freeze is wider than the trigger (whole class vs one
column) on purpose. Keep the section heading's shape but invert its claim —
a future reader greps for the old heading, so leaving a same-shaped heading
that now reads `BOTH HALVES OF THE PREDICATE ARE ENFORCED` is what makes the
change findable.

- [ ] **Step 2: Amend the retention spec's §2.4**

```bash
grep -n "This is a known residual, tracked as #247" docs/superpowers/specs/2026-08-16-waitlist-retention-design.md
```

That spec is a historical design record, so **amend rather than rewrite**: leave
the four bullets (each was true of the tree it described) and append a dated
note saying the residual was closed on 2026-08-17, by what, and pointing at
`2026-08-17-terminal-class-freeze-design.md`.

- [ ] **Step 3: Add the second freeze point to the live reference docs**

`docs/data-model.md:405` currently documents only the economic lock:

> **settings_locked** on Class flips to true when the first Registration is
> created. After that, economic fields (room_cost, min_rate, target_rate,
> min_students, max_students) are immutable.

That statement stays true; it is incomplete. Add a sibling bullet for the second
freeze point — terminal status freezes every field, enforced in `updateClass`
and, for `date`, by `class_terminal_date_guard`.

Do the same in `CLAUDE.md`'s **Class Lifecycle** section, which today says only
`settings_locked` flips true on first registration. One line, matching the
surrounding density.

- [ ] **Step 4: Reconcile against the diff, not against a keyword**

Do not grep for one phrase and call it done — that is how #41's twin survived.
List what changed and compare it to what should have changed:

```bash
git diff --stat HEAD
grep -rn "247" docs/ src/ prisma/ CLAUDE.md | grep -v backlog-roadmap | grep -v "2026-08-17-terminal"
```

Every surviving hit must now *describe the fix*, not an open residual. Four
files should appear in the diff: `waitlist-retention.ts`, the retention spec,
`docs/data-model.md`, `CLAUDE.md`.

- [ ] **Step 5: Commit**

```bash
git add src/services/waitlist-retention.ts \
        docs/superpowers/specs/2026-08-16-waitlist-retention-design.md \
        docs/data-model.md CLAUDE.md
git commit -m "docs: the retention sweep's predicate is enforced on both halves now"
```

---

## Task 6: Whole-branch verification

- [ ] **Step 1: Run everything**

```bash
npm run verify
```

Expected: typecheck, lint and all three vitest projects green. It needs the app
on `:3000`; a wall of `ECONNREFUSED` means the server is down — ask, do not
start it.

- [ ] **Step 2: Record the arithmetic**

Capture files and tests per project, with totals that reconcile
(`a + b + c = total`), and compare against the baseline taken before Task 1.
The delta must be explainable by the eleven tests this branch adds — if it is
not, find out why before writing the PR body. Do not predict the number and
report the prediction.

- [ ] **Step 3: Confirm no migration drift**

```bash
npx prisma validate
npx prisma migrate status
```

Expected: valid, and no pending migrations. `schema.prisma` was not modified, so
there is nothing for CI's drift check to catch — confirm rather than assume.

- [ ] **Step 4: Confirm the mutation ledger is complete**

Eleven tests, eleven mutations (M1–M11, with M6 run twice, once per filter arm).
Each needs its exact recorded error text, and none of them survive the suite —
deleting the early return (M7) reddens both T5 (DB-backed, on the wrong
refusal reason) and T9 (stub, on the write-count assertion); see spec §3.4 for
why an earlier draft claimed otherwise. M6 also reddens two tests per arm, not
one: the non-economic arm reddens T8 alongside Task 1's pre-existing `'reports
not_found when no economic field was sent — the row was deleted (#72)'`, and
the economic arm reddens T8 alongside Task 1's pre-existing `'reports locked
when the row survives — the compare-and-swap lost its race'` — both
pre-existing tests already assert the same `notIn` conjunct T8 does, so each
is independently sensitive to the arm T8 is checking. M5 reddens exactly one
test, T7, matching the original prediction.

---

## Self-Review Notes

Checked against the spec:

- §3.1 variant → Task 1 Step 4. §3.2 three sites → Steps 6–8. The `in_progress`
  boundary → Task 1 Step 2's `it.each`. §3.3 mandatory branch → Step 8, proved
  by Task 2 M5. §3.4 (no predicted survivor; M7 reddens both T5 and T9) →
  Task 2 M7. §3.5 docblocks → Steps 4–5.
- §4 trigger → Task 4 Steps 1–2. §4.1 narrowness → argued in the migration
  comment. §4.2 measurement → carried into that comment so it survives where a
  future reader will look.
- §5 T1–T11 → Tasks 1–4. §5.2 title → Task 4 Step 8.
- §6 artifacts → Task 5, with the diff reconciliation at Step 4.
- §7 the UI path is filed after merge, not built here.

Two things this plan adds that the spec did not anticipate:

1. **Task 1 Step 10.** The CAS changes the `where` shape that two *existing*
   stub tests assert verbatim. They break the moment the conjunct lands, and
   they break in Task 1, not Task 2 — so the fix belongs in Task 1.
2. **Task 1 Step 13 and Task 2.** Measuring that the disambiguation branch is
   invisible to every DB-backed test is what justifies Task 2 existing at all,
   rather than folding its three cases in as extra coverage.
