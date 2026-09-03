import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateMagicLinkToken } from './magic-link';
import { hashNonce } from './origin-nonce';
import { verifyWithHandoff, claimWithCode, HANDOFF_MAX_ATTEMPTS } from './handoff';
import { asBrowserNonce } from './test-support';

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

    const olderToken = await generateMagicLinkToken(db, email, {
      originBrowserHash: hashNonce(nonce),
      redirectTo: '/older',
    });
    const olderOut = await verifyWithHandoff(db, olderToken, null);
    if (olderOut.kind !== 'handoff') throw new Error('expected a handoff');

    const newerToken = await generateMagicLinkToken(db, email, {
      originBrowserHash: hashNonce(nonce),
      redirectTo: '/newer',
    });
    const newerOut = await verifyWithHandoff(db, newerToken, null);
    if (newerOut.kind !== 'handoff') throw new Error('expected a handoff');

    // The redirect pins which token actually matched: the newer token's row
    // would answer '/newer' if the lookup had misattributed the guess to it.
    expect(await claimWithCode(db, asBrowserNonce(nonce), olderOut.code)).toEqual({
      kind: 'verified',
      email,
      redirectTo: '/older',
      purpose: 'sign_in',
    });
  });

  // Two concurrent wrong guesses against the same row must not undercount
  // each other — see the atomic `{ increment: 1 }` in `claimWithCode`.
  it('counts both attempts when two wrong guesses race concurrently', async () => {
    const email = `claim-race-${Date.now()}@example.com`;
    const code = await stampedToken(email, 'nonce-race');
    // Stay under HANDOFF_MAX_ATTEMPTS so the row survives to be inspected.
    const guesses = ['111111', '222222', '333333', '444444'].filter((g) => g !== code);

    await Promise.all(guesses.map((g) => claimWithCode(db, asBrowserNonce('nonce-race'), g)));

    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.handoffAttempts).toBe(guesses.length);
  });

  // A correct claim deletes the row via `consumeTokenRow` at the same moment
  // a concurrent wrong guess is trying to `update` its attempt counter. The
  // row being gone out from under that `update` must resolve to `{ kind:
  // 'invalid' }`, not propagate Prisma's P2025. Looped, with more than one
  // concurrent wrong guess per iteration, since whether any single `update`
  // lands after the delete is timing-dependent.
  it('the race: a correct claim concurrent with wrong guesses never throws', async () => {
    for (let i = 0; i < 8; i++) {
      const email = `claim-race-throw-${Date.now()}-${i}@example.com`;
      const nonce = `nonce-race-throw-${i}`;
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
  });
});
