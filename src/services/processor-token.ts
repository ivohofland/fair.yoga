import type { PrismaClient } from '@/lib/prisma-client';
import { MollieUnavailable, type TokenAnswer, type TokenGrant } from '@/lib/mollie/client';
import { openToken, sealToken, TokenCipherError } from '@/lib/processor-token-cipher';
import { logDegraded } from '@/lib/degradation';
import { lockTeacherForNoKeyUpdate } from '@/lib/db-locks';
import { createNotification } from './notifications';
import { forgetOfferedMethods } from './processor-methods-cache';
import type { MollieDeps } from './mollie-deps';

export type TokenLookup =
  | { kind: 'token'; accessToken: string }
  | { kind: 'disconnected' }
  | { kind: 'unavailable' };
export const REFRESH_MARGIN_MS = 5 * 60_000;

const inflight = new Map<string, Promise<TokenLookup>>();

export function sealGrant(grant: TokenGrant, key: Buffer, now: Date) {
  return {
    accessToken: new Uint8Array(sealToken(grant.accessToken, key)),
    refreshToken: new Uint8Array(sealToken(grant.refreshToken, key)),
    accessTokenExpiresAt: new Date(now.getTime() + grant.expiresInSeconds * 1000),
  };
}

/**
 * A usable access token for a connection not yet revoked. Refreshes inside
 * `REFRESH_MARGIN_MS`, once per connection at a time in this process; a
 * conditional write settles a refresh that raced another.
 */
export async function getAccessToken(
  db: PrismaClient,
  deps: MollieDeps,
  connectionId: string,
  now: Date = new Date(),
): Promise<TokenLookup> {
  const row = await db.processorConnection.findUnique({
    where: { id: connectionId },
    select: { teacherId: true, accessToken: true, refreshToken: true, accessTokenExpiresAt: true, revokedAt: true },
  });
  if (!row || row.revokedAt !== null || !row.accessToken || !row.refreshToken || !row.accessTokenExpiresAt) {
    return { kind: 'disconnected' };
  }
  let access: string;
  let refresh: string;
  try {
    access = openToken(row.accessToken, deps.config.tokenKey);
    refresh = openToken(row.refreshToken, deps.config.tokenKey);
  } catch (err) {
    if (!(err instanceof TokenCipherError)) throw err;
    logDegraded(
      'PROCESSOR_TOKEN_UNREADABLE',
      { connectionId },
      'stored processor token could not be opened; is PROCESSOR_TOKEN_KEY the key it was sealed with?',
      err,
    );
    return { kind: 'unavailable' };
  }
  if (row.accessTokenExpiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS) {
    return { kind: 'token', accessToken: access };
  }

  const running = inflight.get(connectionId);
  if (running) return running;
  const flight = refreshOnce(db, deps, connectionId, row.teacherId, refresh, row.refreshToken, now).finally(() =>
    inflight.delete(connectionId),
  );
  inflight.set(connectionId, flight);
  return flight;
}

async function refreshOnce(
  db: PrismaClient,
  deps: MollieDeps,
  connectionId: string,
  teacherId: string,
  refreshToken: string,
  sealedRefresh: Uint8Array<ArrayBuffer>,
  now: Date,
): Promise<TokenLookup> {
  // The caller's read may predate a flight that has since finished; the row
  // as it stands now says whether a refresh is still due.
  const settled = await settledLookup(db, deps, connectionId, now);
  if (settled !== null) return settled;

  let answer: TokenAnswer;
  try {
    answer = await deps.client.refresh(refreshToken);
  } catch (err) {
    if (!(err instanceof MollieUnavailable)) throw err;
    logDegraded(
      'MOLLIE_UNAVAILABLE',
      { connectionId, operation: 'refresh', ...(err.status === null ? {} : { status: err.status }) },
      'Mollie could not refresh an access token',
      err,
    );
    return { kind: 'unavailable' };
  }

  if (answer.kind === 'invalid_grant') {
    const outcome = await db.$transaction(async (tx): Promise<'disconnected' | 'teacher_gone' | 'superseded'> => {
      // The teacher first, as every connection writer takes it
      // (docs/lock-order.md). An erased teacher gets nothing written.
      if ((await lockTeacherForNoKeyUpdate(tx, teacherId)) === null) return 'teacher_gone';
      // The row is locked before `disconnectedAt` is read, so a disconnect
      // that commits while this waits is seen; the refresh token it still
      // holds is the one Mollie refused, or a newer grant has won.
      const [first] = await tx.$queryRaw<{ wasDisconnected: boolean }[]>`
        SELECT ("disconnectedAt" IS NOT NULL) AS "wasDisconnected"
          FROM "ProcessorConnection"
         WHERE id = ${connectionId} AND "revokedAt" IS NULL AND "refreshToken" = ${sealedRefresh}
           FOR UPDATE`;
      if (first === undefined) return 'superseded';
      await tx.$executeRaw`
        UPDATE "ProcessorConnection"
           SET "accessToken" = NULL, "refreshToken" = NULL, "accessTokenExpiresAt" = NULL,
               "disconnectedAt" = COALESCE("disconnectedAt", ${now}),
               "revokeAfter" = NULL, "revokedAt" = ${now}
         WHERE id = ${connectionId}`;
      if (!first.wasDisconnected) {
        await createNotification(tx, {
          recipientType: 'teacher',
          recipientId: teacherId,
          type: 'processor_disconnected',
          title: 'Mollie disconnected',
          body: 'fair.yoga can no longer reach your Mollie account, so students see your other payment options. Reconnect in Settings → Profile.',
        });
      }
      return 'disconnected';
    });
    if (outcome === 'teacher_gone') return { kind: 'disconnected' };
    if (outcome === 'disconnected') {
      logDegraded('PROCESSOR_DISCONNECTED', { connectionId }, 'Mollie refused the refresh token; the connection was disconnected');
      forgetOfferedMethods(connectionId);
      return { kind: 'disconnected' };
    }
    return (await settledLookup(db, deps, connectionId, now)) ?? { kind: 'unavailable' };
  }

  const { count } = await db.processorConnection.updateMany({
    where: { id: connectionId, refreshToken: sealedRefresh },
    data: sealGrant(answer.grant, deps.config.tokenKey, now),
  });
  if (count === 1) return { kind: 'token', accessToken: answer.grant.accessToken };
  return (await settledLookup(db, deps, connectionId, now)) ?? { kind: 'unavailable' };
}

/** What the row now says, or null when it still needs a refresh. */
async function settledLookup(db: PrismaClient, deps: MollieDeps, connectionId: string, now: Date): Promise<TokenLookup | null> {
  const row = await db.processorConnection.findUnique({
    where: { id: connectionId },
    select: { accessToken: true, accessTokenExpiresAt: true, revokedAt: true },
  });
  if (!row || row.revokedAt !== null) return { kind: 'disconnected' };
  if (!row.accessToken || !row.accessTokenExpiresAt) return null;
  if (row.accessTokenExpiresAt.getTime() - now.getTime() <= REFRESH_MARGIN_MS) return null;
  try {
    return { kind: 'token', accessToken: openToken(row.accessToken, deps.config.tokenKey) };
  } catch (err) {
    if (!(err instanceof TokenCipherError)) throw err;
    logDegraded('PROCESSOR_TOKEN_UNREADABLE', { connectionId }, 'stored processor token could not be opened; is PROCESSOR_TOKEN_KEY the key it was sealed with?', err);
    return { kind: 'unavailable' };
  }
}
