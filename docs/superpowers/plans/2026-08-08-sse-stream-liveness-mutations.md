# SSE stream liveness — mutation log

Durable record that each guard in `tests/integration/notifications-stream.test.ts`
was watched failing before it was trusted to pass. Command run before and after
each mutation: `npx vitest run --project integration tests/integration/notifications-stream.test.ts`.

**Fix round 1 note:** the entries below for Mutations 1 and 2 were re-recorded
after fixing F1 (task review, fix round 1/5). The file's original two `it`
blocks had no explicit test timeout, so vitest's unconfigured 5000ms default
(`vitest.config.ts` sets no `testTimeout`) bound each one — and both inner
`waitFor` calls in the delivery test (`timeoutMs: 5_000` for the preamble,
`8_000` for the data frame) had budgets vitest's own timeout could never let
run to completion. The first recording of Mutations 1 and 2 therefore showed
the delivery test failing with a generic `Error: Test timed out in 5000ms`
rather than the `waitFor` helper's own descriptive message — evidence that
named "the test did not finish" but not "no data frame arrived". Each `it` now
takes an explicit third-argument timeout above the sum of its own internal
budgets (10_000ms for the liveness test, 20_000ms for the delivery test), so
the inner `waitFor` is now the binding constraint and its message is what
actually surfaces. The entries below are the re-recorded, corrected output.

## Mutation 1 — cleanup() immediately after ': connected'

`src/app/api/notifications/stream/route.ts`, inserted after `send(': connected\n\n');`:

```ts
cleanup(); // MUTATION 1 — REMOVE
```

Result: `2 failed` (matches the brief's top-level prediction). Verbatim output:

```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

 ❯ |integration| tests/integration/notifications-stream.test.ts (2 tests | 2 failed) 9319ms
     × stays open well past the millisecond-scale duration a trace reports for it 1096ms
     × delivers a notification created by a different route, and stays open after 8094ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > stays open well past the millisecond-scale duration a trace reports for it
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ tests/integration/notifications-stream.test.ts:165:30
    163|         await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    164|
    165|         expect(stream.ended).toBe(false);
       |                              ^
    166|       } finally {
    167|         stream.close();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > delivers a notification created by a different route, and stays open after
Error: waitFor: condition not met within 8000ms (an SSE data frame for the invitation notification)
 ❯ waitFor tests/helpers.ts:213:13
    211|     if (Date.now() >= deadline) {
    212|       const suffix = description ? ` (${description})` : '';
    213|       throw new Error(`waitFor: condition not met within ${timeoutMs}m…
       |             ^
    214|     }
    215|     await new Promise((resolve) => setTimeout(resolve, intervalMs));
 ❯ tests/integration/notifications-stream.test.ts:209:23

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  1 failed (1)
      Tests  2 failed (2)
   Start at  08:23:31
   Duration  9.56s (transform 41ms, setup 0ms, import 99ms, tests 9.32s, environment 0ms)
```

Test 1 failed exactly as predicted: `expect(stream.ended).toBe(false)` received
`true`.

Test 2 now fails via the inner `waitFor`'s own thrown error —
`waitFor: condition not met within 8000ms (an SSE data frame for the
invitation notification)` — exactly naming the condition that stalled, now
that the explicit 20_000ms test timeout gives that 8_000ms budget room to run
to completion. (First recording, before the F1 fix, showed
`Error: Test timed out in 5000ms` with no mention of a data frame — see the
fix-round note above.)

## Mutation 2 — emitToBus made a no-op

`src/services/notifications.ts`, inserted at the top of `emitToBus`:

```ts
function emitToBus(input: CreateNotificationInput, id: string): void {
  return; // MUTATION 2 — REMOVE
  try {
```

Result: `1 failed | 1 passed`, as predicted — the liveness test passed and only
the delivery test failed. Verbatim output:

```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

 ❯ |integration| tests/integration/notifications-stream.test.ts (2 tests | 1 failed) 9467ms
     × delivers a notification created by a different route, and stays open after 8177ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > delivers a notification created by a different route, and stays open after
Error: waitFor: condition not met within 8000ms (an SSE data frame for the invitation notification)
 ❯ waitFor tests/helpers.ts:213:13
    211|     if (Date.now() >= deadline) {
    212|       const suffix = description ? ` (${description})` : '';
    213|       throw new Error(`waitFor: condition not met within ${timeoutMs}m…
       |             ^
    214|     }
    215|     await new Promise((resolve) => setTimeout(resolve, intervalMs));
 ❯ tests/integration/notifications-stream.test.ts:209:23

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  08:23:58
   Duration  9.68s (transform 36ms, setup 0ms, import 84ms, tests 9.47s, environment 0ms)
```

The liveness test ("stays open well past the millisecond-scale duration...")
passed — confirmed by its absence from the failures list and by `1 passed` in
the summary. Only the delivery test failed, exactly the asymmetry the brief
predicts: mutation 2 silences the bus without touching the connection, so the
first assertion (connection stays open) is unaffected while the second
(a notification arrives on it) has nothing to receive. And, as with mutation 1
above, the failure now surfaces via the inner `waitFor`'s own descriptive
message — `waitFor: condition not met within 8000ms (an SSE data frame for
the invitation notification)` — rather than a generic runner timeout. (First
recording showed `Error: Test timed out in 5000ms`; see the fix-round note
above.)

## Mutation 4 — bus handler closes the stream right after sending

Added in fix round 1 (F4) to prove the delivery test's own trailing
`expect(stream.ended).toBe(false)` — a genuinely distinct property from the
liveness test's "still open after a hold": this one is "still open *after
delivering*". Neither Mutation 1 nor Mutation 2 above reaches that assertion —
both time out earlier in the same test, on the `waitFor` for the data frame —
so until this mutation, the trailing assertion had never been watched
failing.

`src/app/api/notifications/stream/route.ts`, inserted inside `handler`,
right after the `send(...)` call it makes when an event is for this
connection — a plausible real regression ("the stream closes after its first
event"):

```ts
        if (mine) {
          send(`data: ${JSON.stringify(event.notification)}\n\n`);
          cleanup(); // MUTATION 4 — REMOVE
        }
```

Result: `1 failed | 1 passed`, as predicted — the liveness test passed, and
the delivery test failed specifically on its trailing `stream.ended`
assertion (not on the data-frame `waitFor`: the frame *did* arrive, since
`send` runs before `cleanup` in the mutated handler). Verbatim output:

```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

 ❯ |integration| tests/integration/notifications-stream.test.ts (2 tests | 1 failed) 1337ms
     × delivers a notification created by a different route, and stays open after 135ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > delivers a notification created by a different route, and stays open after
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ tests/integration/notifications-stream.test.ts:237:30
    235|         expect(payload).toMatchObject({ id: row.id });
    236|
    237|         expect(stream.ended).toBe(false);
       |                              ^
    238|       } finally {
    239|         stream.close();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  08:24:27
   Duration  1.57s (transform 42ms, setup 0ms, import 106ms, tests 1.34s, environment 0ms)
```

The failure lands at 135ms — fast, because the data frame arrives almost
immediately and the payload/id assertions above it (lines up to 235) all
pass; only the final "still open" check catches the mutation. The liveness
test passed (absent from the failures list, `1 passed` in the summary),
confirming the same asymmetry Mutation 2 demonstrated: this mutation touches
only what happens *after* a notification is delivered, so a test that never
delivers one is unaffected.

Restored via `git checkout src/app/api/notifications/stream/route.ts`;
re-verified `2 passed` afterward.
