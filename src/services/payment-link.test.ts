import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { savePaymentLink, removePaymentLink } from './payment-link';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();
const teacherIds: string[] = [];

async function makeTeacher(paymentLink: string | null = null): Promise<string> {
  const s = uniqueSuffix();
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Link', lastName: 'Teacher', email: `pay-link-${s}@test.local`, paymentLink,
      account: { create: { email: `pay-link-${s}@test.local` } }, bio: '', pageSlug: `pay-link-${s}`,
    },
  });
  teacherIds.push(t.id);
  return t.id;
}

afterAll(async () => {
  if (teacherIds.length > 0) {
    const accounts = await prisma.teacher.findMany({ where: { id: { in: teacherIds } }, select: { accountId: true } });
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    const accountIds = accounts.map((a) => a.accountId);
    if (accountIds.length > 0) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }
  await prisma.$disconnect();
});

async function storedLink(teacherId: string): Promise<string | null> {
  const t = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId }, select: { paymentLink: true } });
  return t.paymentLink;
}

async function erase(teacherId: string): Promise<void> {
  await prisma.teacher.update({ where: { id: teacherId }, data: { deletedAt: new Date() } });
}

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

/**
 * Polls until some backend waits on a lock `holderPid` holds. No deadline of
 * its own: a call that never parks ends the test at vitest's timeout.
 */
async function waitForWaiter(holderPid: number, settled: () => boolean): Promise<boolean> {
  while (!settled()) {
    const [row] = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))
       LIMIT 1`;
    if (row !== undefined) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/**
 * Runs `call` while a second connection holds the teacher's row with an
 * uncommitted erasure, and commits that erasure once `call` is parked on it.
 */
async function raceBehindErasure<T>(teacherId: string, call: () => Promise<T>): Promise<{ result: T; parked: boolean }> {
  const holder = new PrismaClient();
  const held = latch();
  const release = latch();
  let holderPid = 0;
  const holding = holder.$transaction(async (tx: Prisma.TransactionClient) => {
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
    if (row === undefined) throw new Error('pg_backend_pid returned no row');
    holderPid = row.pid;
    await tx.$queryRaw`SELECT id FROM "Teacher" WHERE id = ${teacherId} FOR NO KEY UPDATE`;
    await tx.$executeRaw`UPDATE "Teacher" SET "deletedAt" = now() WHERE id = ${teacherId}`;
    held.open();
    await release.promise;
  }, { timeout: 20_000 });
  try {
    await Promise.race([held.promise, holding]);
    let settled = false;
    const pending = call().finally(() => { settled = true; });
    void pending.catch(() => undefined);
    const parked = await waitForWaiter(holderPid, () => settled);
    release.open();
    await holding;
    return { result: await pending, parked };
  } finally {
    release.open();
    await holding.catch(() => undefined);
    await holder.$disconnect();
  }
}

describe('savePaymentLink', () => {
  it('saves the parsed link', async () => {
    const teacherId = await makeTeacher();
    expect(await savePaymentLink(prisma, teacherId, '  https://revolut.me/anna\n')).toEqual({
      kind: 'saved', paymentLink: 'https://revolut.me/anna',
    });
    expect(await storedLink(teacherId)).toBe('https://revolut.me/anna');
  });

  it('replaces a different stored link', async () => {
    const teacherId = await makeTeacher('https://revolut.me/old');
    expect(await savePaymentLink(prisma, teacherId, 'https://revolut.me/anna')).toEqual({
      kind: 'saved', paymentLink: 'https://revolut.me/anna',
    });
    expect(await storedLink(teacherId)).toBe('https://revolut.me/anna');
  });

  it('answers unchanged when the parsed link is already stored', async () => {
    const teacherId = await makeTeacher('https://revolut.me/anna');
    expect(await savePaymentLink(prisma, teacherId, 'HTTPS://revolut.me/anna')).toEqual({
      kind: 'unchanged', paymentLink: 'https://revolut.me/anna',
    });
  });

  it('refuses a link that does not parse, and stores nothing', async () => {
    const teacherId = await makeTeacher();
    expect(await savePaymentLink(prisma, teacherId, 'http://revolut.me/anna')).toEqual({ kind: 'invalid', error: 'not_https' });
    expect(await storedLink(teacherId)).toBeNull();
  });

  it('answers teacher_gone for an erased teacher and leaves the column alone', async () => {
    const teacherId = await makeTeacher('https://revolut.me/old');
    await erase(teacherId);
    expect(await savePaymentLink(prisma, teacherId, 'https://revolut.me/anna')).toEqual({ kind: 'teacher_gone' });
    expect(await storedLink(teacherId)).toBe('https://revolut.me/old');
  });

  it('answers teacher_gone when it waited behind an erasure, and writes nothing', async () => {
    const teacherId = await makeTeacher();
    const { result, parked } = await raceBehindErasure(teacherId, () => savePaymentLink(prisma, teacherId, 'https://revolut.me/anna'));
    expect({ parked, result }).toEqual({ parked: true, result: { kind: 'teacher_gone' } });
    expect(await storedLink(teacherId)).toBeNull();
  }, 20_000);
});

describe('removePaymentLink', () => {
  it('removes a stored link', async () => {
    const teacherId = await makeTeacher('https://revolut.me/anna');
    expect(await removePaymentLink(prisma, teacherId)).toEqual({ kind: 'removed' });
    expect(await storedLink(teacherId)).toBeNull();
  });

  it('answers absent when there is no link', async () => {
    const teacherId = await makeTeacher();
    expect(await removePaymentLink(prisma, teacherId)).toEqual({ kind: 'absent' });
  });

  it('answers teacher_gone for an erased teacher and leaves the column alone', async () => {
    const teacherId = await makeTeacher('https://revolut.me/anna');
    await erase(teacherId);
    expect(await removePaymentLink(prisma, teacherId)).toEqual({ kind: 'teacher_gone' });
    expect(await storedLink(teacherId)).toBe('https://revolut.me/anna');
  });

  it('answers teacher_gone when it waited behind an erasure, and removes nothing', async () => {
    const teacherId = await makeTeacher('https://revolut.me/anna');
    const { result, parked } = await raceBehindErasure(teacherId, () => removePaymentLink(prisma, teacherId));
    expect({ parked, result }).toEqual({ parked: true, result: { kind: 'teacher_gone' } });
    expect(await storedLink(teacherId)).toBe('https://revolut.me/anna');
  }, 20_000);
});
