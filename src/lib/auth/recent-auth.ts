import type { PrismaClient } from '@prisma/client';

/**
 * How recently a person must have signed in to add a passkey.
 *
 * Every sign-in door mints a new `Session` row, so a session's `createdAt` is
 * the time of the last authentication; a session that merely slid its expiry
 * forward is not a recent one.
 */
export const RECENT_AUTH_WINDOW_MS = 5 * 60 * 1000;

/**
 * True when the session row `sessionId` (a `SessionUser.sessionId`) was
 * created within `RECENT_AUTH_WINDOW_MS` of `now`. A row that no longer exists
 * is not recent.
 */
export async function hasRecentAuth(
  db: PrismaClient,
  sessionId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const session = await db.session.findUnique({
    where: { id: sessionId },
    select: { createdAt: true },
  });
  if (!session) return false;
  return now - session.createdAt.getTime() < RECENT_AUTH_WINDOW_MS;
}
