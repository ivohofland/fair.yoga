import type { PrismaClient } from '@prisma/client';
import { sendPasskeyAddedEmail, sendPasskeyRemovedEmail } from '@/lib/email';
import { mintPasskeyRevokeToken } from '@/services/passkey-revoke-token';
import { log } from '@/lib/log';
import type { FireAndForget } from '@/lib/fire-and-forget';

/**
 * Tell an account's address that a passkey was just added to it.
 *
 * The registration this reports has already committed, so neither the
 * provider's latency nor its failure — nor that of the address lookup, which
 * is why it happens in here — may reach the registration's response. Hence
 * `FireAndForget`, with the rejection owned here (`docs/technical-
 * architecture.md`, The Services Layer → Work that must not be awaited).
 *
 * The revoke link's mint is inside the body for the same reason as the send:
 * its latency and failure must not reach the response either. A failed mint
 * sends the notice without the button.
 *
 * Nothing sits before the IIFE: a statement there that threw would escape the
 * `.catch` into the caller.
 */
export function deliverPasskeyAddedNotice(
  db: PrismaClient,
  input: { accountId: string; addedAt: Date; credentialId: string },
): FireAndForget {
  void (async () => {
    const account = await db.account.findUniqueOrThrow({
      where: { id: input.accountId },
      select: { email: true },
    });
    let revokeUrl: string | null = null;
    try {
      const raw = await mintPasskeyRevokeToken(db, { accountId: input.accountId, credentialId: input.credentialId });
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      revokeUrl = `${baseUrl}/passkey-revoke#t=${raw}`;
    } catch (err) {
      // The notice is the signal and the button its convenience: a failed mint
      // sends the notice with its remedy in words.
      log.error({ err, accountId: input.accountId }, 'passkey-added notice sent without its revoke link');
    }
    await sendPasskeyAddedEmail(account.email, input.addedAt, revokeUrl);
  })().catch((err: unknown) => {
    log.error({ err, accountId: input.accountId }, 'passkey-added notice failed to send');
  });
}

/**
 * Tell an account's address that one of its passkeys was just removed, after
 * the removal has committed: `FireAndForget` for the same reasons as
 * `deliverPasskeyAddedNotice`, and the same shape.
 *
 * Nothing sits before the IIFE: a statement there that threw would escape the
 * `.catch` into the caller.
 */
export function deliverPasskeyRemovedNotice(
  db: PrismaClient,
  input: { accountId: string; removedAt: Date },
): FireAndForget {
  void (async () => {
    const account = await db.account.findUniqueOrThrow({
      where: { id: input.accountId },
      select: { email: true },
    });
    await sendPasskeyRemovedEmail(account.email, input.removedAt);
  })().catch((err: unknown) => {
    log.error({ err, accountId: input.accountId }, 'passkey-removed notice failed to send');
  });
}
