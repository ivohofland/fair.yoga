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
 * streams (MAX_STREAMS_PER_USER), so a leaked connection would count against
 * that cap for the rest of this run and could surface as a 429 in a later
 * test here. It cannot carry over to a later run: `sseCounts` keys on
 * `accountId`, and every run mints a fresh account.
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

        expect(stream.ended).toBe(false);
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

        const frame = await waitFor(
          () => {
            // Drop the last split element: if the buffered text doesn't yet
            // end with '\n' (a decoder chunk boundary landing mid-frame),
            // that last element is an in-flight partial line — e.g. a
            // truncated `data: {"id":"5a1f` — and JSON.parse below would
            // throw on it. Every element before the last was already
            // followed by a newline when split() saw it, so it is complete.
            const completeLines = stream.text().split('\n').slice(0, -1);
            return Promise.resolve(completeLines.find((line) => line.startsWith('data: ')));
          },
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
    },
    // Explicit, above the sum of this test's own budgets (5_000ms preamble
    // wait + the POST round trip + 8_000ms data-frame wait ≈ 13_000ms+),
    // which vitest's unconfigured 5000ms default cannot cover. Without this,
    // the 8_000ms `waitFor` slack is illusory: vitest's own timeout would
    // kill the test first, every time, and report only "Test timed out in
    // 5000ms" instead of the `waitFor`'s descriptive message.
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
      // `.soft` for the same reason as the sibling test above: both
      // properties must be independently observable under a single
      // mutation, otherwise the second is decoration.
      expect.soft(stream.status).toBe(401);
      expect.soft(stream.contentType ?? '').not.toContain('text/event-stream');
    } finally {
      stream.close();
    }
  });
});
