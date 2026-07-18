import { Resend } from 'resend';
import { renderMagicLinkEmail } from '@/lib/email-templates';

const resend = new Resend(process.env.RESEND_API_KEY);

function emailConfigured(): boolean {
  return Boolean(
    process.env.RESEND_API_KEY && process.env.RESEND_API_KEY !== 're_placeholder',
  );
}

/**
 * Dry-run mode logs emails instead of sending them. Active when explicitly
 * requested (EMAIL_DRY_RUN=1 — CI runs the production build without a real
 * Resend key) or when no key is configured.
 */
export function emailDryRun(): boolean {
  return process.env.EMAIL_DRY_RUN === '1' || !emailConfigured();
}

export async function sendMagicLinkEmail(
  to: string,
  magicLink: string
): Promise<void> {
  if (emailDryRun()) {
    // In production an *unintentional* missing key must fail loudly:
    // logging the raw sign-in link to stdout while telling the user
    // "check your inbox" leaks auth tokens into logs and silently breaks
    // login. Explicit EMAIL_DRY_RUN=1 is the sanctioned exception.
    if (process.env.NODE_ENV === 'production' && process.env.EMAIL_DRY_RUN !== '1') {
      throw new Error('RESEND_API_KEY is not configured — cannot send magic-link email');
    }
    console.log(`\n[DEV] Magic link for ${to}: ${magicLink}\n`);
    return;
  }

  const { subject, html } = renderMagicLinkEmail(magicLink);
  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM || 'noreply@fair.yoga',
    to,
    subject,
    html,
  });

  // The Resend SDK reports API failures via { error }, it does not throw.
  if (error) {
    throw new Error(`Failed to send magic-link email: ${error.message}`);
  }
}
