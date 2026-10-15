import crypto from 'crypto';
import type { PrismaClient } from '@/lib/prisma-client';
import { hashToken } from '@/lib/auth/magic-link';

/** How long a "This wasn't me" link works. */
export const PAUSE_TOKEN_TTL_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Mints the secret behind one payout-change email's "This wasn't me" link and
 * returns it raw. Only its SHA-256 is stored, so a database read cannot be
 * turned into a pause link: the raw value is never persisted, only its hash.
 * `pausePayments` looks it up by `hashToken(raw)`.
 */
export async function mintPayoutPauseToken(db: PrismaClient, teacherId: string, eventId: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString('hex');
  await db.payoutPauseToken.create({
    data: {
      tokenHash: hashToken(raw),
      teacherId,
      eventId,
      expiresAt: new Date(Date.now() + PAUSE_TOKEN_TTL_DAYS * DAY_MS),
    },
  });
  return raw;
}
