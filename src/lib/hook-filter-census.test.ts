/**
 * `censusHookFilters` over an in-memory program: each case is a small test
 * file whose cleanup hook either can or cannot write through a filter that
 * holds `undefined`, and the finding (or its absence) is pinned exactly.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import ts from 'typescript';
import { censusHookFilters, type HookFilterFinding } from './hook-filter-census';

const ROOT = '/virtual';

const GLOBALS = `
declare function beforeAll(fn: () => unknown): void;
declare function afterAll(fn: () => unknown): void;
declare function afterEach(fn: () => unknown): void;
declare const test: { afterAll(fn: () => unknown): void; afterEach(fn: () => unknown): void };
declare class FakeClient {
  class: { deleteMany(args?: unknown): Promise<unknown>; updateMany(args?: unknown): Promise<unknown> };
  teacher: { deleteMany(args?: unknown): Promise<unknown> };
}
declare function teardownTeacher(client: FakeClient, id: string): Promise<void>;
`;

const DB = `export const prisma = new FakeClient();\n`;

/** Builds a program over `sources` (paths relative to ROOT); lib files come from the real host. */
function programOf(sources: Record<string, string>, withDb: boolean): { program: ts.Program; files: string[] } {
  const all: Record<string, string> = { 'globals.d.ts': GLOBALS, ...(withDb ? { 'src/lib/db.ts': DB } : {}), ...sources };
  const byPath = new Map(Object.entries(all).map(([rel, text]) => [path.posix.join(ROOT, rel), text]));
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    baseUrl: ROOT,
    paths: { '@/*': ['./src/*'] },
    types: [],
    noEmit: true,
  };
  const real = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...real,
    fileExists: (name) => byPath.has(name) || real.fileExists(name),
    readFile: (name) => byPath.get(name) ?? real.readFile(name),
    directoryExists: (dir) => [...byPath.keys()].some((f) => f.startsWith(`${dir}/`)) || (real.directoryExists?.(dir) ?? false),
    realpath: (name) => (byPath.has(name) ? name : (real.realpath?.(name) ?? name)),
    getSourceFile: (name, version, onError, create) => {
      const text = byPath.get(name);
      return text === undefined
        ? real.getSourceFile(name, version, onError, create)
        : ts.createSourceFile(name, text, version, true);
    },
  };
  const files = [...byPath.keys()];
  return { program: ts.createProgram(files, options, host), files: files.filter((f) => f.endsWith('.test.ts')) };
}

function census(source: string, extra: Record<string, string> = {}, withDb = true): HookFilterFinding[] {
  const { program, files } = programOf({ 'case.test.ts': source, ...extra }, withDb);
  return censusHookFilters(program, files, ROOT);
}

const LOCAL = `const prisma = new FakeClient();`;

describe('censusHookFilters', () => {
  it('reports an unguarded direct write whose shorthand filter is a no-initializer let', () => {
    const findings = census(`${LOCAL}
let classId: string;
beforeAll(async () => { classId = 'c'; });
afterAll(async () => {
  await prisma.class.deleteMany({ where: { classId } });
});
`);
    expect(findings).toEqual([
      {
        file: 'case.test.ts',
        line: 5,
        hook: 'afterAll',
        kind: 'direct',
        call: 'prisma.class.deleteMany',
        bindings: ['classId'],
        guarded: false,
        client: 'test',
      },
    ]);
  });

  it('reads a binding nested inside an operator object', () => {
    const findings = census(`${LOCAL}
let ids: string[];
beforeAll(async () => { ids = ['a']; });
afterAll(async () => {
  await prisma.class.updateMany({ where: { id: { in: ids } }, data: {} });
});
`);
    expect(findings).toMatchObject([{ kind: 'direct', call: 'prisma.class.updateMany', bindings: ['ids'], guarded: false }]);
  });

  it('marks a write under an if that tests its binding as guarded', () => {
    const findings = census(`${LOCAL}
let classId: string;
beforeAll(async () => { classId = 'c'; });
afterAll(async () => {
  if (classId) {
    await prisma.class.deleteMany({ where: { classId } });
  }
});
`);
    expect(findings).toMatchObject([{ line: 6, bindings: ['classId'], guarded: true }]);
  });

  it('marks a write behind && and ?: on its binding as guarded', () => {
    const findings = census(`${LOCAL}
let a: string;
let b: string;
afterAll(async () => {
  await (a && prisma.class.deleteMany({ where: { id: a } }));
  await (b ? prisma.class.deleteMany({ where: { id: b } }) : undefined);
});
`);
    expect(findings.map((f) => [f.bindings, f.guarded])).toEqual([
      [['a'], true],
      [['b'], true],
    ]);
  });

  it('does not count a guard on a different binding', () => {
    const findings = census(`${LOCAL}
let a: string;
let b: string;
afterAll(async () => {
  if (a) await prisma.class.deleteMany({ where: { id: a, teacherId: b } });
});
`);
    expect(findings).toMatchObject([{ bindings: ['a', 'b'], guarded: false }]);
  });

  it('ignores a let with an initializer', () => {
    expect(
      census(`${LOCAL}
let ids: string[] = [];
afterAll(async () => {
  await prisma.class.deleteMany({ where: { id: { in: ids } } });
});
`),
    ).toEqual([]);
  });

  it('ignores a for…of loop variable', () => {
    expect(
      census(`${LOCAL}
afterAll(async () => {
  for (let id of ['a']) await prisma.class.deleteMany({ where: { id } });
});
`),
    ).toEqual([]);
  });

  it('ignores a const', () => {
    expect(
      census(`${LOCAL}
const classId = 'c';
afterAll(async () => {
  await prisma.class.deleteMany({ where: { classId } });
});
`),
    ).toEqual([]);
  });

  it('reports an indirect call passing a possibly-undefined binding', () => {
    const findings = census(`${LOCAL}
let teacherId: string;
afterAll(async () => {
  await teardownTeacher(prisma, teacherId);
});
`);
    expect(findings).toEqual([
      {
        file: 'case.test.ts',
        line: 4,
        hook: 'afterAll',
        kind: 'indirect',
        call: 'teardownTeacher',
        bindings: ['teacherId'],
        guarded: false,
        client: 'test',
      },
    ]);
  });

  it('reads Playwright test.afterAll and test.afterEach', () => {
    const findings = census(`${LOCAL}
let classId: string;
test.afterAll(async () => { await prisma.class.deleteMany({ where: { classId } }); });
test.afterEach(async () => { await prisma.class.deleteMany({ where: { classId } }); });
`);
    expect(findings.map((f) => [f.hook, f.line])).toEqual([
      ['afterAll', 3],
      ['afterEach', 4],
    ]);
  });

  it('reads afterEach', () => {
    const findings = census(`${LOCAL}
let classId: string;
afterEach(async () => { await prisma.class.deleteMany({ where: { classId } }); });
`);
    expect(findings).toMatchObject([{ hook: 'afterEach', kind: 'direct' }]);
  });

  it('ignores a bulk write outside any cleanup hook', () => {
    expect(
      census(`${LOCAL}
let classId: string;
beforeAll(async () => { await prisma.class.deleteMany({ where: { classId } }); });
async function cleanup() { await prisma.class.deleteMany({ where: { classId } }); }
`),
    ).toEqual([]);
  });

  it("marks a receiver imported from '@/lib/db' as the app client", () => {
    const findings = census(`import { prisma } from '@/lib/db';
let classId: string;
afterAll(async () => { await prisma.class.deleteMany({ where: { classId } }); });
`);
    expect(findings).toMatchObject([{ call: 'prisma.class.deleteMany', client: 'app' }]);
  });

  it("falls back to the '@/lib/db' specifier when the import does not resolve", () => {
    const findings = census(
      `import { prisma } from '@/lib/db';
let classId: string;
afterAll(async () => { await prisma.class.deleteMany({ where: { classId } }); });
`,
      {},
      false,
    );
    expect(findings).toMatchObject([{ client: 'app' }]);
  });

  it('marks an indirect call handed the app client as app', () => {
    const findings = census(`import { prisma } from '@/lib/db';
let teacherId: string;
afterAll(async () => { await teardownTeacher(prisma, teacherId); });
`);
    expect(findings).toMatchObject([{ kind: 'indirect', client: 'app' }]);
  });

  it('follows a renamed import and a relative specifier to the app client', () => {
    const findings = census(
      `import { prisma as appPrisma } from './src/lib/db';
let classId: string;
afterAll(async () => { await appPrisma.class.deleteMany({ where: { classId } }); });
`,
    );
    expect(findings).toMatchObject([{ call: 'appPrisma.class.deleteMany', client: 'app' }]);
  });

  it('marks a receiver imported from another module as a test client', () => {
    const findings = census(
      `import { prisma } from './helpers';
let classId: string;
afterAll(async () => { await prisma.class.deleteMany({ where: { classId } }); });
`,
      { 'helpers.ts': 'export const prisma = new FakeClient();\n' },
    );
    expect(findings).toMatchObject([{ client: 'test' }]);
  });
});
