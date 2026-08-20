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

### Lock test: DELETED — probe cannot discriminate

**Plan defect.** The plan specified a `FOR KEY SHARE NOWAIT` probe into `createManyAndReturn` to detect whether `FOR UPDATE` is held. Measured: `createManyAndReturn` does not take `FOR KEY SHARE` on the referenced `ClassTemplate` row (Prisma generates a CTE-based insert, not a plain INSERT with FK-triggered locking). The probe succeeds whether or not the claim is held.

**Verified by mutation:** removing the `claimTemplateForGeneration` call and replacing it with a bare `findUniqueOrThrow` — the `FOR KEY SHARE NOWAIT` probe still succeeds (`probeError` is `null`). The test cannot fail and was deleted per the handover's §6 instruction.

**Impact on test count:** Task 3 predicted +1 test; measured +0. The claim's correctness is certified by the throw's message being asserted (unreachable branch) and by the catch's enumeration, not by a lock probe.

The three Task 2 mutations (CAS archive predicate, CAS already-in-state predicate, guard order) remain the effective guards for this change.

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
