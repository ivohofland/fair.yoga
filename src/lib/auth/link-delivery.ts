import type { PrismaClient, MagicLinkPurpose } from '@prisma/client';
import { generateMagicLinkToken } from './magic-link';
import { hashNonce, type BrowserNonce } from './origin-nonce';
import { sendMagicLinkEmail } from '@/lib/email';
import { log } from '@/lib/log';
import type { FireAndForget } from '@/lib/fire-and-forget';
import type { Assert, Equals } from '@/lib/type-pins';

declare const boundLinkBrand: unique symbol;

/**
 * A `/verify` URL bound to the browser that requested it.
 *
 * A branded string: only `deliverSignInLink` below performs the cast that
 * produces one. See the design spec §2 ("The tether: one function") for why
 * every door is required to go through that one function.
 */
export type BoundSignInLink = string & { readonly [boundLinkBrand]: true };

/**
 * Mints a link token bound to `nonce`, and emails it.
 *
 * The only path from an address to a sign-in email. Callers obtain `nonce`
 * from `ensureOriginNonce`, which they must call for every accepted request
 * regardless of whether an account exists.
 */
export async function deliverSignInLink(
  db: PrismaClient,
  email: string,
  nonce: BrowserNonce,
  opts?: { redirectTo?: string; purpose?: MagicLinkPurpose },
): Promise<void> {
  const token = await generateMagicLinkToken(db, email, {
    redirectTo: opts?.redirectTo,
    purpose: opts?.purpose,
    originBrowserHash: hashNonce(nonce),
  });

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const link = `${baseUrl}/verify?token=${token}` as BoundSignInLink;
  await sendMagicLinkEmail(email, link);
}

/**
 * Emails a sign-in link if `email` belongs to a teacher or a student, and
 * does nothing otherwise.
 *
 * The response to the request that asked for it must not depend on whether
 * the address is registered, so the caller awaits none of it: the lookup, the
 * mint and the send each take a different time for a registered address than
 * for an unknown one. Hence `FireAndForget`, with the rejection owned here
 * (`docs/technical-architecture.md`, The Services Layer → Work that must not
 * be awaited).
 *
 * Nothing sits before the IIFE: a statement there that threw would escape the
 * `.catch` into the caller.
 */
export function deliverSignInLinkIfRegistered(
  db: PrismaClient,
  email: string,
  nonce: BrowserNonce,
  opts?: { redirectTo?: string },
): FireAndForget {
  void (async () => {
    const teacher = await db.teacher.findUnique({ where: { email } });
    const user = teacher ?? (await db.student.findUnique({ where: { email } }));
    if (!user) return;
    await deliverSignInLink(db, email, nonce, { redirectTo: opts?.redirectTo });
  })().catch((err: unknown) => {
    log.error({ err }, 'magic-link send: delivery failed');
  });
}

/**
 * This function's own use of the alias, pinned: a signature restored to
 * `Promise<void>` fails the build instead of reopening the oracle.
 */
type _deliverSignInLinkIfRegisteredReturnsVoid = Assert<
  Equals<ReturnType<typeof deliverSignInLinkIfRegistered>, void>
>;
void 0 as unknown as [_deliverSignInLinkIfRegisteredReturnsVoid];
