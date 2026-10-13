# Template save answer: the first class inside its cancellation deadline (#849)

## Problem

The generator inserts an `open` class whatever its distance from the start.
When the class is already inside its cancellation deadline, students who book it
cannot cancel free; when it is also past its auto-cancel check, the generator
stamps `autoCancelDecidedAt` at insert (`class-generator.ts`, the
`isPastCancelCheck(...)` field) and the class goes ahead however few book, the
teacher covering the shortfall. #840 (publishing late) and #847 (moving late)
warn about this state; the template paths do not.

#847 recorded the template decision as option (c), skip the candidate. The issue
author changed it to option **(b)** on 2026-10-13: tell the teacher in the
template's save answer, and leave the generator's rules as they are.

## Premise check (measured on `origin/main` at `712d62b3`)

- **Held:** the generator stamps the marker at insert when the check has passed.
- **Held: three paths the teacher acts on and gets an answer from**, and no
  more. Unarchive forces `isActive: false` and generates nothing; room archive
  generates nothing; `/api/cron/generate-classes` is an operator endpoint.
  - **Create** (`createClassTemplate`, `class-template-lifecycle.ts`) generates
    its first window inside its own transaction.
  - **Resume** (`pauseOrResumeRule`, `rule-lifecycle.ts`, the `active` arm)
    generates inside its transaction too.
  - **Edit** (`updateRule`) creates nothing; the hourly `class-generation`
    sweep (`scheduler.ts`, `intervalMs: 60 * MINUTE`) lays the first reachable
    week down later (#194). Every PUT runs the probe, not only one that moves
    the schedule.
- **Wrong in the issue:** "routine sweeps never land inside a deadline". A
  candidate skipped as `slot_taken` or `blocked_by_overlap` becomes fillable
  once its blocker stops being live (`entry-generation.ts`, the `live` filter):
  cancel, delete or move the blocking class and the next sweep can insert the
  template's class inside its deadline, with no save answer to carry a warning.
  Out of scope here; see *Not done*.
- **Held:** `GenerationResult` is `{ created; skipped }` and carries no date, so
  create and resume cannot name the class today.
- **Held:** `probeFirstEffectiveWeek` finds the candidate DATE (`free`) and
  returns only its Monday, so the edit path cannot either.
- **Held:** on a clean window the create form navigates to the recurring list
  with no sentence (`template-form.tsx`, the `anyBlocked` gate), so a warning on
  that path needs the form to stay.
- **Held:** both template families share the generator, the probe and the
  lifecycle functions; only the regular family has a deadline.

## Design

### The state, computed once, on the server

`src/services/late-first-class.ts` (new):

```ts
export function lateFirstClass(args: {
  template: { cancelDeadline: CancelDeadline; autoCancelCheck: AutoCancelCheck; minStudents: number };
  entry: { date: Date; startTime: Date };   // @db.Date calendar date + @db.Time
  timeZone: string;
  at: Date;
}): LateFirstClass | null
```

It is `classStartInstant` → `latePublishInstants` → `latePublishState`, the
chain the class overview page uses (the edit form reads its start through the
client-safe `readClassStart` instead), so there is no second spelling of any
instant. `none` maps to `null`.

The computation is a service: `classStartInstant` imports the server logger.
The type and its wire guard live in `src/lib/late-publish.ts`, which is
client-safe, because the forms read them:

```ts
export type LateFirstClassState = Exclude<LatePublishState, 'none'>;
export interface LateFirstClass { date: string; state: LateFirstClassState; minStudents: number }
export function isLateFirstClass(value: unknown): value is LateFirstClass
```

`date` is the `YYYY-MM-DD` calendar date (`toISOString().slice(0, 10)` of the
UTC-midnight `@db.Date`). `minStudents` rides along because the resume button,
unlike the form, has no form values to read it from.

### Which class, and at what instant

| Path | Class | `at` |
|---|---|---|
| Create | earliest entry this generation inserted | the instant the generator stamped with |
| Resume | earliest entry this resume's generation inserted | the instant the generator stamped with |
| Edit | the probe's candidate date | `min(now + CLASS_GENERATION_INTERVAL_MS, start)` |

**Create and resume report a class that exists, judged at the generator's own
instant.** `CLASS_GENERATOR.createChildren` stamps `autoCancelDecidedAt` from an
instant. A separate `new Date()` read after the transaction could disagree with
that stamp by up to a transaction's length, and promise "goes ahead however few
book" about a class the auto-cancel sweep will still judge. So
`generateEntriesForRule` reads the instant once, hands it to `createChildren`
(which stamps with it), and returns it. Only a class this action inserted is
named: a resume that inserts nothing answers `null`, since an existing class
inside its deadline was not put there by the resume.

**Edit predicts one, and errs toward warning.** The sweep nominally inserts the
candidate within the next interval — nominally, because a tick is dropped while
the previous run is in flight and a lock-contended template waits a sweep, so
the interval is not a bound. Judging at save time would stay silent about a
candidate that crosses its deadline before the sweep reaches it, promising no
problem where there is one. Judging at the nominal insert instant can warn
about a candidate that still lands in time, which is why the copy says "may"
and never "will". The `min(…, start)` keeps a candidate starting inside the
interval from reading `none` (`latePublishState` answers `none` once its `now`
is past the start): inserted before its start, it is past every deadline and
check. `updateRule`'s horizon already guarantees the candidate's start is
after `now`.

`CLASS_GENERATION_INTERVAL_MS` moves out of `scheduler.ts`'s inline literal
into `src/lib/generation.ts` (import-free; a numeric constant keeps it so), and
the scheduler entry uses it, so the sentence and the sweep cannot disagree
about the interval.

### Plumbing

- **`GenerationResult` gains `firstCreated: { date: Date; startTime: Date; at:
  Date } | null`** — the earliest row in the generator's `inserted` (an explicit
  minimum: `RETURNING` order is not guaranteed) and `at`, the instant passed to
  `createChildren`. Weekly spacing (7 d) exceeds the widest deadline (48 h), so
  at most one inserted class can be late, and it is this one. Family-agnostic;
  the studio family carries it and ignores it.
- **`GeneratorFamily.createChildren` takes that instant** as a fourth
  parameter; the class family stamps with it instead of its own `new Date()`.
- **`probeFirstEffectiveWeek` returns `{ week, candidate } | null`.** `week` is
  the Monday the answer has always been; `candidate` is `free`. Its only
  production caller is `updateRule`.
- **`TemplateFamily` gains `lateFirstClass: ((child: TChild, entry: { date:
  Date; startTime: Date }, timeZone: string, at: Date) => LateFirstClass | null)
  | null`**, beside `withdraw` and `room` under the same no-optional-field
  rule. `CLASS_FAMILY` supplies a function over the service; `STUDIO_FAMILY`
  supplies `null`, which is how studio templates show nothing. Three callers,
  one spelling:
  - `createClassTemplate`, **inside** its transaction, where the joined
    `created` still carries the zone and the `@db.Time` start;
  - `pauseOrResumeRule`'s `active` arm, with `claimed`'s zone (the same read
    its generation filtered against). `PauseRuleOutcome`'s `active` arm and the
    post-transaction `switch` carry the field out;
  - `updateRule`, when `generationState` is `active`, with the updated child,
    the probe's candidate, and the zone its horizon was built from.

### Wire

- `TemplateCreateResponse` gains `lateFirstClass: LateFirstClass | null`;
  `StudioTemplateCreateResponse` stops being an alias and keeps `{ added;
  counts }`.
- `TemplateToggleResponse`'s `active` arm gains `lateFirstClass`;
  `StudioTemplateToggleResponse` is unchanged.
- The class PUT answers `TemplateEditResponse & { lateFirstClass }`; the studio
  PUT is unchanged.

The studio edit and resume SERVICE results share the generic result types, so
they carry `lateFirstClass: null`; the studio routes pick their fields by name,
so nothing of it reaches the studio wire.

The client narrows the field with `isLateFirstClass`. A present but malformed
value is logged with `console.warn` and shows no notice: the save itself
succeeded, and the field is advisory.

### Copy

`LateFirstClassNotice({ late, when: 'added' | 'expected' })`
(`src/components/settings/late-first-class-notice.tsx`), styled as
`LatePublishNotice`. The shortfall sentence ("If fewer than N students book,
you cover what the missing students would have paid.", singular for 1) is
extracted from `LatePublishNotice` into one exported function both use, so the
`publish` and `move` copy stays byte for byte. `{date}` is
`formatDayHeader` of the date.

- added, `past_deadline`: "Your first class, on {date}, starts inside its
  cancellation deadline. Students who book it can't cancel for free. You can
  cancel it from your schedule."
- added, `past_check`: "Your first class, on {date}, starts inside its
  cancellation deadline and past its auto-cancel check. Students who book it
  can't cancel for free, and the class goes ahead however few book.
  {shortfall} You can cancel it from your schedule."
- expected, `past_deadline`: "Your first class on the new schedule, on {date},
  may be added after its cancellation deadline has passed. Students who book it
  then can't cancel for free."
- expected, `past_check`: "Your first class on the new schedule, on {date},
  may be added after its cancellation deadline and auto-cancel check have
  passed. Students who book it then can't cancel for free, and it may go ahead
  however few book. {shortfall}"

### Where it shows

- **Create form:** stays on the page when `anyBlocked(counts)` **or**
  `lateFirstClass !== null`; the success sentence is `resumeMessage(added,
  added, counts)` as today, and the notice sits under it.
- **Edit form:** the notice sits under the `templateUpdatedMessage` sentence.
- **Resume button:** the notice sits under the resume sentence, from a second
  piece of state; `resolveTemplateConfirmation` stays `string | null`, since
  the archive button shares it.

An economics-only PUT can carry the warning too. That is correct: the deadline
is an economic field, and the next class takes the template's new value.

### Comments and docs this falsifies

Each is rewritten to state what is true after the change:
`resolveStudioConfirmation`'s docblock and `template-form.tsx`'s create-gate
comments (the class create form no longer navigates on every clean window);
`probeFirstEffectiveWeek`'s docblock and its "converted to the WEEK's Monday"
comment; `updateRule`'s `firstEffective` note; `StudioTemplateCreateResponse`'s
docblock; `docs/technical-architecture.md`'s description of the PUT's probe;
CLAUDE.md's "template is a stamp" bullet, which says what the edit answers.

## Not done

- No pre-save notice. A client-side guess cannot see weeks the template already
  holds or overlapping entries; on edit the first candidate's week is usually
  held (#194), so a live notice would often name the wrong class.
- No warning when a sweep fills a candidate whose blocker was cancelled, deleted
  or moved (*Premise check*). No save answer carries it, and the place to say
  it — the action that freed the slot, or the class page — is a separate
  design.
- A candidate starting before the next sweep can reach it may never be created;
  the edit answer names it anyway. `firstEffective` has the same imprecision at
  week granularity today; this change does not widen it.
- No change to the generator's rules: an inside-deadline candidate is still
  generated.
- No notice for studio templates.
- The #847 spec's "Template path: decided (c)" section records the decision as
  it stood then; it gains one line pointing here.
