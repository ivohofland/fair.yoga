# Plan: #447 — a causal handshake, and the tier census that could not see it

Spec: `docs/superpowers/specs/2026-09-05-race-ordering-assertion-design.md`

Four tasks. **Task 3 must follow task 2** — both edit `vitest.config.ts`, and
task 2 changes what task 3's prose has to describe.

> **Scope changed once, deliberately, after measurement.** This plan originally
> carried three extraction tasks, moving the lock-staging tests out of
> `gdpr.test.ts`, `waitlist.test.ts` and `class-template-lifecycle.test.ts` into
> `*-lock-order.test.ts` siblings. That is no longer in this branch. What
> changed it is recorded in spec §4.2.2 and §4.5: the set of tests to extract
> cannot be derived mechanically — a census keyed on assertion text and a
> census keyed on lock machinery each produce false positives *and* false
> negatives — so the real job is ~29 tests needing per-test judgment, not the
> 15 first counted. That is its own issue, filed by task 4, and it is not a
> prerequisite for fixing #447.

---

## Task 1 — replace the wall-clock ordering with an observed one ✅ done

**File:** `src/services/template-room-race.test.ts` — committed as `5778b75e`.

Replaced `expect(archiveSettledAt).toBeGreaterThanOrEqual(resumeCommittedAt)`
and both `Date.now()` samples with the `pg_stat_activity` handshake of spec §3:
a `singleConnectionClient()` for the archive whose backend pid is read before
the archive is issued, a gate resolved inside the resume's transaction once its
update has *returned*, and a poll loop exiting on whichever of "observed
waiting" or "archive settled" happens first.

**Verification, all performed:**

| Check | Result |
|---|---|
| `npx vitest run src/services/template-room-race.test.ts --project unit` | 1 passed, `tests 76ms` (was ~2 s of sleeps) |
| Mutation M1 — resume commits before the archive is issued | fails at `:149` `expect(observedWaiting).toBe(true)`, **having passed** the `archiveError` and `isCheckViolationOn` assertions above it |
| Mutation M2 — resume updates `classType`, so no `ClassTemplate` lock is held | fails at `:137` `expected undefined to be defined` — the archive slips past, the original #272 shape |
| Both reverted, re-run | 1 passed; `grep -c MUTATION` → 0 |
| `npx tsc --noEmit` | no error in this file |
| `update-class-lock-order.test.ts` (the file this technique came from) | passes here, `tests 121ms` — confirms `pg_stat_activity` visibility for this DB user |

M1 is load-bearing: it is the mutation the old `>=` comparison and the issue's
suggested order-array both **pass**.

---

## Task 2 — make list membership impossible to drift

**Files:** `vitest.config.ts`, the seven files named in `LOCK_CONTENTION_TESTS`,
and a new test.

The spec's finding is that *discovery* needs human judgment. **Drift does
not** — and drift is what has actually bitten this list twice.

1. Make `LOCK_CONTENTION_TESTS` importable. Adding `export` to it in
   `vitest.config.ts` is the one-word version and was rejected on measurement:
   a named export beside a default one makes Rollup print `MIXED_EXPORTS`
   three times on every vitest invocation, CI included. The lists move to
   `vitest.tiers.ts` instead, comments and all, and the config imports
   `SERIAL_TESTS` from there.
2. Give each of the seven listed files a marker in its **own** header docblock,
   naming why that file cannot share a parallel tier. The marker is the tether
   CLAUDE.md's *Comment Discipline* asks for where membership matters: it lives
   in the file it describes, and the test below makes it unable to disagree with
   the config.
3. New test asserting the marked set and the configured set are equal, in both
   directions, and that every configured path exists on disk.

**Acceptance:**
- Removing a marker from a listed file fails the test, naming that file.
- Adding a marker to an unlisted file fails the test, naming that file.
- Renaming or deleting a listed file fails the test.
- Each of those three is demonstrated by mutation, with the exact error text
  recorded, then reverted — per `solve-issue` §3. A tether that cannot fail
  certifies nothing, which is the same defect this whole branch is about.
- No prose count of members anywhere, in the test or the config.

## Task 3 — correct what the config comment claims

**Files:** `vitest.config.ts`, `src/services/gdpr-lock-order.test.ts`.

1. **The false description.** The comment introduces
   `db-locks-lock-order.test.ts`, `invitations-lock-order.test.ts` and
   `gdpr-lock-order.test.ts` as "all three are the SECOND kind: each asserts a
   staged race ends in neither `40P01` nor `55P03`".
   `invitations-lock-order.test.ts:283` and `:396` assert
   `toMatch(/40P01|deadlock/i)` — that the race **does** deadlock. Replace the
   description. Do not annotate it with what it used to say; that belongs in
   the PR body.
2. **The undercount, in both copies.** `vitest.config.ts:69` and
   `src/services/gdpr-lock-order.test.ts:76` both say `gdpr.test.ts` runs in
   ~26 s and "exactly one of its tests reads lock timing". It is at least nine.
   Correct both, and say where the real number now lives (the filed issue),
   rather than restating a number in two places that will drift again.
3. **The re-derivation command.** Widen it to catch both directions:
   `grep -rlE '(not\.)?toMatch\(/[^/]*(40P01|55P03|deadlock|lock timeout)' src --include='*.test.ts'`
   and demote its promise. "Every hit belongs on this list" cannot survive the
   widening. It becomes: every hit needs a verdict, this command finds only the
   SQLSTATE-shaped ones, and the property is semantic — the same assertion is
   also written `toBe('returned')`, `toEqual({ ok: true, … })` and
   `expect(elapsedMs).toBeGreaterThan(5_000)`, which no regex will find. Point
   at task 2's tether as the thing that actually holds.

**Acceptance:** the widened command runs clean; `src/lib/db-locks.test.ts` is
recorded as a deliberate non-member with its reason (`NOWAIT` presence probes
on rows it owns, no timing threshold); no prose member count survives.

## Task 4 — file the extraction issue ✅ done — #459

Content: the ~29 candidates by `file:line` and title, the census script and
what it proves about the limits of both census axes, the `+101%` whole-file
measurement with the CI-job caveat, and the four hazards the inventory found —
an inter-test ordering docblock at `waitlist.test.ts:2025-2031` that extraction
falsifies, three prose call-counts in `class-template-lifecycle.test.ts`
(`:154`, `:1178`, `:2484`), counter-derived slot spacing that fails at fixture
build rather than as a lock error, and two imports that go dead.

File it with the rigour of a spec, and link it from the config comment task 3
edits.

---

## Build note

Tasks 2 and 3 are small, prose-dense and heavily context-dependent — two files
plus one new test — and this session already holds the measurements they must
state. They are built directly rather than dispatched, which trades
`solve-issue` §5's context saving for fewer hand-offs on exactly the kind of
careful wording that has gone wrong here twice. **The §6 PR review gate still
applies in full**, and is where cross-task blindness gets caught.

## Verification budget

`npm run verify` cannot go green in this worktree, for reasons predating the
branch: the shared `ethical_yoga_test` database and the shared generated Prisma
client both carry `issue-339-class-room-archive`'s unmerged migration (spec
§6). Local evidence is scoped to the touched files; **CI is what the PR body
cites** for the tiers as a whole.

```
npx vitest run --project unit src/services/template-room-race.test.ts <tether test>
npx tsc --noEmit          # expect exactly the one pre-existing class-list.test.tsx error
```
