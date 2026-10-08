/**
 * Auth-table hygiene: expired sessions, magic-link tokens and payout pause
 * tokens serve no purpose after their expiry, and a handoff budget serves
 * none once its window has ended. A daily sweep keeps them bounded.
 */

import type { PrismaClient } from '@prisma/client';
import { HANDOFF_EMAIL_WINDOW_MS } from '@/lib/auth/handoff';

export async function cleanupExpiredAuth(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<{
  sessions: number;
  magicLinkTokens: number;
  handoffAttemptBudgets: number;
  payoutPauseTokens: number;
}> {
  const [sessions, tokens, budgets, pauseTokens] = await Promise.all([
    db.session.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.magicLinkToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.handoffAttemptBudget.deleteMany({
      where: { windowStartsAt: { lte: new Date(now.getTime() - HANDOFF_EMAIL_WINDOW_MS) } },
    }),
    db.payoutPauseToken.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  return {
    sessions: sessions.count,
    magicLinkTokens: tokens.count,
    handoffAttemptBudgets: budgets.count,
    payoutPauseTokens: pauseTokens.count,
  };
}
