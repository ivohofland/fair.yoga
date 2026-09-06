# Plan — tether `lockClassRowsOrdered`'s call-site census (#464)

Design: `docs/superpowers/specs/2026-09-05-lock-verdict-census-tether-design.md`.
Read it first; it records what was measured, and the two facts the issue omits
(test files really are callers; `db-locks.ts` really does hold the marker text
twice) that both tasks depend on.

**Task order is load-bearing.** Task 2's prose describes the test Task 1 writes;
writing it first means describing something that does not exist yet.

Local verification is `npm run typecheck`, `npm run lint`, and
`npx vitest run --project unit src/lib/db-locks-verdict-census.test.ts`. This is
a worktree with no dev server on `:3000`, so the `integration` and `e2e` tiers
cannot run here — do not attempt them, and do not start a dev server. CI is the
signal for those.

---

## Task 1 — the census tether

**New file:** `src/lib/db-locks-verdict-census.test.ts`.

Written test-first: build the mutations before the implementation is complete
and confirm each one goes red, per §3 of the `solve-issue` skill.

### What it asserts

Parse every `.ts`/`.tsx` file under `src/`, excluding `*.test.ts`/`*.test.tsx`
and excluding `src/lib/db-locks.ts`, using the TypeScript compiler API
(`typescript` is already a devDependency).

Per file:

1. **Calls** — every call expression reaching `lockClassRowsOrdered`: by that
   name, by a local name an import specifier binds to it, as a member of an
   imported namespace (property access or string key), or through a wrapper that
   leaves the callee unchanged (`(f)(…)`, `f!(…)`). Read from the syntax tree,
   not from text, so a mention inside a comment or a string is not a call and a
   call without `await` still is one.
2. **Pairing, one for one** — group each call by its nearest enclosing **comment
   anchor** (a statement, or an object-literal or class member) and read that
   anchor's leading comment ranges. A group must hold **exactly one** call and
   **exactly one** marker. Zero markers is an unverdicted call; two or more is a
   verdict standing over nothing; two calls under one marker leaves one comment
   answering for two lock scopes with nothing saying which. A call with no
   anchor counts as unverdicted rather than being skipped.
3. **Orphans** — every raw occurrence of the marker text in the file must fall
   inside one of the comment ranges paired in step 2.
4. **Fixtures** — `takeCensus` takes its sources as an argument so every rule
   above can be exercised against shapes the repository does not contain. The
   live tree holds exactly one call shape, so without these the alias arm, the
   namespace arm, the grouping and the whole orphan direction are each
   deletable with the suite still green.

Report both directions in a single assertion whose failure names which way it
broke, modelled on `serial-tier-membership.test.ts`'s
`{ listedButNotMarked, markedButNotListed }`:

```
expect({ callSitesNotPairedOneToOne, verdictsWithoutCall })
  .toEqual({ callSitesNotPairedOneToOne: [], verdictsWithoutCall: [] })
```

Each entry a repo-relative `path:line`, sorted, so a failure is a location a
reader can open, with the two counts riding inside the first key's string —
`path:line (2 calls, 1 verdict)` — so a reader knows which of the four shapes it
is without opening the test.

### Non-vacuity, asserted separately and first

- `src/lib/db-locks.ts` exists. This labels a rename rather than preventing a
  failure — a renamed module drops out of the exclusion and its two marker
  occurrences (the `entries` docblock, and the re-derivation command) would
  otherwise surface as two unexplained orphans. Say so in the comment, the way
  `serial-tier-membership.test.ts` says it of its cwd guard.
- Both censuses are non-empty: at least one call found, at least one verdict
  found. A broken file walk empties both sides and would otherwise pass. Take
  the census ONCE and share it, so this guard and the pairing cannot disagree
  about what the tree held.
- Every area under `src/` holding production TypeScript is reached, compared
  against a walk written independently of `searchScope`'s filter. Non-emptiness
  is two totals and all four call sites sit in one directory, so a *partial*
  collapse leaves both totals healthy — measured: narrowing the scope to one
  file left every other assertion green.
- The two exclusions bite and neither is vacuous: no test file and not the
  defining module in scope, and both kinds present on disk.

Do **not** assert a count, a file list, or the four known paths. A roster here is
the thing `db-locks.ts:547` refuses and the thing this design exists to avoid;
it would also have to be edited by the very change the test is meant to catch.

### Self-exclusion

The marker text must be assembled from parts rather than written as one literal,
and the helper's name must not appear as a call. The `*.test.ts` exclusion
already keeps this file out of scope; assembling means that exclusion is not the
only thing standing between the test and reporting itself. State that reason in
a comment — it is the same move, and the same reason, as
`serial-tier-membership.test.ts`'s `MARKER`.

### Prove it bites — five mutations, each recorded

For each: apply, run the test, record the **exact** failure text, restore,
re-run and confirm green. Commit nothing while a mutation is applied.

1. **A fifth call site with no verdict.** Add a real call to a production file
   that has none today — `src/services/class-transitions.ts` imports neither the
   helper nor a verdict, so the mutation is one import and one statement. (It
   *mentions* the helper in two comments, lines 223 and 390, which is convenient:
   those are exactly the false positives a text census counts and this one must
   not.) Expect it in `callSitesNotPairedOneToOne` at its line.
2. **A verdict that outlives its call.** Delete one of the four call statements,
   leaving its verdict comment. Expect that verdict's line in
   `verdictsWithoutCall`, and confirm nothing lands in `callSitesNotPairedOneToOne`.
   Pick `class-template-lifecycle.ts:754`, whose return value is discarded, so
   typecheck stays green and the mutation isolates this test's verdict.
3. **A call the old grep would miss.** Change one existing call from
   `await lockClassRowsOrdered(` to a form without `await` — assign the promise,
   `await` it on the next line — *and* delete its verdict. Under that mutation
   both shipped greps return **three**, and they **agree**, so the test the issue
   asked for would pass on a tree with an unverdicted call site in it. This test
   must name that site. It is the mutation that demonstrates the departure from
   the issue's design, so its error text is the one the PR body quotes.

Then two guard mutations, same protocol:

4. **Empty the file walk — do not break it.** Point `searchScope` at a real
   directory that matches nothing (`prisma/migrations`), not at one that does not
   exist: a missing directory makes `readdirSync` throw `ENOENT` before any
   assertion runs, which proves nothing about the guard. The guard exists for a
   walk that goes *silently empty*. Expect the pairing assertion to **pass** on
   two empty sets and the non-vacuity assertion alone to go red. Run the throwing
   variant too, and record that it fails for the other reason.
5. **Inline the marker — and lift the `*.test.ts` exclusion with it.** Inlining
   alone leaves the suite green, because the exclusion keeps this file out of
   scope; the assembly is the *second* line of defence, so the first has to be
   down for the mutation to bite. Record the green run, then inline **and** lift
   the exclusion and expect this file's own marker in `verdictsWithoutCall`. Then
   the control: re-assemble the marker with the exclusion still lifted, and
   confirm that side empties while the genuine test-file call sites stand in
   `callSitesNotPairedOneToOne` — which is what proves the assembly, and not the
   exclusion, is doing the work.

Record all five in the commit message, with the exact error text of each.

### Done when

`npx vitest run --project unit src/lib/db-locks-verdict-census.test.ts` is green,
`npm run typecheck` and `npm run lint` are green, all five mutations are recorded
with their exact error text, and the tree is restored.

---

## Task 2 — amend the paragraph the tether sits beside

**File:** `src/lib/db-locks.ts`, the "NO ROSTER HERE" paragraph in
`lockClassRowsOrdered`'s docblock (currently around line 547).

The paragraph's reasoning is not being reversed — this tether holds no roster,
which is exactly why it can sit beside it. What is wrong after Task 1 is that the
paragraph reads as a refusal of any mechanical check, and one now exists.

Rewrite it to state, in this order:

- why there is still no caller list here (unchanged reasoning, unchanged
  conclusion);
- that the pairing is now enforced by `src/lib/db-locks-verdict-census.test.ts`,
  named by path — every call site has a verdict, every verdict has a call, and it
  fails rather than going stale;
- what is still **not** enforced: whether a verdict is *correct*, and whether the
  site carries a cross-owner decoy. #461 proved the four that exist; a fifth
  inherits the requirement to write a verdict, not the decoy.

Keep the re-derivation command at line 552 — a reader of the docblock still wants
the set — and leave `ClassLockSource.entries`'s docblock (around line 417)
pointing at the convention as it does.

Constraints:

- **State what is true now.** No "this previously read…", no reconstruction of
  how the paragraph came to need amending. That belongs in the PR body
  (CLAUDE.md, *Comment Discipline*).
- **No count, no roster, no member list** in the prose. "Every call site" is the
  claim; four is not.
- The pointer must be accurate: open the test file and confirm it says what the
  paragraph claims it says, rather than describing the plan.

### Sweep for what this invalidates

Search for prose making the now-amended claim — that the call-site set is checked
by nothing, or held by convention alone. **Every hit gets a written verdict, and
a verdict of "survivor" needs its reason.** Expect most to survive; a hit about
`lockClassRow` (singular), or about the *decoys* rather than the verdicts, is a
survivor by construction.

Three targets are already located and must each be answered by name — the spec's
"What the amendment invalidates elsewhere" section states what is at stake in
each, so read that before deciding:

1. `src/lib/rule-slot-holder.ts:51` — a second "NO ROSTER HERE" paragraph opening
   *"for the reason `db-locks.ts` spends a paragraph on"*. **Open the amended
   paragraph and check the pointer still lands**, rather than assuming it does.
2. `docs/lock-order.md:79` — the third shipped census (`grep -rn
   'lockClassRowsOrdered(' src --include='*.ts' | grep -v '\.test\.ts' | grep -vE
   ':[0-9]+: *(//|\*)'`), measured returning five: the definition plus four
   callers. Re-run it and confirm.
3. `docs/lock-order.md:1376` — "a convention enforced by a grep and a test … the
   same standing … `lockClassRowsOrdered` has for `Class`", which compares the
   template families' convention to this one.

Then sweep beyond those three yourself: `src/lib/db-locks.ts` says "No roster
here" in more than one place (line 191 is one), and the four call sites carry
their own prose. `docs/lock-order.md` mentions the helper ~30 times. Do not edit
a hit that is merely *related*; edit only one this branch made **inaccurate**.

### Done when

The paragraph is accurate against the test as written, the sweep's hits each have
a recorded verdict, and `npm run typecheck` / `npm run lint` are green.
