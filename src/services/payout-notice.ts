import { Prisma, type PrismaClient } from '@prisma/client';
import { sendPayoutChangedEmail } from '@/lib/email';
import { log } from '@/lib/log';
import type { FireAndForget } from '@/lib/fire-and-forget';
import { mintPayoutPauseToken } from '@/services/payout-pause-token';

/** The token's own foreign keys, as Prisma names them in a P2003's `meta.constraint`. */
export const PAUSE_TOKEN_FOREIGN_KEYS: ReadonlySet<string> = new Set([
  'PayoutPauseToken_eventId_fkey',
  'PayoutPauseToken_teacherId_fkey',
]);

function isMintKeyRefusal(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2003') return false;
  const constraint = err.meta?.constraint;
  return typeof constraint === 'string' && PAUSE_TOKEN_FOREIGN_KEYS.has(constraint);
}

/**
 * Tell a teacher's account address that where their students pay just
 * changed, with the link that pauses payments if it was not them.
 *
 * The change this reports has already committed, so neither the provider's
 * latency nor the failure of the lookup, the mint or the send may reach the
 * write's response. Hence `FireAndForget`, with the rejection owned here
 * (`docs/technical-architecture.md`, The Services Layer → Work that must not
 * be awaited). An event that no longer exists, or whose link cannot be
 * minted because the event or teacher row went in between, has nobody left
 * to tell: logged at warn and dropped.
 *
 * Nothing sits before the IIFE: a statement there that threw would escape the
 * `.catch` into the caller.
 */
export function deliverPayoutChangedNotice(db: PrismaClient, eventId: string): FireAndForget {
  void (async () => {
    const event = await db.payoutChangeEvent.findUnique({
      where: { id: eventId },
      select: {
        teacherId: true,
        kind: true,
        accountCurrency: true,
        before: true,
        after: true,
        identifierChanged: true,
        createdAt: true,
        teacher: { select: { defaultTimezone: true, account: { select: { email: true } } } },
      },
    });
    if (event === null) {
      log.warn({ eventId }, 'payout-change notice dropped: the event is gone');
      return;
    }
    let raw: string;
    try {
      raw = await mintPayoutPauseToken(db, event.teacherId, eventId);
    } catch (err) {
      // A refusal by one of the token's own foreign keys is the case above,
      // landing between the read and the insert. Any other refusal is a fault.
      if (isMintKeyRefusal(err)) {
        log.warn({ eventId }, 'payout-change notice dropped: the event or teacher went before its link was minted');
        return;
      }
      throw err;
    }
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    await sendPayoutChangedEmail(event.teacher.account.email, {
      kind: event.kind,
      accountCurrency: event.accountCurrency,
      before: event.before,
      after: event.after,
      identifierChanged: event.identifierChanged,
      at: event.createdAt,
      timezone: event.teacher.defaultTimezone,
      pauseUrl: `${baseUrl}/payout-pause#t=${raw}`,
    });
  })().catch((err: unknown) => {
    log.error({ err, eventId }, 'payout-change notice failed to send');
  });
}
