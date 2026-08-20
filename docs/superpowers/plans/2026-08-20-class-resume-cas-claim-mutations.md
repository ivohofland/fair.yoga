# Mutation records — class resume CAS + claim

## Task 2

### Mutation 1: drop `isArchived: false` from the CAS `where`

**Diff:** removed `isArchived: false,` from the CAS `where` clause in `pauseOrResumeTemplate`.

**Command:** `npx vitest run src/services/class-template-lifecycle.test.ts -t 'answers archived when an archive lands'`

**Verbatim failure output:**

```
FAIL src/services/class-template-lifecycle.test.ts > pauseOrResumeTemplate (DB) > answers archived when an archive lands between the read and the write
AssertionError: expected { ok: true, action: 'active', template: { …, isArchived: true, isActive: true, … } } to equal { ok: false, reason: 'archived' }
```

The CAS without the archive predicate matched and resumed an archived template, generating four classes onto it.

### Mutation 2: drop `isActive: !desiredActive` from the CAS `where`

**Diff:** removed `isActive: !desiredActive` from the CAS `where` clause.

**Command:** `npx vitest run src/services/class-template-lifecycle.test.ts -t 'answers unchanged when a pause lands'`

**Verbatim failure output:**

```
FAIL src/services/class-template-lifecycle.test.ts > pauseOrResumeTemplate (DB) > answers unchanged when a pause lands between the read and the write
AssertionError: expected the action to be 'unchanged' but was 'paused'
```

The CAS without the already-in-state predicate matched and applied the transition instead of answering unchanged.

### Mutation 3: swap the guard order in the miss branch

**Diff:** moved `if (current.isArchived) return { outcome: 'archived' }` above `if (current.isActive === desiredActive)`.

**Command:** `npx vitest run src/services/class-template-lifecycle.test.ts -t 'answers unchanged, not archived, when an archive races a pause'`

**Verbatim failure output:**

```
FAIL src/services/class-template-lifecycle.test.ts > pauseOrResumeTemplate (DB) > answers unchanged, not archived, when an archive races a pause
AssertionError: expected { ok: false, reason: 'archived' } to have property ok equal to true
```

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
2. More fundamental: **a second `PrismaClient`'s query does not run while a
   Prisma interactive transaction is in flight in the same process.** Measured
   by re-instating the probe on `class.findMany` (unconditional, and after the
   claim) with a timing counter: `PROBE_MS 9982` — the probe returned only once
   the resume's 10s transaction budget expired and released everything, so it
   reported "granted" no matter what had been held.

   `NOWAIT` was never the problem. The identical statement through the same
   Prisma client, against a row held `FOR UPDATE` by a psql session, is refused
   in **5ms** (parameterized) and **2ms** (literal) with
   `55P03 could not obtain lock on row`.

So an in-process `NOWAIT` probe cannot observe this lock at all. The test was
rebuilt as a race instead of a probe.

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
