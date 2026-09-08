# Handoff timeout flake (#512) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `handoff.test.ts`'s "counts both attempts when two wrong
guesses race concurrently" from failing a merge gate on a client-side
scheduling stall vitest's 5000ms default cannot absorb, by giving this one
test its own, generous timeout — documented as environmental, not a
correctness fix.

**Architecture:** One-line change: add a per-test timeout override
(vitest's `it(name, fn, timeout)` third argument) to the single affected
test, plus a short comment pointing at the spec's measurement so a future
reader does not mistake the number for an arbitrary guess.

**Tech Stack:** vitest 4.1.10, Prisma, Postgres — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-08-handoff-timeout-flake-design.md`

## Global Constraints

- The timeout override is scoped to this ONE test — never touch
  `vitest.config.ts`'s global `testTimeout`, and never add a file-level
  override that would also loosen every OTHER test in `handoff.test.ts`
  (spec §6).
- The chosen bound is **20,000ms** — exact value, not a placeholder (spec
  §6).
- Do not modify `claimWithCode`, `verifyWithHandoff`, or any other test in
  `src/lib/auth/handoff.test.ts` (spec §8 — out of scope).
- Comment discipline (CLAUDE.md): the comment on the test states the
  constraint in one or two lines and links to the spec for the measurement;
  it does not restate the spec's investigation prose.

---

### Task 1: Give the race test its own timeout, and prove the number actually does something

**Files:**
- Modify: `src/lib/auth/handoff.test.ts:322-334` (the comment immediately
  above `it('counts both attempts when two wrong guesses race
  concurrently', ...)`, and that `it(...)` call's closing)

**Interfaces:**
- Consumes: nothing new — `claimWithCode`, `asBrowserNonce`, `stampedToken`
  are already imported/defined in this file.
- Produces: nothing other tasks depend on (this is the only task).

The test today reads (line 322-334):

```typescript
  // Two concurrent wrong guesses against the same row must not undercount
  // each other — see the atomic `{ increment: 1 }` in `claimWithCode`.
  it('counts both attempts when two wrong guesses race concurrently', async () => {
    const email = `claim-race-${Date.now()}@example.com`;
    const nonce = `nonce-race-${Date.now()}`;
    const code = await stampedToken(email, nonce);
    // Stay under HANDOFF_MAX_ATTEMPTS so the row survives to be inspected.
    const guesses = ['111111', '222222', '333333', '444444'].filter((g) => g !== code);

    await Promise.all(guesses.map((g) => claimWithCode(db, asBrowserNonce(nonce), g)));

    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.handoffAttempts).toBe(guesses.length);
  });
```

- [ ] **Step 1: Confirm the current (pre-fix) baseline still reproduces**

Run the file alone, several times, to confirm the environment still shows
the same flake this branch is fixing (informational — not a pass/fail
gate, since the flake is probabilistic):

```bash
for i in 1 2 3 4 5; do npx vitest run --project unit src/lib/auth/handoff.test.ts 2>&1 | tail -5; done
```

Expected: all 5 green (the flake is ~1-3%, so 5 runs are very likely clean —
this step is just confirming the file runs, not trying to catch it again).

- [ ] **Step 2: Add the timeout override and the comment**

Replace the test's leading comment and closing line so the file reads:

```typescript
  // Two concurrent wrong guesses against the same row must not undercount
  // each other — see the atomic `{ increment: 1 }` in `claimWithCode`.
  //
  // 20s, not vitest's 5s default: this test occasionally hits a client-side
  // scheduling stall unrelated to Postgres contention. See
  // `docs/superpowers/specs/2026-09-08-handoff-timeout-flake-design.md` (#512).
  it('counts both attempts when two wrong guesses race concurrently', async () => {
    const email = `claim-race-${Date.now()}@example.com`;
    const nonce = `nonce-race-${Date.now()}`;
    const code = await stampedToken(email, nonce);
    // Stay under HANDOFF_MAX_ATTEMPTS so the row survives to be inspected.
    const guesses = ['111111', '222222', '333333', '444444'].filter((g) => g !== code);

    await Promise.all(guesses.map((g) => claimWithCode(db, asBrowserNonce(nonce), g)));

    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.handoffAttempts).toBe(guesses.length);
  }, 20_000);
```

The only functional change is the trailing `, 20_000` on the `it(...)` call
(vitest's per-test timeout in milliseconds) — the test body is untouched.

- [ ] **Step 3: Run the file once to confirm it still passes**

```bash
npx vitest run --project unit src/lib/auth/handoff.test.ts
```

Expected: `27 passed (27)` (unchanged from before this edit).

- [ ] **Step 4: Prove the new bound actually bites — a real hang still fails**

This is the mutation-test step: a timeout override that can never fire
proves nothing. Temporarily edit `claimWithCode` in
`src/lib/auth/handoff.ts` so its no-match branch hangs forever instead of
returning. Find this block (inside the `if (!match) { ... }` branch, right
after the `expectedReaps` computation):

```typescript
    const incremented = await db.magicLinkToken.updateMany({
      where: { id: { in: ids } },
      data: { handoffAttempts: { increment: 1 } },
    });
```

Temporarily insert a line directly above it:

```typescript
    await new Promise(() => {}); // TEMPORARY — mutation test for #512, remove before running Step 5
    const incremented = await db.magicLinkToken.updateMany({
```

Run:

```bash
npx vitest run --project unit src/lib/auth/handoff.test.ts -t "counts both attempts"
```

Expected: the test now **fails with `Test timed out in 20000ms`** (not
5000ms) — confirming the override took effect and a genuine hang is still
caught, just at the new ceiling. Record the exact failure text.

- [ ] **Step 5: Revert the mutation**

```bash
git diff src/lib/auth/handoff.ts
git checkout -- src/lib/auth/handoff.ts
```

Confirm `git status` shows `handoff.ts` clean and only `handoff.test.ts` and
the new spec/plan docs modified/added.

- [ ] **Step 6: Re-measure the flake against the issue's own acceptance criterion**

```bash
for i in $(seq 1 40); do npx vitest run --project unit src/lib/auth/handoff.test.ts 2>&1 | tail -5; done
```

Expected: 40/40 green, zero timeouts of any test in the file. Record the
actual count of clean runs (should be 40) in the PR body — if any run shows
a timeout, it does NOT invalidate the fix (§7 of the spec: this bounds risk,
it does not claim zero), but it must be reported honestly in the PR body
rather than silently re-run away.

- [ ] **Step 7: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```

Expected: both clean (this change is a single trailing numeric literal and
a comment — no type or lint surface).

- [ ] **Step 8: Component tier (unaffected, but part of what's scoped to this worktree)**

```bash
npx vitest run --project components
```

Expected: green, unchanged — this branch touches nothing under
`components`'s scope; running it confirms the branch didn't break anything
by accident.

- [ ] **Step 9: Commit**

```bash
git add src/lib/auth/handoff.test.ts docs/superpowers/specs/2026-09-08-handoff-timeout-flake-design.md docs/superpowers/plans/2026-09-08-handoff-timeout-flake.md
git commit -m "$(cat <<'EOF'
fix(auth): give the concurrent-claim race test its own timeout, closing #512

The 4-way-concurrent Promise.all in "counts both attempts when two wrong
guesses race concurrently" completes in single-digit milliseconds
uncontended, but occasionally hits a client-side scheduling stall vitest's
5000ms default cannot absorb — measured via a 400-iteration standalone
negative control (0 slow) and a live-captured 5007ms stall during which
pg_stat_activity showed zero Postgres-side activity for the whole window.
See docs/superpowers/specs/2026-09-08-handoff-timeout-flake-design.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** §6 (the fix and its value) → Step 2. §7.1 (mutation
  bites) → Steps 4-5. §7.2 (40-run re-measurement) → Step 6. §7.3
  (typecheck/lint/unit/components green) → Steps 3, 7, 8. §8 (out of scope:
  no change to `claimWithCode` itself) → Step 5 explicitly reverts the
  mutation before committing.
- **Single task:** this plan has exactly one task, so per the solve-issue
  skill's §5, the whole-branch review step is skipped — this task's own
  review IS the whole-branch review.
- Integration and e2e tiers cannot run from this worktree (no `:3000`, no
  dev database) — CI is the signal for those tiers; the PR body cites the
  run rather than a local claim.
