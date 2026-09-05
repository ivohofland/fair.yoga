import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { isCheckViolationOn } from '@/lib/check-violation';

/**
 * Three connections, each with a job one of the others cannot do:
 *
 *   `a`         holds the resume's transaction open. One connection cannot
 *               hold a transaction open for another.
 *   `archiveDb` issues the archive, and blocks. Single-connection (below), so
 *               its backend pid is knowable in advance.
 *   `probe`     reads `pg_stat_activity` while the other two are blocked or
 *               busy, so it must never be either.
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
  const url = new URL(process.env.DATABASE_URL ?? '');
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
  await a.scheduleRule.deleteMany({ where: { teacherId } });
  await a.teacherRoom.deleteMany({ where: { teacherId } });
  await a.room.deleteMany({ where: { createdById: teacherId } });
  await a.teacher.deleteMany({ where: { id: teacherId } });
  await a.account.deleteMany({ where: { id: accountId } });
  await Promise.all([a.$disconnect(), probe.$disconnect(), archiveDb.$disconnect()]);
});

describe('the room archive that used to slip past door 3', () => {
  it('refuses the archive that commits while a resume is in flight', async () => {
    let archiveError: unknown;
    let archiveSettled = false;
    let observedWaiting = false;

    // The backend the archive will run on, read before it is issued: once that
    // statement blocks, this client has no free connection left to ask on.
    const [backend] = await archiveDb.$queryRaw<Array<{ pid: number }>>`
      SELECT pg_backend_pid()::int AS pid`;
    const archivePid = backend!.pid;

    let signalLockHeld!: () => void;
    const lockHeld = new Promise<void>((r) => { signalLockHeld = r; });
    let releaseResume!: () => void;
    const resumeMayCommit = new Promise<void>((r) => { releaseResume = r; });

    // A: resume the template, then hold the transaction open until released.
    // Flipping `isActive` moves `ScheduleRule.live`, and the composite foreign
    // key's ON UPDATE CASCADE rewrites `ClassTemplate.ruleLive` — so this
    // transaction holds that template row's lock from here until it commits.
    const resume = a.$transaction(async (tx) => {
      await tx.scheduleRule.update({ where: { id: ruleId }, data: { isActive: true } });
      signalLockHeld();
      await resumeMayCommit;
    }, { timeout: 15_000 });

    // Gated on the update having RETURNED, not on a sleep: the lock has to be
    // held before the archive is issued, or there is no race to observe.
    await lockHeld;

    // B: archive the room from the other connection, mid-flight. Its own
    // cascade has to rewrite `roomArchived` on the row A holds, so it blocks.
    const archive = archiveDb.teacherRoom
      .update({ where: { id: teacherRoomId }, data: { isArchived: true } })
      .catch((e: unknown) => { archiveError = e; })
      .finally(() => { archiveSettled = true; });

    // The wait, OBSERVED rather than inferred. Every iteration is a database
    // round trip, not a timer, and the loop cannot spin for ever: it exits on
    // whichever of the two happens. An archive that does not block settles,
    // `observedWaiting` stays false, and the assertion below names that.
    while (!archiveSettled) {
      const [waiting] = await probe.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE pid = ${archivePid} AND wait_event_type = 'Lock'`;
      if ((waiting?.n ?? 0) > 0) { observedWaiting = true; break; }
    }

    releaseResume();
    await Promise.all([resume, archive]);

    // The archive was refused...
    expect(archiveError).toBeDefined();
    // The matcher, not a substring of the stringified error: `toContain` here
    // asserted neither the SQLSTATE nor that Postgres was the one naming the
    // constraint, which is the whole discrimination `isCheckViolationOn` makes.
    expect(isCheckViolationOn(archiveError, 'ClassTemplate_live_needs_open_room')).toBe(true);
    // ...and it WAITED for the resume rather than racing past it, which is the
    // whole property: a check that merely read the room would have passed and
    // then been wrong. Postgres was seen holding this exact backend on a lock
    // while the resume still had the template row, so nothing here rests on
    // two callbacks landing in a particular order or in a particular
    // millisecond.
    expect(observedWaiting).toBe(true);

    // The resume stands; the room is still open.
    const room = await a.teacherRoom.findUniqueOrThrow({ where: { id: teacherRoomId } });
    expect(room.isArchived).toBe(false);
    const rule = await a.scheduleRule.findUniqueOrThrow({ where: { id: ruleId } });
    expect(rule.isActive).toBe(true);
  }, 20_000);
});
