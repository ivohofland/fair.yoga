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

### Sub-case 2 — the longest loop in the suite, and a measurement that did not hold

`tests/integration/students-api.test.ts > refuses a 51st invitation within the
hour` makes **51 sequential HTTP round trips** to prove the rate limiter refuses
the 51st. First measured 2026-08-21, alone, dev server believed idle:

```
npx vitest run --project integration tests/integration/students-api.test.ts \
  -t "refuses a 51st invitation within the hour"
  → Test timed out in 5000ms            (fails)

… --testTimeout=20000
  → 1 passed                            (tests: 9.01s)
```

That reading was written up as "~175ms per round trip, inherently over budget,
no amount of serialization helps". **Re-measurement during PR review
contradicted it.** Against a warm dev server the same test runs in ~0.8s —
~15ms per round trip — and, decisively, the two sibling tests in the same
describe make the same 51 sequential round trips and pass on the untouched 5s
default. Were the cost a property of the round trips, those two would be red on
every run.

So the 9.01s was the server, not the loop: a cold or contended `next dev`,
whose compilation half is exactly what §D3's warm-up protocol removes. The
budget stays on a narrower justification — exposure, not arithmetic; see D2 —
and the claim that no amount of serialization helps is withdrawn.

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
   blow a 5s timeout. On #285's sweep this would have mis-scored three
   mutations RED — a timeout reads exactly like an assertion failure, so a
   guard appears to bite when it did not; warming the routes first is what
   prevented it there. Mutation scoring is the technique this project relies
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
keeping it makes the config honest if workers are ever raised deliberately. If
anyone does raise it, the thing holding each spec together is
`test.describe.configure({ mode: 'serial' })`, which all 12 specs declare — not
their `beforeAll`/`afterAll`, which on their own route a spec into Playwright's
`parallelWithHooks` bucket and let it be chunked into `ceil(tests / workers)`
groups with the fixture setup re-run per chunk. The config comment says so at
the pin, because `mode: 'serial'` reads as redundant beside `workers: 1` and is
otherwise exactly the line a tidy-up deletes.

`trace` moves from `'on-first-retry'` to `'retain-on-failure'`. With CI's
`retries: 2` the former recorded the *retry* — so a contention failure that
passed on attempt 2 uploaded a trace of the healthy run and nothing of the
failing one. A branch about red meaning what it says should not throw away the
evidence from the red.

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
site — the only form this repo uses for a test budget. There is no competing
convention to weigh: `main` carries 13 positional sites across 7 files, and
zero `it(name, { timeout: N }, fn)` sites. (The 25 `{ timeout: N }` sites in
`tests/` are `prisma.$transaction` and `vi.waitFor` options — a different
argument to a different function.) Of the 13, three carry a measured
justification — `teacher-rooms-api.test.ts:611`, `rooms-api.test.ts:592`,
`classes-api.test.ts:744`, the first being the worked example — so commenting
this one puts it at the better end of house practice rather than merely
matching it.

The comment records what is actually true, which is *not* what the first draft
of this spec claimed. Measured 2026-08-21 against a warm dev server, the burst
test runs in ~0.8s, and the two sibling tests in the same describe make the
same 51 sequential round trips and pass on the untouched 5s default. So "51
round trips cost ~9s" was wrong: the ~9s reading came from a cold or contended
server, and the compilation half of that is what §D3's warm-up protocol
removes. The budget is justified instead by exposure — this is the longest
fetch loop in the integration suite by an order of magnitude, 51 sequential
round trips where the next-largest is 2, so it is the test most likely to be
hurt by a loaded server, and it gets headroom the others do not need.

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
  not recover any time anyway: the runtime is 51 round trips through
  `next dev`, not limiter cost.
- **Local retries > 0**: hides real signal; unnecessary once serialized.

## Acceptance

Maps to the issue's acceptance, split per its comment:

1. *Contention*: a local full e2e run is structurally serialized — one worker,
   visible in Playwright's output — so its red means what it says. Duration
   cost measured and stated, not asserted.
2. *The burst test*: passes alone at the default invocation (`npx vitest run
   --project integration tests/integration/students-api.test.ts`) with no
   flags, and its fixture sweep survives a timeout of the test body rather
   than racing it.
3. *Mutation workflow*: the warm-before-scoring rule exists beside the work —
   AGENTS.md, verify skill, solve-issue hazard list — with commands that were
   actually run.
