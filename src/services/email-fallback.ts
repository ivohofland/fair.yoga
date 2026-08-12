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

  // One notification at a time, never a batch at the end: one failed
  // batch-update used to re-email every recipient on every 5-minute sweep.
  //
  // Where that single write falls relative to the send is the whole guard.
  // This service has two triggers — POST /api/cron/email-fallback and the
  // in-process scheduler, every 5 minutes from boot — and the candidate query
  // filters on `emailSent: false` without claiming anything, so overlapping
  // sweeps hold the same rows. Marking after the send de-duplicated the mark
  // and not the email. So the send branch below CLAIMS first and releases on
  // failure, which inverts the residual risk this comment used to record
  // ("worst case is a single duplicate"): a crash in the gap between claim and
  // send now drops one fallback email instead of duplicating one. Accepted in
  // the spec, because overlapping sweeps are routine while a crash inside that
  // gap is rare, and a dropped *fallback* leaves the in-app notification and
  // the inbox record intact — the message survives, only its second delivery
  // channel does not.
  //
  // The two non-send branches (opted-out, dry-run) keep marking after their
  // decision: there is no external effect to protect, so a lost mark there
  // only costs one reconsidered row on the next sweep.
  const markOne = async (id: string) => {
    try {
      await markEmailSent(db, [id]);
    } catch (err) {
      log.error({ err, notificationId: id }, 'failed to mark email-sent (will reconsider next sweep)');
    }
  };

  /**
   * Claims one notification, fail-closed. A throw here means we could not
   * record ownership, and "we could not record it" is not "we own it" — so the
   * caller must not send. `markOne` above logs and carries on, which was right
   * while a lost mark only risked a duplicate; as a claim it must fail closed.
   */
  const claimOne = async (id: string): Promise<'claimed' | 'taken' | 'error'> => {
    try {
      return (await markEmailSent(db, [id])) === 1 ? 'claimed' : 'taken';
    } catch (err) {
      log.error({ err, notificationId: id }, 'failed to claim notification for email fallback');
      return 'error';
    }
  };

  /** Hands a claim back after a failed send, so the next sweep retries it. */
  const releaseOne = async (id: string) => {
    try {
      await db.notification.updateMany({ where: { id }, data: { emailSent: false } });
    } catch (err) {
      log.error({ err, notificationId: id }, 'failed to release email-fallback claim (will not retry)');
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
      //    draft/open/in_progress class of theirs in it too. All three
      //    writers of a teacher-recipient notification now gate on one of
      //    those statuses under the class row lock that transaction holds:
      //    `POST /api/registrations` takes `FOR UPDATE` directly;
      //    `completeClass` and `class-transitions`' auto-cancel each take it
      //    via `lockClassRow`. So no fresh one can be written afterwards —
      //    for a class this transaction actually reaches. Its own `findMany`
      //    for `upcoming` classes runs unlocked, before the per-class CAS
      //    loop below it; a class created after that read is never touched
      //    by this transaction at all, so nothing here blocks a fresh
      //    notification for it — that gap is (2)'s to cover, not this one's.
      //    `completeClass` was the exception until #174 — it used to read
      //    its class without `FOR UPDATE`, so a sweep already inside it
      //    could commit after the `deleteMany`, flipping a `cancelled` class
      //    back to `completed` and creating `Payment` rows against it. #174
      //    closed that window by giving `completeClass` the lock, not
      //    merely by tracking it.
      // 2. The same transaction rewrites `Teacher.email` to
      //    `deleted-<id>@deleted.invalid`. Kept as a second line rather than
      //    deleted: it depends on neither of (1)'s two edges — a class
      //    created after `upcoming`'s unlocked read, or a regression in any
      //    of the three writers' own lock discipline — which is exactly what
      //    makes it cover both. So even a row that slipped through carries
      //    no real address to send to: `email` above still comes back
      //    truthy (the rewritten address, not null), so the send below is
      //    still attempted — nothing here stops that — it only guarantees
      //    the attempt lands on an address `.invalid` guarantees can never
      //    be delivered. (A `completeClass`-shaped regression gets a second,
      //    independent backstop too: `class_terminal_status_guard`, the DB
      //    trigger #174 also added, rejects the underlying
      //    `cancelled → completed` write outright, so no notification from
      //    that path is ever created — but it has nothing to say about the
      //    read-then-create gap above, which only this line covers.)
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

    // Claim before sending, per the block comment above: the row is the only
    // thing standing between two overlapping sweeps and two identical emails.
    //
    // Three outcomes, not two, and collapsing the last two would be a silent
    // failure. A claim that was TAKEN is another sweep doing its job — skip it
    // and report nothing. A claim that ERRORED sent no email either, but for a
    // reason nobody chose, so it has to reach `failed`: without that, a
    // claim-write outage skips every notification in turn and the sweep still
    // returns clean, which is precisely the green-health-through-an-outage the
    // `failed > 0` throw below exists to prevent. The old code could not have
    // this bug — its write came after the send, so a failing write still left
    // the email delivered.
    const claim = await claimOne(notification.id);
    if (claim === 'error') {
      failed++;
      continue;
    }
    if (claim === 'taken') continue;

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
      // an unchecked result would leave the claim standing on a notification
      // whose email never went out.
      if (error) {
        log.error({ notificationId: notification.id, reason: error.message }, 'email fallback send failed');
        await releaseOne(notification.id);
        failed++;
        continue;
      }
      sent++;
    } catch (err) {
      log.error({ err, notificationId: notification.id }, 'email fallback send failed');
      await releaseOne(notification.id);
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
