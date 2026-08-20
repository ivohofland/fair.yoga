# Class template resume: the CAS it never had, and the claim #116 asked for

**Issues:** #116 (primary), #117, #126, plus the class family's un-archive copy gap
(assigned to #116 by PR #191's comment).
**Date:** 2026-08-20
**Branch:** `fix/116-resume-cas-claim`

---

## 1. The premise, measured

Every claim below was checked against the code on `main` at `eb8a76c`, not inherited
from the issue. Three of #116's load-bearing claims are stale, one holds, and the
defect that is actually live is one the issue does not describe.

### 1.1 STALE — the P2002 hedge #116 is named after no longer exists

#116's title is *"pauseOrResumeTemplate generates without taking the claim, so its
P2002 hedge is broken"*, and its body predicts a `25P02` surfacing as a 500.

That mechanism was removed by #164/#192. `generateInstancesForTemplate` now ends in
`createManyAndReturn({ skipDuplicates: true })` — a bare `ON CONFLICT DO NOTHING` —
and has no `catch` at all. `class-generator.ts` states the consequence directly:

> `generateInstancesForTemplate` no longer has a P2002 branch to be broken. Its
> `ON CONFLICT DO NOTHING` makes a lost race cost one date and abort nothing, with
> or without this lock.

No caught P2002 → no aborted transaction → no `25P02` → no 500. **The issue's
headline defect cannot occur.**

The issue quotes `claimStudioTemplateForGeneration`'s docstring as its evidence.
That docstring has since been rewritten to say the opposite ("It is gone for the
…"). An issue citing live code inherits a citation that rots.

### 1.2 STALE — the reporting scope in #116's comment is entirely closed

PR #191's comment on #116 claims a census of six call sites, "four of which drop
the count", and assigns the class family's half here. Re-measured, full census, no
`head` limit — 4 production call sites of `generateInstancesForTemplate`:

| Call site | Count |
|---|---|
| `src/app/api/class-templates/route.ts:102` | consumed — `added` + `countSkipReasons`, line 212 |
| `src/services/class-generator.ts:403` (sweep) | consumed — `result.created` |
| `src/services/template-sync.ts:236` | consumed — `refilled` + `countSkipReasons` |
| `src/services/class-template-lifecycle.ts:879` (resume) | consumed — `added`/`scheduled`/`blockedByCancelled`/`slotTaken` |

**Zero discard.** 4 call sites − 4 consuming = 0, against the comment's claimed 3
of these 4. #164/#192 gave the class family counts; `resolveStudioConfirmation`'s
docblock records it — *"both resume sentences are now word for word identical."*

The `scheduled?: never` phantom the comment warns this issue would have to remove
is also already gone, replaced by the `templateKind` discriminator.

### 1.3 HOLDS — the claim is still not taken

`pauseOrResumeTemplate` still calls `generateInstancesForTemplate(tx, t)` with no
`claimTemplateForGeneration`. This is the one claim in #116 that survives contact
with the code.

### 1.4 LIVE, and undescribed — resume racing archive leaks a bookable window

`pauseOrResumeTemplate`'s write is `update({ where: { id: templateId } })`. Its
`where` carries **no `isArchived: false`**, and the archived guard that protects it
runs in a *non-transactional read* at the top of the function. The studio twin's
write is a CAS carrying both predicates.

Reproduced with the interposing-`$extends` lever this test file already uses for
"X lands between the read and the write" (`class-template-lifecycle.test.ts:1921`),
by committing an archive in that window:

| Family | outcome | `isArchived` | `isActive` | classes generated |
|---|---|---|---|---|
| **class** `pauseOrResumeTemplate` | `active` | true | **true** | **4 × `open`** |
| **studio** `pauseOrResumeStudioTemplate` | `archived` | true | false | 0 |

Identical interleaving, opposite results. The class family leaves an **archived
template still marked active, carrying four publicly bookable classes**, and tells
the teacher it resumed. That is exactly the shelved-but-bookable state #86 exists
to prevent. The studio CAS matches zero rows and correctly answers `archived`.

Reachability: two tabs, or a retry after a lost response — the population this
file's own `unchanged` arm docblock already treats as real.

### 1.5 The issue's remedy is right; its stated reason for one detail is not

#116 says a `null` claim "is a logic error rather than a race. It should throw."
That is true for studio *because its CAS proves the predicate in the same statement
that locks the row*. Bolted onto the class family's plain `update`, a raced archive
makes `null` legitimately reachable, and throwing would convert a correct `archived`
answer into a 500. The CAS is what makes the throw correct — so it is not optional
dressing on this change, it is the precondition for the half the issue asked for.

---

## 2. Design

### 2.1 The new transaction shape

Mirrors `pauseOrResumeStudioTemplate` rather than merely resembling it.

```
$transaction(timeout: 10_000):
  setLockTimeout(tx)                                  // 2s, bounds every wait below

  updateMany where { id, isArchived: false,
                     isActive: !desiredActive }       // the CAS
    count === 0 → re-read and classify:
        row missing            → not_found
        isActive === desired   → unchanged            // before isArchived, see 2.2
        isArchived             → archived
        otherwise              → busy                 // §2.1a, corrected in PR review

  !desiredActive → read back the row → paused

  claimTemplateForGeneration(tx, templateId)          // FOR UPDATE
    null → throw: the CAS just proved the predicate under this lock
  generateInstancesForTemplate(tx, claimed)
  count scheduled (gte today, off claimed.teacher.defaultTimezone)
```

Two locks, doing two different jobs, and the spec states both because conflating
them is what #126 exists to correct:

- the **CAS** takes `FOR NO KEY UPDATE` and closes §1.4 — it is a predicate, not a
  lock upgrade;
- the **claim** takes `FOR UPDATE`, which conflicts with the `FOR KEY SHARE` a
  concurrent `Class` insert takes for FK integrity. `FOR NO KEY UPDATE` does not.
  That is what makes a concurrent insert impossible rather than leaving it to
  `ON CONFLICT DO NOTHING` to cost that date its class with no error.

### 2.1a The residual fourth state answers `busy`, not a throw

**Corrected in PR review; this section originally specified a throw.** The miss
branch's fourth arm — the re-read finds the row neither already in the desired
state nor archived — is reachable, and not exotically: a resume commits between
this transaction's read and its CAS, and a pause commits before the re-read.
Two tabs get there.

A throw escapes the transient branch and surfaces as `{ status: 500, message:
'Internal server error', level: 'error' }`. But the CAS matched zero rows, so
nothing was written and the transaction rolls back clean — a lost race a retry
wins, which is what `busy` means everywhere else in this file.
`archiveOrUnarchiveTemplate`'s miss branch reaches the analogous fourth state
and answers `unchanged` rather than throwing, so a throw here also split the two
families over one interleaving.

`busy`, with a `log.warn` carrying the observed row so predicate drift — the
case the throw was actually aimed at — stays diagnosable.

### 2.2 Guard order inside the miss branch

`isActive === desiredActive` is checked **before** `isArchived`, matching the
studio twin and the fast paths above it. Archiving forces `isActive: false`, so an
archived row racing a *pause* is simultaneously already-desired and archived;
answering `unchanged` matches the fast path, while checking `isArchived` first
would answer a plain pause with a 409 meant for resuming an archived template.

### 2.3 Consequence: the P2025 branch dies

`updateMany` returns `{ count: 0 }` where `update` threw `P2025`, so after this
change **nothing under the transaction can raise P2025**:

- the CAS returns a count;
- the paused arm's read-back runs after the CAS matched, under the
  `FOR NO KEY UPDATE` it took, so the row cannot vanish first;
- `claimTemplateForGeneration`'s `findUniqueOrThrow` runs under the `FOR UPDATE`
  its own raw `SELECT` just took — #116's body notes this, correctly;
- `generateInstancesForTemplate` issues a `findMany` and a `createManyAndReturn`;
  neither produces P2025, and the insert absorbs P2002 rather than raising it;
- `class.count` cannot produce it.

So the `catch`'s `P2025 → null → not_found` branch is removed and `not_found` is
answered by the CAS's miss classification instead. `pauseOrResumeStudioTemplate`'s
catch already carries only the transient branch and a rethrow; this converges on it.

The long enumeration comment in the existing `catch` — which reasons about which
statements can raise what — is rewritten rather than edited, because every one of
its premises changes.

### 2.4 `PauseTemplateResult` is unchanged

`not_found`, `archived`, `unchanged` and `busy` all already exist on it. The change
is which code path produces them, not what the caller can receive. An internal
outcome union (studio's `ResumeTransactionOutcome` shape) is introduced to make the
transaction's arms explicit and to keep the stale pre-transaction snapshot from
reaching any of them.

---

## 3. Also in this sitting

### 3.1 The class family's un-archive says nothing (live)

`archiveOrUnarchiveTemplate` forces `isActive: false` on **both** directions, and
the archive has already deleted the future classes. A teacher who un-archives to get
their weekly class back lands on a **paused template with an empty window**, and the
only signal is a differently-labelled button: `TemplateToggleResponse` collapses
`{ action: 'unarchived' | 'unchanged' }` and `resolveTemplateConfirmation` returns
`null`. `UNARCHIVE_STUDIO_MESSAGE` exists for studio; the class family has no twin.

Fix, copy-only. **No type change** — an earlier draft of this spec called for
splitting `unarchived` from `unchanged` on `TemplateToggleResponse`; measurement
disproved it. `StudioTemplateToggleResponse` carries the same collapsed
`{ action: 'unarchived' | 'unchanged' }` arm and `resolveStudioConfirmation`
still gives the two their own `case`s, because TypeScript narrows a literal-union
property inside a single arm. So:

- add the class message beside `UNARCHIVE_STUDIO_MESSAGE`, saying "recurring class"
  where studio says "template". **NOT "classes"** — that word appears
  identically in both strings ("put classes back on your schedule"), so it is
  the one that does not distinguish them. Corrected during the branch, and
  again here, after the first correction touched only `src/`;
- `resolveTemplateConfirmation` becomes a `switch` with a `never` default, for the
  reason `resolveStudioConfirmation`'s docblock already gives for its own: an
  if-chain ending in `return null` is *accidentally* exhaustive, so a sixth arm
  would fall through to silence instead of failing the build;
- two docblocks are twins that must move with it: `resolveTemplateConfirmation`'s
  own ("`null` … is the correct answer for two of the five actions" becomes one),
  and `UNARCHIVE_STUDIO_MESSAGE`'s, which says the class family's gap is
  "[deliberately] not fixed alongside this; tracked … on #116".

### 3.2 #117 — a zero-count CAS may hold a lock

`class-template-lifecycle.ts:1199-1200`, in `archiveOrUnarchiveTemplate`'s miss
branch, still asserts:

> This read takes a fresh READ COMMITTED snapshot and holds no lock: the CAS
> matched nothing, so it acquired none.

False in one of the two interleavings, settled by experiment during #94: when an
`UPDATE` blocks on a concurrently-updated row, Postgres takes the lock on the newest
version *before* the EvalPlanQual re-check, so a rejection still leaves it held to
commit. No behaviour is wrong — the plain re-read is correct either way — but the
sentence invites a contributor to add a read-then-write believing the row is pinned.

Replaced with the studio side's corrected wording, adapted. **Three twins, all of
which must move** (§4 of the solve-issue skill) — the third turned up only in PR
review, by running the keyword sweep this spec already prescribes:

- `studio-class-template-lifecycle.ts:811-815` points at this sentence by quoting it
  and saying "#117 owns correcting it" — that pointer becomes stale on the fix;
- the new miss branch this branch adds to `pauseOrResumeTemplate` (§2.1) is a second
  zero-count CAS in the same file, and must carry the corrected reasoning from
  birth rather than the wrong one.

### 3.3 #126 — `gdpr.ts` is the last file conflating the two lock modes

`gdpr.ts:1239-1241`:

> The `classTemplate.updateMany`/`studioClassTemplate.updateMany` below take the
> same row locks `claimTemplateForGeneration` / `claimStudioTemplateForGeneration`
> … hold

An `updateMany` takes `FOR NO KEY UPDATE`; the claims take `FOR UPDATE`. Different
modes with different conflict sets — the exact distinction §2.1 turns on. #125
corrected this at six sites across four files and settled on one wording; `gdpr.ts`
was left out because it is the referent of none of them, leaving one file asserting
the opposite of six others. **Eight sites, not seven** — PR review found
`class-generator.test.ts`'s contention docblock carrying the same conflation,
which this branch's own `grep -rn "same row lock" src/` step would have caught.

The same sentence continues *"always for the sweep, and now for the studio family's
own resume too (#94)"* — which this branch makes true of the class family as well.
The correction and the update are one edit, which is why #126 belongs in this
sitting rather than a later one.

### 3.4 Door 3 (the archived-room guard) — known-open, not fixed here

Measured, same lever, same window, archiving the **room** instead of the template:

```
{"outcome":"active","roomArchived":true,"generated":4}
```

Four classes generated into a just-archived room — precisely what door 3's own
comment says it exists to prevent. The template is left `isActive: true` on an
archived room, and because `ACTIVE_TEMPLATE_WHERE` reads only the template's own
flags and never `teacherRoom.isArchived`, the sweep then tops that window up
indefinitely.

**This falsifies a live claim.** `class-generator.ts`'s known-open note calls that
state *"LATENT, not live"* on the grounds that *"after this branch no teacher action
produces that state: door 1 refuses to archive a room an active template uses, and
doors 3, 4 and 5 refuse to resume, create or move an active template onto an
archived room."* Door 3 refuses only in a non-transactional pre-read, so a teacher
action does produce it. That note is corrected to say the state is reachable and
measured.

Not fixed here, deliberately, and the reason is a decision the codebase already
made: `room-archive.ts:138-147` accepts this exact race class rather than locking,
because *"the alternative is a new FOR UPDATE node in the ordering that
`template-lock-order.test.ts` exists to defend."* A re-read after the CAS would
close the interleaving measured above and leave its mirror open — a half-guard whose
residue needs documenting forever.

The invariant "an active template may not sit on an archived room" is currently
enforced by five application doors, every one of them a non-transactional read. The
structural answer is to enforce it once in Postgres, the call #39 made for tier
ranges. That is a product-and-schema decision, so it is **filed as a decision** with
options rather than smuggled into a locking PR (§7, test 2), and door 3 gets a
`known-open` note beside the guard pointing at it.

---

## 4. Testing

Each guard gets a mutation that uses a value the code under test cannot produce, and
each mutation's exact error text is recorded (§3 of the solve-issue skill).

| Guard | Test | Mutation that must fail it |
|---|---|---|
| CAS closes the archive race | archive interposed between read and write → `archived`, 0 classes, `isActive` false | drop `isArchived: false` from the CAS `where` → resumes an archived template, 4 classes |
| CAS closes the already-in-state race | pause interposed → `unchanged` | drop `isActive: !desiredActive` from the CAS `where` |
| Guard order in the miss branch | archived row racing a *pause* → `unchanged`, not `archived` | swap the two checks → a plain pause answers 409 |
| Claim is taken before generating | concurrent `Class` insert cannot interleave | remove `claimTemplateForGeneration` → the insert lands and a date is lost |
| Claim's null is unreachable | **none, and recorded as none** | the branch is reachable only by editing the production predicate, so no test can drive it. An earlier draft of this row claimed the throw's message was asserted; nothing asserted it |
| Un-archive speaks | `resolveTemplateConfirmation({action:'unarchived'})` returns the message | return `null` for `unarchived` |
| Resolver exhaustiveness | a sixth arm fails the build | add an arm, observe the `never` default error |

The two reproductions in §1.4 and §3.4 were run as throwaway tests and reverted; they
become permanent tests on this branch.

`npm run verify` runs typecheck, lint and all three vitest projects, so a green run
is the whole integration suite, not a sample. It needs the app on :3000.

---

## 5. What this branch does not do

- **#229 is unaffected** — the `{Class, ClassTemplate}` lock-order decision is
  untouched; this branch adds no new node to the ordering.
- **Door 3 is not closed** — §3.4, marked known-open, with the structural fix filed
  as a decision.
- **`room-archive.ts` is not changed** — its accepted race stands; only the note in
  `class-generator.ts` that overstated the consequence is corrected.
- **No migration.** The CAS is application-level; the DB-level invariant is the
  filed decision's business, not this branch's.
- **#116's own text is corrected on GitHub** — §1.1 and §1.2 are stale claims that
  would otherwise outlive the branch that disproved them.
