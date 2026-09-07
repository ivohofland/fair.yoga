/**
 * @serial-tier lock-contention — its insert-race test holds a transaction open
 * on an external release signal, for 200ms+, while a concurrent
 * `linkTeacherStudent` contends for the same uncommitted
 * `(teacherId, studentId)` tuple.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { linkTeacherStudent, type LinkOutcome } from './roster-link';

const prisma = new PrismaClient();

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

describe('linkTeacherStudent', () => {
  it('creates the link when there is none', async () => {
    const { teacherId, studentId } = await makeUnlinkedPair();

    const outcome = await linkTeacherStudent(prisma, { teacherId, studentId });

    expect(outcome).toBe('created');
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId } },
    });
    expect(link).not.toBeNull();
  });

  it('is a no-op when the link already exists, and does not disturb it', async () => {
    const { teacherId, studentId } = await makeUnlinkedPair();
    await linkTeacherStudent(prisma, { teacherId, studentId });
    const first = await prisma.teacherStudent.findUniqueOrThrow({
      where: { teacherId_studentId: { teacherId, studentId } },
    });

    const outcome = await linkTeacherStudent(prisma, { teacherId, studentId });

    expect(outcome).toBe('already-linked');
    const second = await prisma.teacherStudent.findUniqueOrThrow({
      where: { teacherId_studentId: { teacherId, studentId } },
    });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toEqual(first.createdAt);
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
    const loser = linkTeacherStudent(prisma, { teacherId, studentId });
    await new Promise((r) => setTimeout(r, 200));
    releaseHolder();

    await expect(loser).resolves.toBe('already-linked');
    await holder;
    expect(holderOutcome).toBe('created');

    const links = await prisma.teacherStudent.findMany({ where: { teacherId, studentId } });
    expect(links).toHaveLength(1);
  }, 30_000);
});
