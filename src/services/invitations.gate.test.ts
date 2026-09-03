import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { inviteContact } from './invitations';

const prisma = new PrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

/**
 * #412. `ALREADY_LINKED` is a distinct, teacher-visible outcome, so answering
 * it on the strength of the link alone confirmed that a typed address belongs
 * to one of this teacher's students — a fact `projectStudentForTeacher`
 * (lib/student-visibility.ts) returns as `null` everywhere else once the
 * student has withheld it (unless the student is unclaimed).
 *
 * A hit costs nothing and leaves nothing: `inviteContact` returns before any
 * write, and the route answers 409 before both the `lastNotifiedAt` write and
 * `deliverInvitation`. That is why the targeted case — testing one guessed
 * address against one suspected student — is the one worth closing, and it is
 * what these tests are written against.
 */
describe('inviteContact — the shareEmail gate on ALREADY_LINKED (#412)', () => {
  let teacherId: string;
  let teacherAccountId: string;
  let otherTeacherId: string;
  let otherTeacherAccountId: string;
  const studentIds: string[] = [];

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Gate', lastName: 'Teacher',
        email: `gate-teacher-${suffix}@test.local`,
        account: { create: { email: `gate-teacher-${suffix}@test.local` } },
        bio: '#412 shareEmail gate fixture',
        pageSlug: `gate-teacher-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    // A second teacher, used below to prove `rosterLinkState`'s
    // `teacherStudents` read is scoped to `teacherId` — "linked to SOME
    // teacher" must not read as "linked to THIS teacher".
    const other = await prisma.teacher.create({
      data: {
        firstName: 'Gate', lastName: 'OtherTeacher',
        email: `gate-other-teacher-${suffix}@test.local`,
        account: { create: { email: `gate-other-teacher-${suffix}@test.local` } },
        bio: '#412 shareEmail gate fixture — cross-teacher scoping',
        pageSlug: `gate-other-teacher-${suffix}`,
      },
    });
    otherTeacherId = other.id;
    otherTeacherAccountId = other.accountId;
  });

  afterAll(async () => {
    if (studentIds.length) {
      await prisma.teacherStudent.deleteMany({ where: { studentId: { in: studentIds } } });
      await prisma.studentPrivacy.deleteMany({ where: { studentId: { in: studentIds } } });
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    }
    if (teacherId) {
      await prisma.invitation.deleteMany({ where: { teacherId } });
      await prisma.teacherBlock.deleteMany({ where: { teacherId } });
      await prisma.teacher.delete({ where: { id: teacherId } });
      await prisma.account.delete({ where: { id: teacherAccountId } });
    }
    if (otherTeacherId) {
      await prisma.invitation.deleteMany({ where: { teacherId: otherTeacherId } });
      await prisma.teacherBlock.deleteMany({ where: { teacherId: otherTeacherId } });
      await prisma.teacher.delete({ where: { id: otherTeacherId } });
      await prisma.account.delete({ where: { id: otherTeacherAccountId } });
    }
    await prisma.$disconnect();
  });

  /** A student on this teacher's roster, with the privacy row this test wants. */
  async function seedLinked(
    label: string,
    privacy: { shareEmail: boolean } | null,
    opts: { linked?: boolean } = {},
  ): Promise<string> {
    const email = `gate-${label}-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Gate', lastName: label, email,
        claimedAt: new Date(),
        account: { create: { email } },
        ...(opts.linked === false ? {} : { teacherStudents: { create: { teacherId } } }),
        ...(privacy ? { studentPrivacy: { create: { teacherId, ...privacy } } } : {}),
      },
      select: { id: true },
    });
    studentIds.push(student.id);
    return email;
  }

  it('does not answer ALREADY_LINKED when the student has not shared their email', async () => {
    const email = await seedLinked('unshared', null);

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Already', lastName: 'Mine',
    });

    // The whole point: an ordinary, indistinguishable success. The row must
    // genuinely be created — "did a new contact appear in my list?" is itself
    // a yes/no channel carrying the bit being withheld.
    if (!result.ok) throw new Error(`expected a fall-through invite, got ${result.reason}`);
    expect(result.value.delivered).toBe(false);
    const row = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email } },
      select: { status: true },
    });
    expect(row.status).toBe('pending');
  });

  it('treats an explicit shareEmail: false exactly as a missing privacy row', async () => {
    const email = await seedLinked('explicit-false', { shareEmail: false });

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Already', lastName: 'Mine',
    });

    expect(result.ok).toBe(true);
  });

  it('answers ALREADY_LINKED when the student HAS shared their email with this teacher', async () => {
    const email = await seedLinked('shared', { shareEmail: true });

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Already', lastName: 'Mine',
    });

    expect(result).toEqual({ ok: false, reason: 'ALREADY_LINKED' });
    // A refusal, not a refusal-shaped success.
    expect(
      await prisma.invitation.findUnique({ where: { teacherId_email: { teacherId, email } } }),
    ).toBeNull();
  });

  it('answers ALREADY_LINKED when the student is unclaimed, bypassing shareEmail', async () => {
    const email = `gate-unclaimed-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Gate', lastName: 'Unclaimed', email,
        // no Account means claimedAt is null
        teacherStudents: { create: { teacherId } },
        studentPrivacy: { create: { teacherId, shareEmail: false } },
      },
      select: { id: true },
    });
    studentIds.push(student.id);

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Already', lastName: 'Mine',
    });

    expect(result).toEqual({ ok: false, reason: 'ALREADY_LINKED' });
    expect(
      await prisma.invitation.findUnique({ where: { teacherId_email: { teacherId, email } } }),
    ).toBeNull();
  });

  it('does not answer ALREADY_LINKED for a shared address that is NOT on the roster', async () => {
    // Pins the `linked &&` conjunct. Without it, `shareEmail: true` alone
    // would refuse an invitation to someone this teacher has never had.
    const email = await seedLinked('shared-unlinked', { shareEmail: true }, { linked: false });

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Not', lastName: 'Mine',
    });

    expect(result.ok).toBe(true);
  });

  it('does not treat a student linked to a DIFFERENT teacher as linked to this one', async () => {
    // Two independent reviewers each manually deleted `where: { teacherId }`
    // from `rosterLinkState`'s `teacherStudents` select and found the entire
    // unit suite still green — this teacher-scoping was completely
    // untested. "Linked to SOME teacher" is not the same fact as "linked to
    // THIS teacher"; conflating them would make `linked` read true for any
    // teacher who happens to query an address already on a peer's roster,
    // reopening the exact account-enumeration oracle #166 closed (and #412
    // sharpened) via `ALREADY_LINKED`.
    const email = `gate-other-teacher-student-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Gate', lastName: 'OtherTeacherStudent', email,
        teacherStudents: { create: { teacherId: otherTeacherId } },
      },
      select: { id: true },
    });
    studentIds.push(student.id);

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Not', lastName: 'Mine',
    });

    // Also closes an already-known, separately-flagged gap: no
    // unit-runnable test previously pinned `delivered === true` on the
    // ordinary (unblocked, unlinked-to-THIS-teacher) success path.
    if (!result.ok) throw new Error(`expected an ordinary delivered invite, got ${result.reason}`);
    expect(result.value.delivered).toBe(true);
  });

  it('answers ALREADY_LINKED on an accepted invitation, and leaves that row untouched', async () => {
    // The second disjunct. It exists to keep the gated path out of
    // `revivePendingInvitation`, which would flip this row to `pending`
    // (rendering it as an outstanding "Invited" contact for someone already
    // in the directory), clear `isArchived`, and overwrite the names.
    const email = await seedLinked('accepted', null);
    const acceptedAt = new Date('2026-01-02T03:04:05.000Z');
    await prisma.invitation.create({
      data: {
        teacherId, email, firstName: 'Original', lastName: 'Name',
        status: 'accepted', respondedAt: acceptedAt, isArchived: true,
      },
    });

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Rewritten', lastName: 'Name',
    });

    expect(result).toEqual({ ok: false, reason: 'ALREADY_LINKED' });
    const row = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email } },
      select: {
        status: true, respondedAt: true, isArchived: true,
        firstName: true, lastName: true,
      },
    });
    expect(row).toEqual({
      status: 'accepted',
      respondedAt: acceptedAt,
      isArchived: true,
      firstName: 'Original',
      lastName: 'Name',
    });
  });
});
