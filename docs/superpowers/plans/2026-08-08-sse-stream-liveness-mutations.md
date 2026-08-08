# SSE stream liveness — mutation log

Durable record that each guard in `tests/integration/notifications-stream.test.ts`
was watched failing before it was trusted to pass. Command run before and after
each mutation: `npx vitest run --project integration tests/integration/notifications-stream.test.ts`.

## Mutation 1 — cleanup() immediately after ': connected'

`src/app/api/notifications/stream/route.ts`, inserted after `send(': connected\n\n');`:

```ts
cleanup(); // MUTATION 1 — REMOVE
```

Result: `2 failed` (matches the brief's top-level prediction). Verbatim output:

```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

 ❯ |integration| tests/integration/notifications-stream.test.ts (2 tests | 2 failed) 6252ms
     × stays open well past the millisecond-scale duration a trace reports for it 1095ms
     × delivers a notification created by a different route, and stays open after 5002ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > stays open well past the millisecond-scale duration a trace reports for it
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ tests/integration/notifications-stream.test.ts:163:28
    161|       await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    162|
    163|       expect(stream.ended).toBe(false);
       |                            ^
    164|     } finally {
    165|       stream.close();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > delivers a notification created by a different route, and stays open after
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/integration/notifications-stream.test.ts:169:3
    167|   });
    168|
    169|   it('delivers a notification created by a different route, and stays …
       |   ^
    170|     const stream = await openStream(studentToken);
    171|     try {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  1 failed (1)
      Tests  2 failed (2)
   Start at  08:13:03
   Duration  6.50s (transform 36ms, setup 0ms, import 105ms, tests 6.25s, environment 0ms)
```

Test 1 failed exactly as predicted: `expect(stream.ended).toBe(false)` received `true`.

Test 2 also failed, but not via the inner `waitFor`'s own thrown error
(`waitFor: condition not met within 8000ms (an SSE data frame for the
invitation notification)`) as the brief's prose anticipated. Vitest's
per-test default timeout is 5000ms (unset in `vitest.config.ts`), which is
*shorter* than that `waitFor` call's own `timeoutMs: 8_000` — so the test
runner's own timeout fires first, at ~5000ms, before the inner `waitFor`
budget is ever exhausted. The underlying cause is identical (mutation 1
closes the connection immediately, so no data frame ever arrives on it) and
the top-level prediction — both tests fail — holds exactly. Only the literal
error text differs from the brief's prose (test-runner timeout vs.
helper-thrown timeout error). Noted here rather than adjusting the test to
force the predicted message, per the branch's instruction not to code around
a mismatch.

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

 ❯ |integration| tests/integration/notifications-stream.test.ts (2 tests | 1 failed) 8096ms
     × delivers a notification created by a different route, and stays open after 5004ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > delivers a notification created by a different route, and stays open after
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/integration/notifications-stream.test.ts:169:3
    167|   });
    168|
    169|   it('delivers a notification created by a different route, and stays …
       |   ^
    170|     const stream = await openStream(studentToken);
    171|     try {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  08:14:48
   Duration  8.33s (transform 34ms, setup 0ms, import 89ms, tests 8.10s, environment 0ms)
```

The liveness test ("stays open well past the millisecond-scale duration...")
passed — confirmed by its absence from the failures list and by `1 passed` in
the summary. Only the delivery test failed, exactly the asymmetry the brief
predicts: mutation 2 silences the bus without touching the connection, so the
first assertion (connection stays open) is unaffected while the second
(a notification arrives on it) has nothing to receive. As with mutation 1,
the failure surfaces via vitest's own 5000ms per-test timeout rather than the
inner `waitFor`'s 8000ms budget or its own thrown error text — same
test-runner-timeout-fires-first mechanism, not a new finding.
