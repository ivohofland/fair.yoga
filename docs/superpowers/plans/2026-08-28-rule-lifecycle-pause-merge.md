# Stage C1b — `pauseOrResume` over `ScheduleRule` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the two template families' `pauseOrResume` into one
`pauseOrResumeRule` over `TemplateFamily`, alongside the `archiveOrUnarchiveRule`
PR #335 landed.

**Architecture:** A family-descriptor dispatch table, not a runtime family test.
`rule-lifecycle.ts` gains `pauseOrResumeRule<TChild>`, `TemplateFamily` gains two
fields (`claim`, `generate`), and each service keeps a thin exported wrapper and
its own public result union. Nothing in the shared module asks which family it is
holding.

**Tech Stack:** TypeScript strict, Prisma 6, PostgreSQL, Vitest (four projects:
`unit`, `components`, `unit-sweeps`, `integration`).

**Spec:** `docs/superpowers/specs/2026-08-28-rule-lifecycle-pause-merge-design.md`

## Global Constraints

- **The stop condition.** If merging forces a parameter that exists only to tell
  the families apart at runtime, STOP and record it. `rule-lifecycle.ts` must
  contain no comparison against a `ClassFamily` literal. An
  `if (family.kind === 'regular')` in the merged body is the forbidden thing.
- **No third type parameter.** `claim`/`generate` are typed over
  `ChildWithRule<TChild>`. Do NOT introduce a `TClaimed` — measured unnecessary
  (spec §3.3), and it is the shape that killed #332's two-parameter draft.
- **No import cycle.** `rule-lifecycle.ts` is imported BY the two services and
  must never import them back.
- **Pure merge.** No behaviour change. The 2006-test baseline staying green is
  the proof. Leave issue 301 alone in this branch — **#301 is unaffected by it.**
- **Every guard ships with a mutation** observed failing, restored, re-verified,
  using a value the code under test cannot produce.
- **Comment discipline** (CLAUDE.md): a comment annotates the code it sits on.
  Counts, rosters and facts about other modules go in `docs/`. Never write
  "this previously read X" — corrections belong in the PR body.
- **Baseline:** `68 + 46 + 16 + 33 = 163` files, `1031 + 302 + 142 + 531 = 2006`
  tests, `npm run verify` exit 0. Measure the after-figure; never predict it.
- **`npm run verify` needs the dev server on :3000.** The user runs it. Never
  start or restart it.

---

### Task 1: `remainingWhere` becomes `standingWhere`

Archive's word for a field two verbs will call. Renamed before the merge so the
merge's diff is about the merge.

**Files:**
- Modify: `src/services/rule-lifecycle.ts` (the `TemplateFamily` field and its
  docblock; the shared archive's call site)
- Modify: `src/services/class-template-lifecycle.ts` (`CLASS_FAMILY`)
- Modify: `src/services/studio-class-template-lifecycle.ts` (`STUDIO_FAMILY`)
- Test: `src/services/rule-lifecycle.test.ts` (the boundary `describe`)

**Interfaces:**
- Consumes: nothing.
- Produces: `TemplateFamily<TChild>['standingWhere']`, signature unchanged —
  `(scheduleRuleId: string, today: Date) => Prisma.CalendarEntryWhereInput`.

- [ ] **Step 1: Find every occurrence**

```bash
grep -rn "remainingWhere" src/ | tee /tmp/c1b-rename-sites.txt
```

Expected: hits in `rule-lifecycle.ts`, both family files, and
`rule-lifecycle.test.ts`. Record the count; it is the reconciliation for Step 3.

- [ ] **Step 2: Rename, and update the docblock's first sentence**

The field's docblock currently opens *"The entries an archive of this family
leaves standing, counted for the teacher after the delete."* It becomes the
entries **either verb** reports as standing. Rewrite the opening sentence to say
so; keep the whole `today` INCLUSIVE paragraph, which is still exactly right and
is the reason the boundary matters.

Do NOT write "renamed from `remainingWhere`" anywhere in the source. That
belongs in the commit message and the PR body.

- [ ] **Step 3: Verify nothing was missed**

```bash
grep -rn "remainingWhere" src/ ; echo "exit=$?"
```

Expected: no output. Then confirm the new name's count matches Step 1's:

```bash
grep -rn "standingWhere" src/ | wc -l
```

- [ ] **Step 4: Typecheck and run the affected project**

```bash
npx tsc --noEmit
npx vitest run --project unit src/services/rule-lifecycle.test.ts
```

Expected: tsc silent; the rule-lifecycle suite green.

- [ ] **Step 5: Commit**

```bash
git add src/services/rule-lifecycle.ts src/services/class-template-lifecycle.ts \
        src/services/studio-class-template-lifecycle.ts src/services/rule-lifecycle.test.ts
git commit -m "refactor: standingWhere, because two verbs now call it (issue 336)"
```

---

### Task 2: `LastScheduledClass` moves to the shared module

The studio family currently imports it from the class family — a dependency
neither owns. The shared pause arm needs it, so it moves to where both already
look.

**Files:**
- Modify: `src/services/rule-lifecycle.ts` (add the export)
- Modify: `src/services/class-template-lifecycle.ts:1138` (remove the local
  declaration; import from `./rule-lifecycle`)
- Modify: `src/services/studio-class-template-lifecycle.ts:~68` (import from
  `./rule-lifecycle` instead of `./class-template-lifecycle`)

**Interfaces:**
- Consumes: Task 1's rename (same files; avoids a conflicting edit).
- Produces: `export type LastScheduledClass = { date: Date; startTime: string };`
  from `@/services/rule-lifecycle`.

- [ ] **Step 1: Add it to the shared module**

In `src/services/rule-lifecycle.ts`, beside `WithSlot`:

```ts
/**
 * The last dated entry a pause leaves standing, as the teacher is told about
 * it. `startTime` is HH:mm — the wire spelling, not the `Date` the column
 * holds — because this crosses into a response body unchanged.
 */
export type LastScheduledClass = { date: Date; startTime: string };
```

- [ ] **Step 2: Remove the class-family declaration and re-point both importers**

Delete the `export type LastScheduledClass` line from
`class-template-lifecycle.ts` and add `LastScheduledClass` to its existing
`import type { … } from './rule-lifecycle'` block.

In `studio-class-template-lifecycle.ts`, remove `LastScheduledClass` from the
`from './class-template-lifecycle'` import and add it to the
`from './rule-lifecycle'` one. **Leave
`PlainUpdateForbiddenScheduleRuleField` and `TeacherEditableScheduleRuleField`
where they are** — they are the `_ruleAllowlistsAgree` /
`_ruleForbiddenListsAgree` cross-family agreement pins, and the whole point of
those is to reach into the other family.

- [ ] **Step 3: Verify the cross-family import shrank but did not vanish**

```bash
grep -n "from './class-template-lifecycle'" -A5 -B5 src/services/studio-class-template-lifecycle.ts
```

Expected: the import block still exists with the two allowlist type names, and
no longer names `LastScheduledClass`.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: silent. A missed importer surfaces here.

- [ ] **Step 5: Commit**

```bash
git add src/services/rule-lifecycle.ts src/services/class-template-lifecycle.ts \
        src/services/studio-class-template-lifecycle.ts
git commit -m "refactor: LastScheduledClass belongs to the shared module (issue 336)"
```

---

### Task 3: `kind` correlates at compile time

Replaces `rule-lifecycle.test.ts`'s runtime loop with a compiler guarantee.
**The sketch in issue #336 does not compile as written** — the constants must
carry their own kind literal. Measured; see spec §4.1.

**Files:**
- Modify: `src/services/rule-lifecycle.ts:100-101` (the type parameter)
- Modify: `src/services/class-template-lifecycle.ts` (`CLASS_FAMILY`'s annotation)
- Modify: `src/services/studio-class-template-lifecycle.ts` (`STUDIO_FAMILY`'s)
- Test: `src/services/rule-lifecycle.test.ts` (registry, and the loop it deletes)

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: `TemplateFamily<TChild, TKind extends ClassFamily = ClassFamily>`.
  Existing single-argument uses (`TemplateFamily<ClassTemplate>`) keep compiling
  via the default; `archiveOrUnarchiveRule`'s signature needs no change.

- [ ] **Step 1: Add the type parameter — and nothing else**

This step and the next reproduce **exactly what issue #336 wrote**, so that the
piece it omits fails on its own terms. The issue's sketch shows two things: the
type carrying `TKind`, and the correlated `satisfies` clause. It does **not**
show the family constants carrying their kind literals. So both of the things it
does show land first, and the omission is what Step 3 supplies.

Order matters here and the obvious order is wrong: writing the `satisfies`
clause before the type parameter exists yields
`TS2314: Generic type 'TemplateFamily' requires 1 type argument(s)` — an arity
complaint that demonstrates nothing about `kind`.

In `src/services/rule-lifecycle.ts`, add the second parameter with its default,
and nothing more. Leave `CLASS_FAMILY` and `STUDIO_FAMILY` annotated exactly as
they are:

```ts
export type TemplateFamily<TChild, TKind extends ClassFamily = ClassFamily> = {
  kind: TKind;
  /* … the rest unchanged … */
};
```

The default is what keeps every existing single-argument use compiling
untouched — notably `archiveOrUnarchiveRule<TChild>(db, family: TemplateFamily<TChild>, …)`.
Confirm that before moving on:

```bash
npx tsc --noEmit
```

Expected: **silent**. If this errors, the default is missing or a call site was
widened that did not need to be.

- [ ] **Step 2: Write the correlated tether, and run it to see it fail**

In `src/services/rule-lifecycle.test.ts`, replace the `FAMILY_BY_KIND`
declaration's `satisfies` clause with the correlated form, and add the child map
above it:

```ts
/**
 * Correlates each descriptor's own `kind` with the key it is filed under, at
 * compile time. The runtime loop this replaces could only observe a
 * disagreement after the fact; this makes it unrepresentable.
 *
 * `TKind` sits in a property position and is therefore covariant — it cannot
 * reproduce the invariance failure that killed the two-parameter draft, where
 * the parameter sat in a return and a parameter position at once.
 */
interface ChildByKind {
  regular: ClassTemplate;
  studio: StudioClassTemplate;
}

const FAMILY_BY_KIND = {
  regular: CLASS_FAMILY,
  studio: STUDIO_FAMILY,
} satisfies { [K in ClassFamily]: TemplateFamily<ChildByKind[K], K> };
```

Then run it:

```bash
npx tsc --noEmit 2>&1 | head -12
```

Expected FAIL, exactly:

```
error TS2322: … is not assignable to type 'TemplateFamily<…, "regular">'.
  Types of property 'kind' are incompatible.
    Type 'ClassFamily' is not assignable to type '"regular"'.
```

This is the point of the task: the type parameter alone is not enough.

- [ ] **Step 3: Supply what the issue's sketch omits**

Each constant carries its own kind literal. This is the step #336 does not
mention, and Step 2 is the evidence that it is required rather than tidy:

```ts
export const CLASS_FAMILY: TemplateFamily<ClassTemplate, 'regular'> = {
export const STUDIO_FAMILY: TemplateFamily<StudioClassTemplate, 'studio'> = {
```

- [ ] **Step 4: Verify it now compiles**

```bash
npx tsc --noEmit
```

Expected: silent.

- [ ] **Step 5: Delete the runtime loop it replaces**

Remove this test from `rule-lifecycle.test.ts` — it now asserts something that
cannot be false:

```ts
it('each descriptor declares the kind it is filed under', () => {
  for (const [kind, family] of Object.entries(FAMILY_BY_KIND)) {
    expect(family.kind).toBe(kind);
  }
});
```

Then check whether `AnyTemplateFamily` still has a consumer:

```bash
grep -n "AnyTemplateFamily" src/services/rule-lifecycle.test.ts
```

If the correlated `satisfies` is now its only former use, delete the alias too
and its docblock. If something else still uses it, keep it and update its
instantiations to carry the kind literals.

- [ ] **Step 6: Prove the guard bites — the ISOLATING mutation**

The mutation must keep the child type correct and make only `kind` lie;
swapping the two descriptors would be caught by the child type alone and proves
nothing about the correlation. Temporarily, in `rule-lifecycle.test.ts`:

```ts
const FAMILY_BY_KIND = {
  regular: { ...CLASS_FAMILY, kind: 'studio' as const },
  studio: STUDIO_FAMILY,
} satisfies { [K in ClassFamily]: TemplateFamily<ChildByKind[K], K> };
```

```bash
npx tsc --noEmit 2>&1 | head -5
```

Expected FAIL: `TS2322`, `Type '"studio"' is not assignable to type '"regular"'`
(measured). Restore, re-run `npx tsc --noEmit`, expect silent.

Record both outputs in the commit message.

- [ ] **Step 7: Run the suite and commit**

```bash
npx vitest run --project unit src/services/rule-lifecycle.test.ts
git add src/services/rule-lifecycle.ts src/services/rule-lifecycle.test.ts \
        src/services/class-template-lifecycle.ts src/services/studio-class-template-lifecycle.ts
git commit -m "refactor: kind correlates to its key at compile time (issue 336)"
```

---

### Task 4: `withSlot`'s `rule` parameter stops lying

Declared `ScheduleRule`; handed the joined row carrying
`teacher: { defaultTimezone }`. Read spec §4.2 before starting — **the fix
guarantees less than it looks like**, and the plan depends on knowing which
part is real.

**Files:**
- Modify: `src/services/rule-lifecycle.ts` (the `withSlot` field type and its
  docblock; the archiving arm's call site)
- Modify: `src/services/class-template-lifecycle.ts` (`CLASS_FAMILY.withSlot`)
- Modify: `src/services/studio-class-template-lifecycle.ts` (`STUDIO_FAMILY.withSlot`)
- Test: both lifecycle test files (the two pins KEEP, and gain one line each)

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `withSlot: (child: ChildWithRule<TChild>, rule: JoinedRule) =>
  WithSlot<TChild>` where
  `export type JoinedRule = ScheduleRule & { teacher: { defaultTimezone: string } }`.

- [ ] **Step 1: Name the joined type once and reuse it**

`ChildWithRule` already spells it inline. In `rule-lifecycle.ts`, extract it so
the `withSlot` field and `ChildWithRule` cannot drift apart:

```ts
/**
 * A `ScheduleRule` as every joined read in this module returns it: with the one
 * `Teacher` column the date boundaries need.
 */
export type JoinedRule = ScheduleRule & { teacher: { defaultTimezone: string } };

export type ChildWithRule<TChild> = TChild & {
  scheduleRuleId: string;
  scheduleRule: JoinedRule;
};
```

- [ ] **Step 2: Widen the field and fix the one bare call site**

```ts
withSlot: (child: ChildWithRule<TChild>, rule: JoinedRule) => WithSlot<TChild>;
```

`npx tsc --noEmit` now fails at the archiving arm, which passes the bare
`recordedRule`. Compose the teacher in from the joined row already in scope —
no query change:

```ts
template: family.withSlot(template, { ...recordedRule, teacher: template.scheduleRule.teacher }),
```

- [ ] **Step 3: Make both adapters discard it structurally**

In each family's descriptor, destructure `teacher` off the rule exactly as the
adapter already destructures `scheduleRule` off the child:

```ts
withSlot: ({ scheduleRule, ...bare }, { teacher, ...rule }) => {
  void scheduleRule;
  void teacher;
  return withSlot(bare, rule);
},
```

- [ ] **Step 4: Rewrite the field's docblock to what is now true**

The existing paragraph ends by describing the gap this task closes — it must not
survive describing a state that no longer exists, and it must not be replaced
with a history of itself. State the two things measured to hold and the one that
does not:

```
 * `rule` is the JOINED row, and each adapter destructures `teacher` off it the
 * way it destructures `scheduleRule` off the child. What that buys is exact:
 * the remainder these adapters spread provably cannot carry `teacher`, and
 * narrowing the joined read later is a compile error rather than a silent
 * change. What it does NOT buy is a bar on a differently-written adapter —
 * TypeScript does not apply excess-property checking to spread-introduced
 * properties, so an adapter that spread `rule` whole would still compile. The
 * runtime pins in both lifecycle tests are the second line for exactly that
 * case, and are not redundant.
```

- [ ] **Step 5: Keep both pins, and say why in one line**

In `class-template-lifecycle.test.ts` (~:2169) and
`studio-class-template-lifecycle.test.ts` (~:643), the
`expect(Object.keys(resumed.template)).not.toContain('teacher')` assertions
STAY. Add one line above each:

```ts
// Kept deliberately after the parameter became the joined type: that makes
// the shipped adapters provably teacher-free, but a spread-based adapter
// would still compile. This is the second line, not a duplicate of the first.
```

- [ ] **Step 6: Prove the pins still bite**

Mutate `CLASS_FAMILY.withSlot` to spread the rule whole:

```ts
withSlot: ({ scheduleRule, ...bare }, rule) => {
  void scheduleRule;
  return { ...rule, ...withSlot(bare, rule) };
},
```

```bash
npx tsc --noEmit
npx vitest run --project unit src/services/class-template-lifecycle.test.ts -t "never the joined rule row"
```

Expected: **tsc silent** (this is the caveat, demonstrated) and the test **RED**
on `teacher`. Record both. Restore and re-verify green.

**The spread order is load-bearing.** `withSlot`'s output must come LAST.
`ScheduleRule.startTime` is a raw Prisma `DateTime` while `WithSlot`'s is the
flattened `string`, so spreading `rule` *after* `withSlot(...)` overwrites the
string with a `Date` and tsc rejects it on that mismatch — a compile error, but
about the wrong thing, and one that would teach the opposite of the truth. With
`withSlot` last, `startTime` stays a string and only `teacher` survives from the
rule, which is exactly the leak the pin exists to catch.

- [ ] **Step 7: Commit**

```bash
git add src/services/rule-lifecycle.ts src/services/class-template-lifecycle.ts \
        src/services/studio-class-template-lifecycle.ts \
        src/services/class-template-lifecycle.test.ts \
        src/services/studio-class-template-lifecycle.test.ts
git commit -m "refactor: withSlot's rule parameter is the row it is actually handed (issue 336)"
```

---

### Task 5: `pauseOrResumeRule`, with the studio family on it

The merge, done one family at a time so the second family's arrival is a real
test of the generic rather than a rewrite of it. Studio first: it is the family
with no room constraint, so Task 6 introduces the class-only throw against an
already-working shared function.

**Files:**
- Modify: `src/services/rule-lifecycle.ts` (two descriptor fields; the new
  function and its outcome type)
- Modify: `src/services/studio-class-template-lifecycle.ts` (`STUDIO_FAMILY`
  gains `claim`/`generate`; `pauseOrResumeStudioTemplate` becomes a wrapper)
- Test: `src/services/studio-class-template-lifecycle.test.ts` (unchanged —
  it is the proof)

**Interfaces:**
- Consumes: Tasks 1-4 — `standingWhere`, `LastScheduledClass`, `JoinedRule`,
  `TemplateFamily<TChild, TKind>`.
- Produces:

```ts
export type PauseRuleOutcome<TChild> =
  | { outcome: 'not_found' }
  | { outcome: 'archived' }
  | { outcome: 'busy' }
  | { outcome: 'unchanged'; template: WithSlot<TChild> }
  | { outcome: 'paused'; template: WithSlot<TChild> }
  | {
      outcome: 'active';
      template: WithSlot<TChild>;
      scheduled: number;
      added: number;
      counts: SkipCounts;
    };

export async function pauseOrResumeRule<TChild>(
  db: PrismaClient,
  family: TemplateFamily<TChild>,
  templateId: string,
  teacherId: string,
  target: 'active' | 'paused',
): Promise<PauseRuleResult<TChild>>;
```

where `PauseRuleResult<TChild>` is the shared public union — `ok: false` with
`not_found | forbidden | archived | busy`, and `ok: true` with
`paused | active | unchanged` — each family aliasing it, as
`ArchiveRuleResult<TChild>` is already aliased.

- [ ] **Step 1: Add the two descriptor fields**

In `TemplateFamily`, typed over `ChildWithRule<TChild>` — **no third type
parameter** (spec §3.3):

```ts
  /**
   * Claim this template's row for generation, and generate its window. A pair
   * rather than one hook because the claimed row is what the `active` arm
   * reports on: its rule id feeds `standingWhere`, its joined teacher feeds the
   * date boundary, and its bare child feeds `withSlot`.
   *
   * Both families' real functions satisfy these signatures directly — the
   * claimed payload is the same joined shape `readChild` returns.
   */
  claim: (
    tx: TransactionClientOnly,
    templateId: string,
  ) => Promise<ChildWithRule<TChild> | null>;
  generate: (
    tx: TransactionClientOnly,
    claimed: ChildWithRule<TChild>,
  ) => Promise<GenerationResult>;
```

`STUDIO_FAMILY` then gets, with no wrappers:

```ts
  claim: claimStudioTemplateForGeneration,
  generate: generateStudioInstancesForTemplate,
```

- [ ] **Step 2: Write `pauseOrResumeRule`**

Port the body from `pauseOrResumeStudioTemplate`
(`studio-class-template-lifecycle.ts:1028-1409`), substituting:

| Concrete | Descriptor |
|---|---|
| `db.studioClassTemplate.findUnique({ include: … })` | `family.readChild(db, templateId)` |
| `tx.studioClassTemplate.findUnique({ include: { scheduleRule: true } })` | `family.readChild(tx, templateId)` |
| `"StudioClassTemplate"` in the `FOR UPDATE` | `family.childTable` (spliced as `Prisma.raw`, as the archive already does) |
| `claimStudioTemplateForGeneration` | `family.claim` |
| `generateStudioInstancesForTemplate` | `family.generate` |
| `scheduledWhere(id, { gte: today })` | `family.standingWhere(id, today)` |
| `withSlot(...)` | `family.withSlot(...)` |
| `'studio class'` in log messages | `family.logNoun` |

Keep the studio body's `paused` placement — `case 'paused': break;` and the
read-back after the `switch`. Its docblock explains why (an accidental
fall-through once answered a new arm as `paused`), and that reasoning is about
the `switch`, not about the family.

Two things NOT to change while porting:

- The `catch` stays `if (isTransientDbError(err)) → busy; throw err`. Task 6
  pins that rethrow; do not widen it.
- The claim-returned-null branch still throws with its message about the CAS and
  claim predicates diverging. Compose the noun with `family.logNoun` rather than
  hard-coding either family's word.

- [ ] **Step 3: Make the studio wrapper delegate**

```ts
export function pauseOrResumeStudioTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  target: 'active' | 'paused',
): Promise<PauseStudioTemplateResult> {
  return pauseOrResumeRule(db, STUDIO_FAMILY, templateId, teacherId, target);
}
```

`PauseStudioTemplateResult` stays exported and becomes
`PauseRuleResult<StudioClassTemplate>`, mirroring
`ArchiveStudioTemplateResult = ArchiveRuleResult<StudioClassTemplate>`. Delete
the old body and the now-unused local `ResumeTransactionOutcome`.

- [ ] **Step 4: Verify against the untouched studio suite**

```bash
npx tsc --noEmit
npx vitest run --project unit src/services/studio-class-template-lifecycle.test.ts
npx vitest run --project unit src/services/studio-class-generator.test.ts
```

Expected: green, with **no edits to either test file**. If a test needed
changing, the merge changed behaviour — stop and report which assertion moved.

- [ ] **Step 5: Check the stop condition**

```bash
grep -nE "=== *'(regular|studio)'|kind === " src/services/rule-lifecycle.ts
```

Expected: no output. Any hit is the forbidden runtime family test — stop.

- [ ] **Step 6: Commit**

```bash
git add src/services/rule-lifecycle.ts src/services/studio-class-template-lifecycle.ts
git commit -m "refactor: pauseOrResumeRule, with the studio family on it (issue 336)"
```

---

### Task 6: The class family joins, and the shared catch gets its pin

**Files:**
- Modify: `src/services/class-template-lifecycle.ts` (`CLASS_FAMILY` gains
  `claim`/`generate`; `pauseOrResumeTemplate` becomes a wrapper; old body and
  local `ResumeTransactionOutcome` deleted)
- Test: `src/services/rule-lifecycle.test.ts` (the new shared-level pin)

**Interfaces:**
- Consumes: Task 5's `pauseOrResumeRule` and `PauseRuleResult<TChild>`.
- Produces: `PauseTemplateResult = PauseRuleResult<ClassTemplate>`.

- [ ] **Step 1: Put the class family on the shared implementation**

```ts
  claim: claimTemplateForGeneration,
  generate: generateInstancesForTemplate,
```

and

```ts
export function pauseOrResumeTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  target: 'active' | 'paused',
): Promise<PauseTemplateResult> {
  return pauseOrResumeRule(db, CLASS_FAMILY, templateId, teacherId, target);
}
```

Delete the old body. `SCHEDULED_STATUSES`, `SCHEDULED_STATUSES_SQL` and the
local `scheduledWhere` are still used by `standingWhere`/`deleteWhere` — do not
delete them without checking:

```bash
grep -n "SCHEDULED_STATUSES\|scheduledWhere" src/services/class-template-lifecycle.ts
```

- [ ] **Step 2: Run the class suites, unedited**

```bash
npx vitest run --project unit src/services/class-template-lifecycle.test.ts
npx vitest run --project unit src/services/class-generator.test.ts
npx vitest run --project unit src/services/room-archive-doors.test.ts
npx vitest run --project unit src/services/room-archive.test.ts
```

Expected: green with no test edits. `room-archive-doors.test.ts` is the one that
matters most — its door-3 case asserts `pauseOrResumeTemplate` REJECTS with
`ClassTemplate_live_needs_open_room`, and that now travels through the shared
catch.

- [ ] **Step 3: Write the shared-level pin**

The class-only throw must survive the shared catch, and the guard that proves it
lives in a file named for the room-archive lifecycle. Add one in
`rule-lifecycle.test.ts`, family-agnostic, using a constraint name the codebase
cannot produce:

```ts
/**
 * The shared catch answers `busy` for a transient error and rethrows anything
 * else. The rethrow is load-bearing and its only other guard lives in
 * `room-archive-doors.test.ts`, under a name that will not occur to someone
 * editing error handling here: since #272 a resume onto an archived room is
 * refused by a CHECK, and the route turns that SQLSTATE into a 409 a teacher
 * can act on. Classify it as transient and the teacher gets 503 "the system
 * was busy" instead, with the studio family showing no symptom at all.
 *
 * `23514` on a constraint name nothing in this schema declares, so a stray
 * match cannot make this pass for the wrong reason.
 */
it('rethrows a non-transient database error rather than answering busy', async () => {
  const checkViolation = Object.assign(
    new Error('… code: "23514" … constraint "__c1b_never_a_real_constraint"'),
    { code: 'P2010' },
  );

  const throwing = prisma.$extends({
    query: {
      scheduleRule: {
        async updateMany() {
          throw checkViolation;
        },
      },
    },
  }) as unknown as PrismaClient;

  await expect(
    pauseOrResumeRule(throwing, CLASS_FAMILY, tpl.id, teacherId, 'active'),
  ).rejects.toBe(checkViolation);
});
```

Build `tpl` with the file's existing fixture helpers, paused and un-archived, so
the CAS is reached.

- [ ] **Step 4: Prove the pin bites**

Mutate the shared catch's final line from `throw err;` to:

```ts
return { ok: false, reason: 'busy' };
```

```bash
npx vitest run --project unit src/services/rule-lifecycle.test.ts -t "rethrows a non-transient"
npx vitest run --project unit src/services/room-archive-doors.test.ts
```

Expected: **both RED** — the new pin and door 3. Record the exact failure text
of each. Restore and re-verify both green.

- [ ] **Step 5: Re-check the stop condition and the trigger**

```bash
grep -nE "=== *'(regular|studio)'|kind === " src/services/rule-lifecycle.ts
diff \
  <(sed -n '/^export type PauseTemplateResult/,/^$/p'      src/services/class-template-lifecycle.ts        | grep -oE "reason: '[a-z_]+'" | sort -u) \
  <(sed -n '/^export type PauseStudioTemplateResult/,/^$/p' src/services/studio-class-template-lifecycle.ts | grep -oE "reason: '[a-z_]+'" | sort -u)
```

Expected: no output from either. If the type aliases now resolve through
`PauseRuleResult` and the `sed` ranges match nothing, say so and re-derive the
trigger against the shared union instead — **an empty diff because both sides
extracted nothing is the stale-command failure, not a pass** (spec §1).

- [ ] **Step 6: Commit**

```bash
git add src/services/class-template-lifecycle.ts src/services/rule-lifecycle.test.ts
git commit -m "refactor: the class family joins pauseOrResumeRule (issue 336)"
```

---

### Task 7: The prose, which is the larger half

#332 measured 534 lines of code under 1322 lines of comment across the four
functions, and every interesting failure that round was in the prose. Budget for
it.

**Files:**
- Modify: `src/services/rule-lifecycle.ts`, both lifecycle services, both route
  files, `src/lib/db-locks.ts`, `docs/lock-order.md`
- Create: a short `docs/` entry for where the room refusal now lives

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: no code surface.

- [ ] **Step 1: Sweep for what you INVALIDATED, not what you edited**

List what this branch REMOVED, then grep for those names — the sweep that found
an eighth stale reference on #315 when the edited-code sweep found seven:

```bash
for name in pauseOrResumeStudioTemplate ResumeTransactionOutcome remainingWhere \
            AnyTemplateFamily LastScheduledClass; do
  echo "=== $name ==="; grep -rn "$name" src/ docs/ || echo "(none)"
done
```

Give every hit a verdict. Expect legitimate survivors —
`pauseOrResumeStudioTemplate` still exists as a wrapper, and
`ResumeTransactionOutcome` may still be a live local name in another function.
**Rewriting a still-true claim is the mirror-image defect and costs more than
the staleness did.**

- [ ] **Step 2: Read whole docblocks in every touched function**

A grep finds a stale NAME, never a stale DESCRIPTION. The claims most likely
wrong now are the ones describing *where* something happens rather than naming
it. Specifically re-read and verdict:

- Every paragraph in the two services' pause docblocks that says the other
  family does or does not do something.
- `db-locks.ts:337`, which names `CLASS_FAMILY.withdraw.around`, and **the
  executable grep at `db-locks.ts:198`** — that command silently began
  returning a template-row lock as a `Class` one on #332, when the shared
  archive started splicing the table name, and it was repaired by adding a
  `family.childTable` alternative to its filter. `pauseOrResumeRule` splices
  through that same alternative, so run it and reconcile against this measured
  baseline:

  | Measured on `main` at `f08bf0b2`, before this branch | Value |
  |---|---|
  | The filtered grep (`Class`/`CalendarEntry` locks) | **5** — `db-locks.ts` ×4, `room-archive.ts` ×1 |
  | Template-table `FOR UPDATE` sites | **5** — 1 spliced (`rule-lifecycle.ts`), 4 literal |

  The four literal ones are two per family: one in each `update*Template`
  (`class-template-lifecycle.ts:890`, `studio-class-template-lifecycle.ts:632`)
  and one in each pause (`:1435`, `:1097`).

  **Predicted after this branch:** the two PAUSE literals collapse into one
  splice, so template sites go 5 → 4 (2 spliced, 2 literal), and **the filtered
  count stays 5** because every template site is filtered either way. The two
  `update*Template` locks stay — that is C2, still blocked on #284.

  If the filtered count is not 5 afterwards, the filter has stopped matching a
  splice and a template lock is being counted as a `Class` one — the #332
  failure, recurring. Do not adjust the number; fix the filter.
- Any runtime log string that describes the merged behaviour — the category
  nobody sweeps and the only one that reaches an operator's grep.

- [ ] **Step 3: Write the `docs/` entry the shared function needs**

Where a resume onto an archived room is refused now reaches past
`rule-lifecycle.ts`, so it does not go in a comment there. Add a short section
to `docs/lock-order.md` (or a sibling doc if that file's scope does not fit)
recording: the CHECK is the enforcement; the class route's pre-check, gated on
`state === 'active'`, produces the actionable message; the route's `catch` covers
the race; the studio family has no such constraint. Link to it from one line in
`pauseOrResumeRule`'s docblock.

- [ ] **Step 4: Full verify — the whole point of this step**

```bash
npm run verify
```

Expected: exit 0. Record files and tests per project, and reconcile the
arithmetic against the `163 / 2006` baseline. **Measure the after-figure; do not
predict it.** If anything earlier is red, `npm test`'s `&&` means the integration
tier reports nothing at all — run `npx vitest run --project integration`
directly rather than reading a red verify as evidence about that tier.

- [ ] **Step 5: Commit**

```bash
git add src/services/rule-lifecycle.ts src/services/class-template-lifecycle.ts \
        src/services/studio-class-template-lifecycle.ts src/lib/db-locks.ts \
        docs/lock-order.md
git commit -m "docs: what the merge invalidated, verdicted one at a time (issue 336)"
```

Stage exact paths; never `git add -A`.

---

## Self-Review

**Spec coverage.** §2 scope → Tasks 5-6 and the Global Constraints' "#301 is
unaffected". §3.3 descriptor and the no-`TClaimed` rule → Task 5 Step 1 plus a
Global Constraint. §3.3 `standingWhere` → Task 1. §3.4 cross-family import →
Task 2. §3.5 result types stay distinct → Task 5 Step 3 and Task 6 Step 1, both
aliasing rather than merging. §3.6 stop condition → a Global Constraint and
checked twice, Task 5 Step 5 and Task 6 Step 5. §4.1 `TKind` → Task 3, including
the failing-first step that demonstrates the issue's sketch is incomplete. §4.2
`withSlot` → Task 4, with the caveat demonstrated in Step 6 rather than asserted.
§5 the shared pin → Task 6 Steps 3-4. §6 #291 → **not a code task**; it is a
tracker action, carried into the finish (§7 of `solve-issue`) rather than a
plan step. §7 baseline → Task 7 Step 4.

**Type consistency.** `PauseRuleOutcome<TChild>` is the transaction-internal
union; `PauseRuleResult<TChild>` is the public one; each family aliases the
latter. `JoinedRule` is defined once in Task 4 Step 1 and used by Task 4's
`withSlot` and by `ChildWithRule`. `claim`/`generate` take
`ChildWithRule<TChild>` in both the Task 5 interface block and its Step 1 code.
`standingWhere(id, today)` keeps `remainingWhere`'s two-argument signature
throughout.

**Known risk the executor should expect.** Task 6 Step 5's trigger `diff` may
begin matching nothing once both unions become aliases of `PauseRuleResult`.
That is the stale-command failure #332 hit on `db-locks.ts`, and the step says
so rather than letting an empty diff read as a pass.
