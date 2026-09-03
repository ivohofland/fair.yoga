import type { MagicLinkPurpose, PrismaClient } from '@prisma/client';
import { generateMagicLinkToken, verifyMagicLinkToken, hashToken } from './magic-link';
import { log } from '@/lib/log';

export const SIGNUP_TICKET_COOKIE = 'fair_yoga_signup';

/**
 * An hour, not the fifteen minutes every other token gets. This one sits
 * behind a FORM: the teacher form asks for four fields including a bio and
 * an availability-checked page address, and the student form for two — a
 * token aging out mid-typing is a bad first interaction with the product
 * either way, generous rather than load-bearing for the shorter form.
 */
const TICKET_TTL_MS = 60 * 60 * 1000;

/** Which signup a ticket belongs to. The two families' tickets are
 *  interchangeable in shape and must not be interchangeable in effect: a
 *  ticket minted because someone clicked a link to book a class must not be
 *  able to create a public teacher page. */
export type SignupFamily = 'teacher' | 'student';

/** `satisfies` rather than a bare object: a third family cannot be added
 *  without a purpose for it. */
const TICKET_PURPOSE = {
  teacher: 'teacher_profile_pending',
  student: 'student_profile_pending',
} as const satisfies Record<SignupFamily, MagicLinkPurpose>;

export async function mintSignupTicket(
  db: PrismaClient,
  email: string,
  family: SignupFamily,
): Promise<string> {
  return generateMagicLinkToken(db, email, {
    purpose: TICKET_PURPOSE[family],
    ttlMs: TICKET_TTL_MS,
  });
}

/** The address behind a live ticket, WITHOUT consuming it — the profile page
 *  reads this to prefill the form's re-send address. */
export async function peekSignupTicket(
  db: PrismaClient,
  token: string,
  family: SignupFamily,
): Promise<string | null> {
  const row = await db.magicLinkToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { email: true, expiresAt: true, purpose: true },
  });
  if (!row || row.purpose !== TICKET_PURPOSE[family]) return null;
  return row.expiresAt > new Date() ? row.email : null;
}

/**
 * Single-use: `verifyMagicLinkToken` deletes atomically, so two concurrent
 * submissions cannot both create a profile for one ticket. Returns the
 * VERIFIED address — the profile route must never take an email from a body.
 *
 * The cookie is an ordinary bearer value, not something only ever set by
 * `setSignupTicketCookie` — a token of another purpose presented here still
 * gets consumed (deleted) by `verifyMagicLinkToken` before the purpose check
 * below can run. That includes a ticket minted for the OTHER family: a
 * cross-family ticket reaches the `log.warn` below and is discarded, not
 * honoured.
 */
export async function consumeSignupTicket(
  db: PrismaClient,
  token: string,
  family: SignupFamily,
): Promise<string | null> {
  const result = await verifyMagicLinkToken(db, token);
  if (!result) return null;
  if (result.purpose !== TICKET_PURPOSE[family]) {
    log.warn(
      { purpose: result.purpose, family },
      'signup ticket cookie carried a token from a different family; it was consumed and discarded',
    );
    return null;
  }
  return result.email;
}

export function setSignupTicketCookie(headers: Headers, token: string): void {
  let cookie = `${SIGNUP_TICKET_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TICKET_TTL_MS / 1000}`;
  if (process.env.NODE_ENV === 'production') cookie += '; Secure';
  headers.append('Set-Cookie', cookie);
}

export function clearSignupTicketCookie(headers: Headers): void {
  let cookie = `${SIGNUP_TICKET_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  if (process.env.NODE_ENV === 'production') cookie += '; Secure';
  headers.append('Set-Cookie', cookie);
}
