import { describe, it, expect, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import {
  inviteContact,
  declineInvitation,
  acceptInvitation,
  unlinkTeacher,
  listDeclinedTeachers,
} from './invitations';
import { deleteStudentAccount } from './gdpr';
import { resolveInvitationOnLink } from './link-consent';

// `invitations.ts` imports `@/lib/log`, so the specifier here must match
// that one — the same constraint `invitations.gate.test.ts` documents for
// its own mock.
vi.mock('@/lib/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const prisma = new PrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

describe('a decline writes a suppression entry that survives erasure (#522)', () => {
  // Every case below builds its own teacher/student pair via
  // `makeTeacherAndInvitee` rather than sharing one across the `describe`
  // (unlike `invitations.gate.test.ts`'s single `beforeAll` teacher), so
  // cleanup collects ids across every call instead of populating them once.
  const teacherIds: string[] = [];
  const teacherAccountIds: string[] = [];
  const studentIds: string[] = [];

  afterAll(async () => {
    // Every step runs whatever an earlier one throws, and the errors are
    // rethrown together at the end. The steps stay ordered (FKs), but a
    // single failing statement must not skip the ones after it or the
    // `$disconnect`: this suite writes into a database every other suite
    // shares, so a skipped cleanup leaks fixture rows into their queries
    // rather than only failing this file.
    const errors: unknown[] = [];
    const step = async (run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
      } catch (err) {
        errors.push(err);
      }
    };

    await step(async () => {
      if (!studentIds.length) return;
      // `Student.accountId` is the FK and there is no cascade, so the
      // account ids are read back here rather than carried from creation —
      // `makeTeacherAndInvitee` has no other use for them.
      const accounts = await prisma.student.findMany({
        where: { id: { in: studentIds } },
        select: { accountId: true },
      });
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
      const studentAccountIds = accounts
        .map((s) => s.accountId)
        .filter((id): id is string => id !== null);
      if (studentAccountIds.length) {
        await prisma.account.deleteMany({ where: { id: { in: studentAccountIds } } });
      }
    });
    await step(async () => {
      if (!teacherIds.length) return;
      // `Invitation` and `TeacherBlock` both cascade on `Teacher` delete
      // (`onDelete: Cascade`); deleted explicitly first anyway, the same
      // belt-and-suspenders style `invitations.gate.test.ts` uses.
      await prisma.invitation.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacherBlock.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    });
    await step(async () => {
      if (!teacherAccountIds.length) return;
      await prisma.account.deleteMany({ where: { id: { in: teacherAccountIds } } });
    });
    await step(() => prisma.$disconnect());

    if (errors.length) throw new AggregateError(errors, 'decline-suite teardown failed');
  });

  async function makeTeacherAndInvitee() {
    const email = `decliner-${suffix}-${crypto.randomBytes(3).toString('hex')}@example.com`;
    const teacherEmail = `teacher-${suffix}-${crypto.randomBytes(3).toString('hex')}@example.com`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Tess',
        lastName: 'Teacher',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: '#522 decline-suppression fixture',
        pageSlug: `tess-${suffix}-${crypto.randomBytes(3).toString('hex')}`,
      },
    });
    teacherIds.push(teacher.id);
    teacherAccountIds.push(teacher.accountId);
    const student = await prisma.student.create({
      data: {
        firstName: 'Sam',
        lastName: 'Student',
        email,
        claimedAt: new Date(),
        account: { create: { email } },
      },
      select: { id: true },
    });
    studentIds.push(student.id);
    return { teacher, student, email };
  }

  async function invite(teacherId: string, email: string) {
    const result = await inviteContact(prisma, {
      teacherId,
      email,
      firstName: 'Sam',
      lastName: 'Student',
    });
    if (!result.ok) throw new Error(`invite refused: ${result.reason}`);
    return result.value;
  }

  it('refuses delivery when a declined invitee erases and is re-invited at their real address', async () => {
    const { teacher, student, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);

    const declined = await declineInvitation(prisma, {
      invitationId: invitation.id,
      accountEmail: email,
    });
    expect(declined).toEqual({ ok: true });

    // Erasure rewrites Invitation.email, so the (teacherId, email) key the
    // refusal used to live on no longer matches the address the teacher types.
    await deleteStudentAccount(prisma, student.id);

    const reinvited = await invite(teacher.id, email);
    expect(reinvited.delivered).toBe(false);
  });

  it('writes a block for the declining pair', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);

    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });

    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).not.toBeNull();
  });

  it('still answers DECLINED to a re-invite before any erasure — the block never reaches that gate', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });

    const again = await inviteContact(prisma, {
      teacherId: teacher.id,
      email,
      firstName: 'Sam',
      lastName: 'Student',
    });
    expect(again).toEqual({ ok: false, reason: 'DECLINED' });
  });

  it('writes no block when the CAS misses, so a non-pending row cannot silently suppress', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });
    await prisma.teacherBlock.deleteMany({ where: { teacherId: teacher.id, email } });

    // The row is already `declined`, so the CAS matches nothing.
    const second = await declineInvitation(prisma, {
      invitationId: invitation.id,
      accountEmail: email,
    });
    expect(second).toEqual({ ok: false, reason: 'NOT_PENDING' });

    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).toBeNull();
  });

  it('rolls back the status write when the block upsert fails mid-transaction', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);

    // A client extension that makes only this one call fail, propagated
    // through to `$transaction`'s `tx` — proves the status write and the
    // block upsert commit or fail together, which is the whole reason
    // `declineInvitation` wraps them in one transaction rather than issuing
    // them as two independent statements.
    const failingBlock = prisma.$extends({
      query: {
        teacherBlock: {
          upsert() {
            throw new Error('boom');
          },
        },
      },
    }) as unknown as PrismaClient;

    await expect(
      declineInvitation(failingBlock, { invitationId: invitation.id, accountEmail: email }),
    ).rejects.toThrow('boom');

    const row = await prisma.invitation.findUniqueOrThrow({
      where: { id: invitation.id },
      select: { status: true },
    });
    expect(row.status).toBe('pending');

    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).toBeNull();
  });

  it('a booking clears a decline-written block and returns the row to accepted', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });

    // What POST /api/registrations does inside `!isTeacher` on a booking that
    // created the link — the student's own act. `docs/data-model.md`
    // ("What a student's own act resolves") owns the rule for which acts
    // clear a block and which abstain.
    await prisma.$transaction(async (tx) => {
      await resolveInvitationOnLink(tx, {
        teacherId: teacher.id,
        studentEmail: email,
        linkOutcome: 'created',
      });
    });

    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).toBeNull();

    const row = await prisma.invitation.findUnique({
      where: { id: invitation.id },
      select: { status: true },
    });
    expect(row?.status).toBe('accepted');
  });

  it('a returning erased decliner clears the surviving block by booking', async () => {
    const { teacher, student, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });
    await deleteStudentAccount(prisma, student.id);

    // The block is what survived the scrub — assert it, or the final
    // `toBeNull` below would pass just as well against an erasure that had
    // deleted it, which is the regression this test exists to catch.
    const survived = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(survived).not.toBeNull();

    // They come back: a new account and Student row on the same address.
    const account = await prisma.account.create({ data: { email } });
    const returning = await prisma.student.create({
      data: {
        firstName: 'Sam',
        lastName: 'Student',
        email,
        incomeTier: 3,
        accountId: account.id,
        claimedAt: new Date(),
      },
    });
    // Registered in the same teardown array the helper populates — this
    // Student/Account pair is created outside `makeTeacherAndInvitee`, but
    // the `afterAll` above resolves each student's `accountId` from the row
    // itself, so pushing the id here is enough to reach both deletes.
    studentIds.push(returning.id);

    await prisma.$transaction(async (tx) => {
      await resolveInvitationOnLink(tx, {
        teacherId: teacher.id,
        studentEmail: email,
        linkOutcome: 'created',
      });
    });

    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).toBeNull();
  });

  // Every decline now leaves a block standing in front of
  // `acceptInvitation`'s own block re-check, so what that check answers is
  // part of this write's surface. Its own nested `describe` for the same
  // reason `listDeclinedTeachers` below has one: the outer name is about the
  // write, and these are about a later read of what it wrote.
  describe('acceptInvitation, with a block standing', () => {
    it('answers NOT_PENDING to the rightful owner of a row they declined', async () => {
      const { teacher, student, email } = await makeTeacherAndInvitee();
      const invitation = await invite(teacher.id, email);
      await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });

      const result = await acceptInvitation(prisma, {
        invitationId: invitation.id,
        studentId: student.id,
        accountEmail: email,
      });
      expect(result).toEqual({ ok: false, reason: 'NOT_PENDING' });

      // The code is not the whole refusal: no link, and the tombstone stands.
      expect(await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId: teacher.id, studentId: student.id } },
      })).toBeNull();
      const row = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
        select: { status: true },
      });
      expect(row.status).toBe('declined');
    });

    it('answers NOT_FOUND for a still-pending row on a blocked pair', async () => {
      const { teacher, student, email } = await makeTeacherAndInvitee();
      const invitation = await invite(teacher.id, email);
      // A block standing over a row nobody has answered. `listPendingInvitations`
      // never offers such a row, so there is nothing here for this caller and
      // the answer has to stay indistinguishable from an unknown id.
      await prisma.teacherBlock.create({ data: { teacherId: teacher.id, email } });

      const result = await acceptInvitation(prisma, {
        invitationId: invitation.id,
        studentId: student.id,
        accountEmail: email,
      });
      expect(result).toEqual({ ok: false, reason: 'NOT_FOUND' });

      expect(await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId: teacher.id, studentId: student.id } },
      })).toBeNull();
      const row = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
        select: { status: true },
      });
      expect(row.status).toBe('pending');
    });

    it('answers NOT_PENDING for an accepted row on a blocked pair, and commits no link', async () => {
      const { teacher, student, email } = await makeTeacherAndInvitee();
      const invitation = await invite(teacher.id, email);

      // `delivered: false` is what makes the state below reachable rather
      // than hand-built: `PUT /api/invitations/[id]` resets that column on a
      // genuine re-address (#502 Fix #3), and `unlinkTeacher`'s status write
      // is scoped to `delivered: true` — so the unlink writes the block and
      // deletes the link while leaving this row `accepted`.
      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { delivered: false },
      });
      expect(await acceptInvitation(prisma, {
        invitationId: invitation.id,
        studentId: student.id,
        accountEmail: email,
      })).toEqual({ ok: true });
      expect(await unlinkTeacher(prisma, {
        teacherId: teacher.id,
        studentId: student.id,
        accountEmail: email,
      })).toEqual({ ok: true });

      // Still the outside guard's answer, exactly as before #537: the block
      // is written here, sequentially, before the second `acceptInvitation`
      // call's own outside pre-check ever runs, so that pre-check alone
      // finds it and refuses before any transaction opens — the
      // in-transaction re-check #537 added never gets a turn in this test.
      // What #537 changes is the RACY version of this same row shape, where
      // the block instead lands AFTER that pre-check has already read "no
      // block" — `invitations-lock-order.test.ts`'s "#537" describe stages
      // that directly, and it is the in-transaction re-check, not this
      // guard, that catches it there. The `declined` case above stays safe
      // either way, because `NotPendingError` rolls the link write back
      // regardless of which guard reaches it.
      const result = await acceptInvitation(prisma, {
        invitationId: invitation.id,
        studentId: student.id,
        accountEmail: email,
      });
      expect(result).toEqual({ ok: false, reason: 'NOT_PENDING' });

      expect(await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId: teacher.id, studentId: student.id } },
      })).toBeNull();
      const row = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
        select: { status: true },
      });
      expect(row.status).toBe('accepted');
    });
  });

  // `listDeclinedTeachers` is a sibling read to `listPendingInvitations`
  // (services/invitations.ts), not a decline-writing case like the ones
  // above — its own nested `describe` so the outer name (about the write)
  // doesn't stand in for these.
  describe('listDeclinedTeachers', () => {
    // A second teacher for the same address as `makeTeacherAndInvitee`'s,
    // for the two discrimination tests below — each proves its filter
    // excludes one row while still returning a live sibling to the SAME
    // address. Both halves are needed: asserting only that the excluded row
    // is absent would pass just as well against a filter mistyped into
    // matching nothing at all.
    async function makeTeacher(overrides: { deletedAt?: Date } = {}) {
      const teacherEmail = `teacher-${suffix}-${crypto.randomBytes(3).toString('hex')}@example.com`;
      const teacher = await prisma.teacher.create({
        data: {
          firstName: 'Tess',
          lastName: 'Teacher',
          email: teacherEmail,
          account: { create: { email: teacherEmail } },
          bio: '#522 decline-suppression fixture',
          pageSlug: `tess-${suffix}-${crypto.randomBytes(3).toString('hex')}`,
          ...overrides,
        },
      });
      teacherIds.push(teacher.id);
      teacherAccountIds.push(teacher.accountId);
      return teacher;
    }

    it('lists a teacher whose invitation this account declined', async () => {
      const { teacher, email } = await makeTeacherAndInvitee();
      const invitation = await invite(teacher.id, email);
      await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });

      const rows = await listDeclinedTeachers(prisma, { accountEmail: email });
      expect(rows.map((r) => r.teacher.pageSlug)).toContain(teacher.pageSlug);
    });

    it('lists a teacher the student unlinked — the other writer of a declined row', async () => {
      const { teacher, student, email } = await makeTeacherAndInvitee();
      const invitation = await invite(teacher.id, email);
      expect(await acceptInvitation(prisma, {
        invitationId: invitation.id,
        studentId: student.id,
        accountEmail: email,
      })).toEqual({ ok: true });

      // `unlinkTeacher` is the refusal route this section is NOT keyed on:
      // it writes the same `TeacherBlock` a decline does, and flips a
      // `delivered: true` invitation to `declined` alongside. That row is
      // what this read finds, so a walk-away is listed exactly like a
      // decline — which is why the section's copy names no route in.
      expect(await unlinkTeacher(prisma, {
        teacherId: teacher.id,
        studentId: student.id,
        accountEmail: email,
      })).toEqual({ ok: true });

      const rows = await listDeclinedTeachers(prisma, { accountEmail: email });
      expect(rows.map((r) => r.teacher.pageSlug)).toContain(teacher.pageSlug);
    });

    it('lists nothing once the account is erased, even though the block survives', async () => {
      const { teacher, student, email } = await makeTeacherAndInvitee();
      const invitation = await invite(teacher.id, email);
      await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });
      await deleteStudentAccount(prisma, student.id);

      // The block is still there — it is what keeps the suppression working.
      const block = await prisma.teacherBlock.findUnique({
        where: { teacherId_email: { teacherId: teacher.id, email } },
        select: { id: true },
      });
      expect(block).not.toBeNull();

      // The narrative is not. A new account on this address learns nothing
      // about the erased person's refusal.
      const rows = await listDeclinedTeachers(prisma, { accountEmail: email });
      expect(rows).toEqual([]);
    });

    it('lists nothing for a pair that is currently linked', async () => {
      const { teacher, student, email } = await makeTeacherAndInvitee();
      const invitation = await invite(teacher.id, email);
      await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });
      await prisma.teacherStudent.create({ data: { teacherId: teacher.id, studentId: student.id } });

      const rows = await listDeclinedTeachers(prisma, { accountEmail: email });
      expect(rows).toEqual([]);
    });

    it('excludes a pending invitation, while still listing a declined one to the same address', async () => {
      const { teacher: declinedTeacher, email } = await makeTeacherAndInvitee();
      const declinedInvitation = await invite(declinedTeacher.id, email);
      await declineInvitation(prisma, { invitationId: declinedInvitation.id, accountEmail: email });

      // A second teacher's invitation to the same address, left pending —
      // otherwise unanswered, this teacher's Accept/Decline card is still
      // live on the same page a "Not connected" listing would sit under.
      const pendingTeacher = await makeTeacher();
      await invite(pendingTeacher.id, email);

      const rows = await listDeclinedTeachers(prisma, { accountEmail: email });
      expect(rows.map((r) => r.teacher.pageSlug)).toEqual([declinedTeacher.pageSlug]);
    });

    it('excludes a declined invitation from a soft-deleted teacher, while still listing a live one to the same address', async () => {
      const { teacher: liveTeacher, email } = await makeTeacherAndInvitee();
      const liveInvitation = await invite(liveTeacher.id, email);
      await declineInvitation(prisma, { invitationId: liveInvitation.id, accountEmail: email });

      // A second, soft-deleted teacher's declined invitation to the same
      // address. `deletedAt` is stamped by the fixture rather than reached
      // through a real erasure: what is under test is the query's
      // `deletedAt: null` filter, and the row it has to exclude is one that
      // is otherwise indistinguishable from the live sibling above it.
      const erasedTeacher = await makeTeacher({ deletedAt: new Date() });
      const erasedInvitation = await invite(erasedTeacher.id, email);
      await declineInvitation(prisma, { invitationId: erasedInvitation.id, accountEmail: email });

      const rows = await listDeclinedTeachers(prisma, { accountEmail: email });
      expect(rows.map((r) => r.teacher.pageSlug)).toEqual([liveTeacher.pageSlug]);
    });
  });
});
