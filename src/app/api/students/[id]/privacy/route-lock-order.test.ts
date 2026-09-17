/**
 * @serial-tier lock-contention — stages this route against `deleteStudentAccount`,
 * or against its `Student` lock, on real Postgres row locks: whether a racer
 * waited, whether the write got a 409, and which rows survive. Lock noise
 * from a neighbour in the parallel tier would stretch a staged wait past the
 * shared `lock_timeout` these outcomes turn on.
 *
 * `PUT` is invoked directly, and the erasure runs in this process too, so a
 * spy can pause either one at an exact statement — same technique as
 * `src/app/api/registrations/route-lock-order.test.ts` (#625).
 */
import { describe, it, expect, afterAll, onTestFinished, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import * as dbLocks from '@/lib/db-locks';
import { deleteStudentAccount } from '@/services/gdpr';
import { cookie, seedSession } from '../../../../../../tests/helpers';
import { PUT } from './route';

const prisma = new PrismaClient();

const HANDSHAKE_MS = 2_000;
const WAIT_MS = 1_500;

const DELETED_MESSAGE = 'This account has been deleted';

type Settled = { status: number; message: string | null };

function putPrivacy(
  token: string,
  studentId: string,
  body: { teacherId: string; shareFullName?: boolean },
): Promise<Response> {
  return PUT(
    new NextRequest('http://localhost:3000/api/students/x/privacy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: studentId }) },
  );
}

function settle(response: Promise<Response>): Promise<Settled> {
  return response.then(
    async (res) => {
      const json: unknown = await res.json().catch(() => null);
      const error =
        typeof json === 'object' && json !== null && 'error' in json ? json.error : null;
      const message =
        typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
          ? error.message
          : null;
      return { status: res.status, message };
    },
    (err: unknown) => ({ status: -1, message: String(err) }),
  );
}

function track<T>(racer: Promise<T>): { racer: Promise<T>; settled: () => boolean } {
  let done = false;
  void racer.then(() => { done = true; });
  return { racer, settled: () => done };
}

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

async function waiterOf(holderPid: number, stop: () => boolean): Promise<number | null> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !stop()) {
    const [row] = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))
       LIMIT 1`;
    if (row !== undefined) return row.pid;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

async function handshake(signal: Promise<void>, label: string, racer: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} never happened within ${HANDSHAKE_MS}ms`)),
          HANDSHAKE_MS,
        );
      }),
      racer.then((outcome) => {
        throw new Error(`${label} never happened: the racer settled first with ${JSON.stringify(outcome)}`);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Pauses `deleteStudentAccount` right after it acquires the `Student` gate,
 * before any of its writes — the technique
 * `src/app/api/registrations/route-lock-order.test.ts` uses for the booking
 * route's own version of this gate (#625).
 */
function pauseErasureAtGate(studentId: string): {
  reached: Promise<void>;
  pid: () => number;
  release: () => void;
} {
  const reached = latch();
  const held = latch();
  let pid = 0;
  let paused = false;
  const original = dbLocks.lockStudentForErasure;
  const spy = vi.spyOn(dbLocks, 'lockStudentForErasure').mockImplementation(async (tx, id) => {
    await original(tx, id);
    if (id === studentId && !paused) {
      paused = true;
      pid = await ownPid(tx);
      reached.open();
      await held.promise;
    }
  });
  onTestFinished(() => spy.mockRestore());
  return { reached: reached.promise, pid: () => pid, release: held.open };
}

/** A teacher, a claimed student, a live `TeacherStudent` link, and a session for the student. */
async function makeFixture() {
  const suffix = `priv-gate-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Gate', lastName: 'Teacher',
      email: `${suffix}-teacher@test.local`,
      account: { create: { email: `${suffix}-teacher@test.local` } },
      bio: 'Privacy-gate fixture',
      pageSlug: suffix,
    },
    select: { id: true, accountId: true },
  });
  const studentEmail = `${suffix}-student@test.local`;
  const student = await prisma.student.create({
    data: {
      firstName: 'Gate', lastName: 'Student', email: studentEmail, claimedAt: new Date(),
      account: { create: { email: studentEmail } },
    },
    select: { id: true, accountId: true },
  });
  const studentAccountId = student.accountId;
  if (studentAccountId === null) throw new Error('fixture student has no account');
  await prisma.teacherStudent.create({ data: { teacherId: teacher.id, studentId: student.id } });
  return {
    teacherId: teacher.id,
    teacherAccountId: teacher.accountId,
    studentId: student.id,
    studentAccountId,
    studentToken: await seedSession(prisma, studentAccountId),
  };
}

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

async function cleanup(fx: Fixture): Promise<void> {
  await prisma.studentPrivacy.deleteMany({ where: { teacherId: fx.teacherId } });
  await prisma.teacherStudent.deleteMany({ where: { teacherId: fx.teacherId } });
  await prisma.session.deleteMany({ where: { accountId: fx.studentAccountId } });
  await prisma.student.deleteMany({ where: { id: fx.studentId } });
  await prisma.teacher.deleteMany({ where: { id: fx.teacherId } });
  await prisma.account.deleteMany({ where: { id: { in: [fx.teacherAccountId, fx.studentAccountId] } } });
}

describe('PUT /api/students/[id]/privacy takes the Student gate (#626)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('refuses a write that waits behind the erasure, and writes nothing', async () => {
    const fx = await makeFixture();
    try {
      const erasure = pauseErasureAtGate(fx.studentId);
      const erasing = deleteStudentAccount(prisma, fx.studentId).then(
        () => 'erased' as const,
        (err: unknown) => ({ error: err }),
      );
      let writing: ReturnType<typeof track<Settled>> | undefined;
      let writingWaited = false;
      try {
        await handshake(erasure.reached, 'erasure Student lock', erasing);
        writing = track(
          settle(putPrivacy(fx.studentToken, fx.studentId, { teacherId: fx.teacherId, shareFullName: true })),
        );
        writingWaited = (await waiterOf(erasure.pid(), writing.settled)) !== null;
      } finally {
        erasure.release();
        await Promise.all([erasing, writing?.racer]);
      }

      expect(await erasing).toBe('erased');
      expect(await writing?.racer).toEqual({ status: 409, message: DELETED_MESSAGE });
      expect(
        await prisma.studentPrivacy.count({ where: { teacherId: fx.teacherId, studentId: fx.studentId } }),
      ).toBe(0);
      expect(writingWaited).toBe(true);
    } finally {
      await cleanup(fx);
    }
  }, 20_000);
});
