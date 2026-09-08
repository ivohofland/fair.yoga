/**
 * THE SCOPE-REACH GUARDS MUST KEEP READING THE TREE FOR THEMSELVES (#489, #492).
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
 * whole appearance is an improvement. The measurement is in
 * `docs/superpowers/specs/2026-09-07-census-scope-tethers-design.md`.
 *
 * Prose cannot hold that, and this repository ships an agent whose stated job
 * is removing duplication. So this file holds it instead, for every census file
 * at once — one implementation of a delicate predicate rather than one per
 * file, drifting.
 *
 * WHAT IT ASSERTS. Inside `areasUnderSrc`, every callee that roots in a
 * module-level binding must root in an import from a `node:` specifier, and a
 * `readdirSync` call must be present. "Roots in" means the bare identifier of
 * an identifier callee, the leftmost identifier of a property- or
 * element-access callee, or — unwrapped the same way — the identifier a
 * construct expression invokes, so `new Walker().walk()` roots in `Walker`.
 * That is deliberately wider than "does not call the walk by name", which a
 * rename defeats and which the refactor actually feared — hoisting the walk
 * into another module — walks straight past.
 *
 * WHAT IT ALSO ASSERTS (#492). Each census file's `reached` — what the
 * scope-reach assertion compares `areasUnderSrc` against — must be built from
 * the census's own consumed-file list. Every `const reached = …`
 * declaration in the file (there may be more than one, and each is checked
 * on its own) must call `censusOfTree`, and any other call rooting in a
 * module-level binding not reached from a `node:` import is a finding — the
 * same node:-origin allowance `areasUnderSrc`'s own check makes, with
 * `censusOfTree` additionally allowed by name alone. That is what catches a
 * revert to a second, independent read of `searchScope()` or
 * `typeScriptUnderSrc()`, aliased or not — and, since `censusOfTree` itself
 * must be unambiguous for the name-alone allowance to mean anything, a second
 * declaration of `censusOfTree` anywhere in the file is a finding too, before
 * any `reached` initializer is even inspected.
 *
 * WHICH FILES, discovered rather than written down: every `src/lib/*.test.ts`
 * declaring `areasUnderSrc` at module level, and separately, every
 * `src/lib/*.test.ts` declaring a `reached` variable anywhere in its syntax tree — a
 * third census file joins either discovery on its own, or both.
 * `KNOWN_CENSUS_FILES` is the floor under both, because a discovery finding
 * nothing would otherwise certify nothing.
 *
 * WHAT IT DOES NOT SEE, so a call landing there is nobody's failure here. A
 * callee rooting in a parameter is out of scope, and so is a non-identifier
 * callee such as a regex literal's `.test` — neither can reach another walk.
 * A callee rooting in a function-local can, and that is the one blind spot
 * the censuses themselves also carry: a walk reached through a local binding
 * (`const w = shared; w();`) roots in a local and is invisible, because
 * resolving it needs a full type-checker program this test does not build.
 * Shadowing is not modelled either — a
 * function-local sharing a name with a module-level binding is reported though
 * the call reaches the local. That direction is loud and correctable; the other
 * one hides the refactor this file exists to catch. One narrower gap is
 * accepted rather than closed (#492): a walk hoisted into a `namespace N {
 * export function walk() {...} }` and called as `N.walk()` resolves to no
 * binding at all, but degrades loud rather than silent — the body then makes
 * no `readdirSync` call, and the missing-walk arm above already reports
 * that. `import x = SomeNamespace.Member` — the internal-namespace form of
 * an import-equals declaration, as against the `require(...)` form fixtured
 * below — is not a gap at all: `moduleLevelBindings` falls through to the
 * same module-level-local treatment any plain declaration gets, so a call
 * reached this way is caught exactly like the destructured-variable case
 * fixtured below; a dedicated fixture for it is added alongside that one,
 * since it exercises a different branch of `moduleLevelBindings` even though
 * both land on the same `local` treatment. The `reached` tether below reuses
 * this same root resolution, so it shares the one blind spot above: a callee
 * rooting in a parameter or a function-local, and the namespace-declaration
 * gap, apply there too.
 *
 * A file that parses is assumed. `ts.createSourceFile` does not throw and no
 * diagnostics are read here, so a syntax error that swallows a call reports
 * nothing; `npm run typecheck` in CI's `checks` job is what holds that.
 *
 * THIS FILE STAYS OUT OF BOTH CENSUSES, and not only by the `*.test.ts`
 * exclusion each of them applies. It makes no call to any helper either
 * census watches, and does not name one anywhere in this file, in a call or
 * in prose, so neither census's call detector has anything to match. It does
 * not spell the db-locks marker either, which that census treats as a
 * reserved token wherever it occurs in a file it searches. It likewise does
 * not discover itself, on either of its own two invariants: the `GUARD`
 * discovery reads module-level declarations only, and this file declares no
 * function or function-valued variable named `areasUnderSrc`; the `REACHED`
 * discovery (#492) is not scoped that way — it walks every node in every
 * scope looking for a `VariableDeclaration` named `reached` — and this file
 * declares no such variable as real code, at any depth. Both names appear
 * only in this docblock's prose, as the `GUARD`/`REACHED` constants, and
 * inside fixture source strings that are parsed as separate synthetic files,
 * never as this one — a real `reached` local written anywhere in this file
 * would join its own discovered set and redden its own assertion, which is a
 * thinner margin than `GUARD`'s and worth remembering before adding one.
 *
 * `reachedIn` ALSO DOES NOT SEE a `reached` declared without an initializer
 * in the same statement — `let reached; if (…) { reached = …; } else { … }`,
 * or a destructured `const { reached } = build();` — both leave
 * `reachedIndependenceOf` unable to tell the file apart from one declaring no
 * `reached` at all. Filed as a follow-up rather than closed here.
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
const WALK = 'readdirSync' satisfies keyof typeof import('node:fs');

/** The local this file's second invariant holds to independence (#492). */
const REACHED = 'reached';

/** The one call `REACHED`'s initializer must make — the census's own consumed list. */
const CENSUS = 'censusOfTree';

/**
 * The census files that declare `GUARD` — and, in the discovery below,
 * `REACHED` — today. Not either list this file checks — those are
 * discovered — but the floor under both: discovery going stale or empty
 * fails here by name rather than silently checking nothing.
 *
 * A file renaming `GUARD` or `REACHED`, or losing either, drops out of the
 * corresponding discovery and is reported here rather than as "no violations
 * in a function that was never located".
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
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isNewExpression(current)
  ) {
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
 *
 * Returns the FIRST such declaration found, trusting there is at most one.
 * `tsc` itself enforces that for a `function` statement, and for `const`/`let`
 * — redeclaring `GUARD` any of those ways is a compile error. It does not for
 * `var`, which permits redeclaration; this project's lint step forbids `var`
 * project-wide, which is what actually holds this assumption, not `tsc`.
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
 * Whether a binding name introduces `REACHED`, directly or through a
 * destructuring pattern — the same recursion `moduleLevelBindings`'s own
 * `declare` already performs on `ts.BindingName`, not re-explained here.
 * `elements.some(…)` guarded by `ts.isBindingElement` serves both pattern
 * kinds: an `ArrayBindingPattern`'s elements may include an
 * `OmittedExpression` hole, which the guard skips, while an
 * `ObjectBindingPattern`'s never do.
 */
function bindsReached(target: ts.BindingName): boolean {
  if (ts.isIdentifier(target)) return target.text === REACHED;
  return target.elements.some((element) => ts.isBindingElement(element) && bindsReached(element.name));
}

/**
 * The initializers of every `const reached = …;` declaration in the file,
 * found by a full recursive walk rather than `guardIn`'s module-level-only
 * one — `reached` lives inside the scope-reach assertion's `it(...)`
 * callback, not at module level. Every match, not just the first: two
 * `reached` declarations in sibling `it(...)` callbacks are legal TypeScript
 * (unlike two module-level `GUARD` declarations, which `tsc` itself would
 * refuse), so a second one needs its own check — collecting only the first
 * would leave it silently unguarded, the exact failure this file exists to
 * make impossible.
 */
function reachedDeclarationsIn(source: ts.SourceFile): readonly ts.VariableDeclaration[] {
  const found: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && bindsReached(node.name)) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
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

/**
 * How many times the file declares `CENSUS` — a function declaration or a
 * variable bound to one — anywhere in it, at any depth. `reachedIndependenceOf`
 * trusts a bare name match against `CENSUS`, the same way `independenceOf`
 * trusts `WALK`'s; that trust only holds while the name is unambiguous. A
 * second declaration — necessarily nested, since a second module-level one is
 * a `tsc` redeclaration error the way `GUARD`'s is — shadows the first inside
 * whatever scope it's declared in, and nothing that walks only a `reached`
 * initializer ever visits a shadow's own body to see what it actually calls.
 */
function censusDeclarationCount(source: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === CENSUS) count++;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === CENSUS) {
      count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

/**
 * What each of `REACHED`'s initializers reaches apart from `CENSUS`, with
 * each initializer's own missing-`CENSUS`-call finding last in its group —
 * the same two-direction shape `independenceOf` uses for `GUARD`, reusing
 * `rootOf` and `moduleLevelBindings` so a call reaching a forbidden name
 * through a local alias (`const s = searchScope; …s()…`) is caught the same
 * way it already is for `GUARD`. Reuses `independenceOf`'s node:-origin
 * allowance too — a call rooting in a node:-imported binding is never a
 * finding here either — and additionally allows a call rooting in a
 * module-level binding named `CENSUS`, regardless of where it comes from,
 * sufficient here because `censusOfTree` is always the file's own
 * declaration, never imported.
 *
 * That name-alone trust is only sound while the name is unambiguous, which is
 * what `censusDeclarationCount` polices first: a shadow named `censusOfTree`
 * anywhere in the file — necessarily nested, since a second module-level one
 * is a `tsc` redeclaration error — would satisfy the name check without its
 * own body ever being inspected, so more than one declaration is a finding on
 * its own, before any initializer is even walked.
 *
 * `undefined`, as against an empty array of findings, when the file declares
 * no `REACHED` at all — not merely one whose initializers are all clean.
 */
function reachedIndependenceOf(file: string, text: string): readonly string[] | undefined {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const declarations = reachedDeclarationsIn(source);
  if (declarations.length === 0) return undefined;

  const bindings = moduleLevelBindings(source);
  const findings: string[] = [];

  const censusCount = censusDeclarationCount(source);
  if (censusCount > 1) {
    findings.push(
      `${file} declares ${CENSUS} ${censusCount} times, not once — a shadow could be what "${REACHED}" actually calls`,
    );
  }

  for (const declaration of declarations) {
    if (declaration.initializer === undefined) {
      const line = source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1;
      findings.push(
        `${file}:${line} ${REACHED} is declared with no initializer of its own — nothing here can see what it is assigned`,
      );
      continue;
    }

    let sawCensus = false;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        const rootName = rootOf(callee);
        if (rootName === CENSUS) sawCensus = true;
        const binding = rootName === undefined ? undefined : bindings.get(rootName);
        if (
          rootName !== undefined &&
          rootName !== CENSUS &&
          binding !== undefined &&
          !binding.fromNodeBuiltin
        ) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          const calleeText = callee.getText(source).replace(/\s+/g, ' ');
          findings.push(
            `${file}:${line} ${REACHED} calls ${calleeText} — ${rootName} ${binding.origin}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration);
    if (!sawCensus) findings.push(`${file} ${REACHED} makes no ${CENSUS} call`);
  }

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

/**
 * Every `*.test.ts` directly under `CENSUS_DIR` that declares `REACHED`, with
 * what its initializer reaches. Memoised for the same reason `censusFiles` is:
 * both assertions below read it, and the second must report on the same set
 * the first put a floor under.
 */
let reachedChecked: readonly Checked[] | undefined;
function reachedCensusFiles(): readonly Checked[] {
  return (reachedChecked ??= readdirSync(path.join(root, CENSUS_DIR), { encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.test.ts'))
    .map((entry) => `${CENSUS_DIR}/${entry}`)
    .sort()
    .flatMap((file) => {
      const findings = reachedIndependenceOf(file, readFileSync(path.join(root, file), 'utf8'));
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

describe('every scope-reach guard derives what it reached from the census, not a second walk', () => {
  it('discovers the census files that declare `reached`', () => {
    // Same shape as the guard's own discovery test, and for the same reason:
    // the assertion after this one passes vacuously on an empty set.
    const discovered = reachedCensusFiles().map((entry) => entry.file);
    expect({
      knownFilesNotDeclaringIt: KNOWN_CENSUS_FILES.filter((file) => !discovered.includes(file)),
      atLeastTwoDeclareIt: discovered.length >= 2,
    }).toEqual({ knownFilesNotDeclaringIt: [], atLeastTwoDeclareIt: true });
  });

  it('finds no `reached` reaching past the census itself', () => {
    expect(reachedCensusFiles().flatMap((entry) => entry.findings)).toEqual([]);
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

  it('reports a call reaching through an import assignment', () => {
    // The one binding form `moduleLevelBindings` reads a specifier from that
    // regular `ts.isImportDeclaration` handling above does not cover:
    // `import x = require(...)`, parsed as a distinct `ts.ImportEqualsDeclaration`
    // node. Bound here from a non-`node:` specifier, so the call is a finding —
    // the clean fixtures above already prove a `node:` specifier reached this
    // way would not be.
    const preamble = `
import legacyFs = require('./legacy-fs');
`;
    const body = `  for (const relative of legacyFs.readdirSync()) {
    areas.add(relative.split('/')[0] ?? relative);
  }`;
    expect(independenceOf(FIXTURE, guardSource(body, preamble))).toEqual([
      `${FIXTURE}:6 ${GUARD} calls legacyFs.readdirSync — legacyFs is imported from './legacy-fs'`,
    ]);
  });

  it('reports a call rooting in a destructured module-level variable binding', () => {
    // `declare` recurses into a variable's binding pattern rather than only
    // handling a bare identifier — a name bound by `const { a } = something;`
    // is exactly as reachable as one bound by `const a = something.a;`. That
    // recursion is what this pins: remove it and this call's root is never
    // added to `bindings`, so the lookup below finds nothing and the call
    // passes silently instead of failing loudly.
    const preamble = `
const { a } = something;
`;
    const body = `  if (a().length === 0) return areas;
${OWN_WALK}`;
    expect(independenceOf(FIXTURE, guardSource(body, preamble))).toEqual([
      `${FIXTURE}:6 ${GUARD} calls a — a is declared at module level`,
    ]);
  });

  it('reports a call rooting in a `new` expression', () => {
    // `rootOf` must descend through a `NewExpression`, not only
    // PropertyAccessExpression/ElementAccessExpression chains: without that
    // disjunct `new Walker().walk()` roots in no identifier, and a walk
    // reached through a class instance is invisible however the class itself
    // is bound.
    const preamble = `
import { Walker } from './walker';
`;
    const body = `  for (const relative of new Walker().walk()) {
    areas.add(relative.split('/')[0] ?? relative);
  }`;
    expect(independenceOf(FIXTURE, guardSource(body, preamble))).toEqual([
      `${FIXTURE}:6 ${GUARD} calls new Walker().walk — Walker is imported from './walker'`,
      `${FIXTURE} ${GUARD} makes no ${WALK} call`,
    ]);
  });

  it('reports a call reaching through a default import', () => {
    // `declare(clause.name, binding)` binds a default import's local name.
    // The clean fixtures above import only `path from 'node:path'`, which
    // never has to distinguish "bound and clean" from "not bound at all" —
    // this pins the positive case: a default-imported walk is exactly as
    // reachable as a named one.
    const preamble = `
import walk from './census-walk';
`;
    const body = `  for (const relative of walk()) {
    areas.add(relative.split('/')[0] ?? relative);
  }`;
    expect(independenceOf(FIXTURE, guardSource(body, preamble))).toEqual([
      `${FIXTURE}:6 ${GUARD} calls walk — walk is imported from './census-walk'`,
      `${FIXTURE} ${GUARD} makes no ${WALK} call`,
    ]);
  });

  it('reports a call rooting in a module-level class declaration', () => {
    // The other declaration form `moduleLevelBindings` must cover: a class
    // (or enum) declared at module level, called through a static method —
    // the same `isFunctionDeclaration || isClassDeclaration ||
    // isEnumDeclaration` disjunct that binds a plain `function` statement
    // also binds this.
    const preamble = `
class CensusWalk {
  static walk(): string[] {
    return [];
  }
}
`;
    const body = `  for (const relative of CensusWalk.walk()) {
    areas.add(relative.split('/')[0] ?? relative);
  }`;
    expect(independenceOf(FIXTURE, guardSource(body, preamble))).toEqual([
      `${FIXTURE}:10 ${GUARD} calls CensusWalk.walk — CensusWalk is declared at module level`,
      `${FIXTURE} ${GUARD} makes no ${WALK} call`,
    ]);
  });

  it('reports a call reaching through an import-equals internal-namespace reference', () => {
    // `import x = SomeNamespace.Member;` is an ImportEqualsDeclaration whose
    // moduleReference is an EntityName, not an ExternalModuleReference — the
    // ternary in moduleLevelBindings falls through to `local` for this shape,
    // a different branch than the require(...) fixture above exercises (that
    // one takes the ExternalModuleReference arm). Untested until this
    // fixture, though the code already handles it correctly.
    const preamble = `
namespace SomeNamespace {
  export function Member() {
    return [];
  }
}
import x = SomeNamespace.Member;
`;
    const body = `  if (x().length === 0) return areas;
${OWN_WALK}`;
    expect(independenceOf(FIXTURE, guardSource(body, preamble))).toEqual([
      `${FIXTURE}:11 ${GUARD} calls x — x is declared at module level`,
    ]);
  });

  it('finds nothing at all, as against nothing wrong, where no guard is declared', () => {
    // What discovery keys on. A file whose guard was renamed away drops out of
    // the discovered set rather than joining it with an empty finding list,
    // and the floor assertion is what then reports it.
    expect(independenceOf(FIXTURE, PREAMBLE)).toBeUndefined();
  });
});

/**
 * The `reached` rule above, against sources this repository does not
 * contain. Parsed the same way `independenceOf`'s own fixtures are, and for
 * the same reason: the real census files hold one shape apiece — the healthy
 * one — so a predicate that has never reported anything here is
 * indistinguishable from one that cannot.
 */
const REACHED_PREAMBLE = `
function censusOfTree() {
  return { filesCensused: [] as string[] };
}
function areaOf(file: string): string {
  return file;
}
function searchScope(): string[] {
  return [];
}
`;

/** Wraps a `reached` initializer the way the real files' `it(...)` callback does. */
function reachedSource(initializer: string, preamble = REACHED_PREAMBLE): string {
  return `${preamble}
describe('x', () => {
  it('y', () => {
    const ${REACHED} = ${initializer};
  });
});
`;
}

describe('the reached rule, against sources this repository does not contain', () => {
  it('reports nothing for the real shape', () => {
    expect(
      reachedIndependenceOf(FIXTURE, reachedSource('new Set(censusOfTree().filesCensused.map(areaOf))')),
    ).toEqual([]);
  });

  it('reports a reach into a second, independent walk', () => {
    expect(reachedIndependenceOf(FIXTURE, reachedSource('new Set(searchScope().map(areaOf))'))).toEqual([
      `${FIXTURE}:14 ${REACHED} calls searchScope — searchScope is declared at module level`,
      `${FIXTURE} ${REACHED} makes no ${CENSUS} call`,
    ]);
  });

  it('reports the same reach through a local alias', () => {
    // The alias-following half: `rootOf` and `moduleLevelBindings` are shared
    // with `GUARD`'s predicate, so a call reaching `searchScope` through a
    // renamed local is exactly as visible here as it already is there.
    const preamble = `${REACHED_PREAMBLE}
const s = searchScope;
`;
    expect(reachedIndependenceOf(FIXTURE, reachedSource('new Set(s().map(areaOf))', preamble))).toEqual([
      `${FIXTURE}:16 ${REACHED} calls s — s is declared at module level`,
      `${FIXTURE} ${REACHED} makes no ${CENSUS} call`,
    ]);
  });

  it('reports a second `reached` declaration independently of the first', () => {
    // Two `reached` declarations in sibling `it(...)` callbacks are legal
    // TypeScript — unlike two module-level `GUARD` declarations, which `tsc`
    // itself would refuse — so a second one needs its own check. This pins
    // `reachedIn` collecting every match rather than only the first: the
    // clean first declaration contributes nothing, and the dirty second one
    // is checked on its own.
    const source = `${REACHED_PREAMBLE}
describe('x', () => {
  it('first', () => {
    const reached = new Set(censusOfTree().filesCensused.map(areaOf));
  });
  it('second', () => {
    const reached = new Set(searchScope().map(areaOf));
  });
});
`;
    expect(reachedIndependenceOf(FIXTURE, source)).toEqual([
      `${FIXTURE}:17 ${REACHED} calls searchScope — searchScope is declared at module level`,
      `${FIXTURE} ${REACHED} makes no ${CENSUS} call`,
    ]);
  });

  it('reports a shadowed `censusOfTree` even though the name check alone would miss it', () => {
    // The name-alone allowance for CENSUS only means anything if the name is
    // unambiguous. A second `censusOfTree`, nested beside `reached`, performs
    // a real independent walk here — and nothing that only walks the
    // initializer expression would ever see this shadow's own body.
    // `censusDeclarationCount` is what catches it instead: this fixture would
    // otherwise report `[]`, fully clean, despite the shadow's `readdirSync`.
    // (Never executed, only parsed, so these two imports need not resolve —
    // included anyway for fixture realism, matching OWN_WALK's real shape.
    // Prepended here rather than added to REACHED_PREAMBLE itself, which
    // other fixtures share and must not gain unrelated imports.)
    const source = `
import { readdirSync } from 'node:fs';
import path from 'node:path';
${REACHED_PREAMBLE}
describe('x', () => {
  it('y', () => {
    function censusOfTree() {
      return {
        filesCensused: readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' }),
      };
    }
    const reached = new Set(censusOfTree().filesCensused.map(areaOf));
  });
});
`;
    expect(reachedIndependenceOf(FIXTURE, source)).toEqual([
      `${FIXTURE} declares ${CENSUS} 2 times, not once — a shadow could be what "${REACHED}" actually calls`,
    ]);
  });

  it('reports a missing census call with no forbidden call alongside it', () => {
    // The two directions are separable: nothing here roots in a module-level
    // binding at all, so only the missing-call finding fires.
    expect(reachedIndependenceOf(FIXTURE, reachedSource('new Set([].map(areaOf))'))).toEqual([
      `${FIXTURE} ${REACHED} makes no ${CENSUS} call`,
    ]);
  });

  it('reports a bare declaration with no initializer of its own', () => {
    // The #472/#489/#492 regression reached through a different syntactic
    // door: `let reached;` with the assignment split across an `if`/`else`
    // still builds `reached` from a second, independent walk in one branch,
    // but leaves no initializer in the declaration itself for anything here
    // to inspect. Reporting the ambiguity loudly is the deliberate choice
    // over resolving which assignment wins.
    const source = `${REACHED_PREAMBLE}
describe('x', () => {
  it('y', () => {
    let ${REACHED};
    if (Math.random() > 0.5) {
      ${REACHED} = new Set(censusOfTree().filesCensused.map(areaOf));
    } else {
      ${REACHED} = new Set(searchScope().map(areaOf));
    }
  });
});
`;
    expect(reachedIndependenceOf(FIXTURE, source)).toEqual([
      `${FIXTURE}:14 ${REACHED} is declared with no initializer of its own — nothing here can see what it is assigned`,
    ]);
  });

  it('reports a destructured declaration by walking the whole declaration', () => {
    // `const { reached } = buildReachedSet();` has no `reached` initializer
    // of its own to collect under the old match — the destructuring source
    // is the declaration's initializer, not `reached`'s. Walking the whole
    // `VariableDeclaration` reaches it anyway.
    const preamble = `${REACHED_PREAMBLE}
function buildReachedSet(): Set<string> {
  return new Set(searchScope().map(areaOf));
}
`;
    const source = `${preamble}
describe('x', () => {
  it('y', () => {
    const { ${REACHED} } = buildReachedSet();
  });
});
`;
    expect(reachedIndependenceOf(FIXTURE, source)).toEqual([
      `${FIXTURE}:18 ${REACHED} calls buildReachedSet — buildReachedSet is declared at module level`,
      `${FIXTURE} ${REACHED} makes no ${CENSUS} call`,
    ]);
  });

  it('reports nothing for a destructured declaration that derives from the census', () => {
    // What keeps the fixture above from passing for the wrong reason: a
    // blanket "any destructured shape is a finding" would satisfy that
    // expectation too. This one derives `reached` from `censusOfTree`
    // directly in the declaration's own initializer, so walking the whole
    // declaration must find it clean.
    const source = `${REACHED_PREAMBLE}
describe('x', () => {
  it('y', () => {
    const { ${REACHED} } = { ${REACHED}: new Set(censusOfTree().filesCensused.map(areaOf)) };
  });
});
`;
    expect(reachedIndependenceOf(FIXTURE, source)).toEqual([]);
  });

  it('finds nothing at all, as against nothing wrong, where no `reached` is declared', () => {
    expect(reachedIndependenceOf(FIXTURE, REACHED_PREAMBLE)).toBeUndefined();
  });
});
