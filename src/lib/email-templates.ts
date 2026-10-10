/**
 * Email templates — one calm, branded shell for every message.
 *
 * Same voice as the product: warm, clear, grounded. No marketing blocks,
 * no images, table-free layout that renders everywhere. Colors are the v2
 * palette inlined (email clients ignore stylesheets).
 */

import type { Currency, NotificationType, PayoutChangeKind } from '@prisma/client';
import type { PayGuidance } from './payment-methods';
import { PAUSE_TOKEN_TTL_DAYS } from '@/services/payout-pause-token';
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

/** Footer for an email sent because an in-app message went unread. */
export const UNREAD_FALLBACK_FOOTER =
  'You get emails like this when an in-app message goes unread; turn them off in your settings. Replies to this email are not read.';

/** Footer for a class reminder, sent at its moment because the reader chose email for reminders. */
export const CLASS_REMINDER_EMAIL_FOOTER =
  'You get this email because you chose class reminders by email; change that in your notification settings. Replies to this email are not read.';

/** Footer for an invitation: the reader did not ask for this mail. */
export const INVITATION_FOOTER =
  'You get this email because a teacher on fair.yoga added your address. Replies to this email are not read.';

/** Footer for mail about the reader's own account: sign-in links and credential notices. */
export const ACCOUNT_ACTIVITY_FOOTER = 'You get this email because of activity on your fair.yoga account.';

export type RenderedEmail = { subject: string; html: string; text: string };
export type ParagraphTone = 'body' | 'intro' | 'note' | 'strong';
export type EmailBlock =
  | { kind: 'paragraph'; lines: readonly string[]; tone?: ParagraphTone }
  | { kind: 'button'; label: string; href: string };

const WORDMARK_LINE = 'fair.yoga — free, open tools for independent yoga teachers.';
const BUTTON_STYLE =
  'display:inline-block;background-color:#1A5653;color:#F7F4EF;text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:999px;';
const TONE_STYLE = {
  body: '',
  intro: 'color:#71645A;font-size:13px;',
  note: 'color:#71645A;font-size:13px;',
  strong: 'font-weight:700;color:#1A5653;',
} satisfies Record<ParagraphTone, string>;

function blockHtml(block: EmailBlock, last: boolean): string {
  switch (block.kind) {
    case 'paragraph': {
      const tone = block.tone ?? 'body';
      const margin = last ? '0' : tone === 'intro' ? '0 0 8px' : '0 0 16px';
      return `<p style="margin:${margin};${TONE_STYLE[tone]}">${block.lines.map(escapeHtml).join('<br>')}</p>`;
    }
    case 'button':
      return `<p style="margin:${last ? '0' : '0 0 16px'};"><a href="${escapeHtml(block.href)}" style="${BUTTON_STYLE}">${escapeHtml(block.label)}</a></p>`;
    default: {
      const unhandled: never = block;
      return unhandled;
    }
  }
}

function blockText(block: EmailBlock): string {
  switch (block.kind) {
    case 'paragraph':
      return block.lines.join('\n');
    case 'button':
      return `${block.label}: ${block.href}`;
    default: {
      const unhandled: never = block;
      return unhandled;
    }
  }
}

/**
 * The shared shell — wordmark, one content card, quiet footer — rendered as
 * html and as text from the same blocks. Every string a block carries is
 * plain text and is escaped here, once. `unsubscribeUrl`, when given, adds an
 * Unsubscribe link under the footer in both renderings.
 */
export function wrapEmail(
  heading: string,
  blocks: readonly EmailBlock[],
  footer: string,
  unsubscribeUrl?: string,
): { html: string; text: string } {
  const body = blocks.map((b, i) => blockHtml(b, i === blocks.length - 1)).join('\n      ');
  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background-color:#F7F4EF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,Helvetica,sans-serif;color:#6B5B4E;">
  <div style="max-width:520px;margin:0 auto;padding:32px 16px;">
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:20px;color:#2D2D2D;margin-bottom:24px;">fair<span style="color:#1A5653;">.</span>yoga</div>
    <div style="background-color:#F0E9DC;border:1px solid #D4C9B8;border-radius:16px;padding:24px;">
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:700;font-size:20px;line-height:1.3;color:#1A5653;margin:0 0 12px;">${escapeHtml(heading)}</h1>
      <div style="font-size:16px;line-height:1.55;color:#6B5B4E;">${body}</div>
    </div>
    <p style="font-size:13px;line-height:1.4;color:#71645A;margin:24px 0 0;">
      ${WORDMARK_LINE}<br>
      ${escapeHtml(footer)}${
        unsubscribeUrl === undefined
          ? ''
          : `<br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#1A5653;">Unsubscribe</a>`
      }
    </p>
  </div>
</body>
</html>`;
  const footerText = unsubscribeUrl === undefined ? footer : `${footer}\nUnsubscribe: ${unsubscribeUrl}`;
  const text = [heading, ...blocks.map(blockText), `${WORDMARK_LINE}\n${footerText}`].join('\n\n') + '\n';
  return { html, text };
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
 * when both the class and a teacher payment method in use (payments not paused) are known, and otherwise no
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
 * a class reminder sent directly. `footer` replaces the fallback footer;
 * `unsubscribeUrl` adds the footer's Unsubscribe link.
 * Every string is plain; `wrapEmail` escapes it.
 *
 * `baseUrl` defaults from the environment the same way `notifyInvitee`
 * (services/invitations.ts) builds its own sign-in link, so existing
 * callers need not thread it through; tests pass an explicit value.
 */
export function renderNotificationEmail(
  notification: NotificationEmailInput,
  baseUrl: string = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  footer: string = UNREAD_FALLBACK_FOOTER,
  unsubscribeUrl?: string,
): RenderedEmail {
  const intro =
    notification.recipientType === 'teacher'
      ? (TEACHER_INTROS[notification.type] ?? STUDENT_INTROS[notification.type])
      : STUDENT_INTROS[notification.type];
  const action =
    notification.recipientType === 'teacher'
      ? TEACHER_ACTION_LINKS[notification.type]
      : studentAction(notification);
  const blocks: EmailBlock[] = [
    { kind: 'paragraph', tone: 'intro', lines: [intro] },
    { kind: 'paragraph', lines: [notification.body] },
  ];
  if (action) blocks.push({ kind: 'button', label: action.label, href: `${baseUrl}${action.path}` });
  return { subject: notification.title, ...wrapEmail(notification.title, blocks, footer, unsubscribeUrl) };
}

/** The sign-in email: one link, one expiry note, nothing else. */
export function renderMagicLinkEmail(magicLink: string): RenderedEmail {
  return {
    subject: 'Sign in to fair.yoga',
    ...wrapEmail(
      'Sign in to fair.yoga',
      [
        { kind: 'paragraph', lines: ["Tap the button and you're in — no password."] },
        { kind: 'button', label: 'Sign in', href: magicLink },
        {
          kind: 'paragraph',
          tone: 'note',
          lines: ["This link works once and expires in 15 minutes. If you didn't request it, you can ignore this email."],
        },
      ],
      ACCOUNT_ACTIVITY_FOOTER,
    ),
  };
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
 * teacher-authored (their own first/last name) and not sanitised on write;
 * `wrapEmail` escapes it for html and leaves it verbatim in the text.
 *
 * `unsubscribeUrl`, when given, is passed to `wrapEmail` as the footer's
 * unsubscribe link; without it the footer has none.
 */
export function renderInvitationEmail(
  teacherName: string,
  signInUrl: string,
  unsubscribeUrl?: string,
): RenderedEmail {
  return {
    subject: `${teacherName} would like to connect on fair.yoga`,
    ...wrapEmail(
      'A teacher would like to connect',
      [
        {
          kind: 'paragraph',
          lines: [
            `${teacherName} added you as a contact on fair.yoga, a free tool independent yoga teachers use to run their classes. You choose whether to connect.`,
          ],
        },
        { kind: 'button', label: 'Sign in', href: signInUrl },
        { kind: 'paragraph', tone: 'note', lines: ["If you weren't expecting this, you can ignore this email."] },
      ],
      INVITATION_FOOTER,
      unsubscribeUrl,
    ),
  };
}

/**
 * The notice sent after a passkey is added: what happened, when, and how to
 * undo it. The remedy is always named in words; when the caller minted a
 * `revokeUrl`, a **This wasn't me** button to it follows. That link holds no
 * credential and signs no one in, and `wrapEmail` escapes it as an attribute.
 * Design, Decisions 9 and 10:
 * docs/superpowers/specs/2026-10-10-passkey-added-sign-out-link-design.md
 */
export function renderPasskeyAddedEmail(addedAt: Date, revokeUrl: string | null = null): RenderedEmail {
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(addedAt);
  const blocks: EmailBlock[] = [
    { kind: 'paragraph', lines: [`A passkey was added to your fair.yoga account on ${when} UTC. It can now sign in to your account.`] },
    {
      kind: 'paragraph',
      lines: ['If that was you, there is nothing to do. If it was not, sign in, find your passkeys under Settings → Profile if you teach (under Account if you are a student), remove the passkey and choose sign out everywhere.'],
    },
  ];
  if (revokeUrl) {
    blocks.push(
      {
        kind: 'paragraph',
        lines: ['Or do it now: this signs you out on every device, cancels any sign-in links already sent, and removes this passkey where it can. Anyone who can read this inbox can still ask for a new sign-in link, so check your email account too.'],
      },
      { kind: 'button', label: "This wasn't me", href: revokeUrl },
    );
  }
  return {
    subject: 'A passkey was added to your fair.yoga account',
    ...wrapEmail('A passkey was added', blocks, ACCOUNT_ACTIVITY_FOOTER),
  };
}

/**
 * The notice sent after a passkey is removed. No link: a removal is not undone
 * by a button.
 */
export function renderPasskeyRemovedEmail(removedAt: Date): RenderedEmail {
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(removedAt);
  return {
    subject: 'A passkey was removed from your fair.yoga account',
    ...wrapEmail(
      'A passkey was removed',
      [
        { kind: 'paragraph', lines: [`A passkey was removed from your fair.yoga account on ${when} UTC. It can no longer sign in to your account.`] },
        {
          kind: 'paragraph',
          lines: ['If that was you, there is nothing to do. If it was not, someone else is signed in to your account: sign in, choose sign out everywhere under Settings → Profile if you teach (under Account if you are a student), and check your payment details.'],
        },
      ],
      ACCOUNT_ACTIVITY_FOOTER,
    ),
  };
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

/** The kinds that have both a before and an after to mask alike. */
type PayoutChangedKind = Extract<PayoutChangeKind, `${string}_changed`>;

/**
 * The warning for a change whose before and after mask to the same string
 * while the full value changed (or nothing says it did not): the mask hides
 * exactly the part of the value someone else would choose.
 */
const PAYOUT_MASKS_ALIKE_WARNING = {
  bank_account_changed: "The bank details changed, though the account number's last digits look the same. Check the full details in your settings.",
  payment_link_changed: 'The new link looks like the old one here, but it is a different link. Check it in full in your settings.',
} as const satisfies Record<PayoutChangedKind, string>;

function isChangedKind(kind: PayoutChangeKind): kind is PayoutChangedKind {
  return Object.hasOwn(PAYOUT_MASKS_ALIKE_WARNING, kind);
}

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
  const kind = event.kind;
  if (!isChangedKind(kind)) return null;
  if (kind === 'bank_account_changed' && event.identifierChanged === false) {
    return { tone: 'same_identifier', text: 'Before and after look the same here because a detail other than the account number changed.' };
  }
  return { tone: 'warning', text: PAYOUT_MASKS_ALIKE_WARNING[kind] };
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
 * It carries a link, on purpose
 * (`docs/superpowers/specs/2026-10-08-payout-change-alert-design.md`,
 * Decision 2): the link holds no credential and signs no one in; all it can do
 * is pause payments, sign every device out and remove recent passkeys, each
 * of which fails toward safety. The secret rides in
 * the URL fragment, so it never reaches a server log or a Referer.
 *
 * `before`/`after` are masked strings built from teacher input; `wrapEmail`
 * escapes every value, `pauseUrl` as an attribute included.
 */
export function renderPayoutChangedEmail(input: PayoutChangedEmailInput): RenderedEmail {
  const when = formatInZoneOrUtc(input.at, input.timezone);
  const isBank = input.kind.startsWith('bank_account');
  const what =
    PAYOUT_CHANGE_PHRASES[input.kind] +
    (isBank && input.accountCurrency !== null ? ` (${input.accountCurrency})` : '');
  const alike = payoutMasksAlikeNote(input);
  const lines: string[] = [];
  if (alike !== null) {
    lines.push(`Shown as: ${input.before ?? ''}`);
    lines.push(alike.text);
  } else {
    if (input.before !== null) lines.push(`Before: ${input.before}`);
    if (input.after !== null) lines.push(`After: ${input.after}`);
  }
  const blocks: EmailBlock[] = [{ kind: 'paragraph', lines: [`${what} on your fair.yoga account on ${when}.`] }];
  if (lines.length > 0) blocks.push({ kind: 'paragraph', lines });
  blocks.push(
    {
      kind: 'paragraph',
      lines: ['If that was you, there is nothing to do. If it was not, pause payments now: students are told to hold off, and every device is signed out.'],
    },
    { kind: 'button', label: "This wasn't me", href: input.pauseUrl },
    {
      kind: 'paragraph',
      tone: 'note',
      lines: [`The link works for ${PAUSE_TOKEN_TTL_DAYS} days. It can only pause payments and sign devices out; it never signs anyone in.`],
    },
  );
  return {
    subject: 'Your payout details changed on fair.yoga',
    ...wrapEmail('Your payout details changed', blocks, PAYOUT_CHANGED_FOOTER),
  };
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
export function renderDegradationDigestEmail(entries: readonly DegradationDigestEntry[]): RenderedEmail {
  const subject =
    entries.length === 1
      ? `fair.yoga: ${entries[0]!.code} fired`
      : `fair.yoga: ${entries.length} degradations fired`;

  const blocks = entries.flatMap((e): EmailBlock[] => {
    const sample = Object.entries(e.sample)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(' · ');
    return [
      { kind: 'paragraph', tone: 'strong', lines: [e.code] },
      { kind: 'paragraph', lines: [e.description] },
      {
        kind: 'paragraph',
        tone: 'note',
        lines: [`First seen ${e.firstSeenAt.toISOString()} · last seen ${e.lastSeenAt.toISOString()} · about ${e.occurrences} times`],
      },
      ...(sample ? [{ kind: 'paragraph', tone: 'note', lines: [`Latest: ${sample}`] } satisfies EmailBlock] : []),
    ];
  });

  return { subject, ...wrapEmail('A fallback fired', blocks, DEGRADATION_DIGEST_FOOTER) };
}
