/**
 * @serial-tier lock-contention — its insert-race test holds a transaction open
 * on an external release signal, for 200ms+, while a concurrent
 * `linkTeacherStudent` contends for the same uncommitted
 * `(teacherId, studentId)` tuple; its vanished-link test holds the link row's
 * lock while a linker queues behind it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import {
  linkTeacherStudent,
  activateTeacherStudentLink,
  lockTeacherStudentLink,
  RosterLinkVanishedError,
  type LinkOutcome,
} from './roster-link';

const prisma = new PrismaClient();
/** Holds the link row's lock while `prisma` runs the linker and observes. */
const holder = new PrismaClient();

/**
 * The brand's compile-time pin, one directive per function, in the pattern
 * `db-locks.test.ts`'s `_theBrandRejectsABareClient` sets out: each takes the
 * link row's `FOR UPDATE`, which a bare client would release at once.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _rosterLinkRejectsABareClient(client: PrismaClient): Promise<void> {
  const pair = { teacherId: 'never-called', studentId: 'never-called' };
  // @ts-expect-error `FOR UPDATE` on the link row, released at once off a bare client.
  await lockTeacherStudentLink(client, pair);
  // @ts-expect-error Takes that lock, then clears `isArchived` under it.
  await activateTeacherStudentLink(client, pair);
  // @ts-expect-error Its insert, then the lock above.
  await linkTeacherStudent(client, pair);
}

const teacherIds: string[] = [];
const studentIds: string[] = [];
const accountIds: string[] = [];

afterAll(async () => {
  if (teacherIds.length) {
    await prisma.teacherStudent.deleteMany({ where: { teacherId: { in: teacherIds } } });
  }
  if (studentIds.length) {
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  }
  if (teacherIds.length) {
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  }
  if (accountIds.length) {
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }
  await prisma.$disconnect();
  await holder.$disconnect();
});

async function makeUnlinkedPair() {
  const local = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacherEmail = `roster-link-teacher-${local}@test.local`;
  const studentEmail = `roster-link-student-${local}@test.local`;

  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Roster', lastName: 'Link',
      email: teacherEmail,
      account: { create: { email: teacherEmail } },
      bio: '#181 roster-link fixture teacher',
      pageSlug: `roster-link-${local}`,
    },
    select: { id: true, accountId: true },
  });
  teacherIds.push(teacher.id);
  accountIds.push(teacher.accountId);

  const student = await prisma.student.create({
    data: {
      firstName: 'Roster', lastName: 'Link',
      email: studentEmail, claimedAt: new Date(),
      account: { create: { email: studentEmail } },
    },
    select: { id: true, accountId: true },
  });
  studentIds.push(student.id);
  accountIds.push(student.accountId as string);

  return { teacherId: teacher.id, studentId: student.id };
}

/** An existing link row, seeded directly at the given `isArchived` value. */
async function makeLinkedPair(isArchived: boolean) {
  const pair = await makeUnlinkedPair();
  await prisma.teacherStudent.create({ data: { ...pair, isArchived } });
  return pair;
}

describe('linkTeacherStudent', () => {
  it('creates the link when there is none', async () => {
    const { teacherId, studentId } = await makeUnlinkedPair();

    const outcome = await prisma.$transaction((tx) => linkTeacherStudent(tx, { teacherId, studentId }));

    expect(outcome).toBe('created');
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId } },
    });
    expect(link).not.toBeNull();
  });

  it('is a no-op when the link already exists, and does not disturb it', async () => {
    const { teacherId, studentId } = await makeUnlinkedPair();
    await prisma.$transaction((tx) => linkTeacherStudent(tx, { teacherId, studentId }));
    const first = await prisma.teacherStudent.findUniqueOrThrow({
      where: { teacherId_studentId: { teacherId, studentId } },
    });

    const outcome = await prisma.$transaction((tx) => linkTeacherStudent(tx, { teacherId, studentId }));

    expect(outcome).toBe('already-linked');
    const second = await prisma.teacherStudent.findUniqueOrThrow({
      where: { teacherId_studentId: { teacherId, studentId } },
    });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toEqual(first.createdAt);
  });

  it('un-archives an existing archived link, and still reports it as already-linked', async () => {
    const { teacherId, studentId } = await makeLinkedPair(true);

    const outcome = await prisma.$transaction((tx) => linkTeacherStudent(tx, { teacherId, studentId }));

    expect(outcome).toBe('already-linked');
    const link = await prisma.teacherStudent.findUniqueOrThrow({
      where: { teacherId_studentId: { teacherId, studentId } },
    });
    expect(link.isArchived).toBe(false);
  });

  /**
   * The defect itself, at the helper's own level. A writer that loses the
   * `INSERT` race must return, not throw — an `upsert({ update: {} })` here
   * raises `P2002` on `["teacherId","studentId"]`, which `classifyApiError`
   * turns into a 409 telling the caller that the link they asked for already
   * exists (#181).
   *
   * The holder's transaction stays open until after the second writer has
   * issued its statement, so the second writer genuinely waits on an
   * uncommitted tuple rather than seeing a committed one.
   *
   * BOTH answers are captured, not just the loser's. `LinkOutcome` is what
   * `resolveInvitationOnLink` decides a `pending` invitation on (#418), so an
   * implementation that handed `'already-linked'` to the winner as well would
   * be wrong in the direction that matters — the inserting act would resolve
   * nothing — and a test reading only the loser's answer would pass.
   */
  it('returns rather than throwing when a concurrent writer wins the insert race', async () => {
    const { teacherId, studentId } = await makeUnlinkedPair();

    let holderInserted!: () => void;
    const inserted = new Promise<void>((r) => { holderInserted = r; });
    let releaseHolder!: () => void;
    const released = new Promise<void>((r) => { releaseHolder = r; });

    let holderOutcome: LinkOutcome | undefined;
    const holder = prisma.$transaction(async (tx) => {
      holderOutcome = await linkTeacherStudent(tx, { teacherId, studentId });
      holderInserted();
      await released;
    }, { timeout: 15_000 });

    await inserted;
    const loser = prisma.$transaction((tx) => linkTeacherStudent(tx, { teacherId, studentId }));
    await new Promise((r) => setTimeout(r, 200));
    releaseHolder();

    await expect(loser).resolves.toBe('already-linked');
    await holder;
    expect(holderOutcome).toBe('created');

    const links = await prisma.teacherStudent.findMany({ where: { teacherId, studentId } });
    expect(links).toHaveLength(1);
  }, 30_000);

  /**
   * The link is deleted between the linker's insert and its row lock. A
   * holder takes the row's `FOR UPDATE` first: the linker's `INSERT … ON
   * CONFLICT DO NOTHING` meets a committed row whose lock is only a lock, so
   * it passes without waiting, and the linker parks on its own `FOR UPDATE`.
   * The holder then deletes the row and commits, which leaves the lock
   * returning nothing. The caller's earlier write in the same transaction
   * must roll back with it.
   */
  it('throws RosterLinkVanishedError, rolling the caller back, when the link is deleted before its lock', async () => {
    const { teacherId, studentId } = await makeLinkedPair(false);
    const WAIT_MS = 1_500;

    let holderPid = 0;
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const holding = holder.$transaction(async (tx) => {
      const [own] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
      if (own === undefined) throw new Error('pg_backend_pid returned no row');
      holderPid = own.pid;
      if ((await lockTeacherStudentLink(tx, { teacherId, studentId })) === null) {
        throw new Error('fixture link missing');
      }
      locked();
      await released;
      await tx.teacherStudent.delete({ where: { teacherId_studentId: { teacherId, studentId } } });
    }, { timeout: 10_000 });
    await isLocked;

    const linking = prisma.$transaction(async (tx) => {
      await tx.student.update({ where: { id: studentId }, data: { firstName: 'Written' } });
      return linkTeacherStudent(tx, { teacherId, studentId });
    }, { timeout: 10_000 });
    const linked = linking.then(
      (value) => ({ kind: 'resolved' as const, value }),
      (err: unknown) => ({ kind: 'rejected' as const, err }),
    );

    let waited = false;
    try {
      const deadline = Date.now() + WAIT_MS;
      while (!waited && Date.now() < deadline) {
        const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock'
             AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
        waited = (row?.n ?? 0) > 0;
        if (!waited) await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      release();
      await holding;
    }

    const result = await linked;
    const student = await prisma.student.findUniqueOrThrow({ where: { id: studentId }, select: { firstName: true } });
    expect({
      waited,
      threw: result.kind === 'rejected' && result.err instanceof RosterLinkVanishedError,
      firstName: student.firstName,
      links: await prisma.teacherStudent.count({ where: { teacherId, studentId } }),
    }).toEqual({ waited: true, threw: true, firstName: 'Roster', links: 0 });
  }, 30_000);
});

describe('activateTeacherStudentLink', () => {
  it('reactivates an archived link and reports it', async () => {
    const { teacherId, studentId } = await makeLinkedPair(true);

    const result = await prisma.$transaction((tx) => activateTeacherStudentLink(tx, { teacherId, studentId }));

    expect(result).toBe('reactivated');
    const link = await prisma.teacherStudent.findUniqueOrThrow({
      where: { teacherId_studentId: { teacherId, studentId } },
    });
    expect(link.isArchived).toBe(false);
  });

  it('leaves an active link alone and reports it', async () => {
    const { teacherId, studentId } = await makeLinkedPair(false);
    const before = await prisma.teacherStudent.findUniqueOrThrow({
      where: { teacherId_studentId: { teacherId, studentId } },
    });

    const result = await prisma.$transaction((tx) => activateTeacherStudentLink(tx, { teacherId, studentId }));

    expect(result).toBe('active');
    const after = await prisma.teacherStudent.findUniqueOrThrow({
      where: { teacherId_studentId: { teacherId, studentId } },
    });
    expect(after.isArchived).toBe(false);
    expect(after.createdAt).toEqual(before.createdAt);
  });

  it('reports a missing pair and creates no row', async () => {
    const { teacherId, studentId } = await makeUnlinkedPair();

    const result = await prisma.$transaction((tx) => activateTeacherStudentLink(tx, { teacherId, studentId }));

    expect(result).toBe('missing');
    const count = await prisma.teacherStudent.count({ where: { teacherId, studentId } });
    expect(count).toBe(0);
  });
});

describe('lockTeacherStudentLink', () => {
  it('returns the row for an existing pair, and never changes isArchived', async () => {
    const { teacherId, studentId } = await makeLinkedPair(true);

    const locked = await prisma.$transaction((tx) => lockTeacherStudentLink(tx, { teacherId, studentId }));

    expect(locked).not.toBeNull();
    expect(locked!.isArchived).toBe(true);
    const after = await prisma.teacherStudent.findUniqueOrThrow({
      where: { teacherId_studentId: { teacherId, studentId } },
    });
    expect(after.isArchived).toBe(true);
  });

  it('returns null for a pair with no row', async () => {
    const { teacherId, studentId } = await makeUnlinkedPair();

    const locked = await prisma.$transaction((tx) => lockTeacherStudentLink(tx, { teacherId, studentId }));

    expect(locked).toBeNull();
  });
});
