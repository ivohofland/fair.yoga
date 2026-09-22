import type { Prisma, PrismaClient } from '@prisma/client';
import type { JsArgs, QueryOptionsCbArgs } from '@prisma/client/runtime/library';

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
 * A Prisma query extension composes in attachment order: the earliest
 * attached hook runs first and hands later ones whatever it forwards, so in
 * `base.$extends(A).$extends(B)`, A sees the caller's own args and B only
 * sees what A forwarded. If the scope filter were attached first, a caller
 * composing a hook on top of `db` — the class-transitions and
 * email-fallback race hooks do this to match `args.where`'s shape — would
 * only ever see the AND-wrapped `where`, never its own. `$extends` on the
 * returned client is therefore intercepted: a caller's extension is
 * attached to the pre-scope `base` first, and the scope filter is
 * reattached last, so it stays the final transformation before the query
 * reaches the database while the caller's own hook keeps seeing `where` in
 * its own shape.
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

type ExtendsArg = Parameters<PrismaClient['$extends']>[0];

// The one cast in this file: an extended client's own generic instantiation
// is not literally `PrismaClient`, but it satisfies the same runtime shape,
// which is all `db`'s callers (and the recursive `$extends` interception
// below) rely on.
function asPrismaClient(client: unknown): PrismaClient {
  return client as unknown as PrismaClient;
}

export function scopeSweep(base: PrismaClient, scope: SweepScope): ScopedSweep {
  const read = new Map<string, number>();

  // A top-level `$allOperations` (not nested under `$allModels`) fires for
  // every model and operation with a plain, non-generic callback type —
  // `model` is only absent for a raw, model-less query, which `filter`
  // below naturally leaves unscoped.
  async function allOperations({ model, operation, args, query }: QueryOptionsCbArgs): Promise<unknown> {
    const filter = (scope as Record<string, object | undefined>)[model ?? ''];
    if (filter === undefined || !SCOPED.has(operation)) return query(args);
    const a = args as { where?: object };
    const result: unknown = await query({ ...a, where: a.where === undefined ? filter : { AND: [a.where, filter] } } as JsArgs);
    if (READS.has(operation)) {
      const key = model ?? '';
      const n = Array.isArray(result) ? result.length : result === null ? 0 : 1;
      read.set(key, (read.get(key) ?? 0) + n);
    }
    return result;
  }

  const scopeExtension = { query: { $allOperations: allOperations } };
  const scoped = base.$extends(scopeExtension);

  // A caller's own `$extends` call is redirected here: it attaches to
  // `base` (before the scope) rather than to `scoped`, then reattaches
  // the scope filter, so the scope stays the last hook to run.
  function extendLast(extArgs: ExtendsArg): PrismaClient {
    const withCaller = asPrismaClient(base.$extends(extArgs));
    return asPrismaClient(withCaller.$extends(scopeExtension));
  }

  const db = asPrismaClient(
    new Proxy(scoped, {
      get(t, prop, receiver) {
        return prop === '$extends' ? extendLast : Reflect.get(t, prop, receiver);
      },
    }),
  );

  return { db, rowsRead: (model) => read.get(model) ?? 0 };
}
