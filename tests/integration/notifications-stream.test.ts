import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, hashToken, uniqueSuffix, seedSession, waitFor } from '../helpers';

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
let student2Id: string;
let student2AccountId: string;
let student2Token: string;
let student2Email: string;
let capStudentId: string;
let capAccountId: string;
let capToken: string;
let capEmail: string;

interface OpenStream {
  status: number;
  contentType: string | null;
  /** Everything the server has sent so far, concatenated. */
  text(): string;
  /** True only when the SERVER ended the response GRACEFULLY — the reader
   *  observed `done`. Aborting via `close()` deliberately does not set it —
   *  the assertions are about the server's behaviour, not ours. */
  ended: boolean;
  /** Set when the read loop rejected for a reason that was NOT our own
   *  `close()`: a socket reset, the server process dying, an HTTP/2 RST, a
   *  proxy kill, a `controller.error()` in the route. Those are deaths too,
   *  and every one of them leaves `ended` false — so `ended` alone cannot
   *  tell them from a healthy stream. `unknown`, not `Error`: a rejection
   *  can carry anything. */
  error: unknown;
  close(): void;
}

/**
 * Opens the SSE endpoint and starts draining it in the background.
 *
 * Reading in the background rather than awaiting the body is the whole point:
 * an SSE body never finishes, so `res.text()` would hang forever. Every caller
 * must `close()` in a `finally` — the route caps an account at 5 concurrent
 * streams (MAX_STREAMS_PER_USER), so a leaked connection would count against
 * that cap for the rest of this run and could surface as a 429 in a later
 * test here. It cannot carry over to a later run: `sseCounts` keys on
 * `accountId`, and every run mints a fresh account.
 *
 * The result reports THREE states, not two: `ended` (the server closed the
 * response gracefully), `error` (the connection died some other way), and
 * neither of those (still open). A liveness assertion has to check both
 * negatives. `ended === false` on its own is equally what a socket reset, a
 * dead server process, an HTTP/2 RST or a route-side `controller.error()`
 * looks like, because all of those REJECT `reader.read()` rather than
 * resolving it with `done` — so a stream that died non-gracefully would be
 * reported as healthy by the very test written to prove it does not die.
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
    error: undefined,
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
    } catch (err) {
      // The catch itself is load-bearing: without it this detached IIFE
      // turns our own `close()` into an unhandled rejection. But it must not
      // SWALLOW what it catches. Our abort leaves `ended` false correctly —
      // `ended` records whether the SERVER closed gracefully, which is what
      // is under test. Every other rejection here (socket reset, server
      // crash, `controller.error()`) also leaves `ended` false, and that is
      // a death being reported as health. Record it instead.
      if (!ac.signal.aborted) state.error = err;
    }
  })();

  return state;
}

/**
 * The first COMPLETE `data:` frame the server has sent, or `undefined`.
 *
 * Drops the last split element: if the buffered text doesn't yet end with
 * '\n' (a decoder chunk boundary landing mid-frame), that last element is an
 * in-flight partial line — e.g. a truncated `data: {"id":"5a1f` — and a
 * caller's `JSON.parse` would throw on it. Every element before the last was
 * already followed by a newline when `split()` saw it, so it is complete.
 *
 * Only for asserting a frame is PRESENT. To assert one is absent, test the
 * raw `text()` instead: a partial frame is still a leaked frame.
 */
function firstDataFrame(stream: OpenStream): string | undefined {
  const completeLines = stream.text().split('\n').slice(0, -1);
  return completeLines.find((line) => line.startsWith('data: '));
}

/**
 * Reopens `token`'s stream until its status matches `want` or `timeoutMs`
 * passes, returning whichever attempt it stopped on — not `waitFor`, which
 * throws on timeout and would report only "condition not met" instead of the
 * status actually observed. Every non-matching attempt is closed before the
 * next retry, so a slow release cannot pile up extra open streams against
 * the cap while this polls.
 */
async function pollForStatus(
  token: string,
  want: number,
  timeoutMs = 2_000,
): Promise<OpenStream> {
  const deadline = Date.now() + timeoutMs;
  let attempt = await openStream(token);
  while (attempt.status !== want && Date.now() < deadline) {
    attempt.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    attempt = await openStream(token);
  }
  return attempt;
}

describe('GET /api/notifications/stream', () => {
  beforeAll(async () => {
    await prisma.$connect();

    const teacherEmail = `sse-stream-t-${suffix}@test.local`;
    studentEmail = `sse-stream-s-${suffix}@test.local`;
    student2Email = `sse-stream-s2-${suffix}@test.local`;

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
    // (the `if (student)` gate at services/invitations.ts:376, whose
    // `createNotification` call is :381) — an unclaimed stranger gets an
    // email instead, and this test would have nothing to receive.
    const makeStudent = (email: string) =>
      prisma.student.create({
        data: {
          firstName: 'Stream',
          lastName: 'Student',
          email,
          incomeTier: 3,
          claimedAt: new Date(),
          account: { create: { email } },
        },
      });

    const student = await makeStudent(studentEmail);
    studentId = student.id;
    studentAccountId = student.accountId!;
    studentToken = await seedSession(prisma, studentAccountId);

    // A SECOND student, with its own account and session. The ownership test
    // cannot reuse the first: the delivery test above spends that address's
    // invitation, and re-inviting an address the teacher has already invited
    // produces no second `teacher_invitation` notification to wait on.
    const student2 = await makeStudent(student2Email);
    student2Id = student2.id;
    student2AccountId = student2.accountId!;
    student2Token = await seedSession(prisma, student2AccountId);

    // A THIRD student, dedicated to the slot-release test below. That test
    // parks five streams on one account key — reusing `studentAccountId`
    // would let a mid-test failure there leave slots occupied and redden
    // this file's other tests, since `sseCounts` keys on `accountId` and
    // every account here shares one process.
    capEmail = `sse-stream-cap-${suffix}@test.local`;
    const capStudent = await makeStudent(capEmail);
    capStudentId = capStudent.id;
    capAccountId = capStudent.accountId!;
    capToken = await seedSession(prisma, capAccountId);
  });

  // Every delete below is guarded on its id actually being defined, per the
  // convention in tests/integration/announcements-api.test.ts. This is not
  // defensive padding:
  //
  //   **Prisma STRIPS `undefined` from a `where`.** If `beforeAll` throws
  //   between the creates — a P2002 from an overlapping run, a DB blip —
  //   then `studentId` is `undefined` and
  //   `notification.deleteMany({ where: { recipientId: studentId } })`
  //   is `deleteMany({})`: every Notification row in the shared dev
  //   database, not this file's. Vitest still runs `afterAll` after a
  //   failed `beforeAll`, so that path is reachable, not theoretical.
  //
  // The `{ in: [...] }` forms are safe for a DIFFERENT reason — an empty
  // array matches nothing rather than everything — so do not read one of
  // these shapes as licence for the other. The `filter(Boolean)` guards are
  // what make them safe, not the `in`.
  //
  // The try/finally is the same hazard one level up: a throw mid-hook used
  // to strand the remaining rows AND skip `$disconnect()`, leaking a client
  // for the rest of the run. It rethrows — a failed cleanup must stay loud.
  afterAll(async () => {
    try {
      const studentIds = [studentId, student2Id, capStudentId].filter(Boolean);
      if (studentIds.length) {
        await prisma.notification.deleteMany({ where: { recipientId: { in: studentIds } } });
      }
      if (teacherId) {
        await prisma.invitation.deleteMany({ where: { teacherId } });
        await prisma.teacherStudent.deleteMany({ where: { teacherId } });
      }
      const accountIds = [
        teacherAccountId,
        studentAccountId,
        student2AccountId,
        capAccountId,
      ].filter(Boolean);
      if (accountIds.length) {
        await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
      }
      if (studentIds.length) {
        await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
      }
      if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
      if (accountIds.length) {
        await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  it(
    'stays open well past the millisecond-scale duration a trace reports for it',
    async () => {
      const stream = await openStream(studentToken);
      try {
        expect(stream.status).toBe(200);
        expect(stream.contentType).toContain('text/event-stream');

        await waitFor(() => Promise.resolve(stream.text().includes(': connected')), {
          timeoutMs: 5_000,
          description: "the SSE ': connected' preamble",
        });

        await new Promise((resolve) => setTimeout(resolve, HOLD_MS));

        // Both negatives, because "still open" is the conjunction of them:
        // `ended` catches a graceful close, `error` catches every other way
        // the connection can die. See `openStream`'s docblock.
        expect(stream.ended).toBe(false);
        expect(stream.error).toBeUndefined();
      } finally {
        stream.close();
      }
    },
    // Explicit, above the sum of this test's own budgets (5_000ms preamble
    // wait + HOLD_MS's 1_000ms = 6_000ms), which already exceeds vitest's
    // unconfigured 5000ms default (vitest.config.ts sets no `testTimeout`).
    // Without this, a slow preamble would be killed by vitest's own generic
    // "Test timed out in 5000ms" before the inner `waitFor` — which carries
    // the actual diagnostic — ever gets to report its own message.
    10_000,
  );

  it(
    'delivers a notification created by a different route, and stays open after',
    async () => {
      const stream = await openStream(studentToken);
      try {
        expect(stream.status).toBe(200);
        expect(stream.contentType).toContain('text/event-stream');

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

        const frame = await waitFor(() => Promise.resolve(firstDataFrame(stream)), {
          timeoutMs: 8_000,
          description: 'an SSE data frame for the invitation notification',
        });

        const payload: unknown = JSON.parse(frame.slice('data: '.length));
        expect(payload).toMatchObject({ type: 'teacher_invitation' });

        // The id ties the frame to the row AND to the code path: only
        // `createNotification` emits a real id — `createBulkNotifications`
        // emits the literal 'bulk'.
        const row = await prisma.notification.findFirstOrThrow({
          where: { recipientId: studentId, type: 'teacher_invitation' },
        });
        expect(payload).toMatchObject({ id: row.id });

        // Still open AFTER delivering — a distinct property from the
        // liveness test's "still open after a hold". Both negatives, for the
        // reason `openStream`'s docblock gives.
        expect(stream.ended).toBe(false);
        expect(stream.error).toBeUndefined();
      } finally {
        stream.close();
      }
    },
    // Explicit, above the sum of this test's own budgets (5_000ms preamble
    // wait + the POST round trip + 8_000ms data-frame wait ≈ 13_000ms+),
    // which vitest's unconfigured 5000ms default cannot cover. Without this,
    // the 8_000ms `waitFor` slack is illusory: vitest's own timeout would
    // kill the test first, every time, and report only "Test timed out in
    // 5000ms" instead of the `waitFor`'s descriptive message.
    20_000,
  );

  it(
    'delivers a notification only to the stream it belongs to',
    async () => {
      // Without this, the route's ownership predicate is unguarded:
      // `const mine = true` passes every other test in this file, because
      // each of them opens ONE stream and only ever asserts presence. What
      // slips through is every notification's title and body — student
      // names, class names — broadcast to every stream open on the box.
      //
      // Proving an absence needs the control-then-assert-absence idiom
      // `tests/helpers.ts` documents on `waitFor`: a negative cannot be
      // proven by polling for it, so wait for a CONTROL signal that would
      // have arrived after the thing being asserted absent, then assert the
      // absence. Here the control is the intended recipient's own frame.
      //
      // Why that ordering holds: `notificationBus` is a plain EventEmitter,
      // so `emitNotification` calls every registered listener SYNCHRONOUSLY,
      // in registration order, before it returns. The teacher's stream is
      // opened first and so is registered first — a frame wrongly sent to it
      // is written before the student's legitimate one. Once the student's
      // frame has arrived, a wrongly-delivered copy is already present. The
      // ordering is deterministic, not a race.
      const teacherStream = await openStream(teacherToken);
      const studentStream = await openStream(student2Token);
      try {
        expect(teacherStream.status).toBe(200);
        expect(studentStream.status).toBe(200);

        await waitFor(
          () =>
            Promise.resolve(
              teacherStream.text().includes(': connected') &&
                studentStream.text().includes(': connected'),
            ),
          { timeoutMs: 5_000, description: "both SSE ': connected' preambles" },
        );

        const invited = await fetch(`${BASE_URL}/api/students`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
          body: JSON.stringify({
            firstName: 'Stream',
            lastName: 'Other',
            email: student2Email,
          }),
        });
        expect(invited.status).toBe(201);

        const frame = await waitFor(() => Promise.resolve(firstDataFrame(studentStream)), {
          timeoutMs: 8_000,
          description: "the second student's own SSE data frame (the control)",
        });
        const payload: unknown = JSON.parse(frame.slice('data: '.length));
        expect(payload).toMatchObject({ type: 'teacher_invitation' });

        // Before the absence: a teacher stream that had died would receive
        // nothing either, and would satisfy the assertion below vacuously.
        expect(teacherStream.ended).toBe(false);
        expect(teacherStream.error).toBeUndefined();

        // Raw text, not `firstDataFrame`: for an absence, a half-written
        // frame is still a leaked frame.
        expect(teacherStream.text()).not.toContain('data: ');
      } finally {
        teacherStream.close();
        studentStream.close();
      }
    },
    // Same reasoning as the delivery test above: 5_000ms preamble wait + the
    // POST round trip + 8_000ms control wait is well past vitest's
    // unconfigured 5000ms default.
    20_000,
  );

  it('refuses a request with no session cookie', async () => {
    const stream = await openStream();
    try {
      // `.soft`, not a throwing `expect`: both properties below must be
      // independently observable under a single mutation, otherwise the
      // second is decoration. A throwing first assertion would abort before
      // the second ever ran, so a broken content-type guard could hide
      // behind a broken status guard indefinitely.
      expect.soft(stream.status).toBe(401);
      // Not just the status: a regression that hands a live stream to an
      // anonymous caller must fail here even if it somehow kept a 401.
      expect.soft(stream.contentType ?? '').not.toContain('text/event-stream');
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
      // `.soft`, not a throwing `expect`, for the reason the sibling test
      // above spells out.
      expect.soft(stream.status).toBe(401);
      expect.soft(stream.contentType ?? '').not.toContain('text/event-stream');
    } finally {
      stream.close();
    }
  });

  it(
    'frees exactly one slot when exactly one of its five open streams closes',
    async () => {
      // Everything opened during this test, closed unconditionally in
      // `finally` — including the final streams held past each assertion,
      // so a soft-failed assertion above still leaves nothing leaked into
      // this account's slot count for a later run.
      const toClose: OpenStream[] = [];
      const openOn = async () => {
        const s = await openStream(capToken);
        toClose.push(s);
        return s;
      };

      try {
        const streams: OpenStream[] = [];
        for (let i = 0; i < 5; i++) streams.push(await openOn());
        for (const s of streams) {
          expect.soft(s.status).toBe(200);
        }

        const sixth = await openOn();
        expect.soft(sixth.status).toBe(429);

        // Close exactly ONE of the five — deliberately not "close all five,
        // then reopen". That shape can't distinguish a correct per-stream
        // decrement from `sseCounts.delete(userKey)` (frees the whole
        // account unconditionally): draining the counter to zero, both
        // implementations agree. The information is at the boundary —
        // closing one of five and checking that exactly one slot opens.
        streams[0]!.close();

        // CONTROL: proves the decrement ran at all. `pollForStatus` covers
        // the case where the runtime doesn't fire `request.signal`'s abort
        // synchronously with our own `close()` — measured at under 25ms on
        // this route locally, but not a guarantee this asserts on directly.
        const reopened = await pollForStatus(capToken, 200);
        toClose.push(reopened);
        expect.soft(reopened.status).toBe(200);

        // EXACTNESS: `reopened` now occupies the freed slot, so the account
        // is back at the cap. A decrement that frees UNCONDITIONALLY rather
        // than by one would still pass the control above but leave room for
        // this extra stream too — this is what that mutation cannot pass.
        const extra = await openOn();
        expect.soft(extra.status).toBe(429);
      } finally {
        toClose.forEach((s) => s.close());
      }
    },
    // Generous margin over `pollForStatus`'s own 2_000ms ceiling plus six
    // initial round trips and the exactness probe.
    10_000,
  );
});
