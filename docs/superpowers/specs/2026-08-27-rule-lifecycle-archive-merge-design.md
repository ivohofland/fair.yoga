# Stage C1: `archiveOrUnarchive` becomes one implementation over `ScheduleRule`

**Issue:** #332 · **Stage:** C1 of the #297/#298 decision (A = #315/PR #326, B = #327/PR #330)
**Date:** 2026-08-27

---

## 1. The premise, re-derived

#332 shipped a re-derivation command for every count it claimed. Running them
on 2026-08-27, after PR #334 merged:

### Held exactly

| Claim | Command | Result |
|---|---|---|
| `LastScheduledClass` imported at line 61 | `grep -n 'LastScheduledClass' src/services/studio-class-template-lifecycle.ts` | ✅ 61 |
| `generationState`/`firstFreeWeek`: 9 class, 0 studio | `grep -c 'generationState\|firstFreeWeek' src/services/class-template-lifecycle.ts src/services/studio-class-template-lifecycle.ts` | ✅ 9 / 0 |
| C1 was never blocked on stage B | both functions already CAS against `ScheduleRule` | ✅ |

One thing #332 did not check but which strengthens its own C2 argument: **all
nine `generationState`/`firstFreeWeek` occurrences sit in `update` territory** —
lines 53, 427, 434, 473, 638, 748, 1131, 1137, 1138, which are
`probeFirstEffectiveWeek`, `updateClassTemplate` and `UpdateClassTemplateResult`.
Zero fall inside the four C1 functions. C2's blocker cannot leak into C1.

### Wrong

**(a) All four line numbers drifted.** PR #334 (the #331 deadlock fix) landed
the same day #332 was written and moved every one:

```
1449 → 1451  pauseOrResumeTemplate
1920 → 1922  archiveOrUnarchiveTemplate
1032 → 1042  pauseOrResumeStudioTemplate
1419 → 1429  archiveOrUnarchiveStudioTemplate
```

Re-derive: `grep -nE '^export (async )?function (pauseOrResume|archiveOrUnarchive)' src/services/*class-template-lifecycle.ts`

The *names* survived and the *numbers* did not, which is the argument for
shipping the command rather than the line.

**(b) "identical docblocks" is false, and it inverts the difficulty estimate.**

| Function | Total | Code | Comment |
|---|---:|---:|---:|
| `pauseOrResumeTemplate` | 459 | 146 | 313 |
| `archiveOrUnarchiveTemplate` | 658 | 153 | 505 |
| `pauseOrResumeStudioTemplate` | 413 | 127 | 286 |
| `archiveOrUnarchiveStudioTemplate` | 326 | 108 | 218 |
| **Total** | **1856** | **534** | **1322** |

Re-derive, per function, over its docblock-plus-body range:

```sh
sed -n 'A,Bp' <file> | grep -vE '^[[:space:]]*(//|\*|/\*)' | grep -cvE '^[[:space:]]*$'
```

534 lines of code under 1322 lines of comment. The docblocks are not identical —
they are four divergent copies that cross-reference each other ("check there
before editing this", "a future edit to either owes the other the same visit").
**The code merge is the small half; the prose merge is the work.** §5 is where
that lands.

**(c) "same failure reasons" is false.** Measured below — `PauseTemplateResult`
carries `room_archived` and `PauseStudioTemplateResult` does not.

**(d) A behavioural divergence #332 does not mention, and it is a defect.** §4.

---

## 2. Scope

**In:**

1. Merge `archiveOrUnarchiveTemplate` and `archiveOrUnarchiveStudioTemplate`
   into one `archiveOrUnarchiveRule` in a new `src/services/rule-lifecycle.ts`,
   parameterised by a `TemplateFamily<TChild>` descriptor.
2. Fix the studio `pauseOrResume` CAS-miss residual: it throws (500) where the
   class family answers `busy` (503). §4.
3. Record the C1b deferral with a measured, checkable trigger. §6.

**Out:**

- `pauseOrResume`'s merge — deferred as **C1b**, §6, with the trigger written
  the way #328's was.
- `update`'s merge — **C2**, unchanged, still blocked on #284 (`OPEN`:
  *"Studio generation becomes week-keyed, and the template edit says so"*).
- `withSlot` / `*WithSlot`. Measured byte-identical modulo the child type name
  and therefore mergeable, but folding them touches the GET routes that import
  the per-family versions, which widens the diff past the two archive
  functions. **Not filed** — it is visible-not-worsened debt (§7 test 3 of the
  solve-issue skill), and C1b will have to touch these types anyway.

---

## 3. The archive merge

### 3.1 Every difference, measured

Normalise the family-specific *names* away and diff the two bodies with comments
stripped, so only structure survives:

```sh
strip() { sed -n "$2,$3p" "$1" | grep -vE '^[[:space:]]*(//|\*|/\*)' | grep -vE '^[[:space:]]*$'; }
strip src/services/class-template-lifecycle.ts 1922 2555 > /tmp/a
strip src/services/studio-class-template-lifecycle.ts 1429 1734 > /tmp/b
diff /tmp/a /tmp/b
```

150 class code lines against 105 studio. **Five difference sites, no more:**

| # | Site | Class | Studio | Becomes |
|---|---|---|---|---|
| 1 | Prisma delegate (×3) | `db.classTemplate` | `db.studioClassTemplate` | descriptor field |
| 2 | Raw table literal (×1) | `"ClassTemplate"` | `"StudioClassTemplate"` | descriptor field |
| 3 | `scheduledWhere` | 3-arg, `classes:{some:{status}}` conjunct | 2-arg, `kind:'studio'` | descriptor field |
| 4 | Log noun (×2) | `"recurring class"` | `"studio class"` | descriptor field |
| 5 | Ordered pre-lock + waitlist read (25 lines) **before** the delete, and survivor-diff + withdrawal notifications (18 lines) **after** it | present | absent | **hook** |

Site 5 is one hook, not two, because the two halves share state: the
`candidates` read must happen before the `deleteMany` and the survivor diff
after it. The hook therefore brackets the shared delete and threads its own
state:

```ts
type WithdrawHook = {
  before: (tx: TransactionClientOnly, ctx: WithdrawContext) => Promise<WithdrawState>;
  after: (tx: TransactionClientOnly, ctx: WithdrawContext, state: WithdrawState) => Promise<void>;
  /** Extra `Class`-side conjunct for the delete's predicate — `registrations: none charged`. */
  deleteFilter: Prisma.ClassWhereInput;
};
```

### 3.2 The fact that makes this merge safe

Compare the two archive result unions mechanically:

```sh
sed -n '1290,1343p' src/services/class-template-lifecycle.ts | grep -oE "reason: '[a-z_]+'|action: '[a-z]+'" | sort -u
sed -n '889,957p'   src/services/studio-class-template-lifecycle.ts | grep -oE "reason: '[a-z_]+'|action: '[a-z]+'" | sort -u
```

Both produce the identical seven-arm set:

```
action: 'archived'  action: 'unarchived'  action: 'unchanged'
reason: 'busy'  reason: 'forbidden'  reason: 'not_found'  reason: 'slot_conflict'
```

**Every archive difference lives inside the transaction body. None reaches the
public type.** That is what a side-effecting hook can express and what makes the
descriptor a dispatch table rather than a runtime family test.

### 3.3 The public result types stay distinct

`ArchiveTemplateResult` and `ArchiveStudioTemplateResult` are **not** merged,
even though their arms agree today. `template-action-messages.ts:396-460`
already decided this one layer up and recorded the measurement:

> "Split from `TemplateToggleResponse` rather than adding optional fields to its
> shared `active` arm. The optional-field version is the smaller diff and
> **certifies nothing**."

That is #93/#119/#136. `archiveOrUnarchiveRule` is generic in the child type and
returns each family's own union; the two services keep thin exported wrappers.

### 3.4 The descriptor, and its exhaustiveness tether

`prisma/schema.prisma:471` is `enum ClassFamily { regular, studio }`, and its own
docblock at line 468 anticipates growth: *"a future variant of this enum needs
that CHECK"*. So the families get the `COUNT_KEYS` treatment:

```ts
const FAMILY_BY_KIND = {
  regular: CLASS_FAMILY,
  studio: STUDIO_FAMILY,
} satisfies Record<ClassFamily, /* see the variance note below */ …>;
```

A third `ClassFamily` variant becomes a compile error here rather than a silent
gap. Three constraints on that, all load-bearing:

- **The value type of that `Record` is a variance question, not a formality, and
  it is deliberately left open here.** `TemplateFamily<never>` is the obvious
  spelling and may well not compile: `TChild` appears in return positions
  (`WithSlot<TChild>`), so `TemplateFamily<ClassTemplate>` is not assignable to
  `TemplateFamily<never>` under covariance. `unknown` pins key completeness
  only — which is all this tether is for, since each constant is already pinned
  by its own annotation — and that may be the right answer. The plan compiles
  the candidates and picks one; it does not inherit a type expression from this
  spec that nobody has built.

- **`TemplateFamily` has no optional fields.** The class-only hook is
  `withdraw: WithdrawHook | null` — *required, explicitly `null`* for studio.
  An optional field is exactly the hole where a third family is half-defined and
  nothing complains, which is the failure the tether exists to close.
- **The registry must not create an import cycle.** `rule-lifecycle.ts` is
  imported *by* the two services and must not import them back — doing so would
  drag class-only waitlist and notification code into the shared module. The
  plan owns choosing where `FAMILY_BY_KIND` lives (a third module, or a
  compile-only pin in a test) rather than discovering the cycle mid-task.

### 3.5 The stop condition, evaluated

#332: *"If merging forces a parameter that exists only to tell the two families
apart at runtime, stop and record it."*

A descriptor record is a **dispatch table** — each family's entry is complete on
its own and nothing in `archiveOrUnarchiveRule` asks which family it is holding.
An `if (family === 'regular')` inside the merged body **is** the forbidden thing
and its appearance is a stop.

The distinction is checkable, and the plan must pin it: **`rule-lifecycle.ts`
contains no comparison against a `ClassFamily` literal.**

---

## 4. The defect: the studio residual throws where the class family answers `busy`

### 4.1 What was measured

Both `pauseOrResume` functions run the same CAS
(`where: { isArchived: false, isActive: !desiredActive }`) and, on a miss,
re-read and classify. Two classifications are checked; a row that changed back
between the two statements' READ COMMITTED snapshots matches neither.

| Family | Residual behaviour | Surface |
|---|---|---|
| class | `log.warn(...)` then `return { outcome: 'busy' }` | 503 `TEMPLATE_BUSY` |
| studio | `throw new Error(...)` | **500, logged at `error`** |

`git log --oneline --all -S "recurring class pause/resume CAS missed and the re-read matched no classification"`
gives `aed305f8 fix: the residual CAS miss answers busy, not a 500 (issue 116)`.
The class side was fixed; the port never happened.

`docs/backlog-roadmap.md:1597` records the lesson from that round:

> **"Residual, not provably unreachable" written in a comment is an invitation
> to go reach it, not a disclaimer** — and the cost of not trying was that the
> branch shipped a 500 where it had a 503 sitting unused in its own union.

The studio comment still reads *"Residual, not provably unreachable this time"*
directly above the throw. The class comment claims *"the two families agreeing
matters more than a distinction only this branch drew"* — while they do not
agree.

**The studio residual has no test; the class residual has had one since
`aed305f8`.** That commit added
`class-template-lifecycle.test.ts:2859`, `'answers busy when the CAS miss
lands in the residual fourth state'`, and it is mutation-proof: replacing its
`return { outcome: 'busy' as const }` (`class-template-lifecycle.ts:1659`)
with a throw turns it red. The grep above is keyed on log-message strings
(`"matched neither the CAS"`, `"CAS missed and the re-read"`); a test that
asserts a *result* rather than a log line contains neither string, so that
grep could not have found it and its absence from the hits is not evidence of
its absence from the file.

### 4.2 Why this is a defect and not a curiosity

Reachability, written out (solve-issue §7 — "will hit", not "could hit"):
a resume commits between this transaction's own read and its CAS, so the CAS
misses on `isActive`; a pause commits before the re-read, so the re-read sees
neither already-desired nor archived. Both are ordinary writes from a second
tab or the hourly sweep. Nothing blocks the path. #116's review reached the
class-side analogue three independent ways.

The consequence is a 500 at `error` — the paging level — for a transaction that
matched zero rows and rolled back clean, i.e. exactly what `busy` means
everywhere else in these files.

### 4.3 The fix, and why it is small

`PauseStudioTemplateResult` **already has a `busy` arm** and the studio route
already answers it 503 `STUDIO_TEMPLATE_BUSY`. Only the *internal*
`ResumeTransactionOutcome` lacks the arm. So:

1. Add `| { outcome: 'busy' }` to studio's `ResumeTransactionOutcome`.
2. Replace the throw with the class family's `log.warn` + `return { outcome: 'busy' }`.
3. Add `case 'busy':` to studio's post-transaction switch.

**No wire change, no copy change, no public type change.**

### 4.4 Proving it — and the second mutation row

The test builds the interleaving with the `$extends` `query` hook these files
already use (`class-template-lifecycle.test.ts:908`, `:986`), deterministically
and with **no `setTimeout`**:

```
hook <child>.findUnique       → after query(): commit isActive = true
                                (the CAS's `isActive: false` now misses)
hook scheduleRule.updateMany  → after query(): commit isActive = false
                                (the re-read matches neither classification)
                                → residual reached
```

Mutations — three, and **row 2 is the one that matters**:

| # | Mutation | Expect |
|---|---|---|
| 1 | Studio residual: restore the `throw` | studio test RED |
| 2 | **Class residual: replace `return { outcome: 'busy' }` with a `throw`** | **class test RED** |
| 3 | Delete `case 'busy'` from studio's post-transaction switch | compile error via the `never` default |

Row 2 exists because **the class test is written green**, against code that
already passes — so nothing otherwise proves it asserts anything. A test written
green needs its own mutation more than one written red does.

### 4.5 The fallback, stated in advance

If the interleaving resists, the answer is **not** a unit test of the outcome
mapping. That is the shape solve-issue §3 names — a pin that compiles but cannot
fail — because the claim under test is that the residual is *reached* and
answered, not that a switch has an arm. In order:

1. The held-lock barrier plus `expect(...Settled).toBe(false)` guard already in
   `studio-class-template-lifecycle.test.ts:1140`.
2. `template-lock-order.test.ts`'s two-connection harness.
3. If neither works, the finding is "the residual is unreachable in this
   family" — a spec-changing result to report, not a smaller test to substitute.

**On timing sensitivity.** Stage B's plan mandated determinism at
`2026-08-25-calendar-entry-extraction.md:951` (*"Drive the interleaving
deterministically — no `setTimeout`"*) and line 1304 records it folded in. It
did **not** retrofit the pre-existing sleeps:
`grep -c setTimeout src/services/{class,studio-class}-template-lifecycle.test.ts`
gives **4** and **10**. Those are not vacuous — the correctness mechanism is a
held-lock barrier and each sleep is followed by a not-settled assertion — but
this branch adds no new ones.

---

## 5. The prose, which is the larger half

1322 comment lines against 534 of code (§1b). Merging two archive bodies leaves
their two docblocks with one owner and, by #332's own hazard, **orphans the
cross-references that named the other copy**:

> A keyword sweep finds stale names, never a stale description. The identical
> docblocks that make C1 easy are four copies of the same prose; merging them
> leaves three orphans that name no object and only describe one wrongly.

Rules for this branch, from CLAUDE.md's *Comment Discipline*:

- **Sweep for what was invalidated, not for what was edited.** After the merge,
  list what was *removed* — `archiveOrUnarchiveStudioTemplate` as a body,
  the studio `scheduledWhere`'s standalone role, the studio throw — and grep for
  those names. Expect legitimate survivors and give each hit a verdict.
- **Read whole docblocks in the touched functions.** A grep finds a stale name,
  never a stale description. The remaining cross-family sentences
  ("mirrors `archiveOrUnarchiveTemplate`", "see there for the reasoning",
  "a future edit to either owes the other the same visit") describe an
  arrangement that no longer exists and name no object that a sweep can find.
- **Runtime log strings are in scope.** `docs/lock-order.md` carries 18 hits for
  these four names (`grep -c 'pauseOrResume\|archiveOrUnarchive' docs/lock-order.md`),
  including all four rows of the lock-node table at `:1238`, `:1239`, `:1241`
  and `:1242`.
- **Replace, don't annotate.** No "this previously read X". The before-and-after
  goes in the PR body.

---

## 6. C1b: the deferral, and what makes it come due

### 6.1 What is actually in the way

The same normalised diff over the two `pauseOrResume` bodies (146 class code
lines, 127 studio) leaves three differences once the cosmetic hunks are
subtracted — `as const` noise, `catch (err: unknown)` vs `catch (err)`, and
where the `paused` read-back sits relative to the post-transaction switch, all
behaviour-identical.

| Difference | Verdict | Measured evidence |
|---|---|---|
| CAS-miss residual: `busy` vs `throw` | **accidental — a defect** | §4; `aed305f8` fixed one side and the port never happened |
| claim + generate pair | **descriptor, not essential** | both are `claim(tx, id) → Promise<XWithTimezone \| null>` and `generate(db, XWithTimezone, from?) → Promise<GenerationResult>` — `class-generator.ts:744`/`:208`, `studio-class-generator.ts:74`/`:159`. Structurally identical; a `{claim, generate}` descriptor entry types cleanly |
| **Room guard** (12 lines) | **ESSENTIAL** | it is the only difference that **widens the public result union** |

The room guard's evidence, mechanically:

```sh
sed -n '1201,1290p' src/services/class-template-lifecycle.ts        | grep -oE "reason: '[a-z_]+'" | sort -u
sed -n '801,889p'   src/services/studio-class-template-lifecycle.ts | grep -oE "reason: '[a-z_]+'" | sort -u
```

The two sets differ by exactly one arm: `room_archived`, class only. Giving the
studio family a reason it can never produce, or making it optional, is the
"certifies nothing" failure §3.3 cites. So the deferral rests on **one**
condition, not two — and it is checkable rather than arguable:

> **C1b comes due when `PauseTemplateResult` and `PauseStudioTemplateResult`
> have the same reason set.**
>
> ```sh
> diff \
>   <(sed -n '/^export type PauseTemplateResult/,/^$/p'      src/services/class-template-lifecycle.ts        | grep -oE "reason: '[a-z_]+'" | sort -u) \
>   <(sed -n '/^export type PauseStudioTemplateResult/,/^$/p' src/services/studio-class-template-lifecycle.ts | grep -oE "reason: '[a-z_]+'" | sort -u)
> ```
>
> Empty output means C1b is due. **Re-check, not re-argue.**

### 6.2 What would make that happen

The safety argument for deferring is a property of **where the room invariant is
enforced today**, not of the two families being different in kind. It expires
when any of these lands:

- **#272 lands.** `OPEN`: *"Decide how 'an active template may not sit on an
  archived room' is enforced — five racy doors, no constraint."* Enforcing it
  once in Postgres removes the application doors, `room_archived` leaves
  `PauseTemplateResult`, and the sets converge. **This is the live one.**
- **The room guard moves to a shared pre-flight** both routes call before the
  service, so neither result union carries the reason.
- **The studio family gains rooms.** It will not — CLAUDE.md pins `StudioClass`
  as disconnected from Room — but the condition is listed because the trigger is
  about the *reason sets*, not about the room.

Until one of those exists, the pause pair has an essential difference and
merging it would extract a shared abstraction across a difference nobody has
shown to be accidental — the same error #332 warns C2 against.

### 6.3 What C1 does *not* settle — stated so C1b is not over-claimed

The archive merge will prove that a family-descriptor record can carry delegate,
table literal, predicate, log noun and a hook **with no runtime family test**.
That is the stop condition's real question and it transfers to C1b.

It does **not** settle the room guard, and the spec says so plainly rather than
let the shape imply more: `withdraw` is a **side-effecting hook** — it does extra
work inside the transaction and returns nothing to the caller. The room guard is
a **refusal that widens the return type**. A generic parameterised over the
*result union* is a materially larger claim than one parameterised over *work
done inside a transaction*, and C1 produces no evidence about it.

---

## 7. Baseline

Measured 2026-08-27 on `main` at `ca8325a3`, `npm run verify`, exit 0:

| project | files | tests |
|---|---:|---:|
| unit | 67 | 1014 |
| components | 46 | 302 |
| unit-sweeps | 10 | 123 |
| integration | 33 | 527 |
| **total** | **156** | **1966** |

Reconciles against the two `npm test` invocations: `67 + 46 = 113` files /
`1014 + 302 = 1316` tests, then `10 + 33 = 43` / `123 + 527 = 650`.
Re-derive per project: `npx vitest run --project <p>`.

The `integration` project talks to the app on :3000, so `verify` needs it live.

---

## 8. Acceptance

- `src/services/rule-lifecycle.ts` exports `TemplateFamily<TChild>` and
  `archiveOrUnarchiveRule`. **No field of `TemplateFamily` is optional.**
- `FAMILY_BY_KIND ... satisfies Record<ClassFamily, TemplateFamily<…>>` exists,
  in a location that creates no import cycle, with a mutation proving a removed
  family fails the build.
- **`rule-lifecycle.ts` contains no comparison against a `ClassFamily` literal.**
  Checkable: `grep -nE "'(regular|studio)'" src/services/rule-lifecycle.ts`
  returns nothing outside type positions.
- Both services keep their exported wrappers and their own result unions; the
  four production call sites (one per function, all in route files) are
  unchanged. Re-derive:
  `grep -rnE '(pauseOrResume|archiveOrUnarchive)[A-Za-z]*\(' src/app --include='*.ts'`
  — four hits, two per route file.
- The studio residual answers `busy`; the class residual is unchanged. Both
  covered by a test, both proven by the mutations in §4.4 — **including row 2**.
- Every `docs/lock-order.md` hit for the four names given a verdict, not a
  blanket rewrite.
- `npm run verify` green, with the after-figure **measured, not predicted**.
- PR body: the four drifted line numbers, the 534/1322 measurement, the
  identical-vs-differing reason sets, the C1b trigger, and what C1 does not
  settle. **#284 is unaffected. #272 is left open.**

---

## 9. Provenance

#332 is stage C1 of the #297/#298 decision. It exists because closing #327 left
stage C with no pointer — the mistake `d3b664f1` corrected one stage earlier.

The scope narrowing from "merge all four" to "merge archive, fix the pause
defect, defer the pause merge" came from the direction gate, on three
measurements the issue did not have: the archive result unions are identical
while the pause ones differ by one arm; the pause pair's generator difference is
a descriptor rather than an essential difference; and the busy/throw split is a
defect rather than a design choice. The gate also required that the deferral
carry a checkable trigger rather than an argument (§6.1), that the essential
difference be recorded by measurement rather than assertion (§6.1), and that the
limits of C1's evidence for C1b be stated rather than implied (§6.3).
