import type { NotificationType, RecipientType, Student, Teacher } from '@prisma/client';
import { isTeacherNotificationType, type TeacherNotificationType } from '@/services/notification-policy';
import type { NoneOf } from '@/lib/type-pins';

/**
 * Which push preference governs each notification. Push is for what happened
 * to the recipient, not what they did: a student's own booking and own
 * cancellation are `never`. The groups and their defaults are decided in
 * `docs/superpowers/specs/2026-10-02-web-push-design.md` §2.
 */
export type StudentPushGroup = 'waitlist' | 'classChanges' | 'payments' | 'classReminders' | 'announcements' | 'invitations';
export type TeacherPushGroup = 'autoCancelled' | 'bookings' | 'classCompleted' | 'classReminders' | 'invitations';

/** Every profile column named `push…`: the preference columns, read off the schema. */
export type StudentPushColumn = Extract<keyof Student, `push${string}`>;
export type TeacherPushColumn = Extract<keyof Teacher, `push${string}`>;

export type StudentPushPrefs = Pick<Student, StudentPushColumn>;
export type TeacherPushPrefs = Pick<Teacher, TeacherPushColumn>;

/** The push service's `Urgency` header values this app sends. */
export type PushUrgency = 'high' | 'normal';

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
} as const satisfies { readonly [G in StudentPushGroup]: `push${Capitalize<G>}` & StudentPushColumn };

export const TEACHER_PUSH_COLUMN = {
  autoCancelled: 'pushAutoCancelled',
  bookings: 'pushBookings',
  classCompleted: 'pushClassCompleted',
  classReminders: 'pushClassReminders',
  invitations: 'pushInvitations',
} as const satisfies { readonly [G in TeacherPushGroup]: `push${Capitalize<G>}` & TeacherPushColumn };

// A `push…` column no group maps to would be a preference nothing reads; the
// build names it here.
const _everyStudentPushColumnHasAGroup: NoneOf<Exclude<StudentPushColumn, (typeof STUDENT_PUSH_COLUMN)[StudentPushGroup]>> = true;
const _everyTeacherPushColumnHasAGroup: NoneOf<Exclude<TeacherPushColumn, (typeof TEACHER_PUSH_COLUMN)[TeacherPushGroup]>> = true;
void [_everyStudentPushColumnHasAGroup, _everyTeacherPushColumnHasAGroup];

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

function teacherGroup(type: NotificationType): TeacherPushGroup | 'never' {
  return isTeacherNotificationType(type) ? TEACHER_PUSH_GROUP[type] : 'never';
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
 * First caps, in raw UTF-8 bytes, on the notification's own title and body.
 * They do not by themselves keep the payload under the push limit: JSON
 * escaping can grow a character to six bytes, so `buildPushPayload` then
 * shrinks the body until the serialised payload fits `PUSH_PLAINTEXT_MAX_BYTES`.
 */
export const PUSH_BODY_MAX_BYTES = 1500;
export const PUSH_TITLE_MAX_BYTES = 200;

/**
 * The most `JSON.stringify(payload)` may weigh: the 4096-byte push message,
 * less the 86-byte aes128gcm header (salt, record size, key id length, key)
 * and 17 bytes of padding delimiter and authentication tag.
 */
export const PUSH_PLAINTEXT_MAX_BYTES = 4096 - 86 - 17;

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

function serialisedBytes(payload: PushPayload): number {
  return Buffer.byteLength(JSON.stringify(payload));
}

/**
 * The longest code-point prefix of `body`, ending in `…`, that keeps the
 * payload within `PUSH_PLAINTEXT_MAX_BYTES`. The serialised size only grows
 * with the prefix, so a binary search finds it.
 */
function fitBody(payload: PushPayload, body: string): PushPayload {
  const codePoints = Array.from(body);
  const withPrefix = (length: number): PushPayload => ({ ...payload, body: `${codePoints.slice(0, length).join('')}…` });
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (serialisedBytes(withPrefix(mid)) <= PUSH_PLAINTEXT_MAX_BYTES) low = mid;
    else high = mid - 1;
  }
  return withPrefix(low);
}

export function buildPushPayload(n: {
  id: string;
  recipientType: RecipientType;
  type: NotificationType;
  title: string;
  body: string;
}): PushPayload {
  const inbox = n.recipientType === 'student' ? '/updates' : '/inbox';
  const payload: PushPayload = {
    id: n.id,
    title: truncate(n.title, PUSH_TITLE_MAX_BYTES),
    body: isRedacted(n.recipientType, n.type) ? REDACTED_BODY : truncate(n.body, PUSH_BODY_MAX_BYTES),
    url: `${inbox}?n=${encodeURIComponent(n.id)}`,
  };
  // A redacted body is a short constant and always fits; an own body dense
  // in characters JSON escapes (control characters, quotes) may not.
  if (serialisedBytes(payload) <= PUSH_PLAINTEXT_MAX_BYTES) return payload;
  return fitBody(payload, n.body);
}

export function pushUrgency(audience: RecipientType, type: NotificationType): PushUrgency {
  if (audience === 'student') {
    const group = STUDENT_PUSH_GROUP[type];
    return group !== 'never' && STUDENT_URGENT[group] ? 'high' : 'normal';
  }
  const group = teacherGroup(type);
  return group !== 'never' && TEACHER_URGENT[group] ? 'high' : 'normal';
}
