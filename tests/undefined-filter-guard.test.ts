import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  findUndefinedFilterPaths,
  classifyCallSite,
  undefinedFilterGuard,
  UNDEFINED_FILTER_GUARD_MESSAGE_PREFIX,
} from './undefined-filter-guard';
import { uniqueSuffix } from './helpers';
import { prisma as appPrisma } from '@/lib/db';

describe('findUndefinedFilterPaths', () => {
  it('names a top-level undefined value', () => {
    expect(findUndefinedFilterPaths({ classId: undefined, teacherId: 't1' })).toEqual(['where.classId']);
  });
  it('names an undefined inside an operator object (`{ in: ids }` with ids unassigned)', () => {
    expect(findUndefinedFilterPaths({ id: { in: undefined } })).toEqual(['where.id.in']);
  });
  it('names an undefined array element', () => {
    expect(findUndefinedFilterPaths({ id: { in: ['a', undefined] } })).toEqual(['where.id.in[1]']);
  });
  it('walks AND/OR/NOT and relation filters', () => {
    expect(
      findUndefinedFilterPaths({ AND: [{ x: 1 }, { class: { teacherId: undefined } }] }),
    ).toEqual(['where.AND[1].class.teacherId']);
  });
  it('treats an explicitly undefined where as a hazard', () => {
    expect(findUndefinedFilterPaths(undefined)).toEqual(['where']);
  });
  it('passes a fully defined filter, Prisma.DbNull, Dates and Decimals', () => {
    expect(
      findUndefinedFilterPaths({
        a: 'x',
        b: Prisma.DbNull,
        c: { gte: new Date(0) },
        d: new Prisma.Decimal(1),
        e: null,
      }),
    ).toEqual([]);
  });
});

describe('classifyCallSite', () => {
  const setup = '/repo/tests/setup/undefined-filter-guard.ts';
  const frame = (file: string): string => `    at something (${file}:10:5)`;
  const stack = (...files: string[]): string => ['Error', ...files.map(frame)].join('\n');

  it('is test when the first non-library frame is a test file', () => {
    expect(classifyCallSite(stack('/repo/node_modules/x/y.js', setup, '/repo/src/app/api/a/route.test.ts'), [setup], '/repo')).toBe('test');
  });
  it('is test for a module under tests/', () => {
    expect(classifyCallSite(stack(setup, '/repo/tests/class-fixtures.ts'), [setup], '/repo')).toBe('test');
  });
  it('is app for app code', () => {
    expect(classifyCallSite(stack(setup, '/repo/src/lib/db.ts', '/repo/src/app/api/a/route.test.ts'), [setup], '/repo')).toBe('app');
  });
  it('is app for a tests/ directory outside the repo root', () => {
    expect(classifyCallSite(stack(setup, '/elsewhere/tests/x.ts'), [setup], '/repo')).toBe('app');
  });
  it('reads a bare frame without a function name', () => {
    expect(classifyCallSite('Error\n    at /repo/src/a.test.ts:3:1', [], '/repo')).toBe('test');
  });
  it('strips file:// and a ?query suffix', () => {
    expect(classifyCallSite('Error\n    at f (file:///repo/src/a.test.ts?v=123:3:1)', [], '/repo')).toBe('test');
    expect(classifyCallSite('Error\n    at f (file:///repo/src/lib/db.ts?v=123:3:1)', [], '/repo')).toBe('app');
  });
  it('skips node: frames', () => {
    expect(classifyCallSite('Error\n    at f (node:internal/x:1:1)\n    at g (/repo/tests/x.ts:1:1)', [], '/repo')).toBe('test');
  });
  it('is undecided when no frame remains', () => {
    expect(classifyCallSite('Error', [], '/repo')).toBe('undecided');
  });
  it('is undecided when every frame is node:, node_modules or ignored', () => {
    expect(
      classifyCallSite(stack(setup, '/repo/node_modules/x/y.js', 'node:internal/process/task_queues'), [setup], '/repo'),
    ).toBe('undecided');
  });
  it('reads the stack vitest actually produces', () => {
    expect(classifyCallSite(new Error('x').stack ?? '', [], process.cwd())).toBe('test');
  });
});

describe('undefinedFilterGuard handler', () => {
  const handler = undefinedFilterGuard.query.$allModels.updateMany;
  const call = (args: unknown) => {
    const query = vi.fn(async (_args: unknown): Promise<unknown> => ({ count: 0 }));
    return { query, result: handler({ model: 'DegradationEvent', operation: 'updateMany', args, query }) };
  };

  it('passes a call with no where key to the query', async () => {
    const args = { data: { occurrences: 1 } };
    const { query, result } = call(args);
    await expect(result).resolves.toEqual({ count: 0 });
    expect(query).toHaveBeenCalledWith(args);
  });
  it('refuses an explicit where: undefined without querying', async () => {
    const { query, result } = call({ where: undefined, data: { occurrences: 1 } });
    await expect(result).rejects.toThrow(
      new RegExp(`${UNDEFINED_FILTER_GUARD_MESSAGE_PREFIX.replace(/[[\]]/g, '\\$&')} DegradationEvent\\.updateMany: where is undefined`),
    );
    expect(query).not.toHaveBeenCalled();
  });
});

const base = new PrismaClient();
const guarded = base.$extends(undefinedFilterGuard);
const sentinels = [`ufg-783-${uniqueSuffix()}-a`, `ufg-783-${uniqueSuffix()}-b`];
// Stands in for a beforeAll-assigned binding that never got its value.
let unassigned: Date | undefined;

beforeAll(async () => {
  await base.degradationEvent.createMany({ data: sentinels.map((code) => ({ code, sample: {} })) });
});
afterAll(async () => {
  await base.degradationEvent.deleteMany({ where: { code: { in: sentinels } } });
  await base.$disconnect();
});
const remaining = (): Promise<number> => base.degradationEvent.count({ where: { code: { in: sentinels } } });
const changed = (): Promise<number> =>
  base.degradationEvent.count({ where: { code: { in: sentinels }, occurrences: 99 } });

const refusal = new RegExp(
  `${UNDEFINED_FILTER_GUARD_MESSAGE_PREFIX.replace(/[[\]]/g, '\\$&')}.*where\\.lastNotifiedAt`,
);

describe('undefinedFilterGuard against the database', () => {
  it('refuses deleteMany and leaves every row', async () => {
    await expect(
      guarded.degradationEvent.deleteMany({ where: { code: { in: sentinels }, lastNotifiedAt: unassigned } }),
    ).rejects.toThrow(refusal);
    expect(await remaining()).toBe(2);
  });
  it('refuses updateMany and changes nothing', async () => {
    await expect(
      guarded.degradationEvent.updateMany({
        where: { code: { in: sentinels }, lastNotifiedAt: unassigned },
        data: { occurrences: 99 },
      }),
    ).rejects.toThrow(refusal);
    expect(await remaining()).toBe(2);
    expect(await changed()).toBe(0);
  });
  it('refuses updateManyAndReturn and changes nothing', async () => {
    await expect(
      guarded.degradationEvent.updateManyAndReturn({
        where: { code: { in: sentinels }, lastNotifiedAt: unassigned },
        data: { occurrences: 99 },
      }),
    ).rejects.toThrow(refusal);
    expect(await remaining()).toBe(2);
    expect(await changed()).toBe(0);
  });
  it('refuses inside an interactive transaction', async () => {
    await expect(
      guarded.$transaction(async (tx) =>
        tx.degradationEvent.deleteMany({ where: { code: { in: sentinels }, lastNotifiedAt: unassigned } }),
      ),
    ).rejects.toThrow(refusal);
    expect(await remaining()).toBe(2);
  });
  it('refuses inside a batch transaction', async () => {
    await expect(
      guarded.$transaction([
        guarded.degradationEvent.deleteMany({ where: { code: { in: sentinels }, lastNotifiedAt: unassigned } }),
      ]),
    ).rejects.toThrow(refusal);
    expect(await remaining()).toBe(2);
  });
  it('lets a fully defined write through', async () => {
    const result = await guarded.degradationEvent.updateMany({
      where: { code: { in: sentinels } },
      data: { occurrences: 2 },
    });
    expect(result.count).toBe(2);
  });
});

const moduleLevel = new PrismaClient();
function build(): PrismaClient {
  return new PrismaClient();
}

describe('the vitest installer (tests/setup/undefined-filter-guard.ts)', () => {
  let builtInHook: PrismaClient | undefined;
  beforeAll(() => {
    builtInHook = build();
  });
  afterAll(async () => {
    await moduleLevel.$disconnect();
    if (builtInHook) await builtInHook.$disconnect();
  });

  it('guards a client test code builds at module level', async () => {
    await expect(
      moduleLevel.degradationEvent.deleteMany({ where: { code: { in: sentinels }, lastNotifiedAt: unassigned } }),
    ).rejects.toThrow(refusal);
    expect(await remaining()).toBe(2);
  });
  it('guards a client built inside a function a hook calls', async () => {
    if (!builtInHook) throw new Error('beforeAll did not build the client');
    await expect(
      builtInHook.degradationEvent.deleteMany({ where: { code: { in: sentinels }, lastNotifiedAt: unassigned } }),
    ).rejects.toThrow(refusal);
    expect(await remaining()).toBe(2);
  });
  it('throws rather than guess when no frame of the construction stack can decide', async () => {
    // A bound native constructor run as a promise reaction that nothing awaits
    // leaves no file frame on the construction stack but the installer's own.
    let outcome: unknown;
    void Promise.resolve([])
      .then(Reflect.construct.bind(null, PrismaClient))
      .then(
        (client: unknown) => {
          outcome = client;
        },
        (err: unknown) => {
          outcome = err;
        },
      );
    await new Promise((resolve) => setImmediate(resolve));
    expect(outcome instanceof Error ? outcome.message : outcome).toMatch(
      /^\[undefined-filter-guard\] cannot tell whether test or app code built this PrismaClient/,
    );
  });
  it('leaves the app client from @/lib/db unguarded', async () => {
    const result = await appPrisma.degradationEvent.deleteMany({
      where: { code: `ufg-783-absent-${uniqueSuffix()}`, lastNotifiedAt: unassigned },
    });
    expect(result.count).toBe(0);
  });
});
