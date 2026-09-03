import type { PrismaClient, MagicLinkPurpose } from '@prisma/client';
import { generateMagicLinkToken } from './magic-link';
import { hashNonce, type BrowserNonce } from './origin-nonce';
import { sendMagicLinkEmail } from '@/lib/email';

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
