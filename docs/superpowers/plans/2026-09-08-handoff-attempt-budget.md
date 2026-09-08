# Handoff Attempt Budget Rescope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope `claimWithCode`'s attempt budget to the browser nonce instead of a single steerable token row, so a caller holding the nonce can no longer keep a decoy token that absorbs every wrong guess (#423).

**Architecture:** One rule replaces the `?? candidates[0]!` fallback — a submitted code that matches no live candidate is a wrong guess against every live candidate and is charged to all of them. The single-row `update` becomes an `updateMany` increment over the live candidate ids, followed by a `deleteMany` gated on `handoffAttempts >= HANDOFF_MAX_ATTEMPTS`. Exhausted rows are reaped and dropped from the working set before matching.

**Tech Stack:** TypeScript strict, Prisma, Vitest (`unit` project, dedicated test database — no dev server needed).

**Spec:** `docs/superpowers/specs/2026-09-08-handoff-attempt-budget-design.md`

## Global Constraints

- TypeScript `strict: true` — no `any`, no implicit types.
- `HANDOFF_MAX_ATTEMPTS` stays `5`. Neither rate limit changes.
- Comments state what is true now, and a corrected claim is **replaced**, never annotated with what it used to say (CLAUDE.md, *Comment Discipline*). The before-and-after belongs in the PR body.
- Never write a count or a member roster in a comment.
- Stage exact paths. Never `git add -A` or `git add .`.
- `src/lib/auth/handoff.test.ts` runs under the `unit` project against `DATABASE_URL_TEST`. It does **not** need the dev server on :3000, and this branch must not start, stop or restart one.

---

### Task 1: Rescope the attempt budget to the browser

**Files:**
- Modify: `src/lib/auth/handoff.ts:5` (drop the now-unused `isRecordNotFound` import), `:83-84` (`HANDOFF_MAX_ATTEMPTS` docblock), `:87-102` (`claimWithCode` docblock), `:110-148` (the algorithm)
- Modify: `src/lib/auth/handoff.ts:27-28` (disambiguate one now-ambiguous spec pointer)
- Test: `src/lib/auth/handoff.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks — this is the only task.
- Produces: `claimWithCode(db, nonce, code)` keeps its exact signature and return type, `Promise<Exclude<HandoffOutcome, { kind: 'handoff' }>>`. `HANDOFF_MAX_ATTEMPTS` stays an exported `const` of `5`. No caller changes.

**Why this is one task:** the docblock at `handoff.ts:96-101` *describes the behaviour being replaced*, so leaving it for a second task would produce a commit whose comment contradicts the code beside it. The documentation is folded into the deliverable that needs it.

---

- [ ] **Step 1: Add the shared test helper and route the existing multi-candidate test through it**

The new tests need stamped tokens under one nonce, distinguished by `redirectTo` so a test can tell one candidate's row from another's. The existing test at `handoff.test.ts:185` already builds that setup inline; extract it once rather than repeating it at every new site.

Add this helper inside the `describe('claimWithCode', …)` block, directly below the existing `stampedToken` helper:

```ts
  /** A stamped token under `nonce`, tagged by `redirectTo` so a test can find
   *  its row and tell one candidate from another. Returns its code. */
  async function stampedWithRedirect(email: string, nonce: string, redirectTo: string) {
    const token = await generateMagicLinkToken(db, email, {
      originBrowserHash: hashNonce(nonce),
      redirectTo,
    });
    const out = await verifyWithHandoff(db, token, null);
    if (out.kind !== 'handoff') throw new Error('expected a handoff');
    return out.code;
  }
```

Then rewrite the body of the existing test `'claims the specific token whose code was entered, not merely the newest one sharing the nonce'` (`handoff.test.ts:185-211`) to use it. Keep its comment and its assertions exactly as they are — only the setup changes:

```ts
  it('claims the specific token whose code was entered, not merely the newest one sharing the nonce', async () => {
    const email = `claim-multi-${Date.now()}@example.com`;
    const nonce = 'nonce-multi';

    const olderCode = await stampedWithRedirect(email, nonce, '/older');
    await stampedWithRedirect(email, nonce, '/newer');

    // The redirect pins which token actually matched: the newer token's row
    // would answer '/newer' if the lookup had misattributed the guess to it.
    expect(await claimWithCode(db, asBrowserNonce(nonce), olderCode)).toEqual({
      kind: 'verified',
      email,
      redirectTo: '/older',
      purpose: 'sign_in',
    });
  });
```

- [ ] **Step 2: Run the suite to confirm the refactor changed nothing**

Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts`
Expected: PASS, every test. This step exists so a later failure cannot be blamed on the extraction.

- [ ] **Step 3: Write the new tests**

Append these to the `describe('claimWithCode', …)` block, after the existing multi-candidate test.

**Do not merge the second and third tests.** They look near-identical and are not: the third asserts the rows are gone with *no intervening `claimWithCode` call*, because the pre-match reap added in Step 5 would otherwise clean up on the next call and mask a missing delete on the miss path. That ordering is the whole point of the third test.

```ts
  // A submitted code is compared against every live candidate at once, so a
  // code matching none of them is one failed guess against all of them.
  it('charges every live candidate on a miss, not only the newest', async () => {
    const email = `claim-chargeall-${Date.now()}@example.com`;
    const nonce = `nonce-chargeall-${Date.now()}`;

    const olderCode = await stampedWithRedirect(email, nonce, '/older');
    const newerCode = await stampedWithRedirect(email, nonce, '/newer');
    // Picked rather than hardcoded: a literal guess could collide with a
    // generated code (10⁻⁶ each) and turn a miss into a match.
    const wrong = ['000000', '111111', '222222'].find(
      (guess) => guess !== olderCode && guess !== newerCode,
    )!;

    expect(await claimWithCode(db, asBrowserNonce(nonce), wrong)).toEqual({ kind: 'invalid' });

    const older = await db.magicLinkToken.findFirst({ where: { email, redirectTo: '/older' } });
    const newer = await db.magicLinkToken.findFirst({ where: { email, redirectTo: '/newer' } });
    expect(older?.handoffAttempts).toBe(1);
    expect(newer?.handoffAttempts).toBe(1);
  });

  // #423: a caller holding this browser's nonce can mint a NEWER token under
  // it and leave it in the candidate list. The budget must not be steerable
  // onto that decoy — the token actually being guessed at has to die.
  it('a newer decoy cannot shield an older token from the attempt budget', async () => {
    const email = `claim-decoy-${Date.now()}@example.com`;
    const nonce = `nonce-decoy-${Date.now()}`;

    const targetCode = await stampedWithRedirect(email, nonce, '/target');
    const decoyCode = await stampedWithRedirect(email, nonce, '/decoy');
    const wrong = ['000000', '111111', '222222'].find(
      (guess) => guess !== targetCode && guess !== decoyCode,
    )!;

    for (let i = 0; i < HANDOFF_MAX_ATTEMPTS; i++) {
      await claimWithCode(db, asBrowserNonce(nonce), wrong);
    }

    // Destroyed, not merely charged: the target's own correct code is dead.
    expect(await claimWithCode(db, asBrowserNonce(nonce), targetCode)).toEqual({ kind: 'invalid' });
  });

  // Asserted with no `claimWithCode` call between the last guess and the read:
  // the reap that runs before matching would otherwise clear these rows on the
  // next call, hiding a miss path that never deleted them.
  it('a spent budget destroys every live candidate before any later call', async () => {
    const email = `claim-reapall-${Date.now()}@example.com`;
    const nonce = `nonce-reapall-${Date.now()}`;

    const firstCode = await stampedWithRedirect(email, nonce, '/first');
    const secondCode = await stampedWithRedirect(email, nonce, '/second');
    const wrong = ['000000', '111111', '222222'].find(
      (guess) => guess !== firstCode && guess !== secondCode,
    )!;

    for (let i = 0; i < HANDOFF_MAX_ATTEMPTS; i++) {
      await claimWithCode(db, asBrowserNonce(nonce), wrong);
    }

    expect(await db.magicLinkToken.findMany({ where: { email } })).toEqual([]);
  });

  // A row can sit at the budget without having been deleted — a crash between
  // the increment and the delete would leave one. Reached by writing the
  // counter directly, because no sequence of claims can produce this state:
  // the miss path deletes a row the moment it hits the budget. Without a row
  // in this state the reap that runs before matching could never be shown to
  // do anything.
  it('an exhausted row is dead to its own correct code, and is reaped', async () => {
    const email = `claim-exhausted-${Date.now()}@example.com`;
    const nonce = `nonce-exhausted-${Date.now()}`;

    const code = await stampedWithRedirect(email, nonce, '/exhausted');
    await db.magicLinkToken.updateMany({
      where: { email, redirectTo: '/exhausted' },
      data: { handoffAttempts: HANDOFF_MAX_ATTEMPTS },
    });

    expect(await claimWithCode(db, asBrowserNonce(nonce), code)).toEqual({ kind: 'invalid' });
    expect(await db.magicLinkToken.findFirst({ where: { email } })).toBeNull();
  });
```

- [ ] **Step 4: Run the tests to verify the right ones fail**

Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts`
Expected: the **first three** new tests FAIL, every pre-existing test PASSES. Record the exact failure text for the PR body. The expected shapes are:
- `charges every live candidate on a miss` — the older row's `handoffAttempts` is `0`, not `1` (only the newest was charged).
- `a newer decoy cannot shield an older token` — the final claim returns `{ kind: 'verified', … }` rather than `{ kind: 'invalid' }`, because all five guesses landed on the decoy and the target is untouched.
- `a spent budget destroys every live candidate` — `findMany` returns one surviving row (the older), not `[]`.

The **fourth** test, `an exhausted row is dead to its own correct code, and is reaped`, is expected to **PASS** here. It is a characterization test, not a regression one: today's `handoffAttempts >= HANDOFF_MAX_ATTEMPTS` check already deletes such a row before comparing codes. It exists to hold that behaviour steady through the rewrite and to give the new reap a mutation that can fail — see Step 9.

If any of the first three passes at this step, stop: the test is not reaching the behaviour it claims to and must be corrected before implementing. If the fourth fails, stop as well — the rewrite has not started, so a failure there means the test itself is wrong.

- [ ] **Step 5: Replace the algorithm**

In `src/lib/auth/handoff.ts`, replace the body from `const candidates = await db.magicLinkToken.findMany(` through the end of the function (`:110-152`) with:

```ts
  const candidates = await db.magicLinkToken.findMany({
    where: {
      // Scoped to the browser, not to an address. A shared browser carries one
      // nonce across an abandoned sign-in, so another person's stamped token
      // can sit in this set and shares the budget spent below — an accepted
      // consequence, argued in
      // `docs/superpowers/specs/2026-09-08-handoff-attempt-budget-design.md` §5.
      originBrowserHash: hashNonce(nonce),
      handoffCode: { not: null },
      expiresAt: { gt: new Date() },
    },
    // No longer load-bearing for the budget, but it still settles the
    // tie-break if two live candidates ever stamp the same code: the newest
    // wins, rather than whatever order the database happened to return.
    orderBy: { createdAt: 'desc' },
  });
  if (candidates.length === 0) return { kind: 'invalid' };

  // An exhausted row is dead to a match as well as to a miss, so it leaves the
  // working set here. Reaped rather than merely skipped because the increment
  // below can push more than one row over the line at once.
  const spent = candidates.filter((c) => c.handoffAttempts >= HANDOFF_MAX_ATTEMPTS);
  if (spent.length > 0) {
    await db.magicLinkToken.deleteMany({ where: { id: { in: spent.map((c) => c.id) } } });
  }

  const live = candidates.filter((c) => c.handoffAttempts < HANDOFF_MAX_ATTEMPTS);
  if (live.length === 0) return { kind: 'invalid' };

  const match = live.find((candidate) => candidate.handoffCode === code);
  if (!match) {
    // Atomic per row, and `updateMany` rather than `update` so a row a
    // concurrent caller already consumed is a no-op instead of a P2025 to
    // catch. The delete re-reads the counter inside its own statement, so
    // whichever concurrent guess pushed a row over the line, the row dies.
    const ids = live.map((c) => c.id);
    await db.magicLinkToken.updateMany({
      where: { id: { in: ids } },
      data: { handoffAttempts: { increment: 1 } },
    });
    await db.magicLinkToken.deleteMany({
      where: { id: { in: ids }, handoffAttempts: { gte: HANDOFF_MAX_ATTEMPTS } },
    });
    return { kind: 'invalid' };
  }

  if (!(await consumeTokenRow(db, match))) return { kind: 'invalid' };
  return {
    kind: 'verified',
    email: match.email,
    redirectTo: match.redirectTo,
    purpose: match.purpose,
  };
}
```

Then delete the now-unused import on line 5:

```ts
import { isRecordNotFound } from '@/lib/api-errors';
```

`@/lib/api-errors` itself is untouched — three other modules still use the helper.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts`
Expected: PASS, every test in the file — the new cases and every pre-existing one, including `'the race: a correct claim concurrent with wrong guesses never throws'`, which must now pass without any `catch` in the source.

- [ ] **Step 7: Replace the two docblocks**

`HANDOFF_MAX_ATTEMPTS` (`handoff.ts:83-84`) — the existing sentence about not depending on nonce secrecy becomes true rather than aspirational, so it stays; what it is a budget *of* changes:

```ts
/** A 6-digit code is 10⁶, brute-forceable inside the token's fifteen minutes.
 *  Per BROWSER, not per token: wrong codes submitted under one nonce spend it
 *  whichever of that browser's tokens they were aimed at. A per-token budget
 *  is steerable by a caller who can mint tokens under the nonce, so this
 *  scoping is what makes it the guard that does not depend on the nonce
 *  staying secret. */
```

`claimWithCode` (`handoff.ts:87-102`) — the final paragraph states the defect and is replaced outright:

```ts
/**
 * Trades a code for the token it was stamped on, for the browser that
 * requested the link.
 *
 * Looks up by nonce rather than by code, so a wrong guess still finds rows
 * whose budget it must spend. Looking up by both would leave the attempt
 * counter unreachable and the budget unenforceable.
 *
 * A resend legitimately leaves more than one live token sharing this
 * browser's nonce, and either can end up stamped with its own code if both
 * get opened elsewhere. The submitted code is compared against every live
 * candidate at once, so a match claims that specific token, and a code
 * matching none of them is one failed guess against ALL of them — charged to
 * all of them. Charging one chosen row instead undercounts, and lets a caller
 * who can mint tokens under this nonce steer the charge off the token being
 * guessed at.
 */
```

- [ ] **Step 8: Disambiguate the spec pointer this branch made ambiguous**

`verifyWithHandoff`'s docblock (`handoff.ts:27-28`) says "see the design spec's §3 for why". There are now two design specs for this feature, so that pointer no longer resolves. Name the file:

```ts
 * Deliberately not routed through `verifyMagicLinkToken`: this decision has
 * to inspect the row before choosing whether to consume it — see
 * `docs/superpowers/specs/2026-09-03-magic-link-device-handoff-design.md` §3.
```

- [ ] **Step 9: Prove each guard bites**

For each mutation: apply it, run `npx vitest run --project unit src/lib/auth/handoff.test.ts`, record the exact failing test name and assertion text, then restore the file and re-run to confirm GREEN before moving to the next. A guard that cannot fail certifies nothing.

Commit before starting, so restoring a mutation cannot discard other uncommitted work.

| # | Mutation | Must turn RED |
|---|---|---|
| 1 | In the `!match` branch, replace `where: { id: { in: ids } }` on the `updateMany` with `where: { id: live[0]!.id }` | `charges every live candidate on a miss` and `a newer decoy cannot shield an older token` |
| 2 | Delete the `deleteMany … { gte: HANDOFF_MAX_ATTEMPTS }` call in the `!match` branch | `a spent budget destroys every live candidate before any later call` |
| 3 | Remove exhaustion handling entirely: `const live = candidates;` **and** delete the `spent` block | `an exhausted row is dead to its own correct code, and is reaped` — first assertion, the claim returns `verified` |
| 4 | Delete only the `spent` block, keeping the exhaustion filter | `an exhausted row is dead to its own correct code, and is reaped` — second assertion, the row survives |

Mutation 1 is the post-rewrite equivalent of restoring the old `?? candidates[0]!` fallback: both make exactly one row — the newest — absorb the miss.

Each note below is a way this table could mislead someone applying it:

- **Mutation 2** cannot be caught by any test that calls `claimWithCode` again before reading the rows: the reap at the top of the function cleans up on that next call and hides the missing delete. Only the no-intervening-call ordering of the third test sees it.
- **Mutation 3 removes both halves deliberately.** Dropping only the exhaustion filter is *not* detectable, and the reason is worth knowing: the `spent` block has already deleted the row, so `consumeTokenRow` finds nothing to delete and returns `false` (`magic-link.ts:72-73`), which lands on `{ kind: 'invalid' }` by a different route. Do not "improve" this into two separate mutations expecting two RED runs.
- That redundancy is why the filter is kept rather than leaning on the reap alone: the filter is what makes the outcome independent of `consumeTokenRow`'s already-deleted return value, instead of accidentally correct through it. Mutation 4 is what pins the reap's own half.

If a mutation does not turn its listed test RED, the test was written wrong, not the guard — fix the test before continuing.

- [ ] **Step 10: Full verification**

Run: `npm run verify`
Expected: PASS — `tsc --noEmit`, then `eslint`, then every vitest project.

If anything earlier in the chain is red, do **not** read the result as evidence about the integration tier: `npm test` chains two invocations with `&&`, so one red unit test means `integration` never ran and reported nothing. Fix the earlier failure, or run `npx vitest run --project integration` directly, before drawing any conclusion about that tier.

- [ ] **Step 11: Commit**

```bash
git add src/lib/auth/handoff.ts src/lib/auth/handoff.test.ts
git commit -m "fix(auth): scope the handoff attempt budget to the browser, not one token (#423)"
```

---

## Verification summary for the PR body

- The RED failures recorded at Step 4, verbatim, and the note that the exhausted-row case passed there by design.
- Every mutation result from Step 9, each with the test it turned RED.
- The `npm run verify` result from Step 10, with the arithmetic showing the total is every project's tests.
- What `handoff.ts:96-101` said before Step 7 replaced it — the record of the correction lives in the PR body, not beside the code.
- `tests/integration/magic-link-claim.test.ts` is untouched: it exercises the route's session, cookie and redirect behaviour and never reaches the budget. No `tests/integration/**` file is modified by this branch.
- **#383 is unaffected** — it is the security tracking parent and stays open.
