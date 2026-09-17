import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { updateStudentPrivacy } from './student-privacy';
import { deleteStudentAccount } from './gdpr';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

describe('updateStudentPrivacy takes the Student gate (#626)', () => {
  it('refuses a write for an erased student even when a stray TeacherStudent link survives', async () => {
    const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const email = `student-privacy-gate-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Gate', lastName: 'Student', email, claimedAt: new Date(),
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Gate', lastName: 'Teacher',
        email: `student-privacy-gate-teacher-${suffix}@test.local`,
        account: { create: { email: `student-privacy-gate-teacher-${suffix}@test.local` } },
        bio: '#626 privacy-route fixture',
        pageSlug: `student-privacy-gate-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    try {
      await deleteStudentAccount(prisma, student.id);
      // A link that outlived the erasure, as an ungated writer or a
      // pre-existing row could leave (`docs/lock-order.md`, "Who is not
      // gated yet").
      await prisma.teacherStudent.create({ data: { teacherId: teacher.id, studentId: student.id } });

      const result = await updateStudentPrivacy(prisma, {
        studentId: student.id,
        teacherId: teacher.id,
        fields: { shareFullName: true },
      });

      expect(result).toEqual({ ok: false, reason: 'STUDENT_ERASED' });
      expect(
        await prisma.studentPrivacy.count({ where: { studentId: student.id, teacherId: teacher.id } }),
      ).toBe(0);
    } finally {
      await prisma.studentPrivacy.deleteMany({ where: { teacherId: teacher.id } });
      await prisma.teacherStudent.deleteMany({ where: { teacherId: teacher.id } });
      await prisma.student.deleteMany({ where: { id: student.id } });
      await prisma.teacher.deleteMany({ where: { id: teacher.id } });
      const studentAccountId = student.accountId;
      if (studentAccountId === null) throw new Error('fixture student has no account');
      await prisma.account.deleteMany({ where: { id: { in: [studentAccountId, teacher.accountId] } } });
    }
  });
});
