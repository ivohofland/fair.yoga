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
