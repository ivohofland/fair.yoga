# Staged interleavings instead of hoped-for ones (#509) — design

**Issue:** #509 — "`handoff.test.ts`'s over-count race warn is ~25% flaky in the
parallel `unit` tier"
**Branch:** `fix/509-handoff-race-flake`, from `origin/main` at `42d259af`
**Date:** 2026-09-08
**Measured on:** darwin 25.6.0, 10 physical cores, node v22.22.2,
vitest 4.1.10, Postgres 16 (`fairyoga-db-1`), database `ethical_yoga_test`

---

## 1. The issue's premise, checked

Five claims, each measured. **Three hold. The two that decide the fix do not.**

### 1.1 The flake is real — HOLDS

Reproduced on this branch's base, unmodified:

```
npx vitest run --project unit --project components      # ×12
```

| Runs | Failures | Which test |
|---|---|---|
| 12 | 1 | `warns on an over-count when two concurrent candidates both cross the budget together` |

Same failure text the issue reports: the `deleteMany` over-count warn never
fires across the test's eight iterations, and the only `log.warn` call recorded
is the `updateMany` under-count one. ~8% here against the issue's ~25%; the
difference is machine load, not mechanism, and the rate is not what the fix
turns on.

### 1.2 Isolation *reduces* it — the issue's "0%" is wrong, and the gap is the whole argument

The issue reports 0 failures in 5 isolated runs and concludes "**0% isolated**
— so tier contention is the trigger, not an inherent property of the staged
race". Five runs cannot separate 0% from a few percent, and 78 do:

```
npx vitest run --project unit src/lib/auth/handoff.test.ts    # the file alone
```

| batch | runs | failures |
|---|---|---|
| A | 20 | 1 — `counts both attempts when two wrong guesses race concurrently`, **5000 ms timeout** (§7) |
| B | 30 | 0 |
| C | 3 | 1 — name not captured; the run's `tests` time was 5.74 s against 692 ms / 699 ms for its two neighbours, which matches batch A's timeout signature |
| D | 25, `--reporter=verbose --testTimeout=30000` | 1 — **the over-count test itself**, failing its assertion in 128 ms, no timeout involved |

**The over-count test fails 1 run in 78 with no neighbours at all**, against 1
in 12 in the tier. Isolation clearly reduces the rate — but with one failure
on each side, no multiplier those two numbers imply is worth stating, which is
the same restraint this section faults the issue for skipping. The load-bearing
half needs no ratio: isolation does not buy zero, and it cannot, because
nothing about running alone forces the particular interleaving the assertion
needs (§1.4). This is the measurement the issue's recommendation rests
on, and it does not support it — §1.5.

### 1.3 #508 did not cause it — HOLDS

`gh pr view 508 --json files` returns exactly three paths — `magic-link.ts`,
`magic-link.test.ts`, and a plan doc. Neither `handoff.ts` nor
`handoff.test.ts` is among them, and the miss branch this test exercises
returns at `handoff.ts:194`, before the `consumeTokenRow` call at `:197` that
#508 edited. Provenance likewise: `git show --stat 9c76c191` touches
`handoff.test.ts` (+85 lines), as the issue says.

### 1.4 Option A does not fix the flake — the issue's premise is WRONG

The issue offers **A. Make the assertion admit either interleaving** and
rejects it for weakening the pin. It should be rejected for a stronger reason:
**it does not fix the flake.** Under *full* serialization of the two calls
neither warn fires, so "assert that one of the two fired" is flaky too.

Derivation, for the over-count fixture (candidate `A` at
`HANDOFF_MAX_ATTEMPTS - 2 = 3`, candidate `B` at `- 1 = 4`, both live, one
wrong guess each). Call 2 begins only after call 1 has returned:

| | call 1 | call 2 |
|---|---|---|
| `findMany` | `[B(4), A(3)]`, `spent = []` | `[A(4)]` — `B` is gone |
| `expectedReaps` | 1 (`B`: 4+1 ≥ 5) | 1 (`A`: 4+1 ≥ 5) |
| `updateMany` | `A→4`, `B→5`; count 2 = 2 ✓ | `A→5`; count 1 = 1 ✓ |
| `deleteMany` | reaps `B`; 1 = 1 ✓ | reaps `A`; 1 = 1 ✓ |
| warns | none | none |

Every guard in `claimWithCode` compares a count against a prediction derived
from *this call's own snapshot*. Serialized, every prediction is correct, so
**no warn is reachable at all** — and an assertion that any warn fired is an
assertion about scheduling. A weakened assertion is a smaller target, not a
different kind of target.

**The failure §1.1 actually observed is a partial ordering, not this one.**
There, both calls took their snapshots and then call 1 ran to completion, so
call 2's `updateMany` found one row already gone and warned the under-count —
the single `log.warn` the failure reports. That ordering reaches no direction
of the `deleteMany` guard either: call 2 predicts one reap and takes exactly
one. So option A would have failed on that run too. The table above is
therefore the stronger statement rather than the observed one, and what
running alone cannot force is the *particular* interleaving the assertion
needs, not interleaving as such.

### 1.5 Option B puts a false claim in the marker, and would not fully fix it either — the issue's premise is WRONG

The issue's recommendation is **B. Move `handoff.test.ts` into
`LOCK_CONTENTION_TESTS`**, on the grounds that `vitest.tiers.ts` "already names
this exact category". It does not. Two problems, either one disqualifying.

**First, the category is lock timing, and this file has none.** The list's own
header says *"Files that cannot run in `unit`'s parallel tier because of LOCK
TIMING — either they create it or they measure it"*, and membership is held by
a marker that spells it: `@serial-tier lock-contention`, in each file's own
header, tethered by `src/lib/serial-tier-membership.test.ts`. `handoff.ts`
opens no transaction, takes no explicit lock, and asserts on no SQLSTATE;
`claimWithCode`'s three writes are autocommit statements. Measured over the list:

```
npx tsx -e "
import {LOCK_CONTENTION_TESTS} from './vitest.tiers';
import {readFileSync} from 'node:fs';
const RE = /\\\$transaction|FOR UPDATE|FOR KEY SHARE|40P01|55P03|pg_advisory|lockClassRowsOrdered|setLockTimeout/;
for (const f of LOCK_CONTENTION_TESTS) if (!RE.test(readFileSync(f,'utf8'))) console.log('no lock machinery:', f);
console.log('handoff.test.ts:', RE.test(readFileSync('src/lib/auth/handoff.test.ts','utf8')));
"
```

**17 of 17 members** name a transaction or a lock primitive in their own source
text; `handoff.test.ts` and `handoff.ts` name neither. (This is a syntactic
measurement standing in for the semantic claim, and the list's own header warns
that lock-shaped searches have false negatives — so read it as corroboration of
the 17 marker sentences, which were also read one by one, not as the argument.)
Writing `@serial-tier lock-contention` into this file's header would put a
claim there that its own code contradicts.

**Second - and this is the disqualifying half - serialization is a probability
reduction, not a fix.** §1.2 measures the very test the issue is about failing
with the file running alone. The serial tier removes neighbours; it does not
make two promise chains interleave, and the assertion stays an assertion about
scheduling (§1.4). Option B would trade serial-tier wall time for a flake that
still lands, roughly once every 78 merge-gate runs, with no remaining lever to
pull - and it would have been shipped believing the rate was zero, because the
5-run measurement it rests on cannot see 1.3%.

---

## 2. The shape, not the line

Four tests in this file assert that a `log.warn` fired as a consequence of a
hoped-for interleaving. **One of them is the reported flake; the other three
are the same construction and are latent.** Each stages a race in a
`for (let i = 0; i < 8; i++)` loop and asserts, after the loop, that a
particular warn was called at least once — and each, run serially, produces no
warn at all by the §1.4 derivation:

| line | test | asserted warn | serialized outcome |
|---|---|---|---|
| 343 | `the race: a correct claim concurrent with wrong guesses never throws` | `updateMany` under-count | correct claim deletes the row first, or last; either way no candidate vanishes mid-write → no warn |
| 370 | `warns when two concurrent wrong guesses race the same near-exhausted candidate` | `deleteMany` reap mismatch | call 1 reaps its own prediction; call 2 finds no candidates → no warn |
| 396 | `warns when two concurrent claims both try to reap the same already-spent candidate` | spent-cleanup mismatch | call 1 reaps the spent row as predicted; call 2 finds no candidates → no warn |
| 440 | `warns on an over-count when two concurrent candidates both cross the budget together` | `deleteMany` over-count | §1.4's table → no warn |

Fixing line 440 alone leaves three tests that fail for the same reason on a
sufficiently loaded machine. The diagnosis generalises, so the fix does.

**Line 343 is different in one way that matters:** its *primary* assertion —
every outcome is `verified` or `invalid`, nothing throws — holds under **every**
interleaving. Only the warn assertion appended to it is timing-dependent.

---

## 3. The census: this file, and nothing else

Genus: *a test whose assertion is only satisfied by some interleavings of a
concurrent execution it does not control.*

```
for f in $(grep -rl 'Promise\.all' src tests --include='*.test.ts'); do
  grep -qE 'for \(let i = 0; i < [0-9]+' "$f" && echo "$f"
done
```

29 test files use `Promise.all`. Under `src/**` the loop filter leaves exactly
one: `src/lib/auth/handoff.test.ts`. Widened to hits that pair `Promise.all`
with a log-spy assertion, three more appear, and all three are non-members:

| hit | verdict |
|---|---|
| `src/services/gdpr.test.ts` | **Not a member.** Its only `Promise.all` is inside a comment (`:1200`). |
| `src/services/studio-class-generator.test.ts` | **Not a member.** `:209` asserts only what every interleaving produces (both sweeps resolve; four dates), and its own docblock says so explicitly. |
| `src/services/studio-class-template-lifecycle-lock-order.test.ts` | **Not a member.** Its races are staged with real held locks and causal handshakes — deterministic by construction, which is why it is in the serial tier. |

The six `tests/integration/**` hits are not members either, but not for the
reason a first pass suggests. Four of the loop sites ARE race retries wrapping
a `Promise.all` — `classes-api.test.ts:1558`, `studio-api.test.ts:332` and
`:2063`, `class-templates-api.test.ts:393`. They are non-members because their
assertion, `expect([a.status, b.status].sort()).toEqual([201, 409])`, is
satisfied by every interleaving: an exclusion constraint picks the winner, so
the loop widens the window against a regression rather than hoping for an
ordering. The remaining loops wrap no `Promise.all` at all — fixture creation
(`registrations-api.test.ts:232`, `students-api.test.ts:32`) and rate-limiter
bursts (`invitations-api.test.ts:719`, `students-api.test.ts:1545`, `:1616`).

The command is a floor rather than a census: the genus is semantic, and a race
retried without a counter, or asserted through a database read rather than a
spy, is reachable by no regex. `serial-tier-membership.test.ts`'s own header
makes the same argument about the same kind of property. What the command
supports is the narrower claim actually used here — **the loop-and-hope
construction is confined to one file.**

---

## 4. The fix: interpose the sibling, do not wait for it

Replace *hoping* two calls interleave with *placing* the sibling's write at the
exact statement boundary the race requires. `claimWithCode`'s only seam is its
`db` parameter, and this repo already has the idiom: a `$extends` query hook
that runs a competing statement inside the call under test
(`src/services/waitlist.test.ts:1551`, whose docblock states the rule this
design follows — *"interposed inside the hook rather than issued before the
call … the actual shape of the race, not a rearrangement of it that would also
pass on unfixed code"*).

Validated on this branch before the design was written: a hook on
`magicLinkToken.updateMany` that re-issues the same statement produces
`{ expected: 1, actual: 2 }` from the over-count guard, deterministically, in
**49 ms** — against an eight-iteration loop that produces it ~92% of the time.
`npx tsc --noEmit` is clean with the `as unknown as PrismaClient` cast. The
repo's existing hooks explain this cast once, in the first hook, and the
other three back-reference it in-file; the cross-file form the repo also uses
was found to dead-end (`waitlist.test.ts` points at
`class-transitions.test.ts`, whose cast carries no comment at all), which is
why these tests do not copy it.

**Two kinds of injection, and which one a case needs is decided by whether the
sibling must share our snapshot.**

- **The sibling's whole call.** `claimWithCode(db, …)` on the *unhooked*
  client, invoked from inside the hook — maximum fidelity, every statement
  real. Correct whenever the race is "the sibling ran to completion inside our
  gap". No recursion: the sibling gets the plain client.
- **The sibling's single statement.** Correct when the sibling must have taken
  its snapshot *alongside* ours, so that a nested whole call — which would read
  a snapshot we have already moved — cannot reproduce it. The over-count is
  this case, and its fidelity argument is exact: both calls derive `ids` from
  the same snapshot — two `findMany` statements taken before either writes —
  so the sibling's `updateMany` **is** `args`, and re-issuing `args` is not an
  approximation of the sibling's statement but a copy of it.

---

## 5. Per-test design

`M` = `HANDOFF_MAX_ATTEMPTS` (5). Each staged test makes **one** real
`claimWithCode` call through a hooked client, and asserts the exact warn
payload — which the looped versions could not, since they had to admit whatever
the scheduler produced.

| # | guard pinned | fixture | hook | injected | resulting warn |
|---|---|---|---|---|---|
| 1 | `updateMany` under-count | one live candidate at 0 | `updateMany`, **before** `query(args)` | the sibling's whole call, with the **correct** code — it consumes the row | `{ requested: 1, affected: 0 }` |
| 2 | `deleteMany` reap **under**-count | one candidate at `M-1` | `updateMany`, **after** `query(args)` | the sibling's whole call, wrong guess — it finds the row now spent and reaps it | `{ expected: 1, actual: 0 }` |
| 3 | `deleteMany` reap **over**-count | `A` at `M-2`, `B` at `M-1` | `updateMany`, **after** `query(args)` | the sibling's `updateMany`, i.e. `args` re-issued | `{ expected: 1, actual: 2 }` |
| 4 | spent-cleanup mismatch | one candidate at `M` | `findMany`, **after** `query(args)` | the sibling's whole call — it reaps the spent row first | `{ expected: 1, actual: 0 }` |

The plan implements these in the reverse order — case 1 is Task 4, case 2 is
Task 2, case 3 is Task 1, case 4 is Task 3 — so that Task 1 takes the guard
#509 actually reports and the reported flake goes first. Each row names its
guard, so nothing is ambiguous read alone; the mapping is here for anyone
cross-referencing a number.

Each replaces the looped test that asserted the same guard. Case 1's property
moves off line 343, which keeps its own loop and its own deterministic
assertion (§6).

Every hook counts its own invocations and the test asserts that count, so a
hook whose shape-key stops matching fails loudly instead of silently staging
nothing — the same guard `waitlist.test.ts:1551` uses (`expect(hookCalls).toBe(1)`).

### 5.1 One comment goes stale on the way, and it is the kind this repo names

`handoff.ts`'s `expectedReaps` docblock ended with a roster of two
test titles in `handoff.test.ts` — `"the race: a correct claim concurrent with
wrong guesses never throws"` and `"warns when two concurrent wrong guesses race
the same near-exhausted candidate"`. Cases 1 and 2 change what the first holds
and retire the second, so both halves of that roster go stale in this branch.

That is the failure CLAUDE.md's *Comment Discipline* describes exactly — a
claim reaching past its own file, whose invalidating edit happens somewhere its
author never looks. It is replaced by a link to §5 of this document, which is
where a claim about another module belongs; the same form `handoff.ts` already
uses twice for its other cross-file claims. What it must not become is a claim about the FILE rather than the
tests: `X.ts` / `X.test.ts` is a repo-wide pairing, so renaming one half is
conspicuous, while a test title is renamed casually and by anyone. Neither is
caught mechanically — `handoff.ts` does not import its test file, so the
reference is a bare string either way.
Replaced, not annotated — what the comment used to say belongs in the PR body.

---

## 6. What stays a real race

Three tests keep genuine concurrency, because each asserts something **no**
interleaving can falsify — which is what makes them safe in a parallel tier:

- `the race: concurrent first-opens of the same link agree on one code` —
  the compare-and-swap makes both callers return the persisted code under every
  ordering.

  **Interleaving-independent is not the same as covered, and the first of
  those three shows the difference.** Its assertion holds whether or not the
  two calls interleave — which is what makes it safe here — but
  `verifyWithHandoff`'s compare-and-swap loser branch (`handoff.ts:73-79`) is
  reached only when they do. Serialized, the second call returns at the reuse
  branch and the CAS never runs, and `a.code === b.code` is satisfied anyway.
  That is #509's defect inverted: an assertion that cannot flake, over a
  branch that is not guaranteed to execute. Filed as #514; nothing in this
  branch changes it, and this section's verdict is about flakiness only.
- `counts both attempts when two wrong guesses race concurrently` — four
  atomic `{ increment: 1 }`s land in some order and sum to four in all of them.
- `the race: a correct claim concurrent with wrong guesses never throws`
  — minus its warn assertion, which case 1 above now holds deterministically.
  Its remaining assertion is that every outcome is `verified` or `invalid`,
  true under every ordering; the loop stays because a rejection needs a real
  window to occur in.

---

## 7. Out of scope, and recorded rather than fixed

**A second flake in this file, different mechanism.** `counts both attempts
when two wrong guesses race concurrently` timed out at exactly 5000 ms
(vitest's default per-test timeout) rather than failing an assertion — once
confirmed in batch A of §1.2, once probable in batch C, so ~2 in 78 isolated
runs. Batch D re-ran the file 25 times with `--testTimeout=30000` and a
per-test duration report: the slowest test in any of those 25 runs was
**163 ms**, so the stall is not a slow path getting slower — it is a discrete
event, absent entirely from 25 consecutive runs.

Out of scope here: it is a different test, a different failure mode, and a
different mechanism from the one #509 names, and this branch's change neither
causes nor cures it. It is a live merge-gate flake, so it is **filed as
#512** rather than let go, with these measurements attached. The test itself
survives this branch untouched (§6).

**A second thing found in passing, and also filed.** `verifyWithHandoff`'s
compare-and-swap loser branch is covered only when its test's two calls
happen to interleave — §6 carries the derivation. Filed as #514. Like the
stall, it is untouched by this branch: it is a different function, and it is
under-coverage rather than a live defect.

---

## 8. Verification

1. **Every staged guard is mutation-tested.** For each of the four, break the
   guard it pins in `handoff.ts` — invert the comparison, or delete the
   `log.warn` — run the file, record the exact failure text, restore, re-run
   green. A staged test that passes against a broken guard has staged nothing.
2. **The flake is re-measured, not assumed gone.** 20 consecutive
   `--project unit --project components` runs, the issue's own acceptance
   criterion, with **zero failures of any of the four staged tests** — the
   criterion is scoped to them rather than to the whole file, because §7's
   stall is a different flake at ~2.6% per run and this branch does not
   address it. If it appears inside the 20, it is reported as itself and does
   not count against the criterion; a failure of any *other* test does.
3. **The file's wall time is recorded before and after.** Three loops of eight
   staged races become four single calls, so the number should fall; it is
   reported either way.
4. `npm run typecheck`, `npm run lint`, and the unit and component tiers are
   green. Integration and e2e cannot run from a worktree (no `:3000`, no dev
   database) — CI is the signal for those tiers and the PR body cites the run.
