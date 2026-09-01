import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  generateMagicLinkToken,
  verifyMagicLinkToken,
  cleanupExpiredTokens,
} from './magic-link';

const db = new PrismaClient();

beforeAll(async () => {
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

afterEach(async () => {
  // Scoped, not a truncate: sibling suites hold their own `magicLinkToken`
  // rows and assert those survive their own sweeps. Every address this file
  // mints is `*@example.com`, and this filter is what keeps it to those.
  await db.magicLinkToken.deleteMany({ where: { email: { endsWith: '@example.com' } } });
});

describe('generateMagicLinkToken', () => {
  it('creates a token in DB and returns a 64-char hex string', async () => {
    const rawToken = await generateMagicLinkToken(db, 'test@example.com');

    // Raw token should be 64 hex characters (32 bytes)
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/);

    // A record should exist in the DB (stored as hash, not raw)
    const count = await db.magicLinkToken.count({
      where: { email: 'test@example.com' },
    });
    expect(count).toBe(1);
  });

  it('stores the hashed token, not the raw token', async () => {
    const rawToken = await generateMagicLinkToken(db, 'hash@example.com');

    // The raw token should NOT appear as a tokenHash in DB
    const found = await db.magicLinkToken.findFirst({
      where: { tokenHash: rawToken },
    });
    expect(found).toBeNull();

    // But there should be a record for this email
    const record = await db.magicLinkToken.findFirst({
      where: { email: 'hash@example.com' },
    });
    expect(record).not.toBeNull();
    expect(record!.tokenHash).not.toBe(rawToken);
  });
});

describe('verifyMagicLinkToken', () => {
  it('returns email for a valid token', async () => {
    const rawToken = await generateMagicLinkToken(db, 'valid@example.com');

    const result = await verifyMagicLinkToken(db, rawToken);

    expect(result).not.toBeNull();
    expect(result!.email).toBe('valid@example.com');
  });

  it('returns null for an expired token', async () => {
    const rawToken = await generateMagicLinkToken(db, 'expired@example.com');

    // Expire the token
    await db.magicLinkToken.updateMany({
      where: { email: 'expired@example.com' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const result = await verifyMagicLinkToken(db, rawToken);
    expect(result).toBeNull();
  });

  it('deletes the token after verification (one-time use)', async () => {
    const rawToken = await generateMagicLinkToken(db, 'onetime@example.com');

    // First verification should succeed
    const first = await verifyMagicLinkToken(db, rawToken);
    expect(first).not.toBeNull();

    // Second verification should fail — token was deleted
    const second = await verifyMagicLinkToken(db, rawToken);
    expect(second).toBeNull();
  });

  it('returns null for an invalid/unknown token', async () => {
    const result = await verifyMagicLinkToken(db, 'invalid-random-token');
    expect(result).toBeNull();
  });

  it('invalidates every other live token for that address on a successful sign-in', async () => {
    const email = 'siblings@example.com';
    const first = await generateMagicLinkToken(db, email);
    const second = await generateMagicLinkToken(db, email);

    expect(await verifyMagicLinkToken(db, second)).toEqual({ email, redirectTo: null, purpose: 'sign_in' });

    // The older link is dead: it has no purpose once its owner is signed in,
    // and a live one sitting in an inbox is exposure with no upside.
    expect(await verifyMagicLinkToken(db, first)).toBeNull();
    expect(await db.magicLinkToken.count({ where: { email } })).toBe(0);
  });

  /**
   * The placement guard for the sibling invalidation above. Captures the
   * stale row by `id` before minting the live one, rather than hashing
   * `stale` to look it up directly — `hashToken` is exported from this
   * module now (`signup-ticket.ts`'s `peekSignupTicket` needs it), but this
   * test has no need to use it: capturing by `id` already reaches the row.
   */
  it('does not let an expired token kill a live one', async () => {
    const email = 'expired-cannot-kill@example.com';
    const stale = await generateMagicLinkToken(db, email);
    const staleRow = await db.magicLinkToken.findFirstOrThrow({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });
    await db.magicLinkToken.update({
      where: { id: staleRow.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const live = await generateMagicLinkToken(db, email);

    expect(await verifyMagicLinkToken(db, stale)).toBeNull(); // expired, rejected
    // If invalidation ran before the expiry check, this would be dead too —
    // which would let anyone holding an old link deny the real user theirs.
    expect(await verifyMagicLinkToken(db, live)).toEqual({ email, redirectTo: null, purpose: 'sign_in' });
  });
});

describe('purpose (#385)', () => {
  it('round-trips the purpose it was minted with', async () => {
    const token = await generateMagicLinkToken(db, 'purpose-teacher-signup@example.com', {
      purpose: 'teacher_signup',
    });
    const result = await verifyMagicLinkToken(db, token);
    expect(result?.purpose).toBe('teacher_signup');
  });

  it('defaults to sign_in when no purpose is given', async () => {
    const token = await generateMagicLinkToken(db, 'purpose-default@example.com');
    expect((await verifyMagicLinkToken(db, token))?.purpose).toBe('sign_in');
  });
});

describe('cleanupExpiredTokens', () => {
  it('removes expired tokens and returns the count', async () => {
    // Create two tokens
    await generateMagicLinkToken(db, 'a@example.com');
    await generateMagicLinkToken(db, 'b@example.com');

    // Expire one of them
    await db.magicLinkToken.updateMany({
      where: { email: 'a@example.com' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const deleted = await cleanupExpiredTokens(db);
    expect(deleted).toBe(1);

    // The non-expired one should still exist. Scoped for the same reason the
    // `afterEach` above is: a bare `.count()` counts sibling suites' rows too,
    // and this database persists between local runs.
    const remaining = await db.magicLinkToken.count({
      where: { email: { endsWith: '@example.com' } },
    });
    expect(remaining).toBe(1);
  });

  it('returns 0 when no tokens are expired', async () => {
    await generateMagicLinkToken(db, 'fresh@example.com');

    const deleted = await cleanupExpiredTokens(db);
    expect(deleted).toBe(0);
  });
});
