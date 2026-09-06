# Plan — tether the forced-plan-settings recipe across its five call sites (#483)

No separate design doc: the issue itself lays out three concrete options with a
recommendation, and premise verification below is the whole of what a spec
would have added. Decision recorded here, not repeated at every gate.

## Premise verification

**Five code sites, confirmed.** `grep -rn 'enable_seqscan\|enable_bitmapscan\|enable_hashjoin\|enable_mergejoin' src --include='*.ts'`
finds exactly five call sites each issuing the same four `SET LOCAL <name> = off`
statements:

1. `src/lib/db-locks-lock-order.test.ts:95-98` — `forceIndexOrderedPlan(tx)`, via `tx.$executeRaw` tagged templates.
2. `src/services/template-lock-order.test.ts:356-359` — inline in `expectPremiseOrder`, same shape as (1).
3. `src/services/gdpr-lock-order.test.ts:324-327` — inline in `probeUnderForcedPlan`, same shape as (1).
4. `src/services/gdpr-lock-order.test.ts:690-693` — the teacher-side `$extends` query hook, via `query([...])` over a raw string (no `tx` available — the hook only ever sees `args`/`query`, not a `TransactionClient`).
5. `src/services/gdpr-lock-order.test.ts:760-763` — the student-side `$extends` query hook, same shape as (4).

**The issue's own re-derivation command is wrong.** It states
`grep -rn 'enable_seqscan = off' src   # 9 lines: 5 code, 4 prose`. Re-running
that exact command today returns **11 lines: 5 code, 6 prose**
(`gdpr-lock-order.test.ts:434,443,746` were not in the issue's count either).
Doesn't change the decision — the five-code-site premise the issue's argument
actually rests on is correct — but the "4 prose" figure is stale and the PR
body should say so rather than repeat it.

**The full "four settings" prose census** (`grep -ni '\bfour\b' src/lib/db-locks-lock-order.test.ts src/services/template-lock-order.test.ts src/services/gdpr-lock-order.test.ts`,
hand-filtered for false positives — `template-lock-order.test.ts:565`'s
"Fourth argument" and `gdpr-lock-order.test.ts:1269`'s "#174 four-specialist
review" are about unrelated things and stay untouched) is **15 sentences**
asserting a count or membership claim about the four settings:

- `db-locks-lock-order.test.ts`: 19, 36, 54, 72, 91, 341 (6)
- `template-lock-order.test.ts`: 319, 327 (2)
- `gdpr-lock-order.test.ts`: 272, 484, 565, 664, 676, 743, 750 (7)

Plus one more: the **recorded decision** in `probeUnderForcedPlan`'s docblock
(`gdpr-lock-order.test.ts:283-285`, "mirrored here rather than imported,
because a test helper crossing suites would couple two files whose fixtures
are independent") — not a count sentence, but the thing the issue's acceptance
criteria requires be replaced outright.

**`docs/lock-order.md` is out of scope.** It also describes this recipe
(`enable_hashjoin`/`enable_mergejoin`/`enable_seqscan`/`enable_bitmapscan`,
~lines 638-826) including its own "four settings" prose. CLAUDE.md's *Comment
Discipline* permits counts in `docs/` on their own terms (they ship with a
re-derivation command, they have an owner). More to the point: nothing this
plan does changes the underlying fact that there are four settings — only
*where the setting names live in code* changes — so nothing in
`docs/lock-order.md` goes stale from this branch. Leaving it alone.

## Decision: Option 1 — a shared array of setting NAMES, each site still issues them itself

**Option 2 (shared helper function) cannot reach all five sites** — sites 4
and 5 have no `Prisma.TransactionClient` to hand a helper; they only see
`(args, query)` from a Prisma `$extends` query hook. A helper taking `tx`
literally cannot be called from there. That alone rules it out; the issue's
own text already flags this ("cannot use it anyway").

**Option 1 does not conflict with the recorded decision.** That decision
names a coupling risk from a *test helper function* crossing files — a
callable, an execution path, something that could tie two files' fixtures
together. A `readonly string[]` of GUC names is inert data: importing it
creates no shared execution path and touches no fixture. The issue's own
framing of this ("a list of GUC names is not a fixture") holds up under
inspection of what the recorded decision actually forbids.

**Precedent in this codebase already draws this exact line.** `LOCK_TIMEOUT_SQL`,
`CLASS_TO_ENTRY_JOIN` and `CLASS_TO_WAITLIST_JOIN` are shared SQL constants
that also cross these three files — but they live in `src/lib/db-locks.ts`
because they have real production callers (`entry-generation.ts`, `gdpr.ts`,
`waitlist.ts`, `class-template-lifecycle.ts`). `FORCED_PLAN_SETTINGS` has zero
production use — it exists only to defeat the query planner in tests — so it
belongs in `tests/`, exactly where the issue suggests and exactly where this
repo already puts test-only shared constants (`tests/class-fixtures.ts`,
`tests/helpers.ts`).

**Tether mechanism: each site LOOPS over the imported array**, rather than
importing it for a human to eyeball while still hand-typing four lines. That
is what makes "adding a member reaches every site" true by construction, not
by discipline — there is no way to add a member and have one site silently
miss it, because no site names the members itself:

```ts
for (const setting of FORCED_PLAN_SETTINGS) {
  await tx.$executeRawUnsafe(`SET LOCAL ${setting} = off`);
}
```

(for the two `$extends` hooks, `await query([...])` in place of `tx.$executeRawUnsafe`.)

**This forces sites 1-3 off `tx.$executeRaw` tagged templates onto
`tx.$executeRawUnsafe`.** Postgres cannot parameterize a config identifier —
`SET LOCAL $1 = off` is not valid, which is exactly why sites 4-5 already
build a raw string instead of a tagged template. `setting` only ever comes
from the fixed internal array, never external input, so `$executeRawUnsafe`
here carries no injection risk.

**Naming:** new module `tests/forced-plan-settings.ts`, exporting
`FORCED_PLAN_SETTINGS` as a `readonly` tuple of bare GUC names (not full
statements — matches the issue's own wording, and keeps the `SET LOCAL … = off`
construction visible at each call site, which is what "each site still issues
them itself" means).

## Task order

Task 2 depends on Task 1 landing first — its docblock edits name the new
module and describe the new call shape, which don't exist until Task 1 lands.
Sequential, not parallel.

---

## Task 1 — shared setting names, all five sites derive from them

**New file:** `tests/forced-plan-settings.ts`

Export `FORCED_PLAN_SETTINGS` as a `readonly` tuple:

```ts
export const FORCED_PLAN_SETTINGS = [
  'enable_hashjoin',
  'enable_mergejoin',
  'enable_seqscan',
  'enable_bitmapscan',
] as const;
```

Docblock: one short paragraph saying what this is (the GUC names the
forced-index-order recipe turns off, shared by the three lock-order suites)
and what it deliberately is NOT (not a helper, not a fixture, doesn't issue
anything itself — each call site still does that). Do not restate *why* the
recipe needs these four rather than some other set, or what index-driven vs.
index-ordered means — that reasoning stays in `forceIndexOrderedPlan`'s
docblock (`db-locks-lock-order.test.ts`), which this module is not a
replacement for. Follow `tests/helpers.ts`'s docblock style (what this module
owns, what stays elsewhere, one paragraph each).

**Edit the five call sites** to import `FORCED_PLAN_SETTINGS` (relative path
from each file, matching how each already imports `createClassFixture` from
`../../tests/class-fixtures`) and loop over it instead of hand-listing four
statements:

1. `db-locks-lock-order.test.ts:94-99` (`forceIndexOrderedPlan`) — replace the
   four `tx.$executeRaw` lines with the loop over `tx.$executeRawUnsafe`.
2. `template-lock-order.test.ts:355-359` (`expectPremiseOrder`) — same.
3. `gdpr-lock-order.test.ts:323-327` (`probeUnderForcedPlan`) — same. Leave
   the `LOCK_TIMEOUT_SQL` line immediately above it untouched — that's a
   different constant, already shared via `@/lib/db-locks`, not in scope here.
4. `gdpr-lock-order.test.ts:688-694` (teacher `$extends` hook) — replace the
   four `query([...])` lines with the loop, keeping the `first`/`return first`
   structure around it exactly as it is.
5. `gdpr-lock-order.test.ts:758-764` (student `$extends` hook) — same as (4).

Do not touch any docblock prose in this task — that is Task 2's job, once the
new shape exists to describe accurately.

**Behaviour to verify.** `npx vitest run --project unit-sweeps
src/lib/db-locks-lock-order.test.ts src/services/template-lock-order.test.ts
src/services/gdpr-lock-order.test.ts` stays green — 17 tests passing today
(baseline captured before this task starts), same 17 after.

**Mutation proof, required — break it the way it actually broke.** This
recipe has real history: before #470, the set was three settings
(`enable_hashjoin`, `enable_mergejoin`, `enable_seqscan`) and CI failed because
a bitmap heap scan survived and returned physical heap order. Reproduce that
failure through the NEW single point of control, proving one edit now reaches
every site:

1. Remove `'enable_bitmapscan'` from `FORCED_PLAN_SETTINGS` (one edit, one
   file).
2. Run the same three-file `unit-sweeps` command above. Record verbatim
   whether it fails, which test(s), and the actual assertion output — don't
   presume the historical failure reproduces identically; these are
   cost-based plans and the docblocks are explicit that some of this behaviour
   is empirical, not mechanical. If it does NOT fail, say so plainly and
   investigate why before treating the tether as proven (a false-negative
   mutation here is proving nothing).
3. Restore the member. Re-run and confirm all 17 tests pass again.
4. Report all three outputs verbatim in the task report.

---

## Task 2 — replace the recorded decision, and stop counting

**Depends on Task 1.** Read its landed diff before writing any of this —
name the real module path and the real loop shape, not this plan's
description of them.

**Replace the recorded decision**, `gdpr-lock-order.test.ts`'s
`probeUnderForcedPlan` docblock (currently ending "...mirrored here rather
than imported, because a test helper crossing suites would couple two files
whose fixtures are independent"). State what is true now: the setting NAMES
are shared (name the module), each site still issues its own statements
through its own client/hook (name the mechanism — `$executeRawUnsafe` here),
so no fixture or execution path crosses files; that is why this doesn't
reopen the coupling the earlier decision was refusing. Don't narrate the
change ("this previously said…") — the before/after belongs in the PR body,
per *Comment Discipline*.

**Fix the 15 "four" sentences censused above**, file by file. Each becomes a
reference to `FORCED_PLAN_SETTINGS` by name rather than a count — "the
settings in `FORCED_PLAN_SETTINGS`" per the issue's own instruction — and
stops asserting a cardinality. Read each sentence in context before editing:
some assert "all four are required" (replace the count, keep the
requirement-claim), some assert non-membership ("`enable_tidscan` is not
among the four" → "...is not one of them" or similar, still naming
`enable_tidscan` explicitly since THAT claim is not a count and stays true).
Do not mechanically find-and-replace the word "four" — read the sentence,
preserve what it substantively asserts, only stop it from counting.

**Explicitly do NOT touch** (named out of scope by the issue itself):
- `db-locks-lock-order.test.ts:514-517` and `gdpr-lock-order.test.ts:316-319`
  — the two index-key rosters. Different kind of claim (which columns an
  index leads with), not a settings count.
- `template-lock-order.test.ts:565` ("Fourth argument") and
  `gdpr-lock-order.test.ts:1269` ("#174 four-specialist review") — unrelated
  uses of "four"/"fourth", already identified as false positives above.
- `docs/lock-order.md` — see "Premise verification" above for why.

**Behaviour to verify.** Same three-file `unit-sweeps` command as Task 1,
green, 17 tests — this task changes no executable behavior, only prose, so
the count and the pass/fail should be byte-identical to Task 1's landed
state. Also grep-check after: `grep -ni '\bfour\b' <the three files>` should
return only the two named-false-positive lines (`template-lock-order.test.ts:565`,
`gdpr-lock-order.test.ts:1269`).

---

## Verification

Run from the worktree. Unlike the usual worktree caveat, these three files
connect directly to the shared Postgres container (`fairyoga-db-1`, via
`DATABASE_URL_TEST`) rather than through the Next dev server on `:3000`, so
they run locally same as CI — copy `.env` into the worktree if not already
present.

- `npm run typecheck`
- `npm run lint`
- `npx vitest run --project unit --project components`
- `npx vitest run --project unit-sweeps`

`--project integration` still needs the dev server + shared dev DB this
worktree doesn't have — skip it locally, cite the CI run in the PR body for
that tier (and for e2e, and `npm run build`).
