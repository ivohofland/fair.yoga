import { PrismaClient } from '@prisma/client';
import { undefinedFilterGuard } from '../undefined-filter-guard';

/**
 * Playwright has no module mocking, so an e2e spec builds its client here and
 * a bulk write whose `where` holds `undefined` rejects instead of matching
 * every row. `eslint.config.mjs` bans `new PrismaClient()` elsewhere in
 * `tests/e2e`.
 */
export function createGuardedPrismaClient(...args: ConstructorParameters<typeof PrismaClient>): PrismaClient {
  // The extended client lacks `$on`/`$use`, which no test calls; every other member matches `PrismaClient`.
  return new PrismaClient(...args).$extends(undefinedFilterGuard) as unknown as PrismaClient;
}
