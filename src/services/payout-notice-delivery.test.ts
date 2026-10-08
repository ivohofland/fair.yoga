/**
 * The alert's path against a real database: a bank-account save records an
 * event, delivery reads it and mints its pause token, and the email carries
 * the raw value whose hash the token row holds. Only the sender is mocked.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';
import { uniqueSuffix } from '../../tests/helpers';

const sendPayoutChangedEmail = vi.hoisted(() => vi.fn<(to: string, input: { pauseUrl: string }) => Promise<void>>());
vi.mock('@/lib/email', () => ({ sendPayoutChangedEmail }));

const { saveBankAccount } = await import('./bank-accounts');
const { deliverPayoutChangedNotice, PAUSE_TOKEN_FOREIGN_KEYS } = await import('./payout-notice');
const { mintPayoutPauseToken, PAUSE_TOKEN_TTL_DAYS } = await import('./payout-pause-token');

const prisma = new PrismaClient();
const DAY_MS = 24 * 60 * 60 * 1000;
const teacherIds: string[] = [];
const accountIds: string[] = [];

afterAll(async () => {
  await prisma.payoutPauseToken.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.payoutChangeEvent.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

async function makeTeacher(): Promise<{ teacherId: string; email: string }> {
  const s = uniqueSuffix();
  const email = `notice-db-${s}@test.local`;
  const t = await prisma.teacher.create({
    data: { firstName: 'Notice', lastName: 'Db', email, bio: '', pageSlug: `notice-db-${s}`, account: { create: { email } } },
    select: { id: true, accountId: true },
  });
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  return { teacherId: t.id, email };
}

describe('deliverPayoutChangedNotice against the database', () => {
  it('mints one token for the saved event, stores its hash with a 14-day expiry, and emails the raw value', async () => {
    const { teacherId, email } = await makeTeacher();
    const saved = await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
    if (saved.kind !== 'saved') throw new Error(`expected saved, got ${saved.kind}`);
    const before = Date.now();

    deliverPayoutChangedNotice(prisma, saved.eventId);
    await vi.waitFor(() => expect(sendPayoutChangedEmail).toHaveBeenCalledTimes(1));

    const [to, sent] = sendPayoutChangedEmail.mock.calls[0]!;
    expect(to).toBe(email);
    const raw = sent.pauseUrl.split('#t=')[1]!;
    const tokens = await prisma.payoutPauseToken.findMany({
      where: { teacherId },
      select: { tokenHash: true, eventId: true, expiresAt: true },
    });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ tokenHash: hashToken(raw), eventId: saved.eventId });
    const ttl = tokens[0]!.expiresAt.getTime() - before;
    expect(Math.abs(ttl - PAUSE_TOKEN_TTL_DAYS * DAY_MS)).toBeLessThan(10_000);
  });

  // Ties the constraint names the delivery downgrades to what Postgres
  // reports: erasure keeps the anonymised teacher and deletes its events.
  it('reports a mint for a deleted event as a refusal by one of the token foreign keys the delivery drops quietly', async () => {
    const { teacherId } = await makeTeacher();
    const saved = await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
    if (saved.kind !== 'saved') throw new Error(`expected saved, got ${saved.kind}`);
    await prisma.payoutChangeEvent.delete({ where: { id: saved.eventId } });

    const err: unknown = await mintPayoutPauseToken(prisma, teacherId, saved.eventId).then(() => null, (e: unknown) => e);

    if (!(err instanceof Prisma.PrismaClientKnownRequestError)) throw new Error(`expected a known request error, got ${String(err)}`);
    expect(err.code).toBe('P2003');
    expect(PAUSE_TOKEN_FOREIGN_KEYS.has(String(err.meta?.constraint))).toBe(true);
  });
});
