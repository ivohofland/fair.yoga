# Finally-guarding the staged races in the two #468 lock-order siblings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every staged race in `class-generator-lock-order.test.ts` and
`studio-class-template-lifecycle-lock-order.test.ts` releases and joins its
parked holder inside a `finally`, so a rejection in the staged span fails that
test alone rather than parking a row lock for the holder's full Prisma budget
(15 s or 20 s) with the rest of the serial tier queued behind it (#474).

**Architecture:** No new mechanism. `0c0f43b7` already made this exact fix for
four tests in `class-template-lifecycle-lock-order.test.ts` and
`gdpr-lock-order.test.ts`, and both target files already contain correct
examples of the pattern. This plan applies it to the sites that lack it, and
records where the issue's own census was wrong.

**Tech Stack:** Vitest (`unit-sweeps` project, `fileParallelism: false`),
Prisma against the dedicated test database (`DATABASE_URL_TEST`), TypeScript
strict.

**Spec:** None, deliberately. The spec gate in `.claude/skills/solve-issue/`
asks for one when an issue spans more than one subsystem, admits more than one
reasonable design, changes an invariant or the data model, or touches money,
auth or shared state. This is test teardown in two files, with the design
fixed by an in-repo precedent that landed this week. The one genuine design
question — whether the racing promises are joined inside the `finally` or
after it — is settled in *Global Constraints* below, with the reason.

**What this document is.** A record of the plan as issued, not a maintained
specification. Its fenced code blocks reproduce the shape prescribed at the
time; the shipped files are authoritative for what the code says, and
`git log` for how it got there.

---

## The premise, re-measured

The issue says **nine** unguarded sites. There are **eight**. The correction
matters enough to state before the tasks, because a task told to fix nine
would edit a site that is already correct.

**Method.** `/usr/bin/grep -n 'release();\|commit();\|} finally {\|try {'`
over both files to enumerate candidates, then a brace-depth walk from each
`try {` to decide, for each `release();`/`commit();` line, whether it is
lexically inside that `try`'s block. The walk is what the issue's `grep`
could not do: a `grep` classifies by proximity to a `finally` token, and
proximity is not nesting.

Re-derive the candidate list with:

```
/usr/bin/grep -n 'release();\|commit();\|} finally {\|try {' \
  src/services/class-generator-lock-order.test.ts \
  src/services/studio-class-template-lifecycle-lock-order.test.ts
```

### `src/services/class-generator-lock-order.test.ts`

Every `try` block in this file closes before the next candidate begins —
`190→203`, `328→364`, `411→443`, `491→520`, `1005→1056`, plus the two guarded
sites at `1180`/`1312`. So:

| line | verdict | why |
|---|---|---|
| `:275` | **unguarded — fix** | outside every `try`; staging `expect(archiveSettled).toBe(false)` sits above the release |
| `:591` | **unguarded — fix** | outside every `try`; staging `expect(sweepSettled).toBe(false)` above the `commit()` |
| `:676` | **unguarded — fix** | outside every `try`; same shape as `:591` |
| `:780` | **unguarded — fix** | outside every `try`; *no* staging `expect` — see "the second shape" below |
| `:845` | **unguarded — fix** | outside every `try`; same shape as `:780` |
| `:1026` | **already guarded — leave alone** | inside the `try` opened at `:1005`, whose `finally` at `:1051` releases at `:1052` |

`:1026` is the issue's error. Its `release()` is the *happy-path* release —
`await holding` two lines below cannot proceed without it — and the `finally`
at `:1052` is the safety net that already exists. The block comment at
`:998-1004` states the convention this whole plan follows:

> `try`/`finally` around everything after the holder is in flight.

Sites `:357`, `:430`, `:516`, `:1052`, `:1215` and `:1339` are the six the
issue correctly lists as already guarded. They are not touched.

### `src/services/studio-class-template-lifecycle-lock-order.test.ts`

This file contains exactly one `try {`, at `:644` (closing `:669`). So `:309`,
`:452` and `:533` are all outside any `try` — **three unguarded, one guarded
(`:663`)**, exactly as the issue states.

### The second shape: `:780` and `:845`

The issue frames every site as "if the staging assertion above the release
fails". That is true of six of the eight. `:780` and `:845` have no assertion
between holder-in-flight and `release()` at all:

```ts
      await parked;
      const generating = generateInstancesForTemplate(prisma, await freshTemplate(), now);
      await new Promise((r) => setTimeout(r, 400));
      release();
      await holding;
      const result = await generating;
      await holder.$disconnect();
```

They still have the defect, by two routes the issue does not name:

1. **Before the release**, `await freshTemplate()` is a database read inside
   an argument list. It can reject while the holder's uncommitted
   `CalendarEntry` insert is already holding its row — parking it for the full
   20 s budget, exactly the issue's failure.
2. **After the release**, `await holding` and `await generating` are each
   unguarded, so a rejection from either skips `await holder.$disconnect()`.
   These two sites own a dedicated `PrismaClient`, so that is a leaked
   connection pool on top of an unjoined generator still writing
   `CalendarEntry` rows for this teacher while the block's `afterEach` deletes
   them.

The fix is the same `try`/`finally`; only the span and the contents of the
`finally` differ, which is why they are their own task step.

---

## Global Constraints

- **No assertion changes.** Every `expect` keeps its subject, its matcher and
  its argument. The tests must still fail for the same reasons; a test that
  stops being able to fail is worse than the defect being fixed.
- **`finally` bodies do not swallow.** Write `await claiming;`, not
  `await claiming.catch(() => {})`. The accepted trade-off is that a
  rejecting join in a `finally` replaces the staging assertion's message with
  its own — rare, because in the failure this fix exists to contain the holder
  is healthy and commits normally once released.

  **This is a choice between two live in-repo conventions, not a dominant one.**
  `0c0f43b7`, the most recent precedent and the one #474 cites, does not
  swallow at any of its three sites. The two files being edited here mostly do:

  ```
  git show 8163c986:src/services/class-generator-lock-order.test.ts | grep -n 'catch(() => {})'
  git show 8163c986:src/services/studio-class-template-lifecycle-lock-order.test.ts | grep -n 'catch(() => {})'
  ```

  returns **six** pre-existing swallow sites — `class-generator` `:361`,
  `:431`, `:517`, `:1216`, `:1340` and `studio` `:664` — of which exactly
  **one**, `class-generator:361`, states a reason beside its `catch`
  (`:358-360`). `class-generator:513-516` explains its `finally` but not its
  swallow.

  The no-swallow side is taken anyway, because #474's own acceptance criteria
  require that the tests "still fail for the same reasons", and swallowing a
  join is what would let a failing one go unreported. Where a new `finally`
  sits beside a swallowing sibling, its comment says so and why. **None of the
  six pre-existing sites is touched.**
- **The racing promises are joined inside the `finally`, not after it.** The
  repo holds two precedents that disagree: `0c0f43b7` moved
  `await Promise.all([erasing, registering])` *into* the `finally` at
  `gdpr-lock-order.test.ts:1464` with the reason written beside it — "rather
  than leaving them running unjoined against the describe's shared `prisma`
  while its `afterAll` may already be deleting the rows they touch" — while
  leaving `await Promise.all([first, second])` *outside* it at
  `class-template-lifecycle-lock-order.test.ts:445`. The three studio sites
  have the second's shape and the first's hazard, so this plan takes the
  first. Code after the `finally` may re-await the same promise for its value;
  awaiting a settled promise a second time costs nothing.
- **Comment discipline (CLAUDE.md).** Each new comment annotates the
  `finally` it sits on and nothing wider: no count of how many sites this
  branch fixed, no roster of the other files, no "this previously read". State
  which hold is released, which budget it would otherwise run to, and which
  teardown queues behind it. The counts and the census belong in this plan,
  in the PR body and in the issue — where they have an owner.
- **`release`/`commit` are `Promise` resolvers**, so calling one twice is a
  no-op. A `finally` that releases after the happy path already released is
  correct, not a bug.
- **In this worktree, `--project integration` and e2e cannot run** — they need
  the dev server on `:3000` and the shared dev database. `unit` and
  `unit-sweeps` *can*: they run against `DATABASE_URL_TEST`
  (`ethical_yoga_test`), which the Docker container already serves. Scope
  local verification to typecheck, lint, `unit`, `unit-sweeps` and
  `components`; cite the CI run for the other tiers.
- **Never touch the dev server on `:3000`.** It is the user's and it is
  running. Nothing in this plan needs it.

## Background the implementer needs

**The reference shape**, from `class-generator-lock-order.test.ts:352-361`,
the file's own already-correct site:

```ts
      } finally {
        // In a `finally`, so a failure above fails this test alone. Without
        // it the claim holds the row for its full 15s, this block's
        // `afterEach` queues behind it, and one broken guard reports as a
        // test timeout plus a hook timeout with the real cause buried.
        release();
        await claiming.catch(() => {});
        warn.mockRestore();
      }
```

**Why the blast radius changed** (background, not something to write into a
comment): both files joined `LOCK_CONTENTION_TESTS` in #468, and `unit-sweeps`
runs `fileParallelism: false`. A parked holder used to stall one worker of
several in the parallel `unit` tier; it now stalls the remainder of a serial
tier measured at 128.01 s on this branch's base.

**Which budget each site runs under** — read it off the site's own
`{ timeout: N }`, do not assume: the `class-generator` sites at `:275`, `:591`
and `:676` are `15_000`; `:780` and `:845` are `20_000`; all three studio
sites are `15_000`.

## File Structure

- `src/services/class-generator-lock-order.test.ts` — five sites. No new
  imports, no new tests, no assertion changes.
- `src/services/studio-class-template-lifecycle-lock-order.test.ts` — three
  sites. Same.

No other file changes. Neither file's header docblock states anything this
change falsifies — verified by reading both headers; the `@serial-tier
lock-contention` markers are about tier membership, which is untouched.

---

### Task 1: `class-generator-lock-order.test.ts` — all five sites

**Files:**
- Modify: `src/services/class-generator-lock-order.test.ts` — five sites, in
  two shapes. Steps 1-3 cover the three staging-assertion sites; steps 4-5
  cover the two that own a `PrismaClient`.

**Anchors, not line numbers.** Line numbers shift as you edit. Locate each of
the three staging-assertion sites by its enclosing `it(...)` title:

1. `'makes a concurrent archive wait until the claim transaction commits'`
   — the `release(); await claiming; const result = await archiving;` run.
2. `'does not generate for a template archived after the list was read'`
   — staging assertion `expect(sweepSettled).toBe(false)` above a
   `commit(); await archiving; await sweeping;`.
3. `'writes the values committed while the sweep was waiting, not the ones it read'`
   — staging assertion `expect(sweepSettled).toBe(false)` above a
   `commit(); await editing; await sweeping;`.

Sites 2 and 3 are distinguished by what they join (`archiving` vs `editing`)
and by the numbered `// 3.` comment above the release, which stays.

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks read. Task 3 mutation-tests site 1.

**Steps:**

- [ ] For each of the three sites, wrap the staging assertion(s) — and only
      those, plus any comment attached to them — in a `try`, and move the
      release and every join below it into a `finally`:

      ```ts
      await new Promise((r) => setTimeout(r, 300));
      try {
        // Without FOR UPDATE the archive's UPDATE is unobstructed and this is true.
        expect(archiveSettled).toBe(false);
      } finally {
        // <the comment specified in the next step>
        release();
        await claiming;
        await archiving;
      }

      const result = await archiving;
      expect(result.ok).toBe(true);
      ```

      The existing comment above the assertion moves *with* the assertion,
      into the `try`. The numbered step comments (`// 3. Commit the archive; …`)
      move with the release, into the `finally`.

- [ ] Write each `finally`'s comment to say, for that site: which hold is
      released, the budget it would otherwise run to (read from the site's own
      `{ timeout: N }`), which teardown queues behind it (`afterEach` or
      `afterAll` — read the enclosing block, do not assume), and why the racer
      is joined here rather than below. Follow the reference shape above.
      Do not restate the count of sites this branch fixes.

- [ ] **The two `PrismaClient`-holder sites.** Anchors:
      `'names a date lost to a concurrent insert by what still holds it'` and
      `'names a short date nothing live overlaps as raced'`. These are the two
      that construct `const holder = new PrismaClient()` *and* lack a `try` —
      the third `PrismaClient` holder in this file lives in the
      `pauseOrResumeTemplate` helper below them and is already guarded; do not
      touch it.

      Open the `try` immediately after the
      `holding` transaction is constructed — the point the file's own
      `:998-1004` comment calls "after the holder is in flight" — and close it
      after the site's final assertion. Hoist `generating` to a `let` declared
      above the `try` so the `finally` can join it. The `finally` must
      release, join both promises, and disconnect the holder's client, with
      no step skipped if an earlier one rejects and nothing swallowed:

      ```ts
      let generating: ReturnType<typeof generateInstancesForTemplate> | undefined;
      try {
        await parked;
        generating = generateInstancesForTemplate(prisma, await freshTemplate(), now);
        await new Promise((r) => setTimeout(r, 400));
        release();
        await holding;
        const result = await generating;

        expect(result.created).toBe(3);
        expect(result.skipped).toEqual([{ date: collide, reason: 'blocked_by_overlap' }]);
      } finally {
        release();
        const joined = await Promise.allSettled([holding, generating]);
        await holder.$disconnect();
        const failed = joined.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed) throw failed.reason;
      }
      ```

      **`allSettled`, not sequential `await`s.** This snippet originally read
      `release(); try { await holding; await generating } finally { await
      holder.$disconnect() }`, which contradicts the property stated one
      paragraph above it: sequential `await`s in a `finally` mean a rejecting
      `holding` propagates immediately and `generating` is never joined at all
      — the exact leak the comment beside it promises to prevent. The
      whole-branch review caught it after the code had already followed the
      snippet; the shape above joins both unconditionally, disconnects
      unconditionally, and rethrows the first rejection so nothing is
      swallowed.

- [ ] Give each of those two `finally` blocks a comment covering: that the
      span starts where the holder is in flight, that `freshTemplate()` reads
      the database and can reject there, the 20 s budget the holder would
      otherwise run to, and why the generator is joined rather than left
      running against the shared `prisma`. The inner `finally` gets its own
      one-liner about the dedicated client.

- [ ] Confirm no assertion changed:
      `git diff -U0 -- src/services/class-generator-lock-order.test.ts | grep '^[-+].*expect('`
      must show only re-indentation — every `-` line has a matching `+` line
      differing in leading whitespace alone.

- [ ] `npx vitest run --project unit-sweeps src/services/class-generator-lock-order.test.ts`
      is green.

- [ ] `npm run typecheck` and `npm run lint` are green.

**Ordering:** Tasks 1 and 2 touch different files and are independent — they
may run concurrently. Task 3 depends on both.

---

### Task 2: `studio-class-template-lifecycle-lock-order.test.ts` — all three sites

**Files:**
- Modify: `src/services/studio-class-template-lifecycle-lock-order.test.ts`.

**Anchors:** `'two concurrent archives: the loser records nothing over the winner'`,
`'a concurrent archive mid-resume is reported as archived, not thrown'`, and
`'a concurrent archive mid-pause is reported as unchanged, not archived'`. The
file's fourth staged race, the `updateStudioClassTemplate` one near the end,
is already guarded — do not touch it.

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks read.

**Steps:**

- [ ] For each of the three sites: wrap the two staging assertions (and the
      comment attached to them, where there is one) in a `try`, move
      `release(); await blocking;` into the `finally`, and add the join of the
      two racers there per *Global Constraints*:

      ```ts
      await new Promise((r) => setTimeout(r, 300));
      try {
        // Both are blocked in their first write. …
        expect(firstSettled).toBe(false);
        expect(secondSettled).toBe(false);
      } finally {
        // <the comment specified in the next step>
        release();
        await blocking;
        await Promise.all([first, second]);
      }

      const settled = await Promise.all([first, second]);
      ```

      The second and third sites' racers are named `archive`/`resume` and
      `archive`/`pause`, not `first`/`second`, and the third has no comment
      above its staging assertions — read each site rather than pattern-matching
      the block above.

- [ ] Write each `finally`'s comment per *Global Constraints*: which hold is
      released, the 15 s budget it would otherwise run to (confirm against each
      site's own `{ timeout: N }`), which teardown queues behind it, and why
      the racers are joined here rather than below. **This file has no
      `afterEach` anywhere** — `/usr/bin/grep -n 'afterEach' <path>` returns
      nothing — so a comment saying "this block's `afterEach`" would be false
      here even though it is true at the reference site in
      `class-generator-lock-order.test.ts`. The hooks are the per-`describe`
      `afterAll`s and the file-level one; each of these tests mints its own
      template via `makeTemplate(...)`, so name the teardown that actually
      reaches that row.

- [ ] Confirm no assertion changed:
      `git diff -U0 -- src/services/studio-class-template-lifecycle-lock-order.test.ts | grep '^[-+].*expect('`
      shows re-indentation only.

- [ ] `npx vitest run --project unit-sweeps src/services/studio-class-template-lifecycle-lock-order.test.ts`
      is green.

- [ ] `npm run typecheck` and `npm run lint` are green.

---

### Task 3: Prove the guards still bite, and that a failure is now contained

This task writes no source code. It produces the evidence the issue's
acceptance criteria ask for, as a report the PR body quotes.

**Prerequisite:** Tasks 1 and 2 are committed. Mutations are applied to a
clean tree and reverted with `git checkout --`, which discards *every*
uncommitted change to that file — so an uncommitted sibling edit would be
destroyed.

**Steps:**

- [ ] **M1 — the guard still bites (issue criterion 2).** In
      `src/services/entry-generation.ts`, delete the ` FOR UPDATE OF tpl`
      clause from the claim's `$queryRaw` (currently `:424`, inside
      `claimRuleForGeneration`). Run
      `npx vitest run --project unit-sweeps src/services/class-generator-lock-order.test.ts`.
      Record the exact failure: the test named
      `makes a concurrent archive wait until the claim transaction commits`
      must fail on `expect(archiveSettled).toBe(false)`. Capture the message
      verbatim. Restore with
      `git checkout -- src/services/entry-generation.ts` and re-run to green.

- [ ] **M2, on the fixed branch — a failure is contained (issue criterion 3).**
      Flip that same test's staging assertion to
      `expect(archiveSettled).toBe(true)`. Run the **whole tier**:
      `npx vitest run --project unit-sweeps`. Record which tests fail and the
      total duration. Expected: that one test, no hook timeout, no timeout in
      any later file. Restore and re-run to green.

- [ ] **M2, on the base — the contrast.** From a scratch checkout of
      `origin/main` (`git worktree add` a second directory, or
      `git stash`-free `git checkout origin/main -- <the two files>` then
      restore), apply the same flip and run the whole tier again. Record the
      difference: the base is expected to show the failing test *plus* a
      timeout elsewhere, or a materially longer duration. **If it does not,
      say so** — the containment claim then rests on M2's fixed-branch result
      alone and the PR body must not assert a contrast that was not observed.

- [ ] **Tier duration (issue criterion 4).** Run
      `/usr/bin/time -p npx vitest run --project unit-sweeps` on the fixed
      branch, unmutated. Compare against the base measurement recorded in this
      plan: **27 files, 217 tests, all passing, 128.01 s wall** (`real 129.81`),
      measured on this worktree before any change. Report file count, test
      count and duration; the file and test counts must be identical.

- [ ] Write the findings to
      `docs/superpowers/plans/2026-09-06-staged-race-finally-guards-evidence.md`
      so the PR body can quote exact strings rather than paraphrase them.

---

## Verification

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npx vitest run --project unit` (the two files are excluded from it, but
      the claim mutation in M1 touches a module `unit` covers)
- [ ] `npx vitest run --project unit-sweeps` — 27 files, 217 tests
- [ ] `npx vitest run --project components`
- [ ] CI is the signal for `integration` and `e2e`; cite the run in the PR body.
