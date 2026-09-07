# Plan — the verdict census's scope-reach guard reads the tree itself (#472)

**No spec.** One file, one edit, and the design already shipped and was reviewed
one file over: `areasUnderSrc()` in `src/lib/probe-placement-census.test.ts`
(PR #471, issue #467). The whole of this plan is porting it and correcting a
comment. Where a spec would have gone, the premise verification below stands
instead.

## Premise, re-verified on `origin/main` at `287ee3b7`

The issue measured on `db443df3`; everything it claims still holds. Measured in
this worktree:

| Claim | Verdict |
|---|---|
| `required` and `reached` both descend from `typeScriptUnderSrc` | **Holds.** `required` calls it directly (line 421); `reached` calls `searchScope`, which is `typeScriptUnderSrc().filter(…)` (line 133). |
| A narrowing inside `typeScriptUnderSrc` leaves the guard green | **Holds.** With `.filter((p) => !p.startsWith('src/components/'))` added inside it, `npx vitest run --project unit src/lib/db-locks-verdict-census.test.ts` → `Test Files 1 passed (1) / Tests 19 passed (19)`. |
| The mutation is observable — it really does narrow the census | **Holds, and the issue understated it.** `find src/components -name '*.ts' -o -name '*.tsx' \| grep -v '\.test\.'` → **97** production files, all silently dropped. |
| The four call sites are all under `src/services` | **Holds today.** `gdpr.ts:440`, `gdpr.ts:1133`, `class-template-lifecycle.ts:754`, `waitlist.ts:1092` are the only call *expressions*; every other `lockClassRowsOrdered` hit under `src/` is prose (including `src/app/api/studio-classes/[id]/route.ts:229`). So the comment is a *Comment Discipline* violation, not a live falsehood — exactly as the issue says. |
| The fix exists in `probe-placement-census.test.ts` | **Holds.** `areasUnderSrc()` at lines 172-180, used at line 445. |

**Why the mechanism works.** The assertion is a set difference,
`required \ reached`. Both sides descend from one walk, so a filter added inside
that walk subtracts the same areas from both, and subtracting equally from both
sides of a difference leaves it empty. The guard can therefore only catch a
narrowing added *below* the fork — inside `searchScope` — never one above it.
The issue's extra observation is right too: `required` re-implements
`searchScope`'s two exclusions inline rather than calling it, so a narrowing
added at *either* end moves both sides together.

**Sweep for the same shape, not just the same lines.** Five files call
`readdirSync` — three under `src/`, two under `tests/`. Re-derived by
`grep -rln readdirSync src tests --include='*.ts' --include='*.tsx'`. The three
under `src/`:

- `src/lib/db-locks-verdict-census.test.ts` — the subject of this plan.
- `src/lib/probe-placement-census.test.ts` — already fixed by #467.
- `src/lib/serial-tier-membership.test.ts` — **not** a third instance. Its walk
  (`markerSearchScope`) is compared against the `LOCK_CONTENTION_TESTS` and
  `SERIAL_TESTS` arrays imported from `vitest.tiers.ts`, an independent source
  that no walk narrowing can move. It has no scope-reach guard at all.

(`tests/migration-sql.ts` and `tests/e2e/visual.spec.ts` also walk directories;
neither carries a guard of this shape.)

---

## Task 1 — give the scope-reach guard its own directory read

**File:** `src/lib/db-locks-verdict-census.test.ts`. (The whole-branch review
added a second file — see *What the review changed* at the foot of this plan.)

### What to write

**1. A new `areasUnderSrc(): Set<string>`,** placed between `searchScope` and
`areaOf`. Model it on `src/lib/probe-placement-census.test.ts` lines 160-180 —
read that file first and match its shape closely, so a reader who knows one
census knows the other. It must:

- call `readdirSync` itself, and call neither `searchScope` nor
  `typeScriptUnderSrc` nor any helper they use;
- duplicate only the extension rule and the test-file rule;
- return the set of first path segments (an area), so a bare file directly under
  `src/` contributes its own filename as its area, matching `areaOf`.

**2. Rewire the guard** (`it('reaches every area of src that holds production
TypeScript')`) so `required` is `areasUnderSrc()` and nothing else. `reached`
stays as it is.

**3. Do not duplicate the `DEFINING_MODULE` exclusion into `areasUnderSrc`,**
and say why in its docblock in one sentence. The reason is a rule, not a
measurement: that exclusion removes exactly one file, and an area whose only
searched production file is the one deliberately excluded is a hole this guard
should report rather than bless. **Write the rule; do not write how many other
files that area holds today** — that would be the same prose-count violation
this task is removing.

### The comment rewrite (acceptance criterion 3)

The guard's leading comment currently reads:

```
// The non-vacuity assertion below checks two TOTALS, and all four call
// sites live under `src/services` — a fraction of the tree. So a filter
// edit that drops whole directories leaves both totals non-zero and every
// assertion green while the census stops watching most of the repository.
// This compares against a walk written separately from `searchScope`'s: it
// shares the extension and test-file rules, and none of the exclusions a
// future edit would add, which is exactly what has to fail.
```

Two things are wrong with it and both must go:

- **The count and the roster** — "all four call sites live under
  `src/services`" is a prose count and a member list about *other files*, which
  *Comment Discipline* forbids outright. The point it serves (the totals are a
  weak guard) does not need it: the totals stay non-zero as long as *any* call
  and *any* verdict survive anywhere, which is a fact about the assertion's own
  logic and needs no census of the tree. State it that way.
- **"a walk written separately from `searchScope`'s"** — after this task that
  becomes true, but the sentence must still be rewritten, because what makes it
  true is the second `readdirSync`, and a reader needs to be told that the
  independence extends *inside* the shared `typeScriptUnderSrc`. The sibling's
  wording at `probe-placement-census.test.ts:441-444` is the model.

**Replace the prose; do not annotate it.** No "this previously read X" — per
*Comment Discipline*, what it used to say belongs in git and the PR body. The
before/after goes in the PR body, which is written at the end of this branch.

### Mutation proof, required

A guard that compiles but cannot fail certifies nothing, so prove this one bites
the way it actually broke — a narrowing inside the *shared* walk, which is the
edit the old guard was blind to.

1. Confirm green first: `npx vitest run --project unit
   src/lib/db-locks-verdict-census.test.ts`. Record the pass line.
2. Add `.filter((p) => !p.startsWith('src/components/'))` inside
   `typeScriptUnderSrc`, after the existing extension filter.
3. Re-run. It must fail on the scope-reach guard. **Record the exact failure
   text verbatim** — the issue predicts an
   `expected [ 'components' ] to deeply equal []` shape; report what actually
   appears, including whether any *other* assertion also went red.
4. Reverse the edit. Re-run and confirm 19 passed again. Record that line too.
5. Report all three outputs verbatim in the task report. Do not paraphrase them.

Restore by reversing the edit, not by `git checkout` — this file is the only one
being edited on the branch and a checkout would discard the real work with it.

### Also verify

- `npx vitest run --project unit src/lib/probe-placement-census.test.ts` still
  passes — the sibling is untouched, and this confirms nothing was edited in the
  wrong file.
- `npm run typecheck` and `npm run lint` pass.

### Out of scope

- `src/lib/probe-placement-census.test.ts` — its `areasUnderSrc` is already
  correct; do not change its behaviour. (Its *comment* turned out not to be —
  see *What the review changed* below.)
- `src/lib/serial-tier-membership.test.ts` — a different shape, see the sweep
  above; do not touch it.
- Every other assertion in `db-locks-verdict-census.test.ts`. In particular the
  `excludes the test files and the defining module, neither of them vacuously`
  guard legitimately reads `typeScriptUnderSrc` on both sides: it is asserting a
  property *of that walk's output*, not comparing that walk against an
  independent reading of the tree. Leave it alone.
- Any change to what the census searches. This branch changes only the strength
  of one guard; the census watches exactly the files it watched before.

---

## Verification for the branch

`npm run verify` cannot run whole from a worktree: the `integration` and `e2e`
tiers are wired to the dev server on `:3000` and the shared dev database, and a
worktree has neither. Run the tiers that need no live app — typecheck, lint,
unit, components — and let CI be the signal for the other two. This branch
touches no file under `tests/`, no route, and no service, so there is no
integration surface for it to change; the PR body should cite the CI run for
that tier rather than a local `verify`.

## What the review changed

The whole-branch review measured the replacement comment's closing sentence
false, and it was false in two files rather than one.

The sentence — "a narrowing added **anywhere** in the walk … makes these two
disagree" — reads as a claim about *which narrowings* are caught, and the guard
compares areas, so it does not catch one that leaves an area any production
file at all. Measured inside `typeScriptUnderSrc`: `!p.startsWith('src/app/api/')`
(65 production files) and `p !== 'src/services/gdpr.ts'` (2 of the 4 call sites)
each leave all 19 assertions green. That is a smaller instance of exactly the
defect #472 was filed over, so the comment now states the area granularity as a
limit instead of implying its absence.

The same sentence stood, word for word, in
`src/lib/probe-placement-census.test.ts` — this branch took its wording from
there. Correcting only the copy would have left the original standing, so both
carry the corrected paragraph. That file's `areasUnderSrc` and every assertion
in it are otherwise untouched; the edit is comment-only.

The review also caught a count in this plan's own sweep, corrected above.

**A third round, from the PR review.** The same defect class surfaced twice more,
which is the honest summary of this branch:

- **The guard's own expectation was unpinned.** `required` moved onto
  `areasUnderSrc`, which nothing else in either file reaches, while the assertion
  stayed one-directional — so a *shrinkage* of `required` shrank the very
  difference being asserted empty. Deleting `recursive: true` from
  `areasUnderSrc` typechecks and leaves everything green. Both directions are
  asserted now, under named keys.
- **"Searched" was the load-bearing word**, and this branch had deleted it two
  paragraphs above, where it named an empty set. The granularity caveat was false
  in this file and true in the sibling, because their `searchScope` functions
  differ — copied wording is only safe where the code beneath it agrees.
- `areaOf`'s docblock asserted the opposite of the caveat in both files, and a
  prose count from #464 survived in the `satisfies` docblock. Both corrected.

Two findings were filed as #489 rather than folded, and one declined; why is in
the PR body.

## Not in this branch

- **#464 and #467 are unaffected.** Both shipped. This changes neither's
  behaviour — only the strength of one guard #464 left behind, plus a
  comment-only correction to one #467 shipped.
- No `prisma/` change, so no migration.
