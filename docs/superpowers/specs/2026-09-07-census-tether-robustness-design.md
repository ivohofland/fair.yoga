# Closing #492's two robustness gaps in the census-scope-tethers guards

Two clusters left open by #489/PR #491's review, both inside
`src/lib/census-walk-independence.test.ts` (item 1) or the predicate it holds
(item 2). Both are about the guard's own robustness against a future refactor —
nothing in the repository is wrong today, and no production code is touched by
either fix.

## The premise, verified

Measured on this branch's base, `origin/main` at `eb1028b7`. Baseline: 3 files,
64 tests passing (`db-locks-verdict-census.test.ts`,
`probe-placement-census.test.ts`, `census-walk-independence.test.ts`).

| # | The issue's claim | Measured | Verdict |
|---|---|---|---|
| 1 | Reverting `reached` to `new Set(searchScope().map(areaOf))` in db-locks leaves the whole suite green | `64 passed` | holds |
| 2a | `new Walker().readdirSync()`, `Walker` imported from a non-`node:` module, produces zero findings | `rootOf` returns `undefined` for a `NewExpression` root (confirmed via a standalone script running the real `rootOf` against a synthetic source) | holds |
| 2b | Removing `declare(clause.name, binding)` (default-import binding) leaves all 12 `census-walk-independence.test.ts` tests green | `12 passed` | holds |
| 2c | Removing the `isClassDeclaration \|\| isEnumDeclaration` disjuncts leaves all 12 tests green | `12 passed` | holds |

Both files still hold their `reached` line at the location the issue names
(db-locks `:490`, probe-placement `:486`), and both still read
`new Set(censusOfTree().filesCensused.map(areaOf))` — the fix from #489, not
yet tethered. `git log` on the three files confirms `2d32985d` (PR #491's
review fix wave) is the most recent touch; nothing since has closed either
gap.

## 1. Tether the `reached` side the same way #489 tethered `areasUnderSrc`

### The gap

`census-walk-independence.test.ts` discovers and checks exactly one thing per
census file: the body of a module-level function or variable named
`areasUnderSrc`. Nothing checks how `reached` is built. `reached` is a local
inside an anonymous `it(...)` callback — not a module-level declaration — so
`guardIn`'s discovery (which walks only `source.statements`, looking for a
`FunctionDeclaration` or `VariableStatement` matching a name) cannot find it
without a second traversal shape, which is exactly the "second discovery
mechanism bolted onto the first" the issue warns against building carelessly.

### The decision

**A sibling predicate in the same file, discovered by its own recursive walk,
sharing the low-level AST helpers (`unwrap`, `rootOf`, `moduleLevelBindings`)
but not `guardIn`/`independenceOf` themselves.**

Discovery: a recursive walk (`ts.forEachChild`, not `source.statements`-only)
for a `VariableDeclaration` named `reached` — deliberately name-based, the same
style as `GUARD`/`WALK`, and safe here because grep confirms exactly one
`reached` declaration exists in each known census file, nowhere else in either
file's text.

Predicate over the initializer, reusing `moduleLevelBindings` + `rootOf` (not
duplicating them, since aliasing a forbidden call through a local variable —
`const s = searchScope; …s()…` — must still be caught, the same way
`independenceOf` already catches that shape for `GUARD`):

- Every call whose root resolves to a module-level binding that is **not**
  `censusOfTree` is a finding — this is what catches `searchScope()`,
  `typeScriptUnderSrc()`, or an aliased reach through either.
- A call resolving to `censusOfTree` must be present at least once — this is
  what stops the check passing vacuously on a `reached` computed from nothing
  at all.

Rejected: matching by the enclosing `it(...)`'s title string. A wording edit
to the test name would silently drop the tether, the same failure mode
`KNOWN_CENSUS_FILES` exists to prevent for `GUARD` — and the file already has
an unambiguous, more specific anchor (`reached` occurs exactly once per file,
grep-verified).

Rejected: hardcoding a hoisted `filesCensused()` helper both `reached` and
`censusOfTree` call. Named explicitly as rejected in the #489 spec for the
same reason it applies here — it reproduces the seam one level further out.

### Non-vacuity

Same three failure modes #489 named for `GUARD`, answered the same way:

1. **`reached` renamed or removed** → reported as "declares no `reached`"
   rather than silently finding zero violations. The existing
   `KNOWN_CENSUS_FILES` floor (already requires both known files to declare
   `GUARD`) is extended to require both to declare `reached` too, in the same
   assertion, so a failure names which invariant a file dropped.
2. **The predicate itself dead** → fixtures inside this file, parsed the same
   way as the `GUARD` fixtures: the clean case, the forbidden-call case
   (`searchScope`), the missing-required-call case, and the aliased-forbidden-call
   case.

### What changes about the docblock

The header docblock's "WHAT IT ASSERTS" paragraph currently describes one
invariant (`areasUnderSrc`'s independence). It gains a second paragraph
describing this one — replaced/extended, not annotated with what it used to
say. The opening paragraph's "the checking side does its own `readdirSync`"
sentence stays true only for `GUARD`; the new paragraph states the `reached`
side's own shape (must consume the census's own list, must not re-walk).

### Acceptance

A revert of either census file's `reached` line to
`new Set(searchScope().map(areaOf))` reddens this file's new assertion, naming
the reverted file. Failure text recorded, reversed, re-verified green.

## 2. Close three of the five unexercised binding-collection arms; document two

### 2a. `new X().method()` roots — a genuine detector gap, closed

`rootOf` walks `PropertyAccessExpression`/`ElementAccessExpression` chains
looking for an `Identifier` root. A `NewExpression` breaks the chain: it is
neither of those two kinds, so the loop stops on it and
`ts.isIdentifier(current)` is false. `new Walker().readdirSync()` is
therefore invisible however `Walker` is bound.

**Fix `rootOf` to also unwrap a `NewExpression`:**

```ts
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

All three node kinds expose `.expression` as the thing to descend into, so the
loop body is unchanged — only the condition gains a disjunct. `new Walker()`
resolves to the identifier `Walker`, which then flows through the existing
`bindings.get(rootName)` lookup unchanged: an imported `Walker` from a
non-`node:` module is a finding, exactly like every other root today.

This is a change to production-of-the-test-guard code (not application code),
proven by mutation like every other arm: revert the added disjunct, and the
new fixture goes red.

**Rejected: leaving this as a documented blind spot.** Unlike the two arms
below, this one is not "code exists, untested" — it is a live gap in the
walk-chasing logic, sitting immediately next to the two chains
(`PropertyAccessExpression`, `ElementAccessExpression`) it already handles.
Leaving it undocumented-and-unfixed would mean the fixed-vs-accepted split
below misrepresents it as a considered trade-off rather than a plain gap.

### 2b. Default-import binding — code exists, fixture it

`moduleLevelBindings`'s `declare(clause.name, binding)` already binds a
default import's local name. No fixture exercises the "should flag" direction
(`import walk from './census-walk'; walk()`) — only the `import path from
'node:path'` clean cases exist today, and mutation-testing this line leaves
all 12 tests green.

**Fixture it**, mirroring the existing named-import-hoist fixture
(`reports a walk hoisted into another module and imported by name`) but with
a default import:

```ts
const preamble = `
import walk from './census-walk';
`;
```

Same body shape, same finding shape. Proven by commenting out
`declare(clause.name, binding)` and confirming the new fixture (not a
different one) goes red; reversed, re-verified green.

### 2c. Class/enum declaration binding — code exists, fixture it

`moduleLevelBindings` already declares a name bound by
`ts.isClassDeclaration || ts.isEnumDeclaration`. No fixture exercises calling
a static method off a module-level class (`class CensusWalk { static
walk() {...} } … CensusWalk.walk()`), and removing the two disjuncts leaves
all 12 tests green.

**Fixture it**, in the same style: a class declared at module level with a
static method whose body is `OWN_WALK`'s `readdirSync` call, called as
`CensusWalk.walk()`. Proven by removing the disjuncts and confirming the new
fixture goes red; reversed, re-verified green.

### 2d / 2e. Import-equals internal-namespace form, `ts.ModuleDeclaration` binding — documented, not fixtured

Both rated Suggestion-level by the reviewing agents, and both fail differently
from the three above:

- **`import x = SomeNamespace.Member`** (the internal-namespace form of import-equals,
  as against the already-fixtured `require(...)` form) is legacy TypeScript
  syntax with no use anywhere in this ESM codebase. A fixture here buys
  protection against a refactor shape nobody is going to write.
- **`namespace N { export function walk() {...} }`** bound and called as
  `N.walk()` is not silently invisible the way the three fixed arms were: the
  call's root (`N`) resolves to nothing in `bindings`, so it is not flagged as
  a forbidden reach — but the body then makes no `readdirSync` call, and the
  existing "makes no `readdirSync` call" arm already fires. It degrades loud,
  not silent, which is a materially different risk than the three closed
  above.

**Decision: document both in the docblock's "WHAT IT DOES NOT SEE" paragraph,
not fixtured.** Per *Comment Discipline*'s stated preference order ("if the
risk is that someone reintroduces the error, add a test or a tether; if
neither is possible, one line stating the constraint") — here the risk is low
enough on both counts (dead syntax; loud degradation) that a fixture's
maintenance cost is not earned. The paragraph gains two sentences naming these
two shapes and why each is accepted rather than closed, replacing nothing
(the paragraph is additive — the arms it already names, parameter-rooted
callees and regex-literal callees, stay accurate).

### Task order

**Task 1 (item 2) before Task 2 (item 1).** Item 1's new predicate reuses
`rootOf` and `moduleLevelBindings`. Doing item 2 first means item 1 is written
against the corrected `rootOf` (post-`NewExpression` fix) rather than being
written first and having its assumptions about `rootOf`'s completeness
shift under it. The two items touch non-overlapping regions of the file
(item 2: `rootOf`, `moduleLevelBindings`, the existing fixture suite; item 1:
a new predicate, new fixtures, `KNOWN_CENSUS_FILES`'s assertion, the header
docblock) except the header docblock, which item 1 edits last and so is
written against item 2's finished state.

## What this does not do

- It does not touch `db-locks-verdict-census.test.ts` or
  `probe-placement-census.test.ts` — both gaps are closed entirely inside
  `census-walk-independence.test.ts`, matching #489's original decision that
  this file is the one place cross-census invariants live.
- It does not fixture the two accepted blind spots (2d, 2e) — documented
  instead, per the decision above.
- It does not change what either scope-reach guard's own two assertions
  (`areasTheCensusMisses` / `areasTheGuardMisses`) compare — only what
  independently checks that the values feeding them were built the way their
  comments claim.
- It adds no production code. Every file it touches is a test.
