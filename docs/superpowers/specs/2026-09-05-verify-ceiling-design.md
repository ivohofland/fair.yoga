# A ceiling on `/verify`'s verifying state (#446)

## What was measured, and what the issue got wrong

#446 reports that `/verify` bounds how *soon* its interstitial may appear and
how *briefly* it may stay, but bounds nothing at the far end: a verification
request that never answers leaves the reader on the rail forever, with no
error, no control, and no log line.

**The mechanism holds exactly as described.** Confirmed by reading:

- `page.tsx`'s verification effect calls `fetch('/api/auth/magic-link/verify')`
  with no `AbortSignal` and no timeout.
- `useVerifyingRail` arms two timers, `appearTimer` (`RAIL_APPEARS_AFTER_MS`)
  and `stayTimer` (`RAIL_STAYS_FOR_MS`). Both bound the near end. Nothing
  bounds the far one.
- Every exit from `verifying` runs through `settle`, and `settle` is only ever
  reached from the fetch's `.then` or `.catch`. A promise that never settles
  reaches neither.

**"Not introduced by PR #445" holds too**, and is worth recording because that
PR is where the rail's timing became something anyone reasons about. At
`d5ae960d~1` the fall-through was a bare `return <VerifyingState />;` and the
Suspense fallback was `fallback={<VerifyingState />}` — the rail painted
immediately and stayed forever. After #445 a hung request never calls
`settle`, so the appearance timer fires normally and the rail shows at
`RAIL_APPEARS_AFTER_MS`. The same stuck screen, arriving later.

**The signup-reload trap holds, and has a second cause the issue does not
name.** `magic-link/verify/route.ts`'s signup branch mints a ticket and calls
`clearSessionCookie` — it never creates a session. So a reader who reloads
after a stall that consumed their token gets a 400 from the verify POST, falls
into the `.catch`, and the session probe finds nothing. But `/api/auth/session`
answers a sessionless request with an error *response*, not a throw: `res.ok`
is false, the `catch (err)` around the probe never runs, and the page lands on
`ErrorState` — "This link can't be used" — having logged nothing. The issue's
"no console line" is true, and true for this second reason as well.

### The acceptance criterion that cannot be met

> *"The threshold is justified by something measured against a deployed
> instance, not by a round number."*

**There is no deployed instance.** `fair.yoga` resolves to no A record;
`DEPLOYMENT.md` is a recipe whose `server_name`, certificate paths and
`NEXT_PUBLIC_APP_URL` all read `yourdomain.example`. Confirmed with the
project owner: not in production yet.

This is not a reason to defer the fix. It is a sign the issue framed its first
question wrongly. A ceiling cannot be *derived* pre-production, because the
quantity it must clear — the worst latency a real network still delivers a
successful verification through — is precisely what does not yet exist to
measure. No amount of local measurement produces it.

**So the criterion is replaced, not satisfied:**

> A verification that never answers ends in a state whose *wrongness is cheap*.
> The threshold is provisional and declared as such; an early fire costs the
> reader one re-sent email, never an account, and the constant's docblock names
> the evidence that would revise it.

This reframes the problem from "get the number right" — impossible now — to
"make the number's being wrong survivable", which is achievable today and is
what the copy and the recovery below are built to deliver.

### Two anchors that do exist

Neither justifies a threshold on its own; both bound the space it sits in.

- **The fast path.** Six variants driven through the dev server for #445
  (`plans/2026-09-04-verify-rail-flash.md`, rows A–F) put a successful
  verification at 89–194ms. All localhost, so this is a floor on plausible
  latency and says nothing about the tail.
- **The proxy.** `deploy/nginx.conf.example` sets `proxy_read_timeout 24h` on
  the `/api/notifications/stream` location only. The `location /` block sets
  no `proxy_read_timeout`, so it takes nginx's documented default of 60s.
  On that topology a request the app has not answered in 60s is already cut by
  the proxy, and the client's existing `.catch` handles the 504.

The gap between them is where the ceiling lives. It also shows why the ceiling
is needed at all: **every stall #446 names — a captive portal that accepts and
holds, a dropped TCP connection with no RST — happens in front of nginx**,
where no server-side bound can reach it. The proxy timeout covers the stalls
the client would have survived anyway.

## Design

### One ceiling, on the state rather than on each request

The issue's fourth question asks whether the same ceiling belongs on the
`/api/auth/session` probe, calling it "a second round trip with the same
failure mode". It is not quite parallel: the probe runs only *after* the verify
POST has failed. Two per-request timeouts would therefore mean two timers and
two thresholds on one screen — and with no deployment, two numbers to justify
instead of one.

A single ceiling on the `verifying` **state** covers both round trips with one
timer. It also fits `useVerifyingRail`'s existing subject, whose docblock
already says a screen's lifetime has two ends: the appearance timer and the
stay timer bound the near end, and this bounds the far one.

The ceiling is armed at mount, alongside the appearance timer and under the
same `enabled` condition, and measures what the reader actually experiences —
time since they tapped the link. `enabled` is `Boolean(token)`, so a `/verify`
with no token — already in `error` before any timer exists — arms no ceiling,
exactly as it arms no appearance timer today.

### The invariant: `verifying` has one exit, and the first to take it wins

`settle` cancels the ceiling. The ceiling makes every later `settle` inert.

One rule, three hazards paid for:

1. **The timeout state cannot be overwritten.** Aborting the fetch rejects it,
   which reaches the `.catch`, which would otherwise run the probe and call
   `settle(() => setStatus('error'))` — replacing an honest "we couldn't reach
   the server" with a false "this link can't be used".
2. **A late response cannot redirect a reader who has moved on.** The success
   branch schedules `setTimeout(() => router.push(dest), …)` *inside* the
   `settle` callback, and that timer is not cleared on unmount. Today this is
   unreachable, because a stranded reader has no control to navigate away with.
   Giving them one makes it reachable — a response landing well after they
   tapped "Send a new link" would yank them off `/login`. An inert `settle`
   never runs the callback, so the timer is never scheduled.
3. **The existing double-settle concern extends cleanly.** The hook already
   logs when a second outcome arrives while one is held; "first exit wins" is
   the same rule stated for the whole state.

### Aborting the fetch

The page holds an `AbortController` in a ref, passes its signal to both
fetches, and aborts on the ceiling. The `.catch` short-circuits when
`signal.aborted`, so a dead verification does not fire a pointless session
probe or log a spurious probe failure.

**This is hygiene, not correctness** — the inert-`settle` invariant already
supplies the correctness, and saying so plainly is better than dressing the
abort up as necessary. It earns its place for two reasons: a page that says it
could not reach the server while still holding an open request to that server
is asserting something it has not acted on; and `signal.aborted` gives the
tests a positive observable rather than only an absence.

### The constant

```ts
export const VERIFY_CEILING_MS = 20_000;
```

Exported beside `RAIL_APPEARS_AFTER_MS` and `RAIL_STAYS_FOR_MS` so tests step
by it rather than by a copy of it.

**Why 20 seconds.** The slowest successful verification on record is 194ms, so
20s is roughly 103× the slowest thing ever measured to work
(20000 / 194 = 103.1). That margin is not evidence — it is an admission that
no evidence is available, sized so that clearing the real tail is very likely
and so that being wrong is cheap. It sits below the 60s the proxy already
enforces, so on the documented topology it never cuts a request nginx would
still have been carrying.

The docblock states what the constant bounds, that it is provisional and why,
what would revise it, and that an early fire is survivable by construction. Per
*Comment Discipline* it does **not** restate the 89–194ms figures: those are
facts about another document, and a comment carrying them has no owner. The
arithmetic lives here, in this spec, which is where a reader is sent.

### The state and its copy

`'timeout'` joins the `Status` union; `TimedOutState` renders it.

The copy follows the house pattern already established for this exact
distinction in `share-room-button.tsx`, whose comment reads "The two reasons
need different sentences" — name the failure, then say what is still true:

> **Connection problem**
> **We couldn't reach the server.**
>
> Your link may have worked anyway — we just never got an answer. If it did,
> that link is spent now, so use a fresh one.
>
> **[ Send a new link ]** → `/login`

Danger-coloured label, as `ErrorState` uses, because this is a failure the
reader must act on.

The second sentence is load-bearing. It is the only honest thing the page can
say — the client genuinely cannot know whether the token was consumed — and it
is what converts a too-early ceiling from a lie into an inconvenience.

**Recovery is "Send a new link" and nothing else.** Re-posting the same token
is unsafe: it may already be spent, and for a signup reader there is no session
to fall back on. A "continue to your dashboard" link was considered and
rejected: `/schedule` calls `requireTeacherSession`, which `redirect('/login')`s
anyone without a *teacher* session, so it would be right for a teacher and
would drop a signed-in student on a login form — and the page cannot tell which
family it is addressing, because that arrived in the response it never
received.

### Logging

`console.error('[verify] no answer within the ceiling; giving up')`, joining
the three `[verify]` lines the file already carries.

## Tests

On the existing `deferredFetch` / `advance` harness in `page.test.tsx`. Each
case ships with the mutation that must make it fail.

| # | Case | Mutation that must break it |
|---|---|---|
| 1 | A response landing past the rail's window but inside the ceiling still signs the reader in | Arm the ceiling at `RAIL_STAYS_FOR_MS` |
| 2 | The ceiling reaches the timeout state, and not `ErrorState` | Route the ceiling to `setStatus('error')` |
| 3 | A fast verification cancels the ceiling — advance past it, still on success | Drop the cancel in `settle` |
| 4 | Resolving the fetch after the ceiling changes nothing, and issues no redirect | Drop the inert-`settle` guard |
| 5 | A verify POST that fails fast, then a probe that never answers, still reaches the ceiling | Arm the ceiling inside the fetch's `.then` |
| 6 | The fetch signal is aborted | Drop the `abort()` call |
| 7 | The failure is logged with the `[verify]` prefix | Drop the `console.error` |

Case 1 is #446's acceptance criterion 3. Case 2 is criterion 1. Case 5 is the
issue's fourth question, pinned. Case 7 is criterion 4.

## Scope

**In:** `src/app/(public)/verify/page.tsx`, `page.test.tsx`, and a correction
to #446's acceptance criterion 2 on the issue itself.

**Out:** every other client `fetch` in the app is likewise unbounded. That is
pre-existing, this change does not worsen it, and a general fetch-timeout
policy is a decision of its own rather than a spin-out of this one. **#254 and
#435 are unaffected** — both concern the near end of the rail's life and are
closed by #445.
