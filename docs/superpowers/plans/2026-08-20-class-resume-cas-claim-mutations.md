# Mutation records — class resume CAS + claim

## Task 2

### Mutation 1: drop `isArchived: false` from the CAS `where`

**Diff:** removed `isArchived: false,` from the CAS `where` clause in `pauseOrResumeTemplate`.

**Command:** `npx vitest run src/services/class-template-lifecycle.test.ts -t 'answers archived when an archive lands'`

**Verbatim failure output, re-measured on the final tree:**

```
 × answers archived when an archive lands between the read and the write 24ms
Error: pauseOrResumeTemplate: claim returned null for template … right after
this transaction's own CAS confirmed it eligible — the claim predicate and the
CAS predicate have diverged
 ❯ db.$transaction.timeout src/services/class-template-lifecycle.ts:1015:17
```

**Re-measured, and the first recording is superseded.** This entry originally
read:

> AssertionError: expected { ok: true, action: 'active', template: { …,
> isArchived: true, isActive: true, … } } to equal { ok: false, reason:
> 'archived' }
>
> The CAS without the archive predicate matched and resumed an archived
> template, generating four classes onto it.

That was true of Task 2's tree and Task 3 falsified it the next commit:
`claimTemplateForGeneration`'s own `AND "isArchived" = false` now catches the
archived row first, so no template is resumed and no classes are generated —
the transaction throws and rolls back. The guard still fails, so the
conclusion holds; the narrative did not, and a mutation record that describes
a tree two commits back is exactly the rot this file is meant to prevent.

Note what this also means: with a single-edit mutation, the test's two extra
assertions (`isActive` false, zero classes) are never reached, because the
function throws before returning. The CAS's `isArchived: false` predicate has
no mutation that isolates it from the claim's identical predicate — it fails
*something* either way, so it is not a vacuous guard, but the evidence pins
less than the original wording claimed.

### Mutation 2: drop `isActive: !desiredActive` from the CAS `where`

**Diff:** removed `isActive: !desiredActive` from the CAS `where` clause.

**Command:** `npx vitest run src/services/class-template-lifecycle.test.ts -t 'answers unchanged when a pause lands'`

**Verbatim failure output:**

```
 × answers unchanged when a pause lands between the read and the write
AssertionError: expected 'paused' to be 'unchanged' // Object.is equality
```

(Re-measured. The line recorded here originally — `expected the action to be
'unchanged' but was 'paused'` — was a paraphrase, not tool output, against a
file whose own Global Constraints say "Record the exact error text".)

The CAS without the already-in-state predicate matched and applied the transition instead of answering unchanged.

### Mutation 3: swap the guard order in the miss branch

**Diff:** moved `if (current.isArchived) return { outcome: 'archived' }` above `if (current.isActive === desiredActive)`.

**Command:** `npx vitest run src/services/class-template-lifecycle.test.ts -t 'answers unchanged, not archived, when an archive races a pause'`

**Verbatim failure output:**

```
 × answers unchanged, not archived, when an archive races a pause
AssertionError: expected false to be true // Object.is equality
```

(Re-measured; the previous line was a paraphrase. The assertion that fails is
`expect(result.ok).toBe(true)`, so the message names the boolean rather than
the object.)

A plain pause was answered `archived` because `isArchived` was checked first, matching the wrong fast path.

## Task 3

### Lock test: RE-INSTATED — the deleted probe's premise was false

**This entry replaces an earlier one that was wrong, and the correction matters
more than the test.** That entry said the probe could not discriminate because
"`createManyAndReturn` does not take `FOR KEY SHARE` on the referenced
`ClassTemplate` row (Prisma generates a CTE-based insert, not a plain INSERT
with FK-triggered locking)", and deleted the test on that basis. Measured
against `ethical_yoga_test`, both insert forms block identically on a held
`FOR UPDATE`:

```
-- session A: BEGIN; SELECT id FROM parent WHERE id='p1' FOR UPDATE;
-- session B: SET LOCAL lock_timeout='2s';
INSERT INTO child(pid) VALUES ('p1');                                     -> 55P03
WITH ins AS (INSERT ... RETURNING *) SELECT * FROM ins;                   -> 55P03

ERROR:  canceling statement due to lock timeout
CONTEXT:  while locking tuple (0,1) in relation "parent"
SQL statement "SELECT 1 FROM ONLY "parent" x WHERE "id" = $1 FOR KEY SHARE OF x"
```

Postgres names the RI trigger's own `FOR KEY SHARE`; a CTE does not bypass it.
`class-generator.ts`'s claim docblock ("Measured on #164, both directions") and
the handover's §6 table were right all along.

**What actually broke the probe — two things, both about the harness, neither
about locking.**

1. `generateInstancesForTemplate` writes
   `free.length === 0 ? [] : await db.class.createManyAndReturn(...)`. On a
   template with no free candidate dates the insert never runs, so a hook
   interposed on it never fires and `probeError` stays `null` either way.
2. **CAUSE NOT ESTABLISHED**, and this entry has now been wrong about it
   twice. Re-instating the probe on `class.findMany` (unconditional, and after
   the claim) with a timing counter gave `PROBE_MS 9982` — the probe returned
   only once the resume's 10s transaction budget had expired. An earlier
   version of this entry explained that as "a second `PrismaClient`'s query
   does not run while a Prisma interactive transaction is in flight in the same
   process". **That is false, measured:** two clients in one process, A holding
   `SELECT … FOR UPDATE` inside an in-flight interactive transaction, B probing
   `FOR KEY SHARE NOWAIT` — `REFUSED 55P03 after 5ms`. The second client's
   query runs and `NOWAIT` discriminates.

   `NOWAIT` was never the problem either: the same statement through the same
   client against a psql-held `FOR UPDATE` is refused in **5ms**
   (parameterized) and **2ms** (literal).

   So the 9982ms is unexplained. It is recorded as unexplained rather than
   given a third guess, because two have already been wrong and the pattern —
   inventing a mechanism to justify a decision already taken — is the thing
   this ledger exists to catch. Reason 1 above stands on its own and is
   verifiable from the source.

The test was rebuilt as a race rather than a probe, which is a better guard
regardless of why the probe misbehaved.

### Mutation 6: remove `claimTemplateForGeneration` (new test: "blocks a concurrent Class insert while generating, and answers busy")

**The test.** A holder transaction inserts a `Class` for this template on a date
`futureOn(60)` — deliberately outside the generator's four-week window, so
there is no unique-index collision and the only thing that can make the resume
wait is a lock. The insert's FK check takes `FOR KEY SHARE`; the claim's
`FOR UPDATE` conflicts with it; the CAS's `FOR NO KEY UPDATE` does not. So the
resume must fail to get the claim inside the 2s `setLockTimeout` bound and
answer `busy`.

**Diff:** replaced `claimTemplateForGeneration(tx, templateId)` with a bare
`tx.classTemplate.findUniqueOrThrow({ where: { id: templateId }, include: ... })`.

**Command:** `npx vitest run --project unit src/services/class-template-lifecycle.test.ts -t 'blocks a concurrent Class insert'`

**Verbatim failure output:**

```
 × blocks a concurrent Class insert while generating, and answers busy 103ms
AssertionError: expected { ok: true, action: 'active', …(5) } to deeply equal { ok: false, reason: 'busy' }
```

Without the claim the resume takes only `FOR NO KEY UPDATE`, never conflicts
with the holder, and succeeds. Restored, re-run, green.

**Impact on test count:** Task 3 predicted +1 test; delivered +1.

### Mutations 7 and 8: the two `class-generator.test.ts` race tests

These two (`leaves isActive committed when the clash lands on the last free
date`, `still fills the other free date when the clash lands on the first`) had
been rewritten to assert `expect(racedDates).toEqual([])` and nothing else,
which is satisfied by a world where no race occurred at all. They now also
assert that the holder committed, that the resume's own promise settled only
after the hold was released, and what the resume `added`.

**Mutation 7 — remove `claimTemplateForGeneration`.**

```
 × leaves isActive committed when the clash lands on the last free date
AssertionError: expected [ '2026-09-15' ] to deeply equal []
 × still fills the other free date when the clash lands on the first
AssertionError: expected [ '2026-09-08' ] to deeply equal []
```

Without the claim the resume reaches its own insert, parks on the holder's
pending unique entry, and takes the `ON CONFLICT DO NOTHING` skip classified
`raced` — the pre-#116 behaviour.

**Mutation 8 — pre-commit the collision (`release(); await holding;` before the
resume starts), i.e. remove the overlap the tests exist to construct.**

```
 × leaves isActive committed when the clash lands on the last free date
AssertionError: expected 21 to be greater than or equal to 300
 × still fills the other free date when the clash lands on the first
AssertionError: expected 15 to be greater than or equal to 300
```

This is the mutation the earlier assertions could not survive contact with, and
it caught a real defect in the first attempt at the fix: `waitedMs` was
initially stamped after the 400ms hold, so it measured the hold rather than the
resume's blocking and this mutation passed. Re-stamped on the resume promise's
own settlement, it fails as it should — 21ms and 15ms against a 300ms floor.

## Task 4

### Mutation 4: make `case 'unarchived'` return `null`

**Diff:** changed `return UNARCHIVE_MESSAGE` to `return null` in `resolveTemplateConfirmation`'s `unarchived` case.

**Command:** `npx vitest run src/components/settings/template-action-messages.test.ts -t 'speaks on un-archive'`

**Verbatim failure output:**

```
FAIL src/components/settings/template-action-messages.test.ts > resolveTemplateConfirmation > speaks on un-archive for the class family
AssertionError: expected null to be 'Un-archived. This recurring class is paused — resume it to put classes back on your schedule.'
```

### Mutation 5: add a sixth action to `TemplateToggleResponse` without a case

**Diff:** added `| { action: 'vanished' }` to `TemplateToggleResponse` without adding a `case 'vanished'` to the switch.

**Command:** `npx tsc --noEmit`

**Verbatim failure output:**

```
src/components/settings/template-action-messages.ts(347,13): error TS2322: Type '{ action: "vanished"; }' is not assignable to type 'never'.
```

The `never` default catches the unhandled arm at compile time — this is the guard the switch conversion exists for, and an if-chain would have compiled clean.

## PR review round (agents, PR #273)

Five review agents re-ran every mutation above and added their own. All seven
originals still kill exactly the test written for them. What follows is what
they found that the originals did not.

### Mutation 9: reinstate the residual `throw` in place of `busy`

The CAS-miss branch's fourth state was a `throw`, which the route rendered as
a 500 logged at `error`. Reachable — reproduced three times independently.

**Command:** `npx vitest run --project unit src/services/class-template-lifecycle.test.ts -t 'residual fourth state'`

```
 × answers busy when the CAS miss lands in the residual fourth state 40ms
Error: pauseOrResumeTemplate: CAS matched no row (mutant)
```

### Mutation 10: `unchanged` returns the stale pre-transaction snapshot

`template: current` → `template: bare`. Before the assertion added in this
round, that passed all 53 tests — the arm's advertised freshness was unpinned,
and the route spreads this template onto the wire.

```
 × answers unchanged when a pause lands between the read and the write 25ms
AssertionError: expected true to be false // Object.is equality
```

### Mutation 11: reword `UNARCHIVE_MESSAGE` to the studio noun

Before this round both levels passed, because the test compared the function's
output to the same constant it returns.

```
AssertionError: expected 'Un-archived. This template is paused …'
  to be 'Un-archived. This recurring class is …' // Object.is equality
TestingLibraryElementError: Unable to find an element with the text:
  Un-archived. This recurring class is paused — resume it to put classes back…
```

### Mutation 12: a fifth `SkipReason`, completed the way a contributor would

Not just adding the reason (which fails at `countSkipReasons`' own `never`) but
finishing the job: handle it, add its count to `SkipCounts`, count it. Before
the `& SkipCounts` binding this compiled **clean repo-wide** and the new count
vanished at every hand-re-listing site. After:

```
src/services/class-template-lifecycle.ts(1211,7): error TS2322:
  Property 'probeFifth' is missing in type '{ … blockedByCancelled: number;
  slotTaken: number; }' but required in type 'SkipCounts'.
```

### Mutation 13: weaken the claim's `FOR UPDATE` to `FOR NO KEY UPDATE`

Run by the test-coverage agent, and the strongest result in the review — the
claim's whole argument is about lock MODE, and this is the edit
`claimTemplateForGeneration`'s docblock explicitly forbids. Three tests caught
it, across both files:

```
 FAIL … > blocks a concurrent Class insert while generating, and answers busy
 FAIL … > still fills the other free date when the clash lands on the first
AssertionError: expected [ '2026-09-08' ] to deeply equal []
```

The tests pin the mode, not merely "a lock". That is what retires the deleted
`NOWAIT` probe honestly.

