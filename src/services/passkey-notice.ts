import type { PrismaClient } from '@prisma/client';
import { sendPasskeyAddedEmail, sendPasskeyRemovedEmail } from '@/lib/email';
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
 * Nothing sits before the IIFE: a statement there that threw would escape the
 * `.catch` into the caller.
 */
export function deliverPasskeyAddedNotice(
  db: PrismaClient,
  input: { accountId: string; addedAt: Date },
): FireAndForget {
  void (async () => {
    const account = await db.account.findUniqueOrThrow({
      where: { id: input.accountId },
      select: { email: true },
    });
    await sendPasskeyAddedEmail(account.email, input.addedAt);
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
