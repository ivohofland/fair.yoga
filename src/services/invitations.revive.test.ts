import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { inviteContact, unlinkTeacher } from './invitations';

const prisma = new PrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

/**
 * The one race `revivePendingInvitation`'s `status: 'accepted'` scope exists
 * for (M3, #166 re-review).
 *
 * `inviteContact` reads the row's status, then runs `hasRosterLink` — two
 * awaited queries — and only then revives. `unlinkTeacher` can commit a
 * `declined` tombstone plus a `TeacherBlock` anywhere inside that window. An
 * unscoped `update` by id would flip the fresh tombstone back to `pending`,
 * and `PUT`/`DELETE /api/invitations/[id]` both refuse to touch a declined
 * row precisely because it is meant to be permanent — so the flip hands the
 * teacher back the delete the tombstone exists to deny.
 *
 * The re-reviewer's finding was that deleting that scope left all 54
 * integration tests green: correct guard, nothing pinning it. Nothing could,
 * through the ordinary path — the pre-checks in `inviteContact` return first
 * for `declined` and `pending`, so the only way in is a real concurrent
 * commit landing inside the window, and two HTTP requests cannot be
 * interleaved to order.
 *
 * So the interleaving is made deterministic instead of raced for: a Prisma
 * client extension hooks the first query of `hasRosterLink` and runs the
 * REAL `unlinkTeacher` there, once. Nothing about `inviteContact` is stubbed
 * — it takes the same code path with the same client, and the only thing the
 * extension changes is *when* the concurrent commit lands. The alternative
 * (hand-writing a declined row and calling the private helper) would prove
 * the `where` clause matches what it says and nothing about the caller.
 */
describe('inviteContact — a revive that loses its race with unlinkTeacher', () => {
  let teacherId: string;
  let teacherAccountId: string;
  let studentId: string;
  let studentAccountId: string;
  let invitationId: string;
  const email = `revive-race-${suffix}@test.local`;
  // The acceptance this fixture is standing on, distinctive so the tombstone
  // assertions cannot pass against a `new Date()` written by the revive.
  const ACCEPTED_AT = new Date('2026-04-05T06:07:08.000Z');

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Revive', lastName: 'Race',
        email: `revive-race-teacher-${suffix}@test.local`,
        account: { create: { email: `revive-race-teacher-${suffix}@test.local` } },
        bio: 'M3 revive-race fixture',
        pageSlug: `revive-race-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    // Linked and accepted: exactly the state `unlinkTeacher` is written to
    // move away from, and the state `inviteContact` reads as "revivable" the
    // instant the link goes.
    const student = await prisma.student.create({
      data: {
        firstName: 'Revive', lastName: 'Race', email, incomeTier: 3,
        claimedAt: new Date(), account: { create: { email } },
        teacherStudents: { create: { teacherId } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId as string;

    const invitation = await prisma.invitation.create({
      data: {
        teacherId, email, firstName: 'Revive', lastName: 'Race',
        status: 'accepted', respondedAt: ACCEPTED_AT,
      },
      select: { id: true },
    });
    invitationId = invitation.id;
  });

  afterAll(async () => {
    await prisma.studentPrivacy.deleteMany({ where: { studentId } });
    await prisma.teacherStudent.deleteMany({ where: { studentId } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    // Invitation and TeacherBlock cascade off Teacher.
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: { id: { in: [teacherAccountId, studentAccountId] } },
    });
    await prisma.$disconnect();
  });

  it('answers CONTACT_CHANGED and leaves the fresh tombstone standing', async () => {
    let unlinked = false;
    const racing = prisma.$extends({
      query: {
        student: {
          // `hasRosterLink`'s first query: after the status read, before the
          // revive. Hooked here rather than on `teacherStudent.findUnique`
          // because that second query only runs when a Student row exists,
          // and this window has to close whether or not one does.
          async findFirst({ args, query }) {
            if (!unlinked) {
              unlinked = true;
              const res = await unlinkTeacher(prisma, {
                teacherId, studentId, accountEmail: email,
              });
              if (!res.ok) throw new Error(`fixture unlink failed: ${res.reason}`);
            }
            return query(args);
          },
        },
      },
    });

    // `$extends` returns a client missing `$on` and the other four methods a
    // transaction cannot use, so it is not assignable to `PrismaClient` even
    // though every method `inviteContact` touches is present and real. Same
    // cast the fake-client tests in `class-lifecycle.test.ts` and
    // `class-generator.test.ts` use, and with more behind it: this object is
    // the real client with one query wrapped, not a stub.
    const result = await inviteContact(racing as unknown as PrismaClient, {
      teacherId, email, firstName: 'Second', lastName: 'Attempt',
    });

    if (result.ok) throw new Error('expected the revive to lose the race');
    // Not `DECLINED`. The student did decline — but not in answer to THIS
    // invitation, and the teacher cannot tell the two apart from the message.
    // A retry now meets the real tombstone and says so honestly.
    expect(result.reason).toBe('CONTACT_CHANGED');

    // The tombstone the unlink wrote is intact: an unscoped update would have
    // returned it to `pending` with a null `respondedAt`, which is the state
    // `DELETE /api/invitations/[id]` will act on and a declined row is not.
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(row.status).toBe('declined');
    expect(row.respondedAt).not.toEqual(ACCEPTED_AT);
    expect(row.firstName).toBe('Revive');

    // And the block underneath it, which is the part that actually holds.
    expect(
      await prisma.teacherBlock.findUnique({ where: { teacherId_email: { teacherId, email } } }),
    ).not.toBeNull();
  });

  it('the retry meets the tombstone and says so', async () => {
    // The claim the refusal above makes to the teacher — "reload and try
    // again" — has to be true, or it is the same lie in a friendlier voice.
    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Third', lastName: 'Attempt',
    });
    if (result.ok) throw new Error('expected the retry to meet the tombstone');
    expect(result.reason).toBe('DECLINED');
  });
});
