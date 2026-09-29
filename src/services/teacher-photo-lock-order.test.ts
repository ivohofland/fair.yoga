/**
 * @serial-tier lock-contention — stages a photo upload against a teacher
 * erasure on real Postgres row locks, holding the `Teacher` row either inside
 * the upload's own transaction or on a second connection, and asserts the
 * other side parked behind it via `pg_blocking_pids`; lock noise from a
 * neighbour in the parallel tier would stretch that wait past the shared
 * `lock_timeout` both sides run under.
 *
 * The order these tests pin is `docs/lock-order.md`'s "The `Teacher` row is
 * the photo upload's gate (#46)".
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import * as dbLocks from '@/lib/db-locks';
import { deleteTeacherAccount } from './gdpr';
import { saveTeacherPhoto } from './teacher-photo';
import { uniqueSuffix } from '../../tests/helpers';
import { expectErased } from '../../tests/erasure-assertions';

const prisma = new PrismaClient();
const teacherIds: string[] = [];

const WAIT_MS = 1_500;

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

async function makeTeacher(): Promise<string> {
  const s = uniqueSuffix();
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Photo', lastName: 'Race', email: `photo-race-${s}@test.local`,
      account: { create: { email: `photo-race-${s}@test.local` } }, bio: '', pageSlug: `photo-race-${s}`,
    },
    select: { id: true },
  });
  teacherIds.push(t.id);
  return t.id;
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (teacherIds.length > 0) {
    const accounts = await prisma.teacher.findMany({ where: { id: { in: teacherIds } }, select: { accountId: true } });
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } }); // cascades TeacherPhoto
    await prisma.account.deleteMany({ where: { id: { in: accounts.map((a) => a.accountId) } } });
  }
  await prisma.$disconnect();
});

describe('a photo upload and a teacher erasure serialise on the Teacher row (#46)', () => {
  it('an erasure that waits behind an upload still deletes what the upload wrote', async () => {
    const teacherId = await makeTeacher();
    const reached = latch(); const release = latch();
    let uploadPid = 0;
    const original = dbLocks.lockLiveTeacher;
    vi.spyOn(dbLocks, 'lockLiveTeacher').mockImplementation(async (tx, id) => {
      const live = await original(tx, id);
      uploadPid = await ownPid(tx);
      reached.open();
      await release.promise;
      return live;
    });

    const upload = saveTeacherPhoto(prisma, teacherId, Buffer.from('racing'));
    try {
      await reached.promise;
      let erasureSettled = false;
      const erasure = deleteTeacherAccount(prisma, teacherId).finally(() => { erasureSettled = true; });
      void erasure.catch(() => undefined);

      const waiter = await waiterOf(uploadPid, () => erasureSettled);
      expect(waiter).not.toBeNull(); // erasure is parked on the upload's FOR SHARE
      release.open();

      expect(await upload).toMatchObject({ saved: true });
      await expectErased(erasure);
      expect(await prisma.teacherPhoto.count({ where: { teacherId } })).toBe(0);
    } finally {
      release.open();
      await upload.catch(() => undefined);
    }
  }, 20_000);

  it('an upload that waits behind an erasure is refused and writes nothing', async () => {
    const teacherId = await makeTeacher();
    const holder = new PrismaClient();
    const held = latch(); const release = latch();
    let holderPid = 0;
    const holding = holder.$transaction(async (tx) => {
      holderPid = await ownPid(tx);
      await tx.$executeRaw`UPDATE "Teacher" SET "deletedAt" = now() WHERE id = ${teacherId}`;
      held.open();
      await release.promise;
    }, { timeout: 20_000 });
    try {
      await Promise.race([held.promise, holding]);
      let settled = false;
      const upload = saveTeacherPhoto(prisma, teacherId, Buffer.from('late')).finally(() => { settled = true; });
      void upload.catch(() => undefined);
      expect(await waiterOf(holderPid, () => settled)).not.toBeNull(); // parked on the uncommitted erasure
      release.open();
      await holding;
      expect(await upload).toEqual({ saved: false, reason: 'teacher-gone' });
      expect(await prisma.teacherPhoto.count({ where: { teacherId } })).toBe(0);
    } finally {
      release.open();
      await holding.catch(() => undefined);
      await holder.$disconnect();
    }
  }, 20_000);
});
