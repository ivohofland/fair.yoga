# Plan — probe placement tether (#467)

Design: `docs/superpowers/specs/2026-09-06-probe-placement-tether-design.md`.
Read it first; it records four ways #467's premise needed correcting, and the
task descriptions below assume its conclusions rather than repeating them.

Two helpers are in scope throughout:

| Helper | Defining module | Call sites (all correct today) |
|---|---|---|
| `ruleSlotHolder` | `src/lib/rule-slot-holder.ts` | `src/services/rule-lifecycle.ts` ×2, `src/services/studio-class-template-lifecycle.ts`, `src/services/class-template-lifecycle.ts` |
| `probeConflictingEntry` | `src/lib/entry-conflict.ts` | `src/app/api/classes/route.ts`, `src/app/api/classes/[id]/route.ts`, `src/app/api/studio-classes/route.ts`, `src/app/api/studio-classes/[id]/route.ts` |

**Task order is load-bearing.** Task 3 writes down what Tasks 1 and 2 enforce, so
it runs last and reads their landed code rather than this plan's description of
it. Tasks 1 and 2 are independent of each other.

Nothing in this branch touches `prisma/`, so there is no migration and no
`prisma migrate` step. Nothing touches `tests/` — see "Verification" for why the
integration tier is CI's job from a worktree.

---

## Task 1 — pin `ruleSlotHolder`'s parameter against widening

**File:** `src/lib/rule-slot-holder.test.ts`

**Why.** The docblock's "always against `db`, never `tx`" is enforced today only
because `Prisma.TransactionClient` is `Omit<PrismaClient, ITXClientDenyList>` and
so lacks `$transaction`. Nothing pins that. Widening the parameter to
`PrismaClient | Prisma.TransactionClient` — which the sibling
`probeOverlappingCandidates` in `entry-conflict.ts` deliberately is — would
compile every call site unchanged and fail only in production.

**What to write.** A never-called `async function` taking a
`Prisma.TransactionClient`, whose single statement calls `ruleSlotHolder` with it
under a `@ts-expect-error`. Model it on the existing device in
`src/lib/entry-conflict.test.ts` (search that file for
`_theProbeRejectsATransactionClient`) — same shape, same lint suppression for the
unused symbol, and a docblock that says why the pin is not redundant with the
signature. Do not restate `entry-conflict.test.ts`'s paragraph; state the claim
for this helper and let the two files each own their own.

The comment must not assert anything about the OTHER helper or about call-site
counts — *Comment Discipline*: a comment annotates the code it sits on.

**Behaviour to verify.** `npm run typecheck` passes with the device present (the
suppressed error really is produced).

**Mutation proof, required.**
1. Widen `ruleSlotHolder`'s first parameter in `src/lib/rule-slot-holder.ts` to
   `PrismaClient | Prisma.TransactionClient`.
2. Run `npm run typecheck`. It must fail, on the now-*unused* `@ts-expect-error`.
   Record the exact error text (expect a `TS2578`-shaped "Unused
   '@ts-expect-error' directive" naming the test file and line).
3. Restore the signature. Re-run `npm run typecheck` and confirm it passes.
4. Report all three outputs verbatim in the task report.

Note for step 1: widening the signature may also make the raw-query body
type-check differently. If it does, say so in the report rather than working
around it — the mutation only needs to demonstrate the directive going unused.

---

## Task 2 — census every probe call's placement

**File (new):** `src/lib/probe-placement-census.test.ts`

**Model it closely on `src/lib/db-locks-verdict-census.test.ts`.** Read that file
first. It already establishes the file walk, the syntax-tree call detection
(own name / import alias / namespace member, through `(f)(…)` and `f!(…)`
wrappers), the scope-reach guard and the non-vacuity guards. Reuse its structure
and its habits — a docblock that says what the census guarantees and what it does
not, findings reported as `path:line` strings a reader can open, fixtures at the
bottom exercising shapes the repository does not contain. Do NOT extract shared
helpers into a module the two tests import; a second census is worth its
duplication, and the sibling file's own docblock explains why two censuses that
are unlike each other beat one that is shared.

**The rule to assert.** No call to either probe may sit lexically inside the
callback argument of a `$transaction(…)` call. Report every violation as
`path:line`, ideally naming the line of the transaction it sits inside, so a
failure is a place a reader can open.

**The two detectors.**

*Probe calls.* Per helper, per file: the helper's own name; any local name an
import specifier binds it to, only from a module specifier whose last segment is
that helper's defining-module basename; a namespace member read as
`ns.<name>` or `ns['<name>']`. Unwrap parenthesised and non-null callees. Both
helper names are tethered with `satisfies keyof typeof import('./<module>')` so a
rename fails compilation with the module's real exports listed instead of
censusing zero calls.

*Transaction callbacks.* A call expression whose callee is a property access or
string-keyed element access named `$transaction`, whose first argument is a
function-like node. Anchor on the member name only — the receiver is
`prisma` at four of the eight call sites and `db` at the others, and eleven
receiver names appear across `src/`. A call is inside a callback iff walking up
its ancestors reaches a function-like node that is the first argument of such a
call. The array form (`$transaction([…])`) has no function first argument and so
contains nothing.

**Guards — all four are required.** The spec's §"Non-vacuity" states each one's
reason; write the reason beside the assertion, not a bare boolean.

1. Both defining modules exist on disk (they are what alias-following matches).
2. The walk reaches every area of `src/` — compare against a walk written
   *separately* from the one under test, sharing only the extension and
   test-file rules and none of the exclusions a future edit would add.
3. Each helper's call census is non-empty, per helper and not merely in total.
4. The transaction-callback detector finds a non-zero number of callbacks in the
   real tree. **This is the guard without which the whole file can go green
   while checking nothing**, and the sibling census has no analogue for it.

**Fixtures.** The real tree contains exactly one shape — a call outside every
callback — so without fixtures the detector could be deleted outright and the
suite would stay green. Cover, at minimum: a call inside an arrow callback
(reported); inside a `function` expression callback (reported); under a receiver
that is neither `db` nor `prisma` (reported); nested two blocks deep inside a
callback (reported); inside a `catch` that is itself inside the callback
(reported); after the callback's closing `)` (clean); with no transaction in the
file at all (clean — this is `classes/[id]/route.ts`'s real shape, and the census
must not demand a lexical transaction); in the array form of `$transaction`
(clean); reached through an import alias inside a callback (reported); reached as
a namespace member inside a callback (reported); the bare name appearing in a
comment or a string (clean, not a call). Write the fixture census over supplied
sources rather than off disk, the way the sibling file's `takeCensus` does, so
the fixtures pin the reported strings and not merely internal counts.

**Exclusions.** Exclude `*.test.ts`/`*.test.tsx`, with the reason stated: a test
may place a probe wrongly on purpose to demonstrate the failure. Do NOT exclude
the two defining modules — the sibling excludes `db-locks.ts` because the
convention's marker text lives there, and there is no marker here.

**Which vitest project.** It reads files off disk and touches no database, so it
belongs in the parallel `unit` tier — that is where `db-locks-verdict-census.test.ts`
runs, and neither file is in `SERIAL_TESTS` (`vitest.tiers.ts`). Add nothing to
`vitest.tiers.ts`.

**Behaviour to verify.** `npx vitest run --project unit src/lib/probe-placement-census.test.ts`
is green on the tree as it stands.

**Mutation proofs, required — five, each restored and re-verified.**
1. *The realistic regression.* Add a fifth `ruleSlotHolder` call inside the
   `db.$transaction(…)` callback in `src/services/class-template-lifecycle.ts`,
   passing the outer `db`. The census must report it. Record the exact failure
   text.
2. *The other helper, and the other receiver.* Add a `probeConflictingEntry` call
   inside the `prisma.$transaction(…)` callback in
   `src/app/api/studio-classes/route.ts`. Must be reported — this is what proves
   the detector is not keyed on `db`.
3. *The detector.* Make the transaction-callback predicate always answer "not
   inside". The fixtures must go red. Record which ones.
4. *Non-vacuity guard 3.* Narrow the file walk so it matches nothing. The
   per-helper non-empty assertions must go red — and note in the report whether
   the placement assertion alone would still have passed, since that is the whole
   reason guard 3 exists.
5. *Non-vacuity guard 4.* Make the transaction-callback count zero on the real
   tree while leaving the fixtures alone (e.g. have the tree-level count filter
   everything out). Guard 4 must go red.

For each: apply, run, record verbatim, restore, re-run, confirm green. Commit
nothing while a mutation is applied — see the hazard note about `git checkout`
eating sibling edits; restore by reversing the edit, not by checking the file out.

---

## Task 3 — say what is enforced, in both paragraphs

**Files:** `src/lib/rule-slot-holder.ts`, `src/lib/entry-conflict.ts`

Runs last, and reads the landed Tasks 1 and 2 rather than this plan.

**Shape to follow.** `src/lib/db-locks.ts:555–573`, as #465 left it: NO ROSTER
HERE and the re-derivation command stay; a new paragraph names the test and says
what it asserts; a further paragraph says what it does not decide.

**In `rule-slot-holder.ts` (the paragraph at lines 40–56 today):**
- Keep NO ROSTER HERE and the shipped grep. The grep stays a convenience for a
  reader, not the thing holding the rule up — say so.
- Name `src/lib/probe-placement-census.test.ts` and what it asserts: no call
  lexically inside a `$transaction(…)` callback, for this helper and for
  `probeConflictingEntry` both.
- Name the `@ts-expect-error` device in `rule-slot-holder.test.ts` as what holds
  the argument half, and be precise about the division: the type signature is why
  `25P02` cannot happen, and the census is about the *other* failure — a probe
  issued on a second pooled connection while the caller's own transaction is
  still open. The current wording implies `25P02` is the live hazard for a
  misplaced call; after Task 1 it is the reason the signature is what it is.
- Do not narrate the correction. *Comment Discipline*: state what is true now.
  The before-and-after goes in the PR body.

**In `entry-conflict.ts` (the paragraph at lines 195–208 today):** the same two
additions, in that file's own voice. Its docblock already names its own
`@ts-expect-error` device's subject matter; check whether it needs to name the
file, and say in the task report what you found rather than assuming.

**Pointers that must still land after the edit** — check each by opening the
target, not by assuming:
- `rule-slot-holder.ts` → "the same contract `probeConflictingEntry`
  (`./entry-conflict`) carries one layer down".
- `rule-slot-holder.ts` → its opening sentence quotes `db-locks.ts`'s reasoning
  ("for the reason `db-locks.ts` spends a paragraph on"). `db-locks.ts`'s
  paragraph was itself rewritten in #465; confirm the sentence still describes
  what is there.
- `entry-conflict.ts:156` → `probeOverlappingCandidates` "deliberately IS" the
  wider signature. That sentence is load-bearing for Task 1's rationale.
- `docs/lock-order.md:83–88` describes the #464 census. Decide whether it needs a
  sibling paragraph for this one and say why either way; a `docs/` entry is where
  a claim reaching past a file belongs.

**No new counts in any comment.** If a number is worth recording, it goes in the
spec or the PR body, per *Comment Discipline*.

---

## Verification

Run from the worktree, so the integration and e2e tiers cannot run locally —
both need the app on `:3000` and the shared dev database, and this worktree has
neither. Do not start a dev server; do not touch any server already on `:3000`.

- `npm run typecheck`
- `npm run lint`
- `npx vitest run --project unit --project components`
- `npx vitest run --project unit-sweeps`

Skip `--project integration`. CI is the signal for that tier and for e2e and
`npm run build`; cite the CI run in the PR body, not a local `verify`.
