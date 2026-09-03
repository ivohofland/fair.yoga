import type { PrismaClient, MagicLinkPurpose } from '@prisma/client';
import { generateMagicLinkToken } from './magic-link';
import { hashNonce } from './origin-nonce';
import { sendMagicLinkEmail } from '@/lib/email';

declare const boundLinkBrand: unique symbol;

/**
 * A `/verify` URL whose token is bound to the browser that requested it.
 *
 * `sendMagicLinkEmail` accepts only this type, and only `deliverSignInLink`
 * below constructs one. That is what makes binding unforgettable: a new route
 * cannot email a sign-in link by assembling the URL itself, because a plain
 * `string` will not typecheck at the send call.
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
  nonce: string,
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
