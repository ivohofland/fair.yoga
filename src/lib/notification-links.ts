/**
 * Where a notification points its reader.
 *
 * The default target for a notification is its related class, and the
 * teacher's class page is teacher-only — so the student surfaces have
 * always had to supply their own targets. That left anything with no
 * related class unclickable, which was fine until #166 introduced a
 * notification type whose whole purpose is to send someone somewhere.
 *
 * One module so the inbox surfaces and the layer-3 fallback email cannot
 * drift on where an invitation goes, for either reader.
 */

import type { ClassFormat, ClassStatus, NotificationType } from '@/lib/prisma-client';
import { STUDENT_PUSH_GROUP } from './push-policy';

/**
 * The student's own page listing pending invitations and their teachers —
 * where `teacher_invitation` sends them. Not a new destination: it is the
 * page the spec named in Q6, already the one that lists a student's
 * teachers.
 */
export const STUDENT_INVITATION_PATH = '/account/privacy';

/**
 * The in-app label for the action a `teacher_invitation` invites. Kept
 * beside the path so the email's button and the page it opens are named
 * from one place.
 */
export const STUDENT_INVITATION_LABEL = 'Review the invitation';

/**
 * The student's own bookings list — where the waitlist notifications send
 * them in the app (#236). Unlike a class page, `/bookings` is a student
 * route, and it is the one page with a queued student's Claim and Leave
 * actions.
 */
export const STUDENT_BOOKINGS_PATH = '/bookings';

/**
 * The notification types a student acts on from `STUDENT_BOOKINGS_PATH`: the
 * `waitlist` group of `STUDENT_PUSH_GROUP`, which classifies every type, so a
 * new waitlist type is routed here by being classified there.
 */
const WAITLIST_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set(
  (Object.keys(STUDENT_PUSH_GROUP) as NotificationType[]).filter(
    (type) => STUDENT_PUSH_GROUP[type] === 'waitlist',
  ),
);

/** The email button's label for that action. */
export const STUDENT_BOOKINGS_LABEL = 'Go to your bookings';

/**
 * Whether a type's email carries an online class's video link (#911), for
 * every `NotificationType`: the `satisfies` makes a new type a compile error
 * here until it is classified. A waitlist broadcast is not link-bearing: its
 * reader holds no seat yet.
 */
const CARRIES_VIDEO_LINK = {
  booking_confirmed: true,
  booking_cancelled: false,
  booking_removed: false,
  class_cancelled: false,
  payment_received: false,
  payment_request: false,
  waitlist_promoted: true,
  spot_available: false,
  spot_taken: false,
  reminder: false,
  announcement: false,
  teacher_invitation: false,
  walk_in_added: true,
  class_reminder: true,
  payment_refunded: false,
  processor_disconnected: false,
  payment_paid_twice: false,
  payment_charged_back: false,
  refund_failed: false,
  video_link_updated: true,
} as const satisfies Record<NotificationType, boolean>;

/**
 * The link-bearing types: their email shows the class's current link to a
 * student who holds a live registration on it (`videoLinkForEmail`), and
 * their inbox row about an online class opens `STUDENT_BOOKINGS_PATH`. The
 * link itself is never written into a notification.
 */
export const VIDEO_LINK_EMAIL_TYPES: ReadonlySet<NotificationType> = new Set(
  (Object.keys(CARRIES_VIDEO_LINK) as NotificationType[]).filter((type) => CARRIES_VIDEO_LINK[type]),
);

/** The page where a student pays for one class. */
export function payPagePath(classId: string): string {
  return `/bookings/${classId}/pay`;
}

/** The label for that action, in the app and on the email's button. */
export const PAY_NOW_LABEL = 'Pay now';

/** Whether a notification type is about paying for its class. */
export function isPaymentNotification(type: NotificationType): type is 'payment_request' | 'reminder' {
  return type === 'payment_request' || type === 'reminder';
}

/**
 * Where a teacher-inbox `teacher_invitation` sends an account with no student
 * side yet: the page that offers one (#172).
 */
export const TEACHER_INVITATION_PATH = '/inbox/invitations';

/** The label for that action on the email's button. */
export const TEACHER_INVITATION_LABEL = 'Review the invitation';

/**
 * Where a `processor_disconnected` sends the teacher: the Mollie section of
 * their profile settings, where they reconnect. The row names no class.
 */
export const TEACHER_MOLLIE_PATH = '/settings/profile';

/** The label for that action on the email's button. */
export const TEACHER_MOLLIE_LABEL = 'Reconnect Mollie';

/** The shape both student surfaces already select. */
export interface StudentNotificationTarget {
  type: NotificationType;
  relatedClass: {
    id: string;
    status: ClassStatus;
    format: ClassFormat;
    /** The teacher and the cancellation both hang off the entry since #327. */
    calendarEntry: { cancelledAt: Date | null; teacher: { pageSlug: string } };
  } | null;
}

/**
 * The href for a student's inbox row, or null when the row is not
 * actionable.
 *
 * Type first, related class second: an invitation carries no related class,
 * so the order costs nothing today, but a type that gains one later should
 * still go to the place its type is about.
 *
 * A class links to its public booking page only while booking still makes
 * sense — a cancelled or completed class would otherwise send a student to
 * a page that cannot do anything for them.
 *
 * TWO reads for that since #327, not one: `completed` is still a status,
 * `cancelled` is a column on the entry, and a cancelled class keeps whatever
 * live status it had — so `status === 'open'` alone would start linking to the
 * booking page of a class that is off, which is the one destination that page
 * refuses to render.
 *
 * A payment notification goes to its class's pay page whatever the payment's
 * state; the link does not depend on the payment's status. A link-bearing
 * notification about an online class goes to the student's bookings, the
 * one student page that shows the link.
 */
export function studentNotificationHref(notification: StudentNotificationTarget): string | null {
  if (notification.type === 'teacher_invitation') return STUDENT_INVITATION_PATH;
  if (WAITLIST_NOTIFICATION_TYPES.has(notification.type)) return STUDENT_BOOKINGS_PATH;
  // The public booking page never shows the link; the booking does.
  if (VIDEO_LINK_EMAIL_TYPES.has(notification.type) && notification.relatedClass?.format === 'online') {
    return STUDENT_BOOKINGS_PATH;
  }
  if (isPaymentNotification(notification.type)) {
    return notification.relatedClass ? payPagePath(notification.relatedClass.id) : null;
  }
  const cls = notification.relatedClass;
  if (cls && cls.status === 'open' && cls.calendarEntry.cancelledAt === null) {
    return `/${cls.calendarEntry.teacher.pageSlug}/book/${cls.id}`;
  }
  return null;
}

/**
 * The href for a teacher's inbox row, or null when the row is not
 * actionable. Type first, related class second, for the same reason
 * `studentNotificationHref` takes that order.
 */
export function teacherNotificationHref(notification: {
  type: NotificationType;
  relatedClassId: string | null;
}): string | null {
  if (notification.type === 'teacher_invitation') return TEACHER_INVITATION_PATH;
  if (notification.type === 'processor_disconnected') return TEACHER_MOLLIE_PATH;
  return notification.relatedClassId ? `/class/${notification.relatedClassId}` : null;
}
