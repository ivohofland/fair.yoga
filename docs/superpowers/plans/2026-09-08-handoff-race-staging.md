# Staged interleavings in `handoff.test.ts` — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four assertions in `src/lib/auth/handoff.test.ts` that hope two concurrent calls interleave a particular way with four that place the sibling's write exactly where the race puts it, so each of `claimWithCode`'s three count guards is pinned deterministically instead of ~92% of the time.

**Architecture:** Each staged test makes **one** real `claimWithCode` call through a client built with `prisma.$extends({ query: { magicLinkToken: { … } } })`. The hook interposes the concurrent sibling — either the sibling's whole `claimWithCode` call on the *unhooked* client, or the single statement it would have issued — at the statement boundary the race requires. No shared helper: the repo's existing hooks (`src/services/waitlist.test.ts:1551`, `src/services/gdpr.test.ts:1008`) are written inline per test, and each hook here is short enough to read as the race it stages.

**Tech Stack:** TypeScript strict, Vitest 4 (`unit` project, real Postgres via `DATABASE_URL_TEST`), Prisma 6 client extensions, pino (`@/lib/log`) spied with `vi.spyOn`.

**Spec:** `docs/superpowers/specs/2026-09-08-handoff-race-staging-design.md`

## Global Constraints

- **`HANDOFF_MAX_ATTEMPTS` is 5** and is imported, never hardcoded. Fixtures say `HANDOFF_MAX_ATTEMPTS - 1`, not `4`.
- **The sibling always runs on the plain `db`,** never on the extended client — otherwise the hook re-enters itself.
- **`$extends` returns a client missing `$on`,** so it is not assignable to a `PrismaClient` parameter. End every extension with `}) as unknown as PrismaClient;` and keep the one-line comment saying why, matching `src/services/waitlist.test.ts:1578`.
- **Every hook counts its own invocations** in a `let hookCalls = 0;` and every staged test asserts `expect(hookCalls).toBe(1)`. A hook that stops firing must fail loudly, not stage nothing silently.
- **Every staged test asserts `expect(warn).toHaveBeenCalledTimes(1)`** as well as the payload. Each staged interleaving produces exactly one warn; a second one means the interleaving drifted.
- **No `for` loop and no `Promise.all` in any staged test.** If either appears, the test is back to hoping.
- **`afterEach(() => vi.restoreAllMocks())` already exists** at `src/lib/auth/handoff.test.ts:145` and covers the `log.warn` spies. Do not add another.
- Tests run with `npx vitest run --project unit src/lib/auth/handoff.test.ts`. Integration and e2e cannot run from this worktree (no `:3000`); CI is their signal.

---

### Task 1: The over-count guard — the flake #509 reports

**Files:**
- Modify: `src/lib/auth/handoff.test.ts` — replace the test titled `'warns on an over-count when two concurrent candidates both cross the budget together'`, together with the `// The existing reap-race test above uses exactly one live candidate…` comment block introducing it, with the staged test below. (It is the last test in the file, at `:431-466` on `42d259af`; **anchor on the title, not the line numbers** — Tasks 1-4 each change this file's length and may run in any order.)

**Interfaces:**
- Consumes: `stampedWithRedirect(email, nonce, redirectTo)` (`:135`), `asBrowserNonce` , `HANDOFF_MAX_ATTEMPTS`, `log`, the module-level `db`.
- Produces: nothing other tasks depend on. Tasks 1-4 are independent and may run in any order.

- [ ] **Step 1: Record the pre-change behaviour of the test being replaced**

Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts -t "over-count"`

Expected: PASS (usually — it is the ~8%-in-tier / ~1.3%-alone flake). Note the reported duration; the staged replacement should be far faster.

- [ ] **Step 2: Replace the test**

Delete that comment block and the `it(…)` it introduces, and write in their place:

```ts
  // Both concurrent calls read `handoffCode`, `handoffAttempts` in one
  // `findMany` before either writes, so both compute `expectedReaps = 1` —
  // only `/b`, at `MAX - 1`, is predicted to cross. Both then increment BOTH
  // candidates, so `/a` crosses too and whichever `deleteMany` runs first
  // reaps two rows against its own prediction of one.
  //
  // The sibling's `updateMany` is staged as `args` re-issued rather than as a
  // whole nested `claimWithCode` call: a nested call would take its snapshot
  // AFTER this call's increment and predict two reaps rather than one, which
  // is a different race. Re-issuing `args` is not an approximation of the
  // sibling's statement — both calls derive `ids` from the same snapshot, so
  // it is a copy of it.
  //
  // Interposed inside the hook rather than issued before the call, so it
  // lands after the miss path has taken its snapshot and computed
  // `expectedReaps` — the actual shape of the race, not a rearrangement of it
  // that would also pass against a guard that never fired.
  it('warns on an over-count when a sibling increment lands before this call reaps', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const email = `claim-staged-overcount-${Date.now()}@example.com`;
    const nonce = `nonce-staged-overcount-${Date.now()}`;

    const codeA = await stampedWithRedirect(email, nonce, '/a');
    const codeB = await stampedWithRedirect(email, nonce, '/b');
    await db.magicLinkToken.updateMany({
      where: { email, redirectTo: '/a' },
      data: { handoffAttempts: HANDOFF_MAX_ATTEMPTS - 2 },
    });
    await db.magicLinkToken.updateMany({
      where: { email, redirectTo: '/b' },
      data: { handoffAttempts: HANDOFF_MAX_ATTEMPTS - 1 },
    });
    const wrong = ['000000', '111111', '222222'].find((g) => g !== codeA && g !== codeB)!;

    let hookCalls = 0;
    const racing = db.$extends({
      query: {
        magicLinkToken: {
          async updateMany({ args, query }) {
            hookCalls += 1;
            const ours = await query(args);
            await db.magicLinkToken.updateMany(args);
            return ours;
          },
        },
      },
      // `$extends` returns a client missing `$on`, so it is not assignable to
      // `claimWithCode`'s `PrismaClient` parameter even though every method it
      // calls here is the real one — same cast as the hooks in
      // `waitlist.test.ts`.
    }) as unknown as PrismaClient;

    expect(await claimWithCode(racing, asBrowserNonce(nonce), wrong)).toEqual({ kind: 'invalid' });

    expect(hookCalls).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { expected: 1, actual: 2 },
      'handoff: deleteMany reaped a different number of exhausted candidates than expected',
    );
  });
```

`PrismaClient` is already imported at `:2`; no import changes are needed.

- [ ] **Step 3: Run it**

Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts -t "over-count"`
Expected: PASS.

- [ ] **Step 4: Mutation — prove the guard is what makes it pass**

The test is written against code that already exists, so its RED evidence is a mutation, not a first run. Apply this to `src/lib/auth/handoff.ts:187`:

```ts
    if (reaped.count !== expectedReaps) {      // before
    if (reaped.count < expectedReaps) {        // after — over-counts no longer warn
```

Run the same command. Expected: FAIL. Record the exact assertion text in the commit body — it should report `warn` called 0 times.

Then restore `!==`, re-run, expect PASS. Confirm with `git diff --stat src/lib/auth/handoff.ts` that the restore left the file unchanged.

- [ ] **Step 5: Mutation — prove the staging is what makes it fail**

Comment out the interposed `await db.magicLinkToken.updateMany(args);` line inside the hook. Run. Expected: FAIL (`warn` called 0 times, and the guard is intact) — proving the sibling's statement, not the fixture, is what crosses `/a` over the line. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth/handoff.test.ts
git commit -m "test(auth): stage the over-count race instead of hoping for it (#509)"
```

---

### Task 2: The reap under-count guard

**Files:**
- Modify: `src/lib/auth/handoff.test.ts` — replace the test titled `'warns when two concurrent wrong guesses race the same near-exhausted candidate'` with the staged test below. (At `:370-391` on `42d259af`; **anchor on the title**, since sibling tasks shift the line numbers.)

**Interfaces:**
- Consumes: `stampedToken(email, nonce)` (`:126`), `asBrowserNonce`, `HANDOFF_MAX_ATTEMPTS`, `log`, `db`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Replace the test**

Delete the whole `it('warns when two concurrent wrong guesses race the same near-exhausted candidate', …)` block and write in its place:

```ts
  // A sibling wrong guess runs to completion between this call's increment
  // and its reap: it finds the row already at the budget, sweeps it into its
  // own `spent` set and deletes it there, so this call's `deleteMany` finds
  // nothing left to reap against its prediction of one.
  //
  // The sibling is a whole `claimWithCode` on the UNHOOKED client, so every
  // statement it issues is the real one and it cannot re-enter this hook.
  // Interposed after `query(args)` rather than before it, because the row has
  // to cross the budget — this call's own increment is what puts it there.
  it('warns when a sibling reaps the row this call was about to reap', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const email = `claim-staged-underreap-${Date.now()}@example.com`;
    const nonce = `nonce-staged-underreap-${Date.now()}`;
    const code = await stampedToken(email, nonce);
    await db.magicLinkToken.updateMany({
      where: { email },
      data: { handoffAttempts: HANDOFF_MAX_ATTEMPTS - 1 },
    });
    const wrong = ['000000', '111111'].find((g) => g !== code)!;

    let hookCalls = 0;
    const racing = db.$extends({
      query: {
        magicLinkToken: {
          async updateMany({ args, query }) {
            hookCalls += 1;
            const ours = await query(args);
            await claimWithCode(db, asBrowserNonce(nonce), wrong);
            return ours;
          },
        },
      },
      // `$extends` returns a client missing `$on`, so it is not assignable to
      // `claimWithCode`'s `PrismaClient` parameter even though every method it
      // calls here is the real one — same cast as the hooks in
      // `waitlist.test.ts`.
    }) as unknown as PrismaClient;

    expect(await claimWithCode(racing, asBrowserNonce(nonce), wrong)).toEqual({ kind: 'invalid' });

    expect(hookCalls).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { expected: 1, actual: 0 },
      'handoff: deleteMany reaped a different number of exhausted candidates than expected',
    );
  });
```

- [ ] **Step 2: Run it**

Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts -t "about to reap"`
Expected: PASS.

If `warn` is called more than once, the sibling itself warned — read which message fired and fix the fixture rather than relaxing the assertion.

- [ ] **Step 3: Mutation — prove the guard bites**

`src/lib/auth/handoff.ts:187`:

```ts
    if (reaped.count !== expectedReaps) {      // before
    if (reaped.count > expectedReaps) {        // after — under-counts no longer warn
```

Run. Expected: FAIL, `warn` called 0 times. Record the text. Restore, re-run green, and confirm `git diff --stat src/lib/auth/handoff.ts` is empty.

- [ ] **Step 4: Mutation — prove the staging bites**

Change the interposed sibling from the unhooked client to a no-op (`await Promise.resolve();`). Run. Expected: FAIL — nothing reaped the row, so this call's own `deleteMany` reaps exactly its prediction. Restore.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/handoff.test.ts
git commit -m "test(auth): stage the reap under-count race instead of hoping for it (#509)"
```

---

### Task 3: The spent-cleanup guard

**Files:**
- Modify: `src/lib/auth/handoff.test.ts` — replace the test titled `'warns when two concurrent claims both try to reap the same already-spent candidate'`, together with the `// Two concurrent calls racing the same already-exhausted candidate…` comment block introducing it, with the staged test below. (At `:393-419` on `42d259af`; **anchor on the title**.)

**Interfaces:**
- Consumes: `stampedToken(email, nonce)` (`:126`), `asBrowserNonce`, `HANDOFF_MAX_ATTEMPTS`, `log`, `db`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Replace the test**

Delete that comment and the `it(…)` under it, and write:

```ts
  // Two calls racing an already-exhausted candidate both read it as `spent`
  // and both try to delete it; whichever runs second finds nothing left.
  // Staged by interposing the sibling right after THIS call's `findMany`, so
  // both have the row in their `spent` set before either deletes it — which
  // is the only ordering that reaches the guard.
  //
  // The exact guess doesn't matter: this row is already exhausted and gets
  // swept into `spent` regardless of whether it matches.
  it('warns when a sibling reaps the already-spent candidate first', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const email = `claim-staged-spent-${Date.now()}@example.com`;
    const nonce = `nonce-staged-spent-${Date.now()}`;
    await stampedToken(email, nonce);
    await db.magicLinkToken.updateMany({
      where: { email },
      data: { handoffAttempts: HANDOFF_MAX_ATTEMPTS },
    });
    const guess = '000000';

    let hookCalls = 0;
    const racing = db.$extends({
      query: {
        magicLinkToken: {
          async findMany({ args, query }) {
            hookCalls += 1;
            const ours = await query(args);
            await claimWithCode(db, asBrowserNonce(nonce), guess);
            return ours;
          },
        },
      },
      // `$extends` returns a client missing `$on`, so it is not assignable to
      // `claimWithCode`'s `PrismaClient` parameter even though every method it
      // calls here is the real one — same cast as the hooks in
      // `waitlist.test.ts`.
    }) as unknown as PrismaClient;

    expect(await claimWithCode(racing, asBrowserNonce(nonce), guess)).toEqual({ kind: 'invalid' });

    expect(hookCalls).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { expected: 1, actual: 0 },
      'handoff: spent-candidate cleanup reaped a different number of rows than expected',
    );
  });
```

- [ ] **Step 2: Run it**

Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts -t "already-spent"`
Expected: PASS.

- [ ] **Step 3: Mutation — prove the guard bites**

`src/lib/auth/handoff.ts:145`:

```ts
    if (reapedSpent.count !== spent.length) {      // before
    if (reapedSpent.count > spent.length) {        // after — under-counts no longer warn
```

Run. Expected: FAIL, `warn` called 0 times. Record the text, restore, re-run green, confirm `git diff --stat src/lib/auth/handoff.ts` is empty.

- [ ] **Step 4: Mutation — prove the staging bites**

Move the interposed `await claimWithCode(db, …)` from after `query(args)` to before it. Run. Expected: FAIL — the sibling then deletes the row *before* this call's `findMany`, so this call sees no candidates at all, returns at the `candidates.length === 0` line and never reaches the guard. This mutation is worth keeping in the commit message: it is what shows the hook's *position*, not merely its presence, is load-bearing. Restore.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/handoff.test.ts
git commit -m "test(auth): stage the spent-cleanup race instead of hoping for it (#509)"
```

---

### Task 4: The `updateMany` under-count guard, and the loop it comes off

**Files:**
- Modify: `src/lib/auth/handoff.test.ts` — keep the test titled `'the race: a correct claim concurrent with wrong guesses never throws'` and its loop; remove only its trailing `expect(warn)` assertion, its now-unused `warn` spy, and the comment paragraph that justified them. Add the staged test below directly after it. (At `:336-368` on `42d259af`; **anchor on the title**.)

**Interfaces:**
- Consumes: `stampedToken(email, nonce)` (`:126`), `asBrowserNonce`, `log`, `db`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Strip the timing-dependent assertion from the surviving loop**

In the `it('the race: a correct claim concurrent with wrong guesses never throws', …)` block:

- delete its first line, `const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);`
- delete the trailing comment (`// The correct claim's consumeTokenRow deletes a row out from under at …`) together with the `expect(warn).toHaveBeenCalledWith(…)` that follows it.

What remains is the `for` loop and the per-result `expect(['verified', 'invalid']).toContain(result.kind)`, which every interleaving satisfies. Leave the loop: a rejection needs a real window to occur in, and this assertion cannot be falsified by scheduling.

Then extend that test's leading comment with one sentence saying where the removed property went — reword the existing paragraph so it reads as what is true now, and do **not** write that it previously asserted anything else:

```ts
  // A correct claim deletes the matched row via `consumeTokenRow` at the same
  // moment a concurrent wrong guess is running `updateMany`/`deleteMany` over
  // the live candidate ids. Both silently match zero rows instead of
  // throwing, so a row disappearing out from under either call must resolve
  // to a normal outcome, never an unhandled rejection. Looped, with more than
  // one concurrent wrong guess per iteration, since whether any single write
  // lands after the delete is timing-dependent — which is why this test
  // asserts only the outcome every interleaving produces. That the
  // `updateMany` under-count guard actually fires when the row does vanish is
  // pinned by the staged test below, which does not depend on scheduling.
```

- [ ] **Step 2: Add the staged test, immediately after that one**

```ts
  // The correct claim consumes the matched row between this wrong guess's
  // snapshot and its increment, so the increment finds nothing to charge.
  //
  // The sibling is a whole `claimWithCode` on the UNHOOKED client, so every
  // statement it issues is the real one and it cannot re-enter this hook.
  // Interposed before `query(args)` rather than after it, because the row has
  // to be gone by the time the increment runs — that gap is the race.
  it('warns when the matched row is consumed between the snapshot and the increment', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const email = `claim-staged-underwrite-${Date.now()}@example.com`;
    const nonce = `nonce-staged-underwrite-${Date.now()}`;
    const code = await stampedToken(email, nonce);
    const wrong = ['000000', '111111'].find((g) => g !== code)!;

    let hookCalls = 0;
    const racing = db.$extends({
      query: {
        magicLinkToken: {
          async updateMany({ args, query }) {
            hookCalls += 1;
            await claimWithCode(db, asBrowserNonce(nonce), code);
            return query(args);
          },
        },
      },
      // `$extends` returns a client missing `$on`, so it is not assignable to
      // `claimWithCode`'s `PrismaClient` parameter even though every method it
      // calls here is the real one — same cast as the hooks in
      // `waitlist.test.ts`.
    }) as unknown as PrismaClient;

    expect(await claimWithCode(racing, asBrowserNonce(nonce), wrong)).toEqual({ kind: 'invalid' });

    expect(hookCalls).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { requested: 1, affected: 0 },
      'handoff: updateMany affected fewer candidates than requested',
    );
  });
```

- [ ] **Step 3: Run both**

Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts -t "never throws"`
Expected: PASS.

Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts -t "between the snapshot and the increment"`
Expected: PASS.

- [ ] **Step 4: Mutation — prove the guard bites**

`src/lib/auth/handoff.ts:177`:

```ts
    if (incremented.count < ids.length) {       // before
    if (incremented.count > ids.length) {       // after — unreachable, so no warn
```

Run the staged test. Expected: FAIL, `warn` called 0 times. Record the text, restore, re-run green, confirm `git diff --stat src/lib/auth/handoff.ts` is empty.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/handoff.test.ts
git commit -m "test(auth): stage the increment under-count race, drop its timing-dependent twin (#509)"
```

---

### Task 5: Retire the cross-file test roster in `handoff.ts`

**Files:**
- Modify: `src/lib/auth/handoff.ts` — the `expectedReaps` comment (at `:163-171` on `42d259af`; `handoff.ts` is untouched by Tasks 1-4, so these line numbers do hold) names two tests in `handoff.test.ts` by title, and Tasks 2 and 4 change or remove both.

**Interfaces:**
- Consumes: the test names introduced by Tasks 1-4.
- Produces: nothing. **Run this task after Tasks 1-4** — it reconciles a comment against names those tasks establish, so its order is load-bearing while theirs is not.

- [ ] **Step 1: Replace the roster with a claim that has an owner**

The comment currently ends:

```ts
    // below is that documented race, not proof of a bug on its own. Forced
    // in handoff.test.ts by "the race: a correct claim concurrent with wrong
    // guesses never throws" and "warns when two concurrent wrong guesses
    // race the same near-exhausted candidate".
```

A roster of test titles in another file is precisely the claim CLAUDE.md's *Comment Discipline* says has no owner: the person who renames a test never sees it, and both names here went stale in one branch. Replace those three lines with:

```ts
    // below is that documented race, not proof of a bug on its own. Each
    // direction of it is staged deterministically in `handoff.test.ts` —
    // there by construction rather than by timing, so a mismatch that only
    // this comment predicts is not one nobody has reproduced.
```

Name the file, not the tests: a file rename is caught by the compiler, a test rename by nothing.

- [ ] **Step 2: Sweep for the names this branch invalidated**

Run:

```bash
grep -rn "near-exhausted\|already-spent candidate\|concurrent candidates both cross" src docs .github
```

Expected hits, and the verdict for each:

| hit | verdict |
|---|---|
| `docs/superpowers/plans/2026-09-08-handoff-miss-observability.md` (3 hits) | **Leave.** A plan is a record of what a past branch did, not a live description of the code — correcting it would rewrite history rather than fix an error. |
| `docs/superpowers/plans/2026-09-08-handoff-race-staging.md` (7 hits) | **Leave.** This file's own text quotes the retired titles deliberately, as the "before" side of what this branch changes — and one of the 7 is this file's own copy of the grep command above, which matches itself. |
| `docs/superpowers/specs/2026-09-08-handoff-race-staging-design.md` (5 hits) | **Leave**, same reason. |
| `src/lib/auth/handoff.test.ts:466` (current title `'warns when a sibling reaps the already-spent candidate first'`) | **Leave.** It is current, not stale. |
| any OTHER hit under `src/` | **Must be zero** after Step 1. None found. |

The command's three terms deliberately do not reach `'the race: a correct claim concurrent with wrong guesses never throws'`, because that title survives this branch unchanged — only its warn assertion moved — so a sweep keyed on it would return live references and cost a verdict each.

- [ ] **Step 3: Verify**

Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts && npm run typecheck && npm run lint`
Expected: all green, 26-ish tests in the file, none failing.

- [ ] **Step 4: Commit**

```bash
git add src/lib/auth/handoff.ts
git commit -m "docs(auth): name the file, not the tests, where the reap race is staged (#509)"
```

---

### Task 6: Measure what the branch claims

**Files:**
- Create: nothing. This task produces numbers for the PR body.

**Interfaces:**
- Consumes: Tasks 1-5, all committed.
- Produces: the measurements the PR body cites. **Run last.**

- [ ] **Step 1: Wall time, before and after**

```bash
git stash list   # expect empty
for i in 1 2 3; do npx vitest run --project unit src/lib/auth/handoff.test.ts 2>&1 | grep -E '^ +Duration|Tests  '; done
```

The pre-branch baseline, measured on `42d259af`, was **2.36 s / 2.31 s** for 26 tests (a third run hit §7's stall at 7.26 s and is excluded, and the exclusion is stated in the PR body rather than hidden). Record the three new numbers as measured, whichever way they fall.

- [ ] **Step 2: The acceptance criterion — 20 consecutive tier runs**

```bash
for i in $(seq 1 20); do
  npx vitest run --project unit --project components >/tmp/h509-$i.log 2>&1 \
    && echo "run $i: pass" \
    || { echo "run $i: FAIL"; grep -E '^\s+×' /tmp/h509-$i.log | head -5; }
done
```

Expected: zero failures of any of the four staged tests. §7 of the spec explains why a `counts both attempts when two wrong guesses race concurrently` timeout, if it appears, is reported as itself rather than counted against this criterion — and why any *other* failure does count.

- [ ] **Step 3: Confirm no test still hopes**

```bash
grep -n "Promise.all\|for (let i = 0" src/lib/auth/handoff.test.ts
```

Expected: exactly three surviving sites — the two `the race: …` tests and `counts both attempts when two wrong guesses race concurrently` — and none of them inside a test that asserts on `log.warn`. Verify that last clause by reading the three, not by grepping.

- [ ] **Step 4: The rest of the gate**

```bash
npm run typecheck && npm run lint && npx vitest run --project unit && npx vitest run --project components && npx vitest run --project unit-sweeps
```

Expected: all green. `--project integration` is deliberately omitted: this is a worktree with no app on `:3000`, and running it hangs on `ECONNREFUSED`. CI is the signal for that tier and the PR body must cite the CI run, not a local result.

- [ ] **Step 5: File the second flake**

Open an issue for the `counts both attempts when two wrong guesses race concurrently` 5000 ms stall, carrying the spec's §7 measurements: ~2 occurrences in 78 isolated runs; 25 consecutive runs under `--testTimeout=30000` whose slowest test was 163 ms, so it is a discrete stall rather than a slow path. State that #509's branch neither causes nor cures it, and that the test is untouched by it.
