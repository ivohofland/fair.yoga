import type { MagicLinkPurpose, PrismaClient } from '@prisma/client';
import { generateMagicLinkToken, verifyMagicLinkToken, hashToken } from './magic-link';
import { isSafeRelativePath, TEACHER_PROFILE_PATH } from '@/lib/schemas';
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
 * Single-use, and destructive before it is discriminating: the delete inside
 * `verifyMagicLinkToken` (see `consumeTokenRow` for its full reach — it takes
 * more than the one row) happens before the purpose check below, so a token
 * of the wrong purpose is spent by being refused. That is deliberate — the
 * atomic delete is what stops two concurrent submissions both creating a
 * profile for one ticket — but it means this is not the function to reach for
 * when a wrong-family token should survive being looked at.
 *
 * Returns the VERIFIED address. The profile route must never take an email
 * from a request body.
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

/**
 * A token's address and purpose, but only if it's still a LIVE ticket of some
 * family — membership checked against `TICKET_PURPOSE` rather than a
 * duplicated purpose list, so any `SignupFamily`'s purpose joins this
 * predicate by construction. The one definition every reader below builds on,
 * so none of them can drift from the others on what "live" means.
 */
async function readLiveTicket(
  db: PrismaClient,
  token: string,
): Promise<{ email: string; purpose: MagicLinkPurpose } | null> {
  const row = await db.magicLinkToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { email: true, expiresAt: true, purpose: true },
  });
  if (!row || row.expiresAt <= new Date()) return null;
  const isTicket = (Object.values(TICKET_PURPOSE) as MagicLinkPurpose[]).includes(row.purpose);
  return isTicket ? { email: row.email, purpose: row.purpose } : null;
}

/**
 * The address behind a live signup ticket of either family, without consuming
 * it or caring which family it belongs to — or `null` when there is no live
 * ticket to speak of. Cookie presence alone is not enough for a caller to
 * mean anything by this: a token that is missing, expired, or was never a
 * ticket at all must all read as "no live ticket", not as evidence something
 * was cancelled. The address is what lets a caller tell a signup it DISPLACES
 * from the same signup being restarted.
 */
export async function liveSignupTicketEmail(
  db: PrismaClient,
  token: string,
): Promise<string | null> {
  return (await readLiveTicket(db, token))?.email ?? null;
}

/**
 * The other family's purpose, if that's genuinely what this token is — a
 * live ticket for a family other than the one asked about — or `null` for
 * every other reason a caller's own family-scoped read of this token would
 * fail (missing, expired, not a ticket, or already the right family). Reads
 * only; the row is never touched.
 */
export async function signupTicketCrossFamilyPurpose(
  db: PrismaClient,
  token: string,
  family: SignupFamily,
): Promise<MagicLinkPurpose | null> {
  const ticket = await readLiveTicket(db, token);
  return ticket && ticket.purpose !== TICKET_PURPOSE[family] ? ticket.purpose : null;
}

/**
 * The destination-first ticket decision shared by `magic-link/verify` and
 * `magic-link/claim` — both routes redeem the same token family/purpose
 * shape and must agree on what a resulting ticket authorizes. Destination
 * first, family second: the teacher ticket has a page that always exists;
 * the student ticket's home is a redirect the caller supplied, so "mint a
 * ticket" and "have somewhere to spend it" are two facts that can come
 * apart. Returning `null` when they don't means the caller falls through to
 * its own 400 rather than producing a credential with no page to spend it
 * on.
 */
export function signupTicketFor(
  purpose: MagicLinkPurpose,
  tokenRedirect: string | null,
): { family: SignupFamily; dest: string } | null {
  switch (purpose) {
    case 'teacher_signup':
      return { family: 'teacher', dest: TEACHER_PROFILE_PATH };
    case 'student_signup':
      if (tokenRedirect && isSafeRelativePath(tokenRedirect)) {
        return { family: 'student', dest: tokenRedirect };
      }
      // A `student_signup` token whose redirect is gone or unsafe: its
      // single use is already spent by the time this runs, and there is
      // nowhere for the ticket it would authorize to go. Refusing is right;
      // refusing silently is not, because the caller's `null` handling reads
      // as "Account not found" and this is not that.
      log.error(
        { purpose, hasRedirect: tokenRedirect !== null },
        'signup token verified but its redirect is missing or unsafe; no ticket minted',
      );
      return null;
    case 'sign_in':
    case 'teacher_profile_pending':
    case 'student_profile_pending':
      return null;
    default: {
      const unreachable: never = purpose;
      log.error({ purpose: unreachable }, 'signupTicketFor reached an unhandled MagicLinkPurpose');
      return null;
    }
  }
}
