import { deliverViaLettermint } from '@/lib/email-lettermint';
import {
  renderMagicLinkEmail,
  renderInvitationEmail,
  renderPasskeyAddedEmail,
  renderPasskeyRemovedEmail,
  renderPayoutChangedEmail,
  type PayoutChangedEmailInput,
  type RenderedEmail,
} from '@/lib/email-templates';
import type { BoundSignInLink } from '@/lib/auth/link-delivery';
import { log } from '@/lib/log';

const DEFAULT_FROM = 'noreply@fair.yoga';
const DEFAULT_REPLY_TO = 'hello@fair.yoga';
const NOT_CONFIGURED = 'LETTERMINT_API_TOKEN is not configured';

/**
 * Whose mail this is. Decides Reply-To and the Lettermint route: `platform`
 * mail replies to the operator, `class` mail goes out on the class route.
 */
export type EmailAudience = 'platform' | 'class';

export interface EmailMessage {
  to: string;
  audience: EmailAudience;
  content: RenderedEmail;
  /** Passed to the provider untouched. */
  headers?: Record<string, string>;
  /** A caller-stable id for a send that may be retried (see `LettermintPayload`). */
  idempotencyKey?: string;
}

export type SendResult =
  | { ok: true; delivery: 'sent' | 'dry-run' }
  | { ok: false; reason: string };

/** An env var set to the empty string counts as unset. */
function env(name: string): string | undefined {
  return process.env[name] || undefined;
}

/**
 * Dry-run mode logs emails instead of sending them. Active when explicitly
 * requested (EMAIL_DRY_RUN=1 — CI runs the production build without a real
 * token) or when no token is configured.
 */
export function emailDryRun(): boolean {
  return process.env.EMAIL_DRY_RUN === '1' || env('LETTERMINT_API_TOKEN') === undefined;
}

let warnedClassRouteUnset = false;

/**
 * The route class mail is sent on. Suppression is route-scoped at Lettermint,
 * so class mail on the default route lets a complaint about it suppress
 * sign-in mail too; unset still sends, and production says so once.
 */
function classRoute(): string | undefined {
  const route = env('LETTERMINT_CLASS_ROUTE');
  if (route === undefined && process.env.NODE_ENV === 'production' && !warnedClassRouteUnset) {
    warnedClassRouteUnset = true;
    log.warn({}, 'LETTERMINT_CLASS_ROUTE is not set; class mail is sent on the default route');
  }
  return route;
}

/**
 * Sends one email and reports the outcome; never throws. A provider refusal
 * and anything the adapter throws both come back as `ok: false`.
 *
 * In production with no token and no explicit EMAIL_DRY_RUN=1 it answers
 * `ok: false` rather than dry-running, so no caller can count an email that
 * was never sent as delivered.
 */
export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  const token = env('LETTERMINT_API_TOKEN');
  if (emailDryRun() || token === undefined) {
    if (process.env.NODE_ENV === 'production' && process.env.EMAIL_DRY_RUN !== '1') {
      return { ok: false, reason: NOT_CONFIGURED };
    }
    log.info({ subject: message.content.subject }, 'email dry-run');
    return { ok: true, delivery: 'dry-run' };
  }
  const replyTo = message.audience === 'platform' ? (env('EMAIL_REPLY_TO') ?? DEFAULT_REPLY_TO) : undefined;
  const route = message.audience === 'class' ? classRoute() : undefined;
  try {
    const result = await deliverViaLettermint(
      {
        from: env('EMAIL_FROM') ?? DEFAULT_FROM,
        to: message.to,
        ...(replyTo !== undefined && { replyTo }),
        ...(route !== undefined && { route }),
        ...message.content,
        ...(message.headers !== undefined && { headers: message.headers }),
        ...(message.idempotencyKey !== undefined && { idempotencyKey: message.idempotencyKey }),
      },
      token,
    );
    return result.ok ? { ok: true, delivery: 'sent' } : result;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Sends the sign-in link. A failed send throws. Production without a token
 * throws too, and never logs the link: logging a sign-in link to stdout while
 * telling the user "check your inbox" leaks auth tokens into logs and
 * silently breaks login. Explicit EMAIL_DRY_RUN=1 is the sanctioned
 * exception, and outside production a dry-run prints the link for the
 * developer.
 */
export async function sendMagicLinkEmail(
  to: string,
  magicLink: BoundSignInLink
): Promise<void> {
  const result = await sendEmail({ to, audience: 'platform', content: renderMagicLinkEmail(magicLink) });
  if (!result.ok) throw new Error(`Failed to send magic-link email: ${result.reason}`);
  if (result.delivery === 'dry-run') console.log(`\n[DEV] Magic link for ${to}: ${magicLink}\n`);
}

/**
 * Sends the invitation email — `notifyInvitee`'s (services/invitations.ts)
 * last-resort channel when the address has no in-app surface to notify
 * instead. Which addresses those are: `docs/data-model.md` (Invitation, "Who
 * an invitation reaches"). A failed send throws, including production without
 * a token; a dry-run prints the sign-in URL for the developer.
 */
export async function sendInvitationEmail(
  to: string,
  teacherName: string,
  signInUrl: string,
): Promise<void> {
  const result = await sendEmail({ to, audience: 'class', content: renderInvitationEmail(teacherName, signInUrl) });
  if (!result.ok) throw new Error(`Failed to send invitation email: ${result.reason}`);
  if (result.delivery === 'dry-run') {
    console.log(`\n[DEV] Invitation email for ${to} from ${teacherName}: ${signInUrl}\n`);
  }
}

/**
 * Sends the passkey-added notice. A failed send throws. A dry-run logs no
 * address: a notice about a credential is not worth a PII entry.
 */
export async function sendPasskeyAddedEmail(to: string, addedAt: Date): Promise<void> {
  const result = await sendEmail({ to, audience: 'platform', content: renderPasskeyAddedEmail(addedAt) });
  if (!result.ok) throw new Error(`Failed to send passkey-added email: ${result.reason}`);
}

/** Sends the passkey-removed notice, the way `sendPasskeyAddedEmail` sends the added one. */
export async function sendPasskeyRemovedEmail(to: string, removedAt: Date): Promise<void> {
  const result = await sendEmail({ to, audience: 'platform', content: renderPasskeyRemovedEmail(removedAt) });
  if (!result.ok) throw new Error(`Failed to send passkey-removed email: ${result.reason}`);
}

/**
 * Sends the payout-change alert. A failed send throws; the caller owns what
 * happens next. A dry-run logs neither the address nor the pause link: the
 * link's fragment is a bearer secret.
 */
export async function sendPayoutChangedEmail(to: string, input: PayoutChangedEmailInput): Promise<void> {
  const result = await sendEmail({ to, audience: 'platform', content: renderPayoutChangedEmail(input) });
  if (!result.ok) throw new Error(`Failed to send payout-changed email: ${result.reason}`);
}
