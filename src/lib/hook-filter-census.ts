/**
 * Which cleanup-hook writes can filter on `undefined` (#783).
 *
 * A syntax-and-symbol reading of `afterAll`/`afterEach` callbacks: a bulk
 * write whose `where` reads a `let`/`var` declared with no initializer filters
 * on `undefined` when the hook that would have assigned it never ran, and
 * Prisma drops an `undefined` key, so the write matches every row. It reads
 * the hook's own body, and the body of a function declaration or a
 * `const`-bound arrow/function expression in the same file that the hook
 * calls, one level deep; a function from another file is
 * reported as the call that hands it the binding, not followed. A report, not
 * a gate; its reach, its known misses and the gate it reports for are in
 * `docs/test-database.md` (section 6). Tooling only: it imports `typescript`,
 * a devDependency.
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
  /**
   * `direct`: a bulk write in the hook's own body. `indirect`: a call in the
   * hook handing a possibly-undefined binding to a function, or a row found
   * inside a same-file function the hook calls.
   */
  kind: 'direct' | 'indirect';
  /** The callee as written, e.g. `prisma.class.deleteMany` or `teardownTeacher`. */
  call: string;
  /** The possibly-undefined bindings the write's `where` (or the call's arguments) reads. */
  bindings: string[];
  /** Every binding is mentioned by a condition the row sits behind: see `isGuarded`. */
  guarded: boolean;
  /**
   * `app` when a bulk write's receiver, or a bare-identifier argument of any
   * other call, resolves to `src/lib/db.ts`; the guard does not cover that client.
   */
  client: 'test' | 'app';
};

const BULK_WRITES: ReadonlySet<string> = new Set(['deleteMany', 'updateMany', 'updateManyAndReturn']);
const APP_DB_SPECIFIER = '@/lib/db';
const APP_DB_FILE = path.join('src', 'lib', 'db.ts');

type Hook = { name: 'afterAll' | 'afterEach'; callback: ts.FunctionLikeDeclaration };

/**
 * `afterAll(fn)`, `afterEach(fn)`, `test.afterAll(fn)`, `test.afterEach(fn)`.
 * `fn` is an inline arrow or function expression, or the first argument when
 * it is an identifier naming a function `sameFileFunction` resolves.
 */
function hookOf(checker: ts.TypeChecker, node: ts.CallExpression, source: ts.SourceFile): Hook | undefined {
  const callee = node.expression;
  let name: string | undefined;
  if (ts.isIdentifier(callee)) name = callee.text;
  else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'test') {
    name = callee.name.text;
  }
  if (name !== 'afterAll' && name !== 'afterEach') return undefined;
  const inline = node.arguments.find(
    (arg): arg is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
  );
  const first = node.arguments[0];
  const callback =
    inline ?? (first !== undefined && ts.isIdentifier(first) ? sameFileFunction(checker, first, source, node) : undefined);
  return callback === undefined ? undefined : { name, callback };
}

/**
 * A `let`/`var` declared with no initializer, outside a `for…of`/`for…in`
 * head. Ambient declarations — a `declare` statement, or anything in a
 * declaration file such as the lib's `Boolean` or `window` — are values the
 * runtime supplies, never unassigned.
 */
function isPossiblyUndefined(symbol: ts.Symbol): boolean {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return false;
  if (declaration.initializer !== undefined) return false;
  if (declaration.getSourceFile().isDeclarationFile) return false;
  if ((ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !== 0) return false;
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

/**
 * Identifiers in `node` that read a value: not property names, not the
 * `.name` of an access. Function bodies inside `node` are skipped — a callback
 * argument's own calls are visited as calls in their own right.
 */
function valueIdentifiers(node: ts.Node): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (n: ts.Node): void => {
    if (n !== node && ts.isFunctionLike(n)) return;
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

/**
 * A call to a model delegate's other methods — a read, a `create`, or a
 * unique-`where` `delete`/`update`/`upsert`, which rejects an `undefined` key
 * itself. A delegate is recognised by its type carrying both `deleteMany` and
 * `findMany`, so no list of method names has to track Prisma's.
 */
function isOtherDelegateMethod(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression) || BULK_WRITES.has(call.expression.name.text)) return false;
  const receiver = checker.getTypeAtLocation(call.expression.expression);
  return receiver.getProperty('deleteMany') !== undefined && receiver.getProperty('findMany') !== undefined;
}

function mentions(checker: ts.TypeChecker, node: ts.Node, symbol: ts.Symbol): boolean {
  return valueIdentifiers(node).some((id) => valueSymbolOf(checker, id) === symbol);
}

/** `return;`/`throw …;`, alone or as the only statement of a block. */
function exits(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (!ts.isBlock(statement)) return false;
  const [only, ...rest] = statement.statements;
  return only !== undefined && rest.length === 0 && exits(only);
}

function unparenthesized(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function readsSymbol(checker: ts.TypeChecker, expression: ts.Expression, symbol: ts.Symbol): boolean {
  const bare = unparenthesized(expression);
  return ts.isIdentifier(bare) && valueSymbolOf(checker, bare) === symbol;
}

function isNullish(expression: ts.Expression): boolean {
  const bare = unparenthesized(expression);
  return bare.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(bare) && bare.text === 'undefined');
}

const NULLISH_EQUALITY: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
]);

/**
 * `condition` holds only when `symbol` is falsy or nullish: `!x`, `x == null`,
 * `x === undefined` (either operand order, `==` or `===`, `null` or
 * `undefined`), or an `||` with such a disjunct.
 */
function establishesAbsent(checker: ts.TypeChecker, condition: ts.Expression, symbol: ts.Symbol): boolean {
  const bare = unparenthesized(condition);
  if (ts.isPrefixUnaryExpression(bare)) {
    return bare.operator === ts.SyntaxKind.ExclamationToken && readsSymbol(checker, bare.operand, symbol);
  }
  if (!ts.isBinaryExpression(bare)) return false;
  const operator = bare.operatorToken.kind;
  if (operator === ts.SyntaxKind.BarBarToken) {
    return establishesAbsent(checker, bare.left, symbol) || establishesAbsent(checker, bare.right, symbol);
  }
  if (!NULLISH_EQUALITY.has(operator)) return false;
  return (
    (readsSymbol(checker, bare.left, symbol) && isNullish(bare.right)) ||
    (isNullish(bare.left) && readsSymbol(checker, bare.right, symbol))
  );
}

/**
 * Between `node` and `boundary`, `node` sits in the then-branch of an `if`,
 * the right of an `&&` or the true branch of a `?:` whose condition mentions
 * `symbol`, or after an `if (…) return;`/`throw` in the same block whose
 * condition establishes it is absent (`establishesAbsent`). The branch forms
 * are "mentions", not "tests": `if (!id) write(id)` counts.
 */
function isGuarded(checker: ts.TypeChecker, node: ts.Node, boundary: ts.Node, symbol: ts.Symbol): boolean {
  let child: ts.Node = node;
  for (let current = node.parent; current !== boundary; child = current, current = current.parent) {
    if (ts.isIfStatement(current) && current.thenStatement === child && mentions(checker, current.expression, symbol)) return true;
    if (ts.isConditionalExpression(current) && current.whenTrue === child && mentions(checker, current.condition, symbol)) return true;
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      current.right === child &&
      mentions(checker, current.left, symbol)
    ) {
      return true;
    }
    if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isCaseOrDefaultClause(current)) {
      const index = current.statements.findIndex((statement) => statement === child);
      const earlier = index < 0 ? [] : current.statements.slice(0, index);
      if (earlier.some((s) => ts.isIfStatement(s) && exits(s.thenStatement) && establishesAbsent(checker, s.expression, symbol))) {
        return true;
      }
    }
  }
  return false;
}

/** The function declared in `source`, outside `hook`, that `call` invokes by name. */
function sameFileCallee(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  source: ts.SourceFile,
  hook: ts.Node,
): ts.FunctionLikeDeclaration | undefined {
  return ts.isIdentifier(call.expression) ? sameFileFunction(checker, call.expression, source, hook) : undefined;
}

/** The function declared in `source`, outside `hook`, that `id` names: a function declaration or a `const` bound to an arrow or function expression. */
function sameFileFunction(
  checker: ts.TypeChecker,
  id: ts.Identifier,
  source: ts.SourceFile,
  hook: ts.Node,
): ts.FunctionLikeDeclaration | undefined {
  const declaration = checker.getSymbolAtLocation(id)?.valueDeclaration;
  if (declaration === undefined || declaration.getSourceFile() !== source) return undefined;
  let fn: ts.FunctionLikeDeclaration | undefined;
  if (ts.isFunctionDeclaration(declaration)) fn = declaration;
  else if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  ) {
    fn = declaration.initializer;
  }
  if (fn?.body === undefined) return undefined;
  return ts.findAncestor(fn, (n) => n === hook) === undefined ? fn : undefined;
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

    /**
     * Rows for the calls in `body`. In a followed callee, `callSite` is the
     * hook's call to it: every row is `indirect`, a row is guarded inside the
     * callee or at the call site, and the callee's own callees are not followed.
     */
    const inspect = (hook: Hook, body: ts.Node, boundary: ts.Node, callSite: ts.CallExpression | undefined): void => {
      const followed = new Set<ts.Node>();
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
          const direct = isDirectWrite(n) ? whereOf(n) : undefined;
          const read =
            direct === undefined
              ? isOtherDelegateMethod(checker, n)
                ? []
                : n.arguments.filter((arg) => !ts.isFunctionLike(arg)).flatMap((arg) => valueIdentifiers(arg))
              : valueIdentifiers(direct);
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
              kind: direct !== undefined && callSite === undefined ? 'direct' : 'indirect',
              call: calleeText(n, source),
              bindings: [...symbols.keys()],
              guarded: [...symbols.values()].every(
                (symbol) =>
                  isGuarded(checker, n, boundary, symbol) ||
                  (callSite !== undefined && isGuarded(checker, callSite, hook.callback, symbol)),
              ),
              client: clientIds.some((id) => id !== undefined && isAppClient(checker, id, appDbFile)) ? 'app' : 'test',
            });
          }
          const callee = callSite === undefined ? sameFileCallee(checker, n, source, hook.callback) : undefined;
          if (callee?.body !== undefined && !followed.has(callee)) {
            followed.add(callee);
            inspect(hook, callee.body, callee, n);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(body);
    };

    const find = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const hook = hookOf(checker, n, source);
        if (hook !== undefined) {
          if (hook.callback.body !== undefined) inspect(hook, hook.callback.body, hook.callback, undefined);
          return;
        }
      }
      ts.forEachChild(n, find);
    };
    find(source);
  }
  return findings;
}
