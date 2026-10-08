/**
 * Email templates — one calm, branded shell for every message.
 *
 * Same voice as the product: warm, clear, grounded. No marketing blocks,
 * no images, table-free layout that renders everywhere. Colors are the v2
 * palette inlined (email clients ignore stylesheets).
 */

import type { Currency, NotificationType, PayoutChangeKind } from '@prisma/client';
import type { PayGuidance } from './payment-methods';
import {
  STUDENT_INVITATION_LABEL,
  STUDENT_INVITATION_PATH,
  STUDENT_BOOKINGS_LABEL,
  STUDENT_BOOKINGS_PATH,
  TEACHER_INVITATION_LABEL,
  TEACHER_INVITATION_PATH,
  PAY_NOW_LABEL,
  isPaymentNotification,
  payPagePath,
} from './notification-links';
import { logDegraded } from './degradation';

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const UNREAD_FALLBACK_FOOTER =
  'You get emails like this when an in-app message goes unread; turn them off in your settings.';

/** Footer for a class reminder, sent at its moment because the reader chose email for reminders. */
export const CLASS_REMINDER_EMAIL_FOOTER =
  'You get this email because you chose class reminders by email; change that in your notification settings.';

/** The shared shell: wordmark, one content block, quiet footer. */
export function wrapEmail(
  heading: string,
  bodyHtml: string,
  footer: string = UNREAD_FALLBACK_FOOTER,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background-color:#F7F4EF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif;color:#6B5B4E;">
  <div style="max-width:520px;margin:0 auto;padding:32px 16px;">
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:20px;color:#2D2D2D;margin-bottom:24px;">fair<span style="color:#1A5653;">.</span>yoga</div>
    <div style="background-color:#F0E9DC;border:1px solid #D4C9B8;border-radius:16px;padding:24px;">
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:700;font-size:20px;line-height:1.3;color:#1A5653;margin:0 0 12px;">${heading}</h1>
      <div style="font-size:16px;line-height:1.55;color:#6B5B4E;">${bodyHtml}</div>
    </div>
    <p style="font-size:13px;line-height:1.4;color:#71645A;margin:24px 0 0;">
      fair.yoga — free, open tools for independent yoga teachers.<br>
      ${escapeHtml(footer)}
    </p>
  </div>
</body>
</html>`;
}

/**
 * Per-type framing line shown above the notification body — keyed by who
 * is reading. The same type reads differently across the counter:
 * booking_confirmed is "your booking" to the student but "a student
 * booked" to the teacher.
 */
const STUDENT_INTROS: Record<NotificationType, string> = {
  booking_confirmed: 'Your booking is confirmed.',
  booking_cancelled: 'Your booking was cancelled.',
  booking_removed: 'Your teacher cancelled your booking.',
  class_cancelled: 'A class was cancelled.',
  payment_received: 'A payment was received.',
  payment_request: 'A class has been priced — here is your share.',
  waitlist_promoted: 'Good news from the waitlist.',
  spot_available: 'A spot opened up.',
  spot_taken: 'A spot you were waiting for has been taken.',
  reminder: 'A gentle reminder.',
  announcement: 'A message from your teacher.',
  teacher_invitation: 'A teacher would like to connect with you.',
  walk_in_added: 'Your teacher added you to a class.',
  class_reminder: 'Your class is coming up.',
};

const TEACHER_INTROS: Partial<Record<NotificationType, string>> = {
  booking_confirmed: 'A student booked your class.',
  class_cancelled: 'One of your classes was cancelled.',
  payment_received: 'A payment was received.',
  payment_request: 'A class has been priced.',
  reminder: 'A gentle reminder.',
  class_reminder: 'You have a class coming up.',
};

/**
 * Types whose email needs somewhere to go, keyed by the reader — a fallback
 * email, or a class reminder's own.
 *
 * Most notifications about a class stay linkless below: the class routes
 * they would point at are teacher-only. An invitation exists to ask someone
 * for a decision, and the mail that arrives when they miss the in-app one
 * has to reach the place that decision is made. A waitlist promotion or a
 * freed-spot broadcast (#236) is likewise meant to be acted on quickly, and
 * `/bookings` is a student route. A class reminder points at `/bookings`,
 * the student's own list of what they booked, because the class route it is
 * about is teacher-only. A payment notification is not in this map: its link
 * names its own class, so `studentAction` builds it.
 *
 * Path only. The base URL is the caller's, so this stays renderable without
 * an environment.
 *
 * A walk-in points at `/login` rather than `/bookings`: the recipient may
 * have no account yet.
 */
const STUDENT_ACTION_LINKS: Partial<Record<NotificationType, { label: string; path: string }>> = {
  teacher_invitation: { label: STUDENT_INVITATION_LABEL, path: STUDENT_INVITATION_PATH },
  waitlist_promoted: { label: STUDENT_BOOKINGS_LABEL, path: STUDENT_BOOKINGS_PATH },
  spot_available: { label: STUDENT_BOOKINGS_LABEL, path: STUDENT_BOOKINGS_PATH },
  walk_in_added: { label: 'Sign in', path: '/login' },
  class_reminder: { label: STUDENT_BOOKINGS_LABEL, path: STUDENT_BOOKINGS_PATH },
};

/**
 * The teacher reader's counterpart to `STUDENT_ACTION_LINKS` (#172). A class
 * reminder opens the schedule.
 */
const TEACHER_ACTION_LINKS: Partial<Record<NotificationType, { label: string; path: string }>> = {
  teacher_invitation: { label: TEACHER_INVITATION_LABEL, path: TEACHER_INVITATION_PATH },
  class_reminder: { label: 'Open your schedule', path: '/schedule' },
};

export interface NotificationEmailInput {
  /** The notification's row id, when it has one; names it in a degradation log line. */
  id?: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Defaults to the student framing when absent. */
  recipientType?: 'teacher' | 'student';
  /** The class a notification is about; with `payGuidance`, gives a payment notification its pay link. */
  relatedClassId?: string | null;
  /**
   * What the class's teacher lets a student do about paying, read at send
   * time (`payGuidanceFor`). A student payment notification gets its Pay now
   * button only when this is `'methods'`.
   */
  payGuidance?: PayGuidance;
}

/**
 * A student email's action. A payment notification gets its class's pay page
 * when both the class and a live teacher payment method are known, and otherwise no
 * link; any other type gets its fixed one.
 */
function studentAction(
  notification: NotificationEmailInput,
): { label: string; path: string } | undefined {
  if (isPaymentNotification(notification.type)) {
    if (!notification.relatedClassId) {
      logDegraded(
        'PAYMENT_NOTIFICATION_WITHOUT_CLASS',
        { notificationId: notification.id, type: notification.type },
        'payment notification has no related class; emailed without a Pay now button',
      );
      return undefined;
    }
    return notification.payGuidance === 'methods'
      ? { label: PAY_NOW_LABEL, path: payPagePath(notification.relatedClassId) }
      : undefined;
  }
  return STUDENT_ACTION_LINKS[notification.type];
}

/**
 * Renders the email for a notification: an unread one's layer 3 fallback, or
 * a class reminder sent directly. `footer` replaces the fallback footer.
 *
 * `baseUrl` defaults from the environment the same way `notifyInvitee`
 * (services/invitations.ts) builds its own sign-in link, so existing
 * callers need not thread it through; tests pass an explicit value.
 */
export function renderNotificationEmail(
  notification: NotificationEmailInput,
  baseUrl: string = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  footer?: string,
): {
  subject: string;
  html: string;
} {
  const intro =
    notification.recipientType === 'teacher'
      ? (TEACHER_INTROS[notification.type] ?? STUDENT_INTROS[notification.type])
      : STUDENT_INTROS[notification.type];
  const action =
    notification.recipientType === 'teacher'
      ? TEACHER_ACTION_LINKS[notification.type]
      : studentAction(notification);
  const actionHtml = action
    ? `<p style="margin:16px 0 0;"><a href="${baseUrl}${action.path}" style="display:inline-block;background-color:#1A5653;color:#F7F4EF;text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:999px;">${escapeHtml(action.label)}</a></p>`
    : '';
  const html = wrapEmail(
    escapeHtml(notification.title),
    `<p style="margin:0 0 8px;color:#71645A;font-size:13px;">${escapeHtml(intro)}</p>
     <p style="margin:0;">${escapeHtml(notification.body)}</p>${actionHtml}`,
    footer,
  );
  return { subject: notification.title, html };
}

/** The sign-in email: one link, one expiry note, nothing else. */
export function renderMagicLinkEmail(magicLink: string): { subject: string; html: string } {
  const html = wrapEmail(
    'Sign in to fair.yoga',
    `<p style="margin:0 0 16px;">Tap the button and you're in — no password.</p>
     <p style="margin:0 0 16px;"><a href="${magicLink}" style="display:inline-block;background-color:#1A5653;color:#F7F4EF;text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:999px;">Sign in</a></p>
     <p style="margin:0;font-size:13px;color:#71645A;">This link works once and expires in 15 minutes. If you didn't request it, you can ignore this email.</p>`,
  );
  return { subject: 'Sign in to fair.yoga', html };
}

/**
 * The invitation email: sent when a teacher adds someone as a contact and
 * the address has neither a `Student` row nor a teacher account
 * (`notifyInvitee`, services/invitations.ts).
 *
 * Same copy regardless of whether the address is already registered
 * elsewhere on fair.yoga — this function only ever runs for an address with
 * no in-app surface, but the wording itself must not carry a "welcome back"
 * that would leak that distinction if this ever gets reused. `teacherName` is
 * escaped: it is teacher-authored (their own first/last name), not sanitised
 * on write, same reasoning as `renderNotificationEmail` escaping a teacher's
 * announcement body.
 */
export function renderInvitationEmail(
  teacherName: string,
  signInUrl: string,
): { subject: string; html: string } {
  const subject = `${teacherName} would like to connect on fair.yoga`;
  const html = wrapEmail(
    'A teacher would like to connect',
    `<p style="margin:0 0 16px;">${escapeHtml(teacherName)} added you as a contact on fair.yoga, a free tool independent yoga teachers use to run their classes. You choose whether to connect.</p>
     <p style="margin:0 0 16px;"><a href="${signInUrl}" style="display:inline-block;background-color:#1A5653;color:#F7F4EF;text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:999px;">Sign in</a></p>
     <p style="margin:0;font-size:13px;color:#71645A;">If you weren't expecting this, you can ignore this email.</p>`,
  );
  return { subject, html };
}

/**
 * The notice sent after a passkey is added: what happened, when, and where to
 * undo it. No link and no token — a message about a credential being added is
 * exactly what a forged copy would imitate, so the way out is named in words
 * for the reader to navigate to themselves.
 */
export function renderPasskeyAddedEmail(addedAt: Date): { subject: string; html: string } {
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(addedAt);
  const subject = 'A passkey was added to your fair.yoga account';
  const html = wrapEmail(
    'A passkey was added',
    `<p style="margin:0 0 16px;">A passkey was added to your fair.yoga account on ${escapeHtml(when)} UTC. It can now sign in to your account.</p>
     <p style="margin:0;">If that was you, there is nothing to do. If it was not, sign in, find your passkeys under Settings → Profile if you teach (under Account if you are a student), remove the passkey and choose sign out everywhere.</p>`,
  );
  return { subject, html };
}

/**
 * The notice sent after a passkey is removed. No link, for the reason
 * `renderPasskeyAddedEmail` gives.
 */
export function renderPasskeyRemovedEmail(removedAt: Date): { subject: string; html: string } {
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(removedAt);
  const subject = 'A passkey was removed from your fair.yoga account';
  const html = wrapEmail(
    'A passkey was removed',
    `<p style="margin:0 0 16px;">A passkey was removed from your fair.yoga account on ${escapeHtml(when)} UTC. It can no longer sign in to your account.</p>
     <p style="margin:0;">If that was you, there is nothing to do. If it was not, someone else is signed in to your account: sign in, choose sign out everywhere under Settings → Profile if you teach (under Account if you are a student), and check your payment details.</p>`,
  );
  return { subject, html };
}

export interface PayoutChangedEmailInput {
  kind: PayoutChangeKind;
  accountCurrency: Currency | null;
  before: string | null;
  after: string | null;
  identifierChanged: boolean | null;
  at: Date;
  timezone: string;
  pauseUrl: string;
}

/** Sent on every payout change, whatever the notification settings say, so the default footer's opt-out claim would be false. */
const PAYOUT_CHANGED_FOOTER = 'You get this email whenever your payout details change; it is not optional.';

/** What happened, as the sentence's predicate, per kind. */
export const PAYOUT_CHANGE_PHRASES = {
  bank_account_added: 'A bank account was added',
  bank_account_changed: 'A bank account was changed',
  bank_account_removed: 'A bank account was removed',
  payment_link_added: 'A payment link was added',
  payment_link_changed: 'A payment link was changed',
  payment_link_removed: 'A payment link was removed',
} as const satisfies Record<PayoutChangeKind, string>;

/**
 * The warning for a change whose before and after mask to the same string
 * while the full value changed (or nothing says it did not): the mask hides
 * exactly the part of the value someone else would choose.
 */
const PAYOUT_MASKS_ALIKE_WARNING = {
  bank_account_changed: 'The account number changed to a different one that ends in the same digits.',
  payment_link_changed: 'The new link looks like the old one here, but it is a different link. Check it in full in your settings.',
} as const satisfies Partial<Record<PayoutChangeKind, string>>;

/** A note explaining why before and after look alike: reassuring only when the full identifier did not change. */
export type PayoutMasksAlikeNote = { tone: 'same_identifier' | 'warning'; text: string };

/**
 * The note for a change event whose before and after mask alike, or null when
 * they differ or the kind has no before and after. Only a bank change whose
 * writer recorded `identifierChanged: false` reassures; every other alike
 * change, an unrecorded one included, warns.
 */
export function payoutMasksAlikeNote(event: {
  kind: PayoutChangeKind;
  before: string | null;
  after: string | null;
  identifierChanged: boolean | null;
}): PayoutMasksAlikeNote | null {
  if (event.before === null || event.before !== event.after) return null;
  if (!(event.kind in PAYOUT_MASKS_ALIKE_WARNING)) return null;
  if (event.kind === 'bank_account_changed' && event.identifierChanged === false) {
    return { tone: 'same_identifier', text: 'Before and after look the same here because a detail other than the account number changed.' };
  }
  return { tone: 'warning', text: PAYOUT_MASKS_ALIKE_WARNING[event.kind as keyof typeof PAYOUT_MASKS_ALIKE_WARNING] };
}

function formatInZoneOrUtc(at: Date, timezone: string): string {
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).format(at);
  try {
    return format(timezone);
  } catch {
    return format('UTC');
  }
}

/**
 * The alert sent when where a teacher's students pay changes: what changed,
 * the masked before and after, when, and a **This wasn't me** button.
 *
 * Unlike `renderPasskeyAddedEmail`, this one carries a link, on purpose
 * (`docs/superpowers/specs/2026-10-08-payout-change-alert-design.md`,
 * Decision 2): the link holds no credential and signs no one in, and the most
 * it can do is pause payments, which fails toward safety. The secret rides in
 * the URL fragment, so it never reaches a server log or a Referer.
 *
 * Every interpolated value is escaped. `before`/`after` are masked strings
 * built from teacher input, and `pauseUrl` is escaped as an attribute.
 */
export function renderPayoutChangedEmail(input: PayoutChangedEmailInput): { subject: string; html: string } {
  const subject = 'Your payout details changed on fair.yoga';
  const when = formatInZoneOrUtc(input.at, input.timezone);
  const isBank = input.kind.startsWith('bank_account');
  const what =
    PAYOUT_CHANGE_PHRASES[input.kind] +
    (isBank && input.accountCurrency !== null ? ` (${input.accountCurrency})` : '');
  const alike = payoutMasksAlikeNote(input);
  const lines: string[] = [];
  if (alike !== null) {
    lines.push(`Shown as: ${escapeHtml(input.before ?? '')}`);
    lines.push(escapeHtml(alike.text));
  } else {
    if (input.before !== null) lines.push(`Before: ${escapeHtml(input.before)}`);
    if (input.after !== null) lines.push(`After: ${escapeHtml(input.after)}`);
  }
  const html = wrapEmail(
    'Your payout details changed',
    `<p style="margin:0 0 16px;">${escapeHtml(what)} on your fair.yoga account on ${escapeHtml(when)}.</p>
     <p style="margin:0 0 16px;">${lines.join('<br>')}</p>
     <p style="margin:0 0 16px;">If that was you, there is nothing to do. If it was not, pause payments now: students are told to hold off, and every device is signed out.</p>
     <p style="margin:0 0 16px;"><a href="${escapeHtml(input.pauseUrl)}" style="display:inline-block;background-color:#1A5653;color:#F7F4EF;text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:999px;">This wasn't me</a></p>
     <p style="margin:0;font-size:13px;color:#71645A;">The link works for 14 days and pauses payments only; it does not sign anyone in.</p>`,
    PAYOUT_CHANGED_FOOTER,
  );
  return { subject, html };
}

export interface DegradationDigestEntry {
  code: string;
  description: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrences: number;
  sample: Readonly<Record<string, unknown>>;
}

const DEGRADATION_DIGEST_FOOTER =
  'You get this because OPERATOR_EMAIL is set on this server. What each code means: docs/degradation-sites.md.';

/** The operator's digest: one block per degradation that fired since they were last told. */
export function renderDegradationDigestEmail(entries: readonly DegradationDigestEntry[]): {
  subject: string;
  html: string;
} {
  const subject =
    entries.length === 1
      ? `fair.yoga: ${entries[0]!.code} fired`
      : `fair.yoga: ${entries.length} degradations fired`;

  const blocks = entries
    .map((e) => {
      const sample = Object.entries(e.sample)
        .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(String(v))}`)
        .join(' · ');
      return `<div style="margin:0 0 16px;">
        <p style="margin:0;font-weight:700;color:#1A5653;">${escapeHtml(e.code)}</p>
        <p style="margin:4px 0;">${escapeHtml(e.description)}</p>
        <p style="margin:0;color:#71645A;font-size:13px;">First seen ${escapeHtml(e.firstSeenAt.toISOString())} · last seen ${escapeHtml(e.lastSeenAt.toISOString())} · about ${e.occurrences} times</p>
        ${sample ? `<p style="margin:4px 0 0;color:#71645A;font-size:13px;">Latest: ${sample}</p>` : ''}
      </div>`;
    })
    .join('');

  return {
    subject,
    html: wrapEmail('A fallback fired', blocks, DEGRADATION_DIGEST_FOOTER),
  };
}
