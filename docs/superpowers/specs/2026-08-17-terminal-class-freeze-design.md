# Freezing a terminal class against `updateClass` (#247)

**Status:** design agreed 2026-08-17
**Issue:** #247 — `updateClass` has no class-status guard, so a terminal class's
`date` is editable, and #238 turned that into a path to permanent data loss.

---

## 1. The premise, re-measured

Issue #247 was filed by the #238 branch's own whole-branch review. It makes four
factual claims. **All four hold verbatim against the tree at `9ecb506`** — which
is worth recording, because on this project the usual outcome of §1 verification
is a correction.

| Claim | Verified |
|---|---|
| `class_reject_terminal_status_change` is `BEFORE UPDATE OF status` and its own comment says other columns of a completed class are unaffected | Yes — `prisma/migrations/20260805120000_class_terminal_status_trigger/migration.sql`, both the `BEFORE UPDATE OF status` clause and the comment "Fires only on an actual status change, so updates to other columns of a completed class … are unaffected" |
| `updateClass`'s only refusal is `settingsLocked && sentEconomic !== null` | Yes — `class-lifecycle.ts:693` |
| `grep -n "status"` over `src/app/api/classes/[id]/route.ts` returns nothing, `export const PUT` is at `:36` | Yes, both |
| `src/app/(teacher)/class/[id]/edit/page.tsx:21` redirects when status is neither `draft` nor `open` | Yes, exact line |

Two further measurements the issue does not make, both of which the exploit
depends on:

- **`isoDate` has no range bound.** `schemas.ts:9-12` is a `YYYY-MM-DD` regex
  plus a not-`NaN` refine. `{"date":"2020-01-01"}` therefore passes validation,
  so the issue's headline payload genuinely reaches `updateClass`.
- **`updateClass` has exactly one production caller** — `route.ts:60`. Every
  other hit in `grep -rn "updateClass(" src/` is a test or a comment. A guard
  placed in the service therefore has a single, fully-enumerated blast radius.

### 1.1 Three findings that changed the design

**(a) The issue's acceptance criteria closes only one of the two sequences the
issue itself describes.** Its "API-only, immediate" path is closed by a
terminal-status guard. Its "through the shipped UI, delayed" path is not: there
the class is `open` at the moment of the edit, so the guard passes, and
`autoTransitionToInProgress` → `autoCompleteClasses` then walk it to `completed`
*legitimately*. `src/components/class/class-edit-form.tsx:150` is a bare
`type="date"` with no `min`, so the typo is reachable exactly as described. This
is filed separately (§7), not fixed here.

**(b) A read-then-return guard would not hold.** `updateClass` does
`findUnique` → `updateMany` and takes no lock. `completeClass` takes a `Class`
row lock and re-reads under it — `lockClassRow` at `class-lifecycle.ts:324`,
and the `requireEndedBy` comparison at `:349-360`, both in the same file as
`updateClass` itself (not `class-transitions.ts`, which only *passes* the
option in, at `:535`) — so it can commit between `updateClass`'s read and its
write. The existing
`settingsLocked` handling already solves the identical race the identical way,
and says so at `class-lifecycle.ts:672`: *"The compare-and-swap inside the
write is the one that matters."* The terminal guard gets the same construction
for the same reason.

**(c) `settingsLocked` does not cover a completed class with zero
registrations.** The latch is written by the first registration
(`api/registrations/route.ts:205`), so a class nobody booked reaches `completed`
with `settingsLocked === false` and its economic fields still writable — while
`completeClass` has already written its totals as `0`
(`class-lifecycle.ts:389`). Freezing a *named identity set* would leave that
open. Freezing the whole class closes it, which is part of why §2 goes that way.

---

## 2. Decisions taken

Three gate questions, all answered by the user on 2026-08-17.

**2.1 Scope: every field freezes when the class becomes terminal.** Not the
issue's option 2 (a named `IDENTITY_FIELDS` mirror of `ECONOMIC_FIELDS`).

The issue estimates option 1's cost as "the ability to fix a typo in a past
class's description". That capability is not exposed: the edit page redirects
for any class outside `draft`/`open`, so no shipped UI edits a terminal class at
all. The cost is hypothetical, the saving is a second list that has to be kept
true, and the guard is on the *class* rather than on a field set — so there is
no list at all. It also picks up (c) above for free.

**2.2 Enforcement: service compare-and-swap *and* a database trigger.** This
follows the #39 precedent, where the decision to enforce a range in PostgreSQL
and not only in TypeScript came out of a gate question.

The two layers are not redundant and are deliberately **not** the same width.
The service holds the *policy* (all fields, typed refusal, 409). The database
holds the one *invariant a deleting sweep depends on* (`date`). §4 gives the
measurement that makes the narrow trigger safe and the broad one unattractive.

**2.3 The UI path is filed, not fixed.** Closing it needs its own product call —
whether backfilling a class you forgot to log is legal — and answering that
inside this branch is how one issue becomes three. §7.

---

## 3. The service change

### 3.1 A new result variant

```ts
export type UpdateClassResult =
  | { ok: true; cls: Class }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'locked'; fields: readonly [EconomicField, ...EconomicField[]] }
  | { ok: false; reason: 'terminal'; status: ClassStatus }   // new
  | { ok: false; reason: 'no_fields' }
  | { ok: false; reason: 'slot_conflict' }
  | { ok: false; reason: 'template_date_conflict' };
```

`status` rides along so the route can name it back to the teacher — the same
reason `locked` carries `fields`. It is `ClassStatus` rather than a narrowed
terminal union: the value is only ever read for a message, and narrowing it
would need a type guard at each of the two construction sites (the early
return and the disambiguation branch, §3.2) for no gain.

### 3.2 Three sites, mirroring `settingsLocked`

**Early return**, after the opening `findUnique`, **before** the `settingsLocked`
check:

```ts
if (TERMINAL_CLASS_STATUSES.includes(cls.status)) {
  return { ok: false, reason: 'terminal', status: cls.status };
}
```

Ordering is deliberate. A class can be both terminal and locked; `terminal` is
the truer answer, because `locked` reads as a state the teacher could undo by
removing a registration, and this freeze is permanent.

`TERMINAL_CLASS_STATUSES` already exists and is already exported from this
module (`class-lifecycle.ts:78`, derived from `VALID_TRANSITIONS`, frozen at
module load, and pinned against the DB trigger by
`class-terminal-status.test.ts`). Nothing new is declared.

**Compare-and-swap**, in both `where` shapes of the `updateMany`:

```ts
const live = { status: { notIn: [...TERMINAL_CLASS_STATUSES] } };
where: sentEconomic !== null
  ? { id: classId, settingsLocked: false, ...live }
  : { id: classId, ...live },
```

The spread copy is required — `TERMINAL_CLASS_STATUSES` is `readonly` and
Prisma's `notIn` takes a mutable array. `gdpr.ts:1038` already writes
`status: { in: [...CANCELLABLE_STATUSES] }` for the same reason, so this is the
established idiom rather than a new one.

**Disambiguation**, in the `count === 0` block. The `stillExists` re-read gains
`select: { status: true }`, and a branch goes in after the not-found check and
before the `locked` check:

```ts
if (TERMINAL_CLASS_STATUSES.includes(stillExists.status)) {
  return { ok: false, reason: 'terminal', status: stillExists.status };
}
```

**The boundary sits at terminality, not at "editable in the UI".** An
`in_progress` class stays editable through the API even though the edit page
redirects away from it, and that is deliberate rather than an oversight: the
retention sweep reads only terminal classes, and `completeClass`'s
`requireEndedBy` already handles a class rescheduled out from under a
completion. Pinning the boundary is T4's job — it asserts `in_progress`
alongside `draft` and `open`, so narrowing or widening the frozen set is a test
failure either way.

### 3.3 Why the disambiguation branch is mandatory, not defensive

This is the part of the change most likely to be dropped as redundant, so it is
stated plainly: **without it, this change creates the exact failure acceptance
forbids.**

Adding the CAS conjunct means a `date`-only edit on a completed class now
returns `count === 0`. The row exists, so the not-found branch does not fire.
`date` is not economic, so `sentEconomic === null` and the `locked` branch does
not fire either. Control reaches `throw new UpdateClassInvariantError` —
`withErrorHandler` turns that into a **500**, for the single most likely request
this whole issue is about.

The branch is therefore load-bearing on the *common* path reached through the
CAS, not only on the racing path. It is the branch with the sharpest mutation in
the branch (§5).

### 3.4 The early return is an optimisation for every case but one

Deleting it changes the result in exactly one case: a class that is BOTH
terminal and settings-locked, edited with an economic field sent. Without the
early return, control falls straight into `if (cls.settingsLocked &&
sentEconomic !== null)` and answers `locked` — the wrong one of the two true
refusals; §3.2's ordering decision says `terminal` is the truer answer when
both apply, and only the early return delivers it, because that branch runs
before the CAS ever does. T5 (§5) pins exactly this case.

That corrects an earlier draft of this section, which claimed the deletion was
invisible to the whole suite by analogy with the `settingsLocked` check's own
docblock claim — *"Deleting the first check would cost round trips, not
correctness."* The analogy holds for the ECONOMIC check (the CAS reproduces
`locked` with the identical field list on its own) but not for the TERMINAL
one. **There is no predicted-survivor mutation for this early return.**
Deleting it reddens T5 today, on the DB-backed suite alone, and will
additionally redden T9 once Task 2 lands.

Everywhere else — any class that is terminal but not locked, or locked but not
terminal — deleting the early return costs round trips only: the CAS
re-derives `terminal` (or `locked`) identically, via §3.2 and §3.3, and the
existing suite already covers those paths (T1–T4).

What distinguishes the two paths for the query-count question is still
observable, and the existing suite already knows how: `'answers a
visibly-locked row from the read, without attempting the write'` asserts
`updateManyCalls).toHaveLength(0)`. The terminal case gets the same
treatment — that is what T9 is for.

### 3.5 Docblock corrections in this file

- `updateClass`'s summary line reads *"Apply a partial update to a class,
  enforcing the economic-field lock."* It now enforces two locks on two
  different axes and at two different trigger points — first registration, and
  terminality. Rewritten, naming both and saying which is permanent.
- `UpdateClassResult`'s docblock explains why `locked` carries a non-empty
  tuple. It gains a sentence on why `terminal` carries a status.

`TeacherEditableClassField`'s docblock is deliberately **left alone**. Its
sentence "none of these guards live in `updateClass`" is about the guards for
the *forbidden* columns (`status`, `settingsLocked`, `teacherId`, the financial
totals), and the new guard is not one of those — it gates other columns *based
on* status rather than gating a write to `status`. The sentence stays true.
Recorded because it looks like a §4-style twin and is not.

---

## 4. The database trigger

New migration, hand-authored (Prisma cannot express it), following
`prisma/migrations/20260805120000_class_terminal_status_trigger/` as the
template — which cannot itself be edited, as it is applied.

```sql
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

`23514` matches the sibling trigger, so `classifyApiError` treats both the same
way.

### 4.1 Why `date` only, when the service freezes everything

The asymmetry is the design, not an oversight: **the service holds the policy,
the database holds the invariant.** A future feature that wants to annotate a
past class changes one service guard; under an all-columns trigger it would have
to drop a migration-installed trigger first.

### 4.2 The collateral is measured, not assumed

`grep -rn "class\.update\|class\.updateMany" src/ --include="*.ts"`, excluding
`classTemplate` and test files, returns **18 hits**. Five are comment lines
(`api-errors.ts:67`, `api-errors.ts:138`, `class-lifecycle.ts:473`,
`class-template-lifecycle.ts:1219`, `waitlist.ts:908`). **18 − 5 = 13 real write
sites.** Of those 13, exactly **one writes `date`: `updateClass` itself**
(`class-lifecycle.ts:730`). The other twelve:

- `class-lifecycle.ts:221` (`transitionClass`), `:373` (`completeClass`'s
  `open → in_progress` step), `class-transitions.ts:147`, `:416`,
  `transition/route.ts:36`, `gdpr.ts:1037` — **status only.**
- `class-lifecycle.ts:389` and `:407` (`completeClass`) — status **plus** the
  financial totals, in a single statement. `OLD.status` is `in_progress` there,
  so neither trigger fires. The existing trigger's own comment already names
  this case.
- `registrations/route.ts:205` — `settingsLocked` only.
- `waitlist.ts:77`, `:809` — `spotBroadcastAt` only.
- `template-sync.ts:187` — rewrites twelve instance columns
  (`teacherRoomId`, `classType`, `description`, `startTime`, `durationMinutes`,
  `roomCost`, `minRate`, `targetRate`, `minStudents`, `maxStudents`,
  `cancelDeadline`, `autoCancelCheck`) and **pointedly not `date`**; it deletes
  wrong-day instances instead of moving them. It is additionally scoped to
  `date: { gt: now }` and `status ∈ {draft, open}` (`template-sync.ts:150-164`),
  so it cannot reach a terminal class at all.

So the trigger fires against **zero** legitimate writers, and a broader trigger
would put the last three bullets at risk for no gain.

This also means the service guard is *complete* coverage for `date` rather than
partial: with one writer and one caller, there is nowhere else for the column to
change from application code.

---

## 5. Tests, and the mutation that proves each

Every guard gets a mutation that reddens it *uniquely* — a mutation that would
also be caught by a different guard proves nothing about the one it targets.

| # | Test | Home | Mutation |
|---|---|---|---|
| T1 | `updateClass` on a `completed` class refuses a `date` edit, and the row is unchanged | `class-lifecycle.test.ts`, `updateClass (DB)` | Remove **both** the early return and the CAS conjunct. Before the trigger lands the edit simply succeeds; after it lands the same mutation reddens on a raw throw instead. Both runs are recorded — that the outcome differs is what shows the two layers are independent |
| T2 | The same on a `cancelled` class | same | as T1 |
| T3 | A `description` edit is refused — the freeze is whole-class, not a field list | same | Narrow the guard to `date` only |
| T4 | An economic edit is refused on a completed class nobody booked, where `settingsLocked` is still `false` | same | Narrow the guard to `date` only. This is the §1.1(c) hole, and the only test that covers it |
| T5 | A class that is **both** terminal and locked reports `terminal`, not `locked` | same | Swap the two early checks → reports `locked`, per §3.2's ordering decision |
| T6 | `draft`, `open` **and `in_progress`** classes still update normally | same | Add the status under test to the guard's frozen set. This is the test that proves the guard *can* pass, and the only one that pins the boundary — a mutation freezing `in_progress` would otherwise pass every other test in this table |
| T7 | Stub `db`: count 0 + terminal on the re-read → `terminal`, not a throw | `class-lifecycle.test.ts` stub block | Delete §3.3's branch → `UpdateClassInvariantError` |
| T8 | Stub `db`: both `where` shapes carry the `notIn` conjunct, asserted on `updateManyCalls[0].where` | same | Drop the conjunct from either shape |
| T9 | The early return answers without attempting a write (`updateManyCalls).toHaveLength(0)`) | same | Delete the early return — reddens T9 on the query-count assertion; T5 (§3.4) reddens too, on the wrong refusal reason, for the terminal-and-locked-with-economic-field case |
| T10 | `PUT /api/classes/[id]` on a completed class answers **409**, not 500, and the stored date is unchanged | `tests/integration/classes-api.test.ts` | Change the mapped status code |
| T11 | Raw SQL `UPDATE "Class" SET date = …` on a completed class is rejected with `23514` | **new** `src/services/class-terminal-date.test.ts` | `DROP TRIGGER class_terminal_date_guard` against `DATABASE_URL_TEST` |

**T11 gets its own file rather than joining `class-terminal-status.test.ts`,**
even though that file already has the fixtures. The two triggers must be
droppable independently: a `DROP TRIGGER class_terminal_date_guard` run that
reddens tests about the *status* trigger tells you less than one that reddens
only its own file, and that independence is the whole point of having two
layers. The duplicated fixture is the price.

**It goes in the `unit` project, beside `class-terminal-status.test.ts`, not in
`tests/integration/`.** That file's docblock records why, and the reason is a
foot-gun rather than a preference: the integration project runs against the
**dev** database (`docs/test-database.md` §3.4), so proving a trigger by
dropping it there needs a manual `DATABASE_URL` override, and getting the
override wrong drops the trigger on dev. `vitest.config.ts` resolves the unit
project's `DATABASE_URL` to `DATABASE_URL_TEST` with no shell override. T11 also
carries the manual mutation recipe in its docblock, in the same shape as its
sibling.

Every mutation is run, its exact error text recorded, then restored and
re-verified — including the early-return deletion: it reddens T5 on its own,
on the DB-backed suite, and additionally reddens T9 once Task 2 lands (§3.4).
No mutation in this table survives the suite.

### 5.2 One existing test's title stops being true

`class-terminal-status.test.ts:370`, `'leaves non-status updates to a completed
class alone'`, writes `description` and asserts it lands. The test stays green —
the new trigger is `BEFORE UPDATE OF date` and that write does not name `date` —
but its title will over-claim, because after this branch some non-status updates
to a completed class are precisely *not* left alone. Narrowed to name the column
it actually exercises, with a pointer to the sibling trigger. Its two
neighbours were checked as well: `'allows a completeClass-shaped write…'` writes
status plus three totals and `'allows a no-op status write on a cancelled
class'` writes status alone, so neither names `date` and neither is affected.

### 5.1 Existing tests are unaffected

Every fixture in the `updateClass (DB)` block is built by a `makeClass` helper
that hard-codes `status: 'draft'` (`class-lifecycle.test.ts:1248`). The change
is additive; no existing assertion moves.

---

## 6. Artifacts to correct

`grep -rn "247" docs/ src/ prisma/ .github/`, discounting the roadmap and
coincidental digit matches, returns **two live pointers**. Both currently
describe this as an open residual and both must flip to describing it as closed,
naming which layer closes which half:

1. `src/services/waitlist-retention.ts:57-70` — the "THE SECOND HALF OF THE
   PREDICATE IS NOT ENFORCED" section. Its heading becomes false on this branch.
   The rewrite says both halves are now enforced, and by what: `status` by
   `class_terminal_status_guard`, `date` by `class_terminal_date_guard` plus the
   `updateClass` CAS.
2. `docs/superpowers/specs/2026-08-16-waitlist-retention-design.md:328-345` —
   §2.4, whose four bullets are each individually still true about the *old*
   tree and collectively wrong about the new one. Amended in place with a dated
   note rather than rewritten, since it is a historical design record.

Plus, on this branch: `updateClass`'s summary docblock and `UpdateClassResult`'s
(§3.5), the PR body, issue #247 itself, and `docs/backlog-roadmap.md` in its own
final commit.

**Each of those six locations gets its own verdict at re-review**, not one
verdict for "the docs finding" — the #41 failure mode was a three-location
finding verdicted ADDRESSED on the strength of the two locations the reviewer
happened to open.

---

## 7. Out of scope, and what gets filed

**Filed as a decision:** the UI path of §1.1(a). A teacher reschedules a live
class, typos the year into the past, the sweeps complete it within two ticks,
and the retention sweep reaps its queue. Nothing in this branch touches it,
because the fix needs a product call this branch should not pre-empt: is moving
a class into the past ever legal — backfilling one you forgot to log — and if
so, how far? The issue lays out the options rather than assuming work.

It clears §7's floor on its own terms regardless: it is a live path to data a
user loses, so it is fixed or filed, and it is filed.

**Unaffected:** `settingsLocked` and `ECONOMIC_FIELDS`. They gate on first
registration, not on terminality, and they already work. This is a second,
later freeze point that did not exist.

**Not attempted:** bounding `isoDate`. It is the mechanism behind §1.1(a) and
belongs to that decision, not to this one.

---

## 8. Acceptance

- `updateClass` refuses any edit to a `completed` or `cancelled` class with
  `reason: 'terminal'`, and the route answers 409 rather than 500.
- The refusal survives the read-to-write race, because the CAS re-derives it.
- `class_terminal_date_guard` rejects a raw-SQL `date` change on a terminal
  class with `23514`.
- Eleven tests, eleven mutations, each recorded with its exact error text; none
  survives the suite — §3.4 corrects an earlier draft's claim that the
  early-return deletion was one legitimate exception.
- Both artifacts in §6 state that the residual is closed, and §5.2's test title
  no longer over-claims.
- `npm run verify` green — all three vitest projects, with the arithmetic in the
  PR body.
