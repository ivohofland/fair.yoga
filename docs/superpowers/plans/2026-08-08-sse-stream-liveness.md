# SSE Stream Liveness Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `/api/notifications/stream` its first test coverage — proving the stream stays open, delivers events emitted by a different route, and refuses unauthenticated callers — so that the claim in issue #41 could have been contradicted.

**Architecture:** One new integration test file talking real HTTP to the app on `:3000`, plus one explanatory comment in an existing e2e helper. **No production code changes.** The integration project is chosen deliberately: it runs against the dev server locally and against the *production build* in CI, which is the only configuration where the `notificationBus` module-sharing question is still unmeasured.

**Tech Stack:** Vitest (`integration` project), Node 22 `fetch` + `ReadableStream` reader, Prisma for fixtures, helpers from `tests/helpers.ts`.

**Spec:** `docs/superpowers/specs/2026-08-08-sse-stream-liveness-design.md`

## Global Constraints

- **This is a test-only branch. Do not modify any file under `src/` except temporarily, as a mutation, always restored before committing.** A commit containing a mutation is a plan failure.
- **The mutation IS the red step.** Normal TDD writes a failing test first. Here the code is already correct, so a new test passes immediately — which proves nothing. The red step is deliberately breaking the source, watching the test fail, recording the *exact* error text, restoring, and re-running to green. Skipping it ships a guard nobody has watched fail.
- **Never start, restart, or stop the dev server on `:3000`.** The user runs it. Integration tests need it live. If it is not responding, stop and say so — do not start one.
- TypeScript `strict: true`. No `any`, no non-null assertions added to satisfy the compiler where a check will do.
- **Never `git add -A` or `git add .`** — stage exact paths.
- Inner loop: `npx vitest run --project integration tests/integration/notifications-stream.test.ts`
- Final gate: `npm run verify` (typecheck + lint + full vitest suite). It needs `:3000` live.
- `POST /api/students` is rate-limited **per teacher id** (`checkStudentWriteLimit` → key `students:${teacherId}`, 50 per hour), **not per IP**. Each run creates a fresh teacher, so the bucket is always fresh. **Do not add a `freshIp()` header** — it would key nothing and would falsely imply the endpoint is IP-limited.
- `vitest.config.ts` sets `fileParallelism: false` and root `env: { TZ: 'America/New_York' }`. Tests within a file run sequentially.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `tests/integration/notifications-stream.test.ts` | **create** | The whole of the route's coverage: liveness, cross-route delivery, and the two auth refusals. Owns its own fixtures and its own `openStream` helper. |
| `tests/e2e/visual.spec.ts` | **modify** (comment only, at `hydrationSignal`, ~line 155–163) | Records why a trace duration cannot be read as stream lifetime, and points at the new test. |
| `src/app/api/notifications/stream/route.ts` | **temporarily mutated, always restored** | Mutations 1 and 3. |
| `src/services/notifications.ts` | **temporarily mutated, always restored** | Mutation 2. |

`openStream` lives in the test file rather than `tests/helpers.ts`: it is the only consumer, and `helpers.ts` is shared by 26 files where an unused SSE reader would be noise. If a second file ever needs it, that is the moment to promote it.

## Reference — facts the code below depends on

Established by measurement before this plan was written; an implementer should not need to re-derive them.

- `getSessionToken(request: Request): string | null` (`src/lib/auth/session.ts:125`)
- `validateSession(db: PrismaClient, token: string): Promise<SessionUser | null>` (`src/lib/auth/session.ts:51`); returns `null` for an expired session **and deletes the row** (`:65-68`).
- `SessionUser = { sessionId: string; accountId: string } & ({ teacherId: string; defaultTimezone: string; studentId: string | null } | { teacherId: null; studentId: string })` (`src/lib/types.ts:32`)
- `POST /api/students` with the email of an **existing** student account runs `createNotification` server-side with `type: 'teacher_invitation'` (`src/services/invitations.ts:381`), fire-and-forget (not awaited by the route), and responds `201`.
- `createNotification` emits the **real** notification id to the bus; `createBulkNotifications` emits the literal string `'bulk'` (`src/services/notifications.ts:101-124`). Asserting on the id therefore also pins which path ran.
- The route sends `': connected\n\n'` immediately, then a `': keepalive\n\n'` every 30 000 ms.
- `MAX_STREAMS_PER_USER = 5` per account. Tests must close every stream they open.
- Exports available from `tests/helpers.ts`: `BASE_URL`, `cookie(token)`, `hashToken(token)`, `uniqueSuffix()`, `seedSession(db, accountId)`, `waitFor(check, opts)`, `freshIp()`.

---

### Task 1: The stream stays open, and delivers

**Files:**
- Create: `tests/integration/notifications-stream.test.ts`
- Temporarily mutate then restore: `src/app/api/notifications/stream/route.ts`, `src/services/notifications.ts`

**Interfaces:**
- Consumes: `BASE_URL`, `cookie`, `uniqueSuffix`, `seedSession`, `waitFor` from `../helpers`.
- Produces: the file, its `describe` block, its fixtures (`teacherToken`, `studentToken`, `studentId`, `studentAccountId`, `studentEmail`), and the `openStream(token?: string): Promise<OpenStream>` helper with `OpenStream = { status: number; contentType: string | null; text(): string; ended: boolean; close(): void }`. **Task 2 extends this same file and reuses all of it** — Task 2 cannot start until Task 1 is committed.

- [ ] **Step 1: Confirm the app is live before writing anything**

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health`
Expected: `200`. If anything else, **stop and report** — do not start a server.

- [ ] **Step 2: Create the test file**

Create `tests/integration/notifications-stream.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession, waitFor } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

const STREAM_URL = `${BASE_URL}/api/notifications/stream`;

/**
 * How long the liveness test holds the connection before asserting it is
 * still open.
 *
 * #41 reported the stream "completing" in 5–21ms and read that as the stream
 * dying. It was time-to-first-byte (see the design spec for the trace
 * arithmetic), but the number is still the right thing to design against:
 * 1000ms is a ~50x margin over the top of that band, so a stream that is
 * still open here is open for a reason, not by rounding. It is not long
 * enough to observe the 30s keepalive — pinning that would cost 30s of CI
 * per run to prove something no user depends on.
 */
const HOLD_MS = 1_000;

let teacherId: string;
let teacherAccountId: string;
let teacherToken: string;
let studentId: string;
let studentAccountId: string;
let studentToken: string;
let studentEmail: string;

interface OpenStream {
  status: number;
  contentType: string | null;
  /** Everything the server has sent so far, concatenated. */
  text(): string;
  /** True only when the SERVER ended the response. Aborting via `close()`
   *  deliberately does not set it — the assertions are about the server's
   *  behaviour, not ours. */
  ended: boolean;
  close(): void;
}

/**
 * Opens the SSE endpoint and starts draining it in the background.
 *
 * Reading in the background rather than awaiting the body is the whole point:
 * an SSE body never finishes, so `res.text()` would hang forever. Every caller
 * must `close()` in a `finally` — the route caps an account at 5 concurrent
 * streams (MAX_STREAMS_PER_USER), so a leaked connection would surface as a
 * 429 in a later test or a later run rather than here.
 */
async function openStream(token?: string): Promise<OpenStream> {
  const ac = new AbortController();
  const res = await fetch(STREAM_URL, {
    headers: token ? cookie(token) : {},
    signal: ac.signal,
  });

  const chunks: string[] = [];
  const state: OpenStream = {
    status: res.status,
    contentType: res.headers.get('content-type'),
    text: () => chunks.join(''),
    ended: false,
    close: () => ac.abort(),
  };

  if (!res.body) {
    state.ended = true;
    return state;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          state.ended = true;
          return;
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Our own abort() lands here. Leaving `ended` false is correct: it
      // records whether the SERVER closed, which is what is under test.
    }
  })();

  return state;
}

describe('GET /api/notifications/stream', () => {
  beforeAll(async () => {
    await prisma.$connect();

    const teacherEmail = `sse-stream-t-${suffix}@test.local`;
    studentEmail = `sse-stream-s-${suffix}@test.local`;

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Stream',
        lastName: 'Teacher',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'SSE stream fixtures.',
        pageSlug: `sse-stream-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;
    teacherToken = await seedSession(prisma, teacherAccountId);

    // `claimedAt` set: the invitation path only creates an in-app
    // notification when a Student row already exists for the email
    // (services/invitations.ts:372) — an unclaimed stranger gets an email
    // instead, and this test would have nothing to receive.
    const student = await prisma.student.create({
      data: {
        firstName: 'Stream',
        lastName: 'Student',
        email: studentEmail,
        incomeTier: 3,
        claimedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
    });
    studentId = student.id;
    studentAccountId = student.accountId!;
    studentToken = await seedSession(prisma, studentAccountId);
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { recipientId: studentId } });
    await prisma.invitation.deleteMany({ where: { teacherId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    await prisma.session.deleteMany({
      where: { accountId: { in: [teacherAccountId, studentAccountId] } },
    });
    await prisma.student.delete({ where: { id: studentId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: { id: { in: [teacherAccountId, studentAccountId] } },
    });
    await prisma.$disconnect();
  });

  it('stays open well past the millisecond-scale duration a trace reports for it', async () => {
    const stream = await openStream(studentToken);
    try {
      expect(stream.status).toBe(200);
      expect(stream.contentType).toContain('text/event-stream');

      await waitFor(() => Promise.resolve(stream.text().includes(': connected')), {
        timeoutMs: 5_000,
        description: "the SSE ': connected' preamble",
      });

      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));

      expect(stream.ended).toBe(false);
    } finally {
      stream.close();
    }
  });

  it('delivers a notification created by a different route, and stays open after', async () => {
    const stream = await openStream(studentToken);
    try {
      await waitFor(() => Promise.resolve(stream.text().includes(': connected')), {
        timeoutMs: 5_000,
        description: "the SSE ': connected' preamble",
      });

      // A different route, in the same server process. `notificationBus` is a
      // plain module singleton (the route's own `sseCounts` is on globalThis
      // precisely because this codebase has been bitten by per-bundle module
      // duplication), so "the emitter and the streamer share one bus" is a
      // real property, not a given — and it is only ever exercised against
      // the PRODUCTION bundle in CI.
      const invited = await fetch(`${BASE_URL}/api/students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
        body: JSON.stringify({
          firstName: 'Stream',
          lastName: 'Student',
          email: studentEmail,
        }),
      });
      expect(invited.status).toBe(201);

      const frame = await waitFor(
        () =>
          Promise.resolve(
            stream
              .text()
              .split('\n')
              .find((line) => line.startsWith('data: ')),
          ),
        {
          timeoutMs: 8_000,
          description: 'an SSE data frame for the invitation notification',
        },
      );

      const payload: unknown = JSON.parse(frame.slice('data: '.length));
      expect(payload).toMatchObject({ type: 'teacher_invitation' });

      // The id ties the frame to the row AND to the code path: only
      // `createNotification` emits a real id — `createBulkNotifications`
      // emits the literal 'bulk'.
      const row = await prisma.notification.findFirstOrThrow({
        where: { recipientId: studentId, type: 'teacher_invitation' },
      });
      expect(payload).toMatchObject({ id: row.id });

      expect(stream.ended).toBe(false);
    } finally {
      stream.close();
    }
  });
});
```

- [ ] **Step 3: Run the tests — they must PASS**

Run: `npx vitest run --project integration tests/integration/notifications-stream.test.ts`
Expected: `2 passed`. The code is already correct; a pass here proves nothing on its own, which is what Steps 4–12 are for.

If either test fails, **stop and report the output** — that would mean the measurement in the spec does not reproduce, which is a finding, not something to code around.

- [ ] **Step 4: Mutation 1 — make the stream close immediately (the regression #41 hypothesised)**

In `src/app/api/notifications/stream/route.ts`, find:

```ts
      sseCounts.set(userKey, (sseCounts.get(userKey) ?? 0) + 1);
      send(': connected\n\n');
      notificationBus.onNotification(handler);
```

and insert one line:

```ts
      sseCounts.set(userKey, (sseCounts.get(userKey) ?? 0) + 1);
      send(': connected\n\n');
      cleanup(); // MUTATION 1 — REMOVE
      notificationBus.onNotification(handler);
```

- [ ] **Step 5: Run — BOTH tests must fail**

Run: `npx vitest run --project integration tests/integration/notifications-stream.test.ts`
Expected: `2 failed`. The liveness test fails on `expect(stream.ended).toBe(false)` receiving `true`; the delivery test fails on the `waitFor` for the data frame timing out.

**Record the exact error text of both failures** into `docs/superpowers/plans/2026-08-08-sse-stream-liveness-mutations.md` (create it) under a heading `## Mutation 1 — cleanup() immediately after ': connected'`. Copy the assertion output verbatim, not a paraphrase.

- [ ] **Step 6: Restore and re-verify**

Run: `git checkout src/app/api/notifications/stream/route.ts`
Then: `npx vitest run --project integration tests/integration/notifications-stream.test.ts`
Expected: `2 passed`.

- [ ] **Step 7: Mutation 2 — silence the bus, and only the bus**

In `src/services/notifications.ts`, find:

```ts
function emitToBus(input: CreateNotificationInput, id: string): void {
  try {
```

and insert one line:

```ts
function emitToBus(input: CreateNotificationInput, id: string): void {
  return; // MUTATION 2 — REMOVE
  try {
```

(TypeScript permits unreachable code; do not run `npm run typecheck` while a mutation is in place.)

- [ ] **Step 8: Run — exactly ONE test must fail**

Run: `npx vitest run --project integration tests/integration/notifications-stream.test.ts`
Expected: `1 failed | 1 passed`. The delivery test fails on the data-frame `waitFor` timeout; **the liveness test still passes.**

This asymmetry is the point of mutation 2: it proves the two assertions are independent, and that the delivery test is not merely riding on the connection staying open. If *both* fail, or if *neither* does, stop and report — the tests are not measuring what they claim.

Record the failure verbatim under `## Mutation 2 — emitToBus made a no-op`, and note explicitly that the liveness test passed.

- [ ] **Step 9: Restore and re-verify**

Run: `git checkout src/services/notifications.ts`
Then: `npx vitest run --project integration tests/integration/notifications-stream.test.ts`
Expected: `2 passed`.

- [ ] **Step 10: Mutation 4 — bus handler closes the stream right after sending**

**Added during Task 1's fix round, not in the original plan.** A whole-branch
review found that Mutations 1 and 2 both fail T1b earlier than its own
trailing assertion — at the data-frame `waitFor` — so neither ever reaches
`expect(stream.ended).toBe(false)`. That assertion had never been watched
failing. This mutation pins it: "still open *after delivering*," distinct
from T1a's "still open after an idle hold," and reached by no other
mutation.

In `src/app/api/notifications/stream/route.ts`, find, inside the bus
`handler`, the `send(...)` call it makes when an event is for this
connection:

```ts
        if (mine) {
          send(`data: ${JSON.stringify(event.notification)}\n\n`);
        }
```

and insert one line right after it — a plausible real regression ("the
stream closes after its first event"):

```ts
        if (mine) {
          send(`data: ${JSON.stringify(event.notification)}\n\n`);
          cleanup(); // MUTATION 4 — REMOVE
        }
```

- [ ] **Step 11: Run — exactly ONE test must fail, on its trailing assertion**

Run: `npx vitest run --project integration tests/integration/notifications-stream.test.ts`
Expected: the delivery test fails, and specifically on
`expect(stream.ended).toBe(false)` — not on the data-frame `waitFor`, since
the frame still arrives (`send` runs before `cleanup` in the mutated
handler). The liveness test must still pass, and, once Task 2's auth tests
exist, so must they — this mutation touches only the bus-delivery handler,
which the 401 guards never reach.

Record the failure verbatim under `## Mutation 4 — bus handler closes the
stream right after sending` in
`docs/superpowers/plans/2026-08-08-sse-stream-liveness-mutations.md`.

- [ ] **Step 12: Restore and re-verify**

Run: `git checkout src/app/api/notifications/stream/route.ts`
Then: `npx vitest run --project integration tests/integration/notifications-stream.test.ts`
Expected: all tests present at the time pass.

- [ ] **Step 13: Confirm no mutation survives**

Run: `git status --porcelain src/`
Expected: **no output.** If anything is listed, restore it before committing.

- [ ] **Step 14: Commit**

```bash
git add tests/integration/notifications-stream.test.ts docs/superpowers/plans/2026-08-08-sse-stream-liveness-mutations.md
git commit -m "test: the SSE stream has never had a test that could contradict #41

Two properties, deliberately separate so a mutation can tell them apart:
the stream is still open 1000ms in (a ~50x margin over the 5-21ms band
#41 read as death), and it delivers a notification emitted by a
different route in the same process.

The second is the one that matters. \`notificationBus\` is a plain module
singleton while the same file's \`sseCounts\` is on globalThis against
per-bundle duplication — so cross-route delivery is a real property, and
CI is the only place it is exercised against the production bundle.

Both proved by mutation: an immediate cleanup() fails both tests, a
no-op emitToBus fails only the delivery one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Unauthenticated callers get no stream

**Files:**
- Modify: `tests/integration/notifications-stream.test.ts` (append two `it` blocks inside the existing `describe`)
- Temporarily mutate then restore: `src/app/api/notifications/stream/route.ts`

**Interfaces:**
- Consumes: everything Task 1 produced — `openStream`, `STREAM_URL`, `prisma`, `studentAccountId`, and the `describe`/`beforeAll`/`afterAll` block. **Task 1 must be committed first.**
- Produces: nothing new for later tasks.

- [ ] **Step 1: Add `hashToken` to the existing import**

Change the import line at the top of `tests/integration/notifications-stream.test.ts` from:

```ts
import { BASE_URL, cookie, uniqueSuffix, seedSession, waitFor } from '../helpers';
```

to:

```ts
import { BASE_URL, cookie, hashToken, uniqueSuffix, seedSession, waitFor } from '../helpers';
```

- [ ] **Step 2: Append the two auth tests**

Insert these two `it` blocks immediately after the delivery test, still inside the `describe`:

```ts
  it('refuses a request with no session cookie', async () => {
    const stream = await openStream();
    try {
      expect(stream.status).toBe(401);
      // Not just the status: a regression that hands a live stream to an
      // anonymous caller must fail here even if it somehow kept a 401.
      expect(stream.contentType ?? '').not.toContain('text/event-stream');
    } finally {
      stream.close();
    }
  });

  it('refuses an expired session', async () => {
    // Seed a real session, then age it — the technique
    // tests/integration/auth.test.ts uses. `validateSession` deletes the row
    // on the way to returning null, so afterAll has nothing extra to clean.
    const token = await seedSession(prisma, studentAccountId);
    await prisma.session.update({
      where: { id: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const stream = await openStream(token);
    try {
      expect(stream.status).toBe(401);
      expect(stream.contentType ?? '').not.toContain('text/event-stream');
    } finally {
      stream.close();
    }
  });
```

- [ ] **Step 3: Run — all four must pass**

Run: `npx vitest run --project integration tests/integration/notifications-stream.test.ts`
Expected: `4 passed`.

- [ ] **Step 4: Mutation 3 — bypass both auth guards, the way a bad refactor would**

In `src/app/api/notifications/stream/route.ts`, replace:

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

This is the realistic shape of the regression — not "someone edited the 401 literal" but "the auth guards stopped standing between an anonymous request and the stream." An anonymous caller now receives a genuine `200 text/event-stream`.

- [ ] **Step 5: Run — the two auth tests must fail, the two Task 1 tests must still pass**

Run: `npx vitest run --project integration tests/integration/notifications-stream.test.ts`
Expected: `2 failed | 2 passed`. Both auth tests fail on `expect(stream.status).toBe(401)` receiving `200`; each would also fail its content-type assertion.

Record both failures verbatim in `docs/superpowers/plans/2026-08-08-sse-stream-liveness-mutations.md` under `## Mutation 3 — both auth guards bypassed`.

- [ ] **Step 6: Restore and re-verify**

Run: `git checkout src/app/api/notifications/stream/route.ts`
Then: `npx vitest run --project integration tests/integration/notifications-stream.test.ts`
Expected: `4 passed`.

- [ ] **Step 7: Confirm no mutation survives**

Run: `git status --porcelain src/`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add tests/integration/notifications-stream.test.ts docs/superpowers/plans/2026-08-08-sse-stream-liveness-mutations.md
git commit -m "test: an anonymous caller must not get a long-lived connection

Status and content-type both, so a regression that keeps the 401 while
leaking a stream still fails. Proved by bypassing both guards the way a
refactor would — an anonymous request then gets a real 200
text/event-stream and both tests fail; the liveness and delivery tests
are unaffected.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Record why the trace was misread, and run the full gate

**Files:**
- Modify: `tests/e2e/visual.spec.ts` (the `hydrationSignal` docblock, ~lines 155–163)

**Interfaces:**
- Consumes: nothing. Independent of Tasks 1 and 2 except that the comment references the test file they create.
- Produces: nothing.

- [ ] **Step 1: Replace the `hydrationSignal` docblock**

Find:

```ts
/**
 * Teacher pages: resolve once the LiveUpdates effect opens the SSE stream.
 * Effects run only after hydration, so the request doubles as a reliable
 * "hydration finished" signal. Must be armed before page.goto.
 */
function hydrationSignal(page: Page): Promise<unknown> {
```

Replace the docblock (leave the function body untouched) with:

```ts
/**
 * Teacher pages: resolve once the LiveUpdates effect opens the SSE stream.
 * Effects run only after hydration, so the request doubles as a reliable
 * "hydration finished" signal. Must be armed before page.goto.
 *
 * `waitForResponse` resolves on response HEADERS, so this says the stream
 * OPENED — never that it stayed open. Do not read it, or a trace, as
 * evidence about the stream's lifetime: a trace's `time` for an SSE
 * response is the sum of its non-negative timing phases, and an unfinished
 * response has `receive: -1`, so `time` collapses to the wait for headers.
 * Measured on 2026-08-08 against a stream held provably open for 12s
 * (`readyState` 1 throughout, `requestfinished` never fired): the trace
 * reported `time: 18.7ms, wait: 18.7, receive: -1, bodySize: -1`, while
 * completed requests in the same trace all had `receive >= 0`. That 18.7
 * is what issue #41 read as the stream dying.
 *
 * The property this cannot check is checked by
 * `tests/integration/notifications-stream.test.ts`.
 */
function hydrationSignal(page: Page): Promise<unknown> {
```

- [ ] **Step 2: Confirm the e2e file still compiles and lints**

Run: `npm run typecheck && npm run lint`
Expected: both clean. (A comment cannot break either, but this is the cheap check before the expensive one.)

- [ ] **Step 3: Run the full gate**

Run: `npm run verify`
Expected: green — typecheck, lint, and the whole vitest suite (all three projects). This is the step that catches a defect existing only in the union of the diffs; per-task runs cannot.

If the integration project reports a wall of `ECONNREFUSED`, the app on `:3000` is down — **report it, do not start one.**

- [ ] **Step 4: Confirm the branch touches no production code**

Run: `git diff --stat main...HEAD -- src/`
Expected: **no output.** The branch's whole claim is that nothing in `src/` needed to change.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/visual.spec.ts
git commit -m "docs: a trace's duration cannot tell an open SSE stream from a closed one

hydrationSignal resolves on headers, which is fine for what it is used
for and misleading for anything else — that misreading is what #41 was
filed on. The measured numbers, beside the helper that produces them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Every acceptance item maps to a step:

| Spec acceptance | Task/step |
|---|---|
| Test file exists with T1–T3 and passes | T1 S2–S3, T2 S2–S3 |
| Each mutation run, output recorded, source restored | T1 S4–S13, T2 S4–S7 |
| `npm run verify` green | T3 S3 |
| `visual.spec.ts` carries the trace comment | T3 S1 |
| #41 closed with the measurement | Post-merge, after PR review — not a plan task |
| #127 carries the standalone-parity Update | Post-merge — not a plan task |

**Two deviations from the spec, both corrections found while writing the plan.** Both need folding back into the spec before implementation starts:

1. The spec describes T1 as one test with a delivery assertion and a still-open assertion. **Split into two `it` blocks.** As one test, mutation 2 would abort at the delivery `waitFor` and the still-open assertion would never execute — so the spec's own claim that mutation 2 "fails delivery only, still-open still passes" would have been unobservable. The split is what makes that claim checkable.
2. The spec says to send `POST /api/students` with a `freshIp()` header. **Dropped.** `checkStudentWriteLimit` keys on `students:${teacherId}` (50/hour), not on IP; a fresh teacher per run means a fresh bucket, and the header would key nothing while falsely implying the endpoint is IP-limited.

**A third correction, found after implementation started rather than while
writing this plan.** Task 1's Steps 10–12 (Mutation 4, bus handler closes the
stream right after sending) were added during a whole-branch review's fix
round, not planned here originally. Mutations 1 and 2 both fail T1b earlier
than its own trailing assertion — at the data-frame `waitFor` — so neither
ever reaches `expect(stream.ended).toBe(false)`; that assertion had never
been watched failing until Mutation 4. Recorded here rather than folded in
silently, per this project's habit of making corrections visible.

**Placeholder scan:** none. Every code step contains the literal text to write.

**Type consistency:** `OpenStream` is defined once in Task 1 and used unchanged in Task 2; `openStream(token?: string)` is optional-arg from the start, so Task 2's no-cookie call needs no signature change. The mutation-3 session stub matches `SessionUser`'s second union branch (`teacherId: null`, `studentId: string`) and so type-checks.
