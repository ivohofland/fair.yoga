# Tethering `/verify`'s status dispatch to the compiler (#449)

One task, one file. No spec: the issue is explicit, its premise verified below,
and there is one reasonable approach — the `const unhandled: never` idiom this
repo already uses widely. The census, and the command that re-derives it:

```
grep -rEn 'const [A-Za-z]+: never = ' src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'
```

29 sites at `d804d55e`, 30 with this change. This sentence first said "fifteen
sites", read off a `grep` whose output `head` had truncated — a `grep | head`
reported as a census, which is the failure this project's lessons name. The
argument ("the repo already has this idiom") never needed the number; it ships
now only because it ships with the command.

## What was verified before planning

Measured on `main` at `d804d55e`, in a worktree branched from it.

| Issue's claim | Verdict |
|---|---|
| `Status` has six members, `'timeout'` the newest | Holds — `page.tsx:9` |
| The dispatch is `if`-returns with no exhaustiveness tie | Holds — `page.tsx:686-703` |
| The repo has a `switch` + `never`-default idiom to match | Holds, with a fork — see below |
| `Status` is not exported | Holds — the change cannot reach another file |

Baseline `npx tsc --noEmit`: exit 0, zero lines of output.

### Two things the issue does not say

**The fall-through is not a dead catch-all.** `return railVisible ?
<VerifyingState /> : null` is the `verifying` render. The conversion therefore
splits one line into a `case 'verifying'` and a genuinely-new `default`, and
the two cannot be merged into one arm — `case 'verifying': default:` narrows
`status` to `'verifying'` rather than `never`, so the tether would not compile.
What the `default` should return instead is a decision this plan has to make
rather than inherit, and the review changed the answer; see *What the review
changed* below.

**The idiom has two runtime shapes, not one.** `template-action-messages.ts`
throws at its `never`. `format.ts` logs and falls back, and its docblock argues
the throw it replaced was *strictly worse* there: that module is called during
the render of an async server component with `force-dynamic`, so a throw took
down a student-facing page on every request, and neither error boundary in this
app (`src/app/error.tsx`, `src/app/global-error.tsx`) logs anything. This plan
takes `format.ts`'s log-and-fall-back shape. Agreed with the issue's author
before planning.

That said — the `default` here is unreachable by construction, unlike
`format.ts`'s. `PaymentStatus` arrives from the database, where enum/deploy
drift is a real path; `status` is local `useState`, written only by the
`setStatus` literals in this file and the ternary that initialises it. Nothing
outside the file can put a seventh value in that variable. The runtime shape is
therefore a choice about which pattern the next maintainer copies, not about a
live failure. The compile-time tether is the whole deliverable.

## Task 1 — convert the dispatch to an exhaustive `switch`

**File:** `src/app/(public)/verify/page.tsx`, `VerifyContent`'s render.

Replace the six-line `if` chain and its fall-through with:

- `switch (status)` with one `case` per member — `error`, `timeout`,
  `already-signed-in`, `success`, `handoff`, `verifying` — each returning
  exactly what its `if` returned today, with the same props. The `verifying`
  arm keeps the existing four-line `railVisible` comment.
- A `default` block that assigns `status` to a `const unhandled: never`, logs
  via `console.error` with the `[verify]` prefix the rest of the file uses, and
  returns `<ErrorState />` (see *What the review changed*). `console.error` and
  not the app logger, because this file is `'use client'`.

The `never` binding must be *used* (in the log payload, as `format.ts` does) —
`@typescript-eslint/no-unused-vars` is `'error'` in `eslint.config.mjs:13`, so
an unused one fails lint rather than compiling.

**Behavior must not change for any of the six members.** A `switch` on a
discriminant has no ordering semantics to preserve, and every arm today is an
equality test on the same variable, so the arms are already mutually exclusive.

**No comment may claim a member count.** Per *Comment Discipline*, the comment
on the `default` says what the branch is for; the union itself is the roster,
and the `never` is the tether. A sentence like "all six statuses" would rot on
the seventh.

### Proving the guard bites (§3)

The acceptance criterion is a compile-time property, so the test is a mutation,
recorded here rather than committed:

1. Temporarily add a seventh member to `Status` (a value the code cannot
   produce, so nothing can accidentally route to it).
2. Run `npx tsc --noEmit`. It must fail, and the error must land **on the
   `never` assignment in the `default`** — not merely somewhere in the file.
   Record the exact error text in the PR body.
3. Revert the member. Re-run `npx tsc --noEmit`; it must return to exit 0.

Every mutation is run against BOTH the new `switch` and HEAD's `if`-chain,
because a mutation the old code already caught measures nothing this change
bought. Three directions, and the control is what separates them:

| Mutation | Old `if`-chain | New `switch` | New coverage? |
|---|---|---|---|
| Add a member, no arm | exit 0 — silent | `TS2322` at the `never` | **yes** |
| Delete an arm, keep the member | exit 0 — silent | `TS2322` at the `never` | **yes** |
| Remove a member entirely | `TS2367` no overlap | `TS2678` not comparable | no |

The third row corrects this plan's first draft, which offered a member-removal
mutation as proof the tether ran in both directions. It is not proof of
anything: an equality test against a string literal is already checked against
the union, so the old chain caught that too. The row that matters and was
missed on the first pass is the second — deleting an arm while its member
stands, which the old chain compiled clean and which is the likelier human
error of the two.

All mutations are edits to the union on line 9 or to a single `case` arm.
None is committed.

### Regression coverage

`page.test.tsx` (the `components` project — jsdom, no database, no dev server)
exercises the rendered outcome of every status through the public behaviour of
the page, and those tests are the check that the arms still render what they
rendered. They must pass unedited.

One arm is not fully covered there, and the review found it by mutation rather
than by reading: `home`, the only prop on the `already-signed-in` arm, could be
set to `''`, to `redirectTo`, or hard-coded to the wrong family's path with the
suite staying green. `''` renders `href=""`, which sends a reader who IS signed
in back to the spent link they just came from, and the student half of
`AlreadySignedInState`'s wording ternary had no test at any tier. This plan
adds two cases pinning that link's accessible name and `href`, each verified to
fail under all three mutations. The gap predates this change — the old line was
identical — but the claim "the suite is the regression check" is this change's
own, so it should be true.

Adding a test that asserts "a future omission fails to compile" is not possible
from inside the suite — the type system is the assertion, which is why the
mutation table above is the evidence.

## What the review changed

**The `default` returns `<ErrorState />`, not the verifying rail.** The plan
first said the rail, on the reasoning that it mirrored the old fall-through
exactly. Review pointed out that this copied `format.ts`'s *shape* while
inverting its *value* criterion: `format.ts` picks its fallback because it is
the calmest state available and never overclaims, whereas the rail is the most
committal screen on the page — a progress step marked in-progress, and a line
offering the reader's connection as the reason for a delay that is not
happening. Worse, issue #449 names the indefinite "Checking your link" as the
defect itself, so the safety net reproduced the thing it guards against.

Two consequences followed. The rail is no longer hoisted to a `const`, because
only one arm returns it now — which also retires the comment explaining why the
two arms could not be merged, a comment that would have been false the moment
the fallback changed. And the argument against throwing had to be rewritten: it
originally said a throw "trades a working rail for a blank screen", which is
wrong twice over. `src/app/error.tsx` renders visible copy and a Try again
button, so a throw is not blank; and the rail arm returns `null` before the
rail is due, so the *fallback* was the branch that could render nothing.

## Verification

Run in the worktree, which has no database and no dev server:

- `npx tsc --noEmit` — exit 0
- `npx eslint src/app/\(public\)/verify/page.tsx` — clean, and specifically not
  reporting the `never` binding as unused
- `npx vitest run --project components src/app/\(public\)/verify/page.test.tsx`
  — all pass: the 34 pre-existing cases unedited, plus the 2 added for `home`
- `npx vitest run --project unit --project components` — the tiers a worktree
  can run

`--project integration` and Playwright are **not** run locally: both are
hard-wired to the dev server on `:3000` and the shared dev database, neither of
which exists in a worktree. This change touches no route, service, schema or
migration — only the render of one client component — so nothing in those tiers
is reachable from the diff. CI is the signal for them; cite that run in the PR
body, not a local one.
