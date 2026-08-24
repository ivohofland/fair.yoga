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

So one file, not three, genuinely cannot be scoped without a production
signature change. It runs 5.95s alone
(`npx vitest run --project unit src/services/class-transitions.test.ts`).
Against a ~6s saving it is not worth putting an optional scope parameter
through the lock and pre-filter logic that #290 and #296 already fought
over. **It is quarantined; the other two are scoped.**

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

1. **parallel** — `unit` (67 files, scoped) + `components` (45 files)
2. **serial** — `unit-sweeps` (`class-transitions.test.ts`) + `integration`

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

Projection, local: ~272s → ~125s. Projection, CI: 233s → ~90s. Both to be
replaced with measurements at acceptance.

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
| `test-unit` | `--project unit --fileParallelism`, then `--project unit-sweeps` | yes | no |
| `test-integration-e2e` | `--project integration`, then Playwright | yes | yes |
| `test` | nothing — fan-in gate | no | no |

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
2. The new `npm test` runs green **five consecutive times** locally. Three
   runs would not have caught D3's defect; four barely did.
3. `npm test` still runs every test the old one did. Compared by count:
   1068 unit + 296 components + 513 integration = 1877, and no file
   collected by two projects.
4. CI `test` critical path measured on a real run and stated. The ~90s
   projection is replaced by the number, whatever it is.
5. A pull request opened after the split shows `checks` and `test` as its
   required contexts and can merge — verified on a real PR, not reasoned
   about.
6. `docs/test-database.md` §2 is amended: its "`fileParallelism: false`
   already serializes suites" no longer describes the config, and D3's
   finding about per-project isolation is recorded where the next person to
   try it will look.
