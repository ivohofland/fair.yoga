import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * A client for handing a DATABASE-WIDE sweep in a test, narrowed to the
 * test's own rows.
 *
 * The shared test database keeps rows earlier runs left behind, and a sweep
 * with no scope parameter reads them. An assertion on such a sweep's return
 * value then depends on that leftover: it can go red when it should pass, or
 * green when it should fail. This client ANDs a per-model filter into the
 * top-level bulk statements a sweep issues on a scoped model.
 *
 * What the scope does NOT reach: raw SQL (`$queryRaw`, `$executeRaw`),
 * related rows loaded through `include`/`select` or matched by a relation
 * filter, nested writes, single-row operations and inserts. Those pass
 * through untouched, so the
 * scope holds only for a sweep that picks its candidates with a top-level
 * bulk read on a scoped model and keys everything after it by the ids that
 * read returned. `rowsRead` exists because a scoped `toBe(0)` passes
 * vacuously when the fixture has fallen out of the sweep's own predicate;
 * pair every zero assertion with a presence check.
 *
 * Prisma runs query extensions in attachment order: the earliest-attached
 * hook sees the caller's own args, and each later one only sees what the
 * earlier ones forwarded. A hook that must see the sweep's own `where`
 * shape therefore goes on the client passed in as `base`, before
 * `scopeSweep` ever runs: `scopeSweep(prisma.$extends(racing) as unknown as PrismaClient, scope)`.
 * Calling `.$extends(...)` on the returned `db` instead places the new hook
 * after the scope, where it only sees the AND-wrapped `where`.
 *
 * The rule this module exists to satisfy is written out in full in
 * `docs/test-database.md` §2, under "Sweep tests assert through a scoped
 * client".
 */
export type SweepScope = {
  [M in Prisma.ModelName]?: Prisma.TypeMap['model'][M]['operations']['findMany']['args']['where'];
};

export interface ScopedSweep {
  readonly db: PrismaClient;
  /**
   * Results returned on `model` by every operation `HANDLING` marks `read` —
   * rows, or groups for `groupBy` — summed over every such call made through
   * `db`, the test's own reads included. Throws for a model the
   * scope does not name, which no read through `db` could have narrowed.
   */
  readonly rowsRead: (model: Prisma.ModelName) => number;
}

/**
 * `read`: scoped, and its results count toward `rowsRead`.
 * `scoped`: scoped, not counted — an aggregate or a write.
 * `pass`: not narrowed — a single-row operation keyed by a unique field, or
 * an insert, which has no `where` to narrow.
 */
type Handling = 'read' | 'scoped' | 'pass';
type ModelOperation = Exclude<Prisma.PrismaAction, 'queryRaw' | 'executeRaw' | 'runCommandRaw' | 'findRaw'>;

const HANDLING = {
  findMany: 'read',
  findFirst: 'read',
  findFirstOrThrow: 'read',
  groupBy: 'read',
  count: 'scoped',
  aggregate: 'scoped',
  updateMany: 'scoped',
  updateManyAndReturn: 'scoped',
  deleteMany: 'scoped',
  findUnique: 'pass',
  findUniqueOrThrow: 'pass',
  create: 'pass',
  createMany: 'pass',
  createManyAndReturn: 'pass',
  update: 'pass',
  upsert: 'pass',
  delete: 'pass',
} as const satisfies Record<ModelOperation, Handling>;

function handlingOf(operation: string): Handling {
  if (!Object.hasOwn(HANDLING, operation)) {
    throw new Error(`scopeSweep: no handling for operation "${operation}"`);
  }
  return HANDLING[operation as ModelOperation];
}

/**
 * A filter leaf left `undefined` is dropped by Prisma, silently widening the
 * scope. Nested `{}` is left alone: under a relation filter (`some: {}`) it
 * is a real condition.
 */
function assertNoUndefined(value: unknown, path: string): void {
  if (value === undefined) throw new Error(`scopeSweep: ${path} is undefined`);
  if (value === null || typeof value !== 'object' || value instanceof Date) return;
  for (const [k, v] of Object.entries(value)) assertNoUndefined(v, `${path}.${k}`);
}

function validate(scope: SweepScope): void {
  const models = Object.keys(scope);
  if (models.length === 0) throw new Error('scopeSweep: the scope names no model');
  const known = new Set<string>(Object.values(Prisma.ModelName));
  for (const model of models) {
    if (!known.has(model)) throw new Error(`scopeSweep: "${model}" is not a model`);
    const filter = (scope as Record<string, unknown>)[model];
    // An empty top-level filter matches every row: no narrowing at all.
    if (filter !== null && typeof filter === 'object' && Object.keys(filter).length === 0) {
      throw new Error(`scopeSweep: ${model} is an empty filter`);
    }
    assertNoUndefined(filter, model);
  }
}

export function scopeSweep(base: PrismaClient, scope: SweepScope): ScopedSweep {
  validate(scope);
  const read = new Map<string, number>();
  const db = base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const handling = handlingOf(operation);
          const filter = (scope as Record<string, object | undefined>)[model];
          if (filter === undefined || handling === 'pass') return query(args);
          const a = (args ?? {}) as { where?: object };
          const result: unknown = await query({ ...a, where: a.where === undefined ? filter : { AND: [a.where, filter] } });
          if (handling === 'read') {
            const n = Array.isArray(result) ? result.length : result === null ? 0 : 1;
            read.set(model, (read.get(model) ?? 0) + n);
          }
          return result;
        },
      },
    },
  }) as unknown as PrismaClient;
  return {
    db,
    rowsRead: (model) => {
      if (!Object.hasOwn(scope, model)) throw new Error(`scopeSweep: rowsRead("${model}") but the scope does not name ${model}`);
      return read.get(model) ?? 0;
    },
  };
}
