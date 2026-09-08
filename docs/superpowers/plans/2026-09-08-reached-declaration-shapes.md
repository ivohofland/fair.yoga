# Plan — seeing a `reached` declared in any shape (#499)

Spec: `docs/superpowers/specs/2026-09-08-reached-declaration-shapes-design.md`.
Read it first; it carries the measured premise, the option analysis, and the
exact finding strings.

Every change is inside `src/lib/census-walk-independence.test.ts`. No production
code, no other file. Baseline on `origin/main` at `bdc5213b`: that file has
**25 tests, all green**.

**Task order is load-bearing.** Task 2's docblock rewrite has to describe the
code Task 1 lands, and Task 2's for-of fixture pins a consequence that only
exists once Task 1's restructure is in.

## Standing constraints for both tasks

- **Never write the identifier `reached` as a real binding in this file.** Not
  `let reached;`, not `const { reached } = …`, not `for (const reached of …)`,
  not a parameter. After Task 1 the file's own discovery sees all of those, so
  one would put this file into its own checked set and red its own assertion.
  The name may appear only in prose, as the `REACHED` constant, and inside
  fixture source **strings**. Verify with the AST sweep in Task 2.
- **Every fixture is proven by mutation** (`.claude/skills/solve-issue`, §3):
  remove or disable the code path the fixture exercises, run the file, record
  the **exact** RED output, restore, re-run, confirm GREEN. A mutation must red
  the fixture it targets and no other; say so explicitly, naming the other
  tests that stayed green.
- Fast loop: `npx vitest run --project unit src/lib/census-walk-independence.test.ts`
  from the worktree root.
- This worktree has no dev server and no database, so `integration` and `e2e`
  cannot run here. Scope local verification to `typecheck`, `lint`, and the
  `unit` + `components` projects. CI is the signal for the rest.

---

## Task 1 — separate discovery from evaluation

### Behaviour to reach

`reachedIndependenceOf` must tell three states apart, where today it tells two:

| Source | Today | After |
|---|---|---|
| binds no `reached` anywhere | `undefined` | `undefined` (unchanged) |
| `const reached = <expr>` | findings for `<expr>` | unchanged |
| `let reached;` (assigned later or not) | `undefined` | one ambiguity finding |
| `const { reached } = <expr>` | `undefined` | findings for the whole declaration |

### Changes

1. **Add `bindsReached(target: ts.BindingName): boolean`** — whether a binding
   name introduces `REACHED`, directly or through a destructuring pattern.
   Bare identifier compares text; otherwise recurse over `target.elements`,
   guarded by `ts.isBindingElement` so an `ArrayBindingPattern`'s
   `OmittedExpression` holes are skipped. This mirrors the recursion
   `moduleLevelBindings`'s own `declare` already performs, and the comment
   should say so rather than re-explain destructuring.

2. **Rename `reachedIn` → `reachedDeclarationsIn`, returning
   `readonly ts.VariableDeclaration[]`.** Collect every `VariableDeclaration`
   whose `name` satisfies `bindsReached`, with or without an initializer. The
   full-tree walk stays as it is — `reached` lives inside an `it(...)`
   callback, not at module level.

   The rename is deliberate: the return type changes meaning, from *initializers
   collected* to *declarations that bind the name*, and both call sites should
   have to re-read.

3. **Branch per declaration in `reachedIndependenceOf`.** Replace
   `for (const initializer of initializers)` with a loop over declarations:
   - `declaration.initializer === undefined` → push exactly
     ```
     `${file}:${line} ${REACHED} is declared with no initializer of its own — nothing here can see what it is assigned`
     ```
     where `line` is the declaration's own start line, and **continue** — do
     not also emit the missing-`CENSUS` finding, which would assert something
     this file cannot know.
   - otherwise → walk the **whole `VariableDeclaration`** (not just its
     initializer), unchanged in every other respect: same `sawCensus` tracking,
     same finding strings, same per-call line numbers.

   The early return stays `declarations.length === 0 → undefined`, and now
   carries only the one meaning it names.

4. **`censusDeclarationCount`'s finding is unchanged** and still runs before
   any declaration is walked.

### Fixtures (in the existing `the reached rule, …` describe)

Each names what it pins and why, in the style of the fixtures already there.

- **`reports a bare declaration with no initializer of its own`** — the
  `let reached;` + `if`/`else` shape from the issue, with the dirty
  `searchScope()` walk in one branch. Expect **exactly** the ambiguity finding
  and nothing else; the comment should say that this is the #472/#489/#492
  regression reached through a different syntactic door, and that reporting it
  loudly is the deliberate choice over resolving which assignment wins.
- **`reports a destructured declaration by walking the whole declaration`** —
  `const { reached } = buildReachedSet();` with `buildReachedSet` declared at
  module level in the preamble. Expect the reach finding for `buildReachedSet`
  **and** the missing-`CENSUS` finding.
- **`reports nothing for a destructured declaration that derives from the census`** —
  the same destructured shape whose right-hand side does call `censusOfTree`.
  Expect `[]`. This is what keeps the fixture above from passing for the wrong
  reason: without it, a blanket "any destructured shape is a finding" would
  satisfy that expectation too.

### Verification

- The file's suite green, and the count stated as arithmetic (25 + 3 = 28).
- `npm run typecheck` and `npm run lint` clean.
- **Mutation proofs**, one per fixture:
  - Restore the `initializer !== undefined` test into discovery → the bare and
    destructured fixtures red (they get `undefined` back), the clean-destructured
    one reds too; name which.
  - Drop the `bindsReached` recursion into `elements` (identifier-only) → the
    two destructured fixtures red, the bare one stays green.
  - Walk `declaration.initializer` instead of the whole declaration → state the
    measured result honestly. If no fixture reds, say so and explain why (the
    destructured RHS *is* the initializer), rather than inventing a fixture to
    manufacture a red.
- Confirm the two real census files still report `[]` — the whole-file suite
  passing is that evidence, since they are what the non-fixture assertions read.

---

## Task 2 — pin the for-of consequence, and correct every docblock claim

Depends on Task 1.

### Fixtures

- **`reports a for-of binding, which has no initializer of its own`** —
  `for (const reached of searchScope()) { … }`. Expect the ambiguity finding.
  The comment states this is a consequence of Task 1's restructure rather than
  a shape #499 named, that it degrades loud, and that a maintainer wanting a
  loop variable of that name renames it.
- **`reports a nested binding pattern`** — a `reached` bound at least two
  levels into a pattern, or through an array pattern with a hole
  (`const [, { reached }] = …`), whichever exercises both the recursion and the
  `ts.isBindingElement` guard. Expect the findings for its right-hand side.

Both mutation-proven the same way.

### Docblock corrections

Replace, do not annotate — "this previously read X" belongs in the PR body
(CLAUDE.md, *Comment Discipline*).

1. **"WHAT IT ALSO ASSERTS (#492)"** — `` Every `const reached = …` declaration ``
   is now wrong. State the widened rule: every declaration **binding** the name,
   whatever the syntax, each checked on its own; a declaration with no
   initializer of its own is itself a finding, because what it is later assigned
   is not visible to a walk of the declaration.
2. **The `` `reachedIn` ALSO DOES NOT SEE … `` paragraph** (the one #499 points
   at) — delete it. It describes a gap that no longer exists. Do not leave a
   sentence saying it used to.
3. **"THIS FILE STAYS OUT OF BOTH CENSUSES"** — the `REACHED` self-exclusion
   sentence says the discovery looks for "a `VariableDeclaration` named
   `reached`". Widen it to the shapes now discovered, and make the existing
   "thinner margin than `GUARD`'s" warning name them, since the margin is now
   thinner still.
4. **`reachedDeclarationsIn`'s own docblock** — rewritten for the new name and
   the declarations-not-initializers return, keeping the existing "every match,
   not just the first" reasoning, which still holds.
5. **`reachedIndependenceOf`'s docblock** — the per-declaration branch, and the
   `undefined` paragraph, which now carries exactly one meaning.

Then **sweep for what was invalidated, not only what was edited**: `grep` the
whole file for `initializer`, `reachedIn`, and `` `const reached` `` and give
every hit a verdict. Expect legitimate survivors.

### Verification

- Suite green; count stated as arithmetic (28 + 2 = 30).
- `npm run typecheck`, `npm run lint` clean.
- `npx vitest run --project unit --project components` green, with the file and
  test totals stated.
- **Re-run the self-exclusion AST sweep** from the spec's row 9 against the
  edited file: it must still find **zero** `reached` bindings in
  `census-walk-independence.test.ts`. Do this with a throwaway script outside
  `src/` (a file under `src/lib/*.test.ts` would itself join the discovery);
  delete it afterwards and confirm `git status` is clean of it.
