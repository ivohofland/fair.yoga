import type { PrismaClient } from '@/lib/prisma-client';
import { MollieUnavailable, type TokenGrant } from '@/lib/mollie/client';
import { openToken, sealToken, TokenCipherError } from '@/lib/processor-token-cipher';
import { logDegraded } from '@/lib/degradation';
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
  let answer;
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
    await db.$transaction(async (tx) => {
      const current = await tx.processorConnection.findUnique({ where: { id: connectionId }, select: { disconnectedAt: true } });
      const { count } = await tx.processorConnection.updateMany({
        where: { id: connectionId, revokedAt: null },
        data: {
          accessToken: null,
          refreshToken: null,
          accessTokenExpiresAt: null,
          disconnectedAt: current?.disconnectedAt ?? now,
          revokeAfter: null,
          revokedAt: now,
        },
      });
      if (count === 1) {
        await createNotification(tx, {
          recipientType: 'teacher',
          recipientId: teacherId,
          type: 'processor_disconnected',
          title: 'Mollie disconnected',
          body: 'fair.yoga can no longer reach your Mollie account, so students see your other payment options. Reconnect in Settings → Profile.',
        });
      }
    });
    logDegraded('PROCESSOR_DISCONNECTED', { connectionId }, 'Mollie refused the refresh token; the connection was disconnected');
    forgetOfferedMethods(connectionId);
    return { kind: 'disconnected' };
  }

  const { count } = await db.processorConnection.updateMany({
    where: { id: connectionId, refreshToken: sealedRefresh },
    data: sealGrant(answer.grant, deps.config.tokenKey, now),
  });
  if (count === 1) return { kind: 'token', accessToken: answer.grant.accessToken };

  const winner = await db.processorConnection.findUnique({
    where: { id: connectionId },
    select: { accessToken: true, accessTokenExpiresAt: true, revokedAt: true },
  });
  if (!winner || winner.revokedAt !== null) return { kind: 'disconnected' };
  if (!winner.accessToken || !winner.accessTokenExpiresAt) return { kind: 'unavailable' };
  if (winner.accessTokenExpiresAt.getTime() - now.getTime() <= REFRESH_MARGIN_MS) return { kind: 'unavailable' };
  try {
    return { kind: 'token', accessToken: openToken(winner.accessToken, deps.config.tokenKey) };
  } catch (err) {
    if (!(err instanceof TokenCipherError)) throw err;
    logDegraded('PROCESSOR_TOKEN_UNREADABLE', { connectionId }, 'stored processor token could not be opened; is PROCESSOR_TOKEN_KEY the key it was sealed with?', err);
    return { kind: 'unavailable' };
  }
}
