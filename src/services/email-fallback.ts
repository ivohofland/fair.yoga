/**
 * Email Fallback — Sends email for unread notifications past the threshold,
 * or sooner when the linked class starts within the urgent window; essential
 * types bypass the student email opt-out (see notification-policy.ts).
 *
 * Layer 3 of the communication system:
 * 1. In-app notification (real-time via SSE)
 * 2. In-app inbox (persistent record)
 * 3. Email fallback (this service)
 */

import type { PrismaClient } from '@prisma/client';
import { Resend } from 'resend';
import { getUnreadForEmailFallback, markEmailSent } from './notifications';
import { shouldEmailStudent } from './notification-policy';
import { renderNotificationEmail } from '@/lib/email-templates';
import { emailDryRun } from '@/lib/email';
import { log } from '@/lib/log';

// Lazy for the same reason as lib/email: a keyless environment must be
// able to import this module (the dry-run path never constructs).
let resendClient: Resend | null = null;
function resend(): Resend {
  return (resendClient ??= new Resend(process.env.RESEND_API_KEY));
}

/**
 * Processes unread notifications eligible for email fallback.
 * Looks up recipient email, checks email preferences, sends email, marks as sent.
 */
export async function processEmailFallback(
  db: PrismaClient,
): Promise<number> {
  const notifications = await getUnreadForEmailFallback(db, 30);

  if (notifications.length === 0) return 0;

  let sent = 0;
  let failed = 0;

  // Mark each notification immediately after its send: batching the marks
  // at the end meant one failed batch-update re-emailed every recipient on
  // every 5-minute sweep. Worst case now is a single duplicate.
  const markOne = async (id: string) => {
    try {
      await markEmailSent(db, [id]);
    } catch (err) {
      log.error({ err, notificationId: id }, 'failed to mark email-sent (may re-send once)');
    }
  };

  for (const notification of notifications) {
    // Look up recipient email and preferences
    let email: string | null = null;
    let emailEnabled = true;

    if (notification.recipientType === 'teacher') {
      // No `deletedAt: null` here, unlike every reader that surfaces a
      // teacher to another person as a live counterparty (`(public)/[slug]`,
      // `(public)/[slug]/book/[classId]`, `validateSession`,
      // `payment-reminders`, `acceptInvitation`). This one is not that read —
      // it emails the teacher their OWN notification — and it is safe by an
      // upstream guarantee rather than by anything visible here. Written down
      // because the next person to touch either end needs to know what they
      // are holding up:
      //
      // 1. `deleteTeacherAccount` (services/gdpr.ts) deletes every
      //    `recipientType: 'teacher'` Notification for the erased teacher in
      //    the SAME transaction that sets `deletedAt`, and cancels every
      //    draft/open/in_progress class of theirs in it too. Of the three
      //    writers of a teacher-recipient notification, two gate on one of
      //    those statuses under the class row lock that transaction holds
      //    (`POST /api/registrations`, `class-transitions`' auto-cancel), so
      //    no fresh one can be written afterwards. **`completeClass` is the
      //    exception: it reads its class without `FOR UPDATE`**, so a sweep
      //    already inside it can commit after the `deleteMany`. That is the
      //    same window (2) covers, and it is filed as #174 — which also
      //    records the larger consequence, that such a sweep can flip a
      //    `cancelled` class back to `completed` and create `Payment` rows
      //    against it.
      // 2. The same transaction rewrites `Teacher.email` to
      //    `deleted-<id>@deleted.invalid`. So even a row that slipped through
      //    — a transition sweep committing its `completeClass` in the instant
      //    after that `deleteMany` is the one window — carries no real
      //    address to send to.
      //
      // A `deletedAt` filter is deliberately NOT added: with (1) holding,
      // nothing could drive it, and an untestable guard is what this branch
      // has already shipped too many of.
      const teacher = await db.teacher.findUnique({
        where: { id: notification.recipientId },
        select: { email: true },
      });
      email = teacher?.email ?? null;
    } else {
      const student = await db.student.findUnique({
        where: { id: notification.recipientId },
        select: { email: true, emailNotifications: true },
      });
      email = student?.email ?? null;
      emailEnabled = shouldEmailStudent(
        notification.type,
        student?.emailNotifications ?? true,
      );
    }

    if (!email || !emailEnabled) {
      // "recipient-missing" is data loss (the profile is gone); "opted-out"
      // is correct consent behavior — the log line is what tells them apart.
      log.info(
        {
          notificationId: notification.id,
          recipientType: notification.recipientType,
          reason: !email ? 'recipient-missing' : 'opted-out',
        },
        'email fallback skipped',
      );
      // Mark as sent to avoid retrying
      await markOne(notification.id);
      sent++;
      continue;
    }

    if (emailDryRun()) {
      log.info({ to: email, title: notification.title }, 'email fallback dry-run');
      await markOne(notification.id);
      sent++;
      continue;
    }

    try {
      // Branded template; escapes teacher-authored bodies so markup or
      // phishing HTML never renders in a platform email.
      const { subject, html } = renderNotificationEmail(notification);
      const { error } = await resend().emails.send({
        from: process.env.EMAIL_FROM || 'noreply@fair.yoga',
        to: email,
        subject,
        html,
      });
      // The Resend SDK reports API failures via { error }, it does not throw —
      // an unchecked result would mark the notification sent when it wasn't.
      if (error) {
        log.error({ notificationId: notification.id, reason: error.message }, 'email fallback send failed');
        failed++;
        continue;
      }
      await markOne(notification.id);
      sent++;
    } catch (err) {
      log.error({ err, notificationId: notification.id }, 'email fallback send failed');
      failed++;
    }
  }

  // Surface failures to the caller: the scheduler records this as
  // lastError, so /api/health cannot show green through a send outage.
  if (failed > 0) {
    throw new Error(`email fallback: ${failed} of ${failed + sent} sends failed`);
  }

  return sent;
}
