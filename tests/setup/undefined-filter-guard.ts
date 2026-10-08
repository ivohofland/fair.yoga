/**
 * A `PrismaClient` built by test code carries `undefinedFilterGuard`, so a
 * bulk write whose `where` holds `undefined` rejects instead of matching every
 * row. A client built by application code (`src/lib/db.ts`) stays plain: its
 * `undefined` filters are deliberate optional filters and must behave exactly
 * as they do in production.
 *
 * Spec: docs/superpowers/specs/2026-10-08-undefined-filter-guard-design.md
 */
import { vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isTestCallSite, undefinedFilterGuard } from '../undefined-filter-guard';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '../..');

vi.mock('@prisma/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisma/client')>();
  class GuardedPrismaClient extends actual.PrismaClient {
    constructor(...args: ConstructorParameters<typeof actual.PrismaClient>) {
      super(...args);
      if (isTestCallSite(new Error().stack ?? '', [SELF], REPO_ROOT)) {
        // A query-only extension leaves the client's API unchanged, but `$extends` is typed as a new client type.
        return this.$extends(undefinedFilterGuard) as unknown as GuardedPrismaClient;
      }
    }
  }
  return { ...actual, PrismaClient: GuardedPrismaClient };
});
