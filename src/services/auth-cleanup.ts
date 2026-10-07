/**
 * Auth-table hygiene: expired sessions and magic-link tokens serve no
 * purpose after their expiry, and a handoff budget serves none once its
 * window has ended. A daily sweep keeps them bounded.
 */

import type { PrismaClient } from '@prisma/client';
import { HANDOFF_EMAIL_WINDOW_MS } from '@/lib/auth/handoff';

export async function cleanupExpiredAuth(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<{ sessions: number; magicLinkTokens: number; handoffAttemptBudgets: number }> {
  const [sessions, tokens, budgets] = await Promise.all([
    db.session.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.magicLinkToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.handoffAttemptBudget.deleteMany({
      where: { windowStartsAt: { lte: new Date(now.getTime() - HANDOFF_EMAIL_WINDOW_MS) } },
    }),
  ]);
  return {
    sessions: sessions.count,
    magicLinkTokens: tokens.count,
    handoffAttemptBudgets: budgets.count,
  };
}
