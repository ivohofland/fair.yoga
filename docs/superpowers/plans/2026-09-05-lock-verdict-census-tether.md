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

1. **Calls** — every call expression whose callee is the identifier
   `lockClassRowsOrdered`. Read from the syntax tree, not from text, so a
   mention inside a comment or a string is not a call and a call without `await`
   still is one.
2. **Pairing** — for each such call, walk up to the nearest enclosing statement
   and collect that statement's leading comment ranges. The call is *verdicted*
   when at least one of those ranges contains the marker text. A call with no
   enclosing statement counts as unverdicted rather than being skipped.
3. **Orphans** — every raw occurrence of the marker text in the file must fall
   inside one of the comment ranges paired in step 2.

Report both directions in a single assertion whose failure names which way it
broke, modelled on `serial-tier-membership.test.ts`'s
`{ listedButNotMarked, markedButNotListed }`:

```
expect({ callsWithoutVerdict, verdictsWithoutCall })
  .toEqual({ callsWithoutVerdict: [], verdictsWithoutCall: [] })
```

Each entry a repo-relative `path:line`, sorted, so a failure is a location a
reader can open.

### Non-vacuity, asserted separately and first

- `src/lib/db-locks.ts` exists. This labels a rename rather than preventing a
  failure — a renamed module drops out of the exclusion and its two marker
  occurrences (the `entries` docblock, and the re-derivation command) would
  otherwise surface as two unexplained orphans. Say so in the comment, the way
  `serial-tier-membership.test.ts` says it of its cwd guard.
- Both censuses are non-empty: at least one call found, at least one verdict
  found. A broken file walk empties both sides and would otherwise pass.

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

### Prove it bites — three mutations, each recorded

For each: apply, run the test, record the **exact** failure text, restore,
re-run and confirm green. Commit nothing while a mutation is applied.

1. **A fifth call site with no verdict.** Add a real call to a production file
   that has none today — `src/services/class-transitions.ts` is a service that
   imports neither the helper nor a verdict, so the mutation is one import and
   one statement. Expect it in `callsWithoutVerdict` at its line.
2. **A verdict that outlives its call.** Delete one of the four call statements,
   leaving its verdict comment. Expect that verdict's line in
   `verdictsWithoutCall`, and confirm nothing lands in `callsWithoutVerdict`.
   (Deleting the statement will also fail typecheck where its return value is
   used — pick `class-template-lifecycle.ts:754`, whose result is discarded, so
   the mutation isolates this test's verdict.)
3. **A call the old grep would miss.** Change one existing call from
   `await lockClassRowsOrdered(` to a form without `await` — e.g. assigning the
   promise and awaiting it on the next line — *and* delete its verdict. The
   shipped `await`-anchored grep reports four either way; this test must report
   five call sites' worth of pairing and name the unverdicted one. This is the
   mutation that demonstrates the departure from the issue's design, so its
   error text is the one the PR body quotes.

Then two guard mutations, same protocol:

4. Break the file walk (point it at a directory that does not exist) and confirm
   the non-vacuity assertion fails rather than the census passing empty.
5. Inline the marker as a single literal and confirm the test reports itself.

Record all five in the commit message.

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

After the edit, search for other prose making the now-amended claim — that the
call-site set is checked by nothing, or that it is held by convention alone.
Search at least `src/lib/db-locks.ts` (it discusses the register in more than one
place), `docs/lock-order.md`, `docs/solve-issue-lessons.md`, and the four call
sites' own comments. Give every hit a verdict; expect legitimate survivors, and
say which and why. A hit that is about `lockClassRow` (singular) or about the
*decoys* rather than the verdicts is a survivor, not a defect.

### Done when

The paragraph is accurate against the test as written, the sweep's hits each have
a recorded verdict, and `npm run typecheck` / `npm run lint` are green.
