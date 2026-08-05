/**
 * Where a notification points a student.
 *
 * The default target for a notification is its related class, and every
 * class route in this app is teacher-only — so the student surfaces have
 * always had to supply their own targets. That left anything with no
 * related class unclickable, which was fine until #166 introduced a
 * notification type whose whole purpose is to send someone somewhere.
 *
 * One module so the two student surfaces (`/updates` and the strip on
 * `/bookings`) and the layer-3 fallback email cannot drift on where an
 * invitation goes.
 */

import type { ClassStatus, NotificationType } from '@prisma/client';

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

/** The shape both student surfaces already select. */
export interface StudentNotificationTarget {
  type: NotificationType;
  relatedClass: { id: string; status: ClassStatus; teacher: { pageSlug: string } } | null;
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
 */
export function studentNotificationHref(notification: StudentNotificationTarget): string | null {
  if (notification.type === 'teacher_invitation') return STUDENT_INVITATION_PATH;
  if (notification.relatedClass && notification.relatedClass.status === 'open') {
    return `/${notification.relatedClass.teacher.pageSlug}/book/${notification.relatedClass.id}`;
  }
  return null;
}
