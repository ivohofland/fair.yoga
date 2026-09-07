# The census pair's unwatched seams (#489)

Four gaps in the two structural censuses — `src/lib/db-locks-verdict-census.test.ts`
and `src/lib/probe-placement-census.test.ts` — all the shape #472 was about: a guard
or a comment advertising a protection that measurement refutes.

All four are latent. Nothing in the repository is currently wrong; what is missing is
anything mechanical holding it that way.

## The premise, verified

Measured on this branch's base, `origin/main` at `6f774b87`, with the dev `.env`
copied in so Prisma's client resolves. Baseline before any mutation: **150 test files,
1930 tests passing** across the `unit` and `components` projects.

| # | The issue's claim | Measured | Verdict |
|---|---|---|---|
| 1 | A filter between `searchScope()` and the census leaves both suites green | `49 passed` (19 + 30), 97 files dropped from both censuses | holds |
| 2 | A dead `transactionCallbackOf` reddens 21 of 30, and the array-form fixture survives | `21 failed \| 9 passed`, array-form fixture among the 9 | holds |
| 3 | `byLocation` → identity leaves db-locks' 19 green | `19 passed` | holds |
| 3 | The same mutation reddens the probe file's dedicated fixture | `1 failed \| 29 passed`, the failure being `orders a report across files by path before line` | holds |
| 4 | Two byte-identical `readdirSync` expressions per file | exactly 2 per file, identical | holds |
| 4 | DRY-ing the two walks and narrowing the result leaves everything green | `19 passed` | holds |

The 97 is `find src/components -name '*.ts' -o -name '*.tsx' | grep -v '\.test\.' | wc -l`
→ 97, re-derived on this base rather than carried over from the issue.

### Where the issue is wrong, and what it did not reach

**One line reference is off by three.** Item 4's table gives probe-placement's
guard-side walk at `:174`. Line 174 is the closing `*/` of `areasUnderSrc`'s docblock;
the `readdirSync` call is at `:177`. The db-locks row (`:123` / `:158`) is correct, and
the substance of the claim — two byte-identical expressions per file — holds in both.

**The sort's line arm is unpinned in the probe file too, which the issue does not
say.** Item 3 treats the probe file as the solved neighbour. It is solved for the
*cross-file* arm only. Mutating the comparator's line arm alone —
`a.file === b.file ? a.line - b.line : …` → `a.file === b.file ? 0 : …` — leaves all
**30 green**. The file's own comment scopes itself honestly ("the only thing that
exercises the cross-file arm of the sort"), so this is a gap the file names rather
than a false claim, but porting only the cross-file half to db-locks would reproduce
it there. §3 below decides what to do about it.

**Item 2's shape does not recur.** Swept both files for a comment claiming an
assertion catches a dead detector. Two sites carry that reasoning:
`probe-placement-census.test.ts:786` states it correctly (its assertion is a non-empty
list) and `:809` is the one the issue names. db-locks has no comparable claim — its
`CLEAN`-asserting fixtures carry no liveness reasoning at all. One site, as filed.

## 1. The scope-reach guard must watch what the census read

### The gap

```ts
const required = areasUnderSrc();
const reached = new Set(searchScope().map(areaOf));   // ← what the walk YIELDS
```

`censusOfTree()` is `takeCensus(searchScope().map(read))`. The guard re-reads
`searchScope()`; it never asks the census what it consumed. Anything between the two —
and `searchScope`'s docblock advertises itself as the seam for exclusions, which makes
its call site the natural home for a future "skip generated files" filter — is
unwatched.

### The decision

**The memoised census carries its inputs.** `takeCensus` records the repo-relative
path of every source as the loop consumes it, and returns it on the `Census`. The
guard's `reached` is derived from that.

```ts
const reached = new Set(censusOfTree().filesCensused.map(areaOf));
```

Recorded *inside the consuming loop*, not from the `sources` parameter before it, so
there is no step left between "what was recorded" and "what was censused".

**Rejected: a shared memoised `filesCensused()` helper both the guard and
`censusOfTree` call.** It reproduces the defect one level further out — a filter can
still be inserted between that helper and `takeCensus`, and the guard would not see
it. The whole lesson of #472 and of this item is that a seam between the two sides is
where the narrowing goes; the fix has to remove the seam, not move it.

### What changes about the second direction

`areasTheGuardMisses` is documented as "empty by construction — `areasUnderSrc`
applies a strict subset of `searchScope`'s rules to the same tree". That reasoning
survives, because the census reads a subset of `searchScope()`, but it gains a way to
fire it did not have: a census that read a file `areasUnderSrc` would not require. The
comment is **replaced** with what is true after the change, not annotated with what it
used to say — that record belongs in the PR body.

`areasUnderSrc`'s own docblock says it reaches "no line of the walk it checks". After
this change the thing checked is the census's consumed list rather than
`searchScope`'s output, so that sentence is restated too.

### Acceptance

A filter inserted between `searchScope()` and the census reddens the scope-reach
guard in both files. Failure text recorded, reversed, re-verified green.

## 2. The array-form fixture gets the protection its comment claims

`finds nothing to be inside in the array form of a transaction` asserts
`callbacksAt(source)).toEqual([])` under a comment saying a dead detector "would also
report this clean". `[]` is precisely what a dead detector yields.

### The decision

**Change the fixture, not only the comment.** A live interactive callback sits beside
the array form, so the assertion pins a non-empty list:

```
line 2   await db.$transaction([db.a.create({}), db.b.create({})]);   // the array form
line 3   await db.$transaction(async (tx: unknown) => tx.c.create({})); // the live control
line 4   await ruleSlotHolder(db, {});                                 // outside both
```

`expect(callbacksAt(source)).toEqual([`${FIXTURE}:3`])` then discriminates both ways:

- **dead detector** → `[]` ≠ `['…:3']` → red. The protection the comment always claimed.
- **over-broad detector** (takes any first argument) → `['…:2', '…:3']` ≠ `['…:3']` → red.
  The protection the assertion actually had, kept.

The verdict under test is unchanged: `censusOf(source)` stays `CLEAN`, because the
probe at line 4 is a sibling statement of both transactions and inside neither.

Correcting the comment alone was the cheaper option and is rejected: it would leave
the one fixture in a file whose stated convention is "where the detector fired is
asserted beside the verdict" unable to see a dead detector, and `:786` already shows
what that convention looks like when it is real.

### Acceptance

Neutering `transactionCallbackOf` reddens this fixture. Making it accept any first
argument also reddens it. Both proven by mutation, reversed, re-verified green.

## 3. `byLocation`'s sort, pinned in both files and in both arms

db-locks' `byLocation` docblock claims "Sorted the way a reader would open them, so a
failure list is stable"; replacing the sort with identity leaves all 19 green.

### The decision

**Port the probe file's cross-file fixture to db-locks, and pin the line arm in both
files.**

The cross-file half is a direct port: two `Source` entries passed later-path-first,
each yielding an unverdicted call, asserted to come back in path order. That alone
meets the issue's acceptance (identity → red).

The line arm needs a different device, and the reason is worth stating because it is
why the probe file never covered it: **the line arm is unobservable through the
census.** `takeCensus` walks each file's AST in source order, so every array it builds
is already in line order within a file, and no fixture routed through `takeCensus` can
hand `byLocation` an out-of-order same-file list. The pin is therefore a **direct call
to `byLocation`** with a hand-built array in reverse line order, carrying a comment
saying exactly that.

Going past the issue here is deliberate. Item 3's entire premise is a docblock
claiming an ordering nothing holds; pinning one arm and leaving the other would ship
the same defect in half. Stated honestly: a broken line arm produces no wrong output
today, because the walk that feeds it is source-ordered. What the pin buys is that the
docblock's claim is wholly true, and that a future walk which stops being
source-ordered fails here rather than in a mis-ordered failure list.

### Acceptance

`return [...sites];` reddens both files. `a.file === b.file ? 0 : …` reddens both
files. Both mutations proven, reversed, re-verified green.

## 4. One shared structural guard against DRY-ing the two walks

Each census file holds two byte-identical `readdirSync` expressions — the census's walk
and the guard's independent read. Hoisting them into one helper silently restores the
defect #472 closed, and neither direction of the repaired guard sees it: a narrowing
inside a shared walk shrinks `required` and `reached` together. Measured: DRY-ed and
narrowed, all 19 stay green.

The only defence today is `areasUnderSrc`'s docblock. *Comment Discipline* states its
own preference order — "if the risk is that someone reintroduces the error, add a test
or a tether; if neither is possible, one line stating the constraint" — and a tether is
possible.

### The decision, on the question the issue asks

The issue asks whether a second self-reading device belongs in each census file, or
whether one shared structural guard should serve both. **One shared guard**, in its
own file: `src/lib/census-walk-independence.test.ts`.

- One implementation of a delicate AST predicate rather than two that can drift — and
  drift between two copies of a guard is this issue's own subject.
- Each census file already carries two self-exclusion devices (the assembled `MARKER`
  or the data-only probe names, and the `satisfies` pins). A third AST-parsing block
  inside a 705- and a 957-line file earns its weight less than a file that names the
  invariant.
- The invariant spans two files. A file naming both is where it belongs.
- It is a `.test.ts`, so both censuses exclude it by path; it contains no
  `lockClassRowsOrdered` call expression, no probe call expression, and does not spell
  the db-locks marker, so lifting either exclusion would still census nothing from it.

### The predicate

Not "does not call `typeScriptUnderSrc` or `searchScope`" — that is defeated by a
rename, and by the refactor the issue actually fears, which hoists the walk into
*another module*. The predicate is:

> Inside `areasUnderSrc`, every callee that roots in a module-level binding must root
> in an import from a `node:` specifier — and a `readdirSync` call expression must be
> present.

That covers the three shapes a hoist can take:

| Refactor | Caught by |
|---|---|
| `areasUnderSrc` calls a local `typeScriptUnderSrc()` / any locally-declared helper | the callee roots in a module-level *declaration*, not a `node:` import |
| `import { walk } from './census-walk'; walk()` | the callee roots in a non-`node:` import |
| `import * as w from './census-walk'; w.walk()` | the property-access root `w` is a non-`node:` import |

Callees rooting in a parameter or a local (`areas.add`, `relative.split`), and regex
literal callees (`/\.tsx?$/.test`), are untouched — they cannot reach another walk.

Syntax, not text, as the acceptance demands: a `ts.CallExpression` is required, so a
name inside a comment or a string literal satisfies nothing.

### Non-vacuity

Three ways this guard could certify nothing, and what stops each:

1. **`areasUnderSrc` renamed or gone** → the guard reports it as missing rather than
   finding no violations in a function it never located.
2. **The census file list going stale** → the list is *discovered*, not written down:
   every `src/lib/*.test.ts` declaring a function named `areasUnderSrc`. A third
   census file joins on its own. A floor assertion (at least the two known paths, and
   at least two members) is what stops discovery silently finding none.
3. **The predicate itself being dead** → fixtures inside the tether file, parsed the
   same way, covering each row of the table above plus the clean case and the
   text-mention case.

### Acceptance

A refactor hoisting the two `readdirSync` calls into a shared helper reddens this
guard for both files, naming the function. Proven by mutation in each of the three
refactor shapes, reversed, re-verified green.

## Task order

**Task 1 before task 4.** Task 1 restates `areasUnderSrc`'s docblock (the guard now
checks the census's consumed list, not `searchScope`'s output); task 4 adds a pointer
to the tether in the same docblock. Writing task 4's pointer against the pre-task-1
wording would leave a pointer describing a guard that no longer works that way.

Tasks 2 and 3 are independent of both and of each other.

## What this does not do

- **#472 and #488 are unaffected** — both shipped; this changes neither's behaviour.
- It does not make the scope-reach guard finer than the area. A narrowing that thins
  an area without emptying it stays invisible, as both files' comments already say.
- It does not tether the census walk (`typeScriptUnderSrc`) against being shared — the
  census's own walk is allowed to be the census's own walk. What must stay independent
  is `areasUnderSrc`.
- It adds no production code. Every file it touches is a test.
