# A template is a stamp, not a live link (#194)

**Issues:** #194 (primary). Moots #257 and #233; corrects a claim this branch's own
author put in #284.
**Date:** 2026-08-20
**Branch:** `fix/194-template-stamp-not-link`

---

## 1. The premise, measured

Every claim below was checked against the code on `main` at `5db8dca`, not inherited
from the issue. Three of #194's load-bearing claims hold, **one is wrong and it is
mine**, and two facts the issue does not mention grow its scope.

### 1.1 HOLDS — one production call site

`syncTemplateInstances` is called from exactly one non-test site:
`src/services/class-template-lifecycle.ts:477`, inside `updateClassTemplate`'s
transaction. Both `template-sync.ts`'s own docblock and
`api/class-templates/route.ts` already say so from their respective sides.

### 1.2 HOLDS — `refilled` has one producer, so #233 dies with it

`refilled` is written at `template-sync.ts:247` and read at
`template-form.tsx:364` and `:368`. Nowhere else. The resume and create paths
report `added`/`scheduled`/`blockedByCancelled`/`slotTaken` and never `refilled`.
So #233's ambiguity ("created nothing" vs "never ran") cannot survive the deletion
— there is no refill left to have run or not run.

### 1.3 HOLDS — `sync_conflict` is separable from `slot_conflict`

`UpdateClassTemplateResult` carries both. `slot_conflict` is the template's own
`ClassTemplate_teacher_slot_unique`; `sync_conflict` (→ `TEMPLATE_SYNC_SLOT_CONFLICT`,
`api/class-templates/[id]/route.ts:111-115`) is the *refill* hitting
`Class_teacher_slot_unique`. Only the second goes. `slot_conflict`, `room_archived`,
`invalid_room`, `not_found`, `forbidden`, `no_fields` and `busy` all stay.

### 1.4 WRONG — `startOfLocalWeek` is the wrong primitive, and #194 says to use it

Issue #194 instructs: *"Reuse `startOfLocalWeek(instant, timeZone)`."* That is a
defect, and `src/lib/timezone.ts`'s own module header states the rule it breaks:

>   - A `@db.Date` column is a *calendar date*, stored at midnight UTC. Read it with
>     UTC accessors.
>   - A `new Date()` is an *instant*. Run it through `startOfLocalDay` (or
>     `startOfLocalWeek`) before comparing it against a calendar date.

`startOfLocalWeek` delegates to `startOfLocalDay`, which runs its argument through
`Intl.DateTimeFormat` in the target zone. A `Class.date` is **already** a UTC-midnight
calendar date. Feeding one in reads that instant in the teacher's zone, and west of
UTC — `America/Los_Angeles`, where UTC midnight is 16:00 or 17:00 the previous day —
it returns the **previous calendar day**, which for a Monday class is the **previous
week**.

The correct primitive is pure UTC arithmetic and already exists: `mondayOf()`, private
at `src/components/schedule/class-list.tsx:30`, which `weekLabel` uses on
`item.data.date`. `class-list.tsx` is in fact the worked example of the whole
distinction — it calls `mondayOf(itemDate)` on the calendar date (no timezone) and
`startOfLocalWeek(now, timeZone)` on the instant, in the same function.

**Consequence: week-keying needs no timezone at all.** Both operands are calendar
dates, and `getNextOccurrences` (`class-generator.ts`) builds its candidates with
`Date.UTC(...)` and `setUTCDate`, so they are calendar dates too.

### 1.5 UNDESCRIBED — the occupancy query structurally cannot see the old day

`generateInstancesForTemplate`'s single occupancy read is:

```ts
const occupants = await db.class.findMany({
  where: { teacherId: template.teacherId, date: { in: dates } },
  select: { templateId: true, date: true, startTime: true, status: true },
});
```

`date: { in: dates }` is scoped to the four candidate dates. After a Tuesday→Thursday
edit the candidates are Thursdays and the blocking classes are on Tuesdays, so this
read **cannot return them at any filter setting**. Week-keying is a second read, not
an adjustment to this one. The issue describes it as though the existing check could
be widened; it cannot.

### 1.6 UNDESCRIBED — the deletion reaches five artifacts the issue does not list

Beyond the files #194 enumerates:

| Artifact | Stale claim |
|---|---|
| `docs/lock-order.md` (1074 lines) | **11** references to `syncTemplateInstances`, including published probe results — *"120 of 120 for `syncTemplateInstances` vs `updateClass`"*. An entire participant leaves the lock graph. |
| `docs/technical-architecture.md:269` | names sync among `generateInstancesForTemplate`'s four call sites |
| `src/lib/generation.ts` docblock | lists `template-sync.ts` among the five server-only modules that value-import it |
| `api/class-templates/[id]/route.ts:118-125` | *"an ordinary booking holding one of this template's future classes, since the edit's transaction now takes those too via `syncTemplateInstances`'s ordered pre-lock"* |
| `UpdateClassTemplateResult.room_archived` docblock | justifies door 5 partly by *"`syncTemplateInstances` relocates every future non-`settingsLocked` `draft`/`open` instance onto the target room in the same transaction"* |

### 1.7 The safety news is good

After the deletion, `updateClassTemplate`'s transaction is `setLockTimeout(tx)` plus
one `classTemplate.update`. **It takes no `Class` row locks at all**, so the edit path
leaves the deadlock graph entirely — a strict improvement, not a coverage loss.

Of the three tests in `template-lock-order.test.ts`, exactly one is sync's
(*"syncTemplateInstances (ordered pre-lock) vs deleteStudentAccount"*); the other two
exercise `archiveOrUnarchiveTemplate` and are untouched. `lockClassRowsOrdered` itself
stays — `gdpr.ts` (×2), `class-template-lifecycle.ts:1627` and `waitlist.ts:986`
still use it.

---

## 2. Decisions taken

Settled with the maintainer on 2026-08-20, before this spec.

1. **A template is a stamp, not a live link.** Editing one does nothing to
   already-generated classes — not the day, not the time, not the room, not the rates,
   not the capacity.
2. **Generation is keyed per week, not per date.** No class is generated into a week
   that already holds one from this template.
3. **A cancelled class holds its week.** Deliberate, and the opposite of how
   `cancelledAt`/`status = cancelled` is read everywhere else (both partial slot
   indexes treat cancelled as free). See §3.2.
4. **The edit says so, and says when** — naming the week the new day first appears.
5. **Rates/room/capacity syncing to unbooked instances was considered and rejected.**
   A rule with an exception is harder to hold than a rule without one, and *"what
   happens to my existing classes when I change this?"* should have exactly one answer.
6. **The prediction and the behaviour share one function** (§4), so the message cannot
   drift from what the generator does.
7. **`already_this_week` surfaces to the teacher** (§3.3), rather than being silent
   like `already_generated`.
8. **All eight artifacts listed in §9 are corrected in this branch**, not filed. Five
   of them go stale purely from the deletion (§1.6); the other three are the
   documentation the maintainer asked for.

This also settles the two questions #194 could not: *withdraw or leave standing* is
answered **leave standing**, and *reuse or mirror `syncTemplateInstances`* is answered
**neither — delete it**.

---

## 3. The rule, stated precisely

### 3.1 The week predicate

For a candidate date `d` and template `T`: `d` is **week-held** iff any `Class` row
with `templateId = T.id` has `mondayOf(row.date) === mondayOf(d)`.

`mondayOf` is UTC-only. Monday-first, matching the schema's `dayOfWeek` convention
(0 = Monday); Sunday maps back six days, not forward one.

### 3.2 No status filter, deliberately

The week read applies **no** `status` filter. A cancelled class holds its week.

The reason is the schedule the alternative produces. Teacher moves Tuesday → Thursday,
then cancels the Tuesday in week 2 only:

| | cancelled holds the week (**chosen**) | cancelled frees the week |
|---|---|---|
| Week 1 | Tuesday | Tuesday |
| Week 2 | *(cancelled — nothing)* | **Thursday** |
| Week 3 | Tuesday | Tuesday |
| Week 4 | Tuesday | Tuesday |
| Week 5 | Thursday | Thursday |

The right column jumps to the new slot for one week and back again. A week that stays
empty is easier to read than a week that changes slot and changes back.

This is a genuine local inconsistency with `Class_teacher_slot_unique`
(`WHERE status <> 'cancelled'`) and it must be written into the code as a comment, not
left for a reader to "fix". A later maintainer adding `status: { not: 'cancelled' }`
here for consistency would reintroduce exactly the flip-flop above.

### 3.3 The skip reason

`already_this_week` joins `SkipReason` in `src/lib/generation.ts` as a fifth member,
and `SkipCounts` as a third field. It is surfaced rather than suppressed because it is
**diagnostic by construction**: `already_generated` means *my class is on this date*;
`already_this_week` means *my class is in this week, on a different date* — which can
only happen when the template moved and the old classes still hold the weeks.

Without it, `resumeMessage` after a day edit says *"4 classes on your schedule. Nothing
needed adding."* — four classes on a weekday the teacher just stopped using. That is
#194's own "8 classes" failure at half the number.

`countSkipReasons`'s exhaustive `switch` already fails the build on an unhandled
`SkipReason`, so adding the member forces the counting site to be updated. That is the
guard; §10 records the mutation that proves it bites.

### 3.4 Evaluation order

Inside `generateInstancesForTemplate`'s per-date loop:

1. **own-date** — `already_generated` / `blocked_by_cancelled`
2. **week** — `already_this_week`
3. **slot** — `slot_taken`
4. otherwise free

Own-date before week is **required for correctness**, not preference: the week set
contains the candidate's own week, so in steady state (no edit, candidates on the
template's own dates) the week rule would fire on every date and mask
`already_generated` entirely.

Week before slot is a judgement: when a day edit and an unrelated class both block a
date, the systematic cause is the useful one to report.

---

## 4. The shared layer is `isWeekHeld`, not the whole decision

> **Corrected against what was built (task 5, 2026-08-20).** This section read *"one
> decision function, two callers"*, with `generateInstancesForTemplate` calling
> `firstFreeWeek`. That is not what shipped and could not have: the generator must name
> a **reason** for every candidate it declines — `already_this_week` is a `SkipReason`,
> `countSkipReasons` reduces it, and the number reaches the teacher — and a
> `Date | null` return cannot carry one. "The first free candidate" and "each declined
> date, with why" are different questions. What the two genuinely share is the
> *definition of held*, and since task 6 they share it as code. Corrected here rather
> than quietly abandoned, because this section is what the plan's task order was derived
> from.

Two exports, one definition of "held". Both pure, both in `class-generator.ts`:

```
isWeekHeld(date: Date, heldWeeks: ReadonlySet<number>): boolean
firstFreeWeek(candidates: readonly Date[], heldWeeks: ReadonlySet<number>): Date | null
```

- **`isWeekHeld`** is the shared code — the single place that says what "this week is
  already taken" means. Called from the generator's loop, which on `true` pushes
  `{ date, reason: 'already_this_week' }` and moves to the next candidate, and from
  `firstFreeWeek` below. It exists for no other reason.
- **`firstFreeWeek`** has ONE caller: the PUT's probe. It returns the first candidate
  `isWeekHeld` says no to, or `null`. Its horizon is longer than the generator's own
  4-occurrence window, because when all four of those weeks are held the honest answer
  is week **5** — outside anything the generator can see. Horizon: `DEFAULT_WEEKS * 2`
  occurrences. If none is free, the message degrades to the unspecific form rather than
  inventing a date (§6).

Sharing the *predicate* is what stops the message describing generator internals it does
not share — the point of this section, and it survives the correction.
`resumeMessage`'s own docblock records the cost of the alternative: its
first draft claimed `blockedByCancelled` "cannot co-occur" with a non-zero `scheduled`,
which was a guess about generator internals and was wrong.

The probe is **read-only**. The PUT creates nothing; generation still happens only on
the cron sweep, on create, and on resume.

---

## 5. The week read

```ts
const heldWeeks = new Set(
  (await db.class.findMany({
    where: { templateId: template.id, date: { gte: firstMonday, lt: lastMondayPlus7 } },
    select: { date: true },
  })).map((c) => mondayOf(c.date)),
);
```

The bounds are derived from the candidate set, not invented: `firstMonday` is
`mondayOf(dates[0])` and `lastMondayPlus7` is `mondayOf(dates.at(-1)) + 7 days`, both
as `Date`s at UTC midnight. Deriving them from the same `dates` array the loop iterates
is what keeps the read and the loop from disagreeing about which weeks are in play —
the gt/gte class of defect this codebase has already paid for twice.

Keyed on `templateId`, not `teacherId` — so it rides the existing
`@@unique([templateId, date])`, present on both `Class` and `StudioClass`.

**This corrects a claim I put in #284**, which says week-keying widens an
already-scanning query and so makes #205 worse. Keyed this way it does not: #205 is
about `teacherId`-scoped reads, and this one is `templateId`-scoped. The comment on
#284 must be corrected (§9).

Rejected alternatives:

- **Widening the existing `teacherId` read to the week range** — one query instead of
  two, but ~7× the rows and unable to use `(templateId, date)`. On `StudioClass` that
  is an unindexed scan over seven times the range.
- **`date_trunc('week', …)` in SQL** — promotes a `@db.Date` to `timestamptz` in the
  session `TimeZone`, which is the exact trap `docs/lock-order.md` and #257 already
  document, and which `postgres:16-alpine`'s unpinned default `TimeZone` would hide
  in dev.

---

## 6. The message

`PUT /api/class-templates/[id]` returns the probe's date in place of `sync`.
`template-form.tsx` renders it where the sync counters were. Copy lives in
`template-action-messages.ts` beside `resumeMessage`.

Two forms:

- **A date is known:** *"Template updated. It takes effect for newly generated classes
  — your first Thursday class is the week of 22 September. Change existing classes
  individually if needed."*
- **No free week inside the horizon:** the same sentence without the middle clause.
  Saying nothing specific beats inventing a date; this file's resolvers already treat
  `null` as "say nothing" for exactly this reason.

If the sentence turns out word-for-word shareable with the studio family (#284), it
follows this file's existing delegate-and-pin pattern — `resumeStudioMessage` delegates
to `resumeMessage` with a test pinning that they agree — rather than being written
twice.

**The message must not over-promise.** `settingsLocked` refuses economic edits on
booked instances, so "change existing classes individually" is not universally
available. Not a regression — sync skipped those instances too — but the copy is new
and must not claim otherwise.

---

## 7. What is deleted

| | |
|---|---|
| `src/services/template-sync.ts` | 250 lines |
| `src/services/template-sync.test.ts` | 7 tests |
| `TemplateSyncResult` | 6 counters: `synced`, `regenerated`, `refilled`, `blockedByCancelled`, `slotTaken`, `kept` |
| `UpdateClassTemplateResult`'s `sync` field | and the route's `sync: result.sync` spread |
| `sync_conflict` reason | and `TEMPLATE_SYNC_SLOT_CONFLICT` |
| `template-lock-order.test.ts` | 1 of its 3 tests |
| `template-form.tsx` | the counter-rendering branch |

`updateClassTemplate`'s transaction survives, reduced to `setLockTimeout(tx)` plus the
`update`. It exists **only** to scope `SET LOCAL lock_timeout`, which is a no-op
outside a transaction (`db-locks.ts`) — that must be stated in the code, or the
transaction reads as vestigial and gets removed, taking the #100/#209 bound with it.

---

## 8. Out of scope

- **The studio family** — #284. This branch lands the shared machinery (`mondayOf`,
  `firstFreeWeek`, `already_this_week`, `countSkipReasons`), so #284 becomes a mirror
  rather than a design.
- **#276** — the studio edit surface, which blocks #284's message half. Unaffected here.
- **#205** — untouched, and §5 explains why this branch does not make it worse.
- **Closing #257 or #233** — both are moot *once this lands*, and both are live
  defects until then. They are commented, not closed.

---

## 9. Artifacts to correct

Per the skill's §4: a claim corrected in one artifact and not its twin is this
project's recorded failure mode. Eight, and each gets its own verdict — not one verdict
for the set.

> **This enumeration was replaced during the build (task 7, 2026-08-20), not
> completed.** Eight was written before the deletion was measured. `grep -rn
> "syncTemplateInstances"` over the repo returns **154 hits across 37 files** with the
> code changes in (173/37 before them), so the eight below are a subset, and two more
> were found by task 4 — the door-5 INLINE comment (the twin of row 7) and this
> branch's own plan file. The sweep that shipped verdicts every hit into one of three
> buckets: **(a)** live source claims in `src/` — corrected; **(b)** live reference
> docs (`docs/lock-order.md`, `docs/technical-architecture.md`, `CLAUDE.md`) —
> corrected; **(c)** dated historical artifacts (`docs/superpowers/specs/*`,
> `docs/superpowers/plans/*`, `docs/backlog-roadmap.md`) — **annotated, never
> revised**, because a July design doc describing a function that existed in July is an
> accurate record and rewriting it destroys the audit trail. This spec and this
> branch's plan are the deliberate exceptions inside (c): they are live working
> documents for the change itself. The eight rows below all landed; they were not the
> whole list.

| # | Artifact | Correction |
|---|---|---|
| 1 | `CLAUDE.md:51` | *"Recurring classes: template generates instances on rolling 4-week basis, runs indefinitely"* → add week-keying and the stamp-not-link stance |
| 2 | `docs/plan-template-sync-and-student-updates.md` | Part 1's *"Decision: sync safe instances, say so for the rest"* marked **superseded by #194**, dated, with the reason. Not deleted — it is the record of why sync existed. |
| 3 | `docs/lock-order.md` | 11 references; a participant leaves the graph |
| 4 | `docs/technical-architecture.md:269` | sync removed from the call-site list |
| 5 | `src/lib/generation.ts` docblock | importer list |
| 6 | `api/class-templates/[id]/route.ts:118-125` | the `busy` comment — the PUT no longer takes `Class` locks |
| 7 | `UpdateClassTemplateResult.room_archived` docblock | door 5 stands (you would still generate into an archived room) but its stated reason goes |
| 8 | GitHub #284's comment | the #205 claim corrected per §5 |

Doc corrections land as their own commit; the deletion and the claims about the
deletion belong to one review.

---

## 10. Tests, and the mutation that proves each

Per the skill's §3: break it, record the exact error text, restore, re-verify. A guard
that compiles but cannot fail certifies nothing.

| Guard | Mutation that must fail it |
|---|---|
| Week-keying blocks a held week | Drop the week check → a day edit generates into weeks 1-4, and the test that asserts "4 classes, all Tuesday" sees 8 |
| **`mondayOf` Sunday roll-back** | Change `day === 0 ? -6 : 1 - day` to `1 - day` → a Sunday class lands in the *following* week. This is the highest-value mutation: a Sunday class and the next Monday are in different weeks, and it is where an off-by-one hides |
| Cancelled holds its week (§3.2) | Add `status: { not: 'cancelled' }` to the week read → the flip-flop schedule appears |
| Evaluation order (§3.4) | Move the week check above the own-date check → steady-state re-runs report `already_this_week` instead of `already_generated` |
| Probe agrees with the generator | Give the probe its own horizon constant → its date disagrees with where the sweep actually creates the class |
| `already_this_week` cannot vanish | Add a sixth `SkipReason` without handling it → `countSkipReasons`'s `never` fails the build |
| **The probe's eligibility precondition** | Drop the `generationState === 'active'` gate at the probe's call site → editing a paused template names week five and an archived one names *this* week, both of which the sweep never fills. Not reachable by completing the `SkipReason` enumeration, which is why it needs its own row |
| Paused and archived are not one state | Collapse `templateUpdatedMessage`'s two ineligible arms into one → the archived sentence tells a teacher to resume, a remedy that does nothing until they un-archive first |

**Timezone coverage is not optional here.** §1.4 is a defect that would have shipped;
the test for `mondayOf` must include a class date whose UTC-midnight instant falls on
the previous day in a west-of-UTC zone, proving the function ignores zones entirely.

---

## 11. Acceptance

- Editing any field on a class template leaves every already-generated `Class`
  byte-identical.
- After a `dayOfWeek` edit, no class is generated into a week that already holds one
  from that template — cancelled ones included.
- The first class on the new day appears in the first week holding none, and the PUT's
  message names that week by date — **for a template the sweep will actually reach**.
  Eligibility is a precondition of the whole prediction, not one of the generator's
  per-date `SkipReason`s: `ACTIVE_TEMPLATE_WHERE` refuses whole templates one layer
  above `generateInstancesForTemplate`, so for a paused or archived one no candidate is
  ever considered and no week can be named honestly. The PUT still succeeds (§8 keeps
  the edit open regardless of `isActive`/`isArchived`) and answers with the state
  instead, and the two states get different sentences because their remedies differ —
  un-archiving forces `isActive: false`, so it does not resume.
- What the message claims is checkable against the Schedule tab.
- `syncTemplateInstances` and its tests are gone, not merely unreferenced.
- Every `syncTemplateInstances` hit in the repo verdicted individually into §9's three
  buckets, the eight rows there included — not eight verdicts for 154 hits.
- `npm run verify` green, with the arithmetic reconciling per project.

---

## 12. Residuals, stated rather than left implicit

- **`already_this_week` is reachable only through a moved template**, and that is worth
  stating because the obvious other route does not exist. A hand-logged class cannot
  trigger it: `createClassSchema` declares no `templateId`, and
  `api/classes/route.ts:86` says so from the other side — *"this create never sets
  `templateId`"* — so a manual class is never in the week set, which is scoped by
  `templateId`. The only producers are a template whose `dayOfWeek` changed and one
  whose instances were generated under a previous day. If a future change lets a create
  accept a `templateId` (the route's own comment anticipates it), this reason gains a
  second origin and its copy stops being accurate.
- **The probe's horizon is a choice, not a derivation.** `DEFAULT_WEEKS * 2` covers the
  realistic case (all four weeks held → week 5) with margin. A template whose next eight
  occurrences are all held falls back to the unspecific message, which is honest.
- **The week rule does not bound the past.** The week read is bounded to the candidate
  window's weeks, so an ancient class from the same template cannot hold a future week.
- **Two templates in one week are unaffected.** The week key is scoped by `templateId`,
  so a teacher running two recurring classes in the same week keeps both.
