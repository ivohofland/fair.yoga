import { Resend } from 'resend';
import { renderMagicLinkEmail, renderInvitationEmail, renderPasskeyAddedEmail } from '@/lib/email-templates';
import type { BoundSignInLink } from '@/lib/auth/link-delivery';
import { log } from '@/lib/log';

// Lazy: constructing Resend without a key throws, which would crash any
// import of this module in keyless environments (Docker image build,
// dry-run dev). The dry-run guard means we only construct when a key exists.
let resendClient: Resend | null = null;
function resend(): Resend {
  return (resendClient ??= new Resend(process.env.RESEND_API_KEY));
}

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
  magicLink: BoundSignInLink
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
  const { error } = await resend().emails.send({
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

/**
 * Sends the invitation email — `notifyInvitee`'s (services/invitations.ts)
 * last-resort channel when the address has no in-app surface to notify
 * instead. Which addresses those are: `docs/data-model.md` (Invitation, "Who
 * an invitation reaches"). Unlike
 * `sendMagicLinkEmail`, a missing key degrading to dry-run in production is
 * not a login-breaking event here, so this has no equivalent production
 * throw-guard: dry-run just logs, the same as `email-fallback.ts`'s send.
 */
export async function sendInvitationEmail(
  to: string,
  teacherName: string,
  signInUrl: string,
): Promise<void> {
  if (emailDryRun()) {
    console.log(`\n[DEV] Invitation email for ${to} from ${teacherName}: ${signInUrl}\n`);
    return;
  }

  const { subject, html } = renderInvitationEmail(teacherName, signInUrl);
  const { error } = await resend().emails.send({
    from: process.env.EMAIL_FROM || 'noreply@fair.yoga',
    to,
    subject,
    html,
  });

  if (error) {
    throw new Error(`Failed to send invitation email: ${error.message}`);
  }
}

/**
 * Sends the passkey-added notice. Like `sendInvitationEmail`, a missing key
 * degrades to a logged dry-run rather than throwing. The line logs no
 * address: a notice about a credential is not worth a PII entry.
 */
export async function sendPasskeyAddedEmail(to: string, addedAt: Date): Promise<void> {
  if (emailDryRun()) {
    log.info({}, 'passkey-added email dry-run');
    return;
  }

  const { subject, html } = renderPasskeyAddedEmail(addedAt);
  const { error } = await resend().emails.send({
    from: process.env.EMAIL_FROM || 'noreply@fair.yoga',
    to,
    subject,
    html,
  });

  if (error) {
    throw new Error(`Failed to send passkey-added email: ${error.message}`);
  }
}

/**
 * Sends one HTML email. An API failure Resend reports as `{ error }` comes back
 * as `{ ok: false }`; an error the SDK throws (network, serialisation)
 * propagates.
 *
 * In production with no key and no explicit `EMAIL_DRY_RUN=1` it answers
 * `{ ok: false }` rather than dry-running, so the caller can count the failure.
 * A caller may have no other delivery — an email-only class reminder has no
 * inbox row — and a dry-run would lose its message with nothing above an
 * `info` line to say so.
 */
export async function sendHtmlEmail(input: {
  to: string;
  subject: string;
  html: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (emailDryRun()) {
    if (process.env.NODE_ENV === 'production' && process.env.EMAIL_DRY_RUN !== '1') {
      return { ok: false, reason: 'RESEND_API_KEY is not configured' };
    }
    log.info({ to: input.to, subject: input.subject }, 'email dry-run');
    return { ok: true };
  }
  const { error } = await resend().emails.send({
    from: process.env.EMAIL_FROM || 'noreply@fair.yoga',
    ...input,
  });
  return error ? { ok: false, reason: error.message } : { ok: true };
}
