# Sweep: skip a template candidate already past its auto-cancel check (#859)

## Problem

The hourly `class-generation` sweep can insert a template class whose
auto-cancel check has already passed. `CLASS_GENERATOR.createChildren`
(`src/services/class-generator.ts`) then stamps `autoCancelDecidedAt` at insert,
so the class is never auto-cancelled: it runs however few book, and the teacher
covers the shortfall. Nobody asked for that class, and nobody is told.

The issue author chose option 2, **prevent**: the sweep, and only the sweep,
declines such a candidate. Create and resume keep #856's warning, because there
the teacher reads the answer.

## Premise check (measured on `origin/main` at `e50f2357`)

- **Held:** the stamp is written at insert when `isPastCancelCheck(entry,
  template.autoCancelCheck, tz, at)` holds (`class-generator.ts`,
  `createChildren`).
- **Held:** the `slot_taken`/`blocked_by_overlap` pre-checks read only live
  entries (`entry-generation.ts`, the `live` filter), so cancelling, deleting or
  moving a blocker frees the date for the next sweep. The blocker has to be
  another rule's entry or a manual one. A cancelled entry of this template's
  own rule still holds both the date (`blocked_by_cancelled`) and the week
  (`already_this_week`).
- **Held:** three paths reach `generateEntriesForRule` for the class family.
  The sweep is `generateClassInstances`, run by `runClassGenerationTick` and the
  operator cron route. Create is `createClassTemplate`. Resume is
  `pauseOrResumeRule` through `CLASS_FAMILY.generate`. The last two go through
  `generateInstancesForTemplate`.
- **Wrong in the issue: "create, resume *and edit* keep #856's warning."** An
  edit inserts nothing. The sweep lays down the edited template's first class
  (#194), so the sweep's new rule applies to it. Today an edit whose first
  candidate is past its check by the next sweep answers `lateFirstClass:
  past_check`. That is pinned by "edit: a first class starting before the next
  sweep is judged at its own start, so it answers past_check"
  (`class-template-lifecycle.test.ts`). Under this change that class is never
  created, so the answer has to stop naming it. That is design question 5, and
  it is not optional.
- **A second route the issue does not name:** the edit itself. If a template
  moves onto a near, free day, the sweep fills a candidate that may already be
  past its check. It is the same mechanism, and the same skip handles it.
- **Held:** `MAX_CANCEL_CHECK_HOURS` is 4 (`CANCEL_CHECK_HOURS`,
  `src/lib/cancel-check.ts`). The smallest check is 1 h, so a check instant is
  always at least an hour before its start.
- **Pinned behaviour this changes:** "stamps the class that starts inside its
  check window and leaves the later ones undecided" (`class-generator.test.ts`,
  #836) drives `generateClassInstances`, which is the sweep. After this change
  that first candidate is not inserted at all. The stamp is still reached from
  create and resume, which "create: a first class inside its check answers
  past_check, stamped at the instant it was judged at" pins.

## Design

### 1. Who opts in: a caller parameter and a family field

There are two independent facts, so each gets its own home:

- **Does this family have a check?** That is a fact about the family, so it
  goes on the descriptor. `GeneratorFamily` gains a required field:

  ```ts
  pastCancelCheck:
    | ((child: TChild, entry: { date: Date; startTime: Date }, timeZone: string, at: Date) => boolean)
    | null;
  ```

  The class family's value wraps `isPastCancelCheck`. The studio family's value
  is `null`, because a `StudioClass` has no deadline or check. It is required
  and nullable, not optional, following the descriptor's own "no field is
  optional" rule and `TemplateFamily.lateFirstClass`'s precedent. The signature
  mirrors `lateFirstClass`'s, so `updateRule` can call it with the child it
  already holds.

  `createChildren`'s stamp calls the same function, so the stamp and the skip
  share one spelling: `CLASS_GENERATOR.pastCancelCheck` is defined once and
  `createChildren` uses it.

- **May this caller decline?** That is a fact about the call, and a descriptor
  cannot express it, because one descriptor constant serves the sweep, create
  and resume alike. `generateEntriesForRule` therefore takes a required
  `caller: GenerationCaller`, where
  `type GenerationCaller = 'sweep' | 'teacher'` lives in `@/lib/generation`.
  The parameter goes before `from`, so nothing can omit it.

  The two families' teacher-path wrappers (`generateInstancesForTemplate`,
  `generateStudioInstancesForTemplate`) pass `'teacher'`, and their signatures
  stay the same, so create, resume and the roughly 75 test call sites are
  untouched. Each family's sweep loop (`generateClassInstances`,
  `generateStudioClassInstances`) calls `generateEntriesForRule` with
  `'sweep'`. The studio sweep passes it too: the rule is "the sweep declines
  what its family says is past its check", and the studio family's `null` is
  what makes it a no-op there. No `if (family.kind === …)` is needed, which is
  the descriptor's stop condition.

### 2. The new skip reason

`SkipReason` gains `'past_cancel_check'`. In the loop it is checked **last**,
after `blocked_by_overlap` and immediately before `free.push`:

```ts
if (caller === 'sweep' && family.pastCancelCheck?.(template, { date, startTime }, tz, at)) {
  skipped.push({ date, reason: 'past_cancel_check' });
  continue;
}
```

It comes last because the reason means "this date was free, and the sweep chose
not to fill it". Every earlier reason is a claim that the date was **not** free,
and is the more useful one to report. A reason that came earlier would also
mask `already_generated` on every steady-state re-run, since the first
candidate in a window is routinely the template's own row, already inside its
check.

**Counting:** `SKIP_REASON_COUNT_MAP.past_cancel_check = null`, so it is
dropped, like `raced` and `already_generated`. Only the sweep emits it, and the
sweep has no teacher-facing answer. A resume runs as `'teacher'` and can never
produce it, so a `SkipCounts` field for it would always be 0. The map is
`Record<SkipReason, …>`, so the compiler forces this placement.
`logSkippedEntries` logs every reason except `already_generated`, so the
declined date reaches the operator's log line with no further change. That
covers the issue's "recorded in the logged skip summary" criterion.

A declined candidate is never filled later. It stays past its check until it
starts, and from then on the window's `start > startDate` filter drops it, so
that template's week stays empty. Each sweep before the start logs it again.
That is at most `MAX_CANCEL_CHECK_HOURS` (4) hourly lines per declined date,
and only for this rare state.

### 3. The instant

`generateEntriesForRule` reads `at` once, **before** the loop rather than after
the insert. The skip judgement, `createChildren`'s stamp and `firstCreated.at`
are then the same instant, with no second spelling. Moving the read earlier
shifts the stamp by the duration of one insert statement. A consequence worth
stating: a class the sweep inserts was judged not past its check at `at`, so
the sweep path never writes the stamp now. Only create and resume can.

As before, `at` is the wall clock, independent of `from`, exactly as the stamp
already was since #856. Tests that pass `from` do not move the judgement.

### 4. The probe agrees

`probeFirstEffectiveWeek` predicts what the sweep fills, so it must decline what
the sweep declines. Otherwise the edit answer names a week, and since #856 a
date, that stays empty: an earlier week than delivered, which is the dishonest
direction the probe's docblock forbids.

- `probeFirstEffectiveWeek` gains a required parameter
  `declines: ((candidate: Date) => boolean) | null`. It removes declined
  candidates exactly as it removes slot-taken ones, before `firstFreeWeek`. A
  declined date loses its week as a consequence, not as a definition. The
  probe stays family-agnostic: the predicate is not a read, and no `kind` filter
  enters the reads.
- `updateRule` builds the predicate from `family.pastCancelCheck`, judged at
  `at = now + CLASS_GENERATION_INTERVAL_MS`. That is the latest instant the next
  nominal sweep runs. If the probe declines a candidate that an earlier sweep
  then fills, the class arrives a week before the answer named it. That is the
  tolerated direction. The reverse, a late sweep declining what the probe named,
  is the nominal-interval imprecision #860 already records. This change does not
  widen it.
- `lateFirstClass` is judged at that same `at`. The `min(now + interval, start)`
  cap goes. For the class family a surviving candidate's check is after `at`,
  and the check is at least an hour before the start, so its start is after
  `at` too, and the cap is unreachable. The studio family's `lateFirstClass` is
  `null`, so the cap never ran there. An edit's answer can therefore no longer
  carry `past_check`. It can still carry `past_deadline`, which the sweep fills
  and auto-cancel still judges.

### 5. #860

For the class family, #860's option 1 now holds as a consequence: a candidate
starting within one interval is past its check by `now + interval`, so the
probe skips it. The studio family has no check and is untouched, so #860 stays
open for it. Its cap criterion is settled here. I comment on #860 saying both.

## Tests (acceptance criteria → pins)

- **Sweep declines** (`class-generator.test.ts`): the #836 describe's single
  test is rewritten. The sweep inserts no class for the candidate past its
  check, reports `past_cancel_check` in the logged skip summary, and still
  fills the later weeks, undecided.
- **Teacher path still inserts:** the existing create test
  (`class-template-lifecycle.test.ts`, "create: … answers past_check, stamped
  …") stays green, unchanged. A new resume test checks that a resume whose
  first candidate is past its check inserts it and answers `past_check`.
- **Studio unaffected** (`studio-class-generator.test.ts`): the studio sweep
  fills a candidate starting within the hour.
- **Uses `isPastCancelCheck` at the generator's `at`, at the boundary:** a
  generator-level test with the clock frozen (`vi.useFakeTimers({ toFake:
  ['Date'] })`) exactly at the candidate's check instant declines it, and 1 ms
  earlier fills it.
- **Probe agrees** (`class-template-lifecycle.test.ts`): the
  "edit: … judged at its own start, so it answers past_check" test is rewritten.
  The edit names the **following** week as `firstEffective` and answers
  `lateFirstClass: null`. A studio counterpart still names the near week.
- **Each guard bites:** the plan carries one mutation per guard, with its
  recorded failure.

## Not done

- **Notify (option 1).** Declined in favour of prevention.
- **The studio half of #860.** It is out of scope here and stays open for #860.
  **#860 is unaffected** beyond the comment.
- **Filling the empty week later.** That is the template's week, and the
  teacher can add a one-off class by hand if they want one.
