# Tethering `lockClassRowsOrdered`'s call-site census (#464)

## The issue's premise, re-measured

Verified on the worktree base `9cd7fd43`, both censuses exactly as issue #464
ships them:

```
grep -rn 'await lockClassRowsOrdered(' src --include='*.ts' | grep -v '\.test\.ts'
  src/services/gdpr.ts:440
  src/services/gdpr.ts:1133
  src/services/class-template-lifecycle.ts:754
  src/services/waitlist.ts:1092

grep -rn 'VERDICT (#327)' src --exclude=db-locks.ts
  src/services/gdpr.ts:432
  src/services/gdpr.ts:1127
  src/services/class-template-lifecycle.ts:750
  src/services/waitlist.ts:1088
```

Four and four, agreeing, and nothing checks it. **The premise holds** — including
both stated blind spots, both reproduced:

- Dropping `await ` from the first returns a fifth,
  `src/app/api/studio-classes/[id]/route.ts:229`, which is a comment mentioning
  the helper.
- The second is a comment convention, so a call site landing without the marker
  is invisible to it.

**The issue's census inventory is incomplete.** It says "two censuses"; there is
a third, shipped in `docs/lock-order.md:79` and re-measured here:

```
grep -rn 'lockClassRowsOrdered(' src --include='*.ts' \
  | grep -v '\.test\.ts' | grep -vE ':[0-9]+: *(//|\*)'
  src/lib/db-locks.ts:571          ← the definition
  src/services/class-template-lifecycle.ts:754
  src/services/waitlist.ts:1092
  src/services/gdpr.ts:440
  src/services/gdpr.ts:1133
```

Five, exactly as that document claims ("the helper's definition plus four
callers"). It is the **most robust of the three**: bare-name, so not
`await`-anchored, and its `grep -vE ':[0-9]+: *(//|\*)'` drops comment lines, so
it excludes `studio-classes/[id]/route.ts:229` where the first census's `await`
anchor only excludes it by luck. It is still textual — a call sharing a line with
other code after a `/* */` would slip past, and it counts the definition as a row
the reader must know to subtract — but it is the one to beat, and the design
below is measured against it rather than against the weaker pair the issue names.
Three untethered censuses of one set is a stronger case for a tether than two,
not a weaker one.

Two further facts the issue does not state, both measured here, both load-bearing
below:

- **`.test.ts` files really do call the helper** — 12 call sites in
  `src/lib/db-locks.test.ts` and 2 in `src/lib/db-locks-lock-order.test.ts`.
  The first census's `grep -v '\.test\.ts'` is therefore not tidiness; those
  calls exercise the helper rather than opening a domain transaction, so there
  is no entry-column question for a verdict to answer. Nothing under `tests/`
  calls it, and nothing in a `.tsx` file mentions it.
- **`db-locks.ts` itself holds two occurrences of the marker text** — line 417,
  the `ClassLockSource.entries` docblock that defines the convention, and line
  552, the re-derivation command inside the "NO ROSTER HERE" paragraph. That is
  why the second census carries `--exclude=db-locks.ts`, and any tether must
  carry the same exclusion.
- **The convention is specific to this helper.** `lockClassRow` (singular) locks
  the `Class` row and its `CalendarEntry` row unconditionally — no `entries`
  option, so no question to answer — and none of its 12 production call sites
  carries a verdict. Widening the tether to it would assert a convention that
  does not exist.

## The design, and where it departs from the issue

The issue asks for "one test [asserting] the two sets above are equal in both
directions". Taken literally that means re-running both greps from a test. This
spec does something strictly stronger, for a reason the issue itself supplies:

> Each command's blind spot is the other command's strength.

That framing accepts both blind spots and relies on them cancelling. They need
not be accepted. `typescript` is already a devDependency (5.9.3), so **the call
side can be read from the syntax tree** — a `CallExpression` whose callee names
`lockClassRowsOrdered`, whether by that name, by a local name an import
specifier binds to it, or as a member of an imported namespace. That census is
not `await`-dependent (a future `return lockClassRowsOrdered(…)` or
`void lockClassRowsOrdered(…)` is found) and cannot mistake a comment for a
call. It has neither blind spot rather than one.

The verdict side stays textual, because a comment convention has nowhere else to
live. So the two sides are no longer two greps hoping to agree — they are
**syntax on one side, comments on the other, asserted to pair**.

Measured against `docs/lock-order.md:79`, the best of the three shipped censuses:
that one already avoids the `await` anchor and already filters comment lines, so
the syntax-tree census beats it on two narrower points rather than on the obvious
one. It does not need to know to subtract the definition — a declaration is not a
call expression — and it cannot be fooled by a call sharing a line with a closed
block comment, or by the helper's name inside a string. None of those is likely;
the point is that each is a way for a *textual* census to be wrong, and the
syntax-tree one has no textual failure mode at all. What it cannot do is decide
whether a verdict is *true*, which is why the second half of the test exists.

### The pairing, not merely the counts

Equal *sets of files* would be too weak: `gdpr.ts` holds two call sites and two
verdicts, and a file with two calls and one verdict would satisfy a file-level
set comparison. Equal *counts per file* would fix that but still accept a
verdict placed anywhere in the file.

The test therefore pairs each call to a specific comment, one for one:

- For each `lockClassRowsOrdered` call expression, walk to the nearest enclosing
  **comment anchor** and require **exactly one** marker in that anchor's
  **leading comment trivia**. None is an unverdicted call; two or more is a
  verdict standing over nothing, which is what a deleted neighbour's orphan
  comment looks like once its trivia has merged into the survivor's run.
- Require that same anchor to enclose **exactly one** such call. Two of them
  under one anchor — `[...(await lock(A)), ...(await lock(B))]` — leave one
  comment to be read as the answer for two lock scopes with nothing saying
  which; splitting them is cheap and makes the author look at the second.
- For each raw occurrence of the marker text in the file, require it to fall
  inside one of the comment ranges just paired. A marker in a comment attached
  to no such anchor is a verdict that outlived its call; a marker inside a
  string literal is not in a comment range at all.

Both directions are reported in one assertion so a failure names which way it
broke, and the two counts ride inside the reported location — `path:line (2
calls, 1 verdict)` — so a reader knows which shape it is without opening the
test.

**The anchor is not simply the nearest statement, and that was a defect for one
review round.** It is the nearest statement *or* the nearest object-literal or
class member — the unit a person actually writes a comment above. Anchoring on
the statement alone was wrong in both directions, each proven by a run: a call in
a concise-body member (`withdraw: (tx) => lock(tx, …)`) **rejected** the verdict
written directly above it, reporting the call as unverdicted and the verdict as
an orphan; and a verdict above the enclosing `export const` **paired** with a
call twenty members deep among unrelated code. `class-template-lifecycle.ts:754`,
the repo's only `entries: true` site, sits inside a ~330-line
`export const CLASS_FAMILY = {…}` and passed only because `around:` has a block
body.

**The remaining looseness is bounded and is the convention.** Leading trivia can
span a long comment run — in `class-template-lifecycle.ts` the run before the
call is 162 comment lines — so a verdict at the top of one still pairs. All that
permits is a verdict separated from its anchor by comments. What the counts rule
out is the looseness turning into a pool: one marker serving two calls, or two
markers hanging over one.

**A consequence, documented rather than desired:** a verdict above an enclosing
`if`, `try`, `$transaction(…)` call or function docblock does not pair, because
the anchor is the call's own. `db-locks.ts`'s `entries` docblock is where the
placement rule is stated for authors, and it now says so precisely — it
previously read "beside the transaction the question is about", which a review
showed rejects four natural placements.

### Non-vacuity

The failure this design could have is silence: a broken file walk empties both
sides and the test passes. Guarded by asserting both censuses are non-empty, and
by an `existsSync` on `src/lib/db-locks.ts` — which labels a rename loudly rather
than letting it surface as two unexplained orphan verdicts (a rename would drop
the exclusion, so lines 417 and 552 would be reported as orphans; the guard makes
that failure say what it is). Both mirror
`serial-tier-membership.test.ts`'s cwd guard and its stated reason.

### What the acceptance criteria's third clause becomes

"…and that every path either names exists" does not transfer. In
`serial-tier-membership.test.ts` it guards a **configured list** of paths. This
design holds no list at all — both sides are derived from the source tree — which
is what makes it compatible with the paragraph it has to clear rather than in
tension with it. The non-vacuity guards above are what stand in its place.

## Scope, stated as blind spots

The search is every `.ts`/`.tsx` under `src/`, minus `*.test.ts`/`*.test.tsx` and
minus `src/lib/db-locks.ts`. So:

- a call site added inside `db-locks.ts` itself is not seen (it is the defining
  module; a call there would be self-referential);
- nothing outside `src/` is searched — not `tests/` (test callers carry no
  verdict by design), not `prisma/seed.ts`, not `scripts/`, not the root configs;
  nor is a source `tsconfig` compiles but the walk does not match, since
  `allowJs` is on and `*.mts` is included;
- a call reaching the helper through a local binding — `const f =
  lockClassRowsOrdered; f(tx, …)` — is not seen, nor are the two shapes hiding
  the name behind an expression, `(0, lockClassRowsOrdered)(…)` and
  `(cond ? lockClassRowsOrdered : other)(…)`. Following any of them needs a full
  type-checker program, which this test does not build. An import alias (from a
  specifier naming `db-locks`), a namespace member by property access or string
  key, and the identity-preserving wrappers `(f)(…)` and `f!(…)` all are;
- the census assumes its files parse. `ts.createSourceFile` throws nothing and
  reports no diagnostics here, so a syntax error swallowing a call censuses zero
  calls quietly; `npm run typecheck` in CI's `checks` job is what holds that;
- **the marker is a reserved token.** Any occurrence in a searched file counts as
  a verdict, prose merely referring to somebody else's included — so a
  cross-reference must name the convention without spelling the marker;
- the tether forces a **verdict**, never a **decoy**. A fifth call site still
  ships with its scoping conjunct unproven. What changes is that its author must
  write down what the transaction reads and writes before the suite goes green.

**What is no longer a blind spot: the scope itself.** Narrowing `searchScope` to
a single file left every assertion green — all four call sites live under
`src/services`, 1.3% of the tree, and the non-vacuity guard checks only two
totals. Since this design created the scope, that degradation path is one it
introduced; an assertion now compares the areas `searchScope` reaches against an
independently written walk, so a directory-level exclusion fails by name
(`expected [ 'app' ] to deeply equal []`).

## The `db-locks.ts:547` amendment

The paragraph declines a roster:

> NO ROSTER HERE … a caller list kept in this file goes stale, and nothing that
> counts can catch it. Every call site instead carries its own written verdict.

Its reasoning survives intact and is not being reversed — this design holds no
roster, which is precisely why it can sit beside that paragraph. But the
paragraph currently reads as a refusal of any mechanical check, and after this
change that is misleading. It is amended in the same commit to state what is now
enforced (every call site has a verdict; every verdict has a call) and what still
is not (which verdict is *correct*, and whether the site carries a decoy). Per
CLAUDE.md's *Comment Discipline*, the amendment states what is true now — it does
not narrate what the paragraph used to say; that record lives in the PR body.

The re-derivation command at line 552 stays: a human reading the docblock still
wants to see the set, and the shipped commands are now backed by a test rather
than standing alone.

### What the amendment invalidates elsewhere

Three artifacts point at that paragraph or make the claim it carries. Each gets a
verdict rather than an edit by reflex:

- **`src/lib/rule-slot-holder.ts:51`** — its own "NO ROSTER HERE" paragraph opens
  *"for the reason `db-locks.ts` spends a paragraph on"*. That pointer survives
  only if the amendment keeps the reasoning it points at, which is why the
  amendment keeps it. It must be confirmed by opening the amended paragraph, not
  assumed — a pointer that points at something no longer saying that is a defect
  only an auditor who follows it can find. `ruleSlotHolder`'s own census stays
  untethered by this change, deliberately: it is a different helper with a
  different convention, and widening scope to it is not what #464 asks for.
- **`docs/lock-order.md:79`** — the third census, and the document that *owns*
  the "four sites" count. The count does not change (this branch adds no call
  site), and the re-derivation command still returns what it claims. It gains
  one sentence naming the test, because a reader re-deriving that set by hand
  should know the pairing behind it is now held by something that fails.
- **`docs/lock-order.md:1376`** — *"This is a convention enforced by a grep and a
  test, not by the database … the same standing … `lockClassRowsOrdered` has for
  `Class`."* That sentence compares the template families' child-lock convention
  to this one. After this branch the two no longer have identical standing, so it
  needs a verdict: either it stays true at the altitude it is written at, or it
  is narrowed. Decide by reading it, not by pattern-matching the words.

## Acceptance

1. `src/lib/db-locks-verdict-census.test.ts` fails when a call site is added
   without a verdict, and when a verdict outlives the call it describes. Both
   proven by mutation, with the exact error text recorded.
2. It passes on the unmutated tree, and its non-vacuity guards fail when the file
   walk is broken.
3. `db-locks.ts`'s "NO ROSTER HERE" paragraph states what is enforced and what is
   not.
4. `npm run typecheck`, `npm run lint`, and the `unit` project are green.
