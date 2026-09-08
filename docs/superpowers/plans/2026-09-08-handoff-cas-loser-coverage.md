# Deterministic coverage for `verifyWithHandoff`'s CAS-loser branch — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two deterministic tests to `src/lib/auth/handoff.test.ts` that stage `verifyWithHandoff`'s compare-and-swap loser branch (`handoff.ts:73-79`) at the exact statement boundary the race requires, covering both of its reachable shapes — the winner-arm (`:78`, another opener stamped a code first) and the invalid-arm (`:77`, the token was consumed and deleted before this call's CAS ran). Neither shape is guaranteed by the existing `Promise.all`-based race test, and the invalid-arm is unreachable by it under any interleaving (see spec §1.4).

**Architecture:** Each staged test makes **one** real `verifyWithHandoff` call through a `db.$extends({ query: { magicLinkToken: { ... } } })` hook on `updateMany` — the CAS statement — that interposes a real sibling call on the *unhooked* client before `query(args)` runs. This is the same idiom `handoff.test.ts` already uses four times for `claimWithCode` (closest template: `'warns when the matched row is consumed between the snapshot and the increment'`, `:449`). No shared helper — each hook is written inline, short enough to read as the race it stages.

**Tech Stack:** TypeScript strict, Vitest 4 (`unit` project, real Postgres via `DATABASE_URL_TEST`), Prisma 6 client extensions.

**Spec:** `docs/superpowers/specs/2026-09-08-handoff-cas-loser-coverage-design.md`

## Global Constraints

- **The existing test `'the race: concurrent first-opens of the same link agree on one code'` (`:71-87`) is kept byte-for-byte unchanged.** The issue's acceptance criteria require it; it is not being replaced, only supplemented.
- **The sibling always runs on the plain `db`,** never on the extended client — otherwise the hook re-enters itself.
- **`$extends` returns a client missing `$on`,** so it is not assignable to a `PrismaClient` parameter. End every extension with `}) as unknown as PrismaClient;`, with the cast explained once in Task 1's hook and Task 2's back-referencing it in-file (the convention this file already uses for its four `claimWithCode` hooks).
- **Every hook counts its own invocations** in `let hookCalls = 0;` and every staged test asserts `expect(hookCalls).toBe(1)`.
- **No `for` loop and no `Promise.all` in either new test.** If either appears, the test is back to hoping.
- **Neither test needs a `log.warn` spy** — the CAS loser branch never logs; the tests assert on the returned `HandoffOutcome` and the persisted row, not on log calls.
- Tests run with `npx vitest run --project unit src/lib/auth/handoff.test.ts`. Integration and e2e cannot run from this worktree (no `:3000`, no dev server) — CI is their signal.

---

### Task 1: The winner-arm — the CAS loser returns the persisted code

**Files:**
- Modify: `src/lib/auth/handoff.test.ts` — insert a new test immediately after the closing `});` of `it('the race: concurrent first-opens of the same link agree on one code', ...)` (currently `:87`) and before `it('lets the real browser still sign in after a stranger stamped a code', ...)` (currently `:89`). **Anchor on the title of the preceding test, not the line number.**

**Interfaces:**
- Consumes: `mint(email, nonce)` (module-level, `:10`), `verifyWithHandoff`, `db` — all already imported/defined at the top of the file.
- Produces: the first `$extends` cast in this insertion region, fully explained. **Task order is load-bearing: this task must run before Task 2** — Task 2's hook back-references this one's cast comment (`// Same cast, same reason as the first hook in this file.`), the convention this file's four existing `claimWithCode` hooks already use, and needs this task's comment to exist first.

- [ ] **Step 1: Add the test**

```ts
  // The CAS loser's winner-arm (`handoff.ts:78`): a sibling first-open wins
  // the compare-and-swap and stamps its own code before this call's
  // `updateMany` runs, so this call matches zero rows, reads the row back,
  // and must return the WINNER's code — not its own, which was never
  // persisted.
  //
  // The sibling is a whole `verifyWithHandoff` call on the UNHOOKED client,
  // so every statement it issues is the real one and it cannot re-enter this
  // hook. Interposed before `query(args)` rather than after it, because the
  // sibling has to win the CAS before this call's own write attempt runs —
  // that ordering is the race.
  it('the loser of a staged first-open race returns the code the winner persisted', async () => {
    const email = `handoff-staged-winner-${Date.now()}@example.com`;
    const nonce = 'nonce-staged-winner';
    const token = await mint(email, nonce);

    let hookCalls = 0;
    let sibling: Awaited<ReturnType<typeof verifyWithHandoff>> | undefined;
    const racing = db.$extends({
      query: {
        magicLinkToken: {
          async updateMany({ args, query }) {
            hookCalls += 1;
            sibling = await verifyWithHandoff(db, token, null);
            return query(args);
          },
        },
      },
      // `$extends` returns a client missing `$on`, so it is not assignable to
      // `verifyWithHandoff`'s `PrismaClient` parameter even though every
      // method it calls here is the real one — same cast every hook in this
      // file uses.
    }) as unknown as PrismaClient;

    const loser = await verifyWithHandoff(racing, token, null);

    expect(hookCalls).toBe(1);
    if (sibling?.kind !== 'handoff') throw new Error('expected a handoff');
    expect(loser).toEqual(sibling);

    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.handoffCode).toBe(sibling.code);
  });
```

- [ ] **Step 2: Run it**

Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts -t "returns the code the winner persisted"`
Expected: PASS.

- [ ] **Step 3: Mutation — prove the guard bites**

Apply this to `src/lib/auth/handoff.ts:70`:

```ts
    where: { id: row.id, handoffCode: null },      // before
    where: { id: row.id },                         // after — CAS becomes an unconditional write
```

Run the same command. Expected: FAIL — the outer call's write now always succeeds, overwriting the sibling's stamp with its own code, so `loser` no longer equals `sibling` and the persisted row's `handoffCode` is the outer call's own code. Record the exact assertion failure text in the commit body.

Then restore the line, re-run, expect PASS. Confirm with `git diff --stat src/lib/auth/handoff.ts` that the restore left the file unchanged.

- [ ] **Step 4: Mutation — prove the staging bites**

Comment out the interposed `sibling = await verifyWithHandoff(db, token, null);` line inside the hook and replace it with `await Promise.resolve();`. Run. Expected: FAIL — with no sibling writing first, the outer call's own CAS succeeds on its first attempt and never reaches the loser branch at all; `sibling` stays `undefined`, so the `if (sibling?.kind !== 'handoff') throw` guard throws `'expected a handoff'` before the `toEqual` assertion is ever reached. Record the failure text. Restore the line.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/handoff.test.ts
git commit -m "test(auth): stage the CAS winner-arm race instead of hoping for it (#514)"
```

---

### Task 2: The invalid-arm — the CAS loser finds the row already deleted

**Files:**
- Modify: `src/lib/auth/handoff.test.ts` — insert a new test immediately after the closing `});` of Task 1's new test (or, if Task 1 has not yet run, after `it('the race: concurrent first-opens of the same link agree on one code', ...)`, currently `:87`) and before `it('lets the real browser still sign in after a stranger stamped a code', ...)` (currently `:89`). **Anchor on the title of the preceding test, not the line number.**

**Interfaces:**
- Consumes: `mint(email, nonce)` (module-level, `:10`), `verifyWithHandoff`, `asBrowserNonce`, `db`, and Task 1's hook comment (this task's cast back-references it). **Run this task after Task 1.**
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the test**

```ts
  // The CAS loser's invalid-arm (`handoff.ts:77`): a sibling call for the
  // SAME token, with the browser's own matching nonce, consumes and deletes
  // the row before this call's `updateMany` runs. This call's CAS matches
  // zero rows because the row is gone — not merely stamped — so `winner`
  // reads back `null` and the loser must report `invalid` rather than
  // dereference a row that no longer exists. This shape is unreachable by
  // the existing loop-based race test, which only ever stages two
  // no-nonce opens — see the spec's §1.4.
  //
  // The sibling is a whole `verifyWithHandoff` call on the UNHOOKED client,
  // so every statement it issues is the real one and it cannot re-enter this
  // hook. Interposed before `query(args)`, because the row has to be gone
  // by the time this call's own write attempt runs — that gap is the race.
  it('returns invalid when the sibling consumes the token before the loser writes', async () => {
    const email = `handoff-staged-deleted-${Date.now()}@example.com`;
    const nonce = 'nonce-staged-deleted';
    const token = await mint(email, nonce);

    let hookCalls = 0;
    let sibling: Awaited<ReturnType<typeof verifyWithHandoff>> | undefined;
    const racing = db.$extends({
      query: {
        magicLinkToken: {
          async updateMany({ args, query }) {
            hookCalls += 1;
            sibling = await verifyWithHandoff(db, token, asBrowserNonce(nonce));
            return query(args);
          },
        },
      },
      // Same cast, same reason as the first hook in this file.
    }) as unknown as PrismaClient;

    const loser = await verifyWithHandoff(racing, token, null);

    expect(hookCalls).toBe(1);
    // A staging that collapsed — a sibling that no longer consumes the row —
    // fails here as itself, rather than downstream as a wrong outcome.
    expect(sibling).toEqual({ kind: 'verified', email, redirectTo: null, purpose: 'sign_in' });
    expect(loser).toEqual({ kind: 'invalid' });
  });
```

- [ ] **Step 2: Run it**

Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts -t "consumes the token before the loser writes"`
Expected: PASS.

- [ ] **Step 3: Mutation — prove the guard bites**

Apply this to `src/lib/auth/handoff.ts:77-78`:

```ts
    if (!winner?.handoffCode) return { kind: 'invalid' };      // before, two lines
    return { kind: 'handoff', code: winner.handoffCode };

    return { kind: 'handoff', code: winner?.handoffCode ?? '' };   // after, one line
```

Run the same command. Expected: FAIL — with `winner` `null` (the row was deleted), the outer call now resolves to `{ kind: 'handoff', code: '' }` instead of `{ kind: 'invalid' }`. Record the exact failure text.

Then restore the original two lines, re-run, expect PASS. Confirm with `git diff --stat src/lib/auth/handoff.ts` that the restore left the file unchanged.

- [ ] **Step 4: Mutation — prove the staging bites**

Comment out the interposed `sibling = await verifyWithHandoff(db, token, asBrowserNonce(nonce));` line inside the hook and replace it with `await Promise.resolve();`. Run. Expected: FAIL — with nothing deleting the row first, the outer call's own CAS succeeds normally and resolves to `{ kind: 'handoff', code: <its own code> }`, and `sibling` stays `undefined`, so `expect(sibling).toEqual({ kind: 'verified', ... })` fails first. Record the failure text. Restore the line.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/handoff.test.ts
git commit -m "test(auth): stage the CAS invalid-arm race, unreachable by the existing test (#514)"
```

---

### Task 3: Verify the gate and record what the branch measured

**Files:**
- Create: nothing. This task verifies and produces the numbers the PR body cites.

**Interfaces:**
- Consumes: Tasks 1-2, both committed.
- Produces: the measurements the PR body cites. **Run last.**

- [ ] **Step 1: Confirm the existing race test is untouched**

```bash
git diff origin/main -- src/lib/auth/handoff.test.ts | grep -A3 "^-.*the race: concurrent first-opens"
```

Expected: no output — the test's own lines appear only as unchanged context (`git diff` shows no `-`/`+` lines touching it), confirming it was not edited, only supplemented.

- [ ] **Step 2: Confirm neither new test loops or races**

```bash
grep -n "Promise.all\|for (let i = 0" src/lib/auth/handoff.test.ts
```

Expected: the same lines the file had on `origin/main`, none of them inside either test added by Tasks 1-2 — verify by reading the two new tests, not by count alone, since the file's other tests legitimately contain these constructs.

- [ ] **Step 3: Full local gate**

```bash
npm run typecheck && npm run lint \
  && npx vitest run --project unit \
  && npx vitest run --project unit-sweeps \
  && npx vitest run --project components
```

Expected: all green. `--project integration` and e2e are deliberately omitted — this is a worktree with no app on `:3000` and no dev database; running integration hangs on `ECONNREFUSED`. CI is the signal for those tiers, and the PR body must cite the CI run rather than a local result for them.

- [ ] **Step 4: Record the file's final test count**

```bash
npx vitest run --project unit src/lib/auth/handoff.test.ts 2>&1 | grep -E "Tests |Test Files"
```

Record the number for the PR body, alongside the two new test titles.
