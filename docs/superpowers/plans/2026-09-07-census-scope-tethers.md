# Plan — the census pair's unwatched seams (#489)

Design: `docs/superpowers/specs/2026-09-07-census-scope-tethers-design.md`.
Read it first. It records the measurement behind every claim below, the two
design questions the issue asked and how they were answered, and one place the
issue's own text is wrong. The tasks assume its conclusions rather than
repeating them.

Two files are in scope throughout, plus one new one:

| File | Lines on base | What it censuses |
|---|---|---|
| `src/lib/db-locks-verdict-census.test.ts` | 705 | every `lockClassRowsOrdered` call site carries a verdict |
| `src/lib/probe-placement-census.test.ts` | 957 | every probe call sits outside every transaction callback |
| `src/lib/census-walk-independence.test.ts` | new (Task 4) | neither file's guard-side walk descends from its census's walk |

**Task order is load-bearing between 1 and 4.** Task 1 restates
`areasUnderSrc`'s docblock — after it, the scope-reach guard checks what the
census consumed rather than what `searchScope` yields. Task 4 adds a pointer to
the new tether in that same docblock, and must read Task 1's landed wording
rather than this plan's description of it. Tasks 2 and 3 are independent of both
and of each other.

Nothing here touches `prisma/`, `src/services/`, `src/app/`, or any production
module — every file changed is a test, and no migration is involved. Nothing
touches `tests/`; see "Verification" for why the integration and e2e tiers are
CI's job from this worktree.

**A note that applies to every task.** These two files are unusually
comment-dense, and their comments are load-bearing. *Comment Discipline* governs
every line written here: a comment annotates the code it sits on; where a
comment becomes wrong, **replace it with what is true now** rather than
annotating what it used to say — the before-and-after goes in the PR body. Do
not add prose counts or rosters.

---

## Task 1 — the scope-reach guard compares against what the census read

**Files:** `src/lib/db-locks-verdict-census.test.ts`,
`src/lib/probe-placement-census.test.ts`

**Why.** The guard's `reached` comes from a second `searchScope()` call, not
from the census. A filter at `censusOfTree`'s call site drops files from the
census while `reached` stays whole. Measured on base: inserting
`.filter((f) => !f.startsWith('src/components/'))` between `searchScope()` and
`.map(…)` in both files drops 97 production files and leaves all 49 tests green.

**What to write.**

1. In each file's `takeCensus`, record the repo-relative path of every source
   **inside the loop that consumes it** — not from the `sources` parameter before
   the loop. Return it on the `Census` as `filesCensused`. Recording inside the
   consuming loop is the point of the change: it leaves no step between "what was
   recorded" and "what was censused" for a filter to occupy.
2. Add a short docblock to the new field saying what it is for — that the
   scope-reach guard compares against it rather than against a second call to the
   walk. Keep it to the field it sits on.
3. In each file's scope-reach guard, derive `reached` from
   `censusOfTree().filesCensused` instead of from `searchScope()`.
4. **Rewrite the two comments this makes wrong.** Both are long; read them and
   restate, do not patch.
   - The scope-reach guard's own comment. Its "Searched is the load-bearing
     word — `reached` is what `searchScope` yields" sentence (and the probe file's
     equivalent) is now false: `reached` is what the census consumed. Its
     "empty by construction" paragraph about `areasTheGuardMisses` still holds
     and for the same reason — the census reads a subset of `searchScope()`,
     which applies a superset of `areasUnderSrc`'s exclusions — but it gains a
     way to fire it did not have: a census reading a file `areasUnderSrc` would
     not require. Say that.
   - `areasUnderSrc`'s docblock, whose first sentence names what the guard
     checks. After this change the thing checked is the census's consumed list.
     Leave its "The duplication is the whole point" paragraph intact — Task 4
     will add one line to it and nothing else.
5. Do not change `searchScope`, `typeScriptUnderSrc`, `areasUnderSrc`'s body, or
   `areaOf`.

**Blast radius to confirm rather than assume.** `findings()` in both files
returns only its own arrays, and the fixtures reach `takeCensus` through
`censusOf` / `callbacksAt`, so adding a `Census` field should touch nothing else.
Confirm that by running both suites, and say in the report if anything else
needed changing.

**Mutation proof, required, per file.**
1. Insert `.filter((f) => !f.startsWith('src/components/'))` between
   `searchScope()` and `.map(…)` in `censusOfTree`.
2. Run that file's suite. It must fail on the scope-reach guard, reporting
   `components` under `areasTheCensusMisses`. Record the exact failure text.
3. Remove the filter. Re-run and confirm green.
4. Report all outputs verbatim, for both files.

---

## Task 2 — the array-form fixture earns its comment

**File:** `src/lib/probe-placement-census.test.ts`

**Why.** `finds nothing to be inside in the array form of a transaction` asserts
`callbacksAt(source)).toEqual([])` under a comment claiming a dead detector
"would also report this clean". `[]` is exactly what a dead detector yields.
Measured on base: with `transactionCallbackOf` neutered, 21 of that file's 30
tests go red and this one stays green.

**What to write.** Add a live interactive callback to the fixture source beside
the array form, so the assertion pins a non-empty list. The intended shape —
line numbers matter because they appear in the expectation:

```
1  async function f(db: unknown) {
2    await db.$transaction([db.a.create({}), db.b.create({})]);
3    await db.$transaction(async (tx: unknown) => tx.c.create({}));
4    await <RULE_SLOT_HOLDER>(db, {});
5  }
```

`censusOf(source)` stays `CLEAN` — the probe at line 4 is a sibling statement of
both transactions and inside neither — and `callbacksAt(source)` becomes
`[`${FIXTURE}:3`]`.

Rewrite the comment to state both protections, since the fixture now has both: a
dead detector reports `[]` and fails, an over-broad one that accepts any first
argument reports line 2 as well and fails. `:786`'s comment in the same file is
the model for the first half — do not copy its wording, and do not make either
comment refer to the other.

**Behaviour to verify.** The fixture passes unchanged in meaning: the array form
still encloses nothing.

**Mutation proof, required — two mutations.**
1. **Dead detector.** Make `transactionCallbackOf` return `undefined`
   unconditionally. This fixture must now be among the failures (on base it was
   among the 9 survivors). Record the failure text and the file's failed/passed
   counts. Restore, re-verify green.
2. **Over-broad detector.** Make `transactionCallbackOf` return the first
   argument whatever its shape — i.e. drop the
   `isArrowFunction || isFunctionExpression` test. This fixture must fail,
   reporting `…:2` alongside `…:3`. Record the failure text. Restore, re-verify
   green.

Both mutations will redden other tests too; that is expected. What the report
must establish is that **this** fixture is red under **each**.

---

## Task 3 — `byLocation`'s sort, pinned in both files and both arms

**Files:** `src/lib/db-locks-verdict-census.test.ts`,
`src/lib/probe-placement-census.test.ts`

**Why.** db-locks' `byLocation` docblock claims failure lists are stable;
replacing its sort with `return [...sites];` leaves all 19 green, because every
db-locks fixture yields at most one entry per array. The probe file has the
fixture db-locks lacks — but only for the cross-file arm. Measured on base:
mutating the probe comparator's line arm alone to `0` leaves all 30 green.

**What to write.**

**(a) db-locks gets a cross-file ordering fixture.** Model it on the probe
file's `orders a report across files by path before line` — read that fixture
first. Two `Source` entries passed later-path-first, each holding one
unverdicted call, asserted to come back in path order in
`callSitesNotPairedOneToOne`. Reach `takeCensus` directly rather than through
`censusOf`, since `censusOf` is single-file. Give it a comment saying it is the
only db-locks fixture holding more than one file and therefore the only thing
exercising the cross-file arm — a claim about the fixture it sits on, so it is
allowed to be there, but keep it to that.

**(b) Both files get a line-arm pin.** This one cannot go through `takeCensus`,
and the comment must say why: `takeCensus` walks each file's AST in source
order, so every array it builds is already in line order within a file, and no
fixture routed through it can hand `byLocation` an out-of-order same-file list.
The pin is therefore a **direct call to `byLocation`** with a hand-built array of
two `Site`s sharing a file and given in descending line order, asserted to come
back ascending.

State honestly in that comment what the pin does and does not buy: a broken line
arm produces no wrong output today, because the walk feeding it is
source-ordered; what the pin holds is that the docblock's claim is wholly true,
and that a walk which stops being source-ordered fails here rather than in a
mis-ordered failure list.

Put (b) beside (a) in db-locks, and beside the existing ordering fixture in the
probe file, so the two arms read as one subject in both files.

**Mutation proof, required — two mutations, both files (four runs).**
1. `return [...sites];` — must redden both files. Record failure text per file.
   Restore, re-verify green.
2. `a.file === b.file ? 0 : a.file < b.file ? -1 : 1` — must redden both files,
   and specifically the new line-arm pin. Record failure text per file. Restore,
   re-verify green.

---

## Task 4 — one shared tether against DRY-ing the two walks

**File (new):** `src/lib/census-walk-independence.test.ts`
**Files touched:** one line added to `areasUnderSrc`'s docblock in each census
file.

**Run this task last.** It reads Task 1's landed wording of `areasUnderSrc`'s
docblock.

**Why.** Each census file holds two byte-identical
`readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })`
expressions — the census's walk and the guard's independent read. Hoisting them
into one helper silently restores the defect #472 closed, and neither direction
of the guard sees it: a narrowing inside a shared walk shrinks `required` and
`reached` together. Measured on base: DRY-ed and narrowed, all 19 stay green.
The only defence today is prose, and this repo ships a `code-simplifier` agent
whose stated job is removing duplication.

**The predicate.** Not "does not call `typeScriptUnderSrc` or `searchScope`" —
a rename defeats that, and so does the hoist the issue actually fears, which
moves the walk to another module. Assert instead:

> Inside `areasUnderSrc`, every callee that roots in a module-level binding must
> root in an import from a `node:` specifier — and a `readdirSync` call
> expression must be present.

"Roots in" means: for a bare-identifier callee, that identifier; for a
property-access callee (`path.join`, `w.walk`), the leftmost identifier. Callees
rooting in a parameter or a function-local, and non-identifier callees such as a
regex literal's `.test`, are out of scope — they cannot reach another walk.

It must read **syntax, not text**: a `ts.CallExpression` is required, so a name
appearing in a comment or a string literal satisfies nothing. Both census files
already `import ts from 'typescript'` and parse with `ts.createSourceFile`; the
means are in place.

**Which files it checks — discovered, not written down.** Every
`src/lib/*.test.ts` declaring a function named `areasUnderSrc`. A third census
file joins on its own. Guard the discovery with a floor: the discovered set must
contain both known paths and hold at least two members, so discovery finding
none fails loudly rather than certifying nothing.

**Non-vacuity, three ways this could certify nothing.**
1. `areasUnderSrc` renamed or gone in a discovered file → reported as missing,
   not as "no violations found in a function I never located".
2. Discovery going stale or empty → the floor above.
3. The predicate itself being dead → fixtures inside the tether file, parsed the
   same way, covering each refactor shape in the mutation list below, plus the
   clean case (the real shape, which must report nothing) and a text-mention case
   (`typeScriptUnderSrc` named only in a comment and in a string literal, which
   must report nothing).

**Keep the new file out of both censuses.** It is a `.test.ts`, so both exclude
it by path — but do not rely on that alone, matching the convention both census
files already follow. It must contain no `lockClassRowsOrdered` call expression,
no probe call expression, and must not spell the db-locks marker text. Say so in
its docblock.

**The pointer.** Add one line to `areasUnderSrc`'s docblock in each census file,
naming this file as what holds the independence its "The duplication is the
whole point" paragraph argues for. One line, stating what is true now; do not
restate the tether's predicate there — that claim would then live in three
places. This is a claim about what constrains the code the comment sits on, in
the shape the files already use for "`npm run typecheck` in CI's `checks` job is
what holds that".

**Mutation proof, required — three refactor shapes, applied to
`areasUnderSrc` in `db-locks-verdict-census.test.ts`, each reversed and
re-verified green.**
1. Replace its `readdirSync` walk with a call to the file's own
   `typeScriptUnderSrc()`. The tether must go red naming the function and the
   file.
2. Hoist the walk into a new sibling module and call it by a bare imported name.
   The tether must go red. (Delete the sibling module when reversing.)
3. The same hoist reached as a namespace member (`import * as w from …;
   w.walk()`). The tether must go red.

Record the exact failure text for each, and confirm the file is green again
after each reversal. Also record that with the tether present and unmutated,
both census files pass it.

---

## Verification

**In this worktree,** run: `npm run typecheck`, `npm run lint`, and
`npx vitest run --project unit --project components`. Baseline on this branch's
base was **150 test files, 1930 tests passing**.

**Do not run `--project integration` or the e2e tier here.** Both are hard-wired
to the dev server on `:3000` and the shared dev database, and this worktree has
neither; scoping them in hangs on `ECONNREFUSED`. CI is the signal for those
tiers, and the PR body must cite the CI run rather than a local `verify` for
them. This branch touches no file under `tests/`, so there is no integration
file to name.

**Do not start, restart, or kill anything on `:3000`.**

Each task's report must carry its mutation outputs verbatim — the failure text,
the reversal, and the re-verified green. A guard that compiles but cannot fail
certifies nothing, and every guard this plan adds exists precisely because
something that looked like a guard did not bite.
