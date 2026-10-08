import { PrismaClient } from '@prisma/client';
import { undefinedFilterGuard } from '../undefined-filter-guard';

/**
 * Playwright has no module mocking, so an e2e spec builds its client here and
 * a bulk write whose `where` holds `undefined` rejects instead of matching
 * every row. See `docs/test-database.md`, section "Undefined filters in test
 * cleanup (#783)".
 */
export function createGuardedPrismaClient(...args: ConstructorParameters<typeof PrismaClient>): PrismaClient {
  // The cast restores `PrismaClient`'s type; the extended client has no `$on`/`$use`.
  return new PrismaClient(...args).$extends(undefinedFilterGuard) as unknown as PrismaClient;
}
