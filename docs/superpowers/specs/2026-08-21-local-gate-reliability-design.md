# Local gate reliability — serialize Playwright locally, budget the invitation burst, document the warm-up protocol

Issue #290. Found while running the gates for PR #285 (issue 194); characterised
across roughly a dozen full runs there, and every load-bearing claim re-measured
on 2026-08-21 before this spec was written.

## The problem, as measured

Two distinct failure modes share one banner: **a red local gate that has nothing
to do with your change**.

### Sub-case 1 — contention

`playwright.config.ts` sets `fullyParallel: true` and
`workers: process.env.CI ? 1 : undefined`, so CI serializes and local runs fan
out across ~half the machine's cores — every worker driving a browser against
the **same single dev server on :3000** that the user has open. During PR
#285's gates, four parallel full runs produced four different victims, each
green on isolated re-run. Captured errors were `toBeVisible` timeouts after a
POST — a server not answering, not a wrong assertion. Green at
`--workers=1`.

The vitest `integration` project talks to the same server over HTTP. One
correction to the issue's framing: `vitest.config.ts` sets
`fileParallelism: false`, so integration tests never contend *with each other*.
Their observed victim (`registrations-api.test.ts`, timed out at 5000ms in two
of four verify runs, 43/43 alone) is explained by the second mechanism below —
the dev server recompiling while mutations edit source — not by intra-suite
fan-out. The fix for the integration side is therefore documentation and the
existing per-test-timeout convention, not serialization (there is nothing to
serialize).

### Sub-case 2 — inherently over budget

`tests/integration/students-api.test.ts > refuses a 51st invitation within the
hour` makes **51 sequential HTTP round trips** to prove the rate limiter refuses
the 51st. Re-measured 2026-08-21, alone, dev server idle:

```
npx vitest run --project integration tests/integration/students-api.test.ts \
  -t "refuses a 51st invitation within the hour"
  → Test timed out in 5000ms            (fails)

… --testTimeout=20000
  → 1 passed                            (tests: 9.01s)
```

~175ms per round trip × 51 ≈ 9s: over the 5s default with nothing else running.
No amount of serialization helps. CI passes it because CI's production build
answers faster than `next dev`.

The sequentiality is load-bearing and stays: the limiter
(`src/lib/rate-limit.ts`) is synchronous and in-memory, so concurrent requests
could not race the count — but sequential requests keep the assertion
deterministic (`statuses.slice(0,50)` all 201, `statuses[50]` exactly 429).

### The reason this is an issue and not a shrug

Not CI risk — CI sets `workers: 1` and `retries: 2`. Two other reasons:

1. **A flaky local gate trains the operator to disregard red**, which is how a
   real regression gets waved through as "just the flake".
2. **Mutation scores silently lie.** After a source edit, `next dev` lazily
   recompiles the touched routes; the first requests pay compilation and can
   blow a 5s timeout. During #285's sweep this mis-scored three mutations RED —
   a timeout reads exactly like an assertion failure, so a guard appears to
   bite when it did not. Mutation scoring is the technique this project relies
   on to prove guards bite (solve-issue §3); corrupting it silently corrupts
   every verdict built on it.

## Decisions

### D1 — Serialize Playwright locally, structurally

`playwright.config.ts`: `workers: 1`, unconditional. The CI ternary collapses;
CI behaviour is unchanged (it already ran at 1). Local `retries` stays
`process.env.CI ? 2 : 0` — a red local run must stay real, and with one worker
the remaining flake surface is small enough that retries would hide more than
they save.

`fullyParallel: true` stays: with one worker it has no scheduling effect, and
keeping it makes the config honest if workers are ever raised deliberately.

Cost, to be measured during implementation and recorded in the PR body: full
local e2e duration before (fanned out) vs after (serialized). Accepted
beforehand: a slower local e2e gate is worth paying for a gate whose red always
means something.

Why structural rather than documented `--workers=1`: a flag humans must
remember is the trap re-armed. The whole point of the issue is that local red
must be trustworthy without the operator recalling a footnote.

Proof this change bites: Playwright's own output names its workers. Before,
multiple workers appear; after, exactly one. Reverting the line restores the
fan-out — that revert is the mutation this guard is proved against. The flake
itself is statistical (four victims in four parallel runs); we prove the
*mechanism* structurally, not the flake statistically, and the spec says so
rather than pretending a red-to-green flake demo is available on demand.

### D2 — Budget the invitation burst per-test, house-style

The burst test gets a positional timeout third arg (`}, 30_000);`) at the call
site — the convention already used across the integration suite: 25 sites in
`{ timeout: N }` option-object form across 12 files and 14 positional-arg
sites across 8 files, each carrying a measured-margin comment
(`teacher-rooms-api.test.ts:596-611` is the worked example). The comment
records: ~9s solo measured 2026-08-21 (51 sequential round trips, ~175ms each);
30s absorbs contention on a busy dev server, not just solo latency; the default
5s was exceeded even idle, so the test was red for reasons unrelated to any
change.

Why not raise the project-wide default: the 5s default is load-bearing —
`notifications-stream.test.ts:267` states it as the baseline tests reason
from, and the house pattern is *narrow overrides with measured justification*.
A higher default converts every genuine hang into a slower diagnosis, suite-
wide, to fix one test.

Why not make the burst concurrent: it would not break the limiter (sync check,
single event loop), but it buys ~8s in a test that runs once per verify while
giving up deterministic ordering — the `50×201 then 429` shape is the assertion.

Proof this change bites: measured above. Default budget → `Test timed out in
5000ms`, alone, idle server. Override → passes. Break-check during
implementation: temporarily set the override to 5000, record the identical
failure text, restore, re-verify green.

### D3 — Document the warm-up protocol where the work happens

Three sites, three audiences:

1. **AGENTS.md** ("Verify commands"): one line — local e2e runs serialized by
   config; after source edits, warm affected routes before trusting a gate or
   a mutation score.
2. **`.claude/skills/verify/SKILL.md`**: the operational recipe — `next dev`
   compiles lazily per route; the first request after an edit pays compilation;
   hit the changed route(s) once (curl is enough) before running suites or
   scoring mutations.
3. **`.claude/skills/solve-issue/SKILL.md`** (hazard list): the failure mode —
   a mutation scored RED off a post-edit cold route is a false bite; warm
   before scoring. This is the doc that dispatches mutation sweeps, so it is
   where the hazard belongs.

Docs cannot fail a test; their verification is mechanical instead — every
documented command is run as written during implementation, and the claims
about `workers`/timeouts are checked against the shipped config.

## Rejected

- **Separate server instance for e2e** (issue option "their own server"):
  breaks the reuse-the-user's-dev-server workflow, adds a second compilation
  and memory footprint, and Postgres contention remains. Cost without curing
  the shared bottleneck that matters.
- **Raise integration default timeout**: see D2.
- **Concurrent burst**: see D2.
- **Bypass the limiter à la `freshIp()`** (`tests/helpers.ts:150`): that helper
  serves IP-keyed limits where the test wants to *avoid* tripping them. This
  budget is keyed on teacher id (`src/lib/rate-limit.ts:76-78`) and the 429 is
  the assertion — bypassing deletes the test's point, and varying IPs would
  not recover the time anyway: the ~9s is 51 round trips through `next dev`,
  not limiter cost.
- **Local retries > 0**: hides real signal; unnecessary once serialized.

## Acceptance

Maps to the issue's acceptance, split per its comment:

1. *Contention*: a local full e2e run is structurally serialized — one worker,
   visible in Playwright's output — so its red means what it says. Duration
   cost measured and stated, not asserted.
2. *Inherently over budget*: the burst test passes alone at the default
   invocation (`npx vitest run --project integration
   tests/integration/students-api.test.ts`) with no flags.
3. *Mutation workflow*: the warm-before-scoring rule exists beside the work —
   AGENTS.md, verify skill, solve-issue hazard list — with commands that were
   actually run.
