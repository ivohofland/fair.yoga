import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { erasedAddress } from '@/lib/erased-address';
import { invitationSubject } from '@/lib/unsubscribe-token';
import { declinePending } from './invitations';
import { unsubscribe } from './unsubscribe';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();
const teacherIds: string[] = [];
const studentIds: string[] = [];
const accountIds: string[] = [];
const emails: string[] = [];

type TeacherOverrides = Partial<
  Pick<
    Prisma.TeacherUncheckedCreateInput,
    'bookingNotifications' | 'emailOnClassCompleted' | 'emailOnInvitation' | 'classReminder' | 'classReminderChannel' | 'deletedAt'
  >
>;
type StudentOverrides = Partial<
  Pick<Prisma.StudentUncheckedCreateInput, 'emailNotifications' | 'classReminder' | 'classReminderChannel' | 'deletedAt'>
>;

async function makeAccount(): Promise<{ accountId: string; email: string; s: string }> {
  const s = uniqueSuffix();
  const email = `unsub-${s}@test.local`;
  const account = await prisma.account.create({ data: { email }, select: { id: true } });
  accountIds.push(account.id);
  emails.push(email);
  return { accountId: account.id, email, s };
}

async function makeTeacher(overrides: TeacherOverrides = {}, accountId?: string, email?: string): Promise<string> {
  const a = accountId && email ? { accountId, email, s: uniqueSuffix() } : await makeAccount();
  const t = await prisma.teacher.create({
    data: { firstName: 'Un', lastName: 'Sub', email: a.email, bio: '', pageSlug: `unsub-${a.s}`, accountId: a.accountId, ...overrides },
    select: { id: true },
  });
  teacherIds.push(t.id);
  return t.id;
}

async function makeStudent(overrides: StudentOverrides = {}, accountId?: string, email?: string): Promise<string> {
  const a = accountId && email ? { accountId, email } : await makeAccount();
  const st = await prisma.student.create({
    data: { firstName: 'Un', lastName: 'Sub', email: a.email, accountId: a.accountId, claimedAt: new Date(), ...overrides },
    select: { id: true },
  });
  studentIds.push(st.id);
  return st.id;
}

async function makeInvitation(
  teacherId: string,
  status: 'pending' | 'declined' | 'accepted' = 'pending',
  email = `inv-${uniqueSuffix()}@test.local`,
): Promise<{ id: string; email: string }> {
  const inv = await prisma.invitation.create({ data: { teacherId, email, status, respondedAt: status === 'pending' ? null : new Date() }, select: { id: true, email: true } });
  return inv;
}

afterAll(async () => {
  await prisma.teacherBlock.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.invitation.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('unsubscribe', () => {
  it('student_notifications: done, then unchanged', async () => {
    const id = await makeStudent({ emailNotifications: true });
    expect(await unsubscribe(prisma, { kind: 'student_notifications', subjectId: id })).toEqual({ status: 'done' });
    expect((await prisma.student.findUniqueOrThrow({ where: { id } })).emailNotifications).toBe(false);
    expect(await unsubscribe(prisma, { kind: 'student_notifications', subjectId: id })).toEqual({ status: 'unchanged' });
  });

  it('teacher_bookings: inbox_and_email becomes inbox_only; off stays off', async () => {
    const id = await makeTeacher({ bookingNotifications: 'inbox_and_email' });
    expect(await unsubscribe(prisma, { kind: 'teacher_bookings', subjectId: id })).toEqual({ status: 'done' });
    expect((await prisma.teacher.findUniqueOrThrow({ where: { id } })).bookingNotifications).toBe('inbox_only');
    expect(await unsubscribe(prisma, { kind: 'teacher_bookings', subjectId: id })).toEqual({ status: 'unchanged' });

    const off = await makeTeacher({ bookingNotifications: 'off' });
    expect(await unsubscribe(prisma, { kind: 'teacher_bookings', subjectId: off })).toEqual({ status: 'unchanged' });
    expect((await prisma.teacher.findUniqueOrThrow({ where: { id: off } })).bookingNotifications).toBe('off');
  });

  it('teacher_class_completed and teacher_invitations switch their boolean off', async () => {
    const id = await makeTeacher({ emailOnClassCompleted: true, emailOnInvitation: true });
    expect(await unsubscribe(prisma, { kind: 'teacher_class_completed', subjectId: id })).toEqual({ status: 'done' });
    let t = await prisma.teacher.findUniqueOrThrow({ where: { id } });
    expect(t.emailOnClassCompleted).toBe(false);
    expect(t.emailOnInvitation).toBe(true);
    expect(await unsubscribe(prisma, { kind: 'teacher_invitations', subjectId: id })).toEqual({ status: 'done' });
    t = await prisma.teacher.findUniqueOrThrow({ where: { id } });
    expect(t.emailOnInvitation).toBe(false);
    expect(await unsubscribe(prisma, { kind: 'teacher_invitations', subjectId: id })).toEqual({ status: 'unchanged' });
  });

  describe.each([
    ['student_reminders', makeStudent, (id: string) => prisma.student.findUniqueOrThrow({ where: { id } })],
    ['teacher_reminders', makeTeacher, (id: string) => prisma.teacher.findUniqueOrThrow({ where: { id } })],
  ] as const)('%s', (kind, make, read) => {
    it('inbox_and_email drops to inbox, timing kept', async () => {
      const id = await make({ classReminder: 'morning_of', classReminderChannel: 'inbox_and_email' });
      expect(await unsubscribe(prisma, { kind, subjectId: id })).toEqual({ status: 'done' });
      const row = await read(id);
      expect(row.classReminderChannel).toBe('inbox');
      expect(row.classReminder).toBe('morning_of');
    });

    it('email channel turns the reminder off, channel kept', async () => {
      const id = await make({ classReminder: 'morning_of', classReminderChannel: 'email' });
      expect(await unsubscribe(prisma, { kind, subjectId: id })).toEqual({ status: 'done' });
      const row = await read(id);
      expect(row.classReminder).toBe('off');
      expect(row.classReminderChannel).toBe('email');
    });

    it('inbox channel is unchanged', async () => {
      const id = await make({ classReminder: 'morning_of', classReminderChannel: 'inbox' });
      expect(await unsubscribe(prisma, { kind, subjectId: id })).toEqual({ status: 'unchanged' });
    });

    it('reminder off is unchanged', async () => {
      const id = await make({ classReminder: 'off', classReminderChannel: 'email' });
      expect(await unsubscribe(prisma, { kind, subjectId: id })).toEqual({ status: 'unchanged' });
      expect((await read(id)).classReminder).toBe('off');
    });
  });

  describe('invitation', () => {
    it('pending: declined and blocked', async () => {
      const teacherId = await makeTeacher();
      const inv = await makeInvitation(teacherId);
      const subjectId = invitationSubject(inv.id, inv.email);
      expect(await unsubscribe(prisma, { kind: 'invitation', subjectId })).toEqual({ status: 'done' });
      expect((await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('declined');
      expect(await prisma.teacherBlock.count({ where: { teacherId, email: inv.email } })).toBe(1);
      expect(await unsubscribe(prisma, { kind: 'invitation', subjectId })).toEqual({ status: 'unchanged' });
    });

    it.each(['declined', 'accepted'] as const)('%s: unchanged, no block written', async (status) => {
      const teacherId = await makeTeacher();
      const inv = await makeInvitation(teacherId, status);
      expect(await unsubscribe(prisma, { kind: 'invitation', subjectId: invitationSubject(inv.id, inv.email) })).toEqual({ status: 'unchanged' });
      expect(await prisma.teacherBlock.count({ where: { teacherId } })).toBe(0);
      expect((await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe(status);
    });

    it('readdressed after send: invalid, nothing written for either address', async () => {
      const teacherId = await makeTeacher();
      const inv = await makeInvitation(teacherId);
      const subjectId = invitationSubject(inv.id, inv.email);
      const newEmail = `moved-${uniqueSuffix()}@test.local`;
      await prisma.invitation.update({ where: { id: inv.id }, data: { email: newEmail } });
      expect(await unsubscribe(prisma, { kind: 'invitation', subjectId })).toEqual({ status: 'invalid' });
      expect((await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('pending');
      expect(await prisma.teacherBlock.count({ where: { teacherId } })).toBe(0);
    });

    it('declinePending with a stale address writes nothing', async () => {
      const teacherId = await makeTeacher();
      const inv = await makeInvitation(teacherId);
      const newEmail = `moved-${uniqueSuffix()}@test.local`;
      await prisma.invitation.update({ where: { id: inv.id }, data: { email: newEmail } });
      const moved = await prisma.$transaction((tx) => declinePending(tx, { id: inv.id, teacherId, email: inv.email }));
      expect(moved).toBe(false);
      expect((await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('pending');
      expect(await prisma.teacherBlock.count({ where: { teacherId } })).toBe(0);
    });

    it('subject without an address tag: invalid', async () => {
      const teacherId = await makeTeacher();
      const inv = await makeInvitation(teacherId);
      expect(await unsubscribe(prisma, { kind: 'invitation', subjectId: inv.id })).toEqual({ status: 'invalid' });
      expect((await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('pending');
    });

    it('tombstoned address: invalid', async () => {
      const teacherId = await makeTeacher();
      const inv = await makeInvitation(teacherId, 'pending', erasedAddress(crypto.randomUUID()));
      expect(await unsubscribe(prisma, { kind: 'invitation', subjectId: invitationSubject(inv.id, inv.email) })).toEqual({ status: 'invalid' });
      expect((await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('pending');
    });
  });

  it.each([
    'student_notifications',
    'teacher_bookings',
    'teacher_class_completed',
    'teacher_invitations',
    'student_reminders',
    'teacher_reminders',
  ] as const)('unknown id for %s: invalid', async (kind) => {
    expect(await unsubscribe(prisma, { kind, subjectId: crypto.randomUUID() })).toEqual({ status: 'invalid' });
  });

  it('unknown invitation id with a well-formed subject: invalid', async () => {
    const id = crypto.randomUUID();
    expect(await unsubscribe(prisma, { kind: 'invitation', subjectId: invitationSubject(id, 'a@test.local') })).toEqual({ status: 'invalid' });
  });

  it('erased student: invalid, flag untouched', async () => {
    const id = await makeStudent({ emailNotifications: true, deletedAt: new Date() });
    expect(await unsubscribe(prisma, { kind: 'student_notifications', subjectId: id })).toEqual({ status: 'invalid' });
    expect((await prisma.student.findUniqueOrThrow({ where: { id } })).emailNotifications).toBe(true);
  });

  it('erased teacher: invalid, preference untouched', async () => {
    const id = await makeTeacher({ bookingNotifications: 'inbox_and_email', deletedAt: new Date() });
    expect(await unsubscribe(prisma, { kind: 'teacher_bookings', subjectId: id })).toEqual({ status: 'invalid' });
    expect((await prisma.teacher.findUniqueOrThrow({ where: { id } })).bookingNotifications).toBe('inbox_and_email');
  });

  it('two-hat account: the student switch leaves the teacher profile alone', async () => {
    const a = await makeAccount();
    const teacherId = await makeTeacher({}, a.accountId, a.email);
    const studentId = await makeStudent({}, a.accountId, a.email);
    expect(await unsubscribe(prisma, { kind: 'student_notifications', subjectId: studentId })).toEqual({ status: 'done' });
    expect((await prisma.student.findUniqueOrThrow({ where: { id: studentId } })).emailNotifications).toBe(false);
    const t = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(t.bookingNotifications).toBe('inbox_and_email');
    expect(t.emailOnClassCompleted).toBe(true);
    expect(t.emailOnInvitation).toBe(true);
  });

  it('two students: only the named one changes', async () => {
    const one = await makeStudent();
    const other = await makeStudent();
    await unsubscribe(prisma, { kind: 'student_notifications', subjectId: one });
    expect((await prisma.student.findUniqueOrThrow({ where: { id: other } })).emailNotifications).toBe(true);
  });
});
