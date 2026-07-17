/**
 * Email Fallback — Sends email for unread notifications older than 30 minutes.
 *
 * Layer 3 of the communication system:
 * 1. In-app notification (real-time via SSE)
 * 2. In-app inbox (persistent record)
 * 3. Email fallback (this service)
 */

import type { PrismaClient } from '@prisma/client';
import { Resend } from 'resend';
import { getUnreadForEmailFallback, markEmailSent } from './notifications';

const resend = new Resend(process.env.RESEND_API_KEY);
const isDev = !process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === 're_placeholder';

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

  const sentIds: string[] = [];

  for (const notification of notifications) {
    // Look up recipient email and preferences
    let email: string | null = null;
    let emailEnabled = true;

    if (notification.recipientType === 'teacher') {
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
      emailEnabled = student?.emailNotifications ?? true;
    }

    if (!email || !emailEnabled) {
      // Mark as sent to avoid retrying
      sentIds.push(notification.id);
      continue;
    }

    if (isDev) {
      console.log(`[DEV] Email fallback for ${email}: ${notification.title} — ${notification.body}`);
      sentIds.push(notification.id);
      continue;
    }

    try {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'noreply@fair.yoga',
        to: email,
        subject: notification.title,
        // Body can contain teacher-authored announcement text — escape it
        // so markup or phishing HTML never renders in a platform email.
        html: `<p>${escapeHtml(notification.body)}</p>`,
      });
      sentIds.push(notification.id);
    } catch (err) {
      console.error(`Failed to send email fallback for notification ${notification.id}:`, err);
    }
  }

  if (sentIds.length > 0) {
    await markEmailSent(db, sentIds);
  }

  return sentIds.length;
}
