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
declare function afterAll(fn: () => unknown, timeout?: number): void;
declare function afterEach(fn: () => unknown, timeout?: number): void;
declare const test: { afterAll(fn: () => unknown): void; afterEach(fn: () => unknown): void };
declare class FakeClient {
  class: {
    deleteMany(args?: unknown): Promise<unknown>;
    updateMany(args?: unknown): Promise<unknown>;
    findMany(args?: unknown): Promise<unknown>;
    delete(args: unknown): Promise<unknown>;
  };
  teacher: { deleteMany(args?: unknown): Promise<unknown> };
}
declare function teardownTeacher(client: FakeClient, id: string): Promise<void>;
declare function teardownMany(client: FakeClient, ...rest: unknown[]): Promise<void>;
declare var fixtureGlobal: string;
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

  describe('ambient globals', () => {
    it('does not read a lib global such as Boolean as a binding', () => {
      const findings = census(`${LOCAL}
let a: string;
afterAll(async () => {
  await prisma.class.deleteMany({ where: { id: { in: [a].filter(Boolean) } } });
});
`);
      expect(findings).toMatchObject([{ bindings: ['a'] }]);
    });

    it('reports no row for a call handed a declaration-file global or a declare in the test file', () => {
      expect(
        census(`${LOCAL}
declare let ambientId: string;
afterAll(async () => {
  await teardownTeacher(prisma, window.name);
  await teardownTeacher(prisma, fixtureGlobal);
  await teardownTeacher(prisma, ambientId);
});
`),
      ).toEqual([]);
    });
  });

  describe('indirect arguments that are not bare identifiers', () => {
    it('reads an optional chain, an array literal and a shorthand object', () => {
      const findings = census(`${LOCAL}
let alice: { id: string } | undefined;
let a: string;
let b: string;
afterAll(async () => {
  await teardownMany(prisma, alice?.id);
  await teardownMany(prisma, [a, b]);
  await teardownMany(prisma, { a });
});
`);
      expect(findings.map((f) => [f.line, f.kind, f.call, f.bindings])).toEqual([
        [6, 'indirect', 'teardownMany', ['alice']],
        [7, 'indirect', 'teardownMany', ['a', 'b']],
        [8, 'indirect', 'teardownMany', ['a']],
      ]);
    });
  });

  describe('delegate methods other than the bulk writes', () => {
    it('reports no row for a unique delete or a read, but an indirect row for a bulk write without a literal where', () => {
      const findings = census(`${LOCAL}
let classId: string;
let filter: { where: { id: string } };
afterAll(async () => {
  await prisma.class.delete({ where: { id: classId } });
  await prisma.class.findMany({ where: { id: classId } });
  await prisma.class.deleteMany(filter);
});
`);
      expect(findings.map((f) => [f.line, f.kind, f.call, f.bindings])).toEqual([[7, 'indirect', 'prisma.class.deleteMany', ['filter']]]);
    });
  });

  describe('same-file callees', () => {
    it('follows a function declaration the hook calls, one level deep', () => {
      const findings = census(`${LOCAL}
let classId: string;
async function teardownWorld() {
  await prisma.class.deleteMany({ where: { classId } });
}
afterAll(() => teardownWorld());
`);
      expect(findings).toEqual([
        {
          file: 'case.test.ts',
          line: 4,
          hook: 'afterAll',
          kind: 'indirect',
          call: 'prisma.class.deleteMany',
          bindings: ['classId'],
          guarded: false,
          client: 'test',
        },
      ]);
    });

    it('follows a const arrow, reading guards inside it and at the call site', () => {
      const findings = census(`${LOCAL}
let a: string;
let b: string;
const cleanup = async () => {
  if (a) await prisma.class.deleteMany({ where: { id: a } });
  await prisma.class.deleteMany({ where: { id: b } });
  await teardownTeacher(prisma, b);
};
afterAll(async () => {
  await cleanup();
});
afterEach(async () => {
  if (b) await cleanup();
});
`);
      expect(findings.map((f) => [f.hook, f.line, f.kind, f.call, f.guarded])).toEqual([
        ['afterAll', 5, 'indirect', 'prisma.class.deleteMany', true],
        ['afterAll', 6, 'indirect', 'prisma.class.deleteMany', false],
        ['afterAll', 7, 'indirect', 'teardownTeacher', false],
        ['afterEach', 5, 'indirect', 'prisma.class.deleteMany', true],
        ['afterEach', 6, 'indirect', 'prisma.class.deleteMany', true],
        ['afterEach', 7, 'indirect', 'teardownTeacher', true],
      ]);
    });

    it('reads a hook callback named by an identifier as the hook body, with or without a timeout argument', () => {
      const findings = census(`${LOCAL}
let classId: string;
async function cleanup() {
  await prisma.class.deleteMany({ where: { classId } });
}
const cleanupEach = async () => {
  if (!classId) return;
  await prisma.class.deleteMany({ where: { classId } });
};
afterAll(cleanup);
afterAll(cleanup, 30_000);
afterEach(cleanupEach);
`);
      expect(findings.map((f) => [f.hook, f.line, f.kind, f.guarded])).toEqual([
        ['afterAll', 4, 'direct', false],
        ['afterAll', 4, 'direct', false],
        ['afterEach', 8, 'direct', true],
      ]);
    });

    it('does not follow a function from another file, nor a callee of a callee', () => {
      const findings = census(
        `${LOCAL}
import { remoteCleanup } from './helpers';
let classId: string;
async function inner() { await prisma.class.deleteMany({ where: { classId } }); }
async function outer() { await inner(); }
afterAll(async () => {
  await remoteCleanup();
  await outer();
});
`,
        { 'helpers.ts': 'export async function remoteCleanup(): Promise<void> {}\n' },
      );
      expect(findings).toEqual([]);
    });
  });

  describe('which branch a guard covers', () => {
    it('does not count the else branch of an if on the binding', () => {
      const findings = census(`${LOCAL}
let classId: string;
afterAll(async () => {
  if (classId) {
    return;
  } else {
    await prisma.class.deleteMany({ where: { classId } });
  }
});
`);
      expect(findings).toMatchObject([{ guarded: false }]);
    });

    it('does not count a write in the left operand of &&', () => {
      const findings = census(`${LOCAL}
let classId: string;
afterAll(async () => {
  await (prisma.class.deleteMany({ where: { classId } }) && classId);
});
`);
      expect(findings).toMatchObject([{ guarded: false }]);
    });

    it('does not count the false branch of ?:', () => {
      const findings = census(`${LOCAL}
let classId: string;
afterAll(async () => {
  await (classId ? undefined : prisma.class.deleteMany({ where: { classId } }));
});
`);
      expect(findings).toMatchObject([{ guarded: false }]);
    });

    it('counts an early return or throw on the binding earlier in the same block', () => {
      const findings = census(`${LOCAL}
let a: string;
let b: string;
afterAll(async () => {
  if (!a) return;
  await prisma.class.deleteMany({ where: { id: a } });
});
afterAll(async () => {
  if (!b) { throw new Error('no b'); }
  await prisma.class.deleteMany({ where: { id: b } });
});
`);
      expect(findings.map((f) => [f.line, f.guarded])).toEqual([
        [6, true],
        [10, true],
      ]);
    });

    it('counts an early exit on a nullish comparison in either operand order, and on an || with such a disjunct', () => {
      const findings = census(`${LOCAL}
let a: string | undefined;
let b: string | undefined;
let c: string | undefined;
let d: string | undefined;
let e: string | undefined;
afterAll(async () => {
  if (a == null) return;
  if (undefined === b) return;
  if ((c === undefined)) return;
  if (null == d || !e) return;
  await prisma.class.deleteMany({ where: { id: { in: [a, b, c, d, e] } } });
});
`);
      expect(findings.map((f) => [f.bindings, f.guarded])).toEqual([[['a', 'b', 'c', 'd', 'e'], true]]);
    });

    it('does not count an early exit whose condition holds when the binding is present', () => {
      const findings = census(`${LOCAL}
let a: string;
let b: string;
let c: string;
let d: string;
afterAll(async () => {
  if (a) return;
  await prisma.class.deleteMany({ where: { id: a } });
});
afterAll(async () => {
  if (b != null) return;
  await prisma.class.deleteMany({ where: { id: b } });
});
afterAll(async () => {
  if (!c && Math.random() > 1) return;
  await prisma.class.deleteMany({ where: { id: c } });
});
afterAll(async () => {
  if (d === 'x' || Math.random() > 1) return;
  await prisma.class.deleteMany({ where: { id: d } });
});
`);
      expect(findings.map((f) => [f.bindings, f.guarded])).toEqual([
        [['a'], false],
        [['b'], false],
        [['c'], false],
        [['d'], false],
      ]);
    });

    it('does not count an early-exit if that follows the write or does not exit', () => {
      const findings = census(`${LOCAL}
let a: string;
afterAll(async () => {
  await prisma.class.deleteMany({ where: { id: a } });
  if (!a) return;
});
afterAll(async () => {
  if (!a) console.log('missing');
  await prisma.class.deleteMany({ where: { id: a } });
});
`);
      expect(findings.map((f) => f.guarded)).toEqual([false, false]);
    });
  });
});
