/**
 * THE SCOPE-REACH GUARDS MUST KEEP READING THE TREE FOR THEMSELVES (#489).
 *
 * A structural census under `src/lib` walks `src/`, censuses what it read, and
 * then checks that it reached every area of the tree. The checking side does
 * its own `readdirSync` — a function named `areasUnderSrc` — rather than asking
 * the walk. That duplication is what makes the check able to fail: a guard
 * whose two sides come from one function narrows in lockstep with it, so a
 * filter added inside that function drops an area from the census AND from the
 * guard's expectation in the same edit and the comparison stays equal. Measured
 * on this branch's base: share the two walks, narrow the result, and every
 * db-locks census test stays green while the census watches a fraction of the
 * repository. That is the defect #472 closed, restored by a refactor whose
 * whole appearance is an improvement.
 *
 * Prose cannot hold that, and this repository ships an agent whose stated job
 * is removing duplication. So this file holds it instead, for every census file
 * at once — one implementation of a delicate predicate rather than one per
 * file, drifting.
 *
 * WHAT IT ASSERTS. Inside `areasUnderSrc`, every callee that roots in a
 * module-level binding must root in an import from a `node:` specifier, and a
 * `readdirSync` call must be present. "Roots in" means the bare identifier of
 * an identifier callee, or the leftmost identifier of a property- or
 * element-access callee. That is deliberately wider than "does not call the
 * walk by name", which a rename defeats and which the refactor actually feared
 * — hoisting the walk into another module — walks straight past.
 *
 * WHICH FILES, discovered rather than written down: every `src/lib/*.test.ts`
 * declaring `areasUnderSrc` at module level. A third census file joins on its
 * own. `KNOWN_CENSUS_FILES` is the floor under that discovery, because a
 * discovery finding nothing would otherwise certify nothing.
 *
 * WHAT IT DOES NOT SEE, so a call landing there is nobody's failure here. A
 * callee rooting in a parameter or a function-local is out of scope, and so is
 * a non-identifier callee such as a regex literal's `.test` — neither can reach
 * another walk. That leaves one blind spot the censuses themselves also carry:
 * a walk reached through a local binding (`const w = shared; w();`) roots in a
 * local and is invisible, because resolving it needs a full type-checker
 * program this test does not build. Shadowing is not modelled either — a
 * function-local sharing a name with a module-level binding is reported though
 * the call reaches the local. That direction is loud and correctable; the other
 * one hides the refactor this file exists to catch.
 *
 * A file that parses is assumed. `ts.createSourceFile` does not throw and no
 * diagnostics are read here, so a syntax error that swallows a call reports
 * nothing; `npm run typecheck` in CI's `checks` job is what holds that.
 *
 * THIS FILE STAYS OUT OF BOTH CENSUSES, and not only by the `*.test.ts`
 * exclusion each of them applies. It makes no call to any helper either census
 * watches — those names appear here in prose alone, and prose is not a call
 * expression — and it does not spell the db-locks marker, which that census
 * treats as a reserved token wherever it occurs in a file it searches. It
 * likewise does not discover itself: the discovery below reads declarations,
 * and `areasUnderSrc` appears here only inside fixture text.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();

/** The only directory searched: where the census files live. */
const CENSUS_DIR = 'src/lib';

/** The function whose independence this file holds, and what discovery keys on. */
const GUARD = 'areasUnderSrc';

/** The call its body must still make, so an emptied-out guard is not "clean". */
const WALK = 'readdirSync';

/**
 * The census files that declare `GUARD` today. Not the list this file checks —
 * that is discovered — but the floor under it: discovery going stale or empty
 * fails here by name rather than silently checking nothing.
 *
 * A file renaming `GUARD`, or losing it, drops out of discovery and is reported
 * here rather than as "no violations in a function that was never located".
 */
const KNOWN_CENSUS_FILES: readonly string[] = [
  'src/lib/db-locks-verdict-census.test.ts',
  'src/lib/probe-placement-census.test.ts',
];

/** Wrappers that leave a callee's identity unchanged: `(f)(…)` and `f!(…)`. */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** The identifier a callee roots in, or nothing when it roots in an expression. */
function rootOf(callee: ts.Expression): string | undefined {
  let current = callee;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrap(current.expression);
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

/** The name a callee ends in: `f`, `ns.f`, or `ns['f']`. */
function calleeName(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return callee.argumentExpression.text;
  }
  return undefined;
}

/** Where a module-level name comes from, and whether a call may root in it. */
interface Binding {
  /** Rendered into the finding, so a failure says why the callee is one. */
  readonly origin: string;
  /** An import from a `node:` specifier — the only root a call in the guard may have. */
  readonly fromNodeBuiltin: boolean;
}

/**
 * Every name the module level of one file binds, with where it came from.
 *
 * Imports, variable statements, and the declaration forms that introduce a
 * callable name are all collected, because the point is what a callee inside
 * the guard can root in — not what kind of statement put it there. A name this
 * misses is a call this file would pass, so the arms are wide rather than
 * minimal: destructured import and variable bindings are walked into, and an
 * import assignment is read for its specifier.
 */
function moduleLevelBindings(source: ts.SourceFile): ReadonlyMap<string, Binding> {
  const bindings = new Map<string, Binding>();
  const local: Binding = { origin: 'is declared at module level', fromNodeBuiltin: false };

  const declare = (name: ts.BindingName | undefined, binding: Binding): void => {
    if (name === undefined) return;
    if (ts.isIdentifier(name)) {
      bindings.set(name.text, binding);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) declare(element.name, binding);
    }
  };

  const fromSpecifier = (specifier: string): Binding => ({
    origin: `is imported from '${specifier}'`,
    fromNodeBuiltin: specifier.startsWith('node:'),
  });

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const binding = fromSpecifier(statement.moduleSpecifier.text);
      declare(clause.name, binding);
      const named = clause.namedBindings;
      if (named === undefined) continue;
      if (ts.isNamespaceImport(named)) declare(named.name, binding);
      else for (const element of named.elements) declare(element.name, binding);
      continue;
    }
    if (ts.isImportEqualsDeclaration(statement)) {
      const reference = statement.moduleReference;
      declare(
        statement.name,
        ts.isExternalModuleReference(reference) && ts.isStringLiteral(reference.expression)
          ? fromSpecifier(reference.expression.text)
          : local,
      );
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        declare(declaration.name, local);
      }
      continue;
    }
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      declare(statement.name, local);
    }
  }
  return bindings;
}

/**
 * The guard's body in one parsed file, in either shape a module-level
 * declaration of it takes: a `function` statement, or a variable bound to a
 * function expression or arrow. Nothing when the source declares neither, which
 * is what keeps a file merely mentioning the name — this one, where it occurs
 * inside fixture text — out of the discovered set.
 */
function guardIn(source: ts.SourceFile): ts.Node | undefined {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === GUARD) return statement;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const body = declaration.initializer;
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== GUARD) continue;
      if (body === undefined) continue;
      if (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) return body;
    }
  }
  return undefined;
}

/**
 * What the guard in one source reaches past `node:`, in source order, with the
 * missing-walk finding last.
 *
 * Nothing at all — as against an empty list — when the source declares no
 * guard. The two answers are different things and discovery depends on telling
 * them apart: an empty list is a file this checked and found clean.
 */
function independenceOf(file: string, text: string): readonly string[] | undefined {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const guard = guardIn(source);
  if (guard === undefined) return undefined;

  const bindings = moduleLevelBindings(source);
  const findings: string[] = [];
  let walks = false;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (calleeName(callee) === WALK) walks = true;
      const rootName = rootOf(callee);
      const binding = rootName === undefined ? undefined : bindings.get(rootName);
      if (rootName !== undefined && binding !== undefined && !binding.fromNodeBuiltin) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const calleeText = callee.getText(source).replace(/\s+/g, ' ');
        findings.push(
          `${file}:${line} ${GUARD} calls ${calleeText} — ${rootName} ${binding.origin}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(guard);

  if (!walks) findings.push(`${file} ${GUARD} makes no ${WALK} call`);
  return findings;
}

/** One discovered census file and what its guard reaches. */
interface Checked {
  readonly file: string;
  readonly findings: readonly string[];
}

/**
 * Every `*.test.ts` directly under `CENSUS_DIR` that declares the guard, with
 * its findings. Memoised: both assertions below read it, and the second must
 * report on the same set the first put a floor under.
 */
let checked: readonly Checked[] | undefined;
function censusFiles(): readonly Checked[] {
  return (checked ??= readdirSync(path.join(root, CENSUS_DIR), { encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.test.ts'))
    .map((entry) => `${CENSUS_DIR}/${entry}`)
    .sort()
    .flatMap((file) => {
      const findings = independenceOf(file, readFileSync(path.join(root, file), 'utf8'));
      return findings === undefined ? [] : [{ file, findings }];
    }));
}

describe('every scope-reach guard reads the tree for itself', () => {
  it('discovers the census files that declare the guard', () => {
    // First, because the assertion after it passes vacuously on an empty set:
    // a discovery that stops finding census files reports no violation, which
    // is indistinguishable from a healthy repository. Both halves report a
    // list or a boolean rather than a bare count, so a failure says which way
    // it broke.
    const discovered = censusFiles().map((entry) => entry.file);
    expect({
      knownFilesNotDeclaringIt: KNOWN_CENSUS_FILES.filter((file) => !discovered.includes(file)),
      // Deliberately not `KNOWN_CENSUS_FILES.length`: a roster edited down
      // must not take the floor down with it.
      atLeastTwoDeclareIt: discovered.length >= 2,
    }).toEqual({ knownFilesNotDeclaringIt: [], atLeastTwoDeclareIt: true });
  });

  it('finds no guard reaching past a node: builtin', () => {
    expect(censusFiles().flatMap((entry) => entry.findings)).toEqual([]);
  });
});

/**
 * The rule above, against sources this repository does not contain.
 *
 * Without these the suite exercises one shape — the healthy one — because that
 * is all the census files hold, and a predicate that has never reported
 * anything is indistinguishable from one that cannot. Each fixture below is a
 * refactor somebody would plausibly make, parsed by the same
 * `independenceOf` the assertions above call.
 */
const FIXTURE = 'src/lib/fixture-census.test.ts';

/** What every fixture's guard reads unless the fixture is about removing it. */
const OWN_WALK = `
  for (const found of readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })) {
    const relative = found.split(path.sep).join('/');
    if (!/\\.tsx?$/.test(relative)) continue;
    areas.add(relative.split('/')[0] ?? relative);
  }`;

/** The preamble the real census files share, node: imports and all. */
const PREAMBLE = `
import { readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function typeScriptUnderSrc(): string[] {
  return readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .map((p) => \`src/\${p.split(path.sep).join('/')}\`);
}
`;

function guardSource(body: string, preamble = PREAMBLE): string {
  return `${preamble}
function ${GUARD}(): Set<string> {
  const areas = new Set<string>();
${body}
  return areas;
}
`;
}

describe('the rule, against sources this repository does not contain', () => {
  it('reports nothing for a guard that walks the tree itself', () => {
    expect(independenceOf(FIXTURE, guardSource(OWN_WALK))).toEqual([]);
  });

  it('reports nothing when another walk is named only in prose and in data', () => {
    // Syntax, not text: the whole reason this reads an AST. A cross-reference
    // in a comment, and a name held as data the way both censuses hold theirs,
    // are not call expressions and buy no violation.
    const body = `  // Deliberately not typeScriptUnderSrc: this reads the tree itself.
  const reason = 'typeScriptUnderSrc';
  if (reason === '') return areas;
${OWN_WALK}`;
    expect(independenceOf(FIXTURE, guardSource(body))).toEqual([]);
  });

  it('reports a walk hoisted into a sibling function of the same file', () => {
    // The cheapest way to DRY the two walks, and the one an agent removing
    // duplication reaches for first. Two findings: the reach, and the walk
    // this body no longer makes.
    const body = `  for (const relative of typeScriptUnderSrc()) {
    areas.add(relative.split('/')[0] ?? relative);
  }`;
    expect(independenceOf(FIXTURE, guardSource(body))).toEqual([
      `${FIXTURE}:14 ${GUARD} calls typeScriptUnderSrc — typeScriptUnderSrc is declared at module level`,
      `${FIXTURE} ${GUARD} makes no ${WALK} call`,
    ]);
  });

  it('reports a reach into the file even where the walk survives beside it', () => {
    // The two arms are separable, and this is what keeps the reach arm from
    // riding on the missing-walk one: the body still calls `readdirSync`.
    const body = `  if (typeScriptUnderSrc().length === 0) return areas;
${OWN_WALK}`;
    expect(independenceOf(FIXTURE, guardSource(body))).toEqual([
      `${FIXTURE}:14 ${GUARD} calls typeScriptUnderSrc — typeScriptUnderSrc is declared at module level`,
    ]);
  });

  it('reports a walk hoisted into another module and imported by name', () => {
    const preamble = `
import { walk } from './census-walk';
`;
    const body = `  for (const relative of walk()) {
    areas.add(relative.split('/')[0] ?? relative);
  }`;
    expect(independenceOf(FIXTURE, guardSource(body, preamble))).toEqual([
      `${FIXTURE}:6 ${GUARD} calls walk — walk is imported from './census-walk'`,
      `${FIXTURE} ${GUARD} makes no ${WALK} call`,
    ]);
  });

  it('reports the same walk reached as a namespace member', () => {
    // The rename-proof half: nothing here matches a name this file knows. What
    // condemns it is where `w` comes from.
    const preamble = `
import * as w from './census-walk';
`;
    const body = `  for (const relative of w.walk()) {
    areas.add(relative.split('/')[0] ?? relative);
  }`;
    expect(independenceOf(FIXTURE, guardSource(body, preamble))).toEqual([
      `${FIXTURE}:6 ${GUARD} calls w.walk — w is imported from './census-walk'`,
      `${FIXTURE} ${GUARD} makes no ${WALK} call`,
    ]);
  });

  it('finds the guard where it is a variable bound to an arrow', () => {
    const source = `${PREAMBLE}
const ${GUARD} = (): string[] => typeScriptUnderSrc();
`;
    expect(independenceOf(FIXTURE, source)).toEqual([
      `${FIXTURE}:12 ${GUARD} calls typeScriptUnderSrc — typeScriptUnderSrc is declared at module level`,
      `${FIXTURE} ${GUARD} makes no ${WALK} call`,
    ]);
  });

  it('finds nothing at all, as against nothing wrong, where no guard is declared', () => {
    // What discovery keys on. A file whose guard was renamed away drops out of
    // the discovered set rather than joining it with an empty finding list,
    // and the floor assertion is what then reports it.
    expect(independenceOf(FIXTURE, PREAMBLE)).toBeUndefined();
  });
});
