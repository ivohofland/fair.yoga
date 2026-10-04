import { describe, it, expect } from 'vitest';
import type { ClassStatus } from '@prisma/client';
import type { TeacherSession } from './types';
import { attendanceOutboxProps } from './attendance-outbox-props';

const session: TeacherSession = {
  sessionId: 'session-1',
  accountId: 'account-1',
  teacherId: 'teacher-1',
  defaultTimezone: 'Europe/Amsterdam',
  studentId: 'student-1',
};

function cls(status: ClassStatus) {
  return { id: 'class-1', status, calendarEntry: { classType: 'Hatha' } };
}

// 16:00 UTC is 18:00 in Amsterdam on this date (CEST).
const start = new Date('2026-10-06T16:00:00Z');

describe('attendanceOutboxProps', () => {
  it('files marks under the signed-in account and names the class in the teacher zone', () => {
    expect(attendanceOutboxProps(session, cls('in_progress'), start, 'Europe/Amsterdam')).toEqual({
      owner: 'account-1',
      classId: 'class-1',
      classLabel: 'Hatha on Tue 6 Oct 18:00',
      completed: false,
    });
  });

  it('is completed only when the class rendered completed', () => {
    expect(attendanceOutboxProps(session, cls('completed'), start, 'Europe/Amsterdam').completed).toBe(true);
    for (const status of ['draft', 'open', 'in_progress'] as const) {
      expect(attendanceOutboxProps(session, cls(status), start, 'Europe/Amsterdam').completed).toBe(false);
    }
  });

  it('owns the queue by account, never by teacher or student profile', () => {
    const { owner } = attendanceOutboxProps(session, cls('completed'), start, 'Europe/Amsterdam');
    expect(owner).toBe(session.accountId);
    expect(owner).not.toBe(session.teacherId);
    expect(owner).not.toBe(session.studentId);
  });
});
