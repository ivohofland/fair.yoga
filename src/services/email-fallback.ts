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
import { renderNotificationEmail } from '@/lib/email-templates';
import { emailDryRun } from '@/lib/email';

const resend = new Resend(process.env.RESEND_API_KEY);

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

    if (emailDryRun()) {
      console.log(`[DEV] Email fallback for ${email}: ${notification.title} — ${notification.body}`);
      sentIds.push(notification.id);
      continue;
    }

    try {
      // Branded template; escapes teacher-authored bodies so markup or
      // phishing HTML never renders in a platform email.
      const { subject, html } = renderNotificationEmail(notification);
      const { error } = await resend.emails.send({
        from: process.env.EMAIL_FROM || 'noreply@fair.yoga',
        to: email,
        subject,
        html,
      });
      // The Resend SDK reports API failures via { error }, it does not throw —
      // an unchecked result would mark the notification sent when it wasn't.
      if (error) {
        console.error(`Failed to send email fallback for notification ${notification.id}:`, error.message);
        continue;
      }
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
