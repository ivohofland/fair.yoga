/**
 * Email templates — one calm, branded shell for every message.
 *
 * Same voice as the product: warm, clear, grounded. No marketing blocks,
 * no images, table-free layout that renders everywhere. Colors are the v2
 * palette inlined (email clients ignore stylesheets).
 */

import type { NotificationType } from '@prisma/client';

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
    <p style="font-size:13px;line-height:1.4;color:#9C8F84;margin:24px 0 0;">
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
};

const TEACHER_INTROS: Partial<Record<NotificationType, string>> = {
  booking_confirmed: 'A student booked your class.',
  class_cancelled: 'One of your classes was cancelled.',
  payment_received: 'A payment was received.',
  payment_request: 'A class has been priced.',
  reminder: 'A gentle reminder.',
};

export interface NotificationEmailInput {
  type: NotificationType;
  title: string;
  body: string;
  /** Defaults to the student framing when absent. */
  recipientType?: 'teacher' | 'student';
}

/** Renders the email for an unread notification (layer 3 fallback). */
export function renderNotificationEmail(notification: NotificationEmailInput): {
  subject: string;
  html: string;
} {
  const intro =
    notification.recipientType === 'teacher'
      ? (TEACHER_INTROS[notification.type] ?? STUDENT_INTROS[notification.type])
      : STUDENT_INTROS[notification.type];
  const html = wrapEmail(
    escapeHtml(notification.title),
    `<p style="margin:0 0 8px;color:#9C8F84;font-size:13px;">${escapeHtml(intro)}</p>
     <p style="margin:0;">${escapeHtml(notification.body)}</p>`,
  );
  return { subject: notification.title, html };
}

/** The sign-in email: one link, one expiry note, nothing else. */
export function renderMagicLinkEmail(magicLink: string): { subject: string; html: string } {
  const html = wrapEmail(
    'Sign in to fair.yoga',
    `<p style="margin:0 0 16px;">Tap the button and you're in — no password.</p>
     <p style="margin:0 0 16px;"><a href="${magicLink}" style="display:inline-block;background-color:#1A5653;color:#F7F4EF;text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:999px;">Sign in</a></p>
     <p style="margin:0;font-size:13px;color:#9C8F84;">This link works once and expires in 15 minutes. If you didn't request it, you can ignore this email.</p>`,
  );
  return { subject: 'Sign in to fair.yoga', html };
}
