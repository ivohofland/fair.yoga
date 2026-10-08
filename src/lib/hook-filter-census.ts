/**
 * Which cleanup-hook writes can filter on `undefined` (#783).
 *
 * A syntax-and-symbol reading of `afterAll`/`afterEach` callbacks: a bulk
 * write whose `where` reads a `let`/`var` declared with no initializer filters
 * on `undefined` when the hook that would have assigned it never ran, and
 * Prisma drops an `undefined` key, so the write matches every row. This is a
 * report, not a gate — the runtime guard (`tests/undefined-filter-guard.ts`)
 * is the gate. Tooling only: it imports `typescript`, a devDependency, so no
 * application module may import it.
 *
 * Spec: docs/superpowers/specs/2026-10-08-undefined-filter-guard-design.md
 */
import ts from 'typescript';
import path from 'node:path';

export type HookFilterFinding = {
  /** Repo-relative path, forward slashes. */
  file: string;
  /** 1-based line of the write or the call. */
  line: number;
  hook: 'afterAll' | 'afterEach';
  /** `direct`: the bulk write itself. `indirect`: a call handing a possibly-undefined binding to a function the census does not follow. */
  kind: 'direct' | 'indirect';
  /** The callee as written, e.g. `prisma.class.deleteMany` or `teardownTeacher`. */
  call: string;
  /** The possibly-undefined bindings the write's `where` (or the call's arguments) reads. */
  bindings: string[];
  /** Every binding is tested by an enclosing `if`, `&&` or `?:` inside the hook. */
  guarded: boolean;
  /** `app` when the receiver (or, for an indirect call, an argument) resolves to `src/lib/db.ts`; the guard does not cover that client. */
  client: 'test' | 'app';
};

const BULK_WRITES: ReadonlySet<string> = new Set(['deleteMany', 'updateMany', 'updateManyAndReturn']);
const APP_DB_SPECIFIER = '@/lib/db';
const APP_DB_FILE = path.join('src', 'lib', 'db.ts');

type Hook = { name: 'afterAll' | 'afterEach'; callback: ts.FunctionLikeDeclaration };

/** `afterAll(fn)`, `afterEach(fn)`, `test.afterAll(fn)`, `test.afterEach(fn)`. */
function hookOf(node: ts.CallExpression): Hook | undefined {
  const callee = node.expression;
  let name: string | undefined;
  if (ts.isIdentifier(callee)) name = callee.text;
  else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'test') {
    name = callee.name.text;
  }
  if (name !== 'afterAll' && name !== 'afterEach') return undefined;
  const callback = node.arguments.find(
    (arg): arg is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
  );
  return callback === undefined ? undefined : { name, callback };
}

/** A `let`/`var` declared with no initializer, outside a `for…of`/`for…in` head. */
function isPossiblyUndefined(symbol: ts.Symbol): boolean {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return false;
  if (declaration.initializer !== undefined) return false;
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list)) return false;
  if ((list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) !== 0) return false;
  return !ts.isForOfStatement(list.parent) && !ts.isForInStatement(list.parent);
}

/** The symbol an identifier reads as a value — for a shorthand `{ x }`, the `x` in scope rather than the property. */
function valueSymbolOf(checker: ts.TypeChecker, id: ts.Identifier): ts.Symbol | undefined {
  if (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) {
    return checker.getShorthandAssignmentValueSymbol(id.parent);
  }
  return checker.getSymbolAtLocation(id);
}

/** Identifiers in `node` that read a value: not property names, not the `.name` of an access. */
function valueIdentifiers(node: ts.Node): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const parent = n.parent;
      const isPropertyName =
        (ts.isPropertyAssignment(parent) && parent.name === n) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === n);
      if (!isPropertyName) found.push(n);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** The `where` expression of a bulk write's object-literal first argument. */
function whereOf(call: ts.CallExpression): ts.Node | undefined {
  const arg = call.arguments[0];
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return undefined;
  for (const property of arg.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'where') {
      return property.initializer;
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'where') return property.name;
  }
  return undefined;
}

function isDirectWrite(call: ts.CallExpression): call is ts.CallExpression & { expression: ts.PropertyAccessExpression } {
  return ts.isPropertyAccessExpression(call.expression) && BULK_WRITES.has(call.expression.name.text);
}

function mentions(checker: ts.TypeChecker, node: ts.Node, symbol: ts.Symbol): boolean {
  return valueIdentifiers(node).some((id) => valueSymbolOf(checker, id) === symbol);
}

/** An ancestor between `node` and `boundary` is an `if`, `&&` or `?:` whose condition mentions `symbol`. */
function isGuarded(checker: ts.TypeChecker, node: ts.Node, boundary: ts.Node, symbol: ts.Symbol): boolean {
  for (let current = node.parent; current !== boundary; current = current.parent) {
    if (ts.isIfStatement(current) && mentions(checker, current.expression, symbol)) return true;
    if (ts.isConditionalExpression(current) && mentions(checker, current.condition, symbol)) return true;
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      mentions(checker, current.left, symbol)
    ) {
      return true;
    }
  }
  return false;
}

/** The leftmost identifier of `a.b.c` / `a[b].c`, if the chain is rooted in one. */
function rootIdentifier(expression: ts.Expression): ts.Identifier | undefined {
  let current: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current : undefined;
}

/** The identifier reads the `src/lib/db.ts` export: resolved through the import, or by its `'@/lib/db'` specifier when resolution fails. */
function isAppClient(checker: ts.TypeChecker, id: ts.Identifier, appDbFile: string): boolean {
  const symbol = checker.getSymbolAtLocation(id);
  if (symbol === undefined) return false;
  const target = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  if ((target.declarations ?? []).some((d) => path.resolve(d.getSourceFile().fileName) === appDbFile)) return true;
  return (symbol.declarations ?? []).some((d) => {
    const importDeclaration = ts.findAncestor(d, ts.isImportDeclaration);
    return (
      importDeclaration !== undefined &&
      ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
      importDeclaration.moduleSpecifier.text === APP_DB_SPECIFIER
    );
  });
}

function calleeText(call: ts.CallExpression, source: ts.SourceFile): string {
  return call.expression.getText(source).replace(/\s+/g, '');
}

export function censusHookFilters(program: ts.Program, files: readonly string[], repoRoot: string): HookFilterFinding[] {
  const checker = program.getTypeChecker();
  const appDbFile = path.resolve(repoRoot, APP_DB_FILE);
  const findings: HookFilterFinding[] = [];

  for (const file of files) {
    const source = program.getSourceFile(file);
    if (source === undefined) continue;
    const rel = path.relative(repoRoot, source.fileName).split(path.sep).join('/');

    const inspectHook = (hook: Hook): void => {
      const body = hook.callback.body;
      if (body === undefined) return;
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
          const direct = isDirectWrite(n) ? whereOf(n) : undefined;
          const read = direct === undefined ? n.arguments.filter(ts.isIdentifier) : valueIdentifiers(direct);
          const symbols = new Map<string, ts.Symbol>();
          for (const id of read) {
            const symbol = valueSymbolOf(checker, id);
            if (symbol !== undefined && isPossiblyUndefined(symbol) && !symbols.has(id.text)) symbols.set(id.text, symbol);
          }
          if (symbols.size > 0) {
            const clientIds =
              direct !== undefined && isDirectWrite(n)
                ? [rootIdentifier(n.expression.expression)]
                : n.arguments.filter(ts.isIdentifier);
            findings.push({
              file: rel,
              line: source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1,
              hook: hook.name,
              kind: direct === undefined ? 'indirect' : 'direct',
              call: calleeText(n, source),
              bindings: [...symbols.keys()],
              guarded: [...symbols.values()].every((symbol) => isGuarded(checker, n, hook.callback, symbol)),
              client: clientIds.some((id) => id !== undefined && isAppClient(checker, id, appDbFile)) ? 'app' : 'test',
            });
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(body);
    };

    const find = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const hook = hookOf(n);
        if (hook !== undefined) {
          inspectHook(hook);
          return;
        }
      }
      ts.forEachChild(n, find);
    };
    find(source);
  }
  return findings;
}
