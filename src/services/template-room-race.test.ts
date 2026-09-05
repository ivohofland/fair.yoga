import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { isCheckViolationOn } from '@/lib/check-violation';

/**
 * Three clients, each with a job the others cannot do:
 *
 *   `a`         holds the resume's transaction open. One connection cannot
 *               hold a transaction open for another.
 *   `archiveDb` issues the archive, and blocks. Single-connection (below), so
 *               its backend pid is knowable in advance.
 *   `probe`     reads `pg_stat_activity` while the other two are blocked or
 *               busy, so it must never be either.
 *
 * Only `archiveDb` is one connection; `a` and `probe` each hold a pool.
 */
const a = new PrismaClient();
const probe = new PrismaClient();

/**
 * A client with exactly one connection, so `pg_backend_pid()` read from it once
 * identifies the backend every later statement runs on. That is what lets the
 * handshake below watch for THIS archive waiting on a lock rather than for any
 * backend anywhere — `pg_stat_activity` is database-wide, and the `unit`
 * project runs its files in parallel.
 */
function singleConnectionClient(): PrismaClient {
  const configured = process.env.DATABASE_URL;
  // Named, rather than parsed as `''`: `new URL('')` throws `Invalid URL` at
  // module scope, which reports a missing environment variable as a syntax
  // problem and names nothing the reader can act on.
  if (!configured) throw new Error('DATABASE_URL is not set; this file needs the test database');
  const url = new URL(configured);
  url.searchParams.set('connection_limit', '1');
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}
const archiveDb = singleConnectionClient();

const suffix = `race-${Date.now()}`;
let teacherId: string;
let accountId: string;
let teacherRoomId: string;
let ruleId: string;

beforeAll(async () => {
  await Promise.all([a.$connect(), probe.$connect(), archiveDb.$connect()]);
  const email = `race-${suffix}@test.local`;
  const t = await a.teacher.create({
    data: {
      firstName: 'Race', lastName: 'Fixture', email, bio: 'race fixture',
      pageSlug: `race-${suffix}`, account: { create: { email } },
    },
  });
  teacherId = t.id; accountId = t.accountId;
  const room = await a.room.create({
    data: {
      venueName: 'Race Venue', address: `${suffix} Race Street`, city: 'Amsterdam',
      postcode: '1011AB', floor: '1', roomName: 'Main', maxCapacity: 12,
      isPublic: false, createdById: teacherId,
    },
  });
  const link = await a.teacherRoom.create({
    data: { teacherId, roomId: room.id, rentalRate: 20, capacityOverride: 12 },
  });
  teacherRoomId = link.id;
  // A PAUSED template on an OPEN room — the state door 3's race starts from.
  const rule = await a.scheduleRule.create({
    data: {
      teacherId, kind: 'regular', classType: 'Yoga', dayOfWeek: 4,
      startTime: new Date('1970-01-01T19:00:00Z'), durationMinutes: 90, isActive: false,
    },
  });
  ruleId = rule.id;
  await a.classTemplate.create({
    data: {
      scheduleRuleId: rule.id, kind: 'regular', teacherRoomId,
      ruleLive: false, roomArchived: false,
      roomCost: 15, minRate: 10, targetRate: 20, minStudents: 2, maxStudents: 8,
    },
  });
});

afterAll(async () => {
  // The disconnects are in a `finally`: a delete that throws would otherwise
  // leave three connection pools open and hold the worker past teardown.
  try {
    await a.scheduleRule.deleteMany({ where: { teacherId } });
    await a.teacherRoom.deleteMany({ where: { teacherId } });
    await a.room.deleteMany({ where: { createdById: teacherId } });
    await a.teacher.deleteMany({ where: { id: teacherId } });
    await a.account.deleteMany({ where: { id: accountId } });
  } finally {
    await Promise.all([a.$disconnect(), probe.$disconnect(), archiveDb.$disconnect()]);
  }
});

describe('the room archive that used to slip past door 3', () => {
  it('refuses the archive that commits while a resume is in flight', async () => {
    let archiveError: unknown;
    let archiveSettled = false;
    let observedWaiting = false;
    // Empty while nothing has gone wrong. On either failing exit it carries the
    // cause, so the assertion at the foot prints why the wait was not seen
    // instead of `expected false to be true`.
    let notObserved = '';

    // The backend the archive will run on, read before it is issued: once that
    // statement blocks, this client has no free connection left to ask on.
    const [backend] = await archiveDb.$queryRaw<Array<{ pid: number }>>`
      SELECT pg_backend_pid()::int AS pid`;
    const archivePid = backend!.pid;
    // Read INSIDE the transaction below, not from `a` out here: `a` holds a
    // pool, so a pid read outside would identify some other connection of its.
    let resumePid = 0;

    let signalLockHeld!: () => void;
    const lockHeld = new Promise<void>((r) => { signalLockHeld = r; });
    let releaseResume!: () => void;
    const resumeMayCommit = new Promise<void>((r) => { releaseResume = r; });

    // A: resume the template, then hold the transaction open until released.
    // Flipping `isActive` moves `ScheduleRule.live`, and the composite foreign
    // key's ON UPDATE CASCADE rewrites `ClassTemplate.ruleLive` — so this
    // transaction holds that template row's lock from here until it commits.
    const resume = a.$transaction(async (tx) => {
      const [own] = await tx.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::int AS pid`;
      resumePid = own!.pid;
      await tx.scheduleRule.update({ where: { id: ruleId }, data: { isActive: true } });
      signalLockHeld();
      await resumeMayCommit;
    }, { timeout: 15_000 });

    // Gated on the update having RETURNED, not on a sleep: the lock has to be
    // held before the archive is issued, or there is no race to observe.
    // Raced against `resume` so that an update which REJECTS — a deadlock, a
    // lock timeout — surfaces here with its own error. `signalLockHeld` runs
    // only on the success path, so without this the gate never settles and the
    // failure is a bare test timeout with the cause relegated to vitest's
    // unhandled-rejection block. `resume` cannot win by resolving: its body
    // awaits `resumeMayCommit`, which nothing has released yet.
    await Promise.race([lockHeld, resume]);

    // B: archive the room from the other connection, mid-flight. Its own
    // cascade has to rewrite `roomArchived` on the row A holds, so it blocks.
    const archive = archiveDb.teacherRoom
      .update({ where: { id: teacherRoomId }, data: { isArchived: true } })
      .catch((e: unknown) => { archiveError = e; })
      .finally(() => { archiveSettled = true; });

    // The wait, OBSERVED rather than inferred, and attributed: `pg_blocking_pids`
    // is what makes this "waiting on the resume" rather than "waiting on
    // something". `wait_event_type = 'Lock'` alone is the whole heavyweight-lock
    // class, which an unrelated advisory or relation lock also satisfies.
    //
    // The deadline is not belt-and-braces. The two state-based exits are NOT
    // independent: while the archive is genuinely blocked, `archiveSettled`
    // cannot become true until the resume commits, and the resume only commits
    // below. So a probe that never sees the wait would otherwise spin until the
    // transaction's own 15s timeout and fail with Prisma's "Transaction already
    // closed", which advises raising that timeout — the one change that makes
    // it worse. Bounded here instead, the assertion at the foot is what fails.
    const deadline = Date.now() + 5_000;
    try {
      while (!archiveSettled) {
        const [waiting] = await probe.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE pid = ${archivePid}
             AND wait_event_type = 'Lock'
             AND ${resumePid} = ANY(pg_blocking_pids(pid))`;
        if ((waiting?.n ?? 0) > 0) { observedWaiting = true; break; }
        if (Date.now() > deadline) {
          // What the backend was actually doing, so "not seen waiting" can be
          // told from "not there at all" without a second run.
          const [seen] = await probe.$queryRaw<Array<{ detail: string }>>`
            SELECT state || ' / ' || coalesce(wait_event_type, 'null')
                 || ' / ' || coalesce(wait_event, 'null')
                 || ' blocked by ' || pg_blocking_pids(pid)::text AS detail
              FROM pg_stat_activity WHERE pid = ${archivePid}`;
          notObserved = `the poll never matched a wait on pid ${resumePid} within 5s; ` +
            `archive backend was: ${seen?.detail ?? 'absent from pg_stat_activity'}`;
          break;
        }
        // Yielding, so a failing run does not put ~1200 queries a second on the
        // database the rest of the parallel tier is sharing. The passing path
        // polls once or twice — whether Postgres has reached the lock wait by
        // the first probe is itself a race — so this costs it one sleep at most.
        await new Promise((r) => setTimeout(r, 5));
      }
      if (!observedWaiting && !notObserved) {
        notObserved = 'the archive settled without ever waiting on the resume';
      }
    } finally {
      // In a `finally`: a throw from the probe would otherwise leave this
      // transaction holding its row lock, and `afterAll`'s first delete blocks
      // on exactly that row — under a 10s hook timeout that fires before the
      // transaction's own 15s one, leaking the fixtures.
      releaseResume();
    }

    await Promise.all([resume, archive]);

    // The archive was refused...
    expect(archiveError).toBeDefined();
    // The matcher, not a substring of the stringified error: `toContain` here
    // asserted neither the SQLSTATE nor that Postgres was the one naming the
    // constraint, which is the whole discrimination `isCheckViolationOn` makes.
    //
    // Asserted as an object carrying the error itself, because a bare boolean
    // reports a neighbour's `40P01` as `expected false to be true` — which
    // reads as "the constraint was renamed" and sends the reader to the
    // migration.
    expect({
      refused: isCheckViolationOn(archiveError, 'ClassTemplate_live_needs_open_room'),
      actual: archiveError instanceof Error ? archiveError.message : String(archiveError),
    }).toMatchObject({ refused: true });
    // ...and it WAITED for the resume rather than racing past it, which is the
    // whole property: a check that merely read the room would have passed and
    // then been wrong. Postgres was seen holding this exact backend on a lock
    // whose blocker was the resume's own backend, so nothing here rests on two
    // callbacks landing in a particular order or in a particular millisecond.
    expect({ observedWaiting, notObserved }).toEqual({ observedWaiting: true, notObserved: '' });

    // The resume stands; the room is still open.
    const room = await a.teacherRoom.findUniqueOrThrow({ where: { id: teacherRoomId } });
    expect(room.isArchived).toBe(false);
    const rule = await a.scheduleRule.findUniqueOrThrow({ where: { id: ruleId } });
    expect(rule.isActive).toBe(true);
  }, 20_000);
});
