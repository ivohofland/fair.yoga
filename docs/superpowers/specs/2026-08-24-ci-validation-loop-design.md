# The validation loop — parallelize what shares nothing, split what waits on nothing

Issue #321. Written from a measurement session on 2026-08-24 prompted by
"CI takes at least 6 minutes". Every number below was measured, not
estimated, and each measurement's command is given so it can be re-derived.
Projections onto CI hardware are labelled as projections.

## The problem, as measured

### Where the six minutes goes

Run `32726082504` (`gh run view 32726082504 --json jobs`), 7m11s wall. The
`checks` job finishes in 1m01 and runs alongside, so the `test` job at
**6m54 is the entire critical path**:

| step | time |
|---|---|
| job setup + containers + checkout + node + install | 45s |
| `migrate deploy` + drift check | 3s |
| Next cache restore + `npm run build` | 28s |
| start app | 1s |
| **`npm test` (vitest)** | **233s** |
| Playwright version + cache + install | 16s |
| **`npx playwright test`** | **81s** |

`npm test` is 56% of the critical path and e2e is 20%. Splitting the
workflow without touching `npm test` moves the smaller half.

### Where the 233s goes

Measured locally on 2026-08-24, 10 cores (`sysctl -n hw.ncpu`). GitHub's
`ubuntu-latest` gives 4, so the ratios below transfer but the absolutes are
optimistic:

| project | files | tests | as configured | `--fileParallelism` |
|---|---|---|---|---|
| `unit` | 68 | 1068 | 129.5s | 25.7s — 3 files fail |
| `components` | 45 | 296 | 55.8s | 11.6s — all pass |
| `integration` | 33 | 513 | 87.3s | not attempted, see D5 |

Command: `npx vitest run --project <name> [--fileParallelism] --reporter=dot`.

Two separate stories hide in those rows, and Vitest's own breakdown tells
them apart:

- **`components` is not doing work.** Of its 55.8s, `environment` is 30.75s
  and `tests` is 8.62s. That is jsdom being constructed 45 times in a row.
- **`unit` is waiting, not computing.** 129.5s wall against 21.70s of user
  CPU (`/usr/bin/time -p`). It is blocked on Postgres round-trips — the
  workload where parallelism pays best, and the biggest single number in
  the suite.

### Why `components` is serial at all

`vitest.config.ts` sets `fileParallelism: false` at the **root**, so all
three projects inherit it. Its justification is `docs/test-database.md` §2,
which declines per-file database isolation on the grounds that
"`fileParallelism: false` already serializes suites" — a statement about
**shared database state**. The `components` project touches no database;
the config's own comment beside it says so. That project has been paying
for a constraint that was never about it.

## Decisions

### D1 — `fileParallelism` moves off the root and onto the projects

`components: true` (no database, nothing to share), `integration: false`
(#290 relies on this: the tier drives one dev server over HTTP and its
serialization is load-bearing), `unit: true` subject to D2 and D3.

The root setting is deleted rather than left as a default, so that no
future project inherits serialization by accident and no reader has to
work out which projects the §2 argument covers.

### D2 — Two of the three `unit` failures are one unused argument

Under `--fileParallelism` the `unit` tier fails in three files. They are
not three problems:

- **`src/services/class-generator.test.ts`** calls
  `generateClassInstances(prisma, from)` in 8 places. The signature is
  `(db, from?, teacherId?)` — `src/services/class-generator.ts:648-652`.
  **The scope parameter already exists and the test never passes it**, so
  the sweep generates against every template in the database, including
  concurrent files' fixtures, and `expect(count).toBe(4)` sees 8. The
  assertion on the line below it (`findMany({ where: { templateId } })`)
  is already correctly scoped. Fix: pass the teacher id. No production
  change.

  The same file then carries a **second, larger** hazard that the missing
  argument caused: its `beforeAll` reads every `isActive: true` template in
  the database and deactivates all of them, restoring them in `afterAll`
  (lines 96-111 and 179-185). That is a global mutation of other files'
  fixtures, and it exists *only* as a workaround for the unscoped call.
  Passing the teacher id removes the reason for it, so the deactivation
  dance is deleted in the same change rather than left as a parallel-safety
  trap that happens to be inert.

- **`src/services/slot-constraints.test.ts`** dies in teardown on
  `Class_teacherRoomId_fkey` (line 72). It deletes its own classes at line
  68 and its `teacherRoom` rows at line 72; in between, the other file's
  unscoped sweep creates fresh `Class` rows referencing those rooms. This
  is **collateral damage from the bullet above**, which is why it presents
  as a file-level error rather than a failed assertion. Expected to clear
  itself; verified, not assumed (see Acceptance).

- **`src/services/class-transitions.test.ts`** is the real case.
  `autoTransitionToInProgress`, `autoCancelClasses` and
  `autoCompleteClasses` are each `(db, now?)` — no scope parameter exists
  to pass. Whole-database by construction.

**Correction, post-execution (#321):** this framing was right about these
three files, but wrong about the tier as a whole. D2b found a fourth
unscoped mutation by scanning rather than failing, and the acceptance gate
(Acceptance #2) then forced a systematic scan (D2c's correction) that found
several more sweep families beyond these three. "Two problems, not three"
held for this file set; it did not hold for the tier.

### D2b — One more global mutation, found by scanning rather than by failing

`src/lib/auth/magic-link.test.ts:19-21` runs, in an `afterEach`:

```ts
await db.magicLinkToken.deleteMany();
```

No `where` clause: it truncates the table after every one of its tests.
`src/services/auth-cleanup.test.ts` is the only other unit file touching
`magicLinkToken`, and at lines 76-79 it asserts a specific token **survives**
the cleanup sweep. Those two files in one parallel pool are a direct
collision.

It did not fail in any probe run. It was found by grepping the tier for
unscoped `deleteMany`/`updateMany`, and it is the reason that scan belongs
in the work rather than trusting a green run: the probe's own lesson is that
this suite can be green and wrong at the same time.

**Correction, post-execution (#321):** "no reproducible red" is FALSE for
this collision, and the sentence above should be read as narrower than it
sounds — "did not fail in any probe run" stays true, but the collision
reproduces **10 out of 10** runs once the pool is narrowed to only
`magic-link.test.ts` and `auth-cleanup.test.ts`. The original probe missed
it because these two files sat among 65 and their runtime windows rarely
overlapped; narrowing the pool turned a rare collision into a deterministic
one. Lesson: a smaller, targeted pool can be a *more* sensitive collision
detector than a large one, not a less sensitive one.

The two files' identifiers are already disjoint — magic-link uses
`*@example.com` throughout (10 addresses), auth-cleanup uses
`cleanup-${uniqueSuffix}@test.local` — so scoping the `afterEach` to
`{ email: { endsWith: '@example.com' } }` resolves it without touching
auth-cleanup. The same scan found `class-terminal-status.test.ts`,
`waitlist-reconciliation.test.ts`, `gdpr.test.ts` and
`template-lock-order.test.ts` already scoped by row id; they need nothing.

### D2c — Correction, post-execution (#321): the quarantine is not one file

This section originally concluded "one file, not three, genuinely cannot
be scoped" and titled itself "Only one file is quarantined." Both are
FALSE as of the finished work. The five-run acceptance gate (Acceptance #2)
failed repeatedly against a one-file quarantine, and a systematic scan —
every exported service function taking a Prisma client with no id/scope
parameter, narrowed to those that write rows they were never handed —
found several more such sweep families. Two of the tier's problem files
were fixed by scoping instead of quarantine (`class-generator.test.ts`,
`magic-link.test.ts` — see D2 and D2b's correction); the rest joined
`class-transitions.test.ts` in quarantine.

The reasoning below still holds for `class-transitions.test.ts` itself, and
generalizes to the rest of the family: `autoTransitionToInProgress`,
`autoCancelClasses` and `autoCompleteClasses` are each `(db, now?)` — no
scope parameter exists to pass. It runs 5.95s alone
(`npx vitest run --project unit src/services/class-transitions.test.ts`).
Against a ~6s saving per file it was not worth putting an optional scope
parameter through the lock and pre-filter logic that #290 and #296 already
fought over, for this file or for the ones found afterward. The roster is
`SWEEP_TESTS` in `vitest.config.ts` — read it rather than trusting a count
in this document.

### D3 — The quarantine is a second invocation, not a per-project flag

The obvious mechanism — a `unit-serial` project carrying
`fileParallelism: false` beside a parallel `unit` — **does not isolate**.
It was probed directly with a throwaway config splitting the tier in two,
run four times:

```
68 passed              46.4s
68 passed              46.3s
1 failed | 67 passed   47.1s
2 failed | 66 passed   45.6s
```

The first two runs were green **by timing luck**. The giveaway was visible
in run one: `recurring class pause/resume lost the template lock race`,
logged from a file inside the *serial* project — proof the two projects
were executing concurrently. Vitest's per-project `fileParallelism: false`
serializes files *within* a project; it does not stop other projects
running alongside.

Adopting that mechanism would have shipped a merge gate that is green
about two times in four. Therefore: **the serial tier runs as its own
`vitest run` invocation**, sequenced with `&&`, which isolates by process
boundary at a cost of ~2s of startup.

`npm test` becomes two passes:

1. **parallel** — `unit` (scoped) + `components`
2. **serial** — `unit-sweeps` + `integration`

**Correction, post-execution (#321):** this list originally named
`unit-sweeps`'s membership as `class-transitions.test.ts` alone and gave
`unit` a file count of 67. Both are stale for the reason D2c's correction
gives — the roster is `SWEEP_TESTS` in `vitest.config.ts`, and it grew far
past that one file. File counts belong to the code, not this prose; see
`vitest.config.ts` for the current split.

Pass 2 pairs two projects in one invocation, which by the finding above
means they run **concurrently with each other** — deliberately, and safe
only for a reason worth stating: they connect to different databases.
`unit-sweeps` inherits the `unit` project's `DATABASE_URL` override and so
reads `DATABASE_URL_TEST`, while `integration` must use `DATABASE_URL` —
the database the app on :3000 reads (`vitest.config.ts`,
`docs/test-database.md` §3.2). The sweeps therefore cannot see
integration's fixtures and vice versa. **If that override is ever removed,
these two must be split into separate invocations**, or the whole-database
sweeps will read integration's rows and D3's defect returns wearing a
different hat.

**Measured, local (#321):** ~272s → **~147s**
(`/usr/bin/time -p npm test`, full green run — 147.08s–157.95s across the
runs that reached and then held the acceptance gate at 5/5, the spread
being run-to-run noise rather than a config change). Projection, CI: 233s →
~90s — still a projection; no CI run has happened on this branch yet, and
replacing it with a measurement is the next task's job.

### D4 — Split the CI job behind a fan-in `test` gate

The dependency graph is wider than the current single chain admits:
`components` needs neither Postgres nor the build; `unit` needs Postgres
but not the build. Today both queue behind 20s of container init and a 27s
build they never use. Split into `unit`, `components`, and
`integration-e2e`, and the critical path becomes `max()` rather than
`sum()`.

Which job runs what, and what each actually needs:

| job | runs | Postgres | build + running app |
|---|---|---|---|
| `test-components` | `--project components` | no | no |
| `test-unit` | `--project unit`, then `--project unit-sweeps` | yes | no |
| `test-integration-e2e` | `--project integration`, then Playwright | yes | yes |
| `test` | nothing — fan-in gate | no | no |

No `--fileParallelism` flag appears in any of these: after D1 the setting
lives on the projects, so a flag here would be a second place to change it.

`test-components` therefore needs neither the `services: postgres` block
nor `migrate deploy` nor `npm run build`, which is most of what it waits
for today. `test-unit` keeps the database but drops the build. Only the
third job pays the full setup, and it is the one whose 81s of e2e already
dominates it.

The two `test-unit` invocations are sequential (`&&`) for the reason given
in D3 — a single invocation would let the sweep files overlap the parallel
ones. Here they share a database, so nothing rescues them if they overlap.

**The trap.** Ruleset `19724469` on this repo requires exactly two
contexts:

```
gh api repos/:owner/:repo/rulesets/19724469 \
  --jq '.rules[] | select(.type=="required_status_checks")
        | .parameters.required_status_checks[].context'
→ checks
  test
```

The workflow's own header already warns that a required check which never
runs leaves the pull request pending with no way to merge. Splitting `test`
into three differently-named jobs does exactly that.

So the split keeps a job named **`test`** that runs no steps and only
declares `needs: [test-unit, test-components, test-integration-e2e]`. It
reports the aggregate under the name the ruleset expects, and the ruleset
is not edited. `needs` already fails the dependent job when a dependency
fails, so the gate needs no script — but it must not carry `if: always()`,
which would let it report success over a failed dependency.

The duplicated `npm ci` across jobs (~20s each) is paid in parallel and
costs only minutes, which the workflow header already notes are free on a
public repo.

### D5 — e2e's `workers: 1` is left alone

81s, and the second-largest number on the critical path. #290 bought that
setting with four parallel runs producing four different victims, each
green in isolation. Nothing here revisits it.

## Rejected

- **Adding an optional `teacherId` to the three transition sweeps** (the
  "scope everything" approach): buys ~6s over quarantining one 5.95s file,
  and spends it on production signatures whose lock ordering is governed by
  `docs/lock-order.md`. Wrong ratio.
- **A `unit-serial` project with `fileParallelism: false`**: measured
  non-isolating, twice green and twice red across four runs. See D3.
- **`paths-ignore` / docs-only skips**: already rejected in the workflow
  header for sound reasons that have not changed.
- **Parallelizing `integration`**: it is the largest tier locally (87.3s)
  and the obvious next target, but it drives one server over HTTP and #290
  explicitly rests on its serialization. In CI that server is a production
  build rather than `next dev`, so the recompilation mechanism #290
  identified does not apply there and the tier *might* parallelize on the
  runner only. That is a separate measurement session and a separate spec.
- **Editing the ruleset instead of adding a fan-in job**: needs admin
  rights, is invisible from the repository, and breaks every open pull
  request during the window where the workflow and the ruleset disagree.

## Acceptance

1. `npx vitest run --project unit --fileParallelism` passes 67/67 with
   `class-transitions.test.ts` excluded — including
   `slot-constraints.test.ts`, whose fix D2 predicts but does not
   demonstrate. If it still fails, it is a real second bug and gets its own
   diagnosis rather than joining the quarantine.

   **Correction, post-execution (#321):** the count is stale — the final
   `unit` project excludes the whole `SWEEP_TESTS` roster (D2c's
   correction), not `class-transitions.test.ts` alone, so `--project unit`
   no longer collects 67 files at this exclusion. The substance held:
   `slot-constraints.test.ts` cleared exactly as D2 predicted, with no
   second bug of its own.
2. The new `npm test` runs green **five consecutive times** locally. Three
   runs would not have caught D3's defect; four barely did.

   **Met, post-execution (#321) — but only after three fix rounds, and the
   gate caught real defects along the way rather than passing on the first
   try.** Round 0 (the one-file quarantine D2c originally described)
   scored 3/5; round 1 (after D2b's file joined it) scored 4/5; round 2
   (after the systematic scan quarantined the rest of the family) reached
   5/5. Each of the first two rounds' failures was a genuine
   previously-unquarantined sweep family surfacing under real scheduling
   pressure, not noise — the gate did exactly the job it was built for.
3. `npm test` still runs every test the old one did. Compared by count:
   1068 unit + 296 components + 513 integration = 1877, and no file
   collected by two projects.
4. CI `test` critical path measured on a real run and stated. The ~90s
   projection is replaced by the number, whatever it is.
5. A pull request opened after the split shows `checks` and `test` as its
   required contexts and can merge — verified on a real PR, not reasoned
   about.
6. No file in the parallel `unit` pool performs an unscoped
   `deleteMany`/`updateMany`. Re-derive with:

   ```
   grep -rn "deleteMany()\|deleteMany({})\|updateMany({ where: { isActive" \
     src --include="*.test.ts"
   ```

   Expected: no hits outside `class-transitions.test.ts`. This is a standing
   check, not a one-off — D2b's collision was invisible to four probe runs.
7. `docs/test-database.md` §2 is amended: its "`fileParallelism: false`
   already serializes suites" no longer describes the config, and D3's
   finding about per-project isolation is recorded where the next person to
   try it will look.
