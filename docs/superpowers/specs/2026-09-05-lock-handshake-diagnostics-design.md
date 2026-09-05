# The lock-order handshakes name the statement they wait for

Issue #244 ("A missing pre-lock is detected by a 30-second hang, not an
assertion"), split out of #239's review.

## 1. The premise, corrected

The issue's three factual claims were re-measured on 2026-09-05 against
`ethical_yoga_test`, on a branch off `ed0768c7`. **Two of the three are wrong,
and one is wrong in the dangerous direction.**

### 1.1 The file moved

The issue names `src/services/gdpr.test.ts`. The test has lived in
**`src/services/gdpr-lock-order.test.ts`** since `90d07e42` (2026-08-28), which
split it out for its *tier* — it asserts a staged race ends in neither `40P01`
nor `55P03`, so lock noise from a concurrent file is a false failure it cannot
distinguish from the defect it watches for. That file holds exactly one `it`,
with a 30 000 ms timeout.

### 1.2 The 30-second hang is real — for one of the two handshakes

Three mutations, each applied to the real functions, each run against
`ethical_yoga_test`:

| # | Mutation | Site | Outcome | Test time | Diagnostic |
|---|---|---|---|---|---|
| **A** | teacher `Class` pre-lock replaced by an unordered `findMany` (i.e. the pre-lock deleted) | `gdpr.ts:1120` | **PASSES GREEN** | 1.0 s | **none** |
| **B** | `ORDER BY c.id` deleted | `db-locks.ts:415` | fails | 2.0 s | `40P01 deadlock detected` — named |
| **D** | student `Class` pre-lock deleted | `gdpr.ts:433` | fails | 30.1 s | `Test timed out in 30000ms.` — names nothing |

Baseline, unmutated: passes in 1.15 s of test time.

So the issue's premise **holds for D** — a 30 s hang naming nothing, costing 30 s
of CI per occurrence, exactly as filed. It is **wrong for A**, and wrong in the
direction that matters: deleting `deleteTeacherAccount`'s ordered pre-lock
produces no hang, no failure, and no signal of any kind.

**The fix the issue proposes would not have found A.** A short timeout on
`preLockReachedPromise` never fires, because that promise *does* resolve. It
resolves on the wrong statement.

### 1.3 Why: a handshake keyed on a bound value names a set, not a statement

`preLockReachedPromise` is keyed on `args.values[0] === teacherId`. Probed
directly (a temporary hook logging each matching statement's SQL),
`deleteTeacherAccount` issues **three** `$queryRaw`s whose first bound value is
`teacherId`, in this order:

1. `SELECT ct."id" … FROM "ClassTemplate" ct … FOR UPDATE OF ct` — `gdpr.ts:1078`
2. `SELECT sct."id" … FROM "StudioClassTemplate" sct … FOR UPDATE OF sct` — `gdpr.ts:1084`
3. `SELECT c.id FROM "Class" c … FOR UPDATE OF c` — `lockClassRowsOrdered`, **the intended one**

The first resolves the promise. The handshake has been signalling on a
`ClassTemplate` lock, not a `Class` lock.

**The comment asserting otherwise was true when it was written.** At `2a19ccd2`
(2026-08-16, #237), where the handshake and its comment were introduced,
`git show 2a19ccd2:src/services/gdpr.ts | grep -c queryRaw` returns **0** — the
only `$queryRaw` in the whole call path was `lockClassRowsOrdered`'s, so
`teacherId` really did identify it uniquely. `ba0dbb8a` (2026-08-25, issue #298
/ PR #315) added the two template pre-locks ahead of it and falsified the claim
nine days later. `90d07e42` then carried the false comment into the new file.

Two artifacts in this repo already record the fact that falsifies it, and
neither is connected to the test:

- `docs/lock-order.md:578-580` — "the pre-lock is first among
  `Class`/`CalendarEntry` locks (not first in the transaction — #229's
  `ClassTemplate`/`StudioClassTemplate` locks run before it)".
- `docs/superpowers/specs/2026-09-01-teacher-erasure-lock-then-read-design.md`
  §1 — enumerates `deleteTeacherAccount`'s statements and names the two
  `FOR UPDATE OF ct`/`OF sct` locks as step 2, four days before this spec.

This is CLAUDE.md's *Comment Discipline* failure in its exact predicted form: a
claim reaching past its own file has no owner, so the person who invalidated it
never saw it.

### 1.4 The student handshake is the same defect, unfired

`studentPreLockReachedPromise` is keyed on `args.values[0] === studentId`. It
fires exactly once today, because `deleteStudentAccount` happens to have exactly
one `$queryRaw` binding `studentId`. That is a property of today's call graph,
not a guarantee, and it is one sibling statement away from becoming mutation A.

### 1.5 The narrowed row set is still uncovered

The issue predicts that "a maintainer who **weakens** the pre-lock differently —
narrows its row set while keeping the statement, say — gets no signal at all".
Confirmed: no assertion in the file reads what the pre-lock actually locked. The
two outcome assertions at the end (`cancelled === 2`,
`remainingEntries === 0`) are satisfied by an erasure that locked one row, or
none.

## 2. Design

Entirely a **test-diagnostics** change. `src/services/gdpr.ts` and
`src/lib/db-locks.ts` are not modified, so no lock-order behaviour changes.

### 2.1 One discriminator, keyed on the statement's shape

```ts
const isClassPreLock = (sql: string) =>
  sql.includes('FROM "Class" c') && sql.includes('FOR UPDATE OF c');
```

Read off `Prisma.Sql`'s `sql` getter, which is typed `string` and therefore needs
no cast under `strict: true`.

**Both halves are load-bearing, and each excludes a different sibling:**

| Statement | `FROM "Class" c` | `FOR UPDATE OF c` | Matches |
|---|---|---|---|
| `lockClassRowsOrdered`'s class lock | yes | yes | **yes** |
| `FROM "ClassTemplate" ct … FOR UPDATE OF ct` | no — `FROM "Class` is followed by `T`, not `"` | yes, as a prefix of `OF ct` | no |
| `FROM "StudioClassTemplate" sct … FOR UPDATE OF sct` | no | no | no |
| `lockClassRowsOrdered`'s entries lock (`FROM "CalendarEntry" e … JOIN "Class" c … FOR UPDATE OF e`) | no — `JOIN`, not `FROM` | no | no |

Measured, not merely argued: run against the real `deleteTeacherAccount` five
times, this predicate matched **exactly once per erasure** in 5/5 runs. §2.2's
firing-count guard is what keeps it that way.

The same predicate serves both hooks. They are installed on **separate extended
clients** (`teacherRacing`, `studentRacing`), so neither sees the other's
statements and the predicate needs no family discriminator of its own.

### 2.2 Three guards, one per way a lock guard can die

| Guard | The regression it catches | Behaviour today |
|---|---|---|
| **Named timeout** around each handshake await | the statement is **deleted**, or its SQL drifts past the discriminator | teacher: silent green (A); student: 30 s hang (D) |
| **Firing count is exactly 1**, asserted per handshake | the key stops being **unique** — a future sibling statement widens it | invisible; this is `ba0dbb8a`'s exact failure |
| **Lock-set assertion** — capture what the pre-lock returned, assert `[LOW, HIGH]` | the row set is **narrowed**, and the ordering revert independently of the deadlock | uncovered (§1.5) |

**The timeout bound is 2 000 ms.** Measured latency from the
`deleteTeacherAccount` call to the class pre-lock being issued, over five
consecutive runs: `[13, 5, 5, 6, 5]` ms — 13 ms cold, 5-6 ms warm. 2 000 / 13 ≈
**154× headroom over the cold-run worst case**, and 6.5× better than a 30 s hang
as a CI cost. Its failure text names the missing statement, e.g.
`teacher Class pre-lock never issued within 2000ms`.

**The firing-count guard is the one the issue did not ask for and the one that
would have prevented it.** Had it existed on 2026-08-25, `ba0dbb8a` would have
driven the count to 3 and failed loudly, instead of silently re-pointing the
handshake at a template lock. It is an assertion about the *test harness* rather
than the code under test — unusual, and deliberate: this issue exists because a
harness broke silently while the code stayed correct, and nothing was watching
the harness.

Counted at the end of the test rather than thrown from inside the hook: an
exception raised inside a Prisma extension rejects the erasure with an error
that looks nothing like what it is.

### 2.3 Applied to both handshakes

Per §1.4 the student handshake carries the identical latent defect. All three
guards are installed on both sides.

## 3. Proving every guard bites

Per CLAUDE.md and `solve-issue` §3, each guard is broken, its exact error text
recorded, then restored and re-verified. Four mutations, each of which must move
from its current outcome to a **named** failure:

| Mutation | Site | Now | Required after |
|---|---|---|---|
| **A** teacher `Class` pre-lock deleted | `gdpr.ts:1120` | passes green, 1.0 s | named timeout failure, ~2 s |
| **B** `ORDER BY c.id` deleted | `db-locks.ts:415` | `40P01`, 2.0 s | unchanged (already named) |
| **C′** teacher pre-lock's row set narrowed to one class | `gdpr.ts:1122-1124` | passes green *(predicted from §1.5, measured by the plan's first task before any guard is written)* | named lock-set assertion failure |
| **D** student `Class` pre-lock deleted | `gdpr.ts:433` | 30 s timeout naming nothing | named timeout failure, ~2 s |

The firing-count guard is proven by a fifth mutation that adds a *second*
matching statement to the erasure, which must drive the count to 2 and fail by
name.

Mutations use values the code under test cannot produce, and every source file
is restored and re-verified green before the branch is pushed.

## 4. Thread B — the stale lock-loop comments

Issue #244's first comment (2026-08-16) enumerates eight present-tense
references to a `lockClassRow` loop `deleteStudentAccount` has not used since
#216/#182. Re-measured 2026-09-05, **that list is stale in both directions**:
two of its eight are gone, six survive at shifted lines, and at least two live
locations it never named exist. This is the same failure the comment itself
predicts ("the count rose while the list was being written").

The census is therefore carried as a **table of locations, never a number**, and
is reconciled against a read-based audit rather than a keyword grep — the
issue's own acceptance criterion, because the claim keeps changing verb.
Legitimate survivors are expected and must each get a verdict: `lockClassRow` is
a live single-row helper with real callers, and `deleteStudentAccount` retains a
genuine *post-commit* loop (`gdpr.ts:873`) that has nothing to do with locking.

The correction rule is CLAUDE.md's: **replace the claim, do not annotate it.**
The before-and-after belongs in the PR body; the comment carries only what is
true now. Where a corrected sentence would still assert a fact about another
module, it is deleted or moved to `docs/` with a link rather than rewritten in
place.

`docs/lock-order.md:1653-1659` is the odd one out and the most misleading: it is
the last surviving copy of the "an account that could never be erased" argument
that PR #246 showed to be inverted — `min(5_000 + N × 2_000, 20_000)` is
monotone non-decreasing in N and capped, so an all-status count could only ever
grant *more* budget, never less. The rebuttal now lives at `gdpr.ts:728-745`;
this paragraph does not point at it. It gets the cross-reference.

## 5. Non-goals

- **`template-lock-order.test.ts`'s two `it`s are not touched.** Issue #244's
  second comment measures them at 0/12 and 0/3 detection and offers three
  options — delete, re-aim, or restore. Choosing between them means deciding
  what those tests are *for*, which is a design decision with its own
  acceptance criteria, not a fix. It is filed as its own issue, carrying those
  measurements. Its stale *comments* (§4) are corrected here; its `it`s are not.
- **No production code changes.** `gdpr.ts` and `db-locks.ts` are read, mutated
  for measurement, and restored. The lock-order guarantees themselves are out of
  scope.
- **#289 is unaffected** — the pre-lock-superset property over a non-UTC session
  `TimeZone` is a different missing test in the same pre-lock. **#245 is
  unaffected** — `lockClassRowsOrdered`'s docblock contract is a different
  subject. Neither is a home for the filing in §5's first bullet.

## 6. Acceptance

1. `src/services/gdpr-lock-order.test.ts` passes green, and its test-body
   runtime stays under 2 s against the 1.15 s baseline — the three guards add
   assertions, not waits, so any larger rise means one of them is waiting on
   something it should not.
2. Mutations A, C′ and D each produce a **named** failure within ~2 s; B still
   produces its `40P01`. Each error text is recorded verbatim in the PR body.
3. The firing-count guard fails by name when a second matching statement is
   added.
4. Neither `src/services/gdpr.ts` nor `src/lib/db-locks.ts` differs from
   `origin/main`.
5. Every location in the audit's census (§4) is either corrected to state what
   is true now, or deleted — and each legitimate survivor is named with the
   reason it survives. The census lives in the plan and the PR body, where it
   has an owner; this spec deliberately carries no count.
6. `npm run verify` is green.
