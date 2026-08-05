/**
 * Email templates — one calm, branded shell for every message.
 *
 * Same voice as the product: warm, clear, grounded. No marketing blocks,
 * no images, table-free layout that renders everywhere. Colors are the v2
 * palette inlined (email clients ignore stylesheets).
 */

import type { NotificationType } from '@prisma/client';
import { STUDENT_INVITATION_LABEL, STUDENT_INVITATION_PATH } from './notification-links';

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The shared shell: wordmark, one content block, quiet footer. */
export function wrapEmail(heading: string, bodyHtml: string): string {
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
      You get emails like this when an in-app message goes unread; turn them off in your settings.
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
  class_cancelled: 'A class was cancelled.',
  payment_received: 'A payment was received.',
  payment_request: 'A class has been priced — here is your share.',
  waitlist_promoted: 'Good news from the waitlist.',
  spot_available: 'A spot opened up.',
  reminder: 'A gentle reminder.',
  missed_you: 'We missed you.',
  announcement: 'A message from your teacher.',
  teacher_invitation: 'A teacher would like to connect with you.',
};

const TEACHER_INTROS: Partial<Record<NotificationType, string>> = {
  booking_confirmed: 'A student booked your class.',
  class_cancelled: 'One of your classes was cancelled.',
  payment_received: 'A payment was received.',
  payment_request: 'A class has been priced.',
  reminder: 'A gentle reminder.',
};

/**
 * Types whose fallback email needs somewhere to go, keyed by the reader.
 *
 * Most notifications are about a class, and this template has never carried
 * a link because the class routes it would point at are teacher-only. An
 * invitation is different: the message exists to ask someone for a decision,
 * and the mail that arrives when they miss the in-app one has to reach the
 * place that decision is made — otherwise the recipient is told a teacher
 * wants to connect and given nothing to do about it.
 *
 * Path only. The base URL is the caller's, so this stays renderable without
 * an environment.
 */
const STUDENT_ACTION_LINKS: Partial<Record<NotificationType, { label: string; path: string }>> = {
  teacher_invitation: { label: STUDENT_INVITATION_LABEL, path: STUDENT_INVITATION_PATH },
};

export interface NotificationEmailInput {
  type: NotificationType;
  title: string;
  body: string;
  /** Defaults to the student framing when absent. */
  recipientType?: 'teacher' | 'student';
}

/**
 * Renders the email for an unread notification (layer 3 fallback).
 *
 * `baseUrl` defaults from the environment the same way `notifyInvitee`
 * (services/invitations.ts) builds its own sign-in link, so existing
 * callers need not thread it through; tests pass an explicit value.
 */
export function renderNotificationEmail(
  notification: NotificationEmailInput,
  baseUrl: string = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
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
      ? undefined
      : STUDENT_ACTION_LINKS[notification.type];
  const actionHtml = action
    ? `<p style="margin:16px 0 0;"><a href="${baseUrl}${action.path}" style="display:inline-block;background-color:#1A5653;color:#F7F4EF;text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:999px;">${escapeHtml(action.label)}</a></p>`
    : '';
  const html = wrapEmail(
    escapeHtml(notification.title),
    `<p style="margin:0 0 8px;color:#71645A;font-size:13px;">${escapeHtml(intro)}</p>
     <p style="margin:0;">${escapeHtml(notification.body)}</p>${actionHtml}`,
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
 * the address has no `Student` row yet (`notifyInvitee`, services/invitations.ts).
 *
 * Same copy regardless of whether the address is already registered
 * elsewhere on fair.yoga — this function only ever runs for the "no Student
 * row" branch, but the wording itself must not carry a "welcome back" that
 * would leak that distinction if this ever gets reused. `teacherName` is
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
