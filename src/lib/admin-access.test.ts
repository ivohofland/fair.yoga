import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { seedSession } from '../../tests/helpers';
import {
  TEST_ADMIN_HOST,
  createAdminFixture,
  seedPasskeySession,
  cleanupAdminFixtures,
  type AdminFixture,
} from '../../tests/admin-fixtures';
import { resolveAdminAccess, assertAdminProof, ADMIN_AUTH_WINDOW_MS, type AdminProof } from './admin-access';

const db = new PrismaClient();
let admin: AdminFixture;
let plain: AdminFixture;

beforeAll(async () => {
  admin = await createAdminFixture(db, 'gate');
  plain = await createAdminFixture(db, 'gate-plain', { grant: false });
});

afterAll(async () => {
  await cleanupAdminFixtures(db, [admin?.accountId, plain?.accountId].filter((id): id is string => Boolean(id)));
  await db.$disconnect();
});

beforeEach(() => vi.stubEnv('ADMIN_HOST', TEST_ADMIN_HOST));
afterEach(() => vi.unstubAllEnvs());

describe('resolveAdminAccess', () => {
  it('pins the window at five minutes', () => {
    expect(ADMIN_AUTH_WINDOW_MS).toBe(300_000);
  });

  it('grants a fresh passkey session of a granted account on the admin host', async () => {
    const access = await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: await seedPasskeySession(db, admin) });
    expect(access.kind).toBe('granted');
    if (access.kind === 'granted') expect(access.proof.accountId).toBe(admin.accountId);
  });

  it('is not_found on another host, even for a valid admin session', async () => {
    const token = await seedPasskeySession(db, admin);
    expect(await resolveAdminAccess(db, { host: 'localhost:3000', sessionToken: token })).toEqual({ kind: 'not_found' });
  });

  it('is not_found everywhere when ADMIN_HOST is unset', async () => {
    vi.stubEnv('ADMIN_HOST', '');
    const token = await seedPasskeySession(db, admin);
    expect(await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: token })).toEqual({ kind: 'not_found' });
  });

  it('asks for sign-in with no session token, or one that matches no session', async () => {
    expect(await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: null })).toEqual({ kind: 'sign_in' });
    expect(await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: 'no-such-token' })).toEqual({ kind: 'sign_in' });
  });

  it('is not_found for a signed-in account without a grant — even with a fresh passkey session', async () => {
    const token = await seedPasskeySession(db, plain);
    expect(await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: token })).toEqual({ kind: 'not_found' });
  });

  it('is not_found once the grant is revoked, for a session that was granted a moment before', async () => {
    const revokee = await createAdminFixture(db, 'gate-revoke');
    try {
      const token = await seedPasskeySession(db, revokee);
      expect((await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: token })).kind).toBe('granted');
      await db.adminGrant.updateMany({
        where: { accountId: revokee.accountId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: 'test' },
      });
      expect(await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: token })).toEqual({ kind: 'not_found' });
    } finally {
      await cleanupAdminFixtures(db, [revokee.accountId]);
    }
  });

  it('asks a grantee to sign in again when the session came from a magic link', async () => {
    const token = await seedSession(db, admin.accountId);
    expect(await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: token })).toEqual({ kind: 'sign_in' });
  });

  it('asks a grantee to sign in again once the window has passed (open at its far end)', async () => {
    const token = await seedPasskeySession(db, admin);
    const row = await db.session.findFirstOrThrow({
      where: { accountId: admin.accountId, passkeyCredentialId: admin.credentialId },
      orderBy: { createdAt: 'desc' },
    });
    const edge = row.createdAt.getTime() + ADMIN_AUTH_WINDOW_MS;
    expect(await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: token, now: edge })).toEqual({ kind: 'sign_in' });
    expect((await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: token, now: edge - 1 })).kind).toBe('granted');
  });
});

describe('assertAdminProof', () => {
  it('accepts a proof resolveAdminAccess minted', async () => {
    const access = await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: await seedPasskeySession(db, admin) });
    if (access.kind !== 'granted') throw new Error('expected a grant');
    expect(() => assertAdminProof(access.proof)).not.toThrow();
  });

  it('refuses a cast literal and a spread copy of a real proof', async () => {
    const access = await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: await seedPasskeySession(db, admin) });
    if (access.kind !== 'granted') throw new Error('expected a grant');
    const forged = { accountId: admin.accountId, sessionId: 'x' } as unknown as AdminProof;
    expect(() => assertAdminProof(forged)).toThrow();
    expect(() => assertAdminProof({ ...access.proof })).toThrow();
  });

  it('does not typecheck a hand-built object', () => {
    // @ts-expect-error — an AdminProof is minted, never written
    const literal: AdminProof = { accountId: 'a', sessionId: 's' };
    expect(literal).toBeDefined();
  });
});
