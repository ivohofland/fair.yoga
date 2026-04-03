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
  await db.magicLinkToken.deleteMany();
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

    // The non-expired one should still exist
    const remaining = await db.magicLinkToken.count();
    expect(remaining).toBe(1);
  });

  it('returns 0 when no tokens are expired', async () => {
    await generateMagicLinkToken(db, 'fresh@example.com');

    const deleted = await cleanupExpiredTokens(db);
    expect(deleted).toBe(0);
  });
});
