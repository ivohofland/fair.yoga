/**
 * Auth-table hygiene: expired sessions and magic-link tokens serve no
 * purpose after their expiry (spent tokens are already deleted on use),
 * but nothing removed them — both tables grew forever. A daily sweep
 * keeps them bounded.
 */

import type { PrismaClient } from '@prisma/client';

export async function cleanupExpiredAuth(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<{ sessions: number; magicLinkTokens: number }> {
  const [sessions, tokens] = await Promise.all([
    db.session.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.magicLinkToken.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  return { sessions: sessions.count, magicLinkTokens: tokens.count };
}
