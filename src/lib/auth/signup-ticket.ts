import type { PrismaClient } from '@prisma/client';
import { generateMagicLinkToken, verifyMagicLinkToken, hashToken } from './magic-link';

export const SIGNUP_TICKET_COOKIE = 'fair_yoga_signup';

/**
 * An hour, not the fifteen minutes every other token gets. This one sits
 * behind a FORM: no other flow asks someone to type four fields while a
 * token ages, and losing a name, an address that waited on an availability
 * check, and a bio is a bad first interaction with the product.
 */
const TICKET_TTL_MS = 60 * 60 * 1000;

export async function mintSignupTicket(db: PrismaClient, email: string): Promise<string> {
  return generateMagicLinkToken(db, email, {
    purpose: 'teacher_profile_pending',
    ttlMs: TICKET_TTL_MS,
  });
}

/** The address behind a live ticket, WITHOUT consuming it — the profile page
 *  reads this to prefill the form's re-send address. */
export async function peekSignupTicket(
  db: PrismaClient,
  token: string,
): Promise<string | null> {
  const row = await db.magicLinkToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { email: true, expiresAt: true, purpose: true },
  });
  if (!row || row.purpose !== 'teacher_profile_pending') return null;
  return row.expiresAt > new Date() ? row.email : null;
}

/**
 * Single-use: `verifyMagicLinkToken` deletes atomically, so two concurrent
 * submissions cannot both create a teacher for one ticket. Returns the
 * VERIFIED address — the profile route must never take an email from a body.
 */
export async function consumeSignupTicket(
  db: PrismaClient,
  token: string,
): Promise<string | null> {
  const result = await verifyMagicLinkToken(db, token);
  if (!result || result.purpose !== 'teacher_profile_pending') return null;
  return result.email;
}

export function setSignupTicketCookie(headers: Headers, token: string): void {
  let cookie = `${SIGNUP_TICKET_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TICKET_TTL_MS / 1000}`;
  if (process.env.NODE_ENV === 'production') cookie += '; Secure';
  headers.append('Set-Cookie', cookie);
}

export function clearSignupTicketCookie(headers: Headers): void {
  headers.append('Set-Cookie', `${SIGNUP_TICKET_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
