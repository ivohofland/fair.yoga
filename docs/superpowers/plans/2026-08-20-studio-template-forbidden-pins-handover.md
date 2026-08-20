# Handover — issue 114, studio template forbidden-field pins

You are executing a plan someone else wrote. The plan says *what to do*. This
document says *what will mislead you on the way* — and every derailer below is
something you would get wrong **from reading the correct documents carefully**,
not from carelessness.

Read section 2 before you touch anything. Those mistakes are unrecoverable
mid-implementation.

---

## 1. Read in this order

| # | Document | The part that matters |
|---|---|---|
| 1 | `CLAUDE.md` | "Development Principles" (test-first, strict TS, services are framework-agnostic) and "Class Lifecycle". Skip the pricing engine and the design system — this branch touches neither. |
| 2 | `docs/superpowers/specs/2026-08-20-studio-template-forbidden-pins-design.md` | **"What the premise check falsified" first, before anything else.** Then §A (the stronger pin) and §E (the lock bound). §§B-D are restated in the plan with more detail. |
| 3 | `docs/superpowers/plans/2026-08-20-studio-template-forbidden-pins.md` | All of it. It carries the actual code. |
| 4 | This file | Sections 2, 6 and 9 especially. |

**Your harness auto-loads `AGENTS.md`. That is not a substitute for `CLAUDE.md`.**
`AGENTS.md` here is a real document — quick start, test architecture, Prisma
rules, auth quirks — but it carries none of `CLAUDE.md`'s domain content and
only *points* at it from a table at the bottom. Read `CLAUDE.md` explicitly.

**Do not read GitHub issue 114 as your source of truth.** Read the spec's
premise section instead. See derailer 2.1.

---

## 2. Derailers

### 2.1 The issue is wrong in a way that changes the work

Issue 114 says the class family has "four pins" and that **nothing** guards the
studio family — that only `.strict()` stands between a contributor and a forged
`archivedAt`.

Both halves are wrong, and the second one matters:

- The class family has **six** pins, not four. Two of the four things the issue
  lists are a type and a mechanism.
- `src/lib/schemas.test.ts` already carries a repo-wide `server-owned fields`
  register that walks **every** exported schema and refuses `id`, `teacherId`,
  `isArchived`, `archivedAt` and `withdrawnCount` — **including both columns the
  issue says are worth forging.** Five of the eight are already guarded, at
  runtime, today.

So the work is not "add missing protection". It is "add the compile-time layer
that can refuse the reflexive repair the register invites" — the register's own
failure message says *"add it to EXPECTED with a reason"*, which is precisely
the repair a forbidden pin exists to make impossible.

If you build from the issue you will write correct code for the wrong reason and
document it wrongly, and the PR body will inherit a false claim.

### 2.2 The class family is your template — and it has one pin you must NOT copy

The plan tells you to mirror `src/services/class-template-lifecycle.ts`. In
copy-mode you will reach for `_templateForbiddenListIsComplete` at `:186`.
**Do not copy it.** It duplicates the forbidden union literally and `Exclude`s
it against itself, so it never consults Prisma and cannot see a column a
migration adds.

Task 2 replaces it with `_studioTemplateListsPartitionTheModel`, which asks
Prisma directly. That substitution is the one novel thing in this branch. Copy
the other five pins; write this one fresh from the plan.

Measured, so you know it is not a preference: when #111 added `archivedAt` and
`withdrawnCount` to both models, every pin then in place stayed green until a
human remembered to classify them.

### 2.3 Mutation 9 must use a variable, never an object literal

```ts
// WRONG — proves nothing. Excess-property checking rejects this with or
// without the intersection, so it goes red either way.
void updateStudioClassTemplate(prisma, 'x', 'y', { classType: 'Yin', isActive: true });

// RIGHT — the bypass the intersection exists to close.
const patch = { classType: 'Yin', isActive: true };
void updateStudioClassTemplate(prisma, 'x', 'y', patch);
```

This project has shipped three guards that compiled and could not fail. The
literal version of this mutation is exactly how a fourth gets shipped.

### 2.4 Two of Task 4's three integration tests pass on arrival — that is correct

Task 4 asks you to write three tests before rewriting the route. Only the 503
case goes red. The 200 case and the `.strict()` case pass immediately, because
the route already works and the schema is already `.strict()`.

TDD discipline will push you to "fix" them into failing, or to skip writing them
because they do not fail. **Do neither.** They are characterization tests: their
job is to go red *if your rewrite drifts*, and they can only do that by existing
before it. Write them, watch two pass and one fail, and proceed.

### 2.5 Do not edit the four pre-existing PUT integration tests

`tests/integration/studio-api.test.ts` already has four `PUT` cases — 403 at
`:305`, 404 at `:328`, empty-body 400 at `:337`, slot collision 409 at `:348`.

After Task 4 they must be green **without a single character changed**. If one
needs editing to pass, your extraction changed behaviour the plan did not
sanction. That is a stop condition (§6), not a test to adjust.

### 2.6 `import type { Prisma }`, not `import { Prisma }`

`class-template-lifecycle.ts:26` imports `Prisma` as a **value**, because it
tests `err instanceof Prisma.PrismaClientKnownRequestError` at `:542`. Your code
reaches the same outcome through `isRecordNotFound` (`api-errors.ts:245`), so it
needs `Prisma` only as a type namespace.

Copying the value import is harmless-looking and wrong: in this repo a value
import is how server-only code (`@/lib/log` is pino) ends up on a client bundle
path. `import type` erases completely.

### 2.7 `no_fields` is a defined-value scan, not a key count

Today's route uses `Object.keys(parsed.data).length === 0`. The service must use
`Object.values(data).some((v) => v !== undefined)`, matching
`updateClassTemplate:372`.

You will be tempted to keep the key count, because it is what the route does and
because the wire cannot produce `{ classType: undefined }` — JSON has no
`undefined`. That reasoning is right about the wire and wrong about the
function, which is now callable without one. There is a test for it.

---

## 3. Verify, don't assume

Every line number in the plan is from `main` at `2a25971`, 2026-08-20. **I ran
each command below and recorded its real output**, so a mismatch means drift,
not a typo in this file. If one has drifted: fix the reference in the plan, and
say so in your report.

```bash
# 1. The write this branch is about
sed -n '60p' 'src/app/api/studio-class-templates/[id]/route.ts'
#    →       data: parsed.data,

# 2. The class family has SIX pins (the issue says four)
grep -c "const _template[A-Za-z]*: NoneOf" src/services/class-template-lifecycle.ts
#    → 6

# 3. The pin you must NOT copy (derailer 2.2)
sed -n '186p' src/services/class-template-lifecycle.ts
#    → const _templateForbiddenListIsComplete: NoneOf<

# 4. The stale claim Task 5 fixes
sed -n '6p' src/services/class-template-lifecycle.ts
#    →  * over), with the same five pins. Three things deliberately differ, and are

# 5. The wire schema is already strict — you do not add this
sed -n '461p' src/lib/schemas.ts
#    → }).strict();

# 6/7. The runtime register and its roster assertion
sed -n '362p' src/lib/schemas.test.ts
#    → const SERVER_OWNED_FIELDS = [
sed -n '439p' src/lib/schemas.test.ts
#    →     expect([...SERVER_OWNED_FIELDS].sort()).toEqual([

# 8/9/10. Import lines Tasks 2-4 edit
sed -n '35p' src/services/studio-class-template-lifecycle.ts
#    → import type { PrismaClient, StudioClassTemplate } from '@prisma/client';
sed -n '38p' src/services/studio-class-template-lifecycle.ts
#    → import { isTransientDbError } from '@/lib/api-errors';
sed -n '16p' 'src/app/api/studio-class-templates/[id]/route.ts'
#    → import { isUniqueConflictOn } from '@/lib/unique-conflict';   (Task 4 DELETES this)

# 11/12. Test-file fixtures Task 3 reuses
sed -n '1p' src/services/studio-class-template-lifecycle.test.ts
#    → import { describe, it, expect, beforeAll, afterAll } from 'vitest';
#      (Task 3 adds `vi`, and `import { log } from '@/lib/log';`)
grep -n "^const seedTeacher\|^function slotTime" src/services/studio-class-template-lifecycle.test.ts
#    → 24:function slotTime(totalMinutesFrom9am: number): string {
#    → 39:const seedTeacher = async (label: string) => {

# 13. The integration fixture Task 4 reuses
grep -n "^const makeTemplate" tests/integration/studio-api.test.ts
#    → 75:const makeTemplate = (

# 14. The bound the `busy` timing assertions rest on
grep -n "^export const LOCK_TIMEOUT_SQL" src/lib/db-locks.ts
#    → 94:export const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '2s'";
#      2s is why the test asserts >= 1_800 and < 5_000.

# 15. The helper Task 3 uses instead of a raw P2025 check
grep -n "^export function isRecordNotFound" src/lib/api-errors.ts
#    → 245:export function isRecordNotFound(error: unknown): boolean {
```

**Environment:**

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep fairyoga
#    → fairyoga-db-1	Up ... (healthy)      PostgreSQL on :5432

curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
#    → 307 (or 200). NEVER 000 — see §7, you must not start this yourself.
```

---

## 4. Harness differences

You are not running the harness this plan was written in. What changes:

- **No skills system.** Where the plan or this file says "per the skill", the
  rule is restated inline. Nothing is hidden behind a skill invocation.
- **TDD ordering is not enforced for you — follow it anyway.** Every task writes
  the test first and runs it to see the failure. The one exception is Task 4,
  where two of three tests pass on arrival by design (derailer 2.4).
- **The mutations are a deliverable, not a private check.** Task 6 produces
  `docs/superpowers/plans/2026-08-20-studio-template-forbidden-pins-mutations.md`
  with the verbatim error text of each. The PR body cites it. A mutation you ran
  and did not record did not happen.
- **Commit per task, exactly as each task's Step 5 says.** The PR is
  **rebase-merged, never squashed** — the commit-per-task history is the record.
  Do not amend, squash, or reorder.
- **Stage exact paths. Never `git add -A` or `git add .`.** Two of the paths
  contain parentheses (`src/app/api/studio-class-templates/[id]/route.ts` has
  brackets, and other paths in this repo have `(teacher)` / `(public)`) — quote
  them.
- **Branch:** work on `issue-114-studio-template-pins`, which already exists and
  already has the spec and plan committed. Do not create another.

---

## 5. Task order, and which constraints are load-bearing

| Order | Load-bearing? | Why |
|---|---|---|
| 1 before 2 | **Yes** | Task 1's key-set test is what makes Task 2's allowlist a *checkable* claim. Land the allowlist first and a wrong one is invisible — the pins would happily certify an allowlist that matches a schema you misread. |
| 2 before 3 | **Yes** | Task 3's function signature references Task 2's two list types. |
| 3 before 4 | **Yes** | Task 4 imports the function. |
| 5 anywhere after 2 | No | Preference. It reads Task 2's pin names in a comment, nothing more. |
| 6 last of the code tasks | **Yes** | Mutations must run against the finished branch. A mutation against a half-built one proves the wrong thing. |
| 7 last | **Yes** | The whole-suite run is the gate. |

**Within Task 2, the six pins may be written in any order.** They are
independent. The doc comments are not filler — several of them record
measurements (the partition arithmetic, the `Decimal` assignment) that a future
reader cannot re-derive from the code.

---

## 6. Stop conditions

Stop, do not work around, and report — in all five cases the finding is more
valuable than the branch:

1. **Mutation 8's contrast does not hold.** You must record *both* halves: the
   partition pin going **red** on a simulated new column, **and** the class
   family's duplicate-union form staying **green** under the same simulation. If
   the class form also goes red, the spec's central claim in §A is wrong and the
   whole justification for the novel pin collapses. Report it; do not quietly
   keep the pin.

2. **Mutation 9 fails to fire with a pre-built variable.** Then the intersection
   is not binding callers and Task 3's signature is decorative.

3. **Mutation 10 aborts at ~10s instead of hanging to the test's own 20s
   timeout.** The plan asserts the Prisma budget is *not* a bound and that
   removing `setLockTimeout` therefore hangs rather than aborts. If it aborts,
   that diagnosis is wrong. Record which actually happened, with the timing.

4. **Any of the four pre-existing PUT integration tests needs editing** (derailer
   2.5). Report which one, what it now returns, and why — that is a behaviour
   drift the PR body has to name, not a test to adjust.

5. **`npm run verify` gives a wall of `ECONNREFUSED`.** The dev server on :3000
   is down. **Ask; do not start it** (§7).

---

## 7. Hazards this branch can actually hit

- **Never start or restart the dev server on :3000.** The user runs it, it
  serves this checkout, and the `integration` project talks to it over HTTP.
  Starting a second one gives you a server on a different port or a stale
  `.next` and a confusing failure.
- **`npm run verify` needs :3000 up.** It runs typecheck, lint, and **all three**
  vitest projects. Green `verify` is a strong signal but **not** CI: CI also runs
  `prisma validate`, a migration-drift check, `npm run build`, and Playwright. A
  build-only defect passes `verify` and fails CI.
- **`@/lib/log` is pino and server-only.** `studio-class-template-lifecycle.ts`
  already imports it and states why at `:41-44`; that reasoning is unchanged by
  this branch, so leave the comment alone. Do not add a `@/lib/log` import to
  anything a `'use client'` component value-imports.
- **`npx vitest run --project <p> <path>` is the fast inner loop.** Use it per
  task; save the full `verify` for Task 7. Every rate-limited request in the
  suite carries its own `x-forwarded-for` via `freshIp()` in `tests/helpers.ts`,
  so re-running costs nothing.
- **Never edit an applied migration.** This branch adds none and needs none —
  no schema change.
- **`TZ` is pinned to `America/New_York`** in `vitest.config.ts`, deliberately
  (west of UTC, so local and UTC calendar reads disagree). Nothing in this
  branch is date-sensitive — `StudioClassTemplate` has no date column — but do
  not remove the pin if a test surprises you.
- **The `unit` project runs against `DATABASE_URL_TEST`, a separate database;
  `integration` runs against the dev database via :3000.** Task 3's tests are
  unit; Task 4's are integration. They do not share fixtures and must not try to.
- **Never write "does not close #N" in a commit message or the PR body.**
  GitHub's parser matches the keyword and ignores the negation in front of it —
  PR #191's scope section closed issue 113 that way. Write "**#N is unaffected**"
  or "**leaves #N open**". The same trap applies to `fixes`, `fixed`, `resolves`,
  `resolved`, `closed`. This branch names #194, #228, #231 and #117 as out of
  scope, so you will write that sentence four times.
- **Post any `gh issue`/`gh pr` prose from a `--body-file`, never
  `--body "…"`.** Backticks in a double-quoted shell string reach zsh as command
  substitution even escaped, and it fails *silently* — a published comment with
  words missing.

---

## 8. Baseline, done, and what to report

**Measured 2026-08-20 on `main` at `2a25971`, all green** — not inherited from
an earlier document:

| Project | Files | Tests |
|---|---|---|
| unit | 63 | 937 |
| components | 41 | 242 |
| integration | 31 | 440 |
| **total** | **135** | **1619** |

`63 + 41 + 31 = 135`. `937 + 242 + 440 = 1619`.

**Predicted after: 135 files / 1630 tests.** No new test *files* — this branch
adds cases to three existing ones: `schemas.test.ts` (+1),
`studio-class-template-lifecycle.test.ts` (+7), `studio-api.test.ts` (+3).
`1619 + 11 = 1630`.

**Measure it anyway.** A prediction cannot know what your own review adds:
#212's handover predicted 1294 and the real figure was 1296, because that
branch's review added tests the prediction could not have seen.

```bash
for p in unit components integration; do
  echo -n "$p: "
  npx vitest run --project $p --reporter=dot 2>&1 | grep -E "^ *(Test Files|Tests) " | tr '\n' ' '
  echo
done
```

**Done means:**

- `npm run verify` exits 0.
- **Six** new commits on `issue-114-studio-template-pins`, one per task for
  Tasks 1-6. Task 7 commits nothing — it is the verification gate. The branch
  already carries three doc commits (spec, plan, this file), so
  `git log main..HEAD --oneline | wc -l` should read **9** when you are done.
- The mutation record exists and every mutation has verbatim error text.
- The four pre-existing PUT integration tests are unchanged in
  `git diff main -- tests/integration/studio-api.test.ts`.

**The PR body must record:**

- **Which inherited claims were checked and which held.** Say plainly that issue
  114's "four pins" was six and that its "nothing is watching" was false — five
  of eight columns were already guarded by `schemas.test.ts`'s register. Say
  which of its claims *did* hold (the unfiltered `parsed.data`, `.strict()`,
  #111's two columns).
- **The arithmetic behind every number**, re-derivable by a reader: the baseline
  sums above, `6 + 8 = 14` for the column partition, and the measured after
  figure.
- **What the PR does not do**, using "**#N is unaffected**" — #194 (studio edits
  leave classes on the old weekday), #228 (template creates), #231 (the four
  existing unlogged sites), #117.
- **Three behaviour changes**, each named: 400-before-403 on a malformed body
  against another teacher's template; `no_fields` becoming a defined-value scan;
  a blocked write answering 503 at ~2s.
- **Which suites ran.** A green `npm run verify` **is** the whole integration
  suite — say so with the arithmetic that proves it (`135 = 63 + 41 + 31`), which
  turns "every integration file ran" from a reassurance into a checkable claim.
  Then name by path the integration file this branch touched:
  `tests/integration/studio-api.test.ts` — one of 31 that *ran*, the only one
  that *changed*.
- **Your own errors**, if any. If a line reference in the plan had drifted and
  you fixed it, that goes in the PR body too.

**Report back:** the measured after-figures with reconciliation, every drifted
reference you corrected, every stop condition you hit, and anything in the plan
that turned out to be wrong. Do not silently accept a wrong instruction and do
not silently work around one — say which, and why you did what you did.

---

## 9. Final checklist — one line per irreversible mistake

- [ ] I read the spec's premise section before issue 114, or instead of it.
- [ ] I wrote `_studioTemplateListsPartitionTheModel` fresh — I did **not** copy
      `_templateForbiddenListIsComplete`.
- [ ] Mutation 9 used a **pre-built variable**, not an object literal.
- [ ] Mutation 8 recorded **both** halves — partition red, class-family form green.
- [ ] The four pre-existing PUT integration tests are byte-unchanged.
- [ ] `import type { Prisma }`, not `import { Prisma }`.
- [ ] `no_fields` is a defined-value scan, not a key count.
- [ ] I did not start or restart the dev server on :3000.
- [ ] I staged exact paths — never `git add -A`, never `git add .`.
- [ ] One commit per task; nothing amended, squashed or reordered.
- [ ] No commit message or PR line reads "does not close #N" — I wrote
      "#N is unaffected".
- [ ] Every mutation was **reverted**, and the suite re-run to green after each.
- [ ] `npm run verify` exits 0 before I push.
