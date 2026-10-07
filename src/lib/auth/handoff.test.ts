import crypto from 'crypto';
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { generateMagicLinkToken, hashToken } from './magic-link';
import { hashNonce } from './origin-nonce';
import {
  verifyWithHandoff,
  claimWithCode,
  reserveHandoffComparisons,
  HANDOFF_MAX_ATTEMPTS,
  HANDOFF_EMAIL_MAX_ATTEMPTS,
  HANDOFF_EMAIL_WINDOW_MS,
} from './handoff';
import { asBrowserNonce } from './test-support';
import { log } from '@/lib/log';

const db = new PrismaClient();

async function mint(email: string, nonce: string | null) {
  return generateMagicLinkToken(db, email, {
    originBrowserHash: nonce ? hashNonce(nonce) : undefined,
  });
}

describe('verifyWithHandoff', () => {
  it('signs in directly when the nonce matches', async () => {
    const email = `handoff-match-${Date.now()}@example.com`;
    const token = await mint(email, 'nonce-1');

    const out = await verifyWithHandoff(db, token, asBrowserNonce('nonce-1'));

    expect(out).toEqual({ kind: 'verified', email, redirectTo: null, purpose: 'sign_in' });
    expect(await db.magicLinkToken.findFirst({ where: { email } })).toBeNull();
  });

  it('returns a 6-digit code and CONSUMES NOTHING when the nonce is absent', async () => {
    const email = `handoff-absent-${Date.now()}@example.com`;
    const token = await mint(email, 'nonce-2');

    const out = await verifyWithHandoff(db, token, null);

    expect(out.kind).toBe('handoff');
    if (out.kind !== 'handoff') throw new Error('unreachable');
    expect(out.code).toMatch(/^\d{6}$/);

    // The scanner case: the row must survive so the human can still sign in.
    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row).not.toBeNull();
    expect(row?.handoffCode).not.toBeNull();
  });

  it('returns a code when the nonce belongs to a different browser', async () => {
    const email = `handoff-other-${Date.now()}@example.com`;
    const token = await mint(email, 'nonce-3');

    const out = await verifyWithHandoff(db, token, asBrowserNonce('a-different-browser'));

    expect(out.kind).toBe('handoff');
    expect(await db.magicLinkToken.findFirst({ where: { email } })).not.toBeNull();
  });

  it('reuses one code across repeated opens, so an attacker cannot churn it', async () => {
    const email = `handoff-stable-${Date.now()}@example.com`;
    const token = await mint(email, 'nonce-4');

    const first = await verifyWithHandoff(db, token, null);
    const second = await verifyWithHandoff(db, token, null);

    expect(first).toEqual(second);
  });

  // Two concurrent opens of the same never-before-opened link (the "multiple
  // mail scanners" case) both read `handoffCode: null` and would, absent a
  // compare-and-swap on the stamp, each generate and persist their OWN code —
  // the loser's caller then holds a code that was never written to the row
  // and can never be claimed. Looped rather than a single `Promise.all`,
  // since the race window is timing-dependent: one iteration hitting it is
  // enough to prove the bug, but a suite that only tries once can get lucky.
  //
  // Kept alongside the two staged tests below: this test proves the
  // timing-dependent bug is real under a genuine race, while the staged
  // tests below pin specific branches deterministically — two different
  // jobs, neither replacing the other.
  it('the race: concurrent first-opens of the same link agree on one code', async () => {
    for (let i = 0; i < 8; i++) {
      const email = `handoff-race-${Date.now()}-${i}@example.com`;
      const token = await mint(email, 'nonce-race-stamp');

      const [a, b] = await Promise.all([
        verifyWithHandoff(db, token, null),
        verifyWithHandoff(db, token, null),
      ]);

      if (a.kind !== 'handoff' || b.kind !== 'handoff') throw new Error('expected a handoff');
      expect(a.code).toBe(b.code);

      const row = await db.magicLinkToken.findFirst({ where: { email } });
      expect(row?.handoffCode).toBe(a.code);
    }
  });

  // The CAS loser's winner-arm (`handoff.ts:86`): a sibling first-open wins
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
      // method it calls here is the real one.
    }) as unknown as PrismaClient;

    const loser = await verifyWithHandoff(racing, token, null);

    expect(hookCalls).toBe(1);
    if (sibling?.kind !== 'handoff') throw new Error('expected a handoff');
    expect(loser).toEqual(sibling);

    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.handoffCode).toBe(sibling.code);
  });

  // The CAS loser's invalid-arm (`handoff.ts:85`): a sibling call for the
  // SAME token, with the browser's own matching nonce, consumes and deletes
  // the row before this call's `updateMany` runs. This call's CAS matches
  // zero rows because the row is gone — not merely stamped — so `winner`
  // reads back `null` and the loser must report `invalid` rather than
  // dereference a row that no longer exists. This shape is unreachable by
  // the existing loop-based race test, which only ever stages two
  // no-nonce opens — see the spec's §1.3-1.4.
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
      // Same cast, same reason as the first hook in this describe block.
    }) as unknown as PrismaClient;

    const loser = await verifyWithHandoff(racing, token, null);

    expect(hookCalls).toBe(1);
    // A staging that collapsed — a sibling that no longer consumes the row —
    // fails here as itself, rather than downstream as a wrong outcome.
    expect(sibling).toEqual({ kind: 'verified', email, redirectTo: null, purpose: 'sign_in' });
    expect(loser).toEqual({ kind: 'invalid' });
  });

  it('lets the real browser still sign in after a stranger stamped a code', async () => {
    const email = `handoff-nopoison-${Date.now()}@example.com`;
    const token = await mint(email, 'nonce-5');

    await verifyWithHandoff(db, token, null); // stranger opens it
    const out = await verifyWithHandoff(db, token, asBrowserNonce('nonce-5')); // owner taps it

    expect(out.kind).toBe('verified');
  });

  it('is invalid for an expired token, and does not stamp a code', async () => {
    const email = `handoff-expired-${Date.now()}@example.com`;
    const token = await generateMagicLinkToken(db, email, {
      ttlMs: -1000,
      originBrowserHash: hashNonce('some-nonce'),
    });

    expect(await verifyWithHandoff(db, token, null)).toEqual({ kind: 'invalid' });
    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.handoffCode ?? null).toBeNull();
  });

  it('is invalid for a live token with no bound browser — nothing to hand off to', async () => {
    const email = `handoff-nulorigin-${Date.now()}@example.com`;
    const token = await mint(email, null); // mint() with null nonce leaves originBrowserHash unset

    expect(await verifyWithHandoff(db, token, null)).toEqual({ kind: 'invalid' });
    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.handoffCode ?? null).toBeNull();
  });

  it('is invalid for a token that does not exist', async () => {
    expect(await verifyWithHandoff(db, 'not-a-real-token', null)).toEqual({ kind: 'invalid' });
  });
});

describe('claimWithCode', () => {
  async function stampedToken(email: string, nonce: string) {
    const token = await mint(email, nonce);
    const out = await verifyWithHandoff(db, token, null);
    if (out.kind !== 'handoff') throw new Error('expected a handoff');
    return out.code;
  }

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

  afterEach(() => vi.restoreAllMocks());

  it('signs in the browser that requested the link', async () => {
    const email = `claim-ok-${Date.now()}@example.com`;
    const code = await stampedToken(email, 'nonce-c1');

    const out = await claimWithCode(db, asBrowserNonce('nonce-c1'), code);

    expect(out).toEqual({ kind: 'verified', email, redirectTo: null, purpose: 'sign_in' });
    expect(await db.magicLinkToken.findFirst({ where: { email } })).toBeNull();
  });

  it('refuses a correct code presented by a browser that did not ask', async () => {
    const email = `claim-wrongbrowser-${Date.now()}@example.com`;
    const code = await stampedToken(email, 'nonce-c2');

    expect(await claimWithCode(db, asBrowserNonce('someone-elses-browser'), code)).toEqual({
      kind: 'invalid',
    });
    // The real browser can still finish.
    expect((await claimWithCode(db, asBrowserNonce('nonce-c2'), code)).kind).toBe('verified');
  });

  it('refuses a wrong code and counts the attempt', async () => {
    const email = `claim-wrongcode-${Date.now()}@example.com`;
    await stampedToken(email, 'nonce-c3');

    expect(await claimWithCode(db, asBrowserNonce('nonce-c3'), '000000')).toEqual({ kind: 'invalid' });
    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.handoffAttempts).toBe(1);
  });

  it('destroys the token once the attempt budget is spent', async () => {
    const email = `claim-budget-${Date.now()}@example.com`;
    const code = await stampedToken(email, 'nonce-c4');

    for (let i = 0; i < HANDOFF_MAX_ATTEMPTS; i++) {
      await claimWithCode(db, asBrowserNonce('nonce-c4'), '000000');
    }

    // Even the correct code is dead now.
    expect(await claimWithCode(db, asBrowserNonce('nonce-c4'), code)).toEqual({ kind: 'invalid' });
    expect(await db.magicLinkToken.findFirst({ where: { email } })).toBeNull();
  });

  it('is invalid when the browser has no nonce at all', async () => {
    const email = `claim-nononce-${Date.now()}@example.com`;
    const code = await stampedToken(email, 'nonce-c5');
    expect(await claimWithCode(db, null, code)).toEqual({ kind: 'invalid' });
  });

  // A resend legitimately leaves two live tokens sharing one browser's nonce.
  // If both get opened elsewhere and stamped with their own code, the lookup
  // must attribute a correct guess to the token it actually belongs to — not
  // merely the newest one.
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

  it('reaps an already-exhausted sibling while still charging a live candidate in the same call', async () => {
    const email = `claim-mixed-${Date.now()}@example.com`;
    const nonce = `nonce-mixed-${Date.now()}`;

    const liveCode = await stampedWithRedirect(email, nonce, '/live');
    await stampedWithRedirect(email, nonce, '/already-exhausted');
    await db.magicLinkToken.updateMany({
      where: { email, redirectTo: '/already-exhausted' },
      data: { handoffAttempts: HANDOFF_MAX_ATTEMPTS },
    });

    const wrong = ['000000', '111111', '222222'].find((g) => g !== liveCode)!;
    expect(await claimWithCode(db, asBrowserNonce(nonce), wrong)).toEqual({ kind: 'invalid' });

    expect(
      await db.magicLinkToken.findFirst({ where: { email, redirectTo: '/already-exhausted' } }),
    ).toBeNull();
    const live = await db.magicLinkToken.findFirst({ where: { email, redirectTo: '/live' } });
    expect(live?.handoffAttempts).toBe(1);
  });

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

  // A correct claim deletes the matched row via `consumeTokenRow` at the same
  // moment a concurrent wrong guess is running `updateMany`/`deleteMany` over
  // the live candidate ids. Both silently match zero rows instead of
  // throwing, so a row disappearing out from under either call must resolve
  // to a normal outcome, never an unhandled rejection. Looped, with more than
  // one concurrent wrong guess per iteration. Whether any single write lands
  // after the delete is timing-dependent, so this asserts only the outcome
  // every interleaving produces; the loop and the extra guesses are there to
  // give a rejection a real window to occur in. That the
  // `updateMany` under-count guard actually fires when the row does vanish is
  // pinned by the staged `updateMany` under-count test in this file, which
  // does not depend on scheduling.
  //
  // 20s, not vitest's 5s default: same client-side scheduling stall as
  // "counts both attempts..." above, confirmed live on this test too. See
  // `docs/superpowers/specs/2026-09-08-handoff-timeout-flake-design.md` (#512).
  it('the race: a correct claim concurrent with wrong guesses never throws', async () => {
    // Spied to silence, not to assert: this race can legitimately fire the
    // `updateMany` under-count warn, and pinning that it does is the staged
    // test's job, not this one's. `afterEach` restores it.
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    for (let i = 0; i < 8; i++) {
      const email = `claim-race-throw-${Date.now()}-${i}@example.com`;
      const nonce = `nonce-race-throw-${Date.now()}-${i}`;
      const code = await stampedToken(email, nonce);
      const wrongGuesses = ['111111', '222222', '333333'].filter((g) => g !== code);

      const results = await Promise.all([
        claimWithCode(db, asBrowserNonce(nonce), code),
        ...wrongGuesses.map((g) => claimWithCode(db, asBrowserNonce(nonce), g)),
      ]);

      // Deterministic, not merely non-throwing: nothing but the correct claim
      // deletes this row — the wrong guesses drive `handoffAttempts` only to
      // `wrongGuesses.length`, under the budget, so their reap matches
      // nothing — and the row therefore survives to be consumed under every
      // ordering.
      expect(results.filter((r) => r.kind === 'verified')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'invalid')).toHaveLength(wrongGuesses.length);
    }

    // Real concurrency over a row that a `deleteMany` actually deletes: the
    // staged tests below serialize by construction, and the loop above uses a
    // 0-attempt fixture, where `expectedReaps` is 0 and the reap matches
    // nothing. Two wrong guesses can never match, so `invalid` is the outcome
    // under every interleaving — nothing asserted here is timing-dependent.
    const raceTwoWrongGuesses = async (nonce: string, codes: string[]) => {
      // Picked rather than hardcoded: a literal guess could collide with a
      // generated code (10⁻⁶ each) and turn a miss into a match.
      const guesses = ['000000', '111111', '222222', '333333'].filter((g) => !codes.includes(g));
      const [a, b] = await Promise.all(
        guesses.slice(0, 2).map((g) => claimWithCode(db, asBrowserNonce(nonce), g)),
      );
      expect(a).toEqual({ kind: 'invalid' });
      expect(b).toEqual({ kind: 'invalid' });
    };

    {
      // One candidate one attempt short of the budget: both guesses push it
      // over, and whichever reap runs second finds it already taken.
      const email = `claim-race-nearbudget-${Date.now()}@example.com`;
      const nonce = `nonce-race-nearbudget-${Date.now()}`;
      const code = await stampedToken(email, nonce);
      await db.magicLinkToken.updateMany({
        where: { email },
        data: { handoffAttempts: HANDOFF_MAX_ATTEMPTS - 1 },
      });
      await raceTwoWrongGuesses(nonce, [code]);
    }

    {
      // One candidate already at the budget: both calls sweep it into their
      // own `spent` set before either deletes it.
      const email = `claim-race-spent-${Date.now()}@example.com`;
      const nonce = `nonce-race-spent-${Date.now()}`;
      const code = await stampedToken(email, nonce);
      await db.magicLinkToken.updateMany({
        where: { email },
        data: { handoffAttempts: HANDOFF_MAX_ATTEMPTS },
      });
      await raceTwoWrongGuesses(nonce, [code]);
    }

    {
      // Two candidates at different distances from the budget — the staged
      // over-count fixture, run here by two real callers instead.
      const email = `claim-race-overcount-${Date.now()}@example.com`;
      const nonce = `nonce-race-overcount-${Date.now()}`;
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
      await raceTwoWrongGuesses(nonce, [codeA, codeB]);
    }
  }, 20_000);

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
    let sibling: Awaited<ReturnType<typeof claimWithCode>> | undefined;
    const racing = db.$extends({
      query: {
        magicLinkToken: {
          async updateMany({ args, query }) {
            hookCalls += 1;
            sibling = await claimWithCode(db, asBrowserNonce(nonce), code);
            return query(args);
          },
        },
      },
      // `$extends` returns a client missing `$on`, so it is not assignable to
      // `claimWithCode`'s `PrismaClient` parameter even though every method it
      // calls here is the real one.
    }) as unknown as PrismaClient;

    expect(await claimWithCode(racing, asBrowserNonce(nonce), wrong)).toEqual({ kind: 'invalid' });

    expect(hookCalls).toBe(1);
    // A staging that collapsed — a sibling that no longer consumes the row —
    // fails here as itself, rather than downstream as a missing warn.
    expect(sibling).toEqual({ kind: 'verified', email, redirectTo: null, purpose: 'sign_in' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { requested: 1, affected: 0 },
      'handoff: updateMany affected fewer candidates than requested',
    );
  });

  // A sibling wrong guess runs to completion between this call's increment
  // and its reap: it finds the row already at the budget, sweeps it into its
  // own `spent` set and deletes it there, so this call's `deleteMany` finds
  // nothing left to reap against its prediction of one.
  //
  // The sibling is a whole `claimWithCode` on the UNHOOKED client, so every
  // statement it issues is the real one and it cannot re-enter this hook.
  // Interposed after `query(args)` rather than before it, because the row has
  // to cross the budget — this call's own increment is what puts it there.
  //
  // The `warn` spy counts the injected sibling's calls too, and that is what
  // makes the total of 1 load-bearing: the mirror ordering — sibling first,
  // this call second — produces the same `{expected: 1, actual: 0}` payload
  // plus an `updateMany` under-count, so only the count excludes it.
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
    let sibling: Awaited<ReturnType<typeof claimWithCode>> | undefined;
    const racing = db.$extends({
      query: {
        magicLinkToken: {
          async updateMany({ args, query }) {
            hookCalls += 1;
            const ours = await query(args);
            sibling = await claimWithCode(db, asBrowserNonce(nonce), wrong);
            return ours;
          },
        },
      },
      // Same cast, same reason as the first hook in this describe block.
    }) as unknown as PrismaClient;

    expect(await claimWithCode(racing, asBrowserNonce(nonce), wrong)).toEqual({ kind: 'invalid' });

    expect(hookCalls).toBe(1);
    // A staging that collapsed — a sibling that no longer runs the reap —
    // fails here as itself, rather than downstream as a missing warn.
    expect(sibling).toEqual({ kind: 'invalid' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { expected: 1, actual: 0 },
      'handoff: deleteMany reaped a different number of exhausted candidates than expected',
    );
  });

  // Two calls racing an already-exhausted candidate both read it as `spent`
  // and both try to delete it; whichever runs second finds nothing left.
  // Staged by interposing the sibling right after THIS call's `findMany`,
  // since the guard is reachable only when both calls hold the row in their
  // `spent` set before either deletes it.
  it('warns when a sibling reaps the already-spent candidate first', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const email = `claim-staged-spent-${Date.now()}@example.com`;
    const nonce = `nonce-staged-spent-${Date.now()}`;
    await stampedToken(email, nonce);
    await db.magicLinkToken.updateMany({
      where: { email },
      data: { handoffAttempts: HANDOFF_MAX_ATTEMPTS },
    });
    // The exact guess doesn't matter: this row is already exhausted and gets
    // swept into `spent` regardless of whether it matches.
    const guess = '000000';

    let hookCalls = 0;
    let sibling: Awaited<ReturnType<typeof claimWithCode>> | undefined;
    const racing = db.$extends({
      query: {
        magicLinkToken: {
          async findMany({ args, query }) {
            hookCalls += 1;
            const ours = await query(args);
            sibling = await claimWithCode(db, asBrowserNonce(nonce), guess);
            return ours;
          },
        },
      },
      // Same cast, same reason as the first hook in this describe block.
    }) as unknown as PrismaClient;

    expect(await claimWithCode(racing, asBrowserNonce(nonce), guess)).toEqual({ kind: 'invalid' });

    expect(hookCalls).toBe(1);
    // A staging that collapsed — a sibling that no longer reaps the spent row
    // — fails here as itself, rather than downstream as a missing warn.
    expect(sibling).toEqual({ kind: 'invalid' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { expected: 1, actual: 0 },
      'handoff: spent-candidate cleanup reaped a different number of rows than expected',
    );
  });

  it('does not warn on an ordinary uncontested miss', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const email = `claim-nowarn-${Date.now()}@example.com`;
    const nonce = `nonce-nowarn-${Date.now()}`;
    const code = await stampedToken(email, nonce);
    const wrong = ['000000', '111111'].find((g) => g !== code)!;
    await claimWithCode(db, asBrowserNonce(nonce), wrong);
    expect(warn).not.toHaveBeenCalled();
  });

  // This call's snapshot sees `/a` at `MAX - 2` and `/b` at `MAX - 1`, so
  // `expectedReaps` is 1 — only `/b` is predicted to cross. The sibling's
  // increment then lands on BOTH candidates before this call's `deleteMany`,
  // so `/a` crosses too and the reap takes two rows against a prediction of
  // one.
  //
  // The sibling's `updateMany` is staged as `args` re-issued rather than as a
  // whole nested `claimWithCode` call: a nested call would take its snapshot
  // AFTER this call's increment, see `/b` already at the budget and reap
  // it as its own spent row — this call's `deleteMany` would then find
  // nothing and under-count, which is a different race. Re-issuing `args` is
  // not an approximation of the sibling's statement — in this race both calls
  // snapshot before either writes, so both derive the same `ids` and issue
  // the identical statement; re-issuing `args` is a copy of it.
  //
  // Interposed inside the hook rather than issued before the call, so it
  // lands after the miss path has taken its snapshot and computed
  // `expectedReaps`. Issued before the call it would not stage this race at
  // all: `/b` would already be at the budget when the snapshot is taken, so
  // it would be swept into `spent` rather than predicted to cross, and every
  // count would match.
  //
  // What this does not execute is two real callers reaching that state — the
  // sibling here is a statement, not a call. That the state is reachable at
  // all rests on the argument above, not on anything this test runs; the
  // surviving real-concurrency test above covers the same fixture.
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
    let siblingIncrement: Prisma.BatchPayload | undefined;
    const racing = db.$extends({
      query: {
        magicLinkToken: {
          async updateMany({ args, query }) {
            hookCalls += 1;
            const ours = await query(args);
            siblingIncrement = await db.magicLinkToken.updateMany(args);
            return ours;
          },
        },
      },
      // Same cast, same reason as the first hook in this describe block.
    }) as unknown as PrismaClient;

    expect(await claimWithCode(racing, asBrowserNonce(nonce), wrong)).toEqual({ kind: 'invalid' });

    expect(hookCalls).toBe(1);
    // A staging that collapsed — a sibling increment that no longer lands on
    // both candidates — fails here as itself, rather than downstream as a
    // missing warn.
    expect(siblingIncrement?.count).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { expected: 1, actual: 2 },
      'handoff: deleteMany reaped a different number of exhausted candidates than expected',
    );
  });
});

describe('the per-address comparison budget', () => {
  // Every address below carries this run's tag, so the teardown can find
  // exactly this run's rows and nothing else.
  const RUN = `budget-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let seq = 0;
  const address = (label: string) => `${RUN}-${label}-${seq++}@example.com`;
  const nonceFor = (label: string) => `${RUN}-nonce-${label}-${seq++}`;

  afterAll(async () => {
    await db.handoffAttemptBudget.deleteMany({ where: { email: { startsWith: RUN } } });
    await db.magicLinkToken.deleteMany({ where: { email: { startsWith: RUN } } });
  });

  /** Mints a token under `nonce` and opens it from no browser, which stamps a
   *  code on it. Returns the code and the raw token. */
  async function stamp(email: string, nonce: string, redirectTo?: string) {
    const token = await generateMagicLinkToken(db, email, {
      originBrowserHash: hashNonce(nonce),
      redirectTo,
    });
    const out = await verifyWithHandoff(db, token, null);
    if (out.kind !== 'handoff') throw new Error('expected a handoff');
    return { code: out.code, token };
  }

  /** A six-digit guess equal to none of `codes`. */
  function wrongFor(...codes: string[]) {
    return ['000000', '111111', '222222', '333333'].find((g) => !codes.includes(g))!;
  }

  async function budgetOf(email: string) {
    return db.handoffAttemptBudget.findUnique({ where: { email } });
  }

  async function tokenRow(token: string) {
    return db.magicLinkToken.findUnique({ where: { tokenHash: hashToken(token) } });
  }

  /** Sets the address's budget to `attempts` used, in a window that started now. */
  async function spend(email: string, attempts: number) {
    await db.handoffAttemptBudget.upsert({
      where: { email },
      create: { email, attempts, windowStartsAt: new Date() },
      update: { attempts, windowStartsAt: new Date() },
    });
  }

  it('grants up to the window maximum and nothing after it', async () => {
    const email = address('grants');

    const grants: number[] = [];
    for (let i = 0; i < 4; i++) grants.push(await reserveHandoffComparisons(db, email, 3));
    expect(grants).toEqual([3, 3, 3, 1]);
    expect(await reserveHandoffComparisons(db, email, 3)).toBe(0);
    expect((await budgetOf(email))?.attempts).toBe(HANDOFF_EMAIL_MAX_ATTEMPTS);
  });

  it('asks for nothing when nothing is wanted', async () => {
    const email = address('nothing');
    expect(await reserveHandoffComparisons(db, email, 0)).toBe(0);
    expect(await budgetOf(email)).toBeNull();
  });

  // The row existed, so the insert did nothing, and is then deleted before
  // the lock is taken — what the retention sweep or an erasure can do. The
  // delete runs on the unhooked client, a connection of its own.
  it('grants from a fresh window when the row is deleted between the insert and the lock', async () => {
    const email = address('vanishing');
    await spend(email, HANDOFF_EMAIL_MAX_ATTEMPTS);

    let hookCalls = 0;
    const racing = db.$extends({
      query: {
        handoffAttemptBudget: {
          async createMany({ args, query }) {
            hookCalls += 1;
            const ours = await query(args);
            if (hookCalls === 1) await db.handoffAttemptBudget.delete({ where: { email } });
            return ours;
          },
        },
      },
      // Same cast as the hooks above: `$extends` drops `$on`.
    }) as unknown as PrismaClient;

    expect(await reserveHandoffComparisons(racing, email, 2)).toBe(2);
    expect(hookCalls).toBe(2);
    expect((await budgetOf(email))?.attempts).toBe(2);
  });

  it('a window that has ended grants again and restarts at the given now', async () => {
    const email = address('window');
    await reserveHandoffComparisons(db, email, HANDOFF_EMAIL_MAX_ATTEMPTS);
    expect(await reserveHandoffComparisons(db, email, 1)).toBe(0);

    const now = new Date();
    // One millisecond short of a full window: still spent.
    await db.handoffAttemptBudget.update({
      where: { email },
      data: { windowStartsAt: new Date(now.getTime() - HANDOFF_EMAIL_WINDOW_MS + 1) },
    });
    expect(await reserveHandoffComparisons(db, email, 4, now)).toBe(0);

    // Exactly one window old: ended.
    await db.handoffAttemptBudget.update({
      where: { email },
      data: { windowStartsAt: new Date(now.getTime() - HANDOFF_EMAIL_WINDOW_MS) },
    });
    expect(await reserveHandoffComparisons(db, email, 4, now)).toBe(4);

    const row = await budgetOf(email);
    expect(row?.attempts).toBe(4);
    expect(row?.windowStartsAt.getTime()).toBe(now.getTime());
  });

  it('spans tokens and nonces: misses spread across them exhaust one budget', async () => {
    const email = address('spans');
    const [n1, n2, n3] = [nonceFor('1'), nonceFor('2'), nonceFor('3')];
    const t1 = await stamp(email, n1);
    const t2 = await stamp(email, n2);
    const t3 = await stamp(email, n3);
    const wrong = wrongFor(t1.code, t2.code, t3.code);

    // No token reaches the per-token limit.
    for (let i = 0; i < 4; i++) await claimWithCode(db, asBrowserNonce(n1), wrong);
    for (let i = 0; i < 4; i++) await claimWithCode(db, asBrowserNonce(n2), wrong);
    for (let i = 0; i < 2; i++) await claimWithCode(db, asBrowserNonce(n3), wrong);

    expect(await claimWithCode(db, asBrowserNonce(n3), t3.code)).toEqual({ kind: 'invalid' });
    expect((await tokenRow(t3.token))?.handoffAttempts).toBe(2);
  });

  it('a claim spends one unit per code compared, not one per claim', async () => {
    const email = address('per-code');
    const nonce = nonceFor('per-code');
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) codes.push((await stamp(email, nonce)).code);

    expect(await claimWithCode(db, asBrowserNonce(nonce), wrongFor(...codes))).toEqual({
      kind: 'invalid',
    });
    expect((await budgetOf(email))?.attempts).toBe(3);
  });

  /** Two stamped tokens for one address under one nonce, the older one moved
   *  a minute back so newest-first is unambiguous, and the budget one short of
   *  spent. */
  async function oneLeft(label: string) {
    const email = address(label);
    const nonce = nonceFor(label);
    const older = await stamp(email, nonce, '/older');
    const newer = await stamp(email, nonce, '/newer');
    await db.magicLinkToken.update({
      where: { tokenHash: hashToken(older.token) },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    await spend(email, HANDOFF_EMAIL_MAX_ATTEMPTS - 1);
    return { email, nonce, older, newer };
  }

  it('a partial grant compares the newest candidate, so the older code is refused', async () => {
    const { nonce, older, newer } = await oneLeft('partial-older');

    expect(await claimWithCode(db, asBrowserNonce(nonce), older.code)).toEqual({ kind: 'invalid' });
    // The miss is charged to the candidate that was compared, and only to it.
    expect((await tokenRow(older.token))?.handoffAttempts).toBe(0);
    expect((await tokenRow(newer.token))?.handoffAttempts).toBe(1);
  });

  it('a partial grant still lets the newest candidate verify', async () => {
    const { email, nonce, newer } = await oneLeft('partial-newer');

    expect(await claimWithCode(db, asBrowserNonce(nonce), newer.code)).toEqual({
      kind: 'verified',
      email,
      redirectTo: '/newer',
      purpose: 'sign_in',
    });
  });

  it('only granted candidates are compared: a spent address cannot match, another one can', async () => {
    const a = address('a');
    const b = address('b');
    const nonce = nonceFor('ab');
    const aStamp = await stamp(a, nonce);
    const bStamp = await stamp(b, nonce);
    await spend(a, HANDOFF_EMAIL_MAX_ATTEMPTS);

    expect(await claimWithCode(db, asBrowserNonce(nonce), aStamp.code)).toEqual({ kind: 'invalid' });
    expect(await claimWithCode(db, asBrowserNonce(nonce), bStamp.code)).toEqual({
      kind: 'verified',
      email: b,
      redirectTo: null,
      purpose: 'sign_in',
    });
  });

  // Live order is newest first across addresses: A's older token, then B's,
  // then A's newest. Grouping by address puts both of A's tokens before B's,
  // so the shared code must still resolve to B's token, the newer of the two
  // that carry it.
  it('a code two addresses share claims the newer token, whatever the address grouping', async () => {
    const a = address('tie-a');
    const b = address('tie-b');
    const nonce = nonceFor('tie');
    const shared = '424242';
    const base = Date.now();
    const row = (email: string, handoffCode: string, ageMs: number, redirectTo: string) => ({
      tokenHash: hashToken(crypto.randomBytes(32).toString('hex')),
      email,
      redirectTo,
      originBrowserHash: hashNonce(nonce),
      handoffCode,
      createdAt: new Date(base - ageMs),
      expiresAt: new Date(base + 15 * 60_000),
    });
    await db.magicLinkToken.createMany({
      data: [
        row(a, '131313', 0, '/a-newest'),
        row(b, shared, 60_000, '/b'),
        row(a, shared, 120_000, '/a-older'),
      ],
    });

    expect(await claimWithCode(db, asBrowserNonce(nonce), shared)).toEqual({
      kind: 'verified',
      email: b,
      redirectTo: '/b',
      purpose: 'sign_in',
    });
  });

  it('a spent budget leaves the same-browser path alone', async () => {
    const email = address('same-browser');
    const nonce = nonceFor('same-browser');
    const { token } = await stamp(email, nonce);
    await spend(email, HANDOFF_EMAIL_MAX_ATTEMPTS);

    expect(await verifyWithHandoff(db, token, asBrowserNonce(nonce))).toEqual({
      kind: 'verified',
      email,
      redirectTo: null,
      purpose: 'sign_in',
    });
  });

  it('refuses an address that is not lowercase', async () => {
    await expect(
      db.$executeRaw`INSERT INTO "HandoffAttemptBudget" (email, "windowStartsAt", attempts)
                     VALUES (${`${RUN}-Upper@Example.com`}, now(), 0)`,
    ).rejects.toThrow(/HandoffAttemptBudget_email_lowercase_check/);
    // The same statement with a lowercase address is accepted, so the refusal
    // above is the CHECK and nothing else about the statement.
    await expect(
      db.$executeRaw`INSERT INTO "HandoffAttemptBudget" (email, "windowStartsAt", attempts)
                     VALUES (${address('lower')}, now(), 0)`,
    ).resolves.toBe(1);
  });

  // Each claim below compares one candidate, the one under its own nonce, so
  // a budget charged after comparing would let every claim compare. The
  // budget row is held from a second connection until every claim is queued
  // on its lock, so the claims demonstrably overlap.
  it('concurrent claims across many nonces compare no more than the budget allows', async () => {
    const email = address('race');
    const nonces = Array.from({ length: 20 }, (_, i) => nonceFor(`race-${i}`));
    // Written directly rather than minted: no rate limit applies, and every
    // code is known to differ from the guess.
    await db.magicLinkToken.createMany({
      data: nonces.map((n, i) => ({
        tokenHash: hashToken(crypto.randomBytes(32).toString('hex')),
        email,
        originBrowserHash: hashNonce(n),
        handoffCode: String(100_000 + i),
        expiresAt: new Date(Date.now() + 15 * 60_000),
      })),
    });
    await db.handoffAttemptBudget.create({ data: { email, attempts: 0, windowStartsAt: new Date() } });

    // Room for every claim's transaction at once. A smaller pool would queue
    // some claims in the client, where they never reach the lock.
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('connection_limit', String(nonces.length + 5));
    const wide = new PrismaClient({ datasourceUrl: url.toString() });
    const holder = new PrismaClient();
    let claims: Promise<Awaited<ReturnType<typeof claimWithCode>>[]> | undefined;
    try {
      let waiting = 0;
      await holder.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "HandoffAttemptBudget" WHERE email = ${email} FOR UPDATE`;
          const [self] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          if (!self) throw new Error('no backend pid for the holder');
          claims = Promise.all(nonces.map((n) => claimWithCode(wide, asBrowserNonce(n), '999999')));
          const deadline = Date.now() + 20_000;
          while (waiting < nonces.length && Date.now() < deadline) {
            // Backends blocked by the holder, directly or through another
            // waiter: only the first in line waits on the holder itself, and
            // each later one waits on the queue ahead of it. Nothing else
            // waiting on a lock in this database is counted.
            const [row] = await db.$queryRaw<{ n: number }[]>`
              WITH RECURSIVE blocked(pid) AS (
                SELECT a.pid FROM pg_stat_activity a
                WHERE pg_blocking_pids(a.pid) @> ARRAY[${self.pid}::int]
                UNION
                SELECT a.pid FROM pg_stat_activity a
                JOIN blocked b ON pg_blocking_pids(a.pid) @> ARRAY[b.pid]
              )
              SELECT count(*)::int AS n FROM blocked`;
            waiting = row?.n ?? 0;
            if (waiting < nonces.length) await new Promise((resolve) => setTimeout(resolve, 50));
          }
        },
        { timeout: 30_000 },
      );
      expect(waiting).toBe(nonces.length);

      const results = await claims!;
      expect(results.every((r) => r.kind === 'invalid')).toBe(true);

      const rows = await db.magicLinkToken.findMany({ where: { email } });
      expect(rows).toHaveLength(nonces.length);
      expect(rows.reduce((sum, r) => sum + r.handoffAttempts, 0)).toBe(HANDOFF_EMAIL_MAX_ATTEMPTS);
      expect((await budgetOf(email))?.attempts).toBe(HANDOFF_EMAIL_MAX_ATTEMPTS);
    } finally {
      // Settled before disconnecting, so a failed assertion above does not
      // leave twenty claims rejecting against a closed client.
      await claims?.catch(() => undefined);
      await wide.$disconnect();
      await holder.$disconnect();
    }
  }, 60_000);
});
