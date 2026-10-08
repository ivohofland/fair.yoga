/**
 * @serial-tier lock-contention — holds a pause's `FOR NO KEY UPDATE` on a
 * teacher while `deletePasskey` waits on the same row, and asserts that the
 * removal parked, via `pg_blocking_pids`. Lock noise from a neighbour in the
 * parallel tier would stretch that wait past the window the assertion allows.
 *
 * A removal reads the pause state under the teacher row's lock, taken before
 * it touches a passkey or a session, so a pause committing under it is seen
 * and refuses the removal.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { deletePasskey, type DeletePasskeyOutcome } from './passkey-credentials';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();
const WAIT_MS = 1_500;
const teacherIds: string[] = [];
const accountIds: string[] = [];

afterAll(async () => {
  await prisma.removedPasskey.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
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

describe('deletePasskey behind a pause in flight', () => {
  it('parks on the teacher row, then refuses because the pause committed', async () => {
    const s = uniqueSuffix();
    const email = `pk-lock-${s}@test.local`;
    const t = await prisma.teacher.create({
      data: {
        firstName: 'Pk', lastName: 'Lock', email, bio: '', pageSlug: `pk-lock-${s}`,
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    teacherIds.push(t.id);
    accountIds.push(t.accountId);
    const credentialId = `pk-lock-${s}`;
    await prisma.passkeyCredential.create({
      data: { id: credentialId, accountId: t.accountId, publicKey: Buffer.from('k'), counter: 0, transports: [] },
    });

    const holder = new PrismaClient();
    const held = latch();
    const release = latch();
    let holderPid = 0;
    const holding = holder.$transaction(async (tx) => {
      holderPid = await ownPid(tx);
      await tx.$queryRaw`SELECT id FROM "Teacher" WHERE id = ${t.id} FOR NO KEY UPDATE`;
      await tx.teacher.update({ where: { id: t.id }, data: { paymentsPausedAt: new Date() } });
      held.open();
      await release.promise;
    }, { timeout: 20_000 });

    let outcome: DeletePasskeyOutcome | null = null;
    let parked = false;
    try {
      await held.promise;
      let settled = false;
      const pending = deletePasskey(prisma, { accountId: t.accountId, credentialId })
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
    expect(outcome).toEqual({ status: 'payments_paused' });
    expect(await prisma.passkeyCredential.count({ where: { id: credentialId } })).toBe(1);
    expect(await prisma.removedPasskey.count({ where: { accountId: t.accountId } })).toBe(0);
  }, 20_000);
});
