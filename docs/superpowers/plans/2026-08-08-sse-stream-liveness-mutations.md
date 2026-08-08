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

**Numbering note.** Mutation 4 appears *before* Mutation 3 below. Mutations 1
and 2 were planned and run under Task 1; Mutation 3 was planned and run under
Task 2. Mutation 4 was added later — during a whole-branch review's fix round,
to prove the delivery test's trailing `stream.ended` assertion, a property
neither Mutation 1 nor Mutation 2 reaches. It is numbered 4 because Mutation 3
already existed by the time it was written, but it is filed here next to
Mutations 1 and 2 because all three exercise the delivery test's own guards;
the ordering in this file is by task and by what each mutation proves, not by
mutation number.

## Mutation 1 — cleanup() immediately after ': connected'

`src/app/api/notifications/stream/route.ts`, inserted after `send(': connected\n\n');`:

```ts
cleanup(); // MUTATION 1 — REMOVE
```

Result: `2 failed` (matches the brief's top-level prediction). **Provenance:**
recorded when the file held only these two tests (T2/T3 did not exist yet),
so the summary below reads `(2 tests | 2 failed)`. Re-running today against
the four-test file gives `2 failed | 2 passed` — the same liveness and
delivery tests fail, and the two auth tests pass, unaffected: the 401 guards
return before `ReadableStream.start()` runs, so no stream-body mutation can
affect them. The conclusion is unchanged. Verbatim output:

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
the delivery test failed. **Provenance:** recorded when the file held only
these two tests, so the summary below reads `(2 tests | 1 failed)`.
Re-running today against the four-test file gives `1 failed | 3 passed` — the
delivery test still fails, and the liveness test plus the two auth tests
pass, unaffected: this mutation silences `emitToBus` in
`src/services/notifications.ts`, a file the 401 guards never reach. The
conclusion is unchanged. Verbatim output:

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
`send` runs before `cleanup` in the mutated handler). **Provenance:** recorded
when the file held only these two tests, so the summary below reads
`(2 tests | 1 failed)`. Re-running today against the four-test file gives
`1 failed | 3 passed` — the delivery test still fails on the same trailing
assertion, and the liveness test plus the two auth tests pass, unaffected:
this mutation is inside the bus-delivery handler, which runs only once a
session has already passed the 401 guards. The conclusion is unchanged.
Verbatim output:

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

## Mutation 3 — both auth guards bypassed

`src/app/api/notifications/stream/route.ts`, replaced:

```ts
  const token = getSessionToken(request);
  if (!token) {
    return new Response('Unauthorized', { status: 401 });
  }
  const session = await validateSession(prisma, token);
  if (!session) {
    return new Response('Session expired', { status: 401 });
  }
```

with:

```ts
  // MUTATION 3 — REMOVE, restore the block below from git
  const token = getSessionToken(request);
  const session = (await validateSession(prisma, token ?? '')) ?? {
    sessionId: 'mutant',
    accountId: 'mutant-account',
    teacherId: null,
    studentId: 'mutant-student',
  };
```

This is the realistic shape of the regression — not "someone edited the 401
literal" but "the auth guards stopped standing between an anonymous request
and the stream." An anonymous caller now receives a genuine
`200 text/event-stream`.

**Re-recorded for the whole-branch review's finding F1.** Both auth tests'
status and content-type assertions were changed from a throwing `expect` to
`expect.soft` (see the test file), specifically so this mutation could show
both assertions failing in the same run. Under the original throwing
`expect`, the content-type line was never reached once the status assertion
threw first — the recording below replaces the original, which showed only
the status failure, even though three artifacts (the spec, the plan, and
commit `49ccdc3`'s message) already claimed both had been observed failing.
They had not; this run is that observation.

Result: `2 failed | 2 passed` — the two new auth tests fail, each now on
**both** its status and content-type assertions; the liveness and delivery
tests are unaffected. Verbatim output:

```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

 ❯ |integration| tests/integration/notifications-stream.test.ts (4 tests | 2 failed) 1368ms
     × refuses a request with no session cookie 11ms
     × refuses an expired session 16ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > refuses a request with no session cookie
AssertionError: expected 200 to be 401 // Object.is equality

- Expected
+ Received

- 401
+ 200

 ❯ tests/integration/notifications-stream.test.ts:261:34
    259|       // the second ever ran, so a broken content-type guard could hide
    260|       // behind a broken status guard indefinitely.
    261|       expect.soft(stream.status).toBe(401);
       |                                  ^
    262|       // Not just the status: a regression that hands a live stream to…
    263|       // anonymous caller must fail here even if it somehow kept a 401.

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/4]⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > refuses a request with no session cookie
AssertionError: expected 'text/event-stream' not to contain 'text/event-stream'
 ❯ tests/integration/notifications-stream.test.ts:264:49
    262|       // Not just the status: a regression that hands a live stream to…
    263|       // anonymous caller must fail here even if it somehow kept a 401.
    264|       expect.soft(stream.contentType ?? '').not.toContain('text/event-…
       |                                                 ^
    265|     } finally {
    266|       stream.close();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/4]⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > refuses an expired session
AssertionError: expected 200 to be 401 // Object.is equality

- Expected
+ Received

- 401
+ 200

 ❯ tests/integration/notifications-stream.test.ts:285:34
    283|       // properties must be independently observable under a single
    284|       // mutation, otherwise the second is decoration.
    285|       expect.soft(stream.status).toBe(401);
       |                                  ^
    286|       expect.soft(stream.contentType ?? '').not.toContain('text/event-…
    287|     } finally {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/4]⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > refuses an expired session
AssertionError: expected 'text/event-stream' not to contain 'text/event-stream'
 ❯ tests/integration/notifications-stream.test.ts:286:49
    284|       // mutation, otherwise the second is decoration.
    285|       expect.soft(stream.status).toBe(401);
    286|       expect.soft(stream.contentType ?? '').not.toContain('text/event-…
       |                                                 ^
    287|     } finally {
    288|       stream.close();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯


 Test Files  1 failed (1)
      Tests  2 failed | 2 passed (4)
   Start at  08:53:55
   Duration  1.58s (transform 36ms, setup 0ms, import 88ms, tests 1.37s, environment 0ms)
```

Both failing tests now fail on two independent assertions:
`expect.soft(stream.status).toBe(401)` receives `200`, and
`expect.soft(stream.contentType ?? '').not.toContain('text/event-stream')`
fails because the mutation hands a genuine `text/event-stream` response to
an anonymous caller — the content-type guard the status check alone cannot
prove. Soft assertions are what make both visible in one run; a throwing
`expect` would have stopped at the first, which is exactly what the original
recording did. The liveness and delivery tests are absent from the failures
list — `2 passed` in the summary confirms both were unaffected by an
anonymous caller's guard being bypassed. (The two failures listed above are
`refuses a request with no session cookie` and `refuses an expired
session` — the auth tests themselves, not the liveness/delivery pair.)

Restored via `git checkout src/app/api/notifications/stream/route.ts`;
`git status --porcelain src/` was empty afterward; re-verified `4 passed`.
