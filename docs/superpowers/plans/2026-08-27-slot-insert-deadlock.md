# Slot-insert deadlock, and the create path gets a named outcome — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four plain `INSERT`s stop deadlocking against the two slot exclusion constraints, and the two template creates move into services so they can bound their lock wait and name the outcome.

**Architecture:** Each nested `create` splits into: insert the parent alone with `skipDuplicates: true` (`ON CONFLICT DO NOTHING`, the deadlock-free speculative path), branch on whether a row came back, then insert the child on the returned `(id, kind)` scalars. For the two template creates that branch becomes the `slot_conflict` arm of a house-convention result union, returned from a new service function that opens with `setLockTimeout(tx)` — issue 331's refusal mechanism *is* issue 228's named outcome.

**Tech Stack:** Next.js App Router route handlers, Prisma, PostgreSQL 16, vitest (`integration` project over HTTP against `:3000`).

**Spec:** `docs/superpowers/specs/2026-08-27-slot-insert-deadlock-design.md`

## Global Constraints

- **Issues 331 and 228 together.** 331 covers all four sites; 228 covers only the two template creates.
- **No new status and no new 409 code.** All four sites keep their existing 409 message and code. The `busy` 503 is new only where 228 puts it.
- **The two entry routes get no bound and no service move.** They are outside 228's scope. Adding a bare `setLockTimeout` there yields a generic 503, which is the defect class this round removes. Record the gap as an update on 228 (Task 5).
- **Both template families or neither**, per 228 and #227 before it.
- **Do not move generation out of the transaction.** The atomicity is load-bearing and the counts it returns are rendered by the create form.
- **The generators are out of scope.** `class-generator.ts:523` and `studio-class-generator.ts:325` already use `skipDuplicates`. Do not touch them.
- **The slot-moving `UPDATE`s are out of scope** — `docs/lock-order.md`'s vacate-and-claim shape, a different defect.
- TypeScript `strict: true`, no `any`. Never start or restart the dev server on `:3000`. Commit per task.
- **Quote bracketed paths** — `'src/app/api/class-templates/[id]/route.ts'`. Unquoted, zsh matches nothing.

## The lock arithmetic, which this plan changes

228 recorded `N = 2` waiting statements against the 10s budget. Splitting the nested create makes the transaction four statements — parent insert, child insert, generation's `findMany`, generation's `createManyAndReturn` — of which **three** can wait on a lock (the `findMany` is a plain read and does not wait under READ COMMITTED). So `3 × 2s = 6s` inside `{ timeout: 10_000 }`, with 4s of headroom.

**Anyone adding a fifth waiting statement must redo this sum**, per `docs/lock-order.md`. At `5 × 2s` the headroom is gone and the recommendation flips.

---

### Task 1: `createStudioClassTemplate` — the site that is red on `main`

**Files:**
- Modify: `src/services/studio-class-template-lifecycle.ts` (add the service beside its three siblings)
- Modify: `src/app/api/studio-class-templates/route.ts:104-165`
- Test: `tests/integration/studio-api.test.ts:293`

**Interfaces:**
- Consumes: `setLockTimeout(tx)` (`@/lib/db-locks`), `ruleSlotHolder(db, probe)` (`@/lib/rule-slot-holder`), `isTransientDbError` (`@/lib/api-errors`), `generateStudioInstancesForTemplate(tx, template)`.
- Produces: `CreateStudioTemplateResult` and `createStudioClassTemplate`, which Task 2 mirrors.

- [ ] **Step 1: Make the racing test repeat, so it can fail**

The existing single-shot case passes against the bug roughly 3 times in 4 (measured: 1 failure in 4 full-suite runs), so one run cannot observe issue 331. Ten independent races miss it with probability `0.75^10 ≈ 0.056`.

Replace the body of `it('leaves one template and one window when two identical creates are in flight at once', …)` in `tests/integration/studio-api.test.ts`:

```ts
      // TEN RACES, NOT ONE (issue 331). Ten 45-minute slots at 02:00 … 11:00
      // on dayOfWeek 0 do not overlap each other, so each race is independent
      // of its predecessors' leftover rows — the hazard the sibling case in
      // the `POST /api/studio-classes` describe documents.
      for (let i = 0; i < 10; i++) {
        const body = {
          classType: `Slot Studio Concurrent ${i}`, dayOfWeek: 0,
          startTime: `${String(2 + i).padStart(2, '0')}:00`,
          durationMinutes: 45, location: 'Some Studio', hourlyRate: 45,
        };

        const [a, b] = await Promise.all([post(body), post(body)]);
        const [bodyA, bodyB] = await Promise.all([a.json(), b.json()]);
        const outcomes = `${a.status}:${bodyA?.error?.code ?? '-'} ${b.status}:${bodyB?.error?.code ?? '-'}`;

        expect([a.status, b.status].sort(), `race ${i}: ${outcomes}`).toEqual([201, 409]);

        const loserBody = a.status === 409 ? bodyA : bodyB;
        expect(loserBody.error.code).toBe('DUPLICATE_STUDIO_TEMPLATE_SLOT');
      }
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts -t 'in flight at once'`
Expected: FAIL, `expected [ 201, 503 ] to deeply equal [ 201, 409 ]`, prefixed `race N:`.

- [ ] **Step 3: Verify the names this task depends on**

Do not write code until each of these prints what the step below assumes:

```bash
grep -n 'export type .*Result' src/services/studio-class-template-lifecycle.ts
grep -n 'withSlot\|WithSlot' src/services/studio-class-template-lifecycle.ts | head
grep -n 'isTransientDbError' src/lib/api-errors.ts | head -3
grep -n 'SLOT_TAKEN' src/app/api/studio-class-templates/route.ts
```

The union below is written to match `ArchiveTemplateResult` in the class family (`src/services/class-template-lifecycle.ts:1288`), which already carries `slot_conflict` with `heldBy`. **If the studio file's siblings differ, follow the studio file** and report the drift.

- [ ] **Step 4: Add the service**

In `src/services/studio-class-template-lifecycle.ts`, beside its siblings:

```ts
/**
 * A create either lands, loses the slot, or loses a contention race. The
 * `slot_conflict` arm carries `heldBy` for the same reason
 * `ArchiveTemplateResult`'s does: one exclusion constraint spans both families
 * (issue 298) and cannot say which raised it, so a fresh probe answers.
 *
 * `slot_conflict` is NOT produced by catching a `23P01` here. The rule insert
 * uses `ON CONFLICT DO NOTHING`, which refuses by returning no row — the
 * deadlock-free path (issue 331). A plain INSERT inserts its tuple and THEN
 * checks the exclusion constraint, so two conflicting creates each wait on the
 * other's transaction and Postgres breaks the cycle with `40P01`.
 */
export type CreateStudioTemplateResult =
  | { ok: true; template: StudioClassTemplateWithSlot; generation: GenerationResult }
  | { ok: false; reason: 'slot_conflict'; heldBy: RuleSlotHolder }
  | { ok: false; reason: 'busy' };

export async function createStudioClassTemplate(
  db: PrismaClient,
  teacherId: string,
  input: CreateStudioClassTemplateInput,
): Promise<CreateStudioTemplateResult> {
  let outcome:
    | { ok: true; created: StudioClassTemplateWithSlot; generation: GenerationResult }
    | { ok: false };
  try {
    outcome = await db.$transaction(async (tx) => {
      // FIRST STATEMENT, per every sibling in this file. Three of this
      // transaction's four statements can wait on a lock, so 3 x 2s sits
      // inside the 10s budget with headroom; redo that sum before adding a
      // fourth waiting statement (issue 228, docs/lock-order.md).
      await setLockTimeout(tx);
      const [rule] = await tx.scheduleRule.createManyAndReturn({
        data: [{
          teacherId,
          kind: 'studio' as const,
          classType: input.classType,
          dayOfWeek: input.dayOfWeek,
          startTime: hhmmToTime(input.startTime),
          durationMinutes: input.durationMinutes,
        }],
        skipDuplicates: true,
      });
      // No row means a constraint refused it. WHICH one is not knowable here —
      // `ON CONFLICT DO NOTHING` carries no conflict target — so the probe
      // runs below, on `db`, after this transaction has closed.
      if (!rule) return { ok: false as const };

      const created = await tx.studioClassTemplate.create({
        data: {
          scheduleRuleId: rule.id,
          kind: 'studio',
          location: input.location,
          hourlyRate: input.hourlyRate,
        },
        include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
      });
      const generation = await generateStudioInstancesForTemplate(tx, created);
      return { ok: true as const, created, generation };
    }, { timeout: 10_000 });
  } catch (err) {
    // BEFORE any conflict check, as all three siblings document: `P2028` and
    // `P2024` are `PrismaClientKnownRequestError`s too, so the other ordering
    // drops them into a branch that does not match and out to a generic 500.
    if (isTransientDbError(err)) return { ok: false, reason: 'busy' };
    throw err;
  }

  if (!outcome.ok) {
    const heldBy = await ruleSlotHolder(db, {
      teacherId,
      dayOfWeek: input.dayOfWeek,
      startMinutes: minutesSinceMidnight(hhmmToTime(input.startTime)),
      durationMinutes: input.durationMinutes,
    });
    return { ok: false, reason: 'slot_conflict', heldBy };
  }
  return { ok: true, template: outcome.created, generation: outcome.generation };
}
```

- [ ] **Step 5: Make the route a thin wrapper**

Replace the route's transaction and catch with:

```ts
  const result = await createStudioClassTemplate(prisma, session.teacherId, parsed.data);

  if (!result.ok && result.reason === 'slot_conflict') {
    log.warn(
      { teacherId: session.teacherId, heldBy: result.heldBy },
      'recurring studio class create refused: that slot is taken',
    );
    const [message, code] = SLOT_TAKEN[result.heldBy];
    return respondError(message, 409, code);
  }
  if (!result.ok && result.reason === 'busy') {
    return respondError(
      'The system was busy and could not create this recurring studio class. Nothing was created. Wait a moment, then try again.',
      503,
      'STUDIO_TEMPLATE_BUSY',
    );
  }
  if (!result.ok) {
    // Exhaustiveness: a new CreateStudioTemplateResult arm becomes a compile
    // error here rather than being answered as a success.
    const unhandled: never = result;
    return unhandled;
  }
```

Then shape the 201 from `result.template` and `result.generation` exactly as the handler does today. **Confirm the `busy` copy and code against the studio family's existing arms** — `grep -n 'BUSY' 'src/app/api/studio-class-templates/[id]/route.ts'` — and reuse their wording pattern rather than inventing one.

- [ ] **Step 6: Run the test**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts`
Expected: PASS, all cases.

- [ ] **Step 7: Prove each guard bites**

For each: apply, run, record the exact error text, restore, re-verify green.

1. Remove `skipDuplicates: true` → the deadlock or an exclusion violation returns. A pass here means the test is not testing the fix.
2. Invert the branch to `if (rule) return { ok: false as const };` → failure on the 201, not a silent second row.
3. **Reinstate the nested `scheduleRule: { create: … }` shape.** This is the realistic regression — someone tidying two statements back into one — and the racing test is the only thing that catches it.
4. Delete the `busy` arm from the route → **expect a compile error at the `never` guard.** That guard is 228's actual deliverable; if removing an arm still compiles, the union is not doing its job.
5. Move `isTransientDbError` *after* a conflict check → expect a transient error to reach a generic 500 rather than `busy`.

- [ ] **Step 8: Commit**

```bash
git add src/services/studio-class-template-lifecycle.ts src/app/api/studio-class-templates/route.ts tests/integration/studio-api.test.ts
git commit -m "fix: the studio template create refuses without deadlocking, and names its outcome (issues 331, 228)"
```

---

### Task 2: `createClassTemplate` — the class family twin

**Files:**
- Modify: `src/services/class-template-lifecycle.ts`
- Modify: `src/app/api/class-templates/route.ts:126-260`
- Test: `tests/integration/class-templates-api.test.ts`

**Interfaces:**
- Produces: `CreateTemplateResult`, `createClassTemplate(db, teacherId, input)`.
- `ClassTemplate` carries a `teacherRoomId` scalar, so the child create uses the **unchecked** shape — which reverts the `teacherRoom: { connect: … }` form that #298's nested write forced.

- [ ] **Step 1: Write the failing test**

Find the racing case: `grep -n 'in flight at once' tests/integration/class-templates-api.test.ts`. Give it the same ten-race loop as Task 1 Step 1, with `classType: \`Slot Class Concurrent ${i}\``, a weekday free in that file, and the 409 code confirmed by `grep -n 'DUPLICATE.*SLOT' src/app/api/class-templates/route.ts` — do not copy Task 1's code, it is a different constant.

If the file has no racing case, add one modelled on Task 1 Step 1, using this file's own body-builder and token helpers (`grep -n 'ownerToken\|function valid' tests/integration/class-templates-api.test.ts | head`).

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project integration tests/integration/class-templates-api.test.ts -t 'in flight at once'`
Expected: FAIL with `[ 201, 503 ]`.

- [ ] **Step 3: Add the service**

In `src/services/class-template-lifecycle.ts`, beside `updateClassTemplate`, `pauseOrResumeTemplate` and `archiveOrUnarchiveTemplate`:

```ts
export type CreateTemplateResult =
  | { ok: true; template: ClassTemplateWithSlot; generation: GenerationResult }
  | { ok: false; reason: 'slot_conflict'; heldBy: RuleSlotHolder }
  | { ok: false; reason: 'busy' };

export async function createClassTemplate(
  db: PrismaClient,
  teacherId: string,
  input: CreateClassTemplateInput,
): Promise<CreateTemplateResult> {
  let outcome:
    | { ok: true; created: ClassTemplateWithSlot; generation: GenerationResult }
    | { ok: false };
  try {
    outcome = await db.$transaction(async (tx) => {
      await setLockTimeout(tx);
      const [rule] = await tx.scheduleRule.createManyAndReturn({
        data: [{
          teacherId,
          kind: 'regular' as const,
          classType: input.classType,
          dayOfWeek: input.dayOfWeek,
          startTime: hhmmToTime(input.startTime),
          durationMinutes: input.durationMinutes,
        }],
        skipDuplicates: true,
      });
      if (!rule) return { ok: false as const };

      const created = await tx.classTemplate.create({
        data: {
          scheduleRuleId: rule.id,
          kind: 'regular',
          teacherRoomId: input.teacherRoomId,
          description: input.description,
          roomCost: input.roomCost,
          minRate: input.minRate,
          targetRate: input.targetRate,
          minStudents: input.minStudents,
          maxStudents: input.maxStudents,
          cancelDeadline: input.cancelDeadline,
          autoCancelCheck: input.autoCancelCheck,
        },
        include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
      });
      const generation = await generateInstancesForTemplate(tx, created);
      return { ok: true as const, created, generation };
    }, { timeout: 10_000 });
  } catch (err) {
    if (isTransientDbError(err)) return { ok: false, reason: 'busy' };
    throw err;
  }

  if (!outcome.ok) {
    const heldBy = await ruleSlotHolder(db, {
      teacherId,
      dayOfWeek: input.dayOfWeek,
      startMinutes: minutesSinceMidnight(hhmmToTime(input.startTime)),
      durationMinutes: input.durationMinutes,
    });
    return { ok: false, reason: 'slot_conflict', heldBy };
  }
  return { ok: true, template: outcome.created, generation: outcome.generation };
}
```

**Verify before writing:** the generator function name and the full `data` key list — `sed -n '126,175p' src/app/api/class-templates/route.ts`. The list above is written from the file at `499da845`; any drift is the file's, and should be reported.

- [ ] **Step 4: Make the route a thin wrapper**

```ts
  const result = await createClassTemplate(prisma, session.teacherId, body);

  if (!result.ok && result.reason === 'slot_conflict') {
    log.warn(
      { teacherId: session.teacherId, heldBy: result.heldBy },
      'recurring class create refused: that slot is taken',
    );
    const [message, code] = SLOT_TAKEN[result.heldBy];
    return respondError(message, 409, code);
  }
  if (!result.ok && result.reason === 'busy') {
    return respondError(
      'The system was busy and could not create this recurring class. Nothing was created. Wait a moment, then try again.',
      503,
      'TEMPLATE_BUSY',
    );
  }
  if (!result.ok) {
    // Exhaustiveness: a new CreateTemplateResult arm becomes a compile error
    // here rather than being answered as a success.
    const unhandled: never = result;
    return unhandled;
  }
```

Then shape the 201 from `result.template` and `result.generation` exactly as the handler does today. The `busy` copy above follows this family's existing wording — *"The system was busy and could not … Nothing was changed."* at `'src/app/api/class-templates/[id]/route.ts':155` — with **"Nothing was created"** because this is a create. Confirm `TEMPLATE_BUSY` is the code that file uses before reusing it: `grep -n 'TEMPLATE_BUSY' 'src/app/api/class-templates/[id]/route.ts'`. Take `SLOT_TAKEN` and the `log.warn` message from this route's own existing catch arm rather than inventing them.

Delete the long `catch` block's `isExclusionConflictOn(err, 'ScheduleRule_teacher_slot_excl')` arm — the service answers that as `slot_conflict` now — and **keep the comment block at `:230-250` about what the 10s budget does and does not bound**, updating its final paragraph: the bound is no longer absent, and issue 228 is no longer pending for this route.

- [ ] **Step 5: Run the test**

Run: `npx vitest run --project integration tests/integration/class-templates-api.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove each guard bites**

The five mutations from Task 1 Step 7, against this route and service.

- [ ] **Step 7: Commit**

```bash
git add src/services/class-template-lifecycle.ts src/app/api/class-templates/route.ts tests/integration/class-templates-api.test.ts
git commit -m "fix: the recurring class template create refuses without deadlocking, and names its outcome (issues 331, 228)"
```

---

### Task 3: `POST /api/classes` — the entry layer, issue 331 only

**Files:**
- Modify: `src/app/api/classes/route.ts:71-165`
- Test: `tests/integration/classes-api.test.ts`

**Interfaces:**
- Consumes: `probeConflictingEntry(db, teacherId, span)` and `entryConflictMessage(conflict, family)` (`@/lib/entry-conflict`).
- **No service move and no `setLockTimeout` here** — outside 228's scope; see Global Constraints.
- Prisma already wraps this route's nested write in a transaction — measured `BEGIN`, two `INSERT`s, `SELECT`, `COMMIT`, and the route's own comment at `:143` says so. The explicit `$transaction` preserves that atomicity across two Prisma calls; it does not create a lock-holding path.

- [ ] **Step 1: Write the failing test**

```ts
    it('answers 409 rather than 503 when two identical creates are in flight at once', async () => {
      // Issue 331: a plain INSERT against `CalendarEntry_teacher_slot_excl`
      // inserts its tuple then checks, so two conflicting creates deadlock and
      // the loser answers 503. Ten races because one pair passes against the
      // bug most of the time.
      for (let i = 0; i < 10; i++) {
        const body = {
          ...validClassBody(),
          date: '2031-05-12',
          startTime: `${String(2 + i).padStart(2, '0')}:00`,
          durationMinutes: 45,
        };
        const [a, b] = await Promise.all([
          send('POST', ownerToken, '/api/classes', body),
          send('POST', ownerToken, '/api/classes', body),
        ]);
        expect([a.status, b.status].sort(), `race ${i}`).toEqual([201, 409]);
      }
    });
```

**Verify before writing:** the body-builder and token names in this file — `grep -n 'ownerToken\|function valid\|send(' tests/integration/classes-api.test.ts | head`. Use what is there.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project integration tests/integration/classes-api.test.ts -t 'in flight at once'`
Expected: FAIL with a 503 among the statuses.

- [ ] **Step 3: Split the create**

```ts
    const outcome = await prisma.$transaction(async (tx) => {
      // The ENTRY is inserted alone and first — it holds the slot constraint,
      // and `skipDuplicates` (`ON CONFLICT DO NOTHING`) makes it refuse with
      // zero rows rather than deadlock against a concurrent conflicting
      // insert (issue 331). Parent before child is forced by the composite
      // foreign key; this is a creation path, so `docs/lock-order.md`'s
      // `Class`-then-entry rule, which governs a write to two EXISTING rows,
      // does not apply.
      //
      // No `setLockTimeout` here, still: issue 228 tracks the bound for the
      // create paths, and alone it would turn a wait that usually succeeds
      // into a generic 503 rather than a named one.
      const [entry] = await tx.calendarEntry.createManyAndReturn({
        data: [{
          teacherId: session.teacherId,
          kind: 'regular' as const,
          classType: body.classType,
          date: new Date(body.date),
          startTime: hhmmToTime(body.startTime),
          durationMinutes: body.durationMinutes,
        }],
        skipDuplicates: true,
      });
      if (!entry) return { ok: false as const };

      const cls = await tx.class.create({
        data: {
          calendarEntryId: entry.id,
          kind: 'regular',
          teacherRoomId: body.teacherRoomId,
          description: body.description ?? null,
          roomCost: body.roomCost,
          minRate: body.minRate,
          targetRate: body.targetRate,
          minStudents: body.minStudents,
          maxStudents: body.maxStudents,
          cancelDeadline: body.cancelDeadline,
          autoCancelCheck: body.autoCancelCheck,
          status: 'draft',
        },
      });
      return { ok: true as const, entry, cls };
    });

    if (!outcome.ok) {
      // WHICH entry, asked of the database, because a zero row count does not
      // say — and either family can be the answer, since both live in one
      // table now. On `prisma`, never on a transaction client: the one above
      // has closed.
      const conflict = await probeConflictingEntry(prisma, session.teacherId, {
        date: new Date(body.date),
        startTime: hhmmToTime(body.startTime),
        durationMinutes: body.durationMinutes,
      });
      log.warn(
        { teacherId: session.teacherId, conflictEntryId: conflict?.id ?? null },
        'class create refused: another live entry holds that slot',
      );
      return respondError(entryConflictMessage(conflict, 'regular'), 409, 'DUPLICATE_CLASS_SLOT');
    }
    const { entry, cls } = outcome;
```

The `if (!cls) throw new Error('class create: the nested class row did not come back')` guard goes — `tx.class.create` returns the row or throws. Delete the catch arm that mapped the exclusion violation to this same 409; the zero-row branch replaces it. Keep any other arm in that catch untouched.

- [ ] **Step 4: Run the test**

Run: `npx vitest run --project integration tests/integration/classes-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove each guard bites**

Mutations 1, 2 and 3 from Task 1 Step 7, against this route.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/classes/route.ts tests/integration/classes-api.test.ts
git commit -m "fix: the class create refuses without deadlocking (issue 331)"
```

---

### Task 4: `POST /api/studio-classes` — the entry layer twin

**Files:**
- Modify: `src/app/api/studio-classes/route.ts:57-125`
- Test: `tests/integration/studio-api.test.ts`, the `POST /api/studio-classes` describe

**Interfaces:** as Task 3, with `kind: 'studio'`, the child on `tx.studioClass`, and `entryConflictMessage(conflict, 'studio')`.

- [ ] **Step 1: Write the failing test**

The racing case already exists — `grep -n 'exactly one row when two identical creates' tests/integration/studio-api.test.ts`. Give it the ten-race loop, and **keep its existing comment** about picking a start time clear of the previous case's leftover 11:00 row: the loop makes that hazard sharper, since every iteration now leaves a row behind. Space the ten slots so no two overlap.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts -t 'exactly one row'`
Expected: FAIL with a 503 among the statuses.

- [ ] **Step 3: Split the create**

```ts
    const outcome = await prisma.$transaction(async (tx) => {
      // See `api/classes/route.ts` and issue 331: the entry holds the slot
      // constraint, and `skipDuplicates` refuses with zero rows rather than
      // deadlocking against a concurrent conflicting insert. No
      // `setLockTimeout` here for the reason that route states.
      const [entry] = await tx.calendarEntry.createManyAndReturn({
        data: [{
          teacherId: session.teacherId,
          kind: 'studio' as const,
          classType: body.classType,
          date: new Date(body.date),
          startTime: hhmmToTime(body.startTime),
          durationMinutes: body.durationMinutes,
        }],
        skipDuplicates: true,
      });
      if (!entry) return { ok: false as const };

      const studioClass = await tx.studioClass.create({
        data: {
          calendarEntryId: entry.id,
          kind: 'studio',
          location: body.location,
          hourlyRate: body.hourlyRate,
        },
      });
      return { ok: true as const, entry, studioClass };
    });

    if (!outcome.ok) {
      const conflict = await probeConflictingEntry(prisma, session.teacherId, {
        date: new Date(body.date),
        startTime: hhmmToTime(body.startTime),
        durationMinutes: body.durationMinutes,
      });
      log.warn(
        { teacherId: session.teacherId, conflictEntryId: conflict?.id ?? null },
        'studio class create refused: another live entry holds that slot',
      );
      return respondError(entryConflictMessage(conflict, 'studio'), 409, 'DUPLICATE_STUDIO_CLASS_SLOT');
    }
    const { entry, studioClass } = outcome;
```

**Verify before writing:** this route's existing 409 code and log message — `sed -n '105,130p' src/app/api/studio-classes/route.ts`. Reuse them verbatim; `DUPLICATE_STUDIO_CLASS_SLOT` above is what the file is expected to contain, not a licence to rename it.

The `if (!studioClass) throw new Error(…)` guard goes.

- [ ] **Step 4: Run the test**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove each guard bites**

Mutations 1, 2 and 3 from Task 1 Step 7, against this route.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/studio-classes/route.ts tests/integration/studio-api.test.ts
git commit -m "fix: the studio class create refuses without deadlocking (issue 331)"
```

---

### Task 5: Whole-branch verification and the record

**Files:** none modified. This task produces the numbers the PR body needs.

- [ ] **Step 1: Snapshot the deadlock counter**

```bash
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga_test -c \
  "SELECT deadlocks FROM pg_stat_database WHERE datname='ethical_yoga_test'"
```

- [ ] **Step 2: Run the integration project four times**

```bash
for i in 1 2 3 4; do npx vitest run --project integration 2>&1 | grep -E '^ *Tests '; done
```

Expected: four green runs. Before the fix, one full-suite run in four failed on this case.

- [ ] **Step 3: Snapshot the counter again**

Same command. Record both numbers and **the delta** — the cumulative total on this database was 625 before the round and is not the measurement.

- [ ] **Step 4: `npm run verify`**

Run: `npm run verify`
Expected: green. Record files and tests per project with totals that reconcile. Note that a red unit tier means the `integration` line never prints at all — invoke the project directly if anything earlier fails.

- [ ] **Step 5: Confirm the bound landed where it was meant to, and only there**

```bash
grep -n 'setLockTimeout' src/services/class-template-lifecycle.ts src/services/studio-class-template-lifecycle.ts
grep -n 'setLockTimeout' src/app/api/classes/route.ts src/app/api/studio-classes/route.ts
```

Expected: present in both services; **absent** from both entry routes. Its absence there is the decision, not an oversight.

- [ ] **Step 6: Sweep for what was invalidated, not for what was edited**

Four things went. `grep` for each and give every hit a verdict — expect legitimate survivors, and rewriting a still-true claim costs more than the staleness did:

```bash
grep -rn 'isExclusionConflictOn' src docs --include='*.ts' --include='*.md'
grep -rn 'nested create' src docs --include='*.ts' --include='*.md'
grep -rn 'issue 228\|#228' src docs --include='*.ts' --include='*.md'
grep -rn 'the nested class row did not come back\|the nested studio class row did not come back' src
```

`class-templates/route.ts:246`'s paragraph declining the bound is now false for that route and must be replaced, not annotated.

- [ ] **Step 7: Record the entry-route gap on issue 228**

`POST /api/classes` and `POST /api/studio-classes` share the unbounded shape and are outside 228's scope. Post an update to 228 — from a `--body-file`, never `--body "…"` — saying so, and that this round bounded only the two template creates it named.

- [ ] **Step 8: Commit nothing**

This task changes no files. Its output is the PR body.
