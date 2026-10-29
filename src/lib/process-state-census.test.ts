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
 * Each file is parsed as the compiler parses it (`.tsx` as TSX, anything else
 * as TS), and a file the parser reports a syntax error in fails the census by
 * name: under the wrong kind a `<T>x` assertion reads as JSX and every
 * statement after it is hidden.
 *
 * WHAT IT FLAGS, read from the syntax tree, so a comment or a string is never
 * a hit. Only top-level statements of a file whose first statement is not the
 * `'use client'` directive, and never a `declare` statement:
 * - every `let` or `var` binding, destructured ones included, unconditionally;
 * - a `const` initialised, through parentheses, `as`, `satisfies` and `!`,
 *   with `new X(…)`, an object literal or an array literal that the file
 *   mutates anywhere: an assignment or `++`/`--` whose target roots in the
 *   binding through property and element accesses, a `MUTATORS` call on a
 *   receiver rooting in it, `Object.assign(binding…)`, or `delete binding.x`;
 * - a `static` property of a class reached without crossing a function
 *   boundary, initialised (through the same wrappers) with `new X(…)`, an
 *   object literal or an array literal, mutated or not, as `Class.property`.
 *   Its reason sits above the property or above the class's statement;
 * - a `setInterval`/`setTimeout` call reached without crossing a function or
 *   class boundary, unless it sits in the then-branch of a top-level `if`
 *   whose condition mentions a process-wide binding or reads
 *   `globalThis.__fairYoga…`.
 *
 * A `const` is process-wide when its initializer, through parentheses, is
 * `globalThis.__fairYoga… ??= …` or a read of `globalThis.__fairYoga…`. A
 * process-wide value outlives an edit with its old prototype, so it holds
 * data, never an instance of a class this repo defines: a `??=` whose
 * right-hand side, through parentheses, is `new X(…)` with `X` rooted in a
 * class declared in the file or in a binding imported from a `@/…` or
 * relative specifier is flagged too.
 *
 * A reason that begins `browser state` claims its holder lives in a browser.
 * The census holds that claim: every file that imports a module carrying one
 * opens with `'use client'` or carries one itself. An import here is a value
 * `import` or `export … from` declaration, side-effect imports included, whose
 * `@/…` or relative specifier resolves to a file under `src/`; `import type`
 * evaluates nothing and is skipped.
 *
 * WHAT IT DOES NOT SEE, each pinned by a fixture in the blind-spot block below
 * so it stays documented rather than accidental:
 * - a `const` initialised with any other call (a factory returning a stateful
 *   closure);
 * - mutation through an alias (`const a = m; a.set(…)`);
 * - mutation from another file;
 * - shadowing: a function-local that shares a holder's name and is mutated
 *   reports the holder (the loud direction);
 * - a process-wide initializer that reaches a repo class other than by a bare
 *   `new` on its right-hand side: a factory call, or an IIFE returning one;
 * - a `static` property initialised with anything else, a scalar included;
 * - a timer called as a member (`globalThis.setInterval(…)`), or inside a
 *   class body;
 * - what a timer guard tests: its condition is matched by identifier name
 *   alone, so a condition that mentions a process-wide binding accepts its
 *   then-branch whether or not it admits the branch once;
 * - a browser-state module reached transitively, through a `'use client'`
 *   file, or by a dynamic `import()`.
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
  shape: 'let' | 'mutated-const' | 'static-holder' | 'top-level-timer' | 'repo-class-global';
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
  'fill',
  'copyWithin',
  'set',
  'add',
  'delete',
  'clear',
  'on',
  'off',
  'once',
  'emit',
  'addListener',
  'removeListener',
  'removeAllListeners',
  'prependListener',
  'prependOnceListener',
  'setMaxListeners',
]);

const TIMERS: ReadonlySet<string> = new Set(['setInterval', 'setTimeout']);

const GLOBAL_PREFIX = '__fairYoga';

/** `// per-instance: <reason>`, reason non-empty. */
const MARKER = /^\/\/\s*per-instance:(.*)$/;

/** The reason that claims its holder lives in a browser. */
const BROWSER_STATE = 'browser state';

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

/** The non-empty `per-instance:` reasons in a node's leading comment trivia. */
function reasonsOf(node: ts.Node, text: string): string[] {
  return (ts.getLeadingCommentRanges(text, node.pos) ?? []).flatMap((range) => {
    const match = MARKER.exec(text.slice(range.pos, range.end));
    const reason = (match?.[1] ?? '').trim();
    return reason === '' ? [] : [reason];
  });
}

function hasReason(node: ts.Node, text: string): boolean {
  return reasonsOf(node, text).length > 0;
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

function isStatic(member: ts.ClassElement): boolean {
  return (
    ts.canHaveModifiers(member) && (ts.getModifiers(member) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
  );
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isBindingElement(element) ? bindingNames(element.name) : []));
}

/** Timer calls under `node` that run at module evaluation: no function or class boundary crossed. */
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

/** Classes under `node` reached without crossing a function boundary, `node` itself included. */
function classesAt(node: ts.Node): ts.ClassLikeDeclaration[] {
  const found: ts.ClassLikeDeclaration[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isClassLike(n)) found.push(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Whether a condition mentions a process-wide binding or reads a `globalThis.__fairYoga…` key. */
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

/**
 * Parses as the compiler does: `.tsx` as TSX, anything else as TS. Under TSX
 * a `<T>x` assertion or a generic arrow reads as JSX, and the statements
 * after it parse as garbage the census cannot see.
 */
function parseSource(fileName: string, text: string): ts.SourceFile {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
}

/**
 * The parser's syntax errors for a file. `parseDiagnostics` is internal to the
 * TypeScript API, so its absence throws rather than reading as clean.
 */
export function syntaxErrors(fileName: string, text: string): string[] {
  const source: ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] } = parseSource(fileName, text);
  const diagnostics = source.parseDiagnostics;
  if (!Array.isArray(diagnostics)) throw new Error('ts.SourceFile no longer carries parseDiagnostics');
  return diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

function processWideIn(source: ts.SourceFile): Set<string> {
  const processWide = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && isProcessWide(declaration.initializer)) {
        processWide.add(declaration.name.text);
      }
    }
  }
  return processWide;
}

/** The top-level bindings the census accepts as process-wide. */
export function processWideBindings(fileName: string, text: string): string[] {
  return [...processWideIn(parseSource(fileName, text))].sort();
}

export function findUnmarkedHolders(fileName: string, text: string): Finding[] {
  const source = parseSource(fileName, text);
  if (isUseClient(source)) return [];
  const mutated = mutatedRoots(source);
  const repoClasses = repoClassNames(source);
  const processWide = processWideIn(source);
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

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

    for (const cls of classesAt(statement)) {
      const className = cls.name?.text ?? '(anonymous class)';
      for (const member of cls.members) {
        if (!ts.isPropertyDeclaration(member) || !isStatic(member) || member.initializer === undefined) continue;
        if (!isHolderInitializer(member.initializer) || hasReason(member, text)) continue;
        findings.push({
          line: lineOf(member),
          binding: `${className}.${member.name.getText(source)}`,
          shape: 'static-holder',
        });
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

/** Whether any top-level statement of the file carries a reason beginning `browser state`. */
function isBrowserStateModule(source: ts.SourceFile, text: string): boolean {
  return source.statements.some((statement) =>
    reasonsOf(statement, text).some((reason) => reason.startsWith(BROWSER_STATE)),
  );
}

/** The repo file a `@/…` or relative specifier names, among `known`; undefined for a package. */
function resolveSpecifier(importer: string, specifier: string, known: ReadonlySet<string>): string | undefined {
  let base: string;
  if (specifier.startsWith('@/')) base = `src/${specifier.slice('@/'.length)}`;
  else if (specifier.startsWith('.')) base = path.posix.join(path.posix.dirname(importer), specifier);
  else return undefined;
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((c) => known.has(c));
}

/** The specifiers of a file's value imports and re-exports; `import type` and `export type` are skipped. */
function valueImports(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly === true) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteral(specifier)) specifiers.push(specifier.text);
    }
  }
  return specifiers;
}

/**
 * `importer imports module` for every file that imports a browser-state
 * module without opening with `'use client'` or being one itself.
 */
export function browserStateImportViolations(files: readonly { file: string; text: string }[]): string[] {
  const parsed = files.map(({ file, text }) => ({ file, text, source: parseSource(file, text) }));
  const known = new Set(parsed.map((p) => p.file));
  const browserState = new Set(parsed.filter((p) => isBrowserStateModule(p.source, p.text)).map((p) => p.file));
  return parsed.flatMap(({ file, source }) => {
    if (isUseClient(source) || browserState.has(file)) return [];
    return valueImports(source)
      .map((specifier) => resolveSpecifier(file, specifier, known))
      .filter((target): target is string => target !== undefined && browserState.has(target))
      .map((target) => `${file} imports ${target}`);
  });
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
  /** `file: first syntax error` for every file that does not parse cleanly. */
  unparsed: string[];
  /** `file:line binding (shape)` for every finding. */
  findings: string[];
  /** `importer imports module` for every unchecked import of a browser-state module. */
  browserStateImports: string[];
  /** The process-wide bindings the census accepted, per file. */
  processWide: Map<string, string[]>;
}

function takeCensus(files: readonly { file: string; text: string }[]): Census {
  const unparsed = files.flatMap(({ file, text }) => {
    const errors = syntaxErrors(file, text);
    return errors.length === 0 ? [] : [`${file}: ${errors[0]}`];
  });
  const findings = files.flatMap(({ file, text }) =>
    findUnmarkedHolders(file, text).map((f) => `${file}:${f.line} ${f.binding} (${f.shape})`),
  );
  const processWide = new Map(files.map(({ file, text }) => [file, processWideBindings(file, text)]));
  return {
    filesCensused: files.map((f) => f.file),
    unparsed,
    findings,
    browserStateImports: browserStateImportViolations(files),
    processWide,
  };
}

/** Read once and shared, so the assertions below agree about what the tree held. */
let treeCensus: Census | undefined;
function censusOfTree(): Census {
  return (treeCensus ??= takeCensus(
    searchScope().map((file) => ({ file, text: readFileSync(path.join(root, file), 'utf8') })),
  ));
}

/** Holders the census must accept as process-wide; a census that accepts none of them sees nothing. */
const PROCESS_WIDE_CONTROLS: readonly (readonly [file: string, binding: string])[] = [
  ['src/lib/event-bus.ts', 'emitter'],
  ['src/lib/auth/passkey.ts', 'state'],
  ['src/lib/rate-limit.ts', 'rateLimits'],
  ['src/lib/notify-health.ts', 'state'],
  ['src/services/processor-token.ts', 'inflight'],
  ['src/services/processor-methods-cache.ts', 'offerCache'],
  ['src/lib/db.ts', 'prisma'],
];

const REASON = '// per-instance: x\n';

describe('findUnmarkedHolders, on fixtures', () => {
  describe('flags', () => {
    it('a top-level let', () => {
      expect(findUnmarkedHolders('f.ts', 'let n = 0;\nexport function f() { n++; }\n')).toEqual([
        { line: 1, binding: 'n', shape: 'let' },
      ]);
    });

    it('a top-level var', () => {
      expect(findUnmarkedHolders('f.ts', 'var n = 0;\n')).toEqual([{ line: 1, binding: 'n', shape: 'let' }]);
    });

    it('each binding of a destructured let', () => {
      expect(findUnmarkedHolders('f.ts', 'let { a, b: [c] } = { a: 1, b: [2] };\n')).toEqual([
        { line: 1, binding: 'a', shape: 'let' },
        { line: 1, binding: 'c', shape: 'let' },
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

    it('a const object literal assigned through an element access', () => {
      const text = "const o: Record<string, number> = {};\nexport function f() { o['k'] = 1; }\n";
      expect(findUnmarkedHolders('f.ts', text)).toEqual([{ line: 1, binding: 'o', shape: 'mutated-const' }]);
    });

    it('a const Set added to', () => {
      expect(findUnmarkedHolders('f.ts', 'const s = new Set();\nexport function f() { s.add(1); }\n')).toEqual([
        { line: 1, binding: 's', shape: 'mutated-const' },
      ]);
    });

    it('a const array literal pushed to', () => {
      expect(findUnmarkedHolders('f.ts', 'const a: number[] = [];\nexport function f() { a.push(1); }\n')).toEqual([
        { line: 1, binding: 'a', shape: 'mutated-const' },
      ]);
    });

    it('a const passed first to Object.assign', () => {
      const text = 'const o = { n: 0 };\nexport function f() { Object.assign(o, { n: 1 }); }\n';
      expect(findUnmarkedHolders('f.ts', text)).toEqual([{ line: 1, binding: 'o', shape: 'mutated-const' }]);
    });

    it('a const a property is deleted from', () => {
      const text = 'const o: { n?: number } = { n: 0 };\nexport function f() { delete o.n; }\n';
      expect(findUnmarkedHolders('f.ts', text)).toEqual([{ line: 1, binding: 'o', shape: 'mutated-const' }]);
    });

    it('a const whose initializer and mutation target are wrapped in as, satisfies and !', () => {
      const text = [
        'const o = ({ n: 0 } satisfies { n: number }) as { n: number };',
        'const m = new Map<string, number>()!;',
        'export function f() { (o as { n: number }).n++; m!.set("k", 1); }',
        '',
      ].join('\n');
      expect(findUnmarkedHolders('f.ts', text)).toEqual([
        { line: 1, binding: 'o', shape: 'mutated-const' },
        { line: 2, binding: 'm', shape: 'mutated-const' },
      ]);
    });

    it.each([...MUTATORS])('a const receiving a %s call', (method) => {
      const text = `const e = new Thing();\nexport function f() { e.${method}(); }\n`;
      expect(findUnmarkedHolders('f.ts', text)).toEqual([{ line: 1, binding: 'e', shape: 'mutated-const' }]);
    });

    it('a static Map on a class, mutated or not', () => {
      const text = 'export class Cache {\n  static entries = new Map();\n  static readonly seen = [] as string[];\n}\n';
      expect(findUnmarkedHolders('f.ts', text)).toEqual([
        { line: 2, binding: 'Cache.entries', shape: 'static-holder' },
        { line: 3, binding: 'Cache.seen', shape: 'static-holder' },
      ]);
    });

    it('a static object literal on a class expression held by a const', () => {
      const text = 'const C = class Store {\n  static state = { n: 0 };\n};\n';
      expect(findUnmarkedHolders('f.ts', text)).toEqual([{ line: 2, binding: 'Store.state', shape: 'static-holder' }]);
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

    it('a timer in the else-branch of a process-wide guard', () => {
      const text = [
        'const state = (globalThis.__fairYogaX ??= { started: false });',
        'if (!state.started) {',
        '  state.started = true;',
        '} else {',
        '  setTimeout(() => {}, 1000);',
        '}',
        '',
      ].join('\n');
      expect(findUnmarkedHolders('f.ts', text)).toEqual([{ line: 5, binding: 'setTimeout', shape: 'top-level-timer' }]);
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
      ['a class with a static Map', 'class C {\n  static m = new Map();\n}\n'],
    ])('%s with a per-instance reason above it', (_label, body) => {
      expect(findUnmarkedHolders('f.ts', REASON + body)).toEqual([]);
    });

    it('a static Map with a per-instance reason above the property', () => {
      expect(findUnmarkedHolders('f.ts', `class C {\n  ${REASON}  static m = new Map();\n}\n`)).toEqual([]);
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

    it('a timer behind a condition reading globalThis.__fairYoga… directly', () => {
      const text = [
        'if (!globalThis.__fairYogaStarted) {',
        '  globalThis.__fairYogaStarted = true;',
        '  setInterval(() => {}, 1000).unref();',
        '}',
        '',
      ].join('\n');
      expect(findUnmarkedHolders('f.ts', text)).toEqual([]);
    });

    it('a timer inside a function', () => {
      expect(findUnmarkedHolders('f.ts', 'export function start() { setInterval(() => {}, 1000); }\n')).toEqual([]);
    });

    it('a declare statement', () => {
      expect(findUnmarkedHolders('f.ts', 'declare let ambient: number;\ndeclare var other: string;\n')).toEqual([]);
    });

    it('a ReadonlySet constant never mutated', () => {
      const text = "const S: ReadonlySet<string> = new Set(['a']);\nexport const has = (k: string) => S.has(k);\n";
      expect(findUnmarkedHolders('f.ts', text)).toEqual([]);
    });

    it("a file opening 'use client'", () => {
      expect(findUnmarkedHolders('f.ts', "'use client';\nlet n = 0;\nsetInterval(() => n++, 1);\n")).toEqual([]);
    });
  });

  describe('blind spots, as documented', () => {
    it('a const initialised with a call, called later', () => {
      const text = 'const c = createThing();\nexport function f() { c(); c.set(1); }\n';
      expect(findUnmarkedHolders('f.ts', text)).toEqual([]);
    });

    it('mutation through an alias', () => {
      const text = 'const m = new Map();\nconst a = m;\nexport function f() { a.set(1, 2); }\n';
      expect(findUnmarkedHolders('f.ts', text)).toEqual([]);
    });

    it('mutation from another file', () => {
      const files = [
        { file: 'src/a.ts', text: 'export const m = new Map();\n' },
        { file: 'src/b.ts', text: "import { m } from './a';\nexport function f() { m.set(1, 2); }\n" },
      ];
      expect(files.flatMap(({ file, text }) => findUnmarkedHolders(file, text))).toEqual([]);
    });

    it('shadowing reports the holder a mutated local shares a name with', () => {
      const text = 'const m = new Map();\nexport function f() { const m = new Map(); m.set(1, 2); }\n';
      expect(findUnmarkedHolders('f.ts', text)).toEqual([{ line: 1, binding: 'm', shape: 'mutated-const' }]);
    });

    it('a process-wide repo-class instance built by a factory', () => {
      const text = "import { createBus } from '@/lib/bus';\nconst b = (globalThis.__fairYogaX ??= createBus());\n";
      expect(findUnmarkedHolders('f.ts', text)).toEqual([]);
    });

    it('a process-wide repo-class instance built by an IIFE', () => {
      const text = 'class Bus {}\nconst b = (globalThis.__fairYogaX ??= (() => new Bus())());\n';
      expect(findUnmarkedHolders('f.ts', text)).toEqual([]);
    });

    it('a static property initialised with a scalar', () => {
      const text = 'export class C {\n  static count = 0;\n}\nexport function f() { C.count++; }\n';
      expect(findUnmarkedHolders('f.ts', text)).toEqual([]);
    });

    it('a timer called as a member', () => {
      const text = 'globalThis.setInterval(() => {}, 1000);\nglobal.setTimeout(() => {}, 1000);\n';
      expect(findUnmarkedHolders('f.ts', text)).toEqual([]);
    });

    it('a timer inside a class body', () => {
      expect(findUnmarkedHolders('f.ts', 'class C {\n  static t = setInterval(() => {}, 1000);\n}\n')).toEqual([]);
    });

    it('a guard that mentions a process-wide binding without admitting its branch once', () => {
      const text = [
        'const state = (globalThis.__fairYogaX ??= { started: false });',
        'if (state.started || true) {',
        '  setInterval(() => {}, 1000);',
        '}',
        '',
      ].join('\n');
      expect(findUnmarkedHolders('f.ts', text)).toEqual([]);
    });
  });
});

describe('browserStateImportViolations, on fixtures', () => {
  const browserModule = { file: 'src/lib/store.ts', text: '// per-instance: browser state\nlet n = 0;\n' };

  it('flags a server file importing a browser-state module', () => {
    const files = [browserModule, { file: 'src/app/route.ts', text: "import { x } from '@/lib/store';\n" }];
    expect(browserStateImportViolations(files)).toEqual(['src/app/route.ts imports src/lib/store.ts']);
  });

  it('flags a relative import, a side-effect import and a re-export', () => {
    const files = [
      browserModule,
      { file: 'src/lib/a.ts', text: "import { x } from './store';\n" },
      { file: 'src/lib/b/c.ts', text: "import '../store';\n" },
      { file: 'src/lib/d.ts', text: "export { x } from '@/lib/store';\n" },
    ];
    expect(browserStateImportViolations(files)).toEqual([
      'src/lib/a.ts imports src/lib/store.ts',
      'src/lib/b/c.ts imports src/lib/store.ts',
      'src/lib/d.ts imports src/lib/store.ts',
    ]);
  });

  it("passes a 'use client' importer, another browser-state module, and a type-only import", () => {
    const files = [
      browserModule,
      { file: 'src/components/c.tsx', text: "'use client';\nimport { x } from '@/lib/store';\n" },
      { file: 'src/lib/other.ts', text: "import { x } from './store';\n// per-instance: browser state\nlet m = 0;\n" },
      { file: 'src/lib/types.ts', text: "import type { X } from '@/lib/store';\nexport type { X } from '@/lib/store';\n" },
    ];
    expect(browserStateImportViolations(files)).toEqual([]);
  });

  it('does not see a browser-state module reached through a client file or a dynamic import (blind spot)', () => {
    const files = [
      browserModule,
      { file: 'src/components/c.tsx', text: "'use client';\nexport { x } from '@/lib/store';\n" },
      { file: 'src/app/route.ts', text: "import { x } from '@/components/c';\nexport const load = () => import('@/lib/store');\n" },
    ];
    expect(browserStateImportViolations(files)).toEqual([]);
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

  it('parses every file without a syntax error, so no statement is hidden from it', () => {
    expect(censusOfTree().unparsed).toEqual([]);
  });

  it.each(PROCESS_WIDE_CONTROLS)('accepts %s %s as process-wide', (file, binding) => {
    expect(censusOfTree().processWide.get(file) ?? []).toContain(binding);
  });

  it('every server-side holder under src/ is process-wide or carries a per-instance reason', () => {
    expect(censusOfTree().findings).toEqual([]);
  });

  it("every importer of a browser-state module is a 'use client' file or a browser-state module", () => {
    expect(censusOfTree().browserStateImports).toEqual([]);
  });
});
