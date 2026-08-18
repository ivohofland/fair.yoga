# Refusing a write that puts a class's start in the past (#249)

Spun out of #247, which closed the post-terminal half of this surface and left
this half open on purpose. #247 filed it *as a decision* rather than as work,
because the mechanism was settled and the product question was not: is moving a
class into the past ever legal, and if so, how far?

This spec answers that question, and corrects four things the issue got wrong or
incomplete on the way — one of which reverses the issue's own cost estimate for
the option it recommended.

---

## 1. The premise, re-measured

All five of the issue's measured links hold against `main` at `e888405`.

| # | Claim | Verdict |
|---|---|---|
| 1 | Nothing bounds the date on the way in | HOLDS. `grep 'min=' src/components/class/class-edit-form.tsx` returns nothing; `isoDate` (`src/lib/schemas.ts:22-32`) checks shape and calendar-validity only; `updateClassSchema.date` is a bare `isoDate.optional()` (`:358`) |
| 2 | The edit is legitimate when it happens | HOLDS. The terminal guard is `TERMINAL_CLASS_STATUSES.includes(cls.status)` (`src/services/class-lifecycle.ts:754-755`), false for `open` |
| 3 | The sweeps then walk it to terminal | HOLDS. `autoTransitionToInProgress` (`src/services/class-transitions.ts:54`, filter at `:64`) and `autoCompleteClasses` (`:506`, filter at `:513`) |
| 4 | Both terminal guards are innocent | HOLDS. The early return at `:754` and the CAS conjunct at `class-lifecycle.ts:834` both gate on the class *already being* terminal; the trigger is a `BEFORE UPDATE OF date` keyed on `OLD.status` |
| 5 | The reaper then deletes | HOLDS. `WAITLIST_RETENTION_DAYS = 365` (`src/services/waitlist-retention.ts:188`), `date: { lt: cutoff }` (`:342`), `deleteMany` (`:426`) |

The issue's follow-up comment also holds: `POST /api/classes/[id]/transition`'s
cancel CAS is `where: { id, status: { in: ['draft', 'open'] } }`
(`src/app/api/classes/[id]/transition/route.ts:37`) with no date predicate, so a
manual cancel reaches a terminal state in one request, no sweep involved.

### 1.1 Four corrections

**(a) Two citations have drifted, and the drift came from #247's own review.**
The issue cites `isoDate` as `src/lib/schemas.ts:8-12`; that range is now the
docblock, and the validator is `:22-32`. It cites the edit form's date input as
`class-edit-form.tsx:150`; it is `:164-168`. Both moved in `e888405` — the #247
branch's five-agent review, which added `isoDate`'s calendar-validity `refine`
*after* this issue was written. The claims survive; the line numbers did not.

**(b) "Within two sweep ticks" is one tick on the production path.**
`src/lib/scheduler.ts:205` runs the three transition sweeps through
`isolatedSweeps`, which `await`s them **sequentially** in a `for` loop
(`:60-76`, the await at `:68`). So `autoCompleteClasses`'s `findMany` sees the
row `autoTransitionToInProgress` committed moments earlier, and a past-dated
`open` class goes `open -> in_progress -> completed` inside a single 60-second
tick. Only the HTTP cron route
(`src/app/api/cron/transition-classes/route.ts:15`) runs them under
`Promise.all`, where the snapshots are concurrent and it genuinely takes two.
The issue described the slower of the two paths.

**(c) "Costs backfill" is a cost against a capability that does not exist.**
This is the correction that reverses the issue's own trade-off. Measured:

  - Creating a past-dated class is *already* unbounded. `createClassSchema.date`
    is a bare `isoDate` (`src/lib/schemas.ts:331`), the wizard's date input has
    no `min` (`src/app/(teacher)/class/new/page.tsx:382-390`), and
    `POST /api/classes` writes `date: new Date(body.date)` (`:70`) with no
    service between the parse and the insert.
  - But that class is created `status: 'draft'` (`:80`), and **no sweep selects
    drafts** — `autoTransitionToInProgress` and `autoCancelClasses` take
    `status: 'open'` (`class-transitions.ts:64`, `:225`), `autoCompleteClasses`
    takes `in_progress` (`:513`). A past-dated draft is inert.
  - Registrations are accepted only for `open`/`in_progress`
    (`src/app/api/registrations/route.ts:131-133`), so the moment such a class
    becomes bookable it is also sweepable, within the same tick.
  - **And the product already has a backfill surface: `StudioClass`.**
    `createStudioClassSchema.date` is deliberately unbounded
    (`src/lib/schemas.ts:468-475`), with no `min` on its input
    (`src/app/(teacher)/studio-class/new/page.tsx:161`), because a studio class
    is a record of teaching done at someone else's studio and logging last
    Tuesday's is the normal flow.

So refusing past starts on the registration-bearing `Class` removes no working
capability. It keeps two objects doing the jobs they were separated to do.

**(d) The harm is wider than the waitlist, and it does not need 365 days.**
The issue scopes the damage to reaping, which requires a date more than 365 days
past. But `VALID_TRANSITIONS.in_progress` is `['completed']`
(`class-lifecycle.ts:49`) — there is no route back to `open` — and completion
creates a `Payment` per charged registration plus a `payment_request`
notification per student (`:438-464`). So a **one-day** typo on a class that has
registrations is already irreversible in the app and sends real payment requests
for a class that never happened. The queue deletion is what the year-typo adds
on top. This is why the guard bounds "in the past" rather than "more than 365
days past": the narrower rule would close the issue's title and leave the more
frequent harm open.

---

## 2. Decisions taken

1. **The rule is "not in the past", not "not more than N days in the past".**
   Option 1 of the issue, chosen over option 2 (a window) because of correction
   (d): inside any window the class still auto-completes and still bills, so a
   window would have to be picked as a billing policy rather than as a typo
   guard, and correction (c) removes the backfill argument that motivated it.
2. **Two doors are guarded: `updateClass` and the publish transition.** Create
   is left unguarded — see §6.
3. **Service policy only. No DB trigger, no CHECK constraint.** See §3.
4. **`StudioClass` is untouched.** See §6.

---

## 3. The rule, stated precisely

> **No write may newly place a `Class`'s start instant in the past.**

Deliberately not "no live class may have a past start instant". That state is
legitimate and the system produces it routinely:

  - `generateClassInstances` computes its first occurrence as *on or after*
    today (`src/services/class-generator.ts:45-60`) and writes `status: 'open'`
    (`:199`). Run at 14:00 on a Tuesday against a Tuesday-09:00 template, it
    correctly creates an `open` class whose start is already past.
  - Any class sitting `open` simply starts, and stays `open` for up to the 60
    seconds until the next sweep tick.

**This is why the guard is service policy and cannot be a database
constraint.** It is the #247 asymmetry reached from the other side: that spec
put the `date` freeze in a trigger because a real invariant existed for the
deleting sweep to depend on. Here there is no invariant — only a rule about
which *writes* are allowed — so the database has nothing to hold. A `now()`-based
CHECK would additionally reject every past-dated test fixture and seed row.

A future author reading "classes cannot start in the past" and hardening it into
a constraint would break recurring generation. That sentence is the reason this
section exists.

---

## 4. The shared predicate

In `src/lib/timezone.ts`, beside `classStartInstant` (`:130`) — which it wraps,
so it introduces no new import chain and no new exposure to `@/lib/log`:

```ts
export function startsInPast(
  date: Date,
  startTime: string,
  timeZone: string,
  now: Date,
): boolean {
  return classStartInstant(date, startTime, timeZone) < now;
}
```

`now` is **required, not defaulted**. Same reasoning as `CompletionTiming`'s
docblock in `class-lifecycle.ts`: a caller that wants to skip or shift the clock
has to say so, and tests get determinism without stubbing `Date`.

The helper is thin — one comparison — and that is acknowledged rather than
hidden. It earns its place by giving the rule one name, one docblock, and one
place to pin timezone and DST behaviour, instead of two call sites that drift.

Strictly `<`, so a class starting exactly now is allowed.

---

## 5. The two doors

### 5.1 `updateClass` — the data-loss path

**Result variant.** A new member of `UpdateClassResult`:

```ts
| { ok: false; reason: 'past_start'; startsAt: Date }
```

It carries the computed instant for the same reason `locked` carries its fields
and `terminal` carries its status: that type's docblock says the caller owns the
wording and needs to name what happened.

**The opening read** (`class-lifecycle.ts:741`) gains
`include: { teacher: { select: { defaultTimezone: true } } }` — the shape
`completeClass` (`:337-343`) and both transition sweeps already use.

**Placement: immediately after the terminal early return at `:754-756`, before
the economic `locked` check.** Two reasons, both load-bearing:

  - `terminal` must keep winning. Two #247 tests
    (`src/services/class-lifecycle.test.ts:1446`, `:1460`) send
    `date: new Date('2020-01-01')` to a `completed` and a `cancelled` class and
    expect `reason: 'terminal'`. A guard placed above the terminal check flips
    both, and would be answering "that date is in the past" about a class whose
    date cannot move for a different and stronger reason.
  - `past_start` is a whole-request refusal, like `terminal`; `locked` is a
    field-level one. Grouping the two whole-request refusals is the honest
    ordering. Measured: no existing test sends a past date together with an
    economic field, so this precedence flips nothing.

**Condition.** Fires only when `data.date !== undefined || data.startTime !==
undefined`, against the merged effective values — `data.date ?? cls.date` and
`data.startTime ?? cls.startTime`. A description edit on a class that started
two minutes ago and has not yet been swept stays legal, which is the point of
the conjunct.

**One enforcement point, not two.** The terminal freeze needs both an early
return and a CAS conjunct because a completion can commit between the opening
read and the write. This guard has no such race: the incoming date and time are
fixed by the request, and the stored fallbacks can only be changed by a writer
that is itself now guarded. This asymmetry goes in the docblock, or a reviewer
will reasonably ask why the CAS was left alone.

**Route.** `PUT /api/classes/[id]` maps it to **409** with code
`CLASS_STARTS_IN_PAST`, alongside `CLASS_TERMINAL` (`:84-85`) and the two
conflict codes. 409 rather than 400 for the same reason `terminal` is 409 and
the route already states at `:78-83`: the request is well-formed and the teacher
does own the class, so it conflicts with a state rather than with the input's
shape.

**The route mapping is compiler-enforced.** `src/app/api/classes/[id]/route.ts`
ends with `const unhandled: never = result` (`:112`), so adding the variant is a
build error until the route answers it. This is a guard that can fail, verified
by construction rather than by inspection.

### 5.2 `transitionClass` — the no-typo path

The publish door needs no typo at all, only elapsed time: a teacher drafts
Monday's class for Friday, does not publish it, and publishes the following
week. `transitionClass` (`class-lifecycle.ts:215-262`) has **no date predicate
anywhere** — its CAS is `status: { in: sourceStatesFor(targetStatus) }` and its
only other check is `validateTransition`.

**Reason.** `'STARTS_IN_PAST'` joins `TransitionFailureReason` (`:113-117`).

This slightly widens `completeClass`'s type too, because both it (`:328`) and
`transitionClass` (`:216`) return `TransitionDbResult` (`:181-183`). Accepted,
and precedented: `NOT_ENDED_YET` is *already* a member that only `completeClass`
returns and `transitionClass` never does. The union is a superset over both
functions, documented as such by that existing member; this mirrors it exactly.

**Condition: `targetStatus === 'open'` only.** That is precisely publish.
`transitionClassSchema` (`src/lib/schemas.ts:382-384`) admits four targets:
`cancelled` never reaches this function (the route intercepts it at `:34`),
`draft` is never a legal target under `VALID_TRANSITIONS`, and `open ->
in_progress` is a teacher starting a class early — where a past start is not
only normal but expected.

**Placement: before the transaction**, reading `{ date, startTime, teacher:
{ select: { defaultTimezone: true } } }`.

The pre-CAS read can go stale, and only in the safe direction. Once §5.1 is in
place a class's stored start instant can never move into the past, so the read
cannot understate it. It *can* be overtaken by the clock — read at 08:59:59.9
for a 09:00 class, CAS at 09:00:00.1 — which publishes a class whose start has
just passed. The window is milliseconds and the outcome is identical to
publishing it a second earlier, which is legal. Recorded rather than closed.

**Route.** No change needed: `transition/route.ts:129` already maps every reason
but `NOT_FOUND` to 409.

---

## 6. Out of scope, and why each

**`POST /api/classes` (create) is left unguarded.** A past-dated class is
created `draft` (`route.ts:80`), no sweep selects drafts, and no registration
can attach to one (`registrations/route.ts:131-133`). It is inert until
published, and publication is guarded by §5.2. A create guard would also need a
second read for `Teacher.defaultTimezone`, which that route does not currently
take — it reads only `teacherRoom`. This is a decision, not an omission: the
gate is publication, and the gate is covered.

**`generateClassInstances` is left unguarded.** Its same-day instance is
intended behaviour (§3), it writes through `prisma.class.create` rather than
through either guarded service, and guarding it would break recurring
generation on the template's own weekday.

**No DB trigger and no CHECK constraint.** See §3 — there is no invariant to
enforce, and a `now()`-based constraint would reject fixtures and seed rows.

**`StudioClass` is structurally out of reach**, and this was measured rather
than assumed:

| What #249 needs | `Class` | `StudioClass` |
|---|---|---|
| A route that moves `date` | `updateClassSchema.date` (`schemas.ts:358`) | **none** — `updateStudioClassSchema` (`:477-484`) is `.strict()` over six fields and `date` is not among them; the route says so at `[id]/route.ts:58` |
| A status machine to walk to terminal | `ClassStatus` + three sweeps | **none** — no status column (`prisma/schema.prisma:517-536`); cancellation is a nullable `cancelledAt` |
| A queue to reap | `WaitlistEntry` | **no relation** |
| Registrations to bill | `Payment` per registration | **no relation** — `studentCount` is a bare `Int?` |

All three harms are absent by construction, and the premise has no route to
travel on.

**#247 is unaffected.** Its post-terminal freeze ships exactly as it is, both
layers unchanged. This branch guards the window *before* terminality, which is a
different rule at a different moment.

---

## 7. Blast radius on the existing suite

Measured, not estimated. `FIXTURE_DATE` in `class-lifecycle.test.ts:1259` is
`'2099-06-01'` — the fixtures are in the future — and exactly four `updateClass`
calls in the suite send a `date`, all of them `2020-01-01`. None sends a
`startTime`. Of the four:

| Site | Class status | Effect |
|---|---|---|
| `:1446` | `completed` | unaffected — terminal answers first |
| `:1460` | `cancelled` | unaffected — terminal answers first |
| `:1835` | stub, `completed` | unaffected — terminal early return |
| `:1793` | stub, **`open`** -> `completed` | **flips** |

`:1793` is the test that proves #247's CAS disambiguation branch is reachable:
it stages a completion committing between the opening read and the write and
asserts `updateManyCalls` has length 1. The new guard answers before any write.

**The failure is loud, and the hazard is what someone does about it.** Its
assertion is `toEqual({ ok: false, reason: 'terminal', status: 'completed' })`
over the whole object (`:1794`), so a `past_start` result fails the comparison
outright — the test goes red, it does not quietly pass. The trap is the obvious
repair: updating the expectation to `past_start` makes it green again and
**deletes all coverage of #247's disambiguation branch**, the branch whose
absence turns the single most likely request in that issue into a 500. That
branch would then be untested, and nothing would say so.

Correct fix: change the *payload* to a future date, not the expectation.
`sentEconomic` stays `null`, so it reaches the CAS and exercises the identical
branch for the identical reason. The plan must name this explicitly; it is not
a judgement call for whoever sees the red test.

`stubDb` (`:1659-1698`) also grows `date`, `startTime` and
`teacher.defaultTimezone` defaults on its first read, since the opening read now
includes them. Future-dated defaults, so every existing stub case behaves as it
did.

---

## 8. Tests, and the mutation that proves each

Every guard gets a test, and every test gets a mutation that makes it red. The
mutation's exact error text is recorded, then the mutation is reverted and the
suite re-run — a guard that compiles but cannot fail certifies nothing.

| # | Guard | Test | Mutation that must turn it red |
|---|---|---|---|
| T1 | `updateClass` refuses a past date | a live `open` class, `date` moved to last year, expects `{ ok: false, reason: 'past_start' }` **and asserts the stored `date` did not move** | delete the guard |
| T2 | The date/startTime conjunct is doing work | a live `open` class whose start has already passed, edited with `{ description }` only, expects `ok: true` | make the guard unconditional (drop the `date`/`startTime` test) |
| T3 | The merge uses stored fallbacks | a class dated **today at 20:00** (still future), edited at 14:00 with `{ startTime: '08:00' }` and no `date` — today 08:00 has gone, so `past_start` | change the fallback to ignore `cls.date` |
| T4 | `transitionClass` refuses publishing a stale draft | a `draft` dated yesterday, target `open`, expects `STARTS_IN_PAST` **and asserts the status is still `draft`** | delete the guard |
| T5 | The publish guard is target-scoped | an `open` class whose start has passed, target `in_progress`, expects `ok: true` | drop the `targetStatus === 'open'` condition |
| T6 | `startsInPast` is timezone-correct | `2026-06-15` 23:00 in `Pacific/Auckland` (= 11:00 UTC) against `now` = `2026-06-15T06:00Z`. Correct: not past. UTC-midnight-naive: past. **Opposite answers** | replace `classStartInstant` with a UTC-midnight comparison |
| T7 | The route answers 409, not 500 | integration: `PUT` a past date over HTTP, expect 409 and code `CLASS_STARTS_IN_PAST` | change the route mapping to 400 |

**T6 is the one that can be written so it cannot fail**, and `prisma/seed.ts`
carries a comment warning about exactly this: a fixture chosen at the wrong hour
makes the timezone-aware and timezone-naive paths agree, and the test passes
against the bug. The numbers above are given rather than described for that
reason — the implementer must not choose the window. Re-derive them if the
fixture changes, and record the derivation.

**T2 and T5 are the conjunct tests**, and they matter more than they look. Each
proves that a narrowing condition is load-bearing rather than decorative — the
class of defect #247's review found three times.

The route mapping needs no separate existence test: `route.ts:112`'s
`const unhandled: never` makes an unhandled variant a build failure.

---

## 9. Artifacts to correct

A claim gets corrected in every place it lives, and each location gets its own
verdict.

1. **`src/services/waitlist-retention.ts:108-121`** — the residual paragraph.
   Two corrections, not one: it says the path is "filed as #249, deliberately
   left open", which becomes closed-and-by-what; **and** it frames the route to
   terminality as `autoTransitionToInProgress` then `autoCompleteClasses`, the
   single-route framing that issue 249's own follow-up comment flagged as
   misleading — a manual cancel gets there in one request.
2. **`docs/superpowers/specs/2026-08-17-terminal-class-freeze-design.md` §7** —
   the same two corrections. Its "Not attempted: bounding `isoDate`" note also
   needs its successor named, since this branch bounds the start instant in the
   service rather than the string in the schema.
3. **`CLAUDE.md`, Class Lifecycle** — one line for the new rule, beside the
   `settings_locked` and terminal-freeze lines.
4. **Issue 249** — a closing comment recording what was measured, including the
   four corrections in §1.1.

---

## 10. Acceptance

- A live class cannot be moved to a start instant that has already passed, and
  the refusal is a typed reason the route answers 409 with a distinguishing
  code, not a 500.
- A draft whose start has passed cannot be published, and that refusal is 409
  too.
- Both refusals are proven by a test, and each test is proven by a mutation
  whose error text is recorded in the PR body.
- The narrowing conjuncts (`date`/`startTime` touched; `targetStatus === 'open'`)
  each have a test that goes red when the conjunct is removed.
- A refused edit writes nothing — asserted against the stored row, not inferred
  from the return value.
- The service refuses independently of the UI. `min` on the two class date
  inputs is a convenience; deleting it changes no test outcome.
- Recurring generation is unaffected: `generateClassInstances` can still emit a
  same-day instance whose start has passed.
- `docs/superpowers/specs/2026-08-17-terminal-class-freeze-design.md` §7 and
  `waitlist-retention.ts`'s residual paragraph both state the path is closed,
  and neither still describes the two-sweep route as the only one.

---

## 11. Residuals, stated rather than left implicit

- **A past-dated `draft` can still be created.** Inert by §6, and its
  publication is refused.
- **The publish guard's pre-CAS read can be overtaken by the clock** by
  milliseconds, in the safe direction only (§5.2).
- **The generator can still produce an `open` class whose start has passed.**
  Intended (§3).
- **A class already `open` when its start passes stays `open`** for up to one
  sweep tick. Unchanged by this branch, and not a defect.
