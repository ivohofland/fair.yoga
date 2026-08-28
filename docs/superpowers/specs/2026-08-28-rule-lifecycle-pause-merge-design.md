# Stage C1b: `pauseOrResume` becomes one implementation over `ScheduleRule`

Issue #336. Stage C1b of the decision recorded on #297/#298. Stage A shipped as
#315 (PR #326), stage B as #327 (PR #330), stage C1's archive half as #332
(PR #335).

`update` remains **C2** and stays blocked on #284.

---

## 1. The premise, re-derived

### Held

- **The trigger's `diff` is empty.** Both reason sets are
  `archived, busy, forbidden, not_found` — four arms each, identical.
  Non-vacuously so: each side extracts four reasons, so this is not the
  stale-command failure #332 hit on `db-locks.ts`.
- **`room_archived` is gone from both files.** `grep -n room_archived
  src/services/*template-lifecycle.ts` returns nothing.
- **What fired it is the event #332 named as "the live one".** #272 closed
  2026-08-28T12:50Z; `0f45fb32` is the commit.
- **`claim` and `generate` are structurally identical across the families**, as
  #332 §6.1 measured. Re-verified: `claim(tx, templateId) =>
  Promise<XWithTimezone | null>` and `generate(db, XWithTimezone, from?) =>
  Promise<GenerationResult>`.

### Wrong, or incomplete

- **The issue's difference table predates the change that fired its own
  trigger** by 20 hours (filed 2026-08-27T16:43Z; #272 landed
  2026-08-28T12:50Z). Its "room guard — ESSENTIAL" row is stale, and its
  line numbers had drifted (re-derived: studio `:1028`, class `:1358`).
- **The issue predicted the wrong resolution.** It listed "the room guard moves
  to a shared pre-flight *both routes call*" as a firing condition. #272 did
  something better: enforcement went into a Postgres CHECK, and the friendly
  message into a *class-route* pre-check. The shared TypeScript needs no
  pre-flight, no descriptor entry and no runtime family test to express it.
- **`scheduledWhere` does not need to become a descriptor entry.** Both
  families already define `remainingWhere` as literally
  `scheduledWhere(scheduleRuleId, { gte: today })`, which is exactly what
  pause's count calls. The descriptor grows by two fields, not three. See §3.3.
- **The issue's `TKind` sketch does not compile as written.** Measured, §4.1.
- **The issue's own excess-property caveat is correct**, and it bounds what the
  `withSlot` fix can claim. Measured, §4.2.

### Re-derivation

```sh
# The trigger. Empty output means C1b is due; both sides must be non-empty.
diff \
  <(sed -n '/^export type PauseTemplateResult/,/^$/p'      src/services/class-template-lifecycle.ts        | grep -oE "reason: '[a-z_]+'" | sort -u) \
  <(sed -n '/^export type PauseStudioTemplateResult/,/^$/p' src/services/studio-class-template-lifecycle.ts | grep -oE "reason: '[a-z_]+'" | sort -u)

# The two functions. Do not trust these line numbers; re-derive.
grep -nE '^export (async )?function pauseOrResume' src/services/*class-template-lifecycle.ts
```

---

## 2. Scope

**A pure merge.** The claim this branch makes is *no behaviour change*, and the
2006-test baseline staying green is what proves it.

In scope:

- One `pauseOrResumeRule` over `TemplateFamily`, in `src/services/rule-lifecycle.ts`.
- Both services keep their exported wrappers and their own result unions.
- The two findings #336 carries in from PR #335 (§4).
- The shared-level pin the class-only throw now needs (§5).

Out of scope, deliberately:

- **#301** — `YG001` escaping as a bare 500 from these two functions. Already
  filed; the floor in `solve-issue` §7 is met. It gets strictly cheaper after
  this branch (one catch instead of two), which is the outcome #301 wants. The
  PR body records that. **#301 is unaffected by this branch.**
- **#291** — its premise is falsified; see §6.
- C2 (`update`), which stays blocked on #284. **#284 is unaffected.**

---

## 3. The pause merge

### 3.1 Every difference, measured

Bodies normalised (comments and blank lines stripped, family nouns folded) and
diffed. The hunks cover the whole of both bodies, so this table is complete
rather than a sample.

| Difference | Verdict |
|---|---|
| Room guard | **Gone** — into a CHECK plus a class-route pre-check (§5) |
| `claim` + `generate` pair | Descriptor entry (§3.3) |
| Count predicate | **Already in the descriptor** as `remainingWhere` (§3.3) |
| Log noun, child delegate | Descriptor — `logNoun` and `readChild` already exist |
| `as const` on outcome literals; `catch (err: unknown)` vs `catch (err)` | Cosmetic |
| Local names (`skipCounts`/`counts`, `bareT`/`bareClaimed`) and the order of two `const`s | Cosmetic |
| `paused` arm inside the `switch` vs breaking out of it | Placement only — identical query, identical returned shape |

**No essential difference remains.**

```sh
# Code lines per body (re-derive the extents first, they drift):
strip() { sed -n "$2,$3p" "$1" | grep -vE '^[[:space:]]*(//|\*|/\*)' | grep -vE '^[[:space:]]*$'; }
```

Measured 2026-08-28: class `1358-1762`, **140** code lines of 405 total; studio
`1028-1409`, **142** of 382. #332 §6.1 measured 146 and 127 — the class side
lost the room guard, and the studio side gained PR #335's CAS-miss residual fix.
They have converged.

### 3.2 What makes this merge safe — and what the trigger does not prove

**The trigger passed by relocation, not removal, and it cannot tell the two
apart.**

#332 chose the reason-set `diff` as a proxy for "is there still an essential
difference?", because at the time the difference lived in the result union.
#272 moved it to the exception channel — somewhere the proxy does not look. The
proxy went green without being able to see why.

That is harmless *here*, and the reason is specific rather than general: the
exception channel is already family-agnostic. Both catches are behaviour-
identical today —

```
if (isTransientDbError(err)) { log.warn(…); return { ok: false, reason: 'busy' }; }
throw err;
```

— and `23514` is in neither `TRANSIENT_SQLSTATES` (`40001`, `40P01`, `55P03`)
nor `TRANSIENT_PRISMA_CODES` (`P2024`, `P2028`, `P2034`), so it rethrows. The
studio family has no such constraint and never produces one. The asymmetry costs
the shared code nothing, in the same way `withdraw: null` costs it nothing —
except that here the declining is done by the schema rather than by a field.

Had #272 instead moved the refusal to a class-only early return inside the
transaction, **the trigger would still be empty and the merge would not be
safe.** So: what licenses this merge is §3.1's body diff. The trigger is a
necessary condition that got the right answer for an incomplete reason, and this
spec says so rather than letting a green check imply more.

### 3.3 The descriptor grows by two fields

`claim` and `generate`. Not three: pause's count and archive's `remaining`
count are the same predicate in both families —

```
CLASS_FAMILY.remainingWhere  = (id, today) => scheduledWhere(id, { gte: today })
STUDIO_FAMILY.remainingWhere = (id, today) => scheduledWhere(id, { gte: today })
pause's count                =                scheduledWhere(id, { gte: today })
```

— and that is deliberate, not coincidental. `PauseTemplateResult`'s `active`
arm already promises it in prose: *"the same predicate and boundary `remaining`
uses, so archiving and resuming report on one basis."*

**Sharing the field converts that prose promise into a structural one.** Under
CLAUDE.md's comment discipline it is currently an unowned claim — the edit that
falsifies it happens in another function, and the person making it never reads
the sentence. After this branch the two numbers a teacher sees from archiving
and from resuming cannot drift, because one field produces both.

`remainingWhere` is archive's word. Serving two verbs, it is renamed to a
verb-neutral **`standingWhere`** — otherwise the field name becomes a claim
about one verb on something two verbs use, which is the class of stale claim
CLAUDE.md is strictest about. Mechanical: the two descriptors, the shared
archive, the new shared pause, and `rule-lifecycle.test.ts`'s boundary
`describe`.

**No nested `pause: { … }` grouping.** Two fields do not earn it. If C2's
`update` arrives and the descriptor sprouts a third verb's worth, grouping can
be argued then, on evidence.

### 3.4 The public result types stay distinct

`PauseTemplateResult` and `PauseStudioTemplateResult` are **not** merged, even
though their arms now agree. This follows #332 §3.3 and the measurement
`template-action-messages.ts` recorded one layer up: the optional-field version
is the smaller diff and *certifies nothing*. `pauseOrResumeRule` is generic in
the child type and returns each family's own union; the two services keep thin
exported wrappers.

### 3.5 The stop condition

Inherited from #332 and unchanged: *if merging forces a parameter that exists
only to tell the two families apart at runtime, stop and record it.*

Checkable, and the plan must pin it: **`rule-lifecycle.ts` contains no
comparison against a `ClassFamily` literal.** An `if (family.kind === 'regular')`
inside the merged body is the forbidden thing and its appearance is a stop.

---

## 4. The two findings carried in from PR #335

### 4.1 `kind` correlates at compile time — and the issue's sketch is incomplete

Settled by compiling, per #332's lesson that three type decisions went that way
and two were plan defects caught before code.

**The sketch as #336 writes it fails:**

```
error TS2322: Type 'TemplateFamily<…>' is not assignable to
  type 'TemplateFamily<…, "regular">'.
  Types of property 'kind' are incompatible.
    Type 'ClassFamily' is not assignable to type '"regular"'.
```

The constants are annotated `TemplateFamily<ClassTemplate>`, so `TKind` defaults
to the whole union and widens `kind` straight back.

**The step the issue omits:** each constant must carry its own literal.

```ts
export type TemplateFamily<TChild, TKind extends ClassFamily = ClassFamily> = {
  kind: TKind;
  /* … */
};

export const CLASS_FAMILY:  TemplateFamily<ClassTemplate, 'regular'>       = { … };
export const STUDIO_FAMILY: TemplateFamily<StudioClassTemplate, 'studio'>  = { … };

const FAMILY_BY_KIND = { regular: CLASS_FAMILY, studio: STUDIO_FAMILY }
  satisfies { [K in ClassFamily]: TemplateFamily<ChildByKind[K], K> };
```

With that, it compiles clean.

**The mutation that proves it bites**, isolating `kind` — child type kept
correct, only `kind` lying (`{ ...CLASS_FAMILY, kind: 'studio' as const }`
filed under `regular`):

| Shape | Result |
|---|---|
| **With** the correlation | `TS2322` — caught |
| **Without** it (today's `Record<ClassFamily, AnyTemplateFamily>`) | **0 errors** — compiles clean |

So the change adds a guarantee today's shape genuinely lacks. The runtime loop
`expect(family.kind).toBe(kind)` becomes redundant and goes; `TKind` sits in a
property position and is covariant, so it cannot reproduce the invariance
failure that killed #332's two-parameter draft.

### 4.2 `withSlot`'s `rule` parameter — and the limit of the fix

Today `rule` is declared `ScheduleRule`, and most call sites pass
`template.scheduleRule`, which carries the joined `teacher: { defaultTimezone }`.
An adapter that spread `rule` would put `teacher` on the PATCH response and
typecheck. The local `withSlot` implementations *pick* named fields rather than
spreading, so nothing leaks today — the gap is latent, and held by the two
`not.toContain('teacher')` assertions rather than by the type.

C1b adds call sites the issue could not have known about. Today there are four,
of which the archiving arm's `recordedRule` is the only bare one:

```sh
grep -n '\.withSlot(' src/services/rule-lifecycle.ts
```

Pause contributes four more, and **exactly one of them is bare**: the `paused`
arm's `pausedRule`, from a `findUniqueOrThrow` with no `include`. The other
three read through a joined `scheduleRule`.

So the branch ends with **two** bare-passing sites, not one — and #336's option
3, "compose `teacher` in locally at the archiving arm", covers only the site it
was written for. Re-derive the split after the merge rather than trusting this
paragraph; the bare ones are the sites whose rule does not come from a
`.scheduleRule` read.

**The fix:** declare `rule` as the joined shape; the two bare sites compose
`teacher` in from `template.scheduleRule.teacher`, which is already in scope (no
query change); and each adapter destructures it off and voids it, exactly as it
already does for `scheduleRule` on the child:

```ts
withSlot: ({ scheduleRule, ...bare }, { teacher, ...rule }) => {
  void scheduleRule;
  void teacher;
  return withSlot(bare, rule);
},
```

**What that is measured to guarantee, and what it is not.** #336 flags that
TypeScript does not apply excess-property checking to spread-introduced
properties. Probed, because it is the assumption the choice rests on:

| Probe | Shape | Result |
|---|---|---|
| P1 | direct object literal with an excess property | **`TS2353`** — EPC works |
| P2 | `{ ...wide }` assigned to a typed variable | compiles |
| P3 | `() => ({ ...wide })` from a typed function — *the spreading-adapter shape* | **compiles** |
| P5 | destructure-and-discard, spread the remainder | compiles, and is safe |
| P6 | destructure `teacher` when the query no longer joins it | **`TS2339`** |

So:

- ✅ The **shipped** adapters provably cannot carry `teacher`: `rule` is a
  computed remainder with the key removed (P5).
- ✅ **The join becomes load-bearing.** Narrowing the read later is a compile
  failure, not a silent behaviour change (P6).
- ❌ It does **not** bar a differently-written adapter. P3 is exactly that
  shape and it compiles. The caveat holds.

**Therefore both `not.toContain('teacher')` pins stay**, each with one line
saying the destructure is the guarantee and the assertion is the second line.
A future reader deleting a now-redundant-looking pin is precisely how a
structural guarantee quietly reverts to a prose one.

---

## 5. The class-only throw, and the pin it needs

After the merge, one `catch` in `rule-lifecycle.ts` serves both families, and
for one of them it must let `23514` through. Widen it — add `23514` to the
transient list, wrap the CAS — and a teacher resuming into an archived room gets
**503 "The system was busy"** instead of the actionable 409, while the studio
family shows no symptom at all.

That mutation **is** caught today: `room-archive-doors.test.ts` calls
`pauseOrResumeTemplate` and asserts it *rejects*, and after the merge that
wrapper routes through the shared code. This is a discoverability cost, not a
coverage gap — the failing test is named for the room-archive lifecycle, and the
person who broke it is editing shared error handling.

**Deliverable:** a pin at the shared level asserting `pauseOrResumeRule` rethrows
a non-transient check violation rather than answering `busy`, proved by mutation.

The wider fact — *where* a resume onto an archived room is refused (a CHECK, plus
a class-route pre-check gated on `state === 'active'`, for one family) — reaches
past `rule-lifecycle.ts`. Per CLAUDE.md it goes in `docs/`, with the shared
function's comment linking to it, not restated inline.

---

## 6. #291's premise is falsified

Measured while verifying this issue, in the types C1b rewrites. #291 asks that
`PauseStudioTemplateResult`'s `active` arm and its `ResumeTransactionOutcome`
intersect `& SkipCounts` *"the way their class twins do"*. Neither side
intersects: **both** nest `counts: SkipCounts`, at all three sites #291 names.
#296 chose the stronger fix, and the class arm's docblock records why — an
intersection buys the guarantee at one site; nesting carries it across all four
hops to the form.

#291's acceptance criterion is unreachable as written. It is closed or amended
as part of this round rather than left to be discovered again.

---

## 7. Baseline

Measured 2026-08-28 on `main` at `a4913c20`, `npm run verify`, exit 0.

| Project | Files | Tests |
|---|---:|---:|
| unit | 68 | 1031 |
| components | 46 | 302 |
| unit-sweeps | 16 | 142 |
| integration | 33 | 531 |
| **Total** | **163** | **2006** |

`68 + 46 + 16 + 33 = 163` and `1031 + 302 + 142 + 531 = 2006`. The two `npm test`
invocations report `114 / 1333` and `49 / 673`; `114 + 49 = 163` and
`1333 + 673 = 2006`, so the split reconciles both ways.

A green `verify` **is** the whole integration suite. The word green is
load-bearing: `npm test` joins two invocations with `&&`, so a red unit test
means the integration tier reports nothing at all rather than zero failures.

The after-figure is **measured, not predicted**.

---

## 8. Acceptance

- One `pauseOrResumeRule` over `TemplateFamily`, no runtime family test, both
  services keeping their exported wrappers and their own result unions.
- `rule-lifecycle.ts` contains no comparison against a `ClassFamily` literal.
- The trigger's `diff` returns empty, and the branch says why that is necessary
  but not sufficient (§3.2).
- `kind` correlates at compile time; the runtime loop is gone; the isolating
  mutation is observed failing, restored, re-verified.
- `withSlot`'s parameter is the joined type, both bare sites compose `teacher`
  in, both adapters destructure-and-void, and **both** runtime pins remain with
  their one-line reason.
- `standingWhere` replaces `remainingWhere`, and both verbs call it.
- The shared catch's rethrow of a non-transient check violation is pinned at the
  shared level, proved by mutation.
- Every guard ships with a mutation observed failing, restored, and re-verified,
  using a value the code under test cannot produce.
- `npm run verify` green, with the after-figure measured.

---

## 9. Provenance

Measured 2026-08-28 against `main` at `a4913c20`. Predecessor spec:
`docs/superpowers/specs/2026-08-27-rule-lifecycle-archive-merge-design.md`,
§6 of which is the deferral this branch discharges.
