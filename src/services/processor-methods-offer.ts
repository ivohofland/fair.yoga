import { Prisma, type Currency, type PrismaClient } from '@/lib/prisma-client';
import { MollieUnavailable } from '@/lib/mollie/client';
import { orderOffered, type AllowedMollieMethod } from '@/lib/processor-methods';
import { logDegraded } from '@/lib/degradation';
import type { MollieDeps } from './mollie-deps';
import { getAccessToken } from './processor-token';
import { METHODS_CACHE_MS, offerCache, putOffer, type CachedOffer } from './processor-methods-cache';
export { forgetOfferedMethods, METHODS_CACHE_MS } from './processor-methods-cache';

export type OfferedMethods =
  | { kind: 'methods'; offered: AllowedMollieMethod[]; excluded: string[] }
  | { kind: 'unavailable' };

const MIN_AMOUNT = new Prisma.Decimal('0.01');
const EMPTY: CachedOffer = { kind: 'methods', offered: [], excluded: [] };

/** The teacher's enabled methods for this amount and currency that fair.yoga offers. */
export async function listOfferedMethods(
  db: PrismaClient,
  deps: MollieDeps,
  connection: { id: string; profileId: string; testmode: boolean },
  amount: Prisma.Decimal,
  currency: Currency,
  now: number = Date.now(),
): Promise<OfferedMethods> {
  if (amount.lessThan(MIN_AMOUNT)) return EMPTY;
  const key = `${connection.id}:${currency}:${amount.toFixed(2)}`;
  const hit = offerCache.get(key);
  if (hit && now - hit.at < METHODS_CACHE_MS) return hit.value;

  const token = await getAccessToken(db, deps, connection.id);
  if (token.kind !== 'token') return { kind: 'unavailable' };
  let value: CachedOffer;
  try {
    const answer = await deps.client.listMethods(token.accessToken, {
      profileId: connection.profileId,
      amount: { value: amount.toFixed(2), currency },
      testmode: connection.testmode,
    });
    value = answer.kind === 'unsupported' ? EMPTY : { kind: 'methods', ...orderOffered(answer.ids) };
  } catch (err) {
    if (!(err instanceof MollieUnavailable)) throw err;
    logDegraded('MOLLIE_UNAVAILABLE', { connectionId: connection.id, operation: 'listMethods', ...(err.status === null ? {} : { status: err.status }) }, 'Mollie methods unavailable; pay page shows the other rows', err);
    return { kind: 'unavailable' };
  }
  putOffer(key, value, now);
  return value;
}
