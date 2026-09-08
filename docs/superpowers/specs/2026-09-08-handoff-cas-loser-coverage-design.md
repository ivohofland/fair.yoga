# Deterministic coverage for `verifyWithHandoff`'s CAS-loser branch — design

**Issue:** #514 — "`verifyWithHandoff`'s compare-and-swap loser branch is
covered only when the race happens to interleave"
**Branch:** `fix/514-handoff-cas-loser-coverage`, from `origin/main` at
`b94c932b`
**Date:** 2026-09-08
**Measured on:** darwin 25.6.0, arm64, node v22.22.2, vitest 4.1.10, Postgres
16.12 (`fairyoga-db-1`), database `ethical_yoga_test`

---

## 1. The issue's premise, checked

### 1.1 The code the issue cites is unchanged — HOLDS

`src/lib/auth/handoff.ts:69-80` matches the issue's quotation exactly, same
line numbers. The intervening work on this file (#509's staged-race branch,
#512, #513) touched only `handoff.test.ts` and one comment block in
`handoff.ts` (the `expectedReaps` docblock, lines 163-171 in that branch's own
numbering) — nothing in the CAS itself.

### 1.2 The only writer of `handoffCode` is this CAS — HOLDS, and narrows the fix

```
grep -rn "handoffCode" src --include="*.ts" | grep -v ".test.ts"
```

Every hit: `handoff.ts:58` (read, reuse branch), `:70-71` (the CAS, the only
write), `:77-78` (read, loser branch), `:124` (read, `claimWithCode`'s
candidate filter), `:156` (read, code match), and one route (`:46`, reads the
outcome). `generateHandoffCode()` always returns a zero-padded 6-digit string
— never empty, never null.

This means `stamped.count === 0` splits into exactly two reachable shapes,
not the three a first reading suggests:

- **The row still exists, `handoffCode` now non-null.** Some other call won
  the CAS and stamped a code — line 78's arm.
- **The row no longer exists.** `winner` is `null` — line 77's arm.
- **The row exists with `handoffCode` falsy.** Given the single-writer census
  above, this shape cannot occur: the only writer of a non-null value writes
  a well-formed 6-digit string, and nothing else writes to the column. This
  is the "written argument for why it is unreachable" the issue's acceptance
  criteria ask for, for the sub-case the `!winner?.handoffCode` check also
  guards against. It is **not** an argument that line 77 itself is
  unreachable — see 1.4.
  The truthiness check itself defends against an out-of-band writer of the
  column — a manual `psql` edit, a future backfill migration — that no
  application code path can produce; it costs nothing to keep, since the
  `?.` null-guard is required regardless and the truthiness check is the
  same expression, so it stays.

### 1.3 What deletes the row, and who can race it

`consumeTokenRow` (`magic-link.ts:81`) is the only deleter, called from two
places: `verifyWithHandoff`'s own `sameBrowser` branch (`handoff.ts:42`, a
matching-nonce open of the SAME token) and `verifyMagicLinkToken`
(`magic-link.ts:131`, a different code path entirely). Either can delete this
exact row between this call's `findUnique` and its CAS `updateMany`, which is
the mechanism behind line 77's arm (1.4).

### 1.4 "Not measured" — measured, and the finding needs one correction

The issue asks, before fixing, to instrument `handoff.ts:74` and record how
often the CAS-loser branch fires across full `unit` runs, and to say so if it
turns out to fire reliably. Done: a temporary `process.stderr.write` at the
`stamped.count === 0` branch, running the existing loop test
(`'the race: concurrent first-opens of the same link agree on one code'`,
8 iterations per run) three times:

| run | CAS-loser hits (of 8 iterations) |
|---|---|
| 1 | 8 |
| 2 | 8 |
| 3 | 8 |

**24 of 24.** On this machine, `Promise.all([verifyWithHandoff(...),
verifyWithHandoff(...)])` reliably interleaves: both calls run their
synchronous prefix up to the first `await` (the `findUnique`) before either's
DB round-trip returns, so both see `handoffCode: null` and both reach the
CAS. This is the same mechanism §1.2 of the `#509` spec
(`docs/superpowers/specs/2026-09-08-handoff-race-staging-design.md`) measured
for a different test in this file.

**Correction to the issue's framing, per its own instructions in "Not
measured":** the branch is not silently *never* executed — it fires reliably
in this test today. What the issue's coverage argument does not depend on,
and remains true regardless: the test's assertion (`a.code === b.code`) is
satisfied whether or not the branch runs (§1.5), so nothing about the test
*passing* certifies the branch ran — the 24/24 above is an artifact of this
JS runtime's microtask scheduling against this machine's DB latency, not a
guarantee the code makes. A CI runner, a slower or faster database, or a
future edit that adds an `await` before the `findUnique` could all change the
empirical rate without the test noticing.

**The stronger, decisive point is §1.3, not §1.4:** the existing test only
ever stages two `null`-nonce calls. In that shape, a losing CAS always finds
the row still present — the winner *wrote* to it, never deleted it. So
**line 77's arm is unreachable by the existing test under any interleaving,
serialized or not** — not a rate question at all. That is the gap this
branch actually closes for line 77; §1.5 covers line 78's arm, where the rate
question is the live one.

### 1.5 Option A from #509's spec, re-applied here — the interleaving-independent test doesn't certify the CAS either

By the same derivation #509's spec §1.4 uses: run the two `null`-nonce calls
fully serialized. Call 1's `findUnique` reads `handoffCode: null`, its CAS
wins, returns `{kind: 'handoff', code}`. Call 2's `findUnique` now reads a
non-null `handoffCode` and returns at line 58 (the reuse branch) —
**never reaching the CAS at all.** `a.code === b.code` holds under this
ordering too (both read the same persisted code, one via the CAS write, one
via the reuse read), so the assertion cannot distinguish "the CAS loser
branch ran and returned the winner's code" from "the CAS never ran a second
time." A mutation of the CAS's `where` clause (§4) would not necessarily
fail this test, because the reuse branch at line 58 short-circuits before the
CAS on a serialized ordering regardless of what the CAS does.

---

## 2. The fix: stage both races the way #509 staged its four

`src/lib/auth/handoff.test.ts` already has the idiom for this — a
`prisma.$extends` query hook that interposes a real sibling call at the exact
statement boundary a race requires, four times over
(`'warns when the matched row is consumed between the snapshot and the
increment'` is the closest template: same function family, same
"hook `updateMany`, run the sibling on the *unhooked* client before
`query(args)`" shape). This branch adds two more, for `verifyWithHandoff`
instead of `claimWithCode`, replacing nothing — the issue's acceptance
criteria require the existing loop test to survive unchanged, and unlike
#509's four, this branch's two staged tests reach code the loop test cannot
reach at all (line 77) or reach only by an interleaving nothing guarantees
(line 78), so there is no timing-dependent twin to retire.

**Two tests, one per shape from §1.2:**

1. **The winner arm (line 78).** Hook `magicLinkToken.updateMany` on a token
   minted with no matching nonce available to the outer call. Before
   `query(args)` runs, the hook issues the sibling's whole `verifyWithHandoff(db,
   token, null)` call on the unhooked client — it reads `handoffCode: null`
   (our call hasn't written yet), wins its own CAS, and returns
   `{kind: 'handoff', code}`. The outer call's `query(args)` then runs against
   a row whose `handoffCode` is already non-null and matches zero rows,
   forcing `stamped.count === 0` deterministically. Assert the outer call
   returns exactly the sibling's outcome, and that the persisted row's
   `handoffCode` is the sibling's code — proving the loser truly returned
   the winner's value rather than a coincidentally-equal one.

2. **The invalid arm (line 77).** Same hook point, but the interposed
   sibling is `verifyWithHandoff(db, token, <the token's own matching
   nonce>)` — the `sameBrowser` branch, which calls `consumeTokenRow` and
   deletes the row entirely before `query(args)` runs. The outer call's CAS
   matches zero rows (the row is gone, not merely stamped), `winner` reads
   back `null`, and the `!winner?.handoffCode` guard returns `{kind:
   'invalid'}`. Assert the sibling resolved to `{kind: 'verified', ...}`
   (proving the deletion staging worked, the same "staging that collapsed
   fails here as itself" pattern the template test uses) and the outer call
   resolved to exactly `{kind: 'invalid'}`.

Both hooks count their own invocations (`hookCalls`) and assert
`toBe(1)`, matching every existing hook in this file — a hook that stops
firing must fail loudly rather than stage nothing.

No comment in `handoff.ts` names a test by title for this branch to correct
(unlike #509's `expectedReaps` docblock), so Comment Discipline's "correct a
claim in every artifact" has nothing to retire here.

---

## 3. Mutation plan — each guard broken, restored, re-verified

Per rule #3 (`docs/solve-issue-lessons.md#3-prove-every-guard-bites`), every
guard the new tests pin gets broken on purpose, the exact failure text
recorded, then restored.

| test | mutation | `handoff.ts` location | expected failure |
|---|---|---|---|
| winner arm | drop the CAS condition: `where: { id: row.id, handoffCode: null }` → `where: { id: row.id }` | `:70` | the outer call's write now succeeds unconditionally, overwriting the sibling's stamp with its own code — `loser` no longer equals `sibling`, and the persisted row's `handoffCode` is the outer call's code instead of the sibling's |
| invalid arm | drop the guard: `if (!winner?.handoffCode) return { kind: 'invalid' }; return { kind: 'handoff', code: winner.handoffCode };` → `return { kind: 'handoff', code: winner?.handoffCode ?? '' };` | `:77-78` | with `winner` null (the row was deleted), the outer call resolves to `{kind: 'handoff', code: ''}` instead of `{kind: 'invalid'}` |

Both mutations are recorded with their exact `expect` failure output in the
task's commit body, then reverted and re-verified green, with `git diff
--stat src/lib/auth/handoff.ts` confirming the restore left the file
unchanged.

---

## 4. Out of scope

- **The `counts both attempts when two wrong guesses race concurrently`
  5000 ms stall** (#512) — different function, already fixed on `main`.
  Unaffected by this branch.
- **#509's four staged tests and the `expectedReaps` comment** — already on
  `main`. This branch's two new tests sit in the `describe('verifyWithHandoff',
  ...)` block, disjoint from `describe('claimWithCode', ...)` where #509's
  tests live; no interaction.
- **Re-deriving whether #509's own tests are still sound** — out of scope;
  this issue is scoped to `verifyWithHandoff`'s CAS, not `claimWithCode`'s
  guards.

---

## 5. Verification

1. Both new tests pass without a `for` loop or bare `Promise.all` — a single
   staged call each.
2. Each guard's mutation (§3) produces the recorded failure, then reverts to
   green.
3. The existing loop test (`'the race: concurrent first-opens…'`) is
   byte-for-byte unchanged — the acceptance criteria require it kept, not
   merely passing.
4. `npm run typecheck`, `npm run lint`, and `npx vitest run --project unit
   src/lib/auth/handoff.test.ts` are green.
5. Full `unit`, `unit-sweeps`, and `components` tiers stay green (this branch
   touches one file; a regression elsewhere would be a signal, not an
   expectation).
6. Integration and e2e cannot run from this worktree (no `:3000`, no dev
   database) — CI is the signal for those tiers, cited by run in the PR body.
