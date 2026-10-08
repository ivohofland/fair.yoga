/**
 * @serial-tier lock-contention — holds a bank-account save's
 * `FOR NO KEY UPDATE` on a teacher while `resumePayments` waits on the same
 * row, and asserts that the resume parked, via `pg_blocking_pids`. Lock noise
 * from a neighbour in the parallel tier would stretch that wait past the
 * window the assertion allows.
 *
 * A resume reads the payout details it fingerprints under the payout
 * writers' own lock, so a save in flight finishes first and the resume sees
 * what it wrote.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';
import { payoutFingerprint } from '@/lib/payout-fingerprint';
import { bankAccountDataSelect } from '@/lib/payment-methods';
import { resumePayments, type ResumeOutcome } from './payout-resume';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();
const WAIT_MS = 1_500;
const teacherIds: string[] = [];
const accountIds: string[] = [];

afterAll(async () => {
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

async function waiterOf(holderPid: number, stop: () => boolean): Promise<number | null> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !stop()) {
    const [row] = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))
       LIMIT 1`;
    if (row !== undefined) return row.pid;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('resumePayments behind a bank-account save in flight', () => {
  it('parks on the teacher row, then refuses the details the save changed', async () => {
    const s = uniqueSuffix();
    const email = `resume-lock-${s}@test.local`;
    const now = new Date();
    const t = await prisma.teacher.create({
      data: {
        firstName: 'Resume', lastName: 'Lock', email, bio: '', pageSlug: `resume-lock-${s}`,
        account: { create: { email } },
        paymentsPausedAt: new Date(now.getTime() - 60_000), pauseWindowStart: new Date(now.getTime() - 120_000),
        bankAccounts: { create: { currency: 'EUR', holderName: 'Anna', iban: 'NL91ABNA0417164300' } },
      },
      select: { id: true, accountId: true, paymentLink: true, bankAccounts: { select: bankAccountDataSelect } },
    });
    teacherIds.push(t.id);
    accountIds.push(t.accountId);
    const sessionId = hashToken(crypto.randomBytes(32).toString('hex'));
    await prisma.session.create({ data: { id: sessionId, accountId: t.accountId, expiresAt: new Date(now.getTime() + 86_400_000) } });
    const shown = payoutFingerprint(t);

    const holder = new PrismaClient();
    const held = latch();
    const release = latch();
    let holderPid = 0;
    const holding = holder.$transaction(async (tx) => {
      holderPid = await ownPid(tx);
      await tx.$queryRaw`SELECT id FROM "Teacher" WHERE id = ${t.id} FOR NO KEY UPDATE`;
      await tx.teacherBankAccount.update({
        where: { teacherId_currency: { teacherId: t.id, currency: 'EUR' } },
        data: { iban: 'NL02ABNA0123456789' },
      });
      held.open();
      await release.promise;
    }, { timeout: 20_000 });

    let outcome: ResumeOutcome | null = null;
    let parked = false;
    try {
      await held.promise;
      let settled = false;
      const pending = resumePayments(prisma, { teacherId: t.id, sessionId, fingerprint: shown, now })
        .finally(() => { settled = true; });
      void pending.catch(() => undefined);
      parked = (await waiterOf(holderPid, () => settled)) !== null;
      release.open();
      await holding;
      outcome = await pending;
    } finally {
      release.open();
      await holding.catch(() => undefined);
      await holder.$disconnect();
    }

    expect(parked).toBe(true);
    expect(outcome).toEqual({ status: 'details_changed' });
    const state = await prisma.teacher.findUniqueOrThrow({ where: { id: t.id }, select: { paymentsPausedAt: true } });
    expect(state.paymentsPausedAt).not.toBeNull();
  }, 20_000);
});
