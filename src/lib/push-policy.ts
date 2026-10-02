import type { NotificationType, RecipientType, Student, Teacher } from '@prisma/client';
import type { TeacherNotificationType } from '@/services/notification-policy';

/**
 * Which push preference governs each notification. Push is for what happened
 * to the recipient, not what they did: a student's own booking and own
 * cancellation are `never`. The groups and their defaults are decided in
 * `docs/superpowers/specs/2026-10-02-web-push-design.md` §2.
 */
export type StudentPushGroup = 'waitlist' | 'classChanges' | 'payments' | 'classReminders' | 'announcements' | 'invitations';
export type TeacherPushGroup = 'autoCancelled' | 'bookings' | 'classCompleted' | 'classReminders' | 'invitations';

export type StudentPushPrefs = Pick<Student, 'pushWaitlist' | 'pushClassChanges' | 'pushPayments' | 'pushClassReminders' | 'pushAnnouncements' | 'pushInvitations'>;
export type TeacherPushPrefs = Pick<Teacher, 'pushAutoCancelled' | 'pushBookings' | 'pushClassCompleted' | 'pushClassReminders' | 'pushInvitations'>;

export const STUDENT_PUSH_GROUP = {
  waitlist_promoted: 'waitlist',
  spot_available: 'waitlist',
  spot_taken: 'waitlist',
  class_cancelled: 'classChanges',
  booking_removed: 'classChanges',
  walk_in_added: 'classChanges',
  payment_request: 'payments',
  reminder: 'payments',
  class_reminder: 'classReminders',
  announcement: 'announcements',
  teacher_invitation: 'invitations',
  booking_confirmed: 'never',
  booking_cancelled: 'never',
  payment_received: 'never',
} as const satisfies Record<NotificationType, StudentPushGroup | 'never'>;

export const TEACHER_PUSH_GROUP = {
  class_cancelled: 'autoCancelled',
  booking_confirmed: 'bookings',
  payment_request: 'classCompleted',
  class_reminder: 'classReminders',
  teacher_invitation: 'invitations',
} as const satisfies Record<TeacherNotificationType, TeacherPushGroup>;

export const STUDENT_PUSH_COLUMN = {
  waitlist: 'pushWaitlist',
  classChanges: 'pushClassChanges',
  payments: 'pushPayments',
  classReminders: 'pushClassReminders',
  announcements: 'pushAnnouncements',
  invitations: 'pushInvitations',
} as const satisfies Record<StudentPushGroup, keyof StudentPushPrefs>;

export const TEACHER_PUSH_COLUMN = {
  autoCancelled: 'pushAutoCancelled',
  bookings: 'pushBookings',
  classCompleted: 'pushClassCompleted',
  classReminders: 'pushClassReminders',
  invitations: 'pushInvitations',
} as const satisfies Record<TeacherPushGroup, keyof TeacherPushPrefs>;

/** Whether a group's lock-screen body is the notification's own or the fixed line (spec §4). */
const STUDENT_LOCK_SCREEN = {
  waitlist: 'own', classChanges: 'own', payments: 'redacted',
  classReminders: 'own', announcements: 'own', invitations: 'own',
} as const satisfies Record<StudentPushGroup, 'own' | 'redacted'>;

const TEACHER_LOCK_SCREEN = {
  autoCancelled: 'own', bookings: 'own', classCompleted: 'redacted',
  classReminders: 'own', invitations: 'own',
} as const satisfies Record<TeacherPushGroup, 'own' | 'redacted'>;

/** Groups whose pushes ask the push service for immediate delivery. */
const STUDENT_URGENT = {
  waitlist: true, classChanges: true, payments: false,
  classReminders: false, announcements: false, invitations: false,
} as const satisfies Record<StudentPushGroup, boolean>;

const TEACHER_URGENT = {
  autoCancelled: true, bookings: false, classCompleted: false,
  classReminders: false, invitations: false,
} as const satisfies Record<TeacherPushGroup, boolean>;

export type PushRecipient =
  | { audience: 'student'; prefs: StudentPushPrefs }
  | { audience: 'teacher'; prefs: TeacherPushPrefs };

function isTeacherType(type: NotificationType): type is TeacherNotificationType {
  return type in TEACHER_PUSH_GROUP;
}

function teacherGroup(type: NotificationType): TeacherPushGroup | 'never' {
  return isTeacherType(type) ? TEACHER_PUSH_GROUP[type] : 'never';
}

export function shouldPush(recipient: PushRecipient, type: NotificationType): boolean {
  if (recipient.audience === 'student') {
    const group = STUDENT_PUSH_GROUP[type];
    return group !== 'never' && recipient.prefs[STUDENT_PUSH_COLUMN[group]];
  }
  const group = teacherGroup(type);
  return group !== 'never' && recipient.prefs[TEACHER_PUSH_COLUMN[group]];
}

export const REDACTED_BODY = 'Open fair.yoga to see the details.';

/**
 * UTF-8 bytes. Body + title + JSON framing + the 86-byte aes128gcm header and
 * 17 bytes of delimiter and tag stay under the 4096-byte push payload limit.
 */
export const PUSH_BODY_MAX_BYTES = 1500;
export const PUSH_TITLE_MAX_BYTES = 200;

export interface PushPayload {
  id: string;
  title: string;
  body: string;
  url: string;
}

function isRedacted(audience: RecipientType, type: NotificationType): boolean {
  if (audience === 'student') {
    const group = STUDENT_PUSH_GROUP[type];
    return group !== 'never' && STUDENT_LOCK_SCREEN[group] === 'redacted';
  }
  const group = teacherGroup(type);
  return group !== 'never' && TEACHER_LOCK_SCREEN[group] === 'redacted';
}

function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const budget = maxBytes - Buffer.byteLength('…');
  let out = '';
  for (const ch of text) {
    if (Buffer.byteLength(out + ch) > budget) break;
    out += ch;
  }
  return `${out}…`;
}

export function buildPushPayload(n: {
  id: string;
  recipientType: RecipientType;
  type: NotificationType;
  title: string;
  body: string;
}): PushPayload {
  const inbox = n.recipientType === 'student' ? '/updates' : '/inbox';
  return {
    id: n.id,
    title: truncate(n.title, PUSH_TITLE_MAX_BYTES),
    body: isRedacted(n.recipientType, n.type) ? REDACTED_BODY : truncate(n.body, PUSH_BODY_MAX_BYTES),
    url: `${inbox}?n=${encodeURIComponent(n.id)}`,
  };
}

export function pushUrgency(audience: RecipientType, type: NotificationType): 'high' | 'normal' {
  if (audience === 'student') {
    const group = STUDENT_PUSH_GROUP[type];
    return group !== 'never' && STUDENT_URGENT[group] ? 'high' : 'normal';
  }
  const group = teacherGroup(type);
  return group !== 'never' && TEACHER_URGENT[group] ? 'high' : 'normal';
}
