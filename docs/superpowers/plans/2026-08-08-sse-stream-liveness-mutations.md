# SSE stream liveness — mutation log

Durable record that each guard in `tests/integration/notifications-stream.test.ts`
was watched failing before it was trusted to pass. Command run before and after
each mutation: `npx vitest run --project integration tests/integration/notifications-stream.test.ts`.

**Reading the line numbers below.** Every `notifications-stream.test.ts:NNN`
inside a verbatim block is *as recorded* — vitest printed it against the file as
it stood at that moment. The file has grown since (a longer `openStream`
docblock in `131ffe1`; the `error` field, the `firstDataFrame` helper and the
ownership test in the PR fix wave), so those numbers no longer point at the
lines quoted beside them. They are deliberately **not** rewritten: a verbatim
block edited after capture is no longer verbatim, and chasing the numbers would
need doing again after every edit. Locate an assertion by the source line
printed underneath it, not by its number.

**Reading the prose beside each block.** Where an entry says what a re-run
"gives" without a captured block underneath, that sentence is a **summary**, not
recorded output — it is flagged as such at each site.

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

Mutations 5 and 6 were added later still, in the PR fix wave, for two guards
that did not exist when the plan was written: the route's **ownership**
predicate (which `const mine = true` left every prior test passing) and the
`openStream` **`error`** field (which is what makes a dirty connection death
distinguishable from a live stream). They are appended at the end, after
Mutation 3.

## Mutation 1 — cleanup() immediately after ': connected'

`src/app/api/notifications/stream/route.ts`, inserted after `send(': connected\n\n');`:

```ts
cleanup(); // MUTATION 1 — REMOVE
```

Result: `2 failed` (matches the brief's top-level prediction). **Provenance:**
recorded when the file held only these two tests (T2/T3 did not exist yet),
so the summary below reads `(2 tests | 2 failed)`.

**Prose summary, not captured output:** re-run at fix round 1 against the
file as it stood then (four tests) it gave `2 failed | 2 passed` — the same
liveness and delivery tests fail, and the two auth tests pass, unaffected:
the 401 guards return before `ReadableStream.start()` runs, so no
stream-body mutation can affect them. The file has since gained a fifth test
(ownership); that re-run has **not** been repeated against it, so no count is
claimed for the five-test file. The conclusion the block below supports is
unchanged either way.

Line numbers in the block are as recorded — see the note at the top of this
file. Verbatim output:

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

**Prose summary, not captured output:** re-run at fix round 1 against the
file as it stood then (four tests) it gave `1 failed | 3 passed` — the
delivery test still fails, and the liveness test plus the two auth tests
pass, unaffected: this mutation silences `emitToBus` in
`src/services/notifications.ts`, a file the 401 guards never reach. The file
has since gained a fifth test (ownership); that re-run has **not** been
repeated against it, so no count is claimed for the five-test file. The
conclusion the block below supports is unchanged either way.

Line numbers in the block are as recorded — see the note at the top of this
file. Verbatim output:

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
`(2 tests | 1 failed)`.

**Prose summary, not captured output:** re-run at fix round 1 against the
file as it stood then (four tests) it gave `1 failed | 3 passed` — the
delivery test still fails on the same trailing assertion, and the liveness
test plus the two auth tests pass, unaffected: this mutation is inside the
bus-delivery handler, which runs only once a session has already passed the
401 guards. The file has since gained a fifth test (ownership); that re-run
has **not** been repeated against it, so no count is claimed for the
five-test file. The conclusion the block below supports is unchanged either
way.

Line numbers in the block are as recorded — see the note at the top of this
file. Verbatim output:

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
tests are unaffected. Line numbers in the block are as recorded — current
when captured, shifted since by the PR fix wave's edits; see the note at the
top of this file. Verbatim output:

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

## Mutation 5 — the ownership predicate always true

Added in the PR fix wave. Two independent reviewers found that
`src/app/api/notifications/stream/route.ts`'s `mine` check was **unguarded**:
every test in the file passed with it replaced by `const mine = true`, because
each of the four opened a single stream and only ever asserted *presence*.
What that leaves unprotected is every notification's `title` and `body` —
student names, class names — going to every stream open on the server. The
fifth test (`delivers a notification only to the stream it belongs to`) exists
to make that observable.

`src/app/api/notifications/stream/route.ts`, replacing the whole predicate
inside `handler`:

```ts
        const mine = true; // MUTATION 5 — REMOVE, restore from git
```

Result: `1 failed | 4 passed`, as predicted — only the new ownership test
fails; the liveness, delivery and two auth tests are untouched, since none of
them has a second stream to leak onto. The failure output carries its own
proof: the teacher's stream contains a `teacher_invitation` notification
addressed to a student, `title` and `body` intact. Verbatim output:

```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

 ❯ |integration| tests/integration/notifications-stream.test.ts (5 tests | 1 failed) 1476ms
     × delivers a notification only to the stream it belongs to 120ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > delivers a notification only to the stream it belongs to
AssertionError: expected ': connected\n\ndata: {"id":"f387c93c-…' not to contain 'data: '

- Expected
+ Received

- data: 
+ : connected
+
+ data: {"id":"f387c93c-1822-4f4d-8662-99727d007528","type":"teacher_invitation","title":"A teacher would like to connect","body":"Stream Teacher added you as a contact. You choose whether to connect.","createdAt":"2026-08-08T07:24:18.147Z"}
+
+

 ❯ tests/integration/notifications-stream.test.ts:400:42
    398|         // Raw text, not `firstDataFrame`: for an absence, a half-writ…
    399|         // frame is still a leaked frame.
    400|         expect(teacherStream.text()).not.toContain('data: ');
       |                                          ^
    401|       } finally {
    402|         teacherStream.close();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 4 passed (5)
   Start at  09:24:16
   Duration  1.71s (transform 45ms, setup 0ms, import 102ms, tests 1.48s, environment 0ms)
```

The received value is the whole point. This is not "an assertion went red" —
it is the leak itself, printed: a stream authenticated as the **teacher**
holding a notification whose recipient is a **student**, with the student-facing
copy in it. Against a privacy-first product that is the worst thing this route
can wave through, and until this test it waved it through silently.

Restored via `git checkout src/app/api/notifications/stream/route.ts`;
`git status --porcelain src/` empty afterward; re-verified `5 passed`.

## Mutation 6 — the stream dies dirtily, mid-life

Added in the PR fix wave, to prove the new `expect(stream.error).toBeUndefined()`
assertions. Before them, `openStream`'s read loop had a bare `catch {}`, and
`ended` stayed `false` for **every** rejection of `reader.read()` — our own
`abort()`, but equally a socket reset, the server process dying, an HTTP/2 RST,
a proxy kill, or a route-side `controller.error()`. All of those satisfied
`expect(stream.ended).toBe(false)`. A stream that died non-gracefully was
reported green by the test written to prove it does not die — and process
death, restarts and proxy resets are exactly #41's own hypothesis class.

**No *graceful* mutation reaches this path.** The route's `send()` catches a
failing `enqueue` and routes it to `cleanup()` → `controller.close()`, which
is a clean end and sets `ended` — that is what Mutations 1 and 4 produce.
Reaching the dirty path takes an explicit `controller.error()`.

### 6a — synchronous `controller.error()` (rejected: it does not reach the guard)

First attempt, in `start` immediately after the preamble send:

```ts
      send(': connected\n\n');
      controller.error(new Error('mutation 6')); // MUTATION 6 — REMOVE
```

This fails the tests, but **not on the assertion under test**, so it does not
prove it. `start()` runs synchronously inside the `ReadableStream`
constructor — before the `Response` is returned and before anything reads —
and `controller.error()` resets the queue, discarding the `: connected` chunk
that was sitting in it. The socket is destroyed before a single response byte
is written, so `fetch()` itself rejects and `openStream` throws at line 77.
`bytesRead: +0` in the output below is that fact. Recorded because a later
reader will otherwise try the obvious mutation and get the wrong evidence:

```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

 ❯ |integration| tests/integration/notifications-stream.test.ts (5 tests | 3 failed) 591ms
     × stays open well past the millisecond-scale duration a trace reports for it 44ms
     × delivers a notification created by a different route, and stays open after 115ms
     × delivers a notification only to the stream it belongs to 120ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > stays open well past the millisecond-scale duration a trace reports for it
TypeError: fetch failed
 ❯ openStream tests/integration/notifications-stream.test.ts:77:15
     75| async function openStream(token?: string): Promise<OpenStream> {
     76|   const ac = new AbortController();
     77|   const res = await fetch(STREAM_URL, {
       |               ^
     78|     headers: token ? cookie(token) : {},
     79|     signal: ac.signal,
 ❯ tests/integration/notifications-stream.test.ts:244:22

Caused by: SocketError: other side closed
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { code: 'UND_ERR_SOCKET', socket: { localAddress: '::1', localPort: 50286, remoteAddress: '::1', remotePort: 3000, remoteFamily: 'IPv6', timeout: undefined, bytesWritten: 285, bytesRead: +0 } }
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > delivers a notification created by a different route, and stays open after
TypeError: fetch failed
 ❯ openStream tests/integration/notifications-stream.test.ts:77:15
     75| async function openStream(token?: string): Promise<OpenStream> {
     76|   const ac = new AbortController();
     77|   const res = await fetch(STREAM_URL, {
       |               ^
     78|     headers: token ? cookie(token) : {},
     79|     signal: ac.signal,
 ❯ tests/integration/notifications-stream.test.ts:277:22

Caused by: SocketError: other side closed
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { code: 'UND_ERR_SOCKET', socket: { localAddress: '::1', localPort: 50287, remoteAddress: '::1', remotePort: 3000, remoteFamily: 'IPv6', timeout: undefined, bytesWritten: 285, bytesRead: +0 } }
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > delivers a notification only to the stream it belongs to
TypeError: fetch failed
 ❯ openStream tests/integration/notifications-stream.test.ts:77:15
     75| async function openStream(token?: string): Promise<OpenStream> {
     76|   const ac = new AbortController();
     77|   const res = await fetch(STREAM_URL, {
       |               ^
     78|     headers: token ? cookie(token) : {},
     79|     signal: ac.signal,
 ❯ tests/integration/notifications-stream.test.ts:360:29

Caused by: SocketError: other side closed
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { code: 'UND_ERR_SOCKET', socket: { localAddress: '::1', localPort: 50288, remoteAddress: '::1', remotePort: 3000, remoteFamily: 'IPv6', timeout: undefined, bytesWritten: 285, bytesRead: +0 } }
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯


 Test Files  1 failed (1)
      Tests  3 failed | 2 passed (5)
   Start at  09:23:31
   Duration  804ms (transform 46ms, setup 0ms, import 97ms, tests 591ms, environment 0ms)
```

A connection that never opened is not the failure being guarded against — the
existing `expect(stream.status).toBe(200)` would already catch that. The
scenario is a connection that opens, works, and then dies.

### 6b — deferred `controller.error()`, the one that proves the guard

Same call, same place in `start`, moved past the point where the response
headers and the preamble have actually been written:

```ts
      send(': connected\n\n');
      // MUTATION 6 — REMOVE
      setTimeout(() => controller.error(new Error('mutation 6')), 200);
```

200 ms sits inside the liveness test's 1000 ms `HOLD_MS`, so the stream is
established, is read from, and *then* dies — the shape a process restart or a
proxy reset has.

Result: `1 failed | 4 passed`. The liveness test fails, and it fails on
**`expect(stream.error).toBeUndefined()`** — the assertion added in this fix
wave. The line above it, `expect(stream.ended).toBe(false)`, is a throwing
`expect` that ran first and **passed**: the server never closed the response
gracefully, so `ended` was legitimately `false` while the connection was
dead. That is the whole finding, reproduced. Verbatim output:

```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

 ❯ |integration| tests/integration/notifications-stream.test.ts (5 tests | 1 failed) 1452ms
     × stays open well past the millisecond-scale duration a trace reports for it 1085ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |integration| tests/integration/notifications-stream.test.ts > GET /api/notifications/stream > stays open well past the millisecond-scale duration a trace reports for it
AssertionError: expected TypeError: terminated to be undefined

- Expected:
undefined

+ Received:
TypeError {
  "message": "terminated",
  "cause": SocketError {
    "message": "other side closed",
    "name": "SocketError",
    "code": "UND_ERR_SOCKET",
    "socket": {
      "bytesRead": 794,
      "bytesWritten": 285,
      "localAddress": "::1",
      "localPort": 50302,
      "remoteAddress": "::1",
      "remoteFamily": "IPv6",
      "remotePort": 3000,
      "timeout": undefined,
    },
  },
}

 ❯ tests/integration/notifications-stream.test.ts:260:30
    258|         // the connection can die. See `openStream`'s docblock.
    259|         expect(stream.ended).toBe(false);
    260|         expect(stream.error).toBeUndefined();
       |                              ^
    261|       } finally {
    262|         stream.close();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 4 passed (5)
   Start at  09:23:40
   Duration  1.67s (transform 38ms, setup 0ms, import 94ms, tests 1.45s, environment 0ms)
```

`bytesRead: 794` against 6a's `bytesRead: +0` is the difference between the two
variants stated in one number: here the response arrived and was read from
before the socket went away.

Only the liveness test fails, and that asymmetry is itself informative rather
than lucky: it is the only test that *holds* the connection (1000 ms) past the
200 ms mark. The delivery and ownership tests finish their work in well under
200 ms, so they never observe the death. The hold is what makes the liveness
test able to see a mid-life failure at all — which is the reason it exists,
and the reason its assertion had to be able to fail.

Restored via `git checkout src/app/api/notifications/stream/route.ts`;
`git status --porcelain src/` empty and `git diff --stat main...HEAD -- src/`
empty afterward; re-verified `5 passed`.
