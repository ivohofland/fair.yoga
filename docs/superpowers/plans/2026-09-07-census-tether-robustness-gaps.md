# Census Tether Robustness Gaps (#492) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two robustness gaps #492 filed against `src/lib/census-walk-independence.test.ts` — the `rootOf`/`moduleLevelBindings` predicate's three unexercised binding-collection arms, and the scope-reach guard's unwatched `reached` side.

**Architecture:** Both fixes live entirely inside `src/lib/census-walk-independence.test.ts`. Task 1 fixes and fixtures three arms of the existing `areasUnderSrc`-independence predicate (`rootOf`, `moduleLevelBindings`) and documents two more as accepted blind spots. Task 2 adds a sibling predicate for a second invariant — the census files' `reached` local must derive from `censusOfTree()`, not a second walk — reusing Task 1's helpers (`unwrap`, `rootOf`, `moduleLevelBindings`) but with its own discovery (a recursive walk for a variable named `reached`, since it lives inside an `it(...)` callback, not at module level).

**Tech Stack:** TypeScript, the `typescript` compiler API (`ts.createSourceFile`, AST traversal), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-census-tether-robustness-design.md`

## Global Constraints

- No production code changes — every file this plan touches is a `.test.ts`.
- `src/lib/db-locks-verdict-census.test.ts` and `src/lib/probe-placement-census.test.ts` are not modified — both gaps close entirely inside `src/lib/census-walk-independence.test.ts`.
- Every new fixture must be proven by mutation: apply the code change it exercises in reverse (comment out or revert the fix), run the specific new test, record the exact failure text, then restore and re-verify green. This is not optional polish — it is the acceptance criterion for every step in this plan.
- Run tests with: `npx vitest run --project unit src/lib/census-walk-independence.test.ts` (fast — this file's suite alone). Run the full three-file suite (`npx vitest run --project unit src/lib/db-locks-verdict-census.test.ts src/lib/probe-placement-census.test.ts src/lib/census-walk-independence.test.ts`) at the end of each task.
- This project's dev `.env` must be present in the repo root for Prisma's client to resolve (copy it from the main checkout if the worktree doesn't have one): `cp /Users/ivohofland/Projects/fair.yoga/.env .`

---

## Task 1: Close three binding-collection blind spots in the `areasUnderSrc` predicate

**Files:**
- Modify: `src/lib/census-walk-independence.test.ts`

**Interfaces:**
- Consumes: nothing new — this task only edits functions and tests already in the file (`rootOf`, `moduleLevelBindings`, `independenceOf`, `guardSource`, `FIXTURE`, `GUARD`, `WALK`).
- Produces: a fixed `rootOf` (handles a `NewExpression` root) that Task 2 builds on.

- [ ] **Step 1: Fix `rootOf` to resolve a `new X().method()` root**

Locate `rootOf` (currently lines 101-108):

```ts
/** The identifier a callee roots in, or nothing when it roots in an expression. */
function rootOf(callee: ts.Expression): string | undefined {
  let current = callee;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrap(current.expression);
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}
```

Replace with:

```ts
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
```

`ts.NewExpression`, `ts.PropertyAccessExpression`, and `ts.ElementAccessExpression` all expose `.expression` as the thing to descend into, so the loop body needs no change — only the condition gains a disjunct. `new Walker().readdirSync()`'s callee is a `PropertyAccessExpression` whose `.expression` is the `NewExpression` `new Walker()`; before this change the loop stopped there (a `NewExpression` matched neither existing condition) and returned `undefined`. After this change it descends once more into `Walker`, an `Identifier`, and returns `'Walker'`.

- [ ] **Step 2: Add the `new`-expression-root fixture**

Locate the test `'reports a call rooting in a destructured module-level variable binding'` (ends around line 453 with `});`), immediately followed by `it('finds nothing at all, as against nothing wrong, where no guard is declared', ...)`. Insert a new test between them:

```ts
  it('reports a call rooting in a `new` expression', () => {
    // `rootOf` walked PropertyAccessExpression/ElementAccessExpression chains
    // looking for an Identifier root. A NewExpression broke that chain — it is
    // neither of those two kinds — so `new Walker().walk()` used to stop there
    // and return undefined: a walk reached through a class instance was
    // invisible however the class itself was bound.
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
```

This exact expected array (line `:6`, that exact callee text and finding order) was verified by running the real `independenceOf`/`rootOf`/`moduleLevelBindings` logic against this exact fixture text before this plan was written — it is not a guess.

- [ ] **Step 3: Run the new test and confirm it passes**

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
Expected: all tests pass, including `'reports a call rooting in a `new` expression'`.

- [ ] **Step 4: Prove the fixture bites — revert the `rootOf` fix, confirm red**

Temporarily revert Step 1's change (remove the `|| ts.isNewExpression(current)` disjunct, restoring the original three-line while condition). Run:

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
Expected: FAIL — exactly one test red, `'reports a call rooting in a `new` expression'`, with an assertion diff showing the actual result missing the `new Walker().walk` finding (only the `makes no readdirSync call` finding present, since `rootOf` now returns `undefined` for the `new Walker()` root again).

Record the exact failure text, then restore Step 1's fix and re-run to confirm all tests green again:

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Add the default-import-binding fixture**

Insert immediately after the fixture added in Step 2:

```ts
  it('reports a call reaching through a default import', () => {
    // `declare(clause.name, binding)` binds a default import's local name —
    // exercised until now only by `import path from 'node:path'` in the clean
    // fixtures above, which never has to distinguish "bound and clean" from
    // "not bound at all". A default-imported walk is exactly as reachable as
    // a named one.
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
```

- [ ] **Step 6: Run the new test and confirm it passes**

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
Expected: all tests pass, including `'reports a call reaching through a default import'`.

- [ ] **Step 7: Prove the fixture bites — disable default-import binding, confirm red**

Locate `moduleLevelBindings`'s import-declaration handling:

```ts
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const binding = fromSpecifier(statement.moduleSpecifier.text);
      declare(clause.name, binding);
      const named = clause.namedBindings;
```

Temporarily comment out the `declare(clause.name, binding);` line:

```ts
      const binding = fromSpecifier(statement.moduleSpecifier.text);
      // declare(clause.name, binding);
      const named = clause.namedBindings;
```

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
Expected: FAIL — exactly one test red, `'reports a call reaching through a default import'`, with the actual result showing only `${FIXTURE} ${GUARD} makes no ${WALK} call'` (the reach finding is gone, because `walk`'s root name is never added to `bindings`, so the lookup in `independenceOf` finds nothing and treats the call as out of scope).

Record the exact failure text, then restore the `declare(clause.name, binding);` line and re-run to confirm all tests green:

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
Expected: all tests pass.

- [ ] **Step 8: Add the class-declaration-binding fixture**

Insert immediately after the fixture added in Step 5:

```ts
  it('reports a call rooting in a module-level class declaration', () => {
    // The other declaration form `moduleLevelBindings` must cover: a class (or
    // enum) declared at module level, called through a static method.
    // `moduleLevelBindings` binds it via the same `isFunctionDeclaration ||
    // isClassDeclaration || isEnumDeclaration` disjunct that already binds a
    // plain `function` statement — untested until now for the class arm.
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
```

The line number (`:10`) was verified by running the real logic against this exact fixture text before this plan was written.

- [ ] **Step 9: Run the new test and confirm it passes**

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
Expected: all tests pass, including `'reports a call rooting in a module-level class declaration'`.

- [ ] **Step 10: Prove the fixture bites — disable class/enum binding, confirm red**

Locate:

```ts
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      declare(statement.name, local);
    }
```

Temporarily remove the two disjuncts:

```ts
    if (
      ts.isFunctionDeclaration(statement)
    ) {
      declare(statement.name, local);
    }
```

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
Expected: FAIL — exactly one test red, `'reports a call rooting in a module-level class declaration'`, with the actual result showing only `${FIXTURE} ${GUARD} makes no ${WALK} call'` (`CensusWalk` is never added to `bindings`, so the call passes silently).

Record the exact failure text, then restore both disjuncts and re-run to confirm all tests green:

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
Expected: all tests pass.

- [ ] **Step 11: Document the two accepted blind spots in the header docblock**

Locate the "WHAT IT DOES NOT SEE" paragraph (currently lines 35-45):

```ts
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
 * one hides the refactor this file exists to catch.
```

Append two sentences (staying inside the same paragraph — do not start a new `*` block):

```ts
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
 * one hides the refactor this file exists to catch. Two narrower gaps are
 * accepted rather than closed (#492): `import x = SomeNamespace.Member`, the
 * internal-namespace form of an import-equals declaration (as against the
 * `require(...)` form fixtured below), is legacy syntax with no use anywhere
 * in this codebase; and a walk hoisted into a `namespace N { export function
 * walk() {...} }` and called as `N.walk()` resolves to no binding at all, but
 * degrades loud rather than silent — the body then makes no `readdirSync`
 * call, and the missing-walk arm above already reports that.
```

- [ ] **Step 12: Run the full three-file suite**

Run: `npx vitest run --project unit src/lib/db-locks-verdict-census.test.ts src/lib/probe-placement-census.test.ts src/lib/census-walk-independence.test.ts`
Expected: all tests pass (67 tests: the original 64 plus the 3 new fixtures added in this task).

- [ ] **Step 13: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 14: Commit**

```bash
git add src/lib/census-walk-independence.test.ts
git commit -m "$(cat <<'EOF'
test(census): close three binding-collection blind spots in areasUnderSrc's independence predicate (#492)

rootOf now resolves a `new X().method()` root by descending through a
NewExpression the same way it already descends property/element access
chains. Two more arms (default-import binding, class/enum declaration
binding) already had correct code in moduleLevelBindings with no fixture
proving it — each is now fixtured and mutation-proven. Two remaining
arms (import-equals internal-namespace form, namespace/module
declaration binding) are documented as accepted blind spots instead:
one is legacy syntax with no use in this codebase, the other degrades
loud (the missing-readdirSync-call arm still fires) rather than silent.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Tether the census's `reached` side to `censusOfTree`, not a second walk

**Files:**
- Modify: `src/lib/census-walk-independence.test.ts`

**Interfaces:**
- Consumes: `unwrap`, `rootOf` (as fixed by Task 1), `moduleLevelBindings`, `Binding`, `Checked`, `root`, `CENSUS_DIR`, `KNOWN_CENSUS_FILES`, `FIXTURE` — all defined earlier in the file, unchanged by this task except as noted below.
- Produces: `reachedIn(source: ts.SourceFile): ts.Expression | undefined`, `reachedIndependenceOf(file: string, text: string): readonly string[] | undefined`, `reachedCensusFiles(): readonly Checked[]` — new, used only within this file.

- [ ] **Step 1: Add the `REACHED` and `CENSUS` constants**

Locate the `WALK` constant (currently lines 76-77):

```ts
/** The call its body must still make, so an emptied-out guard is not "clean". */
const WALK = 'readdirSync' satisfies keyof typeof import('node:fs');
```

Insert immediately after:

```ts
/** The local this file's second invariant holds to independence (#492). */
const REACHED = 'reached';

/** The one call `REACHED`'s initializer must make — the census's own consumed list. */
const CENSUS = 'censusOfTree';
```

- [ ] **Step 2: Add `reachedIn`, the discovery function**

Locate `guardIn` (currently lines 197-216, ending with its closing `}`), immediately followed by the `independenceOf` docblock and function. Insert a new function between them:

```ts
/**
 * The initializer of the file's one `const reached = …;` declaration, found
 * by a full recursive walk rather than `guardIn`'s module-level-only one —
 * `reached` lives inside the scope-reach assertion's `it(...)` callback, not
 * at module level. `undefined`, as against finding one with a clean
 * initializer, when the file declares no such name — the same distinction
 * `guardIn`'s absence keeps for `independenceOf`.
 */
function reachedIn(source: ts.SourceFile): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === REACHED &&
      node.initializer !== undefined
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
```

- [ ] **Step 3: Add `reachedIndependenceOf`, the check function**

Locate `independenceOf` (currently lines 218-255, ending with its closing `}`), immediately followed by the `Checked` interface. Insert a new function between them:

```ts
/**
 * What `REACHED`'s initializer reaches apart from `CENSUS`, with a
 * missing-`CENSUS`-call finding last — the same two-direction shape
 * `independenceOf` uses for `GUARD`, reusing `rootOf` and
 * `moduleLevelBindings` so a call reaching a forbidden name through a local
 * alias (`const s = searchScope; …s()…`) is caught the same way it already is
 * for `GUARD`.
 *
 * `undefined`, as against an empty list, when the file declares no `REACHED`.
 */
function reachedIndependenceOf(file: string, text: string): readonly string[] | undefined {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const initializer = reachedIn(source);
  if (initializer === undefined) return undefined;

  const bindings = moduleLevelBindings(source);
  const findings: string[] = [];
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
  visit(initializer);

  if (!sawCensus) findings.push(`${file} ${REACHED} makes no ${CENSUS} call`);
  return findings;
}
```

- [ ] **Step 4: Add `reachedCensusFiles`, the memoised per-file discovery**

Locate `censusFiles` (currently lines 268-278, ending with its closing `});`), immediately followed by the `describe('every scope-reach guard reads the tree for itself', ...)` block. Insert a new memoised function between them:

```ts
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
```

- [ ] **Step 5: Add the `reached` discovery-and-check `describe` block**

Locate the end of `describe('every scope-reach guard reads the tree for itself', ...)` (currently lines 280-299, ending with its closing `});`), immediately followed by the `FIXTURE` constant and the "against sources this repository does not contain" section. Insert a new `describe` block between them:

```ts
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
```

- [ ] **Step 6: Run against the real census files and confirm green**

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
Expected: all tests pass, including the two new tests from Step 5 — both real census files' `reached` lines already read `new Set(censusOfTree().filesCensused.map(areaOf))`, so `reachedIndependenceOf` returns `[]` for both.

- [ ] **Step 7: Prove it bites — revert `db-locks-verdict-census.test.ts`'s `reached` line, confirm red**

In `src/lib/db-locks-verdict-census.test.ts`, locate:

```ts
    const reached = new Set(censusOfTree().filesCensused.map(areaOf));
```

Temporarily change it to:

```ts
    const reached = new Set(searchScope().map(areaOf));
```

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
Expected: FAIL — `'finds no `reached` reaching past the census itself'` red, with the actual result including `src/lib/db-locks-verdict-census.test.ts:490 reached calls searchScope — searchScope is declared at module level` and `src/lib/db-locks-verdict-census.test.ts reached makes no censusOfTree call`.

Record the exact failure text, then restore the original line in `src/lib/db-locks-verdict-census.test.ts` and re-run:

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts src/lib/db-locks-verdict-census.test.ts`
Expected: all tests pass.

- [ ] **Step 8: Add the fixture-side `describe` block for the `reached` rule**

At the end of the file (after the existing `describe('the rule, against sources this repository does not contain', ...)` block's closing `});`), append:

```ts

/**
 * The `reached` rule above, against sources this repository does not
 * contain. Parsed the same way `independenceOf`'s own fixtures are, and for
 * the same reason: the two real census files hold one shape each — the
 * healthy one — so a predicate that has never reported anything here is
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

  it('reports a missing census call with no forbidden call alongside it', () => {
    // The two directions are separable: nothing here roots in a module-level
    // binding at all, so only the missing-call finding fires.
    expect(reachedIndependenceOf(FIXTURE, reachedSource('new Set([].map(areaOf))'))).toEqual([
      `${FIXTURE} ${REACHED} makes no ${CENSUS} call`,
    ]);
  });

  it('finds nothing at all, as against nothing wrong, where no `reached` is declared', () => {
    expect(reachedIndependenceOf(FIXTURE, REACHED_PREAMBLE)).toBeUndefined();
  });
});
```

Every expected finding string and line number above (`:14`, `:16`) was verified by running the real `reachedIndependenceOf` logic against this exact fixture text before this plan was written — they are not guesses.

- [ ] **Step 9: Run and confirm all five new fixture tests pass**

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
Expected: all tests pass, including the five tests added in Step 8.

- [ ] **Step 10: Prove the forbidden-call fixture bites**

Temporarily change `reachedIndependenceOf`'s condition from:

```ts
      if (
        rootName !== undefined &&
        rootName !== CENSUS &&
        binding !== undefined &&
        !binding.fromNodeBuiltin
      ) {
```

to:

```ts
      if (false) {
```

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
Expected: FAIL — two tests red: `'reports a reach into a second, independent walk'` and `'reports the same reach through a local alias'`, each missing its forbidden-call finding from the actual result (only the `makes no censusOfTree call` finding survives in each).

Record the exact failure text, then restore the original condition and re-run to confirm green:

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
Expected: all tests pass.

- [ ] **Step 11: Prove the missing-required-call fixture bites**

Temporarily change:

```ts
  if (!sawCensus) findings.push(`${file} ${REACHED} makes no ${CENSUS} call`);
```

to:

```ts
  if (false) findings.push(`${file} ${REACHED} makes no ${CENSUS} call`);
```

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
Expected: FAIL — three tests red: `'reports a reach into a second, independent walk'`, `'reports the same reach through a local alias'`, and `'reports a missing census call with no forbidden call alongside it'`, each missing its `makes no censusOfTree call` finding.

Record the exact failure text, then restore the original line and re-run to confirm green:

Run: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
Expected: all tests pass.

- [ ] **Step 12: Update the header docblock**

Locate the title line (currently line 2):

```ts
 * THE SCOPE-REACH GUARDS MUST KEEP READING THE TREE FOR THEMSELVES (#489).
```

Replace with:

```ts
 * THE SCOPE-REACH GUARDS MUST KEEP READING THE TREE FOR THEMSELVES (#489, #492).
```

Locate the "WHAT IT ASSERTS" paragraph (currently lines 22-28):

```ts
 * WHAT IT ASSERTS. Inside `areasUnderSrc`, every callee that roots in a
 * module-level binding must root in an import from a `node:` specifier, and a
 * `readdirSync` call must be present. "Roots in" means the bare identifier of
 * an identifier callee, or the leftmost identifier of a property- or
 * element-access callee. That is deliberately wider than "does not call the
 * walk by name", which a rename defeats and which the refactor actually feared
 * — hoisting the walk into another module — walks straight past.
```

Insert a new paragraph immediately after it (before "WHICH FILES"):

```ts
 * WHAT IT ASSERTS. Inside `areasUnderSrc`, every callee that roots in a
 * module-level binding must root in an import from a `node:` specifier, and a
 * `readdirSync` call must be present. "Roots in" means the bare identifier of
 * an identifier callee, or the leftmost identifier of a property- or
 * element-access callee. That is deliberately wider than "does not call the
 * walk by name", which a rename defeats and which the refactor actually feared
 * — hoisting the walk into another module — walks straight past.
 *
 * WHAT IT ALSO ASSERTS (#492). Each census file's `reached` — what the
 * scope-reach assertion compares `areasUnderSrc` against — must be built from
 * the census's own consumed-file list. Its initializer (the file's one
 * `const reached = …` declaration, wherever it sits — inside the assertion's
 * `it(...)` callback, not at module level) must call `censusOfTree`, and any
 * other call rooting in a module-level binding is a finding: that is what
 * catches a revert to a second, independent read of `searchScope()` or
 * `typeScriptUnderSrc()`, aliased or not.
```

Locate the "WHICH FILES" paragraph (currently lines 30-33):

```ts
 * WHICH FILES, discovered rather than written down: every `src/lib/*.test.ts`
 * declaring `areasUnderSrc` at module level. A third census file joins on its
 * own. `KNOWN_CENSUS_FILES` is the floor under that discovery, because a
 * discovery finding nothing would otherwise certify nothing.
```

Replace with:

```ts
 * WHICH FILES, discovered rather than written down: every `src/lib/*.test.ts`
 * declaring `areasUnderSrc` at module level, and separately, every
 * `src/lib/*.test.ts` declaring a `reached` variable anywhere in its text — a
 * third census file joins either discovery on its own, or both.
 * `KNOWN_CENSUS_FILES` is the floor under both, because a discovery finding
 * nothing would otherwise certify nothing.
```

Locate the end of the "WHAT IT DOES NOT SEE" paragraph, as Task 1 left it (ending "...and the missing-walk arm above already reports that."). Append one more sentence to the same paragraph:

```ts
 * one hides the refactor this file exists to catch. Two narrower gaps are
 * accepted rather than closed (#492): `import x = SomeNamespace.Member`, the
 * internal-namespace form of an import-equals declaration (as against the
 * `require(...)` form fixtured below), is legacy syntax with no use anywhere
 * in this codebase; and a walk hoisted into a `namespace N { export function
 * walk() {...} }` and called as `N.walk()` resolves to no binding at all, but
 * degrades loud rather than silent — the body then makes no `readdirSync`
 * call, and the missing-walk arm above already reports that. The `reached`
 * tether below reuses this same root resolution, so it shares every blind
 * spot above: a callee rooting in a parameter or a function-local, and the
 * two narrower accepted gaps, apply there too.
```

- [ ] **Step 13: Run the full three-file suite**

Run: `npx vitest run --project unit src/lib/db-locks-verdict-census.test.ts src/lib/probe-placement-census.test.ts src/lib/census-walk-independence.test.ts`
Expected: all tests pass (74 = 67 from the end of Task 1 + 2 from Step 5 + 5 from Step 8).

- [ ] **Step 14: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 15: Commit**

```bash
git add src/lib/census-walk-independence.test.ts
git commit -m "$(cat <<'EOF'
test(census): tether the reached side of the scope-reach guard to censusOfTree (#492)

areasUnderSrc's independence was tethered by #489; the census's own
reached — what that guard's expectation is compared against — had no
equivalent protection. Reverting either census file's reached line back
to a second, independent searchScope() call left the whole suite green.

A sibling predicate closes it: reachedIn discovers the file's one
`const reached = …` declaration by a recursive walk (it lives inside an
it(...) callback, not at module level, so guardIn's module-level-only
discovery can't find it), and reachedIndependenceOf reuses rootOf and
moduleLevelBindings to require a call to censusOfTree and forbid any
other call rooting in a module-level binding — including through a
local alias, the same way the existing predicate already catches that
shape for areasUnderSrc.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Post-implementation: whole-branch review

This plan has 2 tasks touching the same file's shared docblock — after both are complete, run one whole-branch review (on the most capable model available) covering the full diff of `src/lib/census-walk-independence.test.ts` against `origin/main`, looking specifically for:

- Cross-task blindness: does Task 2's docblock edit (Step 12) correctly build on Task 1's docblock edit (Step 11), with no stale wording left from either?
- Does the new `reached`-tether predicate (Task 2) actually get exercised against the two real census files, not only against synthetic fixtures? (Step 6/7 exercise this — confirm the reviewer checks it.)
- Any comment anywhere in the diff making a claim wider than this file, per *Comment Discipline*.

Apply one fix wave for whatever the review finds, then one scoped re-review of just the fixed spots, before pushing and opening the PR.
