# Week-Keyed Studio Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the studio family the week key and the first-reachable-week
response #194 gave the class family, by making the two per-template generators
one implementation rather than by copying a third one.

**Architecture:** A new `src/services/entry-generation.ts` — the entry layer's
twin of `rule-lifecycle.ts`, and the lower of the two. It holds the pure date
maths both families already share, the merged per-template generator, the merged
generation claim, and the first-effective-week probe. `GeneratorFamily` is a
**split of the existing `TemplateFamily`**, not a parallel copy: four of its five
fields already live there, so each family still declares them once. Every
currently-exported name survives as a thin adapter, the shape #336 shipped.

**Tech Stack:** TypeScript strict, Prisma 6, PostgreSQL, Vitest (four projects:
`unit`, `components`, `unit-sweeps`, `integration`).

**Spec:** `docs/superpowers/specs/2026-08-29-studio-week-keyed-generation-design.md`

## Global Constraints

- **The stop condition.** `entry-generation.ts` must contain no comparison
  against a `ClassFamily` literal. An `if (family.kind === 'regular')` in the
  merged body is the forbidden thing — the same stop condition #336 shipped
  under, for the same reason. If merging forces one, STOP and record it.
- **No import cycle.** `entry-generation.ts` is imported BY the two generator
  files and by `rule-lifecycle.ts`; it must never import any of them back.
  Verified in Task 3, not assumed.
- **Three noun vocabularies, and they stay three** (spec §3.7). Generation logs:
  `'recurring class' | 'studio class'`. Edit-path logs:
  `'recurring class' | 'studio template'`. Teacher-facing copy:
  `'recurring class' | 'template'`. Never compose one from another.
- **The week read carries no liveness filter.** A cancelled entry holds its week
  (spec §1.4, and `SkipReason`'s own docblock). Adding `cancelledAt: null` for
  consistency with `CalendarEntry_teacher_slot_excl` is a defect, not a tidy-up.
- **Branch order is load-bearing.** Own-date first, then week, then
  `slot_taken`, then `blocked_by_overlap`. The class family's comment states
  which half is pinned by a test and which is a reporting preference; carry that
  distinction across verbatim rather than upgrading the preference into a claim.
- **Every guard ships with a mutation** observed failing, restored, re-verified,
  using a value the code under test cannot produce.
- **Comment discipline** (CLAUDE.md): a comment annotates the code it sits on.
  Counts, rosters and facts about other modules go in `docs/`. Never write "this
  previously read X" — corrections belong in the PR body.
- **Baseline:** see the line at the end of this section. Measure the
  after-figure; never predict it.
- **`npm run verify` needs the dev server on :3000.** The user runs it. **Never
  start or restart it.**
- **Warm a route before scoring a mutation against it.** `next dev` compiles
  lazily; a cold first request can blow a 5s timeout and read exactly like an
  assertion failure (#290).

**Baseline (measured 2026-08-29 at `e9ed2201`, `npm run verify` exit 0):**
`68 + 46 + 16 + 33 = 163` files, `1034 + 302 + 142 + 531 = 2009` tests
(`unit`, `components`, `unit-sweeps`, `integration`). The two smaller
projects were measured directly; `unit` and `integration` are the remainders
of the two `npm test` invocations, which print `114 / 1336` and `49 / 673`.
Three tests above the #336 plan's 2006, which is PR #345 landing.

---

### Task 1: `entry-generation.ts` exists, holding what both families already share

A pure move. No behaviour changes, and the whole suite staying green is the
proof.

**Files:**
- Create: `src/services/entry-generation.ts`
- Create: `src/services/entry-generation.test.ts`
- Modify: `src/services/class-generator.ts` (remove the moved symbols; import them)
- Modify: `src/services/studio-class-generator.ts` (import `getNextOccurrences` from the new module; delete its local `const DEFAULT_WEEKS = 4` at `:17`)
- Modify: `src/services/rule-lifecycle.ts` (`JoinedRule` `:24` and `ChildWithRule` `:30` move out; import them)
- Modify: `src/services/class-template-lifecycle.ts` (`:49-55` import block)
- Modify: `src/services/class-generator.test.ts` (the moved `describe`s go)
- Modify: `src/services/studio-class-generator.test.ts`, `src/services/generation-transaction.test.ts`, `src/services/class-template-lifecycle.test.ts` (import paths)

**Interfaces:**
- Consumes: nothing.
- Produces, all from `@/services/entry-generation`:
  - `export type JoinedRule = ScheduleRule & { teacher: { defaultTimezone: string } }`
  - `export type ChildWithRule<TChild> = TChild & { scheduleRuleId: string; scheduleRule: JoinedRule }`
  - `export const DEFAULT_WEEKS = 4`
  - `export function getNextOccurrences(dayOfWeek: number, from: Date, weeks: number): Date[]`
  - `export function isWeekHeld(date: Date, heldWeeks: ReadonlySet<number>): boolean`
  - `export function firstFreeWeek(candidates: readonly Date[], heldWeeks: ReadonlySet<number>): Date | null`

- [ ] **Step 1: Census the importers before touching anything**

```bash
grep -rn "getNextOccurrences\|DEFAULT_WEEKS\|firstFreeWeek\|isWeekHeld\|ChildWithRule\|JoinedRule" \
  src/ --include="*.ts" --include="*.tsx" | grep -v "^src/services/entry-generation" \
  | tee /tmp/284-move-sites.txt
wc -l /tmp/284-move-sites.txt
```

Record the count. It is the reconciliation for Step 5. Expect hits that are
**comments** as well as imports — `template-action-messages.ts:327` names
`isWeekHeld` in prose and imports nothing. Those get a verdict, not an edit.

- [ ] **Step 2: Create the module and cut the symbols into it**

Move — do not copy — the six symbols with their docblocks intact. Two edits to
the prose they carry, and no others:

- `DEFAULT_WEEKS`'s docblock says "Exported since #194 for `updateClassTemplate`'s
  probe". The probe arrives in this module in Task 4, so leave that sentence
  alone now and revisit it there.
- `isWeekHeld`'s docblock says "both call sites build it the same way". After
  Task 2 there is one call site in the generator and one in the probe, both in
  this file. Leave it now; Task 4 owns the correction.

Write the file's own header docblock: what this module is (the entry layer's
twin of `rule-lifecycle.ts`), the import direction that must not reverse, and
that it imports `@/lib/log` and is therefore server-only — nothing under
`'use client'` may value-import it.

- [ ] **Step 3: Verify the originals are gone, not duplicated**

```bash
grep -n "export function getNextOccurrences\|export function isWeekHeld\|export function firstFreeWeek\|export const DEFAULT_WEEKS" src/services/class-generator.ts
grep -n "export type JoinedRule\|export type ChildWithRule" src/services/rule-lifecycle.ts
grep -n "const DEFAULT_WEEKS" src/services/studio-class-generator.ts
```

Expected: no output from any of the three. A duplicate definition is the failure
mode this step exists to catch — both copies compile, and the two drift.

- [ ] **Step 4: Re-point every importer from `/tmp/284-move-sites.txt`**

`class-template-lifecycle.ts:49-55` splits into two import statements: the two
generation functions stay on `'./class-generator'`, the three date helpers move
to `'./entry-generation'`.

- [ ] **Step 5: Move the pure-helper tests**

`class-generator.test.ts`'s `getNextOccurrences`, `isWeekHeld` and
`firstFreeWeek` `describe`s (the file's first ~90 lines, before the
`generateClassInstances (DB)` block) move verbatim into
`src/services/entry-generation.test.ts`. Do not rewrite an assertion; a moved
test that changes is not a moved test.

- [ ] **Step 6: Run the moved tests and the two generator suites**

```bash
npx vitest run --project unit src/services/entry-generation.test.ts
npx vitest run --project unit src/services/class-generator.test.ts src/services/studio-class-generator.test.ts
npm run typecheck
```

Expected: all pass, `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/services/entry-generation.ts src/services/entry-generation.test.ts \
  src/services/class-generator.ts src/services/class-generator.test.ts \
  src/services/studio-class-generator.ts src/services/studio-class-generator.test.ts \
  src/services/rule-lifecycle.ts src/services/class-template-lifecycle.ts \
  src/services/class-template-lifecycle.test.ts src/services/generation-transaction.test.ts
git commit -m "refactor: the date maths both families already shared gets a module (issue 284)"
```

---

### Task 2: one per-template generator, and the studio family gains the week key

The behaviour task. Failing tests first, and they fail against today's studio
generator for the right reason.

**Files:**
- Modify: `src/services/entry-generation.ts` (add `GenerationLogNoun`, `GeneratorFamily`, `generateEntriesForRule`, `logSkippedEntries`)
- Modify: `src/services/class-generator.ts` (add `CLASS_GENERATOR`; `generateInstancesForTemplate` becomes an adapter; delete `logSkippedSlots`)
- Modify: `src/services/studio-class-generator.ts` (add `STUDIO_GENERATOR`; `generateStudioInstancesForTemplate` becomes an adapter; delete `logSkippedStudioSlots`)
- Test: `src/services/studio-class-generator.test.ts` (new week-keyed `describe`)

**Interfaces:**
- Consumes: Task 1's exports.
- Produces:

```ts
export type GenerationLogNoun = 'recurring class' | 'studio class';

export type GeneratorFamily<TChild, TKind extends ClassFamily = ClassFamily> = {
  kind: TKind;
  logNoun: GenerationLogNoun;
  childTable: Extract<Prisma.ModelName, 'ClassTemplate' | 'StudioClassTemplate'>;
  readChildOrThrow: (tx: TransactionClientOnly, templateId: string) => Promise<ChildWithRule<TChild>>;
  createChildren: (
    db: PrismaClient | Prisma.TransactionClient,
    template: ChildWithRule<TChild>,
    entries: readonly { id: string; date: Date }[],
  ) => Promise<void>;
};

export async function generateEntriesForRule<TChild>(
  db: PrismaClient | Prisma.TransactionClient,
  family: GeneratorFamily<TChild>,
  template: ChildWithRule<TChild>,
  from?: Date,
): Promise<GenerationResult>;
```

  `readChildOrThrow` is unused until Task 3 and is declared here so the type is
  written once. Both family consts must supply it now.

- [ ] **Step 1: Write the failing tests**

Add to `src/services/studio-class-generator.test.ts`, inside the
`generateStudioInstancesForTemplate (DB)` describe, a nested
`describe('week-keyed generation (#284)')` mirroring
`class-generator.test.ts:1614-1760`. Carry the fixture reasoning across — the
anchor is load-bearing, not decoration:

```ts
// Monday 2026-04-06 is the anchor because the four Tuesdays that follow
// (Apr 7/14/21/28) and the four Thursdays (Apr 9/16/23/30) pair up one-for-one
// inside the same four Monday-anchored weeks. Pick an anchor where the new day
// falls BEFORE the old one and the fourth candidate lands in a fifth week the
// old window never reached — a legitimate create that would make these
// assertions wrong rather than failing.
//
// A fixed `from`, because these assertions name calendar weeks and the suite
// pins TZ=America/New_York (`vitest.config.ts`) — west of UTC, the direction
// that moves a UTC-midnight @db.Date back a day and a Monday back a week.
const from = new Date('2026-04-06T00:00:00.000Z');
const TUESDAY = 1; // schema convention: 0=Mon, 1=Tue, ..., 6=Sun
const THURSDAY = 3;
```

Three tests:

1. **`does not generate into a week that already holds a class from this template`** —
   seed the Tuesday window (assert `created: 4`), move the rule to Thursday,
   regenerate from the same `from`. Expect `created: 0`, four
   `'already_this_week'` reasons, and the held dates still exactly the four
   Tuesdays.
2. **`a CANCELLED class still holds its week`** — same, with week 2's Tuesday
   entry given a `cancelledAt` before the move. Every skip reason is
   `'already_this_week'`, and **no Thursday row exists** — assert the dates, not
   just the reasons, because a liveness-filtered read does not mislabel week 2,
   it *creates* it.
3. **`still reports already_generated, not already_this_week, on a steady-state re-run`** —
   no day change, generate twice, all four reasons `'already_generated'`.

- [ ] **Step 2: Run them and record the failure**

```bash
npx vitest run --project unit-sweeps src/services/studio-class-generator.test.ts -t "week-keyed"
```

**`unit-sweeps`, not `unit`, and this is load-bearing.** That file is in
`SWEEP_TESTS` (`vitest.config.ts:18`), so `--project unit` EXCLUDES it, runs
nothing, and **exits 1** — which in a step that expects a failure is
indistinguishable from the failure you are looking for. Measured on this branch.
Read the `Tests` line, not the exit code: it must name your three new tests.

Expected: tests 1 and 2 FAIL — `created` is 4 where 0 is expected and `skipped`
is empty, because today's studio generator has no week predicate. Test 3 PASSES
already (the own-date branch exists). **Record the exact failure text in the
ledger.** A test that fails because a fixture is wrong looks the same at a
glance and proves nothing.

- [ ] **Step 3: Build `generateEntriesForRule`**

Start from `generateInstancesForTemplate` (`class-generator.ts:203-616`) and
make exactly three substitutions:

1. `family.kind` for the `'regular'` literal — **two sites**: the
   `createManyAndReturn` payload and the `slot_taken` filter's `e.kind ===` test.
   Missing the second is a silent bug: the studio generator would report a
   class-family neighbour as `slot_taken`.
2. `family.createChildren(db, template, inserted)` for the `db.class.createMany`
   block.
3. `family.logNoun` for the two message strings.

`logSkippedEntries` takes the noun and composes
`` `${logNoun} generation could not fill every date in the window` ``. The
empty-window warn composes
`` `${logNoun} generation found no candidate dates because their start instants could not be read` ``.

Every comment in the class original travels with the code it annotates. Two need
rewriting because they now describe a shared function rather than one of a pair
— the `NO CATCH` paragraph and the branch-order paragraph, both of which
currently say "the class twin" / "the studio twin". State what is true now; do
not annotate what they used to say.

- [ ] **Step 4: Define both family consts and convert the two exports to adapters**

`CLASS_GENERATOR` lives in `class-generator.ts` (its `createChildren` writes the
ten `Class` columns plus `status: 'open'`), `STUDIO_GENERATOR` in
`studio-class-generator.ts` (`location`, `hourlyRate`). Both supply
`readChildOrThrow` from the `findUniqueOrThrow` their `claim*` already runs.

```ts
export const generateInstancesForTemplate = (
  db: PrismaClient | Prisma.TransactionClient,
  template: TemplateWithTimezone,
  from?: Date,
) => generateEntriesForRule(db, CLASS_GENERATOR, template, from);
```

Keep both exported names and both parameter types. Eight files import them and
several comments name them.

- [ ] **Step 5: Run the tests**

```bash
npx vitest run --project unit-sweeps src/services/studio-class-generator.test.ts
npx vitest run --project unit src/services/class-generator.test.ts src/services/generation-transaction.test.ts
```

Two commands, because the studio generator suite lives in `unit-sweeps` and a
single `--project unit` invocation naming all three silently drops it (Step 2).
Expected: all pass, including the three new ones.

- [ ] **Step 6: Confirm the class family's skip-log string moved, and only that**

```bash
grep -rn "'class generation could not fill" src/   # expect: no output
grep -rn "generation could not fill" src/services/entry-generation.ts
```

The second shows the composed template literal. Note in the ledger that the
class family's line changes from `class generation could not fill…` to
`recurring class generation could not fill…` — it goes in the PR body, because
a log string is how this reaches an operator's grep.

- [ ] **Step 7: Commit**

```bash
git add src/services/entry-generation.ts src/services/class-generator.ts \
  src/services/studio-class-generator.ts src/services/studio-class-generator.test.ts
git commit -m "feat: one per-template generator, and the studio family gains the week (issue 284)"
```

---

### Task 3: one generation claim, and `TemplateFamily` composes `GeneratorFamily`

Behaviour-neutral. The existing claim tests staying green is the proof.

**Files:**
- Modify: `src/services/entry-generation.ts` (add `claimRuleForGeneration`)
- Modify: `src/services/class-generator.ts`, `src/services/studio-class-generator.ts` (both `claim*` become adapters)
- Modify: `src/services/rule-lifecycle.ts` (`TemplateFamily` becomes an intersection)
- Modify: `src/services/class-template-lifecycle.ts`, `src/services/studio-class-template-lifecycle.ts` (each descriptor spreads its generator const)
- Test: `src/services/rule-lifecycle.test.ts` (the `childTable` `@ts-expect-error` pin must still fail to compile)

**Interfaces:**
- Consumes: Task 2's `GeneratorFamily`.
- Produces:

```ts
export async function claimRuleForGeneration<TChild>(
  tx: TransactionClientOnly,
  family: GeneratorFamily<TChild>,
  templateId: string,
): Promise<ChildWithRule<TChild> | null>;

// rule-lifecycle.ts
export type TemplateFamily<TChild, TKind extends ClassFamily = ClassFamily> =
  GeneratorFamily<TChild, TKind> & { /* readChild, deleteWhere, standingWhere, withSlot, claim, generate, withdraw — signatures unchanged */ };
```

- [ ] **Step 1: Merge the two claims**

One function, `family.childTable` spliced as the raw identifier and
`family.readChildOrThrow` for the second statement. The alias becomes a fixed
`c` for both families. `family.logNoun` composes the ineligible-on-re-check
warn.

- [ ] **Step 2: Rewrite the studio docblock's stale objection**

`studio-class-generator.ts:35-37` argues *"a generic version would have to
interpolate the table name into raw SQL"*. #336 shipped exactly that
interpolation, compiler-tethered. The paragraph is deleted, not annotated —
`claimRuleForGeneration`'s own docblock in the shared module carries what is
true now, including why `FOR UPDATE` may not be weakened to `FOR NO KEY UPDATE`
(measured on #164, both directions), which is the half of that docblock still
worth keeping.

- [ ] **Step 3: Make `TemplateFamily` an intersection and spread both consts**

`CLASS_FAMILY` becomes `{ ...CLASS_GENERATOR, readChild, deleteWhere, … }`, and
the same for `STUDIO_FAMILY`. Delete the four now-duplicated field literals
(`kind`, `childTable`, `logNoun`, `readChildOrThrow`) from each descriptor.
`TemplateFamily`'s docblock says "Everything the shared lifecycle functions
below need in order to run over one family" — it now says everything *beyond
what generation needs*. Keep the "NO FIELD IS OPTIONAL" paragraph; it is still
exactly the point.

`claim` and `generate` stay. They are arguably tautological now, and that was
considered and rejected in spec §3.2 — do not remove them on your own judgment.

- [ ] **Step 4: Prove the cycle claim rather than asserting it**

```bash
grep -n "^import" src/services/entry-generation.ts
```

Expected: imports from `@prisma/client`, `@/lib/generation`, `@/lib/entry-conflict`,
`@/lib/db-locks`, `@/lib/timezone`, `@/lib/time-of-day`, `@/lib/log` — and
**nothing** from `./class-generator`, `./studio-class-generator`,
`./rule-lifecycle`, or either lifecycle file. If any appears, the layering is
wrong; stop and report.

- [ ] **Step 5: Run the affected suites**

```bash
npx vitest run --project unit src/services/rule-lifecycle.test.ts src/services/class-generator.test.ts src/services/studio-class-generator.test.ts src/services/class-template-lifecycle.test.ts src/services/studio-class-template-lifecycle.test.ts
npm run typecheck
```

Expected: all pass. The `@ts-expect-error` on a non-template `childTable` in
`rule-lifecycle.test.ts` must still be an error — if `tsc` reports TS2578
("unused '@ts-expect-error' directive") the tether has been loosened by the
split, and that is a stop condition.

- [ ] **Step 6: Commit**

```bash
git add src/services/entry-generation.ts src/services/class-generator.ts \
  src/services/studio-class-generator.ts src/services/rule-lifecycle.ts \
  src/services/class-template-lifecycle.ts src/services/studio-class-template-lifecycle.ts
git commit -m "refactor: one generation claim, and the descriptor is declared once (issue 284)"
```

---

### Task 4: the probe moves beside the generator it predicts

Behaviour-neutral for the class family. The probe's existing tests staying green
is the proof.

**Files:**
- Modify: `src/services/entry-generation.ts` (receives `probeFirstEffectiveWeek`)
- Modify: `src/services/class-template-lifecycle.ts` (loses `:544-737`; imports it)

**Interfaces:**
- Consumes: Task 1's `isWeekHeld` / `firstFreeWeek`.
- Produces:

```ts
export type EditLogNoun = 'recurring class' | 'studio template';

export async function probeFirstEffectiveWeek(
  db: PrismaClient,
  template: { id: string; scheduleRuleId: string; teacherId: string; startTime: string; durationMinutes: number },
  horizon: readonly Date[],
  editNoun: EditLogNoun,
): Promise<Date | null>;
```

  The parameter is a structural literal, not `ClassTemplateWithSlot`: both
  families' `WithSlot` types satisfy it, and naming the five fields it actually
  reads is what lets it serve both without a type parameter.

- [ ] **Step 1: Move the function and its docblock verbatim**

Then make two edits, and only two: the `catch`'s warn composes from `editNoun`
(`` `${editNoun} edit saved, but the first-effective-week probe failed — the confirmation will not name a week` ``),
and the parameter type becomes the structural literal above.

`editNoun`, **not** `logNoun` — spec §3.7. Composed from `logNoun` the studio
line would read "studio class edit saved…" while the five sibling lines in that
service say "studio template edit…". Put the reason in the parameter's docblock,
where the next person to reach for `logNoun` will read it.

- [ ] **Step 2: Correct the two docblocks Task 1 deferred**

`isWeekHeld`'s "both call sites build it the same way" — the two call sites are
now the generator's loop and the probe, both in this file, and the sentence
should say so. **Both `isWeekHeld`'s and `firstFreeWeek`'s docblocks also say
"below" about `generateInstancesForTemplate`**, which stayed in
`class-generator.ts` — Task 1 surfaced these and was told to leave them, because
after Task 2 the merged generator IS in this file and "below" becomes true
again. Verify that, and where it is still a cross-file claim, rewrite it: a
comment reaching past its own file has no owner (CLAUDE.md). `DEFAULT_WEEKS`'s "Exported since #194 for `updateClassTemplate`'s
probe" — the probe is in this module now and the class service is no longer the
only consumer.

**And the header docblock's own `grep`, carried over from Task 1's fix round.**
It ships a command that re-derives the importer census instead of a roster,
which is right — but the docblock quotes the needle, so the file SELF-MATCHES
and the command returns one line more than there are importers. `generation.ts`
solves this two ways at once and this file should pick one: filter the module
out of its own output (`| grep -v "^src/services/entry-generation"`), or say in
prose that the file appears in its own output because the docblock quotes the
grep back at itself. An unexplained off-by-one in a check whose whole purpose is
"re-derive this rather than trusting the comment" undermines the thing it was
written for.

- [ ] **Step 3: Run the class family's suites**

```bash
npx vitest run --project unit src/services/class-template-lifecycle.test.ts src/services/entry-generation.test.ts
npm run typecheck
```

Expected: pass, `tsc` exits 0. **No test changes in this task.** If a class-family
test needs editing to stay green, the move was not behaviour-neutral — stop and
report what changed.

- [ ] **Step 4: Commit**

```bash
git add src/services/entry-generation.ts src/services/class-template-lifecycle.ts
git commit -m "refactor: the probe moves beside the generator it predicts (issue 284)"
```

---

### Task 5: the studio edit predicts its first reachable week

Rule 4's service half. This is the decision stage C2's `update` merge is blocked
on, answered by shipping it.

**Files:**
- Modify: `src/services/studio-class-template-lifecycle.ts` (`UpdateStudioClassTemplateResult` `:493`, `updateStudioClassTemplate` `:552`)
- Test: `src/services/studio-class-template-lifecycle.test.ts` (`updateStudioClassTemplate (DB)`, `:1587`)

**Interfaces:**
- Consumes: Task 4's `probeFirstEffectiveWeek`; `templateGenerationState` and
  `TemplateGenerationState` from `@/lib/template-selection`; `DEFAULT_WEEKS` and
  `getNextOccurrences` from `@/services/entry-generation`; `classStartInstant`
  from `@/lib/timezone`. **Measured: this file imports none of these today** —
  all four import statements are new.
- Produces: `UpdateStudioClassTemplateResult`'s `ok: true` arm gains
  `firstEffective: Date | null` and `generationState: TemplateGenerationState`.

- [ ] **Step 1: Write the failing tests**

Four, mirroring `class-template-lifecycle.test.ts:313-360, 519-573, 628-731`:

1. the `ok: true` arm has exactly four keys — assert
   `Object.keys(result).sort()` equals `['firstEffective', 'generationState', 'ok', 'template']`.
   The class family pins the same shape and its comment says why: a field added
   to the arm and not to the route reaches nobody;
2. an active template's edit answers a Monday —
   `expect(result.firstEffective!.getUTCDay()).toBe(1)`;
3. a **paused** template answers `firstEffective: null` with
   `generationState: 'paused'`; an **archived** one, `'archived'`. Both without
   running the probe;
4. a date held by a **live class from the other family** is not counted as
   reachable, and a date held by a **cancelled** one is. Mirror
   `class-template-lifecycle.test.ts:628-731` with the families swapped —
   a `Class` fixture blocking a `StudioClassTemplate`'s candidate.
5. **the edit leaves every already-generated `StudioClass` byte-identical** —
   the issue's first acceptance bullet, already true and never pinned. Generate
   a window, snapshot every column of every entry **and** every child row
   (`prisma.calendarEntry.findMany` + `prisma.studioClass.findMany`, no
   `select`), edit `dayOfWeek` **and** `startTime` in one PUT, snapshot again,
   and `expect(after).toEqual(before)`. Whole rows, not a chosen field list: a
   list can only prove the fields someone thought of, and this test exists
   because #194 deleted a function that used to rewrite exactly these rows.

- [ ] **Step 2: Run and record the failure**

```bash
npx vitest run --project unit src/services/studio-class-template-lifecycle.test.ts -t "updateStudioClassTemplate"
```

Expected: FAIL — `firstEffective` and `generationState` do not exist on the
result. Record the exact text.

- [ ] **Step 3: Widen the head read**

`:561`, the `include` of the read at `:559`, becomes:

```ts
include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
```

The horizon's past-start filter needs the zone, and `StudioClassTemplate`
carries none of its own.

- [ ] **Step 4: Hoist `updated` / `updatedRule` out of the transaction**

Exactly the shape `updateClassTemplate:650-758` uses — `let updated:
StudioClassTemplateWithSlot; let updatedRule: ScheduleRule;` declared before the
`try`, the transaction returning `{ updatedChild, newRule }`, and the assignment
after it. Carry the reason across in a comment on the declarations: **the probe
must sit outside the `catch`**, or a transient failure of a read-only probe maps
to `busy` — "nothing was changed" — about an edit that already committed.

- [ ] **Step 5: Build the horizon and gate on the generation state**

```ts
const now = new Date();
const horizon = getNextOccurrences(updatedRule.dayOfWeek, now, DEFAULT_WEEKS * 2).filter(
  (date) =>
    classStartInstant({ date, startTime: updatedRule.startTime }, template.scheduleRule.teacher.defaultTimezone) >
    now,
);
const generationState = templateGenerationState(updatedRule);
return {
  ok: true,
  template: updated,
  firstEffective:
    generationState === 'active'
      ? await probeFirstEffectiveWeek(db, updated, horizon, 'studio template')
      : null,
  generationState,
};
```

`DEFAULT_WEEKS * 2`, derived rather than written as 8 — when all four of the
generator's weeks are held the honest answer is week five, and widening the
window must widen the prediction with it.

`updatedRule.startTime` is already a `@db.Time` `Date`; do not round-trip it
through `hhmmToTime`. (The class site does convert, because its `updated` is a
`WithSlot` carrying the HH:mm string — a real difference between the two call
sites, not an inconsistency to erase.)

- [ ] **Step 6: Extend the result type**

Both new fields, with docblocks. Do not copy the class family's paragraphs
verbatim — they say "recurring class". Carry the three facts that are true for
both: `null` has two causes (which is why `generationState` is a field and not
an inference), the value is a **Monday** rather than the candidate occurrence,
and the conversion happens in the service because `mondayOf` lives in a
pino-importing module while the copy layer is value-imported by a `'use client'`
component.

- [ ] **Step 7: Run**

```bash
npx vitest run --project unit src/services/studio-class-template-lifecycle.test.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/services/studio-class-template-lifecycle.ts src/services/studio-class-template-lifecycle.test.ts
git commit -m "feat: the studio edit predicts its first reachable week (issue 284)"
```

---

### Task 6: one edit-confirmation sentence, two nouns

**Files:**
- Modify: `src/components/settings/template-action-messages.ts` (`templateUpdatedMessage` `:371`)
- Test: `src/components/settings/template-action-messages.test.ts` — **`unit`,
  not `components`.** That project's include glob is `.tsx`-only and
  `vitest.config.ts:201-207` states the disjointness explicitly; naming
  `components` for a `.ts` file collects nothing and exits 1, which in a
  failing-first step is indistinguishable from the expected failure.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:

```ts
export type TemplateCopyNoun = 'recurring class' | 'template';

export function templateUpdatedMessage(
  firstEffective: Date | null,
  generationState: TemplateGenerationState,
  noun: TemplateCopyNoun,
): string;
```

- [ ] **Step 1: Write the failing tests**

Four studio cases (`active` with and without a week, `paused`, `archived`)
asserting the full sentence verbatim, plus the four class cases updated for the
new tail. The paused studio sentence in full:

```
Template updated. It takes effect for newly generated classes — this template is paused, so nothing is generated until you resume it. Change or cancel existing classes individually if needed.
```

And one pin that the two families' sentences are **not** interchangeable: assert
`templateUpdatedMessage(null, 'paused', 'template') !== templateUpdatedMessage(null, 'paused', 'recurring class')`.
That is the test `resumeStudioMessage`'s agreement pin is modelled on, one
direction over — there the two must agree, here they must differ.

- [ ] **Step 2: Run and record**

```bash
npx vitest run --project unit src/components/settings/template-action-messages.test.ts -t "templateUpdatedMessage"
```

Expected: FAIL — third argument not accepted, and the class tail still lacks
"or cancel".

- [ ] **Step 3: Add the noun and change the tail**

`const tail = 'Change or cancel existing classes individually if needed.'` and
`${noun}` in the two state clauses. The `never`-default switch stays exactly as
it is.

Then fix the call sites the new parameter breaks — measured, there is exactly
one in production and nine in tests:

```bash
grep -rn "templateUpdatedMessage(" src/ --include="*.ts" --include="*.tsx" | grep -v "^src/components/settings/template-action-messages.ts:"
```

`template-form.tsx:428` passes `'recurring class'`. The nine existing
assertions in `template-action-messages.test.ts:641-693` take the same third
argument — they are the class family's cases and their expected sentences gain
"or cancel".

The docblock's closing-clause paragraph currently explains why the tail is
hedged ("`settingsLocked` refuses economic edits on a booked class, so 'change
existing classes individually' is not universally available"). It gains the
second family's reason: a **generated** studio class's date cannot move at all
(`studio-class-editability.ts`), so cancelling is the remedy that always exists
— which is what the added words name. State it as the reason the sentence reads
as it does; do not write what it used to say.

- [ ] **Step 4: Run**

```bash
npx vitest run --project components src/components/settings/template-action-messages.test.ts
npm run typecheck
```

Expected: pass. `tsc` fails at the class family's call site until it passes
`'recurring class'` — that error is the tether working.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/template-action-messages.ts src/components/settings/template-action-messages.test.ts src/components/settings/template-form.tsx
git commit -m "copy: one edit-confirmation sentence, and a tail that is true for both families (issue 284)"
```

---

### Task 7: the PUT carries it and the form says it

**Files:**
- Modify: `src/app/api/studio-class-templates/[id]/route.ts` (the PUT's `respondOk`)
- Modify: `src/components/settings/studio-template-form.tsx` (`:228`)
- Test: `tests/integration/` — the studio template PUT file (find it with the command in Step 1)
- Test: `src/components/settings/studio-template-form.test.tsx`

**Interfaces:**
- Consumes: Task 5's result fields, Task 6's `templateUpdatedMessage`.
- Produces: the PUT's `data` gains `firstEffective` (ISO string or `null`) and
  `generationState` (`'active' | 'paused' | 'archived'`).

- [ ] **Step 1: Find the integration file that owns this route**

```bash
grep -rln "studio-class-templates" tests/integration/
```

Name it in the ledger. Do not hand-list the others; `npm run verify` runs them
all.

- [ ] **Step 2: Write the failing tests**

Integration: a PUT that moves `dayOfWeek` answers 200 with a `firstEffective`
that parses as a Monday and `generationState: 'active'`; a PUT on a paused
template answers `firstEffective: null`, `generationState: 'paused'`.

Component: the form renders the studio sentence rather than `Saved` after a
successful PUT.

- [ ] **Step 3: Run and record the failure**

```bash
npx vitest run --project integration <the file from Step 1>
npx vitest run --project components src/components/settings/studio-template-form.test.tsx
```

- [ ] **Step 4: Implement both ends**

Route: mirror `api/class-templates/[id]/route.ts:226-245`, including the comment
explaining that `firstEffective` is serialized as an ISO string and
`generationState` is not redundant with the `isActive`/`isArchived` columns the
response already spreads.

**And fix a stale claim you will be editing around** (found by Task 5, left for
you deliberately): the comment on `const unhandled: never = result;` in the
studio route says *"the class twin's success arm already carries `sync`, and its
route spreads it."* `sync` no longer exists anywhere. Rewrite the sentence to
state what is true now — do not work around it, and do not record what it used
to say.

Form: mirror `template-form.tsx:395-430` — parse as untrusted JSON, validate
`generationState` against the three literals rather than casting, and default to
`'active'` when the wire says something else, exactly as the class form does.

- [ ] **Step 5: Run, then verify in the running app**

```bash
npx vitest run --project integration <the file from Step 1>
npx vitest run --project components src/components/settings/studio-template-form.test.tsx
```

Then drive it by hand — the `verify` skill (`.claude/skills/verify/`) has the
auth-without-email recipe. Move a studio template's day and read the sentence.
Warm the route first (#290).

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/studio-class-templates/[id]/route.ts" src/components/settings/studio-template-form.tsx src/components/settings/studio-template-form.test.tsx tests/integration/
git commit -m "feat: the studio template PUT names the week, and the form says it (issue 284)"
```

---

### Task 8: what removing a past generated class does to its week

The acceptance `2026-08-21-studio-class-deletion-design.md` §5 asked this issue
to add, and the first moment it is observable.

**Files:**
- Test: `src/services/studio-class-deletion.test.ts`
- Modify: `src/services/studio-class-deletion.ts` (`:91-107`)

**Interfaces:**
- Consumes: Task 2's week key.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Generate a studio window, age one entry into the past (write its `date`
directly), remove that class through the deletion path, then run
`generateStudioInstancesForTemplate` from a `from` inside that same week with
the rule moved to a later weekday. The freed week must now be filled, where
before the removal it was `already_this_week`.

Assert **both** halves — the skip reason before removal and the created row
after — or the test passes against a generator that never had a week key at all.

- [ ] **Step 2: Run**

```bash
npx vitest run --project unit src/services/studio-class-deletion.test.ts
```

- [ ] **Step 3: Rewrite the docblock's forward-looking paragraph**

`studio-class-deletion.ts:91` opens *"AS SPECIFIED, NOT AS IMPLEMENTED — #284
has not shipped, so nothing below is pinned by a test and this paragraph is the
fastest-rotting prose in the file."* It is implemented and pinned now. Rewrite
the paragraph to state the behaviour, name the test that holds it, and drop the
rotting-prose disclaimer. **The rule and the predicate do not change** — only
the tense, and the sentence that said nothing pinned it.

- [ ] **Step 4: Commit**

```bash
git add src/services/studio-class-deletion.ts src/services/studio-class-deletion.test.ts
git commit -m "test: removing a past generated class frees its week (issue 284)"
```

---

### Task 9: the sweep — what this branch invalidated

Derived from what stopped being true, not from what was edited (#315). Every hit
gets its own verdict; legitimate survivors are expected and rewriting one is the
mirror-image defect.

**Files:** whatever the greps below name, plus `CLAUDE.md` and
`docs/technical-architecture.md`.

- [ ] **Step 1: Run the four sweeps and write the hits to a file**

```bash
{
  echo "== A: the pending-producer claims =="
  grep -rn "#284" src/ tests/ docs/*.md CLAUDE.md | grep -v backlog-roadmap
  echo "== B: objects that no longer exist =="
  grep -rn "logSkippedSlots\|logSkippedStudioSlots\|'class generation could not fill" src/ tests/ docs/
  echo "== C: descriptions of a pair that is now one =="
  grep -rn "studio twin\|class twin\|second copy\|parallel-but-separate" src/services/ tests/ docs/
  echo "== D: the week-predicate absence =="
  grep -rn "no week predicate\|has no week key\|week-keyed" src/ tests/ docs/ CLAUDE.md | grep -v backlog-roadmap
} | tee /tmp/284-invalidation.txt
wc -l /tmp/284-invalidation.txt
```

- [ ] **Step 2: Verdict each hit, one line each, in the ledger**

Three verdicts only: **stale** (rewrite to what is true now), **survivor**
(still true — say why in one clause), **moved** (the claim is right but belongs
in a different file now). Known members before you start:

- `api/studio-class-templates/[id]/route.ts:234` — "0 on every response until
  #284" → **stale**.
- `lib/generation.ts:195` — same shape → **stale**.
- `studio-class-template-lifecycle.ts:546` — "what this family still owes #194
  is tracked on #284" → **stale**; the paragraph above it (the rule itself)
  is a **survivor** and must not be touched.
- `class-generator.ts:317` — "corrects a claim on #284" → **survivor**. The
  correction it names is still the reason that read is keyed on
  `scheduleRuleId`.
- `studio-template-form.tsx:173-178` — needs re-verdicting, not rewriting. Its
  claim is that `alreadyThisWeek` stays unreachable **on create**, which is
  still true (a brand-new template holds no week). What changes is the reason:
  it is no longer "the studio generator has no week key". Rewrite that clause,
  keep the conclusion, and do **not** add the gate term.
- `template-action-messages.ts:465,466,520` and
  `template-action-messages.test.ts:303,600` — **stale**.
- `docs/technical-architecture.md:317` — "apart from the week key, which is
  #284's" → **stale**.
- `CLAUDE.md` — "it does **not** yet key generation per week …
  `studio-class-generator.ts` has no week predicate, so a studio template moved
  Tuesday→Thursday generates four Thursdays beside the four standing Tuesdays.
  #284 carries that half" → **stale**; rewrite the whole clause so the bullet
  states one rule for both families.

- [ ] **Step 2b: The named carry-overs from earlier task reviews**

Four comment defects and one dead symbol, each already located. They are here
rather than in their own fix rounds because this task already owns this surface;
each still gets its own verdict.

1. `src/services/studio-class-generator.test.ts:1214` — a **prose census that is
   false as written**: "every other east-teacher template in this file starts at
   16:15 or earlier". Measured, `:818` creates one at **16:45**. The conclusion
   survives (that one is `dayOfWeek: 5` and the exclusion is per-weekday), so
   replace the census with a sentence the next fixture cannot falsify — the
   latest east-teacher rule on either day this `describe` uses ends at 17:15.
2. `src/services/entry-generation.ts:287` — "Both generators' own test files do
   call this with a bare `prisma`" was a claim about its own file before the
   merge and is now a claim about two others. Reword it as the property it
   justifies: the parameter type admits a bare client because the generator
   suites drive it outside a transaction.
3. `src/services/entry-generation.ts:329` — carries "The sentence that used to be
   here said it could not — 'the filter above can only drop the first of five'",
   which is the `this previously read X` form CLAUDE.md forbids in source. It is
   inherited rather than introduced, and moving into a new file was the moment to
   re-cut it. State the constraint; the history belongs in the PR body.
4. `src/services/entry-generation.ts` — "ONE READ FOR BOTH FAMILIES since #327,
   **where this used to be two**" (in the probe), the same forbidden form as
   item 3 and likewise inherited rather than introduced. Two carried instances
   of one pattern in one file is the signal to re-cut both.
5. `src/services/studio-class-template-lifecycle.ts:519` — names the wrong
   conversion site: "The conversion happens in `updateStudioClassTemplate`".
   Since Task 4 it happens in `probeFirstEffectiveWeek`, and this file does not
   import `mondayOf` at all. **The class twin at
   `class-template-lifecycle.ts:458-459` carries the identical stale naming**,
   so the tree now holds two copies — fix both, and say "in the service layer"
   or point at the probe rather than naming a function that does not do it.
6. `src/services/studio-class-template-lifecycle.test.ts:2064` — "the block's own
   `makeTemplate` slots are all 09:xx" is false: `slotTime(counter * 60 - 30)`
   walks `09:30, 10:30, 11:30, …`, and the same file says so at `:127` and
   `:678`. The reasoning it supports survives; the roster is wrong on its first
   reading.
7. `src/services/studio-class-template-lifecycle.test.ts:1598-1603` — **this
   branch falsified this one.** The note promises the deliberate-collision
   literal `'21:45'` sits "well outside" the block's computed range; Task 5's
   three new `makeTemplate` calls moved the counter ceiling from 10 to 13, so
   the computed range is now `21:30–22:30` and it OVERLAPS `21:45–22:45`. It
   passes only because that `ClassTemplate` is torn down in its own `finally`
   before counter 13 is minted — ordering, not the separation the comment
   claims. Correct the note, and record that headroom is two calls (counter 16
   computes `'24:30'` and `slotTime` throws).
8. `src/services/studio-class-template-lifecycle.ts:605-608` — "but this
   paragraph is, because it used to frame the absence as a seam" is a third
   instance of the forbidden form, two lines above a paragraph this branch
   rewrote for that same rule.
9. **`isCrossFamilySlotConflict` has no definition left anywhere in `src/`** and
   is still named in four files (`entry-generation.ts`,
   `studio-class-template-lifecycle.ts`, `class-template-lifecycle.ts`,
   `generation-transaction.test.ts`). Pre-existing, not this branch's doing —
   but it is exactly the shape of #315's lesson, and this sweep is where it gets
   a verdict. Check each site: some sit inside paragraphs explicitly labelled as
   describing the superseded trigger era, and those may be legitimate survivors.

- [ ] **Step 3: Read whole docblocks in the touched functions**

The category no grep reaches: a paragraph that names no object and only
*describes* one wrongly (#315's one Critical finding). Read every docblock in
`entry-generation.ts`, both generator files, and both lifecycle `update`
functions, asking "is this still a description of what this code does?" — not
"does it mention a name that changed".

- [ ] **Step 4: Commit**

```bash
git add -- CLAUDE.md docs/technical-architecture.md src/
git commit -m "docs: what the merge invalidated, verdicted one at a time (issue 284)"
```

---

### Task 10: the mutations

Eight, from spec §7. Each: apply, run the named command, **record the exact
failure text**, restore, re-run to confirm green. A mutation that passes is a
finding, not a nuisance — stop and report it.

**Files:** none committed. The record goes in the ledger and the PR body.

- [ ] **Step 1: `isWeekHeld` returns `false`**

Command: `npx vitest run --project unit src/services/class-generator.test.ts src/services/studio-class-generator.test.ts`
Expected: RED in **both** families. This is the mutation that proves the
extraction load-bearing rather than decorative — a red in only one family means
the studio side is not actually going through it.

- [ ] **Step 2: delete the `heldWeeks` read from `generateEntriesForRule`** (pass an empty `Set`)

Expected: RED in both generator suites.

- [ ] **Step 3: swap the own-date and week branches**

Expected: RED on both families' `already_generated` steady-state tests. Both,
because Task 2's third test puts the studio family behind the same pin.

- [ ] **Step 4: add `cancelledAt: null` to the week read**

Expected: RED on both families' "a cancelled class still holds its week" tests,
and note **which assertion** fails — it must be the created-dates one, not only
the reasons one.

- [ ] **Step 5: `probeFirstEffectiveWeek` returns the candidate date, not its Monday**

Expected: RED on both families' message tests, on the rendered day.

- [ ] **Step 6: two noun mutations, because there are two nouns**

Point the studio **copy** noun at `'recurring class'` → RED on the studio
message test. Restore, then point the studio **`logNoun`** at
`'recurring class'` → RED on the skip-log test. If either passes, that noun has
no pin.

- [ ] **Step 7: drop `generationState` from the studio result and infer from `firstEffective`**

Expected: RED on the paused and archived message tests.

- [ ] **Step 8: splice `'ClassTemplate'` into `STUDIO_GENERATOR.childTable`**

Expected: RED on the studio claim tests. Use the wrong *table*, not a
nonexistent one — a nonexistent name fails to compile, which proves the tether
and not the splice.

- [ ] **Step 9: record all eight in the ledger, then confirm the tree is clean**

```bash
git status --porcelain   # expect: no output
```

---

### Task 11: verify, push, PR

- [ ] **Step 1: Full gate**

```bash
npm run verify
```

Expected: exit 0. Record `Test Files` and `Tests` from **both** invocations —
`npm test` is two runs joined by `&&`, and a red unit tier means the integration
tier reports nothing at all rather than zero failures. If anything earlier is
red, run `npx vitest run --project integration` directly rather than reading a
red `verify` as evidence about that tier.

- [ ] **Step 2: Reconcile the after-figure against the baseline**

`68 + 46 + 16 + 33 = 163` files, `1034 + 302 + 142 + 531 = 2009` tests at
`e9ed2201`. Report the measured after-figure and the arithmetic; **do not
predict it** — #212's handover predicted 1294 against a real 1296 because that
branch's own review added tests.

- [ ] **Step 3: Push and open the PR**

The body must carry: the six-difference generator measurement with the command
that re-derives it; the three noun vocabularies; the class family's skip-log
string change; which of the issue's claims were checked and which held (§1 of
the spec); the eight mutations with their observed failures; the suites that
ran, naming the integration file this branch touched by path; and what the
branch does **not** do.

**Never write "does not close #N".** GitHub's parser matches the keyword and
ignores the negation in front of it — PR #191 closed issue 113 that way. Write
"**#N is unaffected**". The three to name: the sweeps' merge, stage C2's
`update` merge, and #205.

- [ ] **Step 4: `/pr-review-toolkit:review-pr <N>`**

Run code, tests, comments and silent-failure reviewers. Skip type-design: the
branch's subject is a merge, and its one new type is a split of an existing one.
Give the comments reviewer the specific risk — claims reaching past the file
they sit in, and the docblocks Task 9 Step 3 rewrote.
