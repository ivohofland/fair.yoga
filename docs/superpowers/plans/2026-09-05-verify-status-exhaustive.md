# Tethering `/verify`'s status dispatch to the compiler (#449)

One task, one file. No spec: the issue is explicit, its premise verified below,
and there is one reasonable approach — the `const unhandled: never` idiom this
repo already uses at fifteen sites.

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
the two cannot be merged — `case 'verifying': default:` narrows `status` to
`'verifying'` rather than `never`, so the tether would not compile. Both arms
return the same expression; hoisting it to one `const` above the switch gives
the `railVisible` comment a single home instead of two copies.

**The idiom has two runtime shapes, not one.** `template-action-messages.ts:417`
throws. `format.ts:55` logs and falls back, and its docblock argues the throw it
replaced was *strictly worse* there: a render-time throw takes down the whole
page, and the app's only error boundary logs nothing. `/verify` is the sign-in
page and the same reasoning applies, so this plan takes `format.ts`'s shape.
Agreed with the issue's author before planning.

That said — the `default` here is unreachable by construction, unlike
`format.ts`'s. `PaymentStatus` arrives from the database, where enum/deploy
drift is a real path; `Status` is local `useState`, written only by the six
literals in this file. Nothing outside it can put a seventh value in that
variable. The runtime shape is therefore a choice about which pattern the next
maintainer copies, not about a live failure. The compile-time tether is the
whole deliverable.

## Task 1 — convert the dispatch to an exhaustive `switch`

**File:** `src/app/(public)/verify/page.tsx`, `VerifyContent`'s render.

Replace the six-line `if` chain and its fall-through with:

- A `const` above the switch holding `railVisible ? <VerifyingState /> : null`,
  carrying the existing four-line `railVisible` comment unchanged.
- `switch (status)` with one `case` per member — `error`, `timeout`,
  `already-signed-in`, `success`, `handoff`, `verifying` — each returning
  exactly what its `if` returned today, with the same props.
- A `default` block that assigns `status` to a `const unhandled: never`, logs
  via `console.error` with the `[verify]` prefix the rest of the file uses, and
  returns the hoisted rail. `console.error` and not `@/lib/log`: that module is
  pino and server-only, and this file is `'use client'`.

The `never` binding must be *used* (in the log payload, as `format.ts` does) —
`@typescript-eslint/no-unused-vars` is `'error'` in `eslint.config.mjs:12`, so
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

A second mutation, *removing* a member (`'handoff'`), was run and its result
corrects this plan's original framing. It was written here as proving the
tether "is not one-directional". It proves no such thing: the removal was run
against HEAD's `if`-chain as well, and that chain catches it too —
`TS2367: This comparison appears to be unintentional because the types
'"verifying"' and '"handoff"' have no overlap`. Removal was never the gap,
because an equality test against a literal is already checked against the
union. Only ADDITION was unguarded, and only addition is what this change
buys. The second mutation stays in the record as the measurement that
established that, not as evidence for the switch.

All mutations are edits to the union on line 9 only. None is committed.

### Regression coverage

`page.test.tsx` (the `components` project — jsdom, no database, no dev server)
already exercises the rendered outcome of every status through the public
behaviour of the page. Those tests are the check that the six arms still render
what they rendered; they must pass unedited. Adding a test that asserts "a
future omission fails to compile" is not possible from inside the suite — the
type system is the assertion, which is why the mutation above is the evidence.

## Verification

Run in the worktree, which has no database and no dev server:

- `npx tsc --noEmit` — exit 0
- `npx eslint src/app/\(public\)/verify/page.tsx` — clean, and specifically not
  reporting the `never` binding as unused
- `npx vitest run --project components src/app/\(public\)/verify/page.test.tsx`
  — all pass, unedited
- `npx vitest run --project unit --project components` — the tiers a worktree
  can run

`--project integration` and Playwright are **not** run locally: both are
hard-wired to the dev server on `:3000` and the shared dev database, neither of
which exists in a worktree. This change touches no route, service, schema or
migration — only the render of one client component — so nothing in those tiers
is reachable from the diff. CI is the signal for them; cite that run in the PR
body, not a local one.
