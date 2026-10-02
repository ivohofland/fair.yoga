import { describe, it, expect } from 'vitest';
import { NotificationType } from '@prisma/client';
import {
  STUDENT_PUSH_GROUP, TEACHER_PUSH_GROUP, shouldPush, buildPushPayload, pushUrgency,
  REDACTED_BODY, PUSH_BODY_MAX_BYTES, type StudentPushPrefs, type TeacherPushPrefs,
} from './push-policy';

const allStudentOn: StudentPushPrefs = {
  pushWaitlist: true, pushClassChanges: true, pushPayments: true,
  pushClassReminders: true, pushAnnouncements: true, pushInvitations: true,
};
const allStudentOff: StudentPushPrefs = {
  pushWaitlist: false, pushClassChanges: false, pushPayments: false,
  pushClassReminders: false, pushAnnouncements: false, pushInvitations: false,
};
const allTeacherOn: TeacherPushPrefs = {
  pushAutoCancelled: true, pushBookings: true, pushClassCompleted: true,
  pushClassReminders: true, pushInvitations: true,
};
const allTeacherOff: TeacherPushPrefs = {
  pushAutoCancelled: false, pushBookings: false, pushClassCompleted: false,
  pushClassReminders: false, pushInvitations: false,
};

describe('STUDENT_PUSH_GROUP', () => {
  it('files every NotificationType', () => {
    expect(Object.keys(STUDENT_PUSH_GROUP).sort()).toEqual(Object.values(NotificationType).sort());
  });

  it.each([
    ['waitlist_promoted', 'waitlist'], ['spot_available', 'waitlist'], ['spot_taken', 'waitlist'],
    ['class_cancelled', 'classChanges'], ['booking_removed', 'classChanges'], ['walk_in_added', 'classChanges'],
    ['payment_request', 'payments'], ['reminder', 'payments'],
    ['class_reminder', 'classReminders'], ['announcement', 'announcements'], ['teacher_invitation', 'invitations'],
    ['booking_confirmed', 'never'], ['booking_cancelled', 'never'], ['payment_received', 'never'],
  ] as const)('%s → %s', (type, group) => {
    expect(STUDENT_PUSH_GROUP[type]).toBe(group);
  });
});

describe('shouldPush', () => {
  it('never pushes a student their own booking or cancellation, whatever the prefs', () => {
    for (const type of ['booking_confirmed', 'booking_cancelled'] as const) {
      expect(shouldPush({ audience: 'student', prefs: allStudentOn }, type)).toBe(false);
    }
  });

  it('follows the group column for a student', () => {
    expect(shouldPush({ audience: 'student', prefs: allStudentOn }, 'spot_available')).toBe(true);
    expect(shouldPush({ audience: 'student', prefs: allStudentOff }, 'spot_available')).toBe(false);
    expect(shouldPush({ audience: 'student', prefs: { ...allStudentOff, pushPayments: true } }, 'reminder')).toBe(true);
  });

  it('follows the group column for a teacher, and refuses a type no teacher is sent', () => {
    expect(shouldPush({ audience: 'teacher', prefs: allTeacherOn }, 'class_cancelled')).toBe(true);
    expect(shouldPush({ audience: 'teacher', prefs: { ...allTeacherOn, pushAutoCancelled: false } }, 'class_cancelled')).toBe(false);
    expect(shouldPush({ audience: 'teacher', prefs: allTeacherOn }, 'spot_available')).toBe(false);
  });

  it('covers every teacher type', () => {
    expect(Object.keys(TEACHER_PUSH_GROUP).sort()).toEqual(
      ['booking_confirmed', 'class_cancelled', 'class_reminder', 'payment_request', 'teacher_invitation'],
    );
  });
});

// Written out here rather than read from the policy maps, so a map that files
// a type under the wrong group disagrees with this table.
const STUDENT_COLUMN_FOR = {
  waitlist_promoted: 'pushWaitlist',
  spot_available: 'pushWaitlist',
  spot_taken: 'pushWaitlist',
  class_cancelled: 'pushClassChanges',
  booking_removed: 'pushClassChanges',
  walk_in_added: 'pushClassChanges',
  payment_request: 'pushPayments',
  reminder: 'pushPayments',
  class_reminder: 'pushClassReminders',
  announcement: 'pushAnnouncements',
  teacher_invitation: 'pushInvitations',
  booking_confirmed: null,
  booking_cancelled: null,
  payment_received: null,
} as const satisfies Record<NotificationType, keyof StudentPushPrefs | null>;

const TEACHER_COLUMN_FOR = {
  class_cancelled: 'pushAutoCancelled',
  booking_confirmed: 'pushBookings',
  payment_request: 'pushClassCompleted',
  class_reminder: 'pushClassReminders',
  teacher_invitation: 'pushInvitations',
  waitlist_promoted: null,
  spot_available: null,
  spot_taken: null,
  booking_removed: null,
  walk_in_added: null,
  reminder: null,
  announcement: null,
  booking_cancelled: null,
  payment_received: null,
} as const satisfies Record<NotificationType, keyof TeacherPushPrefs | null>;

const STUDENT_COLUMNS = Object.keys(allStudentOff) as Array<keyof StudentPushPrefs>;
const TEACHER_COLUMNS = Object.keys(allTeacherOff) as Array<keyof TeacherPushPrefs>;

describe('shouldPush, every type against every single column', () => {
  const studentCases = Object.values(NotificationType).flatMap((type) =>
    STUDENT_COLUMNS.map((column) => [type, column] as const));
  it.each(studentCases)('student %s with only %s on', (type, column) => {
    const prefs = { ...allStudentOff, [column]: true };
    expect(shouldPush({ audience: 'student', prefs }, type)).toBe(STUDENT_COLUMN_FOR[type] === column);
  });

  const teacherCases = Object.values(NotificationType).flatMap((type) =>
    TEACHER_COLUMNS.map((column) => [type, column] as const));
  it.each(teacherCases)('teacher %s with only %s on', (type, column) => {
    const prefs = { ...allTeacherOff, [column]: true };
    expect(shouldPush({ audience: 'teacher', prefs }, type)).toBe(TEACHER_COLUMN_FOR[type] === column);
  });
});

describe('buildPushPayload', () => {
  const base = { id: 'n1', title: 'T', body: 'B' };

  it('lands a student on /updates and a teacher on /inbox, at the row', () => {
    expect(buildPushPayload({ ...base, recipientType: 'student', type: 'spot_available' }).url).toBe('/updates?n=n1');
    expect(buildPushPayload({ ...base, recipientType: 'teacher', type: 'class_cancelled' }).url).toBe('/inbox?n=n1');
  });

  it('keeps the title but hides the body for money groups', () => {
    const student = buildPushPayload({ ...base, body: 'Your price for Vinyasa is €14.20.', recipientType: 'student', type: 'payment_request' });
    expect(student).toMatchObject({ title: 'T', body: REDACTED_BODY });
    expect(student.body).not.toContain('€');
    expect(buildPushPayload({ ...base, body: '€14.20 is still open', recipientType: 'student', type: 'reminder' }).body).toBe(REDACTED_BODY);
    expect(buildPushPayload({ ...base, body: '€48.00 earnings', recipientType: 'teacher', type: 'payment_request' }).body).toBe(REDACTED_BODY);
  });

  it('shows its own body otherwise', () => {
    expect(buildPushPayload({ ...base, recipientType: 'student', type: 'spot_available' }).body).toBe('B');
  });

  it('truncates a long body to PUSH_BODY_MAX_BYTES on a character boundary', () => {
    const long = '€'.repeat(PUSH_BODY_MAX_BYTES); // 3 bytes each
    const body = buildPushPayload({ ...base, body: long, recipientType: 'student', type: 'announcement' }).body;
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(PUSH_BODY_MAX_BYTES);
    expect(body.endsWith('…')).toBe(true);
    expect(body).not.toContain('�');
  });
});

describe('pushUrgency', () => {
  it('is high for the time-critical groups only', () => {
    expect(pushUrgency('student', 'spot_available')).toBe('high');
    expect(pushUrgency('student', 'class_cancelled')).toBe('high');
    expect(pushUrgency('teacher', 'class_cancelled')).toBe('high');
    expect(pushUrgency('student', 'announcement')).toBe('normal');
  });
});
