# Studio generation becomes week-keyed, and the template edit says so (issue 284)

**Date:** 2026-08-29 · **Issue:** 284 (parent 274) · **Depends on:** #194 (the
rule), #276 (the studio class edit surface), #298/#327/#336 (`ScheduleRule`,
`CalendarEntry`, the shared lifecycle verbs)

Issue 284 is the studio family's share of the rule #194 decided for both
families on 2026-08-20: **a template is a stamp, not a live link**, and
**one class per week per template**. The class family got both halves in #194.
The studio family got the first half by accident — its update function never
propagated — and has never had the second.

---

## 1. What was measured

Everything in this section was re-derived against `main` at `aaa07934`. Where
the issue is wrong, the correction is the useful part.

### 1.1 The issue's instruction names the wrong helper

> "Reuse `startOfLocalWeek(instant, timeZone)` (`src/lib/timezone.ts`)."

`startOfLocalWeek` is the wrong tool, and `class-generator.ts:333` says so in
the code that had to choose:

> `mondayOf` takes a CALENDAR DATE and no timezone, which is what both operands
> are […] `startOfLocalWeek` is the wrong tool here — it resolves an INSTANT
> through `Intl`, and west of UTC it returns the previous day, which for a
> Monday is the previous week.

The shipped predicate is `mondayOf` (`src/lib/timezone.ts:145`). The issue's
second comment corrected this in 2026-08-24; **the issue body was never
edited**, and an implementer reads the body first.

### 1.2 `already_this_week` is not a new `SkipReason`

The issue asks for "a new `SkipReason` beside `already_generated`…". It has
existed since #194: `src/lib/generation.ts:99` declares it with a docblock, and
`SkipCounts` carries `alreadyThisWeek`. The studio PATCH already puts it on the
wire as a structural zero
(`src/app/api/studio-class-templates/[id]/route.ts:234`).

**This issue adds a producer, not a reason.** Thirteen lines across eight files
in `src/` name #284 as the pending producer, plus one in
`docs/technical-architecture.md`:

    grep -rn "#284" src/ docs/*.md | grep -v backlog-roadmap

### 1.3 The week predicate is already extracted; the *construction* is not

The issue's third comment proposed extracting the week predicate "into one
tested helper […] and re-point the two existing class-family call sites at it".
That shipped with #194: `isWeekHeld` (`class-generator.ts:110`) and
`firstFreeWeek` (`:137`) are exported, and both class-family call sites use
them.

What is still hand-copied is the `heldWeeks` **construction** — the bounded
`findMany` plus the `mondayOf` map — which exists twice — `class-generator.ts:339-350` and the probe's own pair at
`class-template-lifecycle.ts:645` (the bounded read) and `:692` (the
`mondayOf` map) — and would become three under a copy.

### 1.4 The two generators differ in six places, and only two are features

Comment-stripped and diffed:

    strip() { perl -0777 -pe 's{/\*.*?\*/}{}gs' "$1" | sed -E 's://.*$::' | grep -v '^[[:space:]]*$'; }
    strip src/services/class-generator.ts        > /tmp/cg.txt
    strip src/services/studio-class-generator.ts > /tmp/scg.txt
    awk '/^export async function generateInstancesForTemplate/,/^}$/'       /tmp/cg.txt  > /tmp/a
    awk '/^export async function generateStudioInstancesForTemplate/,/^}$/' /tmp/scg.txt > /tmp/b
    diff -u /tmp/a /tmp/b

**147 comment-free lines against 100**, differing in exactly six places:

| # | Difference | Kind |
|---|---|---|
| 1 | the empty-window guard and its `log.warn` | **feature, missing from studio** |
| 2 | the `heldWeeks` read and the `isWeekHeld` branch | **feature, missing from studio** |
| 3 | `kind: 'regular'` vs `'studio'` (insert, and the `slot_taken` filter) | family |
| 4 | the child insert payload (`Class`: ten fields + `status`; `StudioClass`: `location`, `hourlyRate`) | family |
| 5 | `logSkippedSlots` vs `logSkippedStudioSlots` | family (noun only) |
| 6 | the function name and its parameter type | family |

The same treatment of `claimTemplateForGeneration` (`:740`) against
`claimStudioTemplateForGeneration` (`studio-class-generator.ts:74`) gives
**23 comment-free lines each**, differing only in the table identifier spliced
into the raw `FOR UPDATE` and one log noun.

**The absences are coupled, not merely adjacent.** The week read derives its
bounds from `dates[0]` and `dates[dates.length - 1]`; under
`noUncheckedIndexedAccess` the studio generator — which today never indexes
`dates` — cannot take the week key without also taking the empty-window guard.

### 1.5 Acceptance bullets 1 and 4 are already satisfied

- **"Editing a studio template leaves every already-generated `StudioClass`
  byte-identical"** is already true and always was: that function never
  propagated. It gains a test on this branch; it does not gain behaviour.
- **"The `No instance sync` docblock is rewritten"** was discharged on #194's
  branch (`studio-class-template-lifecycle.ts:539`). What it now says —
  *"What this family still owes #194 is tracked on #284"* — is what **this**
  branch invalidates.

### 1.6 Rule 4's stated blocker is gone, and its copy cannot be shared verbatim

`updateStudioClassSchema` (`src/lib/schemas.ts:482`) carries `date` and
`classType` since #276, so the issue's "Blocked by #276" no longer holds.

But the surface #276 shipped is **narrower than the class family's**, and it is
narrower in exactly the field a day-edit makes a teacher reach for:

- `studioClassEditability` (`src/services/studio-class-editability.ts:106`):
  `dateEditable ⟺ notPast && scheduleRuleId === null`. A **generated** studio
  class's date cannot move at all — gate 2 in
  `src/app/api/studio-classes/[id]/route.ts:131` refuses it, because moving it
  frees `(scheduleRuleId, date)` and the sweep recreates the class on the old
  date within the hour.
- The class family has no such gate: `updateClass` lets a generated class move
  and only refuses on collision
  (`class-lifecycle.ts:1584`, `template_date_conflict`).

So the class family's tail sentence — *"Change existing classes individually if
needed."* — over-promises for studio. Cancelling is the remedy that does exist.

Two further divergences in the same function: `templateUpdatedMessage`'s
`paused` and `archived` arms name the family (*"this **recurring class** is
paused"*), and studio copy calls the thing a *template*
(`UNARCHIVE_STUDIO_MESSAGE`). The `resumeStudioMessage` delegation pattern the
issue points at therefore does **not** apply unchanged: these sentences are not
word-for-word identical.

### 1.7 The sweeps' asymmetry is test-only

`generateClassInstances(db, from?, teacherId?)` takes a teacher scope its
studio twin lacks. **No production caller passes it** — the cron route
(`api/cron/generate-classes/route.ts:13`) and the scheduler
(`lib/scheduler.ts:219`) both pass only `prisma`; all eight call sites that
pass a `teacherId` are in `class-generator.test.ts`.

### 1.8 One operator-facing string is not parallel today

`logSkippedSlots` logs `'class generation could not fill every date in the
window'` while that family's `TemplateFamily.logNoun` is `'recurring class'`.
The studio twin logs `'studio class generation could not fill…'`, which does
match its noun. Composing the shared message from `logNoun` therefore changes
the class family's line to `'recurring class generation could not fill…'`. No
test asserts either string (checked across `src/**/*.test.ts*`).

---

## 2. The decision

1. **The two per-template generators become one**, parameterised by a family
   descriptor. The studio family gains the week key and the empty-window guard
   **by construction** rather than by a third hand-copy.
2. **The two `claim*` functions become one** on the same descriptor.
3. **The sweeps stay as they are** — the pair with the least duplicated logic
   and the one real asymmetry (§1.7) to decide.
4. **Rule 4 ships**, with `probeFirstEffectiveWeek` extracted rather than
   copied.
5. **One tail sentence for both families**: *"Change or cancel existing classes
   individually if needed."*

The reasoning for 1–2 is that the studio family did not lose the week rule
through a decision — it lost it by being a copy that never received it. A
shared function cannot have that failure mode; a fourth copy can.

---

## 3. Design

### 3.1 Module boundary

A new `src/services/entry-generation.ts` — the entry layer's twin of what
`rule-lifecycle.ts` is for the template layer, and the lower of the two:

| Symbol | Origin | Change |
|---|---|---|
| `JoinedRule`, `ChildWithRule<TChild>` | `rule-lifecycle.ts:24,30` | move (zero fan-out: no other file imports them) |
| `DEFAULT_WEEKS`, `getNextOccurrences`, `isWeekHeld`, `firstFreeWeek` | `class-generator.ts:34,49,110,137` | move, no edit |
| `GenerationLogNoun` = `'recurring class' \| 'studio class'` | new | one union, three consumers |
| `GeneratorFamily<TChild, TKind>` | new | the dispatch table |
| `generateEntriesForRule` | merge of both per-template generators | |
| `claimRuleForGeneration` | merge of both `claim*` | |
| `logSkippedEntries` | merge of `logSkippedSlots` + `logSkippedStudioSlots` | |
| `probeFirstEffectiveWeek` | `class-template-lifecycle.ts:627` | move + an `editNoun` (§3.7 — **not** `logNoun`) |

`probeFirstEffectiveWeek` moves **beside the generator it predicts**. Its whole
job is to reproduce that generator's grounds; co-locating them means a change
to one is read against the other. It also takes 194 lines — `:545`-`:738`,
docblock included; the body alone is 112 — out of a 1,685-line file.

Import direction is one-way: `entry-generation.ts` ← `rule-lifecycle.ts` and
both generator files; the lifecycle files reach it through them. No cycle
exists to break, and the plan verifies that rather than asserting it.

### 3.2 `GeneratorFamily`, and how it relates to `TemplateFamily`

`TemplateFamily` (`rule-lifecycle.ts:136`) already carries four of the five
fields generation needs — `kind`, `logNoun`, `childTable`, `readChildOrThrow`.
So the new type is a **split of the existing one**, not a parallel copy:

```ts
// entry-generation.ts
export type GeneratorFamily<TChild, TKind extends ClassFamily = ClassFamily> = {
  kind: TKind;
  logNoun: GenerationLogNoun;
  childTable: Extract<Prisma.ModelName, 'ClassTemplate' | 'StudioClassTemplate'>;
  readChildOrThrow: (tx: TransactionClientOnly, templateId: string) => Promise<ChildWithRule<TChild>>;
  /** The family's own child rows, keyed to the entries that actually landed. */
  createChildren: (
    db: PrismaClient | Prisma.TransactionClient,
    template: ChildWithRule<TChild>,
    entries: readonly { id: string; date: Date }[],
  ) => Promise<void>;
};

// rule-lifecycle.ts
// illustrative — the remaining fields keep their current signatures verbatim
export type TemplateFamily<TChild, TKind extends ClassFamily = ClassFamily> =
  GeneratorFamily<TChild, TKind> & { readChild: …; deleteWhere: …; standingWhere: …; withSlot: …; claim: …; generate: …; withdraw: … };
```

Each family declares those four fields **once**. The generator file owns the
`GeneratorFamily` const (where the child insert payload naturally lives) and
the lifecycle file spreads it into its `TemplateFamily`:

```ts
// class-generator.ts
export const CLASS_GENERATOR: GeneratorFamily<ClassTemplate, 'regular'> = { … };
export const claimTemplateForGeneration = (tx, id) => claimRuleForGeneration(tx, CLASS_GENERATOR, id);
export const generateInstancesForTemplate = (db, t, from?) => generateEntriesForRule(db, CLASS_GENERATOR, t, from);

// class-template-lifecycle.ts
export const CLASS_FAMILY: TemplateFamily<ClassTemplate, 'regular'> = {
  ...CLASS_GENERATOR,
  readChild, deleteWhere, standingWhere, withSlot, claim: claimTemplateForGeneration,
  generate: generateInstancesForTemplate, withdraw,
};
```

`TemplateFamily` keeps `claim` and `generate`. They could be dropped — both are
now the shared functions bound to the descriptor `pauseOrResumeRule` already
holds — but keeping them preserves that type's stated property that "each
family's entry is complete on its own", and dropping them would churn eight
comment sites for no behavioural gain. **Considered and rejected**, recorded so
a reviewer need not re-derive it.

Every currently-exported name survives as a thin adapter. This is the shape
#336 shipped: `pauseOrResumeStudioTemplate` still exists over
`pauseOrResumeRule`. Existing imports, and the many comments naming these
functions, stay correct.

### 3.3 The merged generator

`generateEntriesForRule` is today's `generateInstancesForTemplate` with three
substitutions — `family.kind` for the `'regular'` literal (insert **and** the
`slot_taken` filter), `family.createChildren` for the `db.class.createMany`
block, and `family.logNoun` for the two log messages. Nothing else changes for
the class family.

The studio family thereby gains, with no studio-specific code:

- the empty-window guard and its warn, now
  `'${logNoun} generation found no candidate dates because their start instants could not be read'`;
- the week read (keyed on `scheduleRuleId`, bounded by the window's own first
  and last weeks, **no liveness filter** — a cancelled entry holds its week)
  and the `isWeekHeld` branch, producing `already_this_week`.

**Branch order is load-bearing and stays as the class family pins it:** the
own-date branch first (so a steady-state re-run reports `already_generated`,
not `already_this_week` — the two land in different `SkipCounts` fields and
reach the teacher as different clauses), then the week branch, then
`slot_taken` and `blocked_by_overlap`. The class family's comment states which
half of that order is pinned by a test and which is a reporting preference;
that distinction is preserved verbatim in the merged function.

### 3.4 The merged claim

`claimRuleForGeneration(tx, family, templateId)` splices `family.childTable`
into the raw `SELECT … FOR UPDATE OF` and calls `family.readChildOrThrow` for
the second, Prisma-typed statement. The studio file's docblock currently argues
against this — *"a generic version would have to interpolate the table name
into raw SQL"* — and that objection has been overtaken by its own codebase:
#336 shipped exactly that interpolation for the archive and pause row locks,
compiler-tethered by `childTable`'s `Extract<Prisma.ModelName, …>` and pinned
by a `@ts-expect-error` in `rule-lifecycle.test.ts`. **The docblock is rewritten
to state what is true now**, not annotated with what it used to claim.

The alias in the raw statement becomes a fixed `c` for both families rather
than `ct`/`sct`; only the table identifier varies.

### 3.5 Rule 4

`updateStudioClassTemplate` mirrors `updateClassTemplate` step for step:

1. widen its head read to
   `include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } }`
   (today: `include: { scheduleRule: true }`) — the horizon needs the zone;
2. hoist `updated` / `updatedRule` out of the `$transaction`, so the probe sits
   **outside the `catch`** — otherwise a transient failure of a read-only probe
   maps to `busy` ("nothing was changed") about an edit that already committed;
3. build the horizon: `getNextOccurrences(rule.dayOfWeek, now, DEFAULT_WEEKS * 2)`
   filtered by the same past-start test the generator applies;
4. `const generationState = templateGenerationState(updatedRule)`, and run the
   probe only when it is `'active'`;
5. return `firstEffective` and `generationState` beside `template`.

`UpdateStudioClassTemplateResult`'s `ok: true` arm gains both fields, carrying
across the reasoning the class family's arm documents: `null` has two causes,
which is why `generationState` is a field rather than an inference, and the
value is a **Monday**, converted in the service because `mondayOf` lives in a
pino-importing module and the copy layer is value-imported by a `'use client'`
component.

The PUT (`api/studio-class-templates/[id]/route.ts`) serializes them exactly as
the class route does. `studio-template-form.tsx:228` replaces
`setSuccess('Saved')` with the rendered sentence, parsing the wire shape the way
the class form does — untrusted JSON, `generationState` validated against the
three literals rather than cast.

### 3.6 The copy

`templateUpdatedMessage` gains a noun parameter — `'recurring class' | 'template'`,
the pair this file already differs by at `UNARCHIVE_MESSAGE` /
`UNARCHIVE_STUDIO_MESSAGE`, whose own docblock names it (§3.7) — and serves
both families. The shared tail becomes:

> Change **or cancel** existing classes individually if needed.

Three words added to #194's shipped class copy, so that one sentence is true
for both families rather than two sentences having to agree. It is true for the
class family too — cancelling has always been available there — and it is the
only remedy the studio family has for a generated class sitting on the old day.

Rendered studio sentences:

| state | sentence |
|---|---|
| `active`, week known | Template updated. It takes effect for newly generated classes — your first class on the new schedule is the week starting Mon 21 Sep. Change or cancel existing classes individually if needed. |
| `active`, no free week | Template updated. It takes effect for newly generated classes. Change or cancel existing classes individually if needed. |
| `paused` | … — this template is paused, so nothing is generated until you resume it. … |
| `archived` | … — this template is archived, so nothing is generated until you un-archive and resume it. … |

The `never`-default exhaustiveness switch stays.

---

### 3.7 Three noun vocabularies, and why they stay three

This branch touches all three. They are measured, not remembered, and a
reviewer's instinct to unify them would make each new line the odd one out in
its own file:

| Vocabulary | Values | Where it lives | Example |
|---|---|---|---|
| **Generation log** | `'recurring class'` / `'studio class'` | `TemplateFamily.logNoun` | `'studio class generation could not fill every date in the window'` |
| **Edit-path log** | `'recurring class'` / `'studio template'` | each lifecycle service's own lines | `'studio template edit refused: that slot is taken'` (5 lines) |
| **Teacher-facing copy** | `'recurring class'` / `'template'` | `template-action-messages.ts` | `UNARCHIVE_STUDIO_MESSAGE`: *"This template is paused"* |

Re-derive with:

    grep -rhn "edit refused\|edit lost a lock race\|edit saved" src/services/*.ts
    grep -n "is paused" src/components/settings/template-action-messages.ts

So `probeFirstEffectiveWeek`'s warn — *"… edit saved, but the
first-effective-week probe failed"* — takes the **edit** noun and would read
wrong composed from `logNoun`; and `templateUpdatedMessage` takes the **copy**
noun, which is the pair its own file's docblock already records ("the two
differ only in the noun (\"recurring class\" vs \"template\"), matching each
family's own copy").

Only the first of the three becomes shared machinery on this branch. The other
two are parameters passed at their single call sites.

---

## 4. What changes for a teacher, and for an operator

**Teacher, studio family.** Moving a studio template Tuesday → Thursday stops
producing four Thursdays beside four standing Tuesdays. The standing Tuesdays
are untouched — that is #194's rule, unchanged — and the first Thursday lands
in the first week holding none of that template's classes, which is week five
when the four standing Tuesdays occupy weeks one to four. The PUT names that
week. The resume confirmation's existing "N dates are still held by classes on
your previous day" clause becomes reachable for this family for the first time,
with no copy change: the count already rides the wire as a zero.

**Teacher, class family.** One sentence gains two words. Nothing else.

**Operator.** `'class generation could not fill every date in the window'`
becomes `'recurring class generation could not fill…'` (§1.8). A grep on the
old string finds nothing after this branch.

**Interaction with #279, and the acceptance its spec asked for.** Removing a
**past generated** studio class now frees that class's week, so the sweep can
fill a still-future candidate date in the same week that was previously skipped
as `already_this_week`. That is the week rule working as specified — worked
through in `2026-08-21-studio-class-deletion-design.md` §5 — and it becomes
observable for the first time here. It gets a test, and
`studio-class-deletion.ts:93`'s "AS SPECIFIED, NOT AS IMPLEMENTED" paragraph is
rewritten to state it as shipped behaviour.

---

## 5. What this does not do

- **The two sweeps are unaffected.** `generateClassInstances` and
  `generateStudioClassInstances` stay two functions, with the `teacherId`
  asymmetry of §1.7 left standing and measured. Whether that parameter should
  survive at all is a separate question this branch does not answer.
- **Stage C2's `update` merge is not attempted.** This branch decides the
  question that merge is blocked on — whether the studio family gains the
  first-reachable-week machinery — by shipping it. The two `update` functions
  keep their own field allowlists, forbidden lists and room validation.
- **The studio class `date` gate is left exactly as #276 shipped it.** The copy
  is made honest about it rather than the gate being widened.
- **#205 is unaffected.** The week read is keyed on `scheduleRuleId` and rides
  `@@unique([scheduleRuleId, date])`; #205 is about `(teacherId, date)` on a
  different read. The issue's own "Interaction with #205" section is wrong and
  was corrected on the issue in 2026-08-21.

---

## 6. Acceptance → coverage

| Acceptance (issue 284) | How it is proved |
|---|---|
| An edit leaves every generated `StudioClass` byte-identical | New test: snapshot every entry+child column before a `dayOfWeek`+`startTime` edit, compare after. Already true; now pinned. |
| No studio class is generated into a week that already holds one from that template, cancelled included | Generator tests: four standing Tuesdays, template moved to Thursday, all four candidates reported `already_this_week`; and the same with the week-2 Tuesday cancelled. |
| The first class on the new day lands in the first week holding none | Generator test at a horizon where week 3 is free; plus the probe's own test. |
| The PUT's response names that week by date | Service test on `firstEffective`; route test on the serialized ISO string; copy test on the rendered sentence. |
| The docblock states the behaviour as intended | Already done (§1.5); this branch removes the "still owes #284" clause. |
| (#279's addition) What removing a past generated class does to its week | Test: remove a past generated class, run the sweep, assert a still-future candidate in that week is now filled. |

---

## 7. Mutations — each must fail, with the error text recorded

1. **Break `isWeekHeld`** (`return false`) → **both** families' suites go red.
   This is the mutation the issue's third comment asked for by name: it proves
   the extraction is load-bearing rather than decorative.
2. **Delete the `heldWeeks` read** from the merged generator → both generator
   suites red.
3. **Reverse the own-date and week branches** → the `already_generated`
   steady-state test goes red for both families (it is pinned in the class
   family today; the merge puts the studio family behind the same pin).
4. **Add a liveness filter to the week read** (`cancelledAt: null`) → the
   cancelled-holds-its-week test goes red for both families.
5. **Return the candidate date instead of its Monday** from the probe → the
   studio and class message tests both go red on the rendered day.
6. **Point the studio family's copy noun at `'recurring class'`** → the studio
   message test goes red on the noun; and separately, **point its `logNoun` at
   `'recurring class'`** → the studio skip-log test goes red. Two nouns, two
   mutations, because §3.7 says they are two things.
7. **Drop `generationState` from the studio result** and infer from
   `firstEffective` → the paused/archived message tests go red.
8. **Splice the wrong `childTable`** into the merged claim → the family whose
   table was taken fails its claim test.

Every mutation is applied against a **warmed** route where it touches HTTP:
`next dev` recompiles lazily and a cold first request can blow a 5s timeout,
which reads exactly like an assertion failure (#290).

---

## 8. The sweep this branch owes

Derived from what it **invalidates**, not from what it edits (#315's lesson).
Objects that stop existing or stop being true:

- `logSkippedSlots`, `logSkippedStudioSlots`, and the string
  `'class generation could not fill every date in the window'`;
- `generateStudioInstancesForTemplate`'s and
  `claimStudioTemplateForGeneration`'s docblocks, both of which argue for the
  copies this branch removes;
- every claim that the studio family produces no `already_this_week` — thirteen
  lines across eight files in `src/`, plus `docs/technical-architecture.md:317`
  and CLAUDE.md's "it does **not** yet key generation per week … #284 carries
  that half";
- `studio-class-deletion.ts:93`'s "AS SPECIFIED, NOT AS IMPLEMENTED";
- `studio-class-template-lifecycle.ts:546`'s "what this family still owes #194
  is tracked on #284";
- `studio-template-form.tsx:173`'s "a gate term that can never fire" argument,
  which needs re-verdicting rather than rewriting: the reason becomes reachable
  on **resume**, and the comment's own claim is that it stays unreachable on
  **create**. That claim is still true and the comment must not be blanket-
  rewritten.

Each hit gets its own verdict. Legitimate survivors are expected.
