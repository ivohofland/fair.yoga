import crypto from 'crypto';
import type { PrismaClient, MagicLinkPurpose } from '@prisma/client';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

/**
 * Mints a single-use sign-in link token, returning the RAW token for the
 * email and storing only its SHA-256 hash.
 *
 * A second call for the same address deliberately mints a second live token
 * rather than reusing or invalidating the first: a resend must work, and the
 * first link must keep working, because the user clicks whichever mail they
 * see first. That duplication is legitimate (#196) and bounded — though less
 * tightly than a per-route reading suggests. Each minting route rate-limits
 * per address in its OWN bucket, so the live token count for one address is
 * bounded by the sum of the routes that mint for it — not by any single
 * route's limit. The TTL is 15 minutes, `cleanupExpiredAuth` sweeps the
 * remains daily, and `verifyMagicLinkToken` deletes every sibling the moment
 * one of them is used.
 *
 * Reusing a live token instead is NOT possible and must not be attempted: the
 * raw value is returned here and persisted nowhere, so recovering it from a
 * row would mean inverting SHA-256. Storing it raw, or reversibly, would make
 * any database read a sign-in — which is the whole reason this column is a
 * hash. #196's original design proposed reuse; that is why this note exists.
 */
export async function generateMagicLinkToken(
  db: PrismaClient,
  email: string,
  opts?: { redirectTo?: string; purpose?: MagicLinkPurpose; ttlMs?: number },
): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + (opts?.ttlMs ?? FIFTEEN_MINUTES_MS));

  await db.magicLinkToken.create({
    data: {
      tokenHash,
      email,
      redirectTo: opts?.redirectTo ?? null,
      purpose: opts?.purpose ?? 'sign_in',
      expiresAt,
    },
  });

  return rawToken;
}

export async function verifyMagicLinkToken(
  db: PrismaClient,
  token: string
): Promise<{ email: string; redirectTo: string | null; purpose: MagicLinkPurpose } | null> {
  const tokenHash = hashToken(token);

  const record = await db.magicLinkToken.findUnique({
    where: { tokenHash },
  });

  if (!record) {
    return null;
  }

  // Atomic single-use: exactly one concurrent verification wins the delete;
  // any other sees count 0 and fails. (find-then-delete was a race.)
  const deleted = await db.magicLinkToken.deleteMany({ where: { id: record.id } });
  if (deleted.count === 0) {
    return null;
  }

  if (record.expiresAt <= new Date()) {
    return null;
  }

  // Every other live token for this address is now surplus: its owner is
  // signed in, so the only thing a link still sitting in their inbox can do
  // is be used by someone else — a forwarded mail, a shared mailbox, a
  // link-prefetching scanner. How many that can be is bounded per this
  // function's own docblock above, not restated here.
  //
  // Placement is load-bearing: this runs only AFTER the expiry check above.
  // Invalidating on every consumption would let anyone holding an old expired
  // link destroy the user's fresh one — a guard that creates the denial of
  // service it exists to prevent.
  //
  // Unindexed by design. `MagicLinkToken` carries `@unique` on `tokenHash`
  // only, and adding an index means a migration. What actually bounds the
  // table is `cleanupExpiredAuth`'s daily sweep of `expiresAt < now` — roughly
  // a day's accumulation — NOT the rate limiter, which caps rows per address
  // and says nothing about how many addresses there are.
  await db.magicLinkToken.deleteMany({ where: { email: record.email } });

  return { email: record.email, redirectTo: record.redirectTo, purpose: record.purpose };
}

/**
 * Deletes expired tokens and returns the count.
 *
 * **Nothing in production calls this.** The daily sweep is
 * `cleanupExpiredAuth` (`services/auth-cleanup.ts`), wired to both the cron
 * route and the scheduler's 24-hour job; this function's only callers are its
 * own tests. Said out loud because the name is the more obvious of the two and
 * has already been cited, in a comment on this very file, as the reason an
 * unindexed `deleteMany` stays cheap — a justification resting on a function
 * that never runs. If you are reaching for a token sweep, you want the other
 * one.
 */
export async function cleanupExpiredTokens(
  db: PrismaClient
): Promise<number> {
  const result = await db.magicLinkToken.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
    },
  });

  return result.count;
}
