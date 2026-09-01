# SSE stream slot-release — mutation log (#189)

Durable record that the guard added to `tests/integration/notifications-stream.test.ts`
(`frees exactly one slot when exactly one of its five open streams closes`) was
watched failing three ways before it was trusted to pass. Command run before
and after every mutation: `npx vitest run --project integration
tests/integration/notifications-stream.test.ts`. `route.ts`'s handler runs
inside `next dev`'s lazily-recompiling dev server, so a bare `curl` against the
route was sent first after every edit to warm it — an unwarmed first request
can blow the test's own timeout and read as a false RED (`solve-issue`'s
mutation-testing hazard note).

**Reading the line numbers below.** Every line number named in the prose or
inside a captured `vitest` output block is *as recorded at the moment each
mutation ran* — before this PR's own review fix round added to
`pollForStatus`'s docblock, rewrote two other comments, and widened its
default timeout. That round shifted every assertion a few lines down (the
three this file mutates moved from 515/531/538 to 523/539/546). The numbers
below are deliberately **not** rewritten, for the same reason the sibling
`2026-08-08-sse-stream-liveness-mutations.md` gives: a verbatim block edited
after capture is no longer verbatim. Locate an assertion by the source line
printed underneath it in each block, not by the number.

**Premise check, before any mutation.** The issue's own proposed shape —
open 5, close ALL 5, reopen once — was measured against a mutation it does not
name: an unconditional `sseCounts.delete(userKey)` in `cleanup` instead of a
per-stream decrement. Draining the counter to zero either way, a correct
decrement and an unconditional one agree, so that shape cannot tell them
apart. The test built here instead closes exactly ONE of five and checks that
exactly one slot re-opens — the boundary, not the drain. Mutation (c) below is
what a "close all five" design would have missed.

## Mutation (a) — raise the cap so it can't bind

`src/app/api/notifications/stream/route.ts:9`:

```diff
- const MAX_STREAMS_PER_USER = 5;
+ const MAX_STREAMS_PER_USER = 500;
```

**Predicted:** the cap assertion (6th stream) fails, since 500 streams never
hits it. The exactness assertion also fails — with no cap, "no room for one
more" is unobservable, so removing the instrument the test reads exactness
through fails that assertion too, by construction rather than as a
coincidence. The control assertion (reopen after closing one) passes: the
decrement itself is untouched.

**Recorded:**

```
 ❯ |integration| tests/integration/notifications-stream.test.ts (6 tests | 1 failed) 1612ms
     × frees exactly one slot when exactly one of its five open streams closes 134ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > frees exactly one slot when exactly one of its five open streams closes
AssertionError: expected 200 to be 429 // Object.is equality

- Expected
+ Received

- 429
+ 200

 ❯ tests/integration/notifications-stream.test.ts:515:35
    513|
    514|         const sixth = await openOn();
    515|         expect.soft(sixth.status).toBe(429);
       |                                   ^
    516|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > frees exactly one slot when exactly one of its five open streams closes
AssertionError: expected 200 to be 429 // Object.is equality

- Expected
+ Received

- 429
+ 200

 ❯ tests/integration/notifications-stream.test.ts:538:35
    536|         // this extra stream too — this is what that mutation cannot p…
    537|         const extra = await openOn();
    538|         expect.soft(extra.status).toBe(429);
       |                                   ^
    539|       } finally {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

Matches the prediction exactly: lines 515 and 538 fail (soft, both surfaced in
one run); the control at line 531 (`reopened.status`) is absent from the
failure list — it passed.

Restored via `git checkout src/app/api/notifications/stream/route.ts`;
`diff` against the pre-mutation copy showed no residual change. Re-verified
green: `Test Files 1 passed (1)`, `Tests 6 passed (6)`.

## Mutation (b) — delete the decrement outright

`src/app/api/notifications/stream/route.ts`, replacing:

```ts
const count = (sseCounts.get(userKey) ?? 1) - 1;
if (count <= 0) sseCounts.delete(userKey);
else sseCounts.set(userKey, count);
```

with:

```ts
// MUTATION (b), issue #189: decrement deleted entirely.
```

**Predicted:** the cap assertion still passes (the cap is untouched). The
control assertion — reopen after closing one stream — fails: the counter
never drops below 5, so every reopen attempt inside `pollForStatus`'s
then-2-second ceiling (widened to 5s by this PR's own review fix round — see
the header note above) keeps getting 429, and the poll returns its last
(429) attempt. The final "extra" assertion passes, but vacuously — the
account is still at cap for a reason that has nothing to do with the
property it exists to check.

**Recorded:**

```
 ❯ |integration| tests/integration/notifications-stream.test.ts (6 tests | 1 failed) 3638ms
     × frees exactly one slot when exactly one of its five open streams closes 2139ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > frees exactly one slot when exactly one of its five open streams closes
AssertionError: expected 429 to be 200 // Object.is equality

- Expected
+ Received

- 200
+ 429

 ❯ tests/integration/notifications-stream.test.ts:531:38
    529|         const reopened = await pollForStatus(capToken, 200);
    530|         toClose.push(reopened);
    531|         expect.soft(reopened.status).toBe(200);
       |                                      ^
    532|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

The test's own duration (2139ms) confirms `pollForStatus` actually spent its
full ~2000ms ceiling — as it stood at the time this mutation ran, before the
fix round's 5_000ms widening — retrying before giving up. This is the poll
doing its job, not a hang. Only line 531 fails; the cap assertion and the
final "extra" assertion are both absent from the failure list, exactly as
predicted.

Restored via `git checkout src/app/api/notifications/stream/route.ts`;
`diff` against the pre-mutation copy showed no residual change. Re-verified
green: `Test Files 1 passed (1)`, `Tests 6 passed (6)`.

## Mutation (c) — free the whole account instead of one slot

The mutation the issue's own proposed test shape (close all five, then
reopen) could not have caught, because draining the counter to zero makes
this bug indistinguishable from a correct decrement.

`src/app/api/notifications/stream/route.ts`, replacing the same three lines
with:

```ts
// MUTATION (c), issue #189: frees the WHOLE account, not one slot.
sseCounts.delete(userKey);
```

**Predicted:** the cap assertion passes (untouched). The control assertion
passes — the account genuinely does free up, just too much of it — so
`pollForStatus`'s first attempt already returns 200. The final "extra"
assertion fails: with the whole account reset to zero by closing one of five,
four slots that should still read as occupied instead read as free, and the
next open succeeds instead of hitting 429.

**Recorded:**

```
 ❯ |integration| tests/integration/notifications-stream.test.ts (6 tests | 1 failed) 1578ms
     × frees exactly one slot when exactly one of its five open streams closes 121ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > frees exactly one slot when exactly one of its five open streams closes
AssertionError: expected 200 to be 429 // Object.is equality

- Expected
+ Received

- 429
+ 200

 ❯ tests/integration/notifications-stream.test.ts:538:35
    536|         // this extra stream too — this is what that mutation cannot p…
    537|         const extra = await openOn();
    538|         expect.soft(extra.status).toBe(429);
       |                                   ^
    539|       } finally {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

Only line 538 fails — the signature distinct from both (a) and (b), as
required for three mutations to certify three separate things rather than one
property wearing three assertions.

Restored via `git checkout src/app/api/notifications/stream/route.ts`;
`diff` against the pre-mutation copy showed no residual change. Re-verified
green: `Test Files 1 passed (1)`, `Tests 6 passed (6)`.

## Standalone-build verification

Every mutation above ran against `next dev`. That leaves open exactly the
question issue #41's whole lineage exists to ask: does the property hold in
the runtime CI (and production) actually use, or only in a dev server that
recompiles lazily and never runs another file concurrently?

Built and ran the real thing: `npm run build`, started
`.next-build/standalone/server.js` on an alternate port (`:3099` — the
running dev server owns `:3000` and was never touched or restarted), with
`RESEND_API_KEY`/`EMAIL_DRY_RUN=1`/`EMAIL_FROM` set to match
`.github/workflows/ci.yml`'s integration job exactly. Then:

```
INTEGRATION_BASE_URL=http://localhost:3099 npx vitest run --project integration --file-parallelism
```

— CI's own invocation, verbatim, against the standalone bundle, all 35
integration files running concurrently per the `--file-parallelism` flag
this PR's `vitest.config.ts`/`docs/test-database.md` correction describes.

**First run: 8 failures, all in `signup-api.test.ts` and
`auth-email-case.test.ts`, all 500s.** Investigated before concluding
anything about the guard: the standalone server's log named the cause —
`RESEND_API_KEY is not configured — cannot send magic-link email`, from
`src/lib/email.ts`'s `sendMagicLinkEmail`. The server had been started by
sourcing this repo's own `.env` (a real, non-placeholder key) rather than
CI's `RESEND_API_KEY: re_test` / `EMAIL_DRY_RUN: '1'`, and
`emailDryRun()`'s `NODE_ENV === 'production'` branch throws rather than
falling back to a console-logged link — by design (`email.ts`'s own comment:
an unintentional missing key must fail loudly, not leak a sign-in link to
stdout while telling the user to check their inbox). Restarted with CI's
exact three env vars; both files then passed clean (16/16). This was a gap
in the verification harness, not in `route.ts` or in application behaviour —
recorded here rather than silently redone, since a wrong first reading would
otherwise be indistinguishable from a real regression to a future reader of
this log.

**Second run, correctly configured: green.** `Test Files 35 passed (35)`,
`Tests 565 passed (565)`, including all 6 tests in
`notifications-stream.test.ts` — the new slot-release test among them. The
property this PR exists to prove — a closed stream frees its slot — holds
under the exact runtime and concurrency CI uses, not only under `next dev`.

Standalone server stopped afterward; `.next-build/` is gitignored and
untouched by this PR's diff.

## Signature table

| Mutation | cap (6th → 429) | control (reopen → 200) | exactness (next → 429) |
|---|---|---|---|
| (a) cap → 500 | fails | passes | fails |
| (b) no decrement | passes | fails | passes (vacuous) |
| (c) unconditional delete | passes | passes | fails |

Three mutations, three distinct failure signatures. No production code was
changed by this issue — `route.ts` carries the same behaviour it did before,
confirmed identical after every restore via `diff` against a pre-mutation
copy.
