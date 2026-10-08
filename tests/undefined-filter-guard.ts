/**
 * Prisma drops a filter key whose value is `undefined`, so a bulk write like
 * `deleteMany({ where: { classId } })` with `classId` never assigned matches
 * every row. This module refuses such a write: a Prisma query extension that
 * walks the `where` of the bulk writes, plus the classifier that tells a test
 * call site from application code.
 *
 * Installers: `docs/test-database.md`, section "Undefined filters in test cleanup (#783)".
 *
 * Only types come from `@prisma/client`, so this module is callable from
 * inside a `vi.mock('@prisma/client')` factory.
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

interface BulkWriteParams<A> {
  model: string;
  operation: string;
  args: A;
  query: (args: A) => Promise<unknown>;
}

async function refuseUndefinedFilter<A>({ model, operation, args, query }: BulkWriteParams<A>): Promise<unknown> {
  if (typeof args === 'object' && args !== null && 'where' in args) {
    const paths = findUndefinedFilterPaths(args.where);
    if (paths.length > 0) {
      throw new Error(
        `${UNDEFINED_FILTER_GUARD_MESSAGE_PREFIX} ${model}.${operation}: ${paths.join(', ')} is undefined. ` +
          'Prisma drops an undefined filter value and this write would match every row. ' +
          'Assign the binding, guard the write (if (id) …), or omit the key.',
      );
    }
  }
  return query(args);
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

/** Who a stack's call site belongs to; `undecided` when no frame could say. */
export type CallSite = 'test' | 'app' | 'undecided';

/**
 * Classifies a stack's call site. Frames in `node:` modules, under
 * `node_modules/` or in `ignoreFiles` are skipped, as are lines that are not
 * file frames; the first remaining frame decides. A frame outside `repoRoot`
 * is `app`; one inside is `test` when it is a `.test`/`.spec` file or a module
 * under `tests/`, and `app` otherwise. The path is made relative to `repoRoot`
 * first, so a checkout under a directory named `tests` is not misread. A stack
 * with no remaining frame is `undecided`, never a guess.
 */
export function classifyCallSite(stack: string, ignoreFiles: readonly string[], repoRoot: string): CallSite {
  const root = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
  for (const line of stack.split('\n')) {
    const match = FRAME.exec(line);
    const raw = match?.[1];
    if (raw === undefined) continue;
    const file = raw.replace(/^file:\/\//, '').replace(/\?[^:]*$/, '');
    if (file.startsWith('node:')) continue;
    if (file.includes('/node_modules/')) continue;
    if (ignoreFiles.includes(file)) continue;
    if (!file.startsWith(root)) return 'app';
    const relative = file.slice(root.length);
    return /\.(test|spec)\.tsx?$/.test(relative) || relative.startsWith('tests/') ? 'test' : 'app';
  }
  return 'undecided';
}
