# Plan — log claimWithCode's discarded batched-write counts (#504)

No separate design doc: this is a one-file, additive logging change with a
single reasonable design, resolved below by precedent already in this
codebase. Decision recorded here, not repeated at every gate.

## Premise verification

**Confirmed against `src/lib/auth/handoff.ts` as it stands today.** The miss
branch of `claimWithCode` (lines 147-162) fires two batched writes and
inspects neither result:

```ts
147	  const match = live.find((candidate) => candidate.handoffCode === code);
148	  if (!match) {
...
153	    const ids = live.map((c) => c.id);
154	    await db.magicLinkToken.updateMany({
155	      where: { id: { in: ids } },
156	      data: { handoffAttempts: { increment: 1 } },
157	    });
158	    await db.magicLinkToken.deleteMany({
159	      where: { id: { in: ids }, handoffAttempts: { gte: HANDOFF_MAX_ATTEMPTS } },
160	    });
161	    return { kind: 'invalid' };
162	  }
```

There is no logging anywhere in `handoff.ts` today (`grep -n "log\." src/lib/auth/handoff.ts` returns nothing).

## Decision: `log.warn`, expected-count derived from the in-memory snapshot, no suppression

**Level: `warn`, not `error`.** `waitlist-reconciliation.ts:806` already resolved
this exact dilemma — a lock-race that's expected under load, logged at `warn`
with a comment calling it "the false alarm #269 was filed about, and the line
that keeps it visible without paging anyone." Same shape here: a benign
concurrent-handoff race should stay visible in logs without paging anyone,
which is what this codebase's own `warn` semantics already mean.

**No suppression/throttling.** `rate-limit.ts` DOES throttle its own eviction
warnings (`WARNING_LOG_THROTTLE_MS`, per key prefix) — that precedent exists
because bucket eviction can fire on nearly every request during sustained
load, a genuinely high-frequency, load-scaling signal. The handoff race needs
two rarer things to coincide: multiple live candidates sharing one browser
nonce (only happens on a resend or a scanner prefetch) and a real concurrent
write landing in a specific window during one person's login attempt, bounded
by human behavior inside a 15-minute token lifetime — it does not scale with
traffic the way an LRU eviction does. Building a throttle for a signal with no
evidence of volume is solving a problem that doesn't exist yet (CLAUDE.md:
don't add abstractions beyond what the task requires). If production logs
later show otherwise, that's a follow-up issue with real numbers, not a
preemptive build now.

**The `updateMany` check is the issue's own suggested shape**: warn when
`incremented.count < ids.length` (it cannot legitimately exceed it, since
`ids` are unique row ids).

**The `deleteMany` check goes further than the issue's sketch.** Comparing
`reaped.count` against `ids.length` would be wrong — most misses reap zero
rows by design (only a candidate at the budget's edge gets deleted). The
correct expectation is derivable from data this function already has in
memory: `live` is the pre-increment snapshot, so
`live.filter(c => c.handoffAttempts + 1 >= HANDOFF_MAX_ATTEMPTS).length` is
exactly how many rows *this* call's own increment should push into the reap
predicate. In the single-request case (no concurrency) this always equals
`reaped.count` exactly — verified by inspection: nothing else touches these
rows between the snapshot and the delete, so the delete's live
`handoffAttempts >= HANDOFF_MAX_ATTEMPTS` re-check can only diverge from the
snapshot-derived prediction if a *different* concurrent call wrote to one of
these same rows in between. That divergence is precisely the condition worth
surfacing, and precisely why it must not fire in the ordinary case.

## Task 1 — add both warns, prove each one fires under a forced race

**File:** `src/lib/auth/handoff.ts`

Add the import (matching every other file under `src/lib/auth/`, e.g.
`profile-authorization.ts:6`, `passkey.ts:13`):

```ts
import { log } from '@/lib/log';
```

Replace lines 147-162 with:

```ts
  const match = live.find((candidate) => candidate.handoffCode === code);
  if (!match) {
    // Atomic per row, and `updateMany` rather than `update` so a row a
    // concurrent caller already consumed is a no-op instead of a P2025 to
    // catch. The delete re-reads the counter inside its own statement, so
    // whichever concurrent guess pushed a row over the line, the row dies.
    const ids = live.map((c) => c.id);
    // Expected reap count, derived from THIS call's own `live` snapshot,
    // taken before the increment below runs. A sibling call racing one of
    // these same rows can move its true count between this snapshot and the
    // writes below without this call ever seeing it (#504) — a mismatch
    // below is that documented race, not proof of a bug on its own. Forced
    // in handoff.test.ts by "the race: a correct claim concurrent with wrong
    // guesses never throws" and "warns when two concurrent wrong guesses
    // race the same near-exhausted candidate".
    const expectedReaps = live.filter((c) => c.handoffAttempts + 1 >= HANDOFF_MAX_ATTEMPTS).length;

    const incremented = await db.magicLinkToken.updateMany({
      where: { id: { in: ids } },
      data: { handoffAttempts: { increment: 1 } },
    });
    if (incremented.count < ids.length) {
      log.warn(
        { requested: ids.length, affected: incremented.count },
        'handoff: updateMany affected fewer candidates than requested',
      );
    }

    const reaped = await db.magicLinkToken.deleteMany({
      where: { id: { in: ids }, handoffAttempts: { gte: HANDOFF_MAX_ATTEMPTS } },
    });
    if (reaped.count !== expectedReaps) {
      log.warn(
        { expected: expectedReaps, actual: reaped.count },
        'handoff: deleteMany reaped a different number of exhausted candidates than expected',
      );
    }

    return { kind: 'invalid' };
  }
```

**File:** `src/lib/auth/handoff.test.ts`

Add `vi` to the vitest import and `log`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
```
```ts
import { log } from '@/lib/log';
```

Inside `describe('claimWithCode', ...)`, immediately after the
`stampedWithRedirect` helper (after line 142) and before the first `it`, add:

```ts
  afterEach(() => vi.restoreAllMocks());
```

**Extend the existing race test** (lines 339-355) to spy on `log.warn` and
assert it fired at least once across the loop — this is the same test that
already engineers the row-disappears-mid-write race the `updateMany` check
guards. Also fix its nonce to match its own email's uniqueness scope (see
"A nonce-hygiene fix, folded in" below):

```ts
  it('the race: a correct claim concurrent with wrong guesses never throws', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    for (let i = 0; i < 8; i++) {
      const email = `claim-race-throw-${Date.now()}-${i}@example.com`;
      const nonce = `nonce-race-throw-${Date.now()}-${i}`;
      const code = await stampedToken(email, nonce);
      const wrongGuesses = ['111111', '222222', '333333'].filter((g) => g !== code);

      const results = await Promise.all([
        claimWithCode(db, asBrowserNonce(nonce), code),
        ...wrongGuesses.map((g) => claimWithCode(db, asBrowserNonce(nonce), g)),
      ]);

      for (const result of results) {
        expect(['verified', 'invalid']).toContain(result.kind);
      }
    }
    // The correct claim's consumeTokenRow deletes a row out from under at
    // least one concurrent wrong guess's updateMany across these 8 races —
    // exactly the `incremented.count < ids.length` condition.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({}),
      'handoff: updateMany affected fewer candidates than requested',
    );
  });
```

**Add a new test immediately after it**, before the closing `});` of the
`describe` block (currently line 356), forcing the reap-count mismatch: two
concurrent wrong guesses against one candidate parked one attempt short of
the budget, so both calls' own `expectedReaps` snapshot says "1" but the
delete on whichever call runs second finds the row already gone:

```ts
  it('warns when two concurrent wrong guesses race the same near-exhausted candidate', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    for (let i = 0; i < 8; i++) {
      const email = `claim-race-reap-${Date.now()}-${i}@example.com`;
      const nonce = `nonce-race-reap-${Date.now()}-${i}`;
      const code = await stampedToken(email, nonce);
      await db.magicLinkToken.updateMany({
        where: { email },
        data: { handoffAttempts: HANDOFF_MAX_ATTEMPTS - 1 },
      });
      const wrong = ['000000', '111111'].find((g) => g !== code)!;

      await Promise.all([
        claimWithCode(db, asBrowserNonce(nonce), wrong),
        claimWithCode(db, asBrowserNonce(nonce), wrong),
      ]);
    }
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ expected: 1 }),
      'handoff: deleteMany reaped a different number of exhausted candidates than expected',
    );
  });
```

**A nonce-hygiene fix, folded in — measured, not assumed.** Confirmed by
running the suite repeatedly against the local Postgres test DB
(`DATABASE_URL_TEST`, a persistent container, not recreated per run): the
pre-existing `nonce-race-throw-${i}` (only unique per loop iteration, not per
run — unlike the email on the same line, `claim-race-throw-${Date.now()}-${i}@example.com`)
leaves live `MagicLinkToken` rows behind after every manual local run,
because they don't expire for 15 minutes. Repeated manual runs accumulate
extra "live candidates" sharing that nonce, which is invisible to every
existing assertion in this file (none of them count candidates or inspect
`log.warn`) but becomes directly observable once a test asserts on
`log.warn`, as this task's two tests now do — confirmed by reproducing it:
564 accumulated rows from repeated local runs during this plan's own
validation caused a real, correctly-attributed `log.warn` call from
unrelated concurrent candidates sharing the same stale nonce, before the
rows were cleaned out. Both new/modified tests in this task suffix their
nonce with `Date.now()`, matching the pattern their own email variable
already uses one line above.

The pre-existing `'nonce-race'` test ("counts both attempts when two wrong
guesses race concurrently") is concurrent-and-log-observing too: it races
concurrent `claimWithCode` calls via `Promise.all` over a hardcoded,
non-suffixed nonce, in the same persistent test DB. Two independent PR
reviewers of #505 reproduced this firing a real, unmocked `log.warn` after
local runs accumulated live rows sharing that nonce. Its nonce is now
suffixed with `Date.now()` the same way, in the same PR review's fix.

**Not touched**: the file's other hardcoded nonces (`nonce-c1`-`nonce-c5`,
`nonce-multi`, `nonce-1`-`nonce-5`, `nonce-race-stamp`) — none of them are
concurrent-and-log-observing, so the same accumulation is provably inert for
them (each test matches by its own uniquely-generated code or its own
uniquely-suffixed email, never by counting candidates), and fixing tests
this task isn't otherwise touching would be unrelated-scope cleanup.

**Behaviour to verify.** `npx vitest run --project unit src/lib/auth/handoff.test.ts`
— baseline today is **22 tests, all passing** (measured by running it; also
`grep -c "^\s*it(" src/lib/auth/handoff.test.ts` returns 22). The race test is
extended in place, not duplicated; one new test is added. After this task:
**23 tests, all passing.**

**Mutation proof, required — one per guard, per CLAUDE.md's *Comment
Discipline* and this project's "prove every guard bites" convention.** A pin
that compiles but cannot fail certifies nothing. **Already run once during
this plan's own validation** (implement, mutate each guard with
`if (false && ...)`, confirm RED, restore, confirm GREEN) — both guards bite.
Re-run as part of implementing this task, since the validation run's edits
were reverted rather than committed:

1. Guard the `if (incremented.count < ids.length) { ... }` block with
   `if (false && incremented.count < ids.length) {`. Run
   `npx vitest run --project unit src/lib/auth/handoff.test.ts -t "the race: a correct claim"`.
   **Measured output**: FAIL —
   `AssertionError: expected "LOG" to be called with arguments: [ ObjectContaining {}, …(1) ] / Number of calls: 0`.
   Restore the line exactly (remove `false && `).
2. Guard the `if (reaped.count !== expectedReaps) { ... }` block the same
   way. Run
   `npx vitest run --project unit src/lib/auth/handoff.test.ts -t "near-exhausted candidate"`.
   **Measured output**: FAIL —
   `AssertionError: expected "LOG" to be called with arguments: [ …(2) ] / Number of calls: 0`.
   Restore the line exactly.
3. Re-run the whole file (`npx vitest run --project unit src/lib/auth/handoff.test.ts`)
   with both blocks restored. **Measured**: 23 passed, confirming the
   mutations didn't leave anything behind.

**A shared-database caveat for this specific mutation proof.** Step 3, run
more than once in a row without cleanup in between, could still show an
extra, correctly-attributed `log.warn` call if some concurrent-and-
log-observing test in this file accumulated stale rows under an unsuffixed
nonce. Every such test — `'nonce-race'` included (see above) — now suffixes
its nonce with `Date.now()`, so no known accumulation source remains.

**Commit.**

```bash
git add src/lib/auth/handoff.ts src/lib/auth/handoff.test.ts
git commit -m "$(cat <<'EOF'
fix(auth): log claimWithCode's discarded batched-write counts (#504)

Both writes in the miss path fired without inspecting {count}, so a
regression in the attempt-budget enforcement (a wrong ids array, a
weakened predicate) would have no user-facing symptom and no
operator-visible failure. Warns on a mismatch at `warn`, matching
waitlist-reconciliation.ts's own precedent for logging benign
contention without paging anyone; declines to add suppression, since
nothing here scales with request volume the way that precedent's
eviction warnings do.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

## Verification

Run from the main worktree (this branch touches only `unit`-tier files, no
migration, no route, so no need for the dev server or the shared DB):

- `npm run typecheck`
- `npm run lint`
- `npx vitest run --project unit src/lib/auth/handoff.test.ts`

Full `npm run verify` before pushing, per CLAUDE.md and this repo's standing
hazard list. No `integration` or e2e coverage is needed for this branch —
say so in the PR body rather than citing a CI run for tiers this change
cannot affect (`handoff.ts`'s only callers are unchanged, and no route or
schema is touched).

## Out of scope

- No suppression/rate-limiting mechanism (see Decision above).
- No change to `HandoffOutcome`, the function's return shape, or any caller —
  this branch is additive logging only.
- `verifyWithHandoff`'s own compare-and-swap (`stamped.count === 0`, already
  checked and branched on) is untouched — it isn't discarding anything.
