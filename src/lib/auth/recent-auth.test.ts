import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { hasRecentAuth, RECENT_AUTH_WINDOW_MS } from './recent-auth';
import { seedSession, uniqueSuffix } from '../../../tests/helpers';
import { hashToken } from './magic-link';

const db = new PrismaClient();
const suffix = uniqueSuffix();
let accountId: string;

beforeAll(async () => {
  const account = await db.account.create({ data: { email: `recent-auth-${suffix}@test.local` } });
  accountId = account.id;
});

afterAll(async () => {
  await db.session.deleteMany({ where: { accountId } });
  await db.account.deleteMany({ where: { id: accountId } });
  await db.$disconnect();
});

async function sessionAged(ageMs: number): Promise<string> {
  const token = await seedSession(db, accountId);
  const id = hashToken(token);
  await db.session.update({ where: { id }, data: { createdAt: new Date(Date.now() - ageMs) } });
  return id;
}

describe('hasRecentAuth', () => {
  it('accepts a session created just now', async () => {
    expect(await hasRecentAuth(db, await sessionAged(0))).toBe(true);
  });

  it('accepts a session one second inside the window', async () => {
    expect(await hasRecentAuth(db, await sessionAged(RECENT_AUTH_WINDOW_MS - 1000))).toBe(true);
  });

  it('refuses a session one second past the window', async () => {
    expect(await hasRecentAuth(db, await sessionAged(RECENT_AUTH_WINDOW_MS + 1000))).toBe(false);
  });

  it('measures from createdAt, not from a slid expiry', async () => {
    const id = await sessionAged(RECENT_AUTH_WINDOW_MS + 60_000);
    await db.session.update({ where: { id }, data: { expiresAt: new Date(Date.now() + 30 * 86_400_000) } });
    expect(await hasRecentAuth(db, id)).toBe(false);
  });

  it('refuses a session id that names no row', async () => {
    expect(await hasRecentAuth(db, 'no-such-session')).toBe(false);
  });
});
