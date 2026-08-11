# Generator slot reporting — #164 + #192

**Status:** design agreed 2026-08-11. Closes #164 and #192. Unblocks #196 branch 1.

Both generators stop relying on a `catch (P2002) { continue }` that cannot work, and
start reporting *which* dates they skipped and *why*. One branch, because #196 indexes
both families and the two changes touch the same eight lines twice if taken separately.

---

## 1. What was measured

Three probes, against `ethical_yoga_test` with the full migration history, real
`PrismaClient`, `@prisma/client` 6.19.3. Every number below came out of a probe; none
was reasoned about.

### 1.1 The silent variant is real, and no one had checked it

#164's own comment probed the loud half only — a caught `P2002` inside a transaction
poisons it, and the next statement raises `25P02`. The half the issue is *named* for
was still an argument. It is now a measurement:

```
A autocommit      : dup -> P2002; next insert -> SUCCEEDED (row committed)
B tx, not last    : dup -> P2002; next stmt -> 25P02 "current transaction is aborted"
                    the earlier insert: NOT committed
C tx, IS last     : dup -> P2002; $transaction -> RESOLVED, reported created=1
                    the row it claims to have created: NOT committed
```

**C is the defect.** `$transaction` resolves *successfully*, returns a positive count,
and every row it counted is gone. Postgres answers `COMMIT` on an aborted transaction
with the `ROLLBACK` tag and no error, so nothing anywhere raises. Through
`pauseOrResumeTemplate` that is `{ ok: true, action: 'active' }` handed to a teacher
whose `isActive: true` was rolled back in the same transaction — the template stays
paused, the window stays empty, and no log line exists to find it by.

### 1.2 The issue's reachability table is wrong in row 3

#164 lists `class-template-lifecycle.ts:456` (Resume) as protected by the implicit
`FOR NO KEY UPDATE` its preceding `update` takes. A Postgres FK check takes
`FOR KEY SHARE` on the referenced row, and `FOR KEY SHARE` conflicts with `FOR UPDATE`
but **not** with `FOR NO KEY UPDATE`. Measured with a real `Class` insert against a
real held lock:

```
concurrent Class insert while a transaction holds:
  FOR NO KEY UPDATE  (pauseOrResumeTemplate's update)  : SUCCEEDED — no protection
  FOR UPDATE         (claimTemplateForGeneration)      : BLOCKED  — protected
```

**So Resume — the issue's headline symptom — is reachable today, not only after #196.**
The codebase already knew: #116's body says it in those words, quoting
`claimStudioTemplateForGeneration`'s docstring, and `class-generator.ts:180-189` says
`FOR UPDATE` *specifically* is what makes a concurrent insert impossible. #164's table
contradicts both. #164 is the one that is wrong, and its title was right all along.

### 1.3 `skipDuplicates` is a bare `ON CONFLICT DO NOTHING`

This is the linchpin. `createMany`/`createManyAndReturn` with `skipDuplicates` is only
a general answer if Prisma emits **no conflict target** — a target would cover
`@@unique([templateId, date])` and miss #196's partial index, which is the entire point.

Measured by creating #196's exact index on the test database, inserting a *manually
created* class (`templateId: null`) into the teacher's slot, then running a three-date
batch through it:

```
createMany count = 2 (asked 3; the middle date was blocked by the PARTIAL index only)
rows landed: 2098-01-07, 2098-01-21    (the blocked date, and only it, was skipped)
inside a tx: next stmt SUCCEEDED; tx RESOLVED; the other dates committed
```

A targeted `ON CONFLICT ("templateId","date")` could not have skipped that row — it
would have raised `P2002` on the partial index. It was skipped, so the clause is bare.
**One blocked date cost exactly that date**, which is verbatim the bar #196 sets.

`createManyAndReturn({ skipDuplicates: true, select })` was probed separately inside a
transaction: asked for 3 dates with one pre-existing, it returned exactly the 2 rows it
inserted, did not abort, and committed. So the *inserted set* is knowable without a
second query.

### 1.4 Corrections owed to #164's text

| #164 says | measured |
|---|---|
| `class-generator.ts:122-127` | `:123-128` |
| `class-generator.ts:268` | `:265` |
| `class-template-lifecycle.ts:453` | `:456` |
| `template-sync.ts:101` | `:119` |
| Resume protected by `FOR NO KEY UPDATE` | **not protected** — §1.2 |
| "the correct claim exists in [the studio] file" | it also exists **in the same file**. `class-generator.ts:74-78` advertises "idempotently (`@@unique([templateId, date])` + P2002-skip)"; `:183-189` says that branch "cannot work inside this transaction anyway… the next query fails with `25P02`, not a clean P2002 skip". The file has contradicted itself for 105 lines. |

Confirmed as stated: `template-sync.ts` is the one caller passing a bare
`PrismaClient`; `class-templates/route.ts` POST is genuinely unreachable today because
the template id is created inside its own transaction and no concurrent writer can name
it; the studio twin logs this condition and the class twin logs nothing.

### 1.5 A correction owed to #196's spec §5.1

§5.1 chose a pre-check and conceded: *"The pre-check is a read-then-write and so is not
race-safe on its own; the unique index is its backstop. Under a true race the
transaction still aborts, as it does today. What changes is that the route maps that
P2002 to a 409 naming the clash."*

With a bare `ON CONFLICT DO NOTHING` behind it, that residue does not exist. The
generator cannot raise `P2002` at all, so there is no 409 for it to map and no
surviving abort. §5.1's other endpoints are unaffected — this correction is about the
generator only. It is recorded here and must be applied to §5.1 (or, if that branch is
gone, posted to #196) rather than left in this file alone.

---

## 2. Decisions taken at the gate

Recorded with who decided, because each widened the branch.

1. **Both families, not just the class one** (Ivo, 2026-08-11). #196 indexes `Class`
   *and* `StudioClass`, so both generators need this regardless — #196 inverts #192's
   own cost estimate, which had discounted Option C partly for "dragging in the class
   family."
2. **#164 and #192 together** (Ivo, 2026-08-11), matching the roadmap's "#164 + #192
   (the generator family)" bundle.
3. **Include the `(teacherId, date, startTime)` pre-check now** (Ivo, 2026-08-11), as
   §5.1 asks, rather than deferring it to #196 branch 1.
4. **Both families' teacher-facing copy** (Ivo, 2026-08-11) — including the class
   family's, which reports no counts on resume today. That half is new capability, the
   class twin of #119/#120, and no issue asks for it; it is in scope by this decision.

---

## 3. The generation result

Both generators return the same shape. The parity both files' docblocks protect is
preserved and strengthened: it now covers the result as well as the signature.

```ts
export type SkipReason =
  | 'already_generated'    // this template's own live instance is on that date
  | 'blocked_by_cancelled' // this template's own CANCELLED instance holds that date
  | 'slot_taken'           // another of this teacher's classes holds date + startTime
  | 'raced';               // pre-check said free; ON CONFLICT skipped it anyway

export interface SkippedSlot {
  date: Date;
  reason: SkipReason;
}

export interface GenerationResult {
  created: number;
  skipped: SkippedSlot[];
}
```

Four reasons, each with a distinct origin and a distinct owner:

- `already_generated` is correct idempotency. It is the normal case and stays silent.
- `blocked_by_cancelled` is **#192's** target. `@@unique([templateId, date])` makes the
  date permanently unfillable, so the window comes back short for good. Invisible today.
- `slot_taken` is **#196's** target. Invisible today, and worse than invisible: today
  the generator inserts anyway and the teacher gets two classes in one slot.
- `raced` is **#164's** target — the condition that used to poison the transaction. It
  is now a skipped date like any other, and it is always logged.

`created + skipped.length === candidateDates.length` is an invariant, and every caller
that today reads a bare number reads `.created`.

## 4. The algorithm

Unchanged: compute the candidate dates exactly as now (`getNextOccurrences`, the
`classStartInstant` "start is still ahead" filter, `.slice(0, DEFAULT_WEEKS)`).

Then, replacing the per-date `findFirst` + `create` loop:

1. **One** `findMany` for the occupied slots — this teacher's rows whose `date` is in
   the candidate set, selecting `date`, `startTime`, `templateId`, and the family's
   cancellation column. One query per run, not one per date.
2. Classify each candidate, in this order (first match wins, so an already-generated
   date is never also reported as `slot_taken` by its own row):
   - own-template row present, not cancelled → `already_generated`
   - own-template row present, cancelled → `blocked_by_cancelled`
   - any other row at the same `date` **and** `startTime`, not cancelled → `slot_taken`
   - otherwise free
3. One `createManyAndReturn({ data: freeRows, skipDuplicates: true })`.
4. Any free date absent from the returned rows → `raced`.

Step 3's bare `ON CONFLICT DO NOTHING` is the backstop, and it is why step 1's
read-then-write is safe to build on: the pre-check names *why*, the constraint
guarantees *that a clash costs only its own date*. Neither part can be dropped — the
pre-check alone leaves the abort live under a race (§1.5), and the backstop alone
cannot say which reason applied.

### 4.1 The predicate must mirror the index predicate

`slot_taken` must use exactly the predicate #196's index will carry, per family:

| family | occupancy predicate | #196's index predicate |
|---|---|---|
| `Class` | `status: { not: 'cancelled' }` | `WHERE "status" <> 'cancelled'` |
| `StudioClass` | `cancelledAt: null` | `WHERE "cancelledAt" IS NULL` |

They must agree, in both directions, and the failure modes are asymmetric. A pre-check
*stricter* than the index silently under-fills the window — a date it calls `slot_taken`
would in fact have been insertable, and nothing raises. A pre-check *looser* than the
index falls through to `raced`, which is safe but mislabelled. Only the first is a
defect; both are worth a test.

## 5. Call sites

Seven in production, nine in tests — and §3's blanket claim that all sixteen "read a
number today and read `.created` after" was wrong. Measured while implementing
Task 1: most sites **discard** the return value, so no edit is needed there, and the
spec's first pass should not have listed them as converting:

- **Discard the return:** `api/class-templates/route.ts:63` (POST),
  `class-template-lifecycle.ts:456` (Resume), `template-sync.ts:119`,
  `api/studio-class-templates/route.ts:48` (POST), and the rollback probe at
  `tests/integration/class-templates-api.test.ts:194`. Their only obligation is to
  keep calling the generator; the shape change is invisible to them.
- **Consume the return:** the two sweeps (`class-generator.ts:265`,
  `studio-class-generator.ts:266`, which read `.created` into their totals) and the
  resume branches Tasks 4/5 count from.

**Class family — `generateInstancesForTemplate`:** `api/class-templates/route.ts:63`
(discards), `class-generator.ts:265` (consumes), `class-template-lifecycle.ts:456`
(discards; Task 4 reads it), `template-sync.ts:119` (discards) (4 production);
`class-generator.test.ts:643` and the Task 1 slot-reporting suite (consume),
`tests/integration/class-templates-api.test.ts:194` (discards) (3 test).

**Studio family — `generateStudioInstancesForTemplate`:**
`api/studio-class-templates/route.ts:48` (discards), `studio-class-generator.ts:266`
(consumes), `studio-class-template-lifecycle.ts:385` (consumes; Task 5 counts)
(3 production); `studio-class-generator.test.ts:538,539,562,585,586,600`,
`tests/integration/studio-api.test.ts:196` (7 test).

`4 + 3 = 7` production, `3 + 7 = 10` test, 17 total. The two sweeps
(`generateClassInstances`, `generateStudioClassInstances`) keep returning `number` —
their callers are the cron route and `scheduler.ts`, which want a total, and the
per-template detail belongs in the log, not in a sweep-wide sum.

## 6. Logging, and the noise answer #192 asked for

#192 declined Option A partly because it had no answer for volume: the sweep runs
hourly, and a teacher with two blocked dates would generate "~48 warnings/day for weeks
on a 2GB VPS."

**One `log.warn` per generator call**, emitted only when `skipped` contains at least one
reason other than `already_generated`, carrying `{ templateId, teacherId, skipped }`
with every blocked date and its reason in one line.

- `already_generated` never logs. It is the correct case; logging it is the noise.
- Per-*call*, not per-date. That is what turns #192's arithmetic from 24 × N lines/day
  into 24 lines/day per affected template, each one complete rather than a fragment.
- Explicitly rejected: stateful de-duplication across runs. It needs storage this VPS
  budget does not want, and a line per hour is greppable without it.

This is also #164's fix 1 — the log line the studio twin has and the class twin lacks —
now carrying a reason instead of a bare "generated without the claim held".

## 7. Teacher-facing copy

Both families. The service change is what makes this honest rather than inferred:
`resumeStudioMessage`'s docblock declines to name a cause today for exactly this reason
— *"That inference is sound today and rests on generator internals, so it stays out of
the copy: occupancy is checkable by whoever reads the message, cause is not."* Once
`skipped` is measured and travels over the wire, the cause is checkable too, and the
objection lapses.

### 7.1 The live contradiction being fixed

`resumeStudioMessage(0, 0)` returns "Nothing is scheduled from this template." while
`class-list.tsx` renders that same template's cancelled classes struck through with a
"Cancelled" badge on the Schedule tab. Two statements from the same app that the teacher
can see disagreeing.

### 7.2 Proposed wording

Existing sentences are unchanged unless a blocking reason applies. Proposed additions,
for review — copy is the user's call and these are a starting point, not a decision:

| case | today | proposed |
|---|---|---|
| nothing blocked | `4 classes on your schedule.` | unchanged |
| nothing to add, nothing blocked | `4 classes on your schedule. Nothing needed adding.` | unchanged |
| some dates `slot_taken` | `3 classes on your schedule.` | `3 classes on your schedule. 1 date already had a class.` |
| `scheduled === 0`, all `blocked_by_cancelled` | `Nothing is scheduled from this template.` | `Nothing is scheduled from this template. 4 cancelled classes still hold those dates.` |
| `scheduled === 0`, nothing blocked | `Nothing is scheduled from this template.` | unchanged |

The class family gets the same sentences via a new `resumeMessage`, and
`pauseOrResumeTemplate` gains the occupancy count on its active branch that the pause
branch already computes (`scheduledWhere(templateId, { gte: today })`, `class-template-lifecycle.ts:511`).

### 7.3 The brand this removes, and what replaces it

`TemplateToggleResponse`'s `active` arm carries `scheduled?: never; added?: never`, and
its docblock is explicit about the job: without it the studio type is assignable to the
class type, because "excess-property checking fires only on fresh object literals" and
every other arm matches verbatim. PR review measured two live slips it catches —
swapping the resolver in `toggle-studio-template-button.tsx` restores #119 exactly, and
in `archive-studio-template-button.tsx` it substitutes `archiveMessage` for
`archiveStudioMessage`, which is #93. **Neither was caught by the compiler before the
brand, and neither would be caught by a test that does not compare strings.** The
docblock even names this change: *"If #116 ever gives the class family's resume a count,
this brand is what it removes."*

Giving the class `active` arm real counts makes the two arms structurally identical, so
no phantom-`never` trick can separate them again — there is no longer a field one family
has and the other lacks.

**Replacement: a required, wire-visible discriminator** on both `active` arms —
`templateKind: 'class'` and `templateKind: 'studio'`. A union is assignable only if
every arm is, so one non-assignable arm protects the whole type in both directions,
exactly as the brand did. It is strictly stronger than what it replaces:

- it is checkable at runtime, and the resolvers already distrust the wire — the `active`
  branch of `resolveStudioConfirmation` re-checks `Number.isInteger` on both counts
  because "the type constrains the server and nothing constrains the wire";
- it is one literal rather than a phantom, so it reads as what it is.

Pinned with a `@ts-expect-error` line asserting the studio payload does not satisfy the
class resolver, and the reverse. That pin genuinely fails: delete `templateKind` from
either type and the `@ts-expect-error` becomes unused, which `tsc` reports as an error.

## 8. Corrections owed to other artifacts

Per "correct a claim in every artifact, not just the one in front of you":

- `class-generator.ts:74-78` — the docblock advertising "idempotently
  (`@@unique([templateId, date])` + P2002-skip)". A comment asserting an idempotency the
  code does not have is what stops the next reader checking.
- `class-generator.ts:180-189` — `claimTemplateForGeneration`'s docblock says the P2002
  branch is "dead code, safe" under `FOR UPDATE`. After this change there is no P2002
  branch; the paragraph's reasoning about `FOR UPDATE` versus `FOR NO KEY UPDATE` stays
  (it is correct and #116 depends on it) but must stop describing a branch that is gone.
- `studio-class-generator.ts:153-208` — the long comment above the studio `try`,
  including the sentence about the `if (existing) continue` path that "logs nothing";
  that path now reports `blocked_by_cancelled`.
- `template-action-messages.ts` — `resumeStudioMessage`'s "stays out of the copy"
  paragraph, and `TemplateToggleResponse`'s brand paragraph.
- `docs/lock-order.md` — **check, do not assume.** `:94` states `create`/`createMany`
  are deliberately outside the candidate set because "a freshly inserted row's lock
  conflicts with nothing", which suggests N creates → 1 `createMany` changes nothing.
  The new `findMany` takes no locks under READ COMMITTED. Both need confirming against
  the document rather than argued from here, and `:511-512` names the generator in a
  known-violation entry that must still read true.
- `docs/technical-architecture.md` — listed in CLAUDE.md as live; check whether it
  documents the generator's return or its idempotency.
- **#196's spec §5.1** — the correction in §1.5 above.

Task 7's grep found three further studio-family sites the list above missed, all
corrected on this branch — none are load-bearing code, so the correction is
comment-only:
- `studio-class-generator.ts:46-81` — the claim docblock's three-caller P2002-hedge
  narrative ("what makes the P2002 branch below unreachable, full stop"). There is
  no branch; the class twin's correction (second bullet) now has a studio mirror.
- `api/studio-class-templates/route.ts:35` — "The generator's P2002 hedge is
  therefore dead for this caller".
- `studio-class-template-lifecycle.ts:362` — "the generator's P2002 hedge cannot
  save us".

## 9. Testing

### 9.1 The two tests that must fail against today's code

#164's acceptance asks for the silent variant through the `class-template-lifecycle`
path. Both are deterministic with no test-only hook in production code, using the lever
§1.2 measured: a second transaction holds `FOR UPDATE` on a row the insert's FK
references (`TeacherRoom`), which parks the generator's insert; that transaction then
writes the colliding row itself and commits; the parked insert unblocks into the clash.
`class-generator.test.ts:443-505` ("archive mid-sweep") already drives concurrency this
way.

The Resume path is the right vehicle precisely because §1.2 measured it unprotected —
its `FOR NO KEY UPDATE` does not conflict with the holder's work.

**T1 — the silent variant.** Pre-create this template's own instances on candidate dates
1–3, leaving only date 4 free. Park Resume's insert; the holder inserts date 4 and
commits. Today: the loop skips 1–3, `create(d4)` raises P2002, `continue` exits the loop,
`return 0`, `COMMIT` on an aborted transaction resolves, and **`{ ok: true, action:
'active' }` is returned with `isActive: true` rolled back**. Assert `isActive` is
committed → fails today. After: date 4 is reported `raced`, nothing aborts, `isActive`
commits.

**T2 — the loud variant.** Same, but leave dates 3 *and* 4 free and have the holder
insert date 3. Today: `create(d3)` raises P2002, `continue`, then `findFirst(d4)` raises
`25P02`, which is not P2002 so it is rethrown, Resume's `.catch` sees a non-P2025 and
rethrows, and the route 500s. Assert Resume succeeds and date 4 exists → fails today.

Both assert the invariant the issue asks for: **rows that exist == reported `added`**.

### 9.2 The rest

- **`slot_taken`** — a manual class (`templateId: null`) at the teacher's slot on date 2.
  Assert `created === 3`, `skipped === [{ date: d2, reason: 'slot_taken' }]`, and the
  other three dates exist. Fails today: today ignores the teacher slot, creates a fourth
  class into an occupied slot, and returns 4.
- **`blocked_by_cancelled`** (#192) — a cancelled instance of this template on date 2.
  Assert the reason and that `created` excludes it. Fails today: the field does not exist
  and the short count has no explanation.
- **Predicate mirror (§4.1)** — a *cancelled* class of another template at the same
  `date` + `startTime` must **not** block. Passes today for an unrelated reason, so it
  earns its place by mutation, not by failing: drop `status: { not: 'cancelled' }` from
  the pre-check and it must fail.
- **Log line** — asserted present with the blocked dates, and asserted *absent* when the
  only skips are `already_generated`. The second half is the one that keeps §6's noise
  answer true.
- **Type pin** — §7.3's `@ts-expect-error` pair.

### 9.3 Every guard is proved by mutation

Per this project's rule that a guard which compiles but cannot fail certifies nothing,
each mutation below is applied, the exact error text recorded, then reverted and
re-verified. **A mutation must use a value the code under test cannot produce**, and none
of these introduces a live-looking date or address.

| guard | mutation that must break it |
|---|---|
| `ON CONFLICT` backstop | replace `createManyAndReturn({skipDuplicates})` with the per-date `create` + `catch P2002 continue` loop → T1 and T2 must fail, T2 with `25P02` specifically |
| `slot_taken` clause | delete it from the pre-check → the double-booking test must fail |
| predicate mirror | drop `status: { not: 'cancelled' }` → the cancelled-neighbour test must fail |
| `blocked_by_cancelled` | classify a cancelled own-row as `already_generated` → #192's test must fail |
| `raced` | drop the "free but not returned" diff → T1's reason assertion must fail |
| log line | remove the `log.warn` → its test must fail |
| noise rule | log on `already_generated` too → the absence test must fail |
| `templateKind` | delete it from either type → the `@ts-expect-error` goes unused, `tsc` fails |

## 10. Explicitly not in scope

- **#116** — giving `pauseOrResumeTemplate` the `FOR UPDATE` claim. This branch makes
  the abort impossible; #116 makes the race impossible. Independent, and #116 also
  covers reading stale template values, which this does not touch. §1.2's measurement
  is evidence *for* #116 and should be posted there.
- **#83** — `template-sync`'s write-then-sync seam.
- **#194, #122, #180, #103** — adjacent generator/lock issues, untouched.
- **#196's migration.** No index is created here. The pre-check is written to match the
  predicates #196 will use, and §4.1's tests pin that match, but the constraint itself
  is #196 branch 1's.
- Adding `cancelledAt: null` / `status` to the *own-template* probe's `where`. #192 rules
  this out: `@@unique([templateId, date])` makes it a clash rather than a regeneration.
  The skip is correct; only the reporting was wrong.

## 11. Acceptance

1. T1 and T2 pass, and both fail against `main`.
2. Reported `added` equals the rows that exist, in every test that reports a count.
3. A window containing one blocked date still generates every other date, and still
   creates the template — #196's stated bar, met by the constraint rather than by luck.
4. An operator can answer "why was this teacher's window short in August" from one log
   line per generator call, naming each date and its reason — #192's bar.
5. `resumeStudioMessage`'s `scheduled === 0` branch no longer contradicts what the
   Schedule tab shows for the same template.
6. Every mutation in §9.3 was applied, observed to fail, and reverted.
7. `npm run verify` green, with the integration file count stated by path.
