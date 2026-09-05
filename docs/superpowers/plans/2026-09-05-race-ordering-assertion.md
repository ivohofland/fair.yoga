# Plan: #447 — a causal handshake, and the tier census that could not see it

Spec: `docs/superpowers/specs/2026-09-05-race-ordering-assertion-design.md`
Extraction inventory (line ranges, shared helpers, risks):
`/private/tmp/claude-501/-Users-ivohofland-Projects-fair-yoga/53e98ab4-86f2-41a6-8afc-561a73546ca0/scratchpad/extraction-inventory.md`

Five tasks. **Task 5 must run last** — it depends on the filenames tasks 2–4
create and on the test counts they produce. Tasks 2, 3 and 4 are independent of
each other and of task 1.

---

## Task 1 — replace the wall-clock ordering with an observed one ✅ done

**File:** `src/services/template-room-race.test.ts`

Replace `expect(archiveSettledAt).toBeGreaterThanOrEqual(resumeCommittedAt)`
and both `Date.now()` samples with the `pg_stat_activity` handshake described in
the spec §3: a `singleConnectionClient()` for the archive whose backend pid is
read before the archive is issued, a gate resolved inside the resume's
transaction once its update has *returned*, and a poll loop that exits on
whichever of "observed waiting" or "archive settled" happens first.

**Verification, all performed:**

| Check | Result |
|---|---|
| `npx vitest run src/services/template-room-race.test.ts --project unit` | 1 passed, `tests 76ms` (was ~2 s of sleeps) |
| Mutation M1 — `releaseResume(); await resume;` immediately after `await lockHeld`, so the resume commits before the archive is issued | fails at `:149` `expect(observedWaiting).toBe(true)`, **having passed** the `archiveError` and `isCheckViolationOn` assertions above it |
| Mutation M2 — resume updates `classType` instead of `isActive`, so no `ClassTemplate` lock is held | fails at `:137` `expected undefined to be defined` — the archive slips past, the original #272 shape |
| Both mutations reverted, re-run | 1 passed; `grep -c MUTATION` → 0 |
| `npx tsc --noEmit` | no error in this file |

M1 is the load-bearing one: it is the mutation the old `>=` comparison and the
issue's suggested order-array both **pass**.

---

## Task 2 — extract `gdpr.test.ts`'s lock-staging tests

**Source:** `src/services/gdpr.test.ts`
**Destination:** `src/services/gdpr-lock-order.test.ts` — **this file already
exists.** Append in its existing idiom; do not create a new file and do not
restructure what is there.

Move the tests the inventory lists under its `## gdpr.test.ts → ### A`
section, together with any docblock immediately above each one. Carry across
only the fixtures those tests need. Where a helper is shared with tests that
stay behind, the inventory says so explicitly — such a helper is duplicated or
imported, never moved.

**Acceptance:**
- Both files pass in isolation.
- **Test-count reconciliation:** `gdpr.test.ts`'s count drops by exactly the
  number moved, and `gdpr-lock-order.test.ts`'s rises by the same number. State
  both numbers and the arithmetic. An `it.each` over five statuses moves as
  five, not one.
- No import, helper, client or constant left unused in `gdpr.test.ts` — lint
  must be clean on both files.

## Task 3 — extract `waitlist.test.ts`'s lock-staging tests

**Source:** `src/services/waitlist.test.ts`
**Destination:** new `src/services/waitlist-lock-order.test.ts`.

Same rules as task 2. Note that four of these tests each open a **fresh
`PrismaClient`** and sleep 3 500 ms inside a held transaction; those clients
must be disconnected in the new file's `afterAll`, or the tier leaks
connections.

**Acceptance:** as task 2, plus the new file compiles and its header docblock
states, in one or two sentences, what it holds and why it cannot share a
parallel tier. No count of its own tests in that prose — name the behaviour,
not the number.

## Task 4 — extract `class-template-lifecycle.test.ts`'s lock-staging tests

**Source:** `src/services/class-template-lifecycle.test.ts`
**Destination:** new `src/services/class-template-lifecycle-lock-order.test.ts`.

Same rules as task 2. The inventory flags this file as the least mechanical of
the three — read its `### D` risks before starting.

**Acceptance:** as task 3.

## Task 5 — the config, last

**Files:** `vitest.config.ts`, and the duplicated sentence in
`src/services/gdpr-lock-order.test.ts`.

1. Add `src/services/waitlist-lock-order.test.ts` and
   `src/services/class-template-lifecycle-lock-order.test.ts` to
   `LOCK_CONTENTION_TESTS`.
2. **Correct the false description.** The comment introduces
   `db-locks-lock-order.test.ts`, `invitations-lock-order.test.ts` and
   `gdpr-lock-order.test.ts` as "all three are the SECOND kind: each asserts a
   staged race ends in neither `40P01` nor `55P03`".
   `invitations-lock-order.test.ts:283` and `:396` assert
   `toMatch(/40P01|deadlock/i)` — that the race **does** deadlock. Replace the
   description; do not annotate it with what it used to say.
3. **Correct the undercount, in both copies.** `vitest.config.ts:69` and
   `src/services/gdpr-lock-order.test.ts:76` both say `gdpr.test.ts` runs in
   ~26 s and "exactly one of its tests reads lock timing". After task 2 that
   sentence is doubly wrong — it was an undercount, and the tests it counted
   have moved. Restate both from what is true after this branch.
4. **Widen the census command** to catch both directions:
   `grep -rlE '(not\.)?toMatch\(/[^/]*(40P01|55P03|deadlock|lock timeout)' src --include='*.test.ts'`
5. **Restate the claim it carries.** "Every hit belongs on this list" cannot
   survive the widening, because the widened command admits tier-safe forms.
   It becomes a triage instruction — every hit needs a verdict — and the
   comment states the technique's limit plainly: this property is *semantic*,
   and the same assertion is also written `toBe('returned')`,
   `toEqual({ ok: true, … })` and `expect(elapsedMs).toBeGreaterThan(5_000)`,
   which no regex will find.

**Acceptance:**
- The widened command runs clean and every hit has a stated verdict.
- `src/lib/db-locks.test.ts` is recorded as a deliberate non-member with its
  reason (`NOWAIT` presence probes on rows it owns, no timing threshold).
- No prose count of list members anywhere — CLAUDE.md's *Comment Discipline*
  applies, and this comment has already gone stale twice by carrying one.

---

## Whole-branch review

The plan has five tasks, so after the per-task loop: **one whole-branch review
on the most capable model, one fix wave, one scoped re-review.** The
cross-task risk this exists to catch is specific and worth naming in the
dispatch:

- a test moved in tasks 2–4 but **not** removed from its source, or removed and
  not landed — only a reviewer holding all four diffs can reconcile the counts;
- a helper duplicated into two new files that has drifted between them;
- task 5's corrected prose describing a tier membership that tasks 2–4 did not
  actually produce.

## Verification budget, and what this branch cannot prove locally

`npm run verify` cannot go green in this worktree, for reasons that predate it
and are not this branch's to fix — the shared test database and the shared
generated Prisma client both carry `issue-339-class-room-archive`'s unmerged
migration (spec §6). Local evidence is therefore scoped to the touched files;
**CI is the signal cited in the PR body** for the tiers as a whole.

Per task, run the source file and its sibling directly:

```
npx vitest run --project unit <source> <sibling>
npx vitest run --project unit-sweeps      # after task 5, for the moved files
```
