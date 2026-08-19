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
import { getUnreadForEmailFallback, claimEmailFallback } from './notifications';
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
  // Claims that could not be handed back — see `releaseOne` and the throw at
  // the bottom, which names them separately because they are the one outcome
  // here that no later sweep can put right.
  let stranded = 0;

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
  // The two non-send branches (opted-out, dry-run) mark AFTER their decision
  // rather than claiming before it: there is no external effect to protect, so
  // ordering buys nothing and a lost mark costs one reconsidered row.
  //
  // But it still reports a write failure, for the same reason `claimOne` does
  // below. It used to swallow one, and the argument for that ("a lost mark
  // only costs a duplicate") is about duplicates and silent about health:
  // `processEmailFallback` returning cleanly does not merely fail to raise the
  // outage, it makes `scheduler.ts` CLEAR `lastError`. So a sweep whose
  // candidates are all opted-out — the ordinary shape under EMAIL_DRY_RUN —
  // could turn a database that cannot accept writes into a green
  // `/api/health`, one row at a time, every five minutes.
  const markOne = async (id: string): Promise<'marked' | 'error'> => {
    try {
      await claimEmailFallback(db, id);
      return 'marked';
    } catch (err) {
      log.error({ err, notificationId: id }, 'failed to mark email-sent (will reconsider next sweep)');
      return 'error';
    }
  };

  /**
   * Claims one notification, fail-closed. A throw here means we could not
   * record ownership, and "we could not record it" is not "we own it" — so the
   * caller must not send. `markOne` above logs and carries on, which was right
   * while a lost mark only risked a duplicate; as a claim it must fail closed.
   *
   * `'already-claimed'` rather than `'taken'`: the two words were near
   * synonyms, and at the call site `claim === 'taken'` read as though it might
   * be the success case.
   */
  const claimOne = async (id: string): Promise<'claimed' | 'already-claimed' | 'error'> => {
    try {
      return await claimEmailFallback(db, id);
    } catch (err) {
      log.error({ err, notificationId: id }, 'failed to claim notification for email fallback');
      return 'error';
    }
  };

  /**
   * Hands a claim back after a failed send so the next sweep can retry it —
   * when the release itself succeeds. It swallows its own failure (there is
   * nothing useful to do with it mid-sweep), and a swallowed one strands the
   * notification as `emailSent: true` with no email ever sent, permanently:
   * the candidate query filters on `emailSent: false`, so it is never a
   * candidate again. Hence the log line's "(will not retry)", and hence
   * `stranded`, which carries that fact out to the operator in the throw
   * below — a log line alone is only read by someone already looking.
   *
   * `emailSent: true` in the WHERE, so this says "hand back MY claim" rather
   * than "set this false". Defensive rather than load-bearing, and worth being
   * exact about which: only the owner ever releases, and no other sweep can
   * claim a row while `emailSent` is true, so the race a looser predicate
   * would lose to cannot occur today. The count check below is what would tell
   * us if that ever stopped being true.
   *
   * Both failure shapes strand the row identically — `emailSent: true` with no
   * email sent, invisible to the candidate query for ever — so both count. A
   * throw is the DB refusing; a zero count is the row not being ours to
   * release, which today means it was deleted underneath us.
   */
  const releaseOne = async (id: string) => {
    try {
      const { count } = await db.notification.updateMany({
        where: { id, emailSent: true },
        data: { emailSent: false },
      });
      if (count === 0) {
        stranded++;
        log.error(
          { notificationId: id },
          'email-fallback claim was not ours to release (will not retry)',
        );
      }
    } catch (err) {
      stranded++;
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
      //    `POST /api/registrations`, `completeClass` and `class-transitions`'
      //    auto-cancel each take it via `lockClassRow`. So no fresh one can
      //    be written afterwards — for a class this transaction actually
      //    reaches. Its own `findMany`
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
      if ((await markOne(notification.id)) === 'error') failed++;
      else sent++;
      continue;
    }

    if (emailDryRun()) {
      log.info({ to: email, title: notification.title }, 'email fallback dry-run');
      if ((await markOne(notification.id)) === 'error') failed++;
      else sent++;
      continue;
    }

    // Claim before sending, per the block comment above: the row is the only
    // thing standing between two overlapping sweeps and two identical emails.
    //
    // Three outcomes, not two, and collapsing any two would be a silent
    // failure. An ALREADY-CLAIMED row is another sweep doing its job — skip it
    // and report nothing. A claim that ERRORED sent no email either, but for a
    // reason nobody chose, so it has to reach `failed`: without that, a
    // claim-write outage skips every notification in turn and the sweep still
    // returns clean, which is precisely the green-health-through-an-outage the
    // `failed > 0` throw below exists to prevent. The old code could not have
    // this bug — its write came after the send, so a failing write still left
    // the email delivered.
    //
    // A `switch` closed by `const unhandled: never`, not the chain of `if`s
    // this used to be, because what follows the chain is the SEND: a fourth
    // outcome added to `claimOne` fell past both `if`s and emailed a
    // notification nobody had decided this sweep owned. The `never` makes
    // adding one a compile error here (the project's idiom — `lib/format.ts`,
    // `api/classes/[id]/route.ts`), and `owned` makes the runtime default
    // not-sending rather than sending, so the two failure modes are covered by
    // different mechanisms.
    const claim = await claimOne(notification.id);
    let owned = false;
    switch (claim) {
      case 'claimed':
        owned = true;
        break;
      case 'already-claimed':
        break;
      case 'error':
        failed++;
        break;
      default: {
        // Unreachable while the union has exactly the three members above —
        // the assignment below is what keeps it that way. Fail closed at
        // runtime anyway: an outcome nobody wrote a branch for is not
        // permission to send, and it is a defect, so it reaches `failed`.
        const unhandled: never = claim;
        log.error(
          { notificationId: notification.id, claim: String(unhandled) },
          'unhandled email-fallback claim outcome',
        );
        failed++;
        break;
      }
    }
    if (!owned) continue;

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
  //
  // Stranded releases are named separately because they are a different kind
  // of news. "N of M sends failed" reads as retryable, and for a released
  // claim it is — the next sweep picks the row up again. A claim that could
  // not be handed back is not: the row keeps `emailSent: true` with no email
  // ever sent, the candidate query never returns it again, and no sweep will
  // fix it without someone clearing the flag by hand. An operator who is not
  // told that reads the same sentence for both and waits for a retry that
  // cannot come.
  //
  // `stranded > 0` is in the condition rather than trusted to imply
  // `failed > 0`. Both release call sites happen to sit beside a `failed++`
  // today, so the implication holds — but it holds by arrangement, not by
  // construction, and a third call site added without one would make the
  // permanent loss the unreportable case. Enforced, not asserted.
  if (failed > 0 || stranded > 0) {
    const strandedNote =
      stranded > 0
        ? `; ${stranded} claim(s) could not be released and will never be retried`
        : '';
    throw new Error(`email fallback: ${failed} of ${failed + sent} sends failed${strandedNote}`);
  }

  return sent;
}
