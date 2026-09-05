/**
 * @serial-tier lock-contention — three of this file's five tests hold a
 * `Class` row for 3 500 ms on a second connection and assert `55P03`: that is
 * real lock noise for anything sharing a parallel tier with them, and real
 * lock noise landing on them in return is what would turn their own `55P03`
 * assertion into a false positive from the wrong cause.
 *
 * Split out of `waitlist.test.ts` (#459) for exactly that reason. The five
 * guards below prove `addToWaitlist`, `promoteNext` and `claimSpot` each give
 * up on `lockClassRow`'s shared 2s `SET LOCAL lock_timeout` under contention,
 * and that `removeFromWaitlist` and `handleSpotFreed` genuinely wait on (and,
 * for the second, are bounded by) the same `Class` row lock — a lock outcome,
 * not a registration/promotion/removal outcome. One teacher, one room, one
 * `TeacherRoom` and a small pool of students are shared at module scope; each
 * test below builds the one class it locks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  addToWaitlist,
  removeFromWaitlist,
  promoteNext,
  claimSpot,
  handleSpotFreed,
} from './waitlist';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

/**
 * Turns a running total-minutes-from-9am into a valid `HH:MM`, wrapping into
 * the next hour rather than ever emitting an invalid minute like `'09:60'`.
 * `CalendarEntry.startTime` is `@db.Time` and would refuse the row outright at
 * the DB, which is a less useful failure here than this guard's message
 * naming the fixture counter that produced it. Mirrors `waitlist.test.ts`'s
 * `slotTime` (and `class-template-lifecycle.test.ts`'s) — every class below
 * shares one teacher, so `CalendarEntry_teacher_slot_excl` refuses any two of
 * them whose ranges overlap, and a raw `HH:${counter}` literal would produce
 * exactly that once the counter crosses 30.
 */
function slotTime(totalMinutesFrom9am: number): string {
  const hour = 9 + Math.floor(totalMinutesFrom9am / 60);
  const minute = totalMinutesFrom9am % 60;
  const startTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (!/^\d{2}:[0-5]\d$/.test(startTime)) {
    throw new Error(`slotTime produced an invalid startTime: ${startTime}`);
  }
  return startTime;
}

let teacherId: string;
let roomId: string;
let teacherRoomId: string;
// Two "filler" students — registered occupants that make a class full — and
// three "waiting" students, the largest number any one test below needs on a
// single queue (`removeFromWaitlist`'s reorder case). Every test picks
// whichever of these its own class needs; none of them is shared across two
// tests' classes at once, so reusing the same rows across different classes
// (a different `classId` each time) never collides.
const fillerIds: string[] = [];
const studentIds: string[] = [];

beforeAll(async () => {
  const mail = `waitlist-lock-teacher-${uniqueSuffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'WaitlistLock',
      lastName: 'Teacher',
      email: mail,
      account: { create: { email: mail } },
      bio: 'Test teacher for waitlist lock-order tests',
      pageSlug: `waitlist-lock-teacher-${uniqueSuffix}`,
      defaultTimezone: 'UTC',
    },
  });
  teacherId = teacher.id;

  const room = await prisma.room.create({
    data: {
      venueName: 'Waitlist Lock Studio',
      address: `${uniqueSuffix} Waitlist Lock St`,
      city: 'Amsterdam',
      postcode: '1234WL',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 20,
      createdById: teacherId,
    },
  });
  roomId = room.id;

  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId, roomId, capacityOverride: 15, rentalRate: 30 },
  });
  teacherRoomId = teacherRoom.id;

  for (let i = 1; i <= 2; i++) {
    const filler = await prisma.student.create({
      data: {
        firstName: `WaitlistLockFiller${i}`,
        lastName: 'Test',
        email: `waitlist-lock-filler-${i}-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    fillerIds.push(filler.id);
  }

  for (let i = 1; i <= 3; i++) {
    const student = await prisma.student.create({
      data: {
        firstName: `WaitlistLockStudent${i}`,
        lastName: 'Test',
        email: `waitlist-lock-student-${i}-${uniqueSuffix}@test.local`,
        incomeTier: i + 1,
      },
    });
    studentIds.push(student.id);
  }
});

afterAll(async () => {
  await prisma.student.deleteMany({ where: { id: { in: [...fillerIds, ...studentIds] } } });
  await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
  await prisma.room.delete({ where: { id: roomId } });
  await prisma.teacher.delete({ where: { id: teacherId } });
  await prisma.$disconnect();
});

/**
 * A one-minute class on the shared teacher's one generic date — `addToWaitlist`,
 * `promoteNext` and `removeFromWaitlist`'s guards below don't care what the
 * class's own schedule is, only that it exists and is `open`, so a distinct
 * minute per call (via `slotTime`) is all `CalendarEntry_teacher_slot_excl`
 * needs. `claimSpot`'s and `handleSpotFreed`'s guards build their own fixed-date
 * classes instead, because their deadline math is pinned against an exact
 * instant.
 */
let makeClassCounter = 0;
async function makeClass(maxStudents: number): Promise<string> {
  makeClassCounter += 1;
  const cls = await createClassFixture(prisma, {
    teacherId,
    teacherRoomId,
    classType: 'Hatha',
    date: new Date('2099-06-01'),
    startTime: hhmmToTime(slotTime(makeClassCounter)),
    durationMinutes: 1,
    roomCost: 35,
    minRate: 15,
    targetRate: 25,
    minStudents: 1,
    maxStudents,
    status: 'open',
    settingsLocked: true,
  });
  return cls.id;
}

describe('addToWaitlist + removeFromWaitlist (DB)', () => {
  /**
   * #104. `addToWaitlist` took an unbounded inline `FOR UPDATE` until this
   * change; it now goes through `lockClassRow`, which issues the shared 2s
   * `SET LOCAL lock_timeout` first.
   *
   * The 3.5s hold is the guard, not scenery: it sits above the 2s bound and
   * below Prisma's 5s default transaction budget, so WITHOUT the bound this
   * call acquires the lock at 3.5s and succeeds. Reverting the site to its
   * inline statement therefore fails `expect(outcome.ok).toBe(false)` rather
   * than hanging the suite.
   *
   * `outcome.ok === false` is what distinguishes "gave up at 2s" from "waited
   * the holder out", and it is the only thing that can: waiting the holder out
   * does not fail slowly, it SUCCEEDS at 3.5s. `/55P03/` then names the
   * mechanism as Postgres's `lock_timeout` rather than some other refusal, and
   * `waited > 1_000` excludes an instant failure that never reached the lock.
   *
   * There is deliberately NO upper bound on `waited`, and this paragraph is
   * the reference for the two sibling guards below (`promoteNext (DB)` and
   * `claimSpot (DB)`) and for the HTTP one in
   * `tests/integration/registrations-api.test.ts`. All four carried
   * `toBeLessThan(3_400)`. It was not dead weight for every value, though: a
   * `lock_timeout` configured between 3.4s and 3.5s — say 3.45s — still sits
   * below the 3.5s hold, so the call still raises `55P03` and `ok === false`
   * and `/55P03/` both stay green while `waited` lands past the 3_400 ceiling.
   * That was its one sliver of unique coverage. Everywhere else it was
   * redundant with the other two assertions: at a 3.0s or 3.3s bound the call
   * raises `55P03` and passes the ceiling anyway; at 3.6s it acquires when the
   * holder releases and succeeds, which `ok === false` catches on its own.
   * And that one sliver is already pinned directly — `db-locks.test.ts`
   * asserts the literal `LOCK_TIMEOUT_SQL` value and observes the effect via
   * `SHOW lock_timeout` — so the ceiling was never the only thing standing
   * between a misconfigured bound and a green suite. What it cost instead was
   * a ~1400ms overhead budget, against a holder-acquisition latency this same
   * file measured at 486ms under load and 428ms idle on a 10-core machine —
   * so on a 2-4 core CI box running three vitest projects it was the one
   * flake surface in these guards, reddening at random under a label that
   * sent the reader looking for a bound which had in fact fired correctly.
   * The timeout's VALUE is pinned by `db-locks.test.ts`, never by a
   * wall-clock threshold here.
   */
  it('gives up on the 2s bound when another transaction holds the class row', async () => {
    // Its own full class: max 1, one registration.
    const lockedClassId = await makeClass(1);
    await prisma.registration.create({
      data: {
        classId: lockedClassId,
        studentId: fillerIds[0]!,
        status: 'registered',
        tierAtBooking: 3,
      },
    });

    const holderClient = new PrismaClient();
    let signalHeld!: () => void;
    const held = new Promise<void>((r) => {
      signalHeld = r;
    });

    const holder = holderClient.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${lockedClassId} FOR UPDATE`;
        signalHeld();
        await new Promise((r) => setTimeout(r, 3_500));
      },
      { timeout: 30_000 },
    );
    await held;

    const startedAt = Date.now();
    const outcome = await addToWaitlist(prisma, lockedClassId, studentIds[0]!).then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err: String(err) }),
    );
    const waited = Date.now() - startedAt;

    await holder;
    await holderClient.$disconnect();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err).toMatch(/55P03/);
    expect(waited).toBeGreaterThan(1_000);

    await prisma.waitlistEntry.deleteMany({ where: { classId: lockedClassId } });
    await prisma.registration.deleteMany({ where: { classId: lockedClassId } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: lockedClassId } } } });
  }, 20_000);
});

describe('promoteNext (DB)', () => {
  /**
   * #104. `promoteNext` is the one converted site that is NOT a route. It is
   * called only by `handleSpotFreed`, which `reconcileWaitlists` re-invokes
   * every minute — `waitlist-reconciliation.ts`'s own docblock puts it as
   * "this module detects; `handleSpotFreed` decides". So its failure surface
   * is the reconciliation sweep repairing it later, not a 503 a student reads.
   *
   * The bound is a TRADE here, not a free improvement, and the trade is worth
   * stating because both directions are real. What it buys: a contended
   * promotion used to wait out the WHOLE hold and then blow Prisma's 5s budget
   * (`P2028`, measured at 7014ms against a 7s hold — it cannot cancel a
   * statement already blocked inside Postgres), occupying a pool connection
   * the whole time; now it aborts at 2s with `55P03` and the sweep retries
   * sooner. What it costs: before the conversion a promotion still SUCCEEDED
   * against a competing hold of up to roughly 4.5s (the 5s budget less the
   * 8-12 statements that still have to run after the lock is won — spec §3.3).
   * `2s < h ≲ 4.5s` is therefore a band where a promotion that used to happen
   * no longer does on the live path.
   *
   * That band is not invisible. `reconcileWaitlists` catches per class and
   * logs the loss at `warn` (`waitlist-reconciliation.ts`) on every tick, and
   * escalates to `error` if the same class stays stuck for
   * `MAX_CONSECUTIVE_CONTENDED_TICKS` in a row. Neither level delivers
   * anywhere on its own today — `lib/log.ts` is pino to stdout with no
   * transport, so nothing pages anyone off either one (#157); the lines sit in
   * the server log for whoever reads it. What surfaces is `report`'s
   * `ReconciliationFailedError`, which `scheduler.ts` stores as the
   * job's `lastError` and `/api/health` surfaces as `degraded`, only under
   * `decideEscalation`'s two conditions: immediately for a tick with any
   * non-transient failure, or after `MAX_CONSECUTIVE_CONTENDED_TICKS`
   * consecutive all-transient ticks. The sweep INVOKES a class only in the
   * rare state it exists for — a free seat and a live queue at the same
   * moment — and skips every other candidate, so one invoked class per tick is
   * the ordinary case however many teachers share the deployment. A single
   * benign lock race on an otherwise-idle sweep therefore no longer reddens
   * the job by itself — that false alarm is exactly what issue #269 (and this
   * branch) fixed.
   *
   * The 3.5s hold sits above the 2s bound and below the 5s budget, so without
   * the bound this call acquires at 3.5s and succeeds. `outcome.ok === false`
   * is therefore the discriminator, `/55P03/` names the mechanism, and
   * `waited > 1_000` excludes an instant unrelated failure — see the sibling
   * guard in `addToWaitlist + removeFromWaitlist (DB)` above for why there is
   * no upper bound on `waited`, and for why the ceiling that used to be here
   * was worth deleting even though it had one sliver of coverage: that sliver
   * is already pinned directly by `db-locks.test.ts`.
   */
  it('gives up on the 2s bound when another transaction holds the class row', async () => {
    // Its own full class: max 1, one filler registered (making it full,
    // which `addToWaitlist` requires), a second filler waitlisted, then that
    // registration cancelled to free the seat.
    const lockedClassId = await makeClass(1);

    try {
      await prisma.registration.create({
        data: {
          classId: lockedClassId,
          studentId: fillerIds[0]!,
          status: 'registered',
          tierAtBooking: 3,
        },
      });
      await addToWaitlist(prisma, lockedClassId, fillerIds[1]!);
      await prisma.registration.update({
        where: { classId_studentId: { classId: lockedClassId, studentId: fillerIds[0]! } },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });

      const holderClient = new PrismaClient();
      let signalHeld!: () => void;
      const held = new Promise<void>((r) => {
        signalHeld = r;
      });

      const holder = holderClient.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${lockedClassId} FOR UPDATE`;
          signalHeld();
          await new Promise((r) => setTimeout(r, 3_500));
        },
        { timeout: 30_000 },
      );
      await held;

      const startedAt = Date.now();
      const outcome = await promoteNext(prisma, lockedClassId).then(
        () => ({ ok: true as const }),
        (err: unknown) => ({ ok: false as const, err: String(err) }),
      );
      const waited = Date.now() - startedAt;

      await holder;
      await holderClient.$disconnect();

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.err).toMatch(/55P03/);
      expect(waited).toBeGreaterThan(1_000);
    } finally {
      await prisma.waitlistEntry.deleteMany({ where: { classId: lockedClassId } });
      await prisma.registration.deleteMany({ where: { classId: lockedClassId } });
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: lockedClassId } } } });
    }
  }, 20_000);
});

describe('claimSpot (DB)', () => {
  // One fixed class drives the deadline math, so nothing here reads the wall
  // clock:
  //   class starts       2026-06-01 09:00 UTC  (teacher default timezone UTC)
  //   HOURS_24        →  deadline 2026-05-31 09:00 UTC
  //   cutoff = deadline − 1h        2026-05-31 08:00 UTC
  // IN_CLAIM_WINDOW sits inside the final hour, after the deadline's cutoff
  // and before the deadline itself.
  const IN_CLAIM_WINDOW = new Date('2026-05-31T08:30:00Z');

  let classId: string;

  beforeAll(async () => {
    // A full, open class with `studentIds[0]` on its waitlist — the state the
    // claim starts from. `maxStudents: 1` plus one registration is the
    // cheapest way to be full, which is what `addToWaitlist` requires before
    // it will accept anyone.
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'Claim Flow',
      date: new Date('2026-06-01'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 1,
      cancelDeadline: 'HOURS_24',
      status: 'open',
    });
    classId = cls.id;
    await prisma.registration.create({
      data: { classId, studentId: fillerIds[0]!, tierAtBooking: 3 },
    });
    await addToWaitlist(prisma, classId, studentIds[0]!);
  });

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: classId } } } });
  });

  /**
   * #104. `claimSpot` took an unbounded inline `FOR UPDATE` until this change;
   * it now goes through `lockClassRow` and its shared 2s bound.
   *
   * This is the site where contention is by DESIGN: the final-hour broadcast
   * tells every waiting student at once, so N claims land on one `Class` row
   * and serialize. That is not what the bound is for — each claim holds the
   * row only for its own short transaction, so 2s covers a deep queue
   * comfortably. What the bound stops is a claim arriving while an UNRELATED
   * long holder has the row: a GDPR erasure holds, for up to 20s, every class
   * the erased student was QUEUED in — `deleteStudentAccount` pre-locks on a
   * join over `WaitlistEntry` (`gdpr.ts`), across every entry status, not on
   * registrations. A class the student was registered in but never queued in
   * is written UNLOCKED by that same erasure, a distinction `handleSpotFreed`
   * makes deliberately in `waitlist.ts` — so "every class a student touched"
   * would name a wider lock set than the one that actually exists.
   *
   * The 3.5s hold is the guard. It sits above the 2s bound and below Prisma's
   * 5s default budget, so WITHOUT the bound this call acquires at 3.5s and
   * succeeds — reverting the site fails `expect(outcome.ok).toBe(false)`
   * rather than hanging the suite. That failure IS what separates "gave up at
   * 2s" from "waited it out"; see the sibling guard in
   * `addToWaitlist + removeFromWaitlist (DB)` above for why there is no upper
   * bound on `waited`, and for why the ceiling that used to be here was worth
   * deleting even though it had one sliver of coverage: that sliver is
   * already pinned directly by `db-locks.test.ts`.
   */
  it('gives up on the 2s bound when another transaction holds the class row', async () => {
    // Same state `claimSpot` needs to reach the lock: in the claim window,
    // one free spot, this student `waiting`.
    await prisma.registration.update({
      where: { classId_studentId: { classId, studentId: fillerIds[0]! } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

    const holderClient = new PrismaClient();
    let signalHeld!: () => void;
    const held = new Promise<void>((r) => {
      signalHeld = r;
    });

    const holder = holderClient.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
        signalHeld();
        await new Promise((r) => setTimeout(r, 3_500));
      },
      { timeout: 30_000 },
    );
    await held;

    const startedAt = Date.now();
    const outcome = await claimSpot(prisma, classId, studentIds[0]!, IN_CLAIM_WINDOW).then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err: String(err) }),
    );
    const waited = Date.now() - startedAt;

    await holder;
    await holderClient.$disconnect();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err).toMatch(/55P03/);
    expect(waited).toBeGreaterThan(1_000);
  }, 20_000);
});

describe('removeFromWaitlist takes the class lock (DB)', () => {
  /**
   * Held for under the 2s `lock_timeout` this site now sets, so what this
   * observes is the wait and not the timeout.
   */
  it('waits for a class row another transaction holds before renumbering', async () => {
    // Its own full class: max 1, one filler registered, three students
    // waiting in order — position 2 gets removed mid-lock below, so the
    // reorder that follows has real work to do: position 3 moves to 2.
    const classId = await makeClass(1);
    await prisma.registration.create({
      data: {
        classId,
        studentId: fillerIds[0]!,
        status: 'registered',
        tierAtBooking: 3,
      },
    });
    for (const studentId of studentIds) {
      await addToWaitlist(prisma, classId, studentId);
    }

    let holderReleased = false;

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
        await new Promise((r) => setTimeout(r, 900));
        holderReleased = true;
      },
      { timeout: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 150));

    const removing = removeFromWaitlist(prisma, classId, studentIds[1]!).then(
      () => 'returned' as const,
    );
    const outcome = await Promise.race([
      removing,
      new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 400)),
    ]);

    expect(outcome).toBe('waiting');
    expect(holderReleased).toBe(false);

    await holder;
    expect(await removing).toBe('returned');

    // Not a lock-discriminating assertion on its own — nothing else is
    // renumbering this queue concurrently, so it would pass with the lock
    // removed too. What the wait assertions above prove is the
    // serialization; this only confirms `removeFromWaitlist` left the queue
    // correctly renumbered once it ran.
    const remaining = await prisma.waitlistEntry.findMany({
      where: { classId, status: 'waiting' },
      orderBy: { position: 'asc' },
    });
    expect(remaining.map((e) => e.position)).toEqual([1, 2]);

    await prisma.waitlistEntry.deleteMany({ where: { classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: classId } } } });
  });
});

describe('handleSpotFreed (DB)', () => {
  // Fixed class, so nothing here reads the wall clock. Same derivation as the
  // `claimSpot (DB)` block above, one day later so the two don't overlap on
  // the shared teacher:
  //   class starts       2026-06-03 09:00 UTC  (teacher default timezone UTC)
  //   HOURS_24        →  deadline 2026-06-02 09:00 UTC
  //   cutoff = deadline − 1h        2026-06-02 08:00 UTC
  const IN_CLAIM_WINDOW = new Date('2026-06-02T08:30:00Z');

  /**
   * #212. The capacity guard above is proved by M4; the lock that makes it
   * MEAN anything was proved by nothing — deleting `lockClassRow` left every
   * test in `waitlist`/`capacity`/`gdpr` green. That is the branch's whole
   * argument (spec §2: an unlocked count moves the race rather than closing
   * it) sitting untested.
   *
   * **Two traps, and the second one caught the first version of this test.**
   *
   * 1. *The notification write blocks anyway.* Holding the row and calling the
   *    hook on a class with a FREE seat passes with `lockClassRow` deleted: a
   *    broadcast that reaches its `createMany` takes `FOR KEY SHARE` on the
   *    same `Class` row via `relatedClassId` (`docs/lock-order.md`, "the
   *    fourth path"), which conflicts with the holder's `FOR UPDATE`. It
   *    blocks either way and the wait proves only that Postgres works. So the
   *    fixture below builds the class already full: the hook counts, returns,
   *    and writes nothing, leaving the lock as the only thing that can block
   *    it.
   *
   * 2. *A wall-clock verdict is not a proposition about locks.* The first
   *    version raced the hook against a 400 ms timer and asserted "did not
   *    finish". Under CPU load, with `lockClassRow` deleted, it reported a
   *    PASS in 4 of 5 runs — instrumented, the hook had not yet reached its
   *    `FOR UPDATE` when the verdict fired at 552 ms. Slowness manufactured
   *    the evidence. CI is 2-4 cores against the 10-core machine that measured
   *    that, so it is likelier there, not less.
   *
   * The fix for trap 2 is to assert an outcome slowness cannot produce. The
   * holder keeps the row for longer than `lockClassRow`'s own 2 s
   * `SET LOCAL lock_timeout`, so the hook must abort with **55P03** — a
   * SQLSTATE a busy machine does not invent, and that only asking for a held
   * lock can produce. Measured 5/5 detection under the same load that broke
   * the timer version.
   *
   * `released` guards the converse: had the holder finished early, the hook
   * would have taken the lock cleanly and this would be testing nothing.
   */
  it('takes the class row lock before it counts', async () => {
    // maxStudents: 1 plus one registration is the cheapest way to be full,
    // which is what the lock guard below needs: a full class means the hook,
    // once it gets past the lock, would count and return without writing —
    // trap 1 above.
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'SpotFreed Flow',
      date: new Date('2026-06-03'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 1,
      cancelDeadline: 'HOURS_24',
      status: 'open',
    });
    const classId = cls.id;
    await prisma.registration.create({
      data: { classId, studentId: fillerIds[1]!, tierAtBooking: 3 },
    });

    const countBroadcasts = () =>
      prisma.notification.count({ where: { relatedClassId: classId, type: 'spot_available' } });
    const broadcastsBefore = await countBroadcasts();

    let released = false;
    // A handshake, not a sleep: a fixed wait and hoping the holder had the
    // row by then measured holder-acquisition latency reaching 486 ms under
    // load and 428 ms even idle, so that assumption failed loudly and at
    // random.
    let signalHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
        signalHeld();
        // Longer than the 2 s `lock_timeout` inside `lockClassRow`, so the
        // hook is guaranteed to hit the bound rather than eventually succeed.
        await new Promise((r) => setTimeout(r, 3_500));
        released = true;
      },
      { timeout: 20_000 },
    );
    await lockHeld;

    const outcome = await handleSpotFreed(prisma, classId, IN_CLAIM_WINDOW).then(
      (result) => ({ ok: true as const, result }),
      // `handleSpotFreed` now wraps every throw in `SpotFreedError` — the
      // Postgres error this guard is about (see the docblock above) lives on
      // `.cause`, not the wrapper's own message.
      (err: unknown) => ({
        ok: false as const,
        err: err instanceof Error ? String(err.cause) : String(err),
      }),
    );

    // Without `lockClassRow` the hook never asks for the row, counts a full
    // class, and returns `{ action: 'none' }` — `ok: true`, and this fails.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err).toMatch(/55P03|lock timeout/i);
    expect(released).toBe(false);

    await holder;

    // It wrote nothing on the way out, so the aborted broadcast cost the
    // waiting students nothing except the notice they never got.
    expect(await countBroadcasts()).toBe(broadcastsBefore);

    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: classId } } } });
  });
});
