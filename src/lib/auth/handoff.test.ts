import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateMagicLinkToken } from './magic-link';
import { hashNonce } from './origin-nonce';
import { verifyWithHandoff, claimWithCode, HANDOFF_MAX_ATTEMPTS } from './handoff';

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

    const out = await verifyWithHandoff(db, token, 'nonce-1');

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

    const out = await verifyWithHandoff(db, token, 'a-different-browser');

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

  it('lets the real browser still sign in after a stranger stamped a code', async () => {
    const email = `handoff-nopoison-${Date.now()}@example.com`;
    const token = await mint(email, 'nonce-5');

    await verifyWithHandoff(db, token, null); // stranger opens it
    const out = await verifyWithHandoff(db, token, 'nonce-5'); // owner taps it

    expect(out.kind).toBe('verified');
  });

  it('is invalid for an expired token, and does not stamp a code', async () => {
    const email = `handoff-expired-${Date.now()}@example.com`;
    const token = await generateMagicLinkToken(db, email, { ttlMs: -1000 });

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

    const out = await claimWithCode(db, 'nonce-c1', code);

    expect(out).toEqual({ kind: 'verified', email, redirectTo: null, purpose: 'sign_in' });
    expect(await db.magicLinkToken.findFirst({ where: { email } })).toBeNull();
  });

  it('refuses a correct code presented by a browser that did not ask', async () => {
    const email = `claim-wrongbrowser-${Date.now()}@example.com`;
    const code = await stampedToken(email, 'nonce-c2');

    expect(await claimWithCode(db, 'someone-elses-browser', code)).toEqual({ kind: 'invalid' });
    // The real browser can still finish.
    expect((await claimWithCode(db, 'nonce-c2', code)).kind).toBe('verified');
  });

  it('refuses a wrong code and counts the attempt', async () => {
    const email = `claim-wrongcode-${Date.now()}@example.com`;
    await stampedToken(email, 'nonce-c3');

    expect(await claimWithCode(db, 'nonce-c3', '000000')).toEqual({ kind: 'invalid' });
    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.handoffAttempts).toBe(1);
  });

  it('destroys the token once the attempt budget is spent', async () => {
    const email = `claim-budget-${Date.now()}@example.com`;
    const code = await stampedToken(email, 'nonce-c4');

    for (let i = 0; i < HANDOFF_MAX_ATTEMPTS; i++) {
      await claimWithCode(db, 'nonce-c4', '000000');
    }

    // Even the correct code is dead now.
    expect(await claimWithCode(db, 'nonce-c4', code)).toEqual({ kind: 'invalid' });
    expect(await db.magicLinkToken.findFirst({ where: { email } })).toBeNull();
  });

  it('is invalid when the browser has no nonce at all', async () => {
    const email = `claim-nononce-${Date.now()}@example.com`;
    const code = await stampedToken(email, 'nonce-c5');
    expect(await claimWithCode(db, null, code)).toEqual({ kind: 'invalid' });
  });
});
