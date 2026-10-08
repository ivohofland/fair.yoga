/**
 * Prisma drops a filter key whose value is `undefined`, so a bulk write like
 * `deleteMany({ where: { classId } })` with `classId` never assigned matches
 * every row. This module refuses such a write: a Prisma query extension that
 * walks the `where` of the bulk writes, plus the classifier that tells a test
 * call site from application code.
 *
 * Installed by `tests/setup/undefined-filter-guard.ts` and `tests/e2e/prisma.ts`.
 *
 * Only types come from `@prisma/client`: the unit-tier installer calls this
 * module from inside a `vi.mock('@prisma/client')` factory, where a runtime
 * import would be circular.
 */
import type { PrismaClient } from '@prisma/client';

export const UNDEFINED_FILTER_GUARD_MESSAGE_PREFIX = '[undefined-filter-guard]';

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Paths of every `undefined` reachable through arrays and plain objects.
 * Anything else (Date, Decimal, Prisma null sentinels, class instances) is a leaf.
 */
export function findUndefinedFilterPaths(where: unknown, path: string = 'where'): string[] {
  if (where === undefined) return [path];
  if (where === null || typeof where !== 'object') return [];
  if (Array.isArray(where)) {
    return where.flatMap((element: unknown, i) => findUndefinedFilterPaths(element, `${path}[${i}]`));
  }
  if (!isPlainObject(where)) return [];
  return Object.entries(where).flatMap(([key, value]) => findUndefinedFilterPaths(value, `${path}.${key}`));
}

interface BulkWriteParams {
  model: string;
  operation: string;
  args: unknown;
  query: (args: never) => Promise<unknown>;
}

async function refuseUndefinedFilter({ model, operation, args, query }: BulkWriteParams): Promise<unknown> {
  if (typeof args === 'object' && args !== null && 'where' in args) {
    const paths = findUndefinedFilterPaths((args as { where: unknown }).where);
    if (paths.length > 0) {
      throw new Error(
        `${UNDEFINED_FILTER_GUARD_MESSAGE_PREFIX} ${model}.${operation}: ${paths.join(', ')} is undefined. ` +
          'Prisma drops an undefined filter value and this write would match every row. ' +
          'Assign the binding, guard the write (if (id) …), or omit the key.',
      );
    }
  }
  return query(args as never);
}

export const undefinedFilterGuard = {
  name: 'undefined-filter-guard',
  query: {
    $allModels: {
      deleteMany: refuseUndefinedFilter,
      updateMany: refuseUndefinedFilter,
      updateManyAndReturn: refuseUndefinedFilter,
    },
  },
} satisfies Parameters<PrismaClient['$extends']>[0];

const FRAME = /^\s*at (?:.*? \()?(.+?):\d+:\d+\)?\s*$/;

/**
 * Whether the first stack frame outside libraries, `ignoreFiles` and
 * `repoRoot`-external code is a test file or a module under `tests/`.
 * The path is made relative to `repoRoot` first, so a checkout under a
 * directory named `tests` is not misread.
 */
export function isTestCallSite(stack: string, ignoreFiles: readonly string[], repoRoot: string): boolean {
  const root = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
  for (const line of stack.split('\n')) {
    const match = FRAME.exec(line);
    const raw = match?.[1];
    if (raw === undefined) continue;
    const file = raw.replace(/^file:\/\//, '').replace(/\?[^:]*$/, '');
    if (file.startsWith('node:')) continue;
    if (file.includes('/node_modules/')) continue;
    if (ignoreFiles.includes(file)) continue;
    if (!file.startsWith(root)) return false;
    const relative = file.slice(root.length);
    return /\.(test|spec)\.tsx?$/.test(relative) || relative.startsWith('tests/');
  }
  return false;
}
