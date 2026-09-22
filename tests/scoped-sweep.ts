import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * A client for handing a DATABASE-WIDE sweep in a test, narrowed to the
 * test's own rows.
 *
 * The shared test database keeps rows earlier runs left behind, and a sweep
 * with no scope parameter reads them. An assertion on such a sweep's return
 * value then depends on that leftover: it can go red when it should pass, or
 * green when it should fail. This client ANDs a per-model filter into the
 * sweep's bulk statements so the sweep only ever sees what the test built.
 * `docs/test-database.md` states the convention.
 *
 * Single-row operations pass through untouched: they are keyed by an id the
 * sweep took from a scoped read. `rowsRead` exists because a scoped
 * `toBe(0)` passes vacuously when the fixture has fallen out of the sweep's
 * own predicate; pair every zero assertion with it.
 *
 * Prisma runs query extensions in attachment order: the earliest-attached
 * hook sees the caller's own args, and each later one only sees what the
 * earlier ones forwarded. A hook that must see the sweep's own `where`
 * shape — the class-transitions and email-fallback race hooks do this —
 * therefore goes on the client passed in as `base`, before `scopeSweep`
 * ever runs: `scopeSweep(prisma.$extends(racing) as unknown as PrismaClient, scope)`.
 * Calling `.$extends(...)` on the returned `db` instead places the new hook
 * after the scope, where it only sees the AND-wrapped `where`.
 */
export type SweepScope = {
  [M in Prisma.ModelName]?: Prisma.TypeMap['model'][M]['operations']['findMany']['args']['where'];
};

export interface ScopedSweep {
  db: PrismaClient;
  rowsRead(model: Prisma.ModelName): number;
}

const SCOPED = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'groupBy', 'aggregate', 'updateMany', 'updateManyAndReturn', 'deleteMany']);
const READS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'groupBy']);

export function scopeSweep(base: PrismaClient, scope: SweepScope): ScopedSweep {
  const read = new Map<string, number>();
  const db = base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const filter = (scope as Record<string, object | undefined>)[model];
          if (filter === undefined || !SCOPED.has(operation)) return query(args);
          const a = args as { where?: object };
          const result: unknown = await query({ ...a, where: a.where === undefined ? filter : { AND: [a.where, filter] } });
          if (READS.has(operation)) {
            const n = Array.isArray(result) ? result.length : result === null ? 0 : 1;
            read.set(model, (read.get(model) ?? 0) + n);
          }
          return result;
        },
      },
    },
  }) as unknown as PrismaClient;
  return { db, rowsRead: (model) => read.get(model) ?? 0 };
}
