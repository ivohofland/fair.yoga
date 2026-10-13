# Sweep Past-Check Skip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hourly sweep declines a class-template candidate whose auto-cancel check has already passed, and the template-edit answer stops predicting a class the sweep will now never create.

**Architecture:** Two facts, two homes. A required nullable `pastCancelCheck` on `GeneratorFamily` says whether a family has a check (class: wraps `isPastCancelCheck`; studio: `null`). A required `caller: GenerationCaller` on `generateEntriesForRule` says whether this call may decline. The sweeps pass `'sweep'`, and the teacher-path wrappers pass `'teacher'`. `probeFirstEffectiveWeek` takes a `declines` predicate, which `updateRule` builds from the same family field at `now + CLASS_GENERATION_INTERVAL_MS`.

**Tech Stack:** TypeScript strict, Prisma/PostgreSQL, Vitest (`unit`, `integration` projects; the generator suites hit the DB directly).

**Spec:** `docs/superpowers/specs/2026-10-13-sweep-past-check-skip-design.md`. Read it first. Its premise check lists which existing tests flip, and why.

## Global Constraints

- TypeScript `strict`, no `any`. Descriptor fields are required and may be nullable, never optional (`GeneratorFamily` docblock).
- No `if (family.kind === …)` anywhere in `entry-generation.ts`. That is the descriptor's stop condition.
- The skip judgement, the stamp and `firstCreated.at` must be one `at` instant, read once.
- The new reason is spelled `'past_cancel_check'`. It is dropped from counts: `SKIP_REASON_COUNT_MAP.past_cancel_check = null`.
- Comment discipline (CLAUDE.md): a comment annotates the code it sits on. No prose counts or rosters. State what is true now, and keep correction history for the PR body.
- Never `git add -A` or `git add .`. Stage exact paths.
- Worktree: integration tests run against this worktree's own app. Run `pnpm run worktree:up` first if it is not up. Use the Node 24 bin on PATH (`$HOME/.nvm/versions/node/v24.21.0/bin`).

## Review Focus

1. A steady-state re-run whose first candidate is the template's own row, already past its check, must still report `already_generated`, not `past_cancel_check`. That is why the new branch goes last. Pinned in Task 1.
2. A candidate past its check **and** slot-blocked reports the blocking reason, not `past_cancel_check`. Pinned in Task 1.
3. Resume (teacher path) with a past-check first candidate still inserts it, stamps it, and answers `past_check`. Pinned in Task 1.
4. A non-UTC teacher: the judgement uses the teacher's zone. It goes through `isPastCancelCheck(…, timeZone, …)`, which already takes the zone. Covered by the unit boundary test, which uses a non-UTC zone.
5. An edit whose near candidate is declined must name the following week. A studio edit with the same geometry still names the near week. Pinned in Task 2.

---

### Task 1: The sweep declines a candidate past its check

**Files:**
- Modify: `src/lib/generation.ts` (`SkipReason`, `SKIP_REASON_COUNT_MAP`, new `GenerationCaller` type; extend the `SkipCounts` docblock's list of dropped reasons by naming the member)
- Modify: `src/services/entry-generation.ts` (`GeneratorFamily.pastCancelCheck`, `generateEntriesForRule` signature, the `at` read moved before the loop, the new last branch)
- Modify: `src/services/class-generator.ts` (`CLASS_GENERATOR.pastCancelCheck`, `createChildren` uses it, wrapper passes `'teacher'`, `generateClassInstances` calls `generateEntriesForRule(…, 'sweep', startDate)`)
- Modify: `src/services/studio-class-generator.ts` (`pastCancelCheck: null`, wrapper passes `'teacher'`, sweep passes `'sweep'`)
- Test: `src/services/class-generator.test.ts`, `src/services/studio-class-generator.test.ts`, `src/services/class-template-lifecycle.test.ts` (resume case), and a unit test for the descriptor predicate wherever a pure test of `class-generator.ts` fits. If none exists, add `src/services/class-generator-past-check.test.ts` in the unit project. Check `vitest.config.ts` / `vitest.tiers.ts` for how files are assigned to projects. A file that imports `CLASS_GENERATOR` pulls in Prisma types only, so confirm that it runs in the tier you pick.

**Interfaces:**
- Produces: `export type GenerationCaller = 'sweep' | 'teacher'` in `@/lib/generation`.
- Produces: `GeneratorFamily.pastCancelCheck: ((child: TChild, entry: { date: Date; startTime: Date }, timeZone: string, at: Date) => boolean) | null`.
- Produces: `generateEntriesForRule(db, family, template, caller: GenerationCaller, from?: Date): Promise<GenerationResult>`.
- Unchanged signatures: `generateInstancesForTemplate(db, template, from?)`, `generateStudioInstancesForTemplate(db, template, from?)`.

- [ ] **Step 1: Rewrite the #836 sweep test to the new behaviour (failing).** In `class-generator.test.ts`, describe `generateClassInstances — the auto-cancel decision (#836)`. Rename the describe to `… (#836, #859)`. Replace its single test with:

```ts
it('declines the candidate already past its check, logs it, and fills the later weeks undecided', async () => {
  const warn = vi.spyOn(log, 'warn');
  const count = await generateClassInstances(prisma, {
    streaks: createContentionStreaks(),
    from: new Date(),
    teacherId,
  });
  expect(count).toBeGreaterThan(0);

  const classes = await prisma.class.findMany({
    where: { calendarEntry: { scheduleRuleId } },
    include: { calendarEntry: { select: { date: true } } },
    orderBy: { calendarEntry: { date: 'asc' } },
  });
  // The candidate 90 minutes out (check at -30 min) produced no row at all.
  const nearDate = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  expect(classes.some((c) => c.calendarEntry.date.getTime() === nearDate.getTime())).toBe(false);
  for (const cls of classes) expect(cls.autoCancelDecidedAt).toBeNull();

  const line = warn.mock.calls.find(([, msg]) => msg === 'recurring class generation could not fill every date in the window');
  expect(line?.[0]).toMatchObject({
    skipped: [{ date: nearDate.toISOString().slice(0, 10), reason: 'past_cancel_check' }],
  });
  warn.mockRestore();
});
```

Lift `start` from `beforeAll` into the describe scope so the test can read it. Match the file's existing `log`/spy imports; the "logs blocked dates once per call" test shows the pattern. Also check whether `start` near midnight UTC can put the candidate on a different date than `start`'s UTC date. It cannot: the template is UTC and the candidate is `start` itself.

- [ ] **Step 2: Add the ordering pins (failing until Step 6).** In the same describe, or a sibling one with its own UTC teacher and template, add:
  - **Steady state:** create the near candidate's row first, through a teacher-path call `generateInstancesForTemplate(prisma, fresh)`, which inserts and stamps it. Then run the sweep. The sweep's skipped list for that date is `already_generated`, never `past_cancel_check`. Read it by calling `generateEntriesForRule(prisma, CLASS_GENERATOR, fresh, 'sweep')` directly and inspecting `result.skipped`.
  - **Blocked and past check:** a manual live `Class` (or a `StudioClass` entry) of the same teacher overlapping the near candidate. The sweep reports `blocked_by_overlap` or `slot_taken` for that date, never `past_cancel_check`.

- [ ] **Step 3: Generator-level boundary test (failing).** Template in a non-UTC zone (e.g. `Europe/Amsterdam`), `autoCancelCheck: 'HOURS_2'`, next candidate about 3 h out. Compute `check = cancelCheckInstant(entry, 'HOURS_2', tz)` from `@/lib/auto-cancel-check`. Then:

```ts
vi.useFakeTimers({ toFake: ['Date'] });
try {
  vi.setSystemTime(new Date(check.getTime() - 1));
  const before = await generateEntriesForRule(prisma, CLASS_GENERATOR, fresh, 'sweep', new Date(check.getTime() - 1));
  expect(before.skipped.find((s) => s.date.getTime() === candidate.getTime())).toBeUndefined();
  // clean up the rows `before` inserted, then:
  vi.setSystemTime(check);
  const at = await generateEntriesForRule(prisma, CLASS_GENERATOR, fresh, 'sweep', check);
  expect(at.skipped.find((s) => s.date.getTime() === candidate.getTime())?.reason).toBe('past_cancel_check');
} finally {
  vi.useRealTimers();
}
```

Faking only `Date` leaves Prisma's timers alone. If Prisma or the pool misbehaves under a frozen `Date`, report that rather than weakening the test. The pure boundary test in Step 4 is not a substitute for this one; it is in addition.

- [ ] **Step 4: Pure boundary test on the descriptor (failing to compile).** `CLASS_GENERATOR.pastCancelCheck` at exactly the check instant is `true`, and 1 ms before it is `false`. Use a non-UTC zone. `STUDIO_GENERATOR.pastCancelCheck` is `null`.

- [ ] **Step 5: Studio and resume pins.**
  - `studio-class-generator.test.ts`: a studio template whose next candidate starts about 30 min out. `generateStudioClassInstances(prisma, { streaks, teacherId })` inserts that candidate. Mirror the file's existing sweep test setup.
  - `class-template-lifecycle.test.ts`, describe with the #849 tests: `resume: a first class past its check is still added, stamped, and answers past_check`. Use `seedTemplate(seeded, new Date(Date.now() + 90 * 60 * 1000), false, 'HOURS_4')`, then `pauseOrResumeTemplate(…, 'active')`. Expect `added > 0`, `lateFirstClass?.state === 'past_check'`, and the earliest class's `autoCancelDecidedAt` not null. Check `seedTemplate`'s parameter order in the file before you write it.

- [ ] **Step 6: Run the new tests and see them fail.** Run
  `pnpm exec vitest run --project integration src/services/class-generator.test.ts src/services/studio-class-generator.test.ts`
  (use the project the file actually belongs to; check `vitest.tiers.ts`). Expected: Steps 1 to 4 fail, by compile error for the new signature or assertion failure. Steps 5's tests pass already. They are regression pins, so say so.

- [ ] **Step 7: Implement.**
  - `src/lib/generation.ts`: add the `| 'past_cancel_check'` member last in `SkipReason`, with a docblock. The docblock says: free by every other reason, but the sweep caller declines it because its family says its auto-cancel check has passed at the generator's `at`. Only the sweep emits it. It is dropped from counts because no teacher-facing answer follows a sweep. A declined date stays unfilled, because it stays past its check until it starts. Add `past_cancel_check: null` to `SKIP_REASON_COUNT_MAP`. Add `export type GenerationCaller = 'sweep' | 'teacher';` with a docblock: `'sweep'` may decline what the family's `pastCancelCheck` says has passed, and `'teacher'` (create, resume) inserts it and lets the caller warn instead (#856). In the `SkipCounts` docblock, add one clause naming `past_cancel_check` among the dropped reasons and why.
  - `entry-generation.ts`: add `pastCancelCheck` to `GeneratorFamily`, after `createChildren`, with a docblock in the style of `TemplateFamily.lateFirstClass`. Change the signature to `(db, family, template, caller: GenerationCaller, from?: Date)`. Move `const at = new Date();` to just before the `for (const date of dates)` loop. Reword its comment: the skip judgement, the stamp `createChildren` writes, and `firstCreated.at` are this one instant. After the `blocked_by_overlap` branch and before `free.push(date)`:

```ts
    // LAST, deliberately: every reason above says the date was not free, which
    // is the more useful thing to report, and checking this earlier would mask
    // `already_generated` on every steady-state re-run. Only the sweep declines:
    // on create and resume the teacher reads the answer and is warned instead
    // (#856). A family with no check passes `null`.
    if (
      caller === 'sweep' &&
      family.pastCancelCheck?.(template, { date, startTime }, template.scheduleRule.teacher.defaultTimezone, at)
    ) {
      skipped.push({ date, reason: 'past_cancel_check' });
      continue;
    }
```

  Update `generateEntriesForRule`'s docblock with one short paragraph on `caller`.
  - `class-generator.ts`: define the predicate once, then reference it from both fields:

```ts
const classPastCancelCheck = (
  template: ClassTemplate,
  entry: { date: Date; startTime: Date },
  timeZone: string,
  at: Date,
): boolean => isPastCancelCheck(entry, template.autoCancelCheck, timeZone, at);
```

  `pastCancelCheck: classPastCancelCheck`. In `createChildren`, `autoCancelDecidedAt: classPastCancelCheck(template, entry, template.scheduleRule.teacher.defaultTimezone, at) ? at : null`. Reword the stamp comment: the sweep declines such a candidate before insert, so only a teacher-path call (create, resume) reaches the stamp. The wrapper becomes `generateEntriesForRule(db, CLASS_GENERATOR, template, 'teacher', from)`; say in its docblock that it is the teacher path. In `generateClassInstances`, replace `generateInstancesForTemplate(tx, fresh, startDate)` with `generateEntriesForRule(tx, CLASS_GENERATOR, fresh, 'sweep', startDate)`.
  - `studio-class-generator.ts`: `pastCancelCheck: null` (a studio class has no check). The wrapper passes `'teacher'`. The sweep calls `generateEntriesForRule(tx, STUDIO_GENERATOR, fresh, 'sweep', startDate)`.
  - Any other `generateEntriesForRule(` call site (tests included; `grep -rn "generateEntriesForRule(" src tests`) gets an explicit caller.

- [ ] **Step 8: Run the tests and see them pass.** Run the same command as Step 6, plus `src/services/class-template-lifecycle.test.ts` and `pnpm exec tsc --noEmit`. Expected: all pass, and tsc is clean.

- [ ] **Step 9: Prove each guard bites.** Record the exact failure text in the report for each:
  1. Delete `caller === 'sweep' &&` from the new branch. Expected failure: the resume pin and the existing create test ("create: … stamped at the instant it was judged at"), since create no longer inserts.
  2. Move the new branch before the `own` branch. Expected failure: the steady-state pin.
  3. Change `>=` to `>` in `isPastCancelCheck` (`src/lib/auto-cancel-check.ts`). Expected failure: both boundary tests.
  4. Pass `'teacher'` from `generateClassInstances`. Expected failure: the rewritten #836 test.
  5. Move `const at = new Date()` back after the insert. Expected failure: the stamp and the skip still agree within a run, so this mutation may not redden anything. Say so if it does not. That is a finding to report, not something to paper over.

  Restore each and re-run green.

- [ ] **Step 10: Sweep the docs and comments this falsifies.** Run `grep -rn "stamps\|autoCancelDecidedAt.*insert\|at insert" src docs CLAUDE.md`, and `grep -rn "SkipReason\b" docs`. Fix any sentence that says the **sweep** stamps at insert, or that lists `SkipReason` members by count. Give each hit a verdict in the report.

- [ ] **Step 11: Commit.**

```bash
git add src/lib/generation.ts src/services/entry-generation.ts src/services/class-generator.ts src/services/studio-class-generator.ts src/services/class-generator.test.ts src/services/studio-class-generator.test.ts src/services/class-template-lifecycle.test.ts <any new test file> <any docs touched>
git commit -m "feat: the sweep declines a template candidate already past its auto-cancel check (#859)"
```

---

### Task 2: The edit answer agrees with the sweep

**Files:**
- Modify: `src/services/entry-generation.ts` (`probeFirstEffectiveWeek` gains `declines`)
- Modify: `src/services/rule-lifecycle.ts` (`updateRule` builds the predicate at `now + CLASS_GENERATION_INTERVAL_MS`, judges `lateFirstClass` at the same `at`, and removes the `min(…, start)` cap; update `UpdateRuleResult.lateFirstClass`'s docblock)
- Modify: `src/lib/api-types.ts` only if a docblock there describes the cap or the edit answer's `past_check`. Grep it.
- Test: `src/services/class-template-lifecycle.test.ts`, `src/services/studio-class-template-lifecycle.test.ts`, and any direct `probeFirstEffectiveWeek(` test (`grep -rn "probeFirstEffectiveWeek(" src tests`)

**Interfaces:**
- Consumes: `GeneratorFamily.pastCancelCheck` from Task 1. `TemplateFamily` spreads it, so `family.pastCancelCheck` is available in `updateRule`.
- Produces: `probeFirstEffectiveWeek(db, template, horizon, declines: ((candidate: Date) => boolean) | null, editNoun)`. Put the new parameter before `editNoun`, or after it, whichever reads better, and update every call site.

- [ ] **Step 1: Rewrite the cap test (failing).** In `class-template-lifecycle.test.ts`, replace `edit: a first class starting before the next sweep is judged at its own start, so it answers past_check` with:

```ts
it('edit: a candidate past its check by the next sweep is one the sweep declines, so the answer names the following week', async () => {
  const seeded = await freshTeacher('edit-declined');
  const target = new Date(Date.now() + 40 * 60 * 1000);
  const template = await seedTemplate(seeded, target, true, 'HOURS_2');

  const result = await updateClassTemplate(prisma, template.id, seeded.teacherId, { classType: 'Renamed' });

  if (!result.ok) throw new Error('expected ok');
  const near = slotAt(target, 'UTC').date;
  expect(result.firstEffective).toEqual(new Date(mondayOf(near) + 7 * 24 * 60 * 60 * 1000));
  expect(result.lateFirstClass).toBeNull();
});
```

Add a second test: a candidate whose check falls just after `now + interval` is still named. Seed `target = now + 3h + 5min` with `HOURS_2`, so the check is at now + 65 min, after `now + 60 min`. The edit names the near week and answers `lateFirstClass` with whatever the template's deadline makes it. Use `cancelDeadline: 'HOURS_24'` so it is `past_deadline`. Check the `seedTemplate` signature for how to pass `cancelDeadline`.

- [ ] **Step 2: Studio counterpart.** In `studio-class-template-lifecycle.test.ts`, an edit to an active studio template whose next candidate is about 40 min out still names the near week as `firstEffective`. Follow that file's existing `firstEffective` test setup.

- [ ] **Step 3: Run and see the class test fail.** Run `pnpm exec vitest run --project integration src/services/class-template-lifecycle.test.ts src/services/studio-class-template-lifecycle.test.ts`. Expected: the first rewritten test fails, because it names the near week and answers `past_check`. The others pass, and they are regression pins.

- [ ] **Step 4: Implement.**
  - `probeFirstEffectiveWeek`: add `declines` and change the candidates line to

```ts
    const candidates = horizon.filter(
      (date) => !takenDates.has(date.getTime()) && !(declines?.(date) ?? false),
    );
```

  Add a bullet to its docblock's list of the generator's refusals that it reproduces: `past_cancel_check`, reproduced by `declines`, which the caller builds from the family's `pastCancelCheck` at the latest nominal sweep instant. Say why that instant errs in the tolerated direction, and that the nominal interval itself is #860's imprecision. Keep it in the existing style of that list.
  - `updateRule`:

```ts
  // The latest instant the next nominal sweep runs: what the probe and the
  // late-first-class judgement are both judged at, so they cannot disagree.
  const at = new Date(now.getTime() + CLASS_GENERATION_INTERVAL_MS);
  const pastCancelCheck = family.pastCancelCheck;
  const declines =
    pastCancelCheck === null
      ? null
      : (date: Date) => pastCancelCheck(updated, { date, startTime: updatedRule.startTime }, timeZone, at);
```

  Pass `declines` to the probe. Judge `family.lateFirstClass(updated, entry, timeZone, at)` with no `Math.min` cap. Keep the try/catch. Rewrite the comment above it and `UpdateRuleResult.lateFirstClass`'s docblock so they say what is true now. The answer is judged at the latest nominal sweep instant. A candidate past its check by then is one the sweep declines, so the probe skips it and this can be `past_deadline` but never `past_check`. Drop the cap sentence entirely, since its history goes in the PR body.
  - Update every other `probeFirstEffectiveWeek(` call site.

- [ ] **Step 5: Run and see it pass.** Run the same command as Step 3, plus `pnpm exec tsc --noEmit`, plus `pnpm exec vitest run src/services/rule-lifecycle.test.ts` in its own project if it is a unit file.

- [ ] **Step 6: Prove the guards bite.** Record the failure text for each:
  1. Pass `null` for `declines` from `updateRule`. Expected failure: the rewritten edit test.
  2. Judge `declines` at `now` instead of `at`. Expected failure: the rewritten edit test (its check is 20 min in the future at `now`).
  3. Reintroduce the `Math.min(…, start)` cap. Expected: nothing reddens, because the cap is unreachable. Record that as confirmation of the spec's claim, not as a gap.

  Restore each and re-run green.

- [ ] **Step 7: Sweep.** Run `grep -rn "min(now\|its own start\|nominal insert instant\|CLASS_GENERATION_INTERVAL_MS" src docs CLAUDE.md`. Every hit describing the removed cap or an edit answering `past_check` gets fixed or a verdict.

- [ ] **Step 8: Commit.**

```bash
git add src/services/entry-generation.ts src/services/rule-lifecycle.ts src/services/class-template-lifecycle.test.ts src/services/studio-class-template-lifecycle.test.ts <other touched paths>
git commit -m "feat: the template edit answer skips a first class the sweep now declines (#859)"
```

## Task order

Task 2 consumes `GeneratorFamily.pastCancelCheck` from Task 1, so it must run second.
