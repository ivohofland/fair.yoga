# Seeing a `reached` declared in any shape, not just `const reached = …` (#499)

`reachedIn` (`src/lib/census-walk-independence.test.ts`) discovers a census
file's `reached` by matching a `VariableDeclaration` whose `name` is the bare
identifier `reached` **and** whose `initializer` is present in the same
statement. Declarations outside that match are invisible to
`reachedIndependenceOf`, which answers `undefined` for them — the same answer it
gives for a file declaring no `reached` at all.

Nothing in the repository is wrong today, and no production code is touched.
Every file this changes is a `.test.ts`.

## The premise, verified

Measured on this branch's base, `origin/main` at `bdc5213b`. Baseline for
`src/lib/census-walk-independence.test.ts`: **25 tests, all green**.

Method for rows 1–4 and 8: the file was copied verbatim to a scratch `.mts`,
its `vitest` import replaced with no-op `describe`/`it`/`expect` so the suites
never run, and `reachedIn`/`reachedIndependenceOf` exported — so the **real**
predicate bodies ran against synthetic sources. No repository file was changed
for those rows.

| # | Claim | Measured | Verdict |
|---|---|---|---|
| 1 | `reachedIndependenceOf` returns `undefined` for `let reached;` assigned in a later `if`/`else` | `undefined` | holds |
| 2 | …and `undefined` for `const { reached } = buildReachedSet();` | `undefined` | holds |
| 3 | Both are indistinguishable from a file declaring no `reached` | both `undefined`, exactly as for a source with no `reached` at all | holds |
| 4 | Control — the matched shape with the same dirty body is caught | two findings, `… reached calls searchScope …` and `… reached makes no censusOfTree call` | holds |
| 5 | Nothing in `db-locks-verdict-census.test.ts` or `probe-placement-census.test.ts` is affected | AST sweep of every `src/lib/*.test.ts` for a binding named `reached` in **any** shape (identifier ± initializer, binding element, parameter, function/class declaration) found exactly **2** hits — `db-locks-verdict-census.test.ts:490` and `probe-placement-census.test.ts:486`, both identifier-with-initializer | holds |
| 6 | The gap lets the #472/#489/#492 regression back in "through a different syntactic door" | **Incomplete.** For a file on `KNOWN_CENSUS_FILES` it does **not**: rewriting db-locks' `reached` to a bare `let` assigned a dirty `searchScope()` walk reds the discovery test — `knownFilesNotDeclaringIt: ["src/lib/db-locks-verdict-census.test.ts"]`, `atLeastTwoDeclareIt: false`. The floor catches it. | **refined** — see below |
| 7 | The gap is nonetheless a live silent bypass | **Yes, for a file off the roster.** A synthetic third census file (`src/lib/zz-third-census.test.ts`) building `reached` from an independent `readdirSync` walk behind `let reached;` left the suite at **25/25 green**. The identical file with the one-line change to `const reached = new Set(searchScope().map(areaOf))` reds with `zz-third-census.test.ts:12 reached calls searchScope …`. Only the declaration shape differed. | proven |
| 8 | *(not in the issue)* `for (const reached of xs)` is a **third** unmatched shape | `undefined` | new finding |
| 9 | *(not in the issue)* `census-walk-independence.test.ts` binds no `reached` in any shape as real code | the same AST sweep found **0** hits in it; its three `const reached = …` occurrences are inside fixture string literals, which are not this file's syntax | holds — and see *Self-exclusion* below |

### What row 6 changes about the design

The issue's framing — "silently dropped from `reachedCensusFiles()`'s discovered
set" — is right about the *set* and wrong about the *consequence* for the two
files that exist today. `KNOWN_CENSUS_FILES` is the floor precisely for this:
a listed file that stops being discovered is reported by name.

Two things survive that, and they are what this issue is actually about:

1. **A third census file** — which the header docblock explicitly anticipates
   ("a third census file joins either discovery on its own, or both") — never
   joins the discovered set, `atLeastTwoDeclareIt` stays satisfied by the
   original two, and `knownFilesNotDeclaringIt` stays empty. Row 7 proves this
   end to end.
2. **The diagnosis is misleading even where it fires.** `knownFilesNotDeclaringIt`
   reads as "this file no longer declares `reached`", sending a maintainer to
   look for a deleted variable that is in fact right there, three lines down.

## The three options the issue names

| | Approach | Verdict |
|---|---|---|
| **A** | Widen `reachedIn` to correlate `let reached;` with the `reached = …` assignment expressions that follow it | **Declined.** Deciding *which* `reached` an assignment targets — across an `if`/`else`, a loop, or a nested function that shadows the name — is scope resolution, and this file deliberately builds no type-checker program (its docblock names that as its one accepted blind spot). An approximation here would be a new source of quiet wrong answers in the predicate whose whole job is not giving them. |
| **B** | Widen to the destructured `const { reached } = …` form | **Taken.** Cheap and sound: the expression that produces `reached` is the declaration's own initializer, and walking it needs no scope resolution. |
| **C** | Treat a `reached` with no same-statement initializer as a finding | **Taken.** Same precedent as `censusDeclarationCount` (PR #498): a name whose meaning became ambiguous is reported loudly rather than trusted quietly. Its cost — a `reached` must keep its initializer in its own statement — is named by the failure message and fixed by one line. |

B and C are not alternatives; each covers a shape the other does not. Taken
together they close both shapes the issue names *and* the for-of shape row 8
found, because what actually fixes all three is neither B nor C but the
restructuring both require.

## The design

### The root defect: discovery and evaluation are one answer

`reachedIn` returns `readonly ts.Expression[]`, and `reachedIndependenceOf`
reads `initializers.length === 0` as "this file declares no `reached`". That
one expression carries two different meanings:

- the file binds no such name anywhere, and
- the file binds it in a shape that produced no initializer to collect.

Every shape in this issue is the second meaning being reported as the first.
Widening the *match* one shape at a time leaves that conflation in place for
the next shape. Separating the two answers closes all of them, including
shapes nobody has written yet.

### 1. `reachedIn` → `reachedDeclarationsIn`, returning declarations

Renamed, because its return type changes meaning: it now answers *which
declarations bind this name*, not *which initializers were collected*. Both
call sites re-read as a consequence.

```ts
function bindsReached(target: ts.BindingName): boolean;
function reachedDeclarationsIn(source: ts.SourceFile): readonly ts.VariableDeclaration[];
```

`bindsReached` recurses through a binding pattern the same way
`moduleLevelBindings`'s own `declare` already does — `ts.isIdentifier` for the
bare case, otherwise `elements.some(… ts.isBindingElement …)`. That guard is
what makes one recursion serve `ObjectBindingPattern`, `ArrayBindingPattern`
(whose elements may be `OmittedExpression`), nesting to any depth, and the
rest form `const { ...reached } = x`.

A declaration is collected whether or not it has an initializer. The
`initializer !== undefined` test moves out of discovery and into evaluation,
where the two meanings can be told apart.

**Deliberately not collected:** a parameter, a `function`, or a `class` named
`reached`. `reached` in these files is a set of areas built from a census; none
of those three forms is one, and none can carry an initializer expression to
check.

### 2. `reachedIndependenceOf` branches per declaration

For each collected declaration:

- **No initializer** → one finding, and no walk:
  `` `${file}:${line} ${REACHED} is declared with no initializer of its own — nothing here can see what it is assigned` ``
  The missing-`censusOfTree` finding is deliberately **not** also emitted: the
  declaration may well be assigned from `censusOfTree` later, so claiming it
  makes no such call would be asserting something this file cannot know.
- **With an initializer** → walk the **whole `VariableDeclaration`** rather
  than only `declaration.initializer`. For the plain `const reached = …` shape
  the two are identical (the remaining children are an `Identifier` and an
  optional type node, neither of which can hold a `CallExpression`), so no
  existing fixture moves. For a destructured one it additionally covers the
  source expression, a binding element's default (`{ reached = fallback() }`),
  and a computed property key.

Findings keep reporting the **call expression's** line, not the declaration's,
so existing expectations are unchanged.

`undefined` — as against `[]` — still means "this file binds no `reached` at
all", and now means only that.

### Consequence: a for-of binding is reported

`for (const reached of xs)` is a `VariableDeclaration` with no initializer, so
it lands on the ambiguity finding. That is a behaviour change on a shape the
issue did not name, it degrades loud, and its blast radius today is zero (row
5). It gets its own fixture so it is pinned behaviour rather than an accident.

### Self-exclusion, whose margin gets thinner

The header docblock records that this file stays out of its own `REACHED`
discovery because it declares no such variable at any depth. Widening
discovery narrows that margin: a `let reached;`, a `const { reached } = …`, or
a `for (const reached of …)` written anywhere in this file would now also join
its own discovered set and red its own assertion. The implementation must not
introduce the name in any form, and the docblock paragraph must say so.

### Docblock edits

Every claim about the old match has to move, not just the one the issue names:

| Where | Change |
|---|---|
| "WHAT IT ALSO ASSERTS (#492)", `` Every `const reached = …` declaration `` | State the widened rule: every declaration **binding** the name, in any shape, and a declaration with no initializer of its own being a finding. |
| "`reachedIn` ALSO DOES NOT SEE …" (the paragraph the issue points at) | **Replaced**, not annotated — it describes a gap that no longer exists. Per this project's Comment Discipline, "this previously read X" belongs in the PR body. |
| "THIS FILE STAYS OUT OF BOTH CENSUSES" | Widen the `REACHED` self-exclusion sentence to the shapes now discovered, and keep the "thinner margin" warning accurate. |
| `reachedIn`'s own docblock | Rewritten for the renamed function and the declarations-not-initializers return. |
| `reachedIndependenceOf`'s docblock | The `undefined` paragraph, and the new per-declaration branch. |

`docs/` needs no entry: every claim here annotates the file it sits in.

## Acceptance

Per the issue, and per this project's standard for a guard: each new fixture is
proven by mutation — the code path it exercises removed, the exact RED recorded,
restored, re-verified GREEN — and each mutation reddens **that** fixture and no
other.

Fixtures to add (all in the existing `the reached rule, against sources this
repository does not contain` suite):

1. `let reached;` assigned in a later `if`/`else` — the #472/#489/#492
   regression through this door. Expect exactly the ambiguity finding.
2. `const { reached } = buildReachedSet();` — expect the reach finding for
   `buildReachedSet` plus the missing-`censusOfTree` finding.
3. A clean destructured `reached` whose declaration does call `censusOfTree` —
   expect `[]`. This is what keeps fixture 2 from passing for the wrong reason
   (a blanket flag on every destructured shape).
4. A nested/array binding pattern — pins `bindsReached`'s recursion past one
   level.
5. `for (const reached of …)` — pins the row-8 consequence.

Plus the standing regression checks: the two real census files still report
`[]`, `KNOWN_CENSUS_FILES` still discovers both, and the AST sweep from row 9
still finds zero `reached` bindings in `census-walk-independence.test.ts`
itself.

## Not in scope

- `src/lib/db-locks-verdict-census.test.ts` and
  `src/lib/probe-placement-census.test.ts` are not touched (row 5).
- The `GUARD` side. `guardIn` has a structurally similar shape restriction —
  it reads module-level statements only, so `let areasUnderSrc; areasUnderSrc =
  () => …` would drop out too — but `KNOWN_CENSUS_FILES` is the floor there
  exactly as it is here, and no evidence was gathered that the shape is
  reachable in practice. Out of scope, and not filed: it is the same debt this
  issue is closing on the other side, and filing it would be filing a
  hypothetical.
- **#492 is unaffected.** This narrows a gap in the predicate #492 added; it
  changes nothing about what #492 itself closed.
