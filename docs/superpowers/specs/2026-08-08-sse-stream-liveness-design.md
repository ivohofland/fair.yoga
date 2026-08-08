# A trace cannot tell an open SSE stream from a closed one, and #41 read one that could not

**Issue:** #41 — SSE notification stream dies instantly in CI (`next start` vs standalone serving)
**Date:** 2026-08-08
**Outcome:** the issue's premise is disproved. The work that remains is the coverage
whose absence allowed it to be filed.

## The problem, stated after measuring it

#41 says the SSE stream is dead in CI, cites Playwright trace durations of 5–21 ms
as the evidence, and proposes switching CI's serving mode from `next start` to the
standalone server as the fix.

All three parts fail:

- **The evidence cannot distinguish the two states it is being used to distinguish.**
  A provably-open stream reports 18.7 ms in a trace. That number is time-to-headers.
- **The proposed fix has no mechanism.** Both entry points call the same
  `startServer()`; the request pipeline is byte-identical code.
- **The proposed command does not name a path that exists in this repo.**

What is true, and is what this branch acts on: **`/api/notifications/stream` has no
test coverage at all**, so nothing would have contradicted the issue, and nothing
would notice if the stream really did die.

## What was measured

All measurements are against this checkout, dev server on `:3000`, Next 16.2.10,
2026-08-08. Probe scripts are throwaway; the numbers below are the record.

### 1. A trace's duration for an SSE response is TTFB, not stream lifetime

An `EventSource` was opened from inside the page and held for 12 s, sampled once a
second, while Playwright recorded every network event for the same URL and wrote a
trace.

In-page state — `readyState` 1 (OPEN) on **all 12 samples**, `opens=1`, `errors=0`.
Playwright's `requestfinished` **never fired**. The stream was open the whole time.

The trace's own `trace.network` entries, from that same run:

| request | status | `time` | `dns` | `connect` | `ssl` | `send` | `wait` | `receive` | `bodySize` |
|---|---|---|---|---|---|---|---|---|---|
| `/` | 200 | 190.813 | 0.324 | 0.488 | 2.301 | 0 | 120.859 | 66.841 | 8833 |
| `…/src_app_layout_tsx…js` | 200 | 115.701 | −1 | −1 | −1 | 0 | 7.775 | 107.926 | 307 |
| **`/api/notifications/stream`** | **200** | **236.185** | −1 | −1 | −1 | 0 | **236.185** | **−1** | **−1** |
| **`/api/notifications/stream`** | **200** | **18.739** | −1 | −1 | −1 | 0 | **18.739** | **−1** | **−1** |
| `ws://…/_next/webpack-hmr` | 101 | 10001.5 | *absent* | *absent* | *absent* | −1 | −1 | −1 | −1 |

`time` is the sum of the **non-negative** phases; `−1` means "this phase did not
happen or did not complete" and contributes nothing. That reproduces every row:

```
/            0.324 + 0.488 + 2.301 + 0 + 120.859 + 66.841 = 190.813
layout chunk                         0 +   7.775 + 107.926 = 115.701
stream                               0 + 236.185           = 236.185   (receive −1)
stream                               0 +  18.739           =  18.739   (receive −1)
```

The discriminator is therefore proven in both directions from a single trace. Every
request that **finished** has `receive ≥ 0` and `bodySize ≥ 0`. Both requests that
were **still open** have `receive = −1` and `bodySize = −1`, which collapses `time`
to nothing but the wait for headers.

**18.7 ms sits inside the issue's own 5–21 ms band.** That band is a distribution of
time-to-first-byte, not of stream lifetimes. A short trace duration on
`/api/notifications/stream` is what a *healthy* stream looks like.

The HMR WebSocket in the same trace is why the SSE row looked anomalous by
comparison, and it is the exception that proves the rule above. Its timings are
`{"send":-1,"wait":-1,"receive":-1}` — every phase negative, no `dns`/`connect`/`ssl`
keys at all — so the sum rule would give 0, yet its `time` is 10001.5 ms for a ~10 s
run. A WebSocket's duration is accounted connection-wide, so a long-lived one *looks*
long. A long-lived SSE response does not. Two open connections in the same trace,
reported by opposite conventions: 10001.5 next to 18.7.

### 2. The stream also delivers — the half nobody checked

Opening is not the interesting property; delivering is. And there was a concrete
reason to doubt it. `src/app/api/notifications/stream/route.ts` deliberately hangs
its `sseCounts` map off `globalThis`, commented *"Global so every bundle context
shares the same counters"* — this codebase has already been bitten by per-bundle
module duplication. `notificationBus` (`src/lib/event-bus.ts`) is a plain
module-level singleton with **no such protection**. If the emitting route and the
streaming route resolved to different module instances, the stream would open
perfectly, stay open, and silently never deliver anything.

Measured end-to-end, across two different routes in one server process:

```
stream: HTTP 200 content-type=text/event-stream
': connected' preamble received: true
POST /api/students: HTTP 201
notification rows written for the student : 1 ["teacher_invitation"]
event delivered over the open SSE stream  : true
stream ended on its own                   : false

  +0ms   ": connected\n\n"
  +192ms "data: {\"id\":\"5a1f…\",\"type\":\"teacher_invitation\",…"
```

The bus **is** shared across route bundles — in dev. The production bundle, which is
what CI serves, is the one configuration still unmeasured, and is where per-route
bundling actually differs. That is the single strongest argument for the test shape
chosen below.

### 3. `next start` and the standalone server run the same server

- `next/dist/cli/next-start.js:13,102` — `require("../server/lib/start-server")`,
  then `startServer({…})`.
- `.next-build/standalone/server.js` (generated) — `require('next/dist/server/lib/start-server')`,
  then `startServer({…})`.

The standalone entry differs only in setting `__NEXT_PRIVATE_STANDALONE_CONFIG` and
skipping the `next.config.ts` read. The request-handling pipeline is the same code.

The warning itself is advisory. `next/dist/server/next.js:227` is a bare `log.warn`
for `output: 'standalone'`; three lines below, `output: 'export'` **throws**. Next
distinguishes "you did not need this" from "this will not work," and standalone is
the former. So *"CI is exercising a serving mode nothing else uses"* overstates it:
the **entry point** differs, the **server** does not.

### 4. The suggested command names a path this repo does not have

`next.config.ts` sets `distDir: process.env.NODE_ENV === "development" ? ".next" : ".next-build"`.
Production output therefore lives in `.next-build`. The Dockerfile already does it
correctly:

```
COPY --from=build /app/.next-build/standalone ./
COPY --from=build /app/.next-build/static ./.next-build/static
COPY --from=build /app/public ./public
```

The issue's `node .next/standalone/server.js` and `.next/static` are Next's generic
warning text copied verbatim; `.next/standalone/` does not exist in a production
build of this project.

### 5. The original evidence is unrecoverable

Run 29991472315 was created 2026-07-23. Both artifacts report `expired=true`
(`playwright-report`, `server-log`) — `retention-days: 7` in `ci.yml`, and today is
2026-08-08. The 5–21 ms figures cannot be re-read from source. Note also that
`playwright.config.ts` sets `trace: 'on-first-retry'` and `ci.yml` uploads the report
`if: failure()`, so SSE-in-trace evidence only ever exists on a *failing* run.

### 6. The secondary question was the issue's own counter-evidence

#41 asks why no `EventSource` auto-reconnect appeared within the 10–15 s trace
windows. **Because nothing disconnected.** The absence of reconnects is confirming
evidence of a healthy stream, read as a second symptom.

The arithmetic in the issue is right and the timer is wrong. In
`src/components/layout/live-updates.tsx`, the first error takes `attempts` to 1, so
`Math.min(60_000, 2_000 * 2 ** Math.min(1, 5))` = `2_000 × 2` = **4000 ms** — 4 s, as
stated. But that path is unreachable for the failure being hypothesised: `onerror`
returns early unless `readyState === EventSource.CLOSED`, and a cleanly-ended 200
response leaves `EventSource` in CONNECTING, where the **browser's own** ~3 s retry
applies. The custom backoff exists for permanent failures (401, 429), which is what
its docblock says.

### 7. Nothing in the suite covers this route

`/api/notifications/stream` appears nowhere in `tests/` except `visual.spec.ts:162`:

```ts
function hydrationSignal(page: Page): Promise<unknown> {
  return page.waitForResponse((r) => r.url().includes('/api/notifications/stream'));
}
```

`waitForResponse` resolves on **response headers**. It would pass unchanged against a
stream that closes one millisecond later. `src/lib/event-bus.test.ts` covers the bus
in isolation and never touches the route.

This is the actual defect #41 found, one level up from the one it named: the route
had no way to be contradicted.

## What this branch builds

### `tests/integration/notifications-stream.test.ts` — new file

Integration, not unit and not e2e, for a specific reason: the integration project
talks HTTP to whatever serves `:3000` — the dev server locally, **the production
build in CI**. That makes §2's one unmeasured case something CI proves on every run.
A vitest unit test would import the module directly and prove nothing about
bundling; a Playwright test would spend a browser on a server-side property.

Follows the existing integration conventions: `BASE_URL`, `cookie()`, `hashToken()`,
`seedSession()`, `uniqueSuffix()`, `waitFor()` from `tests/helpers.ts`; Prisma for
fixtures and for `afterAll` cleanup.

Fixtures: teacher `T` with a session; student `S` with a claimed account and a
session. (`claimedAt` matters — the invitation path only creates an in-app
notification when a `Student` row already exists for the email, `invitations.ts:372`;
an unclaimed stranger gets an email instead and the test would have nothing to
receive.)

**T1a — the stream stays open.** Open as `S` → assert `200` and
`content-type: text/event-stream`; read until the `: connected` preamble; hold
1000 ms; assert the reader has **not** observed `done`. 1000 ms is a ~50× margin over
the top of the 5–21 ms band §1 shows is really TTFB. Deliberately short of the 30 s
keepalive: pinning that would cost 30 s of CI per run to prove something no user
depends on.

**T1b — the stream delivers, and is still open after.** Open as `S`; read until
`: connected`; `POST /api/students` as `T` with `S`'s email → assert `201`, which runs
`createNotification` **server-side** (`src/services/invitations.ts:381`) and is what
makes the test cross-route; assert a `data:` frame arrives whose parsed `type` is
`teacher_invitation` and whose `id` equals the `Notification` row's id
(`createNotification` emits the real id, `createBulkNotifications` emits the literal
`'bulk'`, so the id assertion also pins which path ran); assert `done` still not
observed.

**T1a and T1b are two `it` blocks, not one.** As a single test, the still-open
assertion would sit after the delivery assertion and mutation 2 below would abort
before reaching it — making the claim "mutation 2 fails delivery only" unobservable.
The split is what makes the two properties independently checkable, which is the
entire point of running two mutations.

No `freshIp()` on the `POST`: `checkStudentWriteLimit` keys on `students:${teacherId}`
(50/hour), not on IP. A fresh teacher per run is already a fresh bucket, and the
header would key nothing while implying the endpoint is IP-limited.

**T2 — no session cookie → 401. T3 — expired session → 401.** T3 seeds a session and
then ages it with `prisma.session.update`, the technique `tests/integration/auth.test.ts`
already uses. Both additionally assert the response `content-type` is **not**
`text/event-stream`, so a regression that hands a live stream to an anonymous caller
fails rather than merely returning the wrong status.

### Proving each guard bites

Three mutations, because T1a and T1b pin independent properties and a single mutation
would not show they are independent. Each: break it, record the exact error text,
restore, re-verify. The mutation **is** the red step — the code is already correct, so
a newly written test passes immediately, and a test nobody has watched fail is not a
guard.

| # | Mutation | Required failure |
|---|---|---|
| 1 | In `route.ts`, call `cleanup()` immediately after `send(': connected\n\n')` — exactly the regression #41 hypothesised | **Both** T1a and T1b fail |
| 2 | `return;` as the first statement of `emitToBus` in `src/services/notifications.ts` | **T1b only.** T1a must still pass |
| 3 | Bypass both auth guards in `route.ts` — take `getSessionToken`'s result unchecked and default `validateSession`'s null to a stub `SessionUser`, so an anonymous caller gets a genuine `200 text/event-stream` | T2 and T3 both fail, on status **and** content-type |

Mutation 2 is the one that matters most, and its required *asymmetry* is the
assertion: if both tests fail, the delivery test was riding on liveness; if neither
does, it is not observing the bus at all. Mutation 3 is deliberately the
"guards stopped standing between the caller and the stream" shape rather than
"someone edited the `401` literal" — the latter is easy to write and tests almost
nothing.

### One comment, no production code

A comment beside `hydrationSignal` in `tests/e2e/visual.spec.ts` recording that
`waitForResponse` resolves on headers, and that a trace's duration for an open SSE
response is TTFB (`receive: -1`, `bodySize: -1`, `time == wait`) — with §1's measured
numbers — pointing at the new integration test as the thing that actually checks
liveness. This is the case where the right home is a comment: the fact is needed at
the moment someone reads an SSE trace, which is exactly when #41 was filed.

## What this branch does not do

- **No production code changes.** `src/app/api/notifications/stream/route.ts`,
  `src/components/layout/live-updates.tsx`, `src/lib/event-bus.ts` and
  `next.config.ts` are untouched. Nothing measured here says any of them is wrong.
- **CI's serving mode is unchanged.** `ci.yml` keeps `npm run start`. The gap is real
  but unrelated to SSE — CI never exercises the standalone bundle production ships, so
  a dependency-tracing bug there would pass CI and fail only in prod. It is
  pre-existing debt this work made *visible*, not worse, so per the project's filing
  rules it does not spawn an issue: the corrected paths and the reasoning go as an
  Update on **#127**, the existing framework-upkeep issue in the same bundle.
- **No browser-level EventSource coverage.** `LiveUpdates`' reconnect behaviour is
  standard `EventSource` semantics plus a documented backoff; §6 shows the reported
  anomaly was not one.
- **Does not itself prove the production bundle shares the bus.** It causes CI to
  prove it on every run, which is the durable version of that.

## Acceptance

- `tests/integration/notifications-stream.test.ts` exists with T1a, T1b, T2 and T3 —
  four tests — and passes against the running app.
- Each of the three mutations has been run, its exact failure output recorded in the
  PR body, and the source restored.
- `npm run verify` is green.
- `visual.spec.ts` carries the trace-measurement comment.
- #41 is closed with the measurement, naming which of its claims were false.
- #127 carries the standalone-parity Update with `.next-build` paths.
