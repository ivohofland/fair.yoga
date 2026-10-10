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
import type { UnsubscribeTarget } from '@/lib/unsubscribe-kind';
import { invitationSubject, unsubscribeLinks } from '@/lib/unsubscribe-token';

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
  /**
   * `null` for mail the recipient cannot switch off; a target adds RFC 8058's
   * two headers (when a signing key is configured). Required so every sender
   * decides.
   */
  unsubscribe: UnsubscribeTarget | null;
  /**
   * Passed to the provider, except that `sendEmail` sets `List-Unsubscribe`
   * and `List-Unsubscribe-Post` over these when `unsubscribe` yields links.
   */
  headers?: Record<string, string>;
  /** A caller-stable id for a send that may be retried (see `LettermintPayload`). */
  idempotencyKey?: string;
}

/**
 * `delivery: 'sent'` means the provider accepted the message, not that it
 * reached the inbox; `'dry-run'` means nothing left the process.
 */
export type SendResult =
  | { ok: true; delivery: 'sent' | 'dry-run' }
  | { ok: false; reason: string };

/** An env var that is empty or only whitespace counts as unset; a set one is returned trimmed. */
function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

/**
 * Dry-run mode logs emails instead of sending them. True when
 * EMAIL_DRY_RUN=1 or when no token is configured. `sendEmail` refuses rather than dry-runs in
 * production without a token, unless EMAIL_DRY_RUN=1.
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

/** Reply-To and route for each audience; the `never` default makes a new audience a compile error here. */
function routing(audience: EmailAudience): { replyTo?: string; route?: string } {
  switch (audience) {
    case 'platform': {
      return { replyTo: env('EMAIL_REPLY_TO') ?? DEFAULT_REPLY_TO };
    }
    case 'class': {
      const route = classRoute();
      return route === undefined ? {} : { route };
    }
    default: {
      const unhandled: never = audience;
      return unhandled;
    }
  }
}

/**
 * Sends one email and reports the outcome; never throws. A provider refusal
 * and anything the adapter throws both come back as `ok: false`. A dry-run
 * logs only the subject. A non-null `unsubscribe` adds `List-Unsubscribe` and
 * `List-Unsubscribe-Post` to `headers`; without a signing key the mail goes
 * out without them.
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
  try {
    const { replyTo, route } = routing(message.audience);
    const links = message.unsubscribe === null ? null : unsubscribeLinks(message.unsubscribe);
    const headers: Record<string, string> = {
      ...message.headers,
      ...(links !== null && {
        'List-Unsubscribe': `<${links.oneClick}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }),
    };
    const result = await deliverViaLettermint(
      {
        from: env('EMAIL_FROM') ?? DEFAULT_FROM,
        to: message.to,
        ...(replyTo !== undefined && { replyTo }),
        ...(route !== undefined && { route }),
        ...message.content,
        ...(Object.keys(headers).length > 0 && { headers }),
        ...(message.idempotencyKey !== undefined && { idempotencyKey: message.idempotencyKey }),
      },
      token,
    );
    return result.ok ? { ok: true, delivery: 'sent' } : result;
  } catch (err) {
    log.error({ err, subject: message.content.subject, audience: message.audience }, 'email adapter threw');
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Sends the sign-in link. A failed send throws, including production without
 * a token. A dry-run prints the link for the developer; in production that
 * happens only when EMAIL_DRY_RUN=1 was set explicitly. Production without a
 * token never logs the link: logging it while telling the user to check their
 * inbox leaks tokens and silently breaks login.
 */
export async function sendMagicLinkEmail(
  to: string,
  magicLink: BoundSignInLink
): Promise<void> {
  const result = await sendEmail({ to, audience: 'platform', content: renderMagicLinkEmail(magicLink), unsubscribe: null });
  if (!result.ok) throw new Error(`Failed to send magic-link email: ${result.reason}`);
  if (result.delivery === 'dry-run') console.log(`\n[DEV] Magic link for ${to}: ${magicLink}\n`);
}

/**
 * Sends the invitation email. Which addresses it reaches: `docs/data-model.md`
 * (Invitation, "Who an invitation reaches"). A failed send throws, including
 * production without a token; a dry-run prints the sign-in URL for the
 * developer.
 */
export async function sendInvitationEmail(
  to: string,
  teacherName: string,
  signInUrl: string,
  invitationId: string,
): Promise<void> {
  const target = { kind: 'invitation', subjectId: invitationSubject(invitationId, to) } as const;
  const result = await sendEmail({
    to,
    audience: 'class',
    content: renderInvitationEmail(teacherName, signInUrl, unsubscribeLinks(target)?.page),
    unsubscribe: target,
  });
  if (!result.ok) throw new Error(`Failed to send invitation email: ${result.reason}`);
  if (result.delivery === 'dry-run') {
    console.log(`\n[DEV] Invitation email for ${to} from ${teacherName}: ${signInUrl}\n`);
  }
}

/** Sends the passkey-added notice. A failed send throws. */
export async function sendPasskeyAddedEmail(to: string, addedAt: Date): Promise<void> {
  const result = await sendEmail({ to, audience: 'platform', content: renderPasskeyAddedEmail(addedAt), unsubscribe: null });
  if (!result.ok) throw new Error(`Failed to send passkey-added email: ${result.reason}`);
}

/** Sends the passkey-removed notice, the way `sendPasskeyAddedEmail` sends the added one. */
export async function sendPasskeyRemovedEmail(to: string, removedAt: Date): Promise<void> {
  const result = await sendEmail({ to, audience: 'platform', content: renderPasskeyRemovedEmail(removedAt), unsubscribe: null });
  if (!result.ok) throw new Error(`Failed to send passkey-removed email: ${result.reason}`);
}

/** Sends the payout-change alert. A failed send throws; the caller owns what happens next. */
export async function sendPayoutChangedEmail(to: string, input: PayoutChangedEmailInput): Promise<void> {
  const result = await sendEmail({ to, audience: 'platform', content: renderPayoutChangedEmail(input), unsubscribe: null });
  if (!result.ok) throw new Error(`Failed to send payout-changed email: ${result.reason}`);
}
