/**
 * Every server-side module-level mutable holder under `src/` is process-wide
 * or carries a written reason for being per-instance (#933).
 *
 * Next.js evaluates a server module once per bundle layer, and in dev once
 * more after each edit, so a module-level `Map` is not one map. A holder whose
 * readers and writers must agree lives on `globalThis` behind the idiom
 * `const s = (globalThis.__fairYogaX ??= init)` with its key typed in
 * `declare global`. Every other holder says why a split costs nothing, in a
 * `// per-instance: <reason>` line in the statement's leading comment trivia.
 * The rule, the verdicts and the reasoning are in
 * `docs/superpowers/specs/2026-10-29-process-singletons-design.md`.
 *
 * WHAT IT FLAGS, read from the syntax tree, so a comment or a string is never
 * a hit. Only top-level statements of a file whose first statement is not the
 * `'use client'` directive:
 * - every `let` or `var`, unconditionally;
 * - a `const` initialised with `new X(…)`, an object literal or an array
 *   literal that the file mutates anywhere: an assignment or `++`/`--` whose
 *   target roots in the binding through property and element accesses, a
 *   `MUTATORS` call on a receiver rooting in it, `Object.assign(binding…)`,
 *   or `delete binding.x`;
 * - a `setInterval`/`setTimeout` call reached without crossing a function
 *   boundary, unless it sits in the then-branch of a top-level `if` whose
 *   condition reads a process-wide binding or `globalThis.__fairYoga…`.
 *
 * A `const` is process-wide when its initializer, through parentheses, is
 * `globalThis.__fairYoga… ??= …` or a read of `globalThis.__fairYoga…`. A
 * process-wide value outlives an edit with its old prototype, so it holds
 * data, never an instance of a class this repo defines: a `??=` whose
 * right-hand side, through parentheses, is `new X(…)` with `X` rooted in a
 * class declared in the file or in a binding imported from a `@/…` or
 * relative specifier is flagged too.
 *
 * WHAT IT DOES NOT SEE, pinned by the blind-spot fixtures below so they stay
 * documented rather than accidental: a `const` initialised with any other call
 * (a factory returning a stateful closure); mutation through an alias
 * (`const a = m; a.set(…)`); mutation from another file; shadowing, which
 * reports a local that shares a holder's name (the loud direction); and a
 * process-wide initializer that reaches a repo class other than by a bare
 * `new` on its right-hand side, such as a factory call or an IIFE returning
 * one.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();

/** What a finding is: a holder the census flagged, and the rule it tripped. */
export interface Finding {
  line: number;
  binding: string;
  shape: 'let' | 'mutated-const' | 'top-level-timer' | 'repo-class-global';
}

/** Method calls that change their receiver. */
const MUTATORS: ReadonlySet<string> = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'set',
  'add',
  'delete',
  'clear',
  'on',
  'off',
  'once',
  'emit',
  'setMaxListeners',
]);

const TIMERS: ReadonlySet<string> = new Set(['setInterval', 'setTimeout']);

const GLOBAL_PREFIX = '__fairYoga';

/** `// per-instance: <reason>`, reason non-empty. */
const MARKER = /^\/\/\s*per-instance:(.*)$/;

function unwrapParens(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** Parentheses, `as`, `satisfies` and `!` leave a literal a literal. */
function unwrapLiteral(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isGlobalRead(expression: ts.Expression): boolean {
  const e = unwrapParens(expression);
  return (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === 'globalThis' &&
    e.name.text.startsWith(GLOBAL_PREFIX)
  );
}

function isProcessWide(initializer: ts.Expression): boolean {
  const e = unwrapParens(initializer);
  if (isGlobalRead(e)) return true;
  return (
    ts.isBinaryExpression(e) &&
    e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken &&
    isGlobalRead(e.left)
  );
}

/** Names that reach a class this repo defines: same-file classes and bindings imported from repo specifiers. */
function repoClassNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isClassDeclaration(statement) && statement.name) names.add(statement.name.text);
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('@/') && !specifier.startsWith('.')) continue;
    const clause = statement.importClause;
    if (clause?.name) names.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.add(element.name.text);
  }
  return names;
}

/** Whether a process-wide initializer's `??=` right-hand side is `new` of a repo class. */
function storesRepoInstance(initializer: ts.Expression, repoClasses: ReadonlySet<string>): boolean {
  const e = unwrapParens(initializer);
  if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionEqualsToken) return false;
  const right = unwrapParens(e.right);
  if (!ts.isNewExpression(right)) return false;
  const name = rootIdentifier(right.expression);
  return name !== undefined && repoClasses.has(name);
}

function isHolderInitializer(initializer: ts.Expression): boolean {
  const e = unwrapLiteral(initializer);
  return ts.isNewExpression(e) || ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e);
}

/** The identifier a target or receiver roots in, through property and element accesses. */
function rootIdentifier(expression: ts.Expression): string | undefined {
  let current = unwrapLiteral(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapLiteral(current.expression);
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isIncrement(node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression): boolean {
  return node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken;
}

/** Every identifier the file mutates, by the rules in this file's docblock. */
function mutatedRoots(source: ts.SourceFile): Set<string> {
  const roots = new Set<string>();
  const note = (expression: ts.Expression): void => {
    const name = rootIdentifier(expression);
    if (name !== undefined) roots.add(name);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      note(node.left);
    } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && isIncrement(node)) {
      note(node.operand);
    } else if (ts.isDeleteExpression(node)) {
      note(node.expression);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && MUTATORS.has(callee.name.text)) {
        note(callee.expression);
      }
      const first = node.arguments[0];
      if (
        first !== undefined &&
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'Object' &&
        callee.name.text === 'assign'
      ) {
        note(first);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return roots;
}

/** Whether the statement's leading comment trivia carries a non-empty `per-instance:` reason. */
function hasReason(statement: ts.Statement, text: string): boolean {
  return (ts.getLeadingCommentRanges(text, statement.pos) ?? []).some((range) => {
    const match = MARKER.exec(text.slice(range.pos, range.end));
    return match !== null && (match[1] ?? '').trim() !== '';
  });
}

function isUseClient(source: ts.SourceFile): boolean {
  const first = source.statements[0];
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use client'
  );
}

function isAmbient(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)
  );
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isBindingElement(element) ? bindingNames(element.name) : []));
}

/** Timer calls under `node` that run at module evaluation: no function boundary crossed. */
function timerCalls(node: ts.Node): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && TIMERS.has(n.expression.text)) {
      found.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Whether a condition reads a process-wide binding or a `globalThis.__fairYoga…` key. */
function readsProcessWide(condition: ts.Expression, processWide: ReadonlySet<string>): boolean {
  let reads = false;
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && processWide.has(n.text)) reads = true;
    if (ts.isExpression(n) && isGlobalRead(n)) reads = true;
    if (!reads) ts.forEachChild(n, visit);
  };
  visit(condition);
  return reads;
}

export function findUnmarkedHolders(fileName: string, text: string): Finding[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (isUseClient(source)) return [];
  const mutated = mutatedRoots(source);
  const repoClasses = repoClassNames(source);
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const processWide = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && isProcessWide(declaration.initializer)) {
        processWide.add(declaration.name.text);
      }
    }
  }

  const findings: Finding[] = [];
  for (const statement of source.statements) {
    if (isAmbient(statement) || hasReason(statement, text)) continue;

    if (ts.isVariableStatement(statement)) {
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of statement.declarationList.declarations) {
        if (!isConst) {
          for (const binding of bindingNames(declaration.name)) {
            findings.push({ line: lineOf(declaration), binding, shape: 'let' });
          }
        } else if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer !== undefined &&
          isProcessWide(declaration.initializer) &&
          storesRepoInstance(declaration.initializer, repoClasses)
        ) {
          findings.push({ line: lineOf(declaration), binding: declaration.name.text, shape: 'repo-class-global' });
        } else if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer !== undefined &&
          !isProcessWide(declaration.initializer) &&
          isHolderInitializer(declaration.initializer) &&
          mutated.has(declaration.name.text)
        ) {
          findings.push({ line: lineOf(declaration), binding: declaration.name.text, shape: 'mutated-const' });
        }
      }
    }

    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) continue;
    const guarded =
      ts.isIfStatement(statement) && readsProcessWide(statement.expression, processWide)
        ? new Set(timerCalls(statement.thenStatement))
        : new Set<ts.CallExpression>();
    for (const call of timerCalls(statement)) {
      if (guarded.has(call)) continue;
      findings.push({ line: lineOf(call), binding: call.expression.getText(source), shape: 'top-level-timer' });
    }
  }
  return findings;
}

/**
 * Every `.ts`/`.tsx` under `src/`, repo-relative, minus test files and the
 * generated Prisma client. `'use client'` files are read and skipped by
 * `findUnmarkedHolders` itself, so they count as censused.
 */
function searchScope(): string[] {
  return readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .map((p) => `src/${p.split(path.sep).join('/')}`)
    .filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.startsWith('src/generated/'))
    .sort();
}

/**
 * A SECOND read of `src/`, for the scope-reach guard alone. It reaches no line
 * of the code that builds `filesCensused`, so a narrowing of the walk
 * disagrees with it. `src/lib/census-walk-independence.test.ts` holds the two
 * walks' independence.
 */
function areasUnderSrc(): Set<string> {
  const areas = new Set<string>();
  for (const found of readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })) {
    const relative = found.split(path.sep).join('/');
    if (!/\.tsx?$/.test(relative) || /\.test\.tsx?$/.test(relative) || relative.startsWith('generated/')) continue;
    areas.add(relative.split('/')[0] ?? relative);
  }
  return areas;
}

/** The first path segment under `src/`, the granularity the scope-reach assertion holds. */
function areaOf(file: string): string {
  return file.slice('src/'.length).split('/')[0] ?? file;
}

interface Census {
  filesCensused: string[];
  /** `file:line binding (shape)` for every finding. */
  findings: string[];
}

function takeCensus(files: readonly { file: string; text: string }[]): Census {
  const findings = files.flatMap(({ file, text }) =>
    findUnmarkedHolders(file, text).map((f) => `${file}:${f.line} ${f.binding} (${f.shape})`),
  );
  return { filesCensused: files.map((f) => f.file), findings };
}

/** Read once and shared, so the assertions below agree about what the tree held. */
let treeCensus: Census | undefined;
function censusOfTree(): Census {
  return (treeCensus ??= takeCensus(
    searchScope().map((file) => ({ file, text: readFileSync(path.join(root, file), 'utf8') })),
  ));
}

const REASON = '// per-instance: x\n';

describe('findUnmarkedHolders, on fixtures', () => {
  describe('flags', () => {
    it('a top-level let', () => {
      expect(findUnmarkedHolders('f.ts', 'let n = 0;\nexport function f() { n++; }\n')).toEqual([
        { line: 1, binding: 'n', shape: 'let' },
      ]);
    });

    it('a const Map set in a function', () => {
      expect(findUnmarkedHolders('f.ts', 'const m = new Map();\nexport function f() { m.set(1, 2); }\n')).toEqual([
        { line: 1, binding: 'm', shape: 'mutated-const' },
      ]);
    });

    it('a const object literal incremented through a property chain', () => {
      expect(findUnmarkedHolders('f.ts', 'const o = { a: { n: 0 } };\nexport function f() { o.a.n++; }\n')).toEqual([
        { line: 1, binding: 'o', shape: 'mutated-const' },
      ]);
    });

    it('a const Set added to', () => {
      expect(findUnmarkedHolders('f.ts', 'const s = new Set();\nexport function f() { s.add(1); }\n')).toEqual([
        { line: 1, binding: 's', shape: 'mutated-const' },
      ]);
    });

    it('a top-level setInterval', () => {
      expect(findUnmarkedHolders('f.ts', 'setInterval(() => {}, 1000).unref();\n')).toEqual([
        { line: 1, binding: 'setInterval', shape: 'top-level-timer' },
      ]);
    });

    it('a top-level timer behind a condition that reads no process-wide state', () => {
      expect(findUnmarkedHolders('f.ts', 'if (true) {\n  setTimeout(() => {}, 1000);\n}\n')).toEqual([
        { line: 2, binding: 'setTimeout', shape: 'top-level-timer' },
      ]);
    });

    it('a process-wide holder that is an instance of a class declared in the file', () => {
      const text = 'class Bus {}\nconst b = (globalThis.__fairYogaX ??= new Bus());\n';
      expect(findUnmarkedHolders('f.ts', text)).toEqual([{ line: 2, binding: 'b', shape: 'repo-class-global' }]);
    });

    it('a process-wide holder that is an instance of a class imported from the repo', () => {
      const text = [
        "import { Bus } from '@/lib/bus';",
        "import * as tools from './tools';",
        'const b = (globalThis.__fairYogaX ??= new Bus());',
        'const t = globalThis.__fairYogaY ??= (new tools.Store());',
        '',
      ].join('\n');
      expect(findUnmarkedHolders('f.ts', text)).toEqual([
        { line: 3, binding: 'b', shape: 'repo-class-global' },
        { line: 4, binding: 't', shape: 'repo-class-global' },
      ]);
    });

    it('a per-instance marker with an empty reason', () => {
      expect(findUnmarkedHolders('f.ts', '// per-instance:\nlet n = 0;\n')).toEqual([
        { line: 2, binding: 'n', shape: 'let' },
      ]);
    });
  });

  describe('passes', () => {
    it.each([
      ['a let', 'let n = 0;\nexport function f() { n++; }\n'],
      ['a const Map', 'const m = new Map();\nexport function f() { m.set(1, 2); }\n'],
      ['a const object literal', 'const o = { a: { n: 0 } };\nexport function f() { o.a.n++; }\n'],
      ['a const Set', 'const s = new Set();\nexport function f() { s.add(1); }\n'],
      ['a timer', 'setInterval(() => {}, 1000).unref();\n'],
    ])('%s with a per-instance reason above it', (_label, body) => {
      expect(findUnmarkedHolders('f.ts', REASON + body)).toEqual([]);
    });

    it('a holder initialised through globalThis, mutated', () => {
      const text = 'const s = (globalThis.__fairYogaX ??= new Map());\nexport function f() { s.set(1, 2); }\n';
      expect(findUnmarkedHolders('f.ts', text)).toEqual([]);
    });

    it.each([
      ['a Map', "const m = (globalThis.__fairYogaX ??= new Map());\n"],
      ['an EventEmitter from events', "import { EventEmitter } from 'events';\nconst e = (globalThis.__fairYogaX ??= new EventEmitter());\n"],
      ['an EventEmitter from node:events', "import { EventEmitter } from 'node:events';\nconst e = (globalThis.__fairYogaX ??= new EventEmitter());\n"],
    ])('a process-wide holder that is %s', (_label, text) => {
      expect(findUnmarkedHolders('f.ts', text)).toEqual([]);
    });

    it('a timer behind a condition reading process-wide state', () => {
      const text = [
        'const state = (globalThis.__fairYogaX ??= { started: false });',
        'if (!state.started) {',
        '  state.started = true;',
        '  setInterval(() => {}, 1000).unref();',
        '}',
        '',
      ].join('\n');
      expect(findUnmarkedHolders('f.ts', text)).toEqual([]);
    });

    it('a ReadonlySet constant never mutated', () => {
      const text = "const S: ReadonlySet<string> = new Set(['a']);\nexport const has = (k: string) => S.has(k);\n";
      expect(findUnmarkedHolders('f.ts', text)).toEqual([]);
    });

    it("a file opening 'use client'", () => {
      expect(findUnmarkedHolders('f.ts', "'use client';\nlet n = 0;\nsetInterval(() => n++, 1);\n")).toEqual([]);
    });
  });

  describe('blind spots, passing as documented', () => {
    it('a const initialised with a call, called later', () => {
      const text = 'const c = createThing();\nexport function f() { c(); c.set(1); }\n';
      expect(findUnmarkedHolders('f.ts', text)).toEqual([]);
    });

    it('a process-wide repo-class instance built by a factory', () => {
      const text = "import { createBus } from '@/lib/bus';\nconst b = (globalThis.__fairYogaX ??= createBus());\n";
      expect(findUnmarkedHolders('f.ts', text)).toEqual([]);
    });

    it('mutation through an alias of a marked holder', () => {
      const text = `${REASON}const m = new Map();\nconst a = m;\nexport function f() { a.set(1, 2); }\n`;
      expect(findUnmarkedHolders('f.ts', text)).toEqual([]);
    });
  });
});

describe('process-state census over src/', () => {
  it('reaches every area of src that holds production TypeScript', () => {
    const required = areasUnderSrc();
    const reached = new Set(censusOfTree().filesCensused.map(areaOf));
    expect({
      areasTheCensusMisses: [...required].filter((area) => !reached.has(area)).sort(),
      areasTheGuardMisses: [...reached].filter((area) => !required.has(area)).sort(),
    }).toEqual({ areasTheCensusMisses: [], areasTheGuardMisses: [] });
  });

  it('every server-side holder under src/ is process-wide or carries a per-instance reason', () => {
    expect(censusOfTree().findings).toEqual([]);
  });
});
