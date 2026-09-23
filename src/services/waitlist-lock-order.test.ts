/**
 * @serial-tier lock-contention — every test below holds a `Class` row across
 * a staged wait and asserts on how it resolves: real lock noise for anything
 * sharing a parallel tier with them, and real lock noise landing on them in
 * return is what would turn one of these assertions into a false positive
 * from the wrong cause.
 *
 * Split out of `waitlist.test.ts` (#459) for exactly that reason. Each test
 * names the waitlist function it drives and what that function does when it
 * meets a held `Class` row — give up at the shared 2s `lock_timeout`, wait,
 * or read stale state a later statement re-fetches once the wait ends. Each
 * test asserts the consequence of the lock, not the ordinary
 * registration/promotion/removal path. One teacher, one room, one
 * `TeacherRoom` and a small pool of students are shared at module scope; each
 * test below builds the one class it locks.
 */
import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  addToWaitlist,
  removeFromWaitlist,
  promoteNext,
  claimSpot,
  handleSpotFreed,
  SpotFreedError,
  withdrawWaitingEntriesForTeacher,
} from './waitlist';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture, slotTime } from '../../tests/class-fixtures';
import * as dbLocks from '@/lib/db-locks';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

let teacherId: string;
let accountId: string;
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
  accountId = teacher.accountId;

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
  // Swept by teacherId, not by a fixed id list: `Class.teacherRoom` has no
  // `onDelete: Cascade` (unlike `Class.calendarEntry`), so a test that dies
  // before reaching its own inline cleanup — which the mutation-testing
  // protocol guarantees will happen — must not leave a class behind that
  // then breaks this teardown's `teacherRoom` delete on an FK violation.
  // Same fix `waitlist.test.ts`'s sibling `afterAll` already carries.
  await prisma.waitlistEntry.deleteMany({ where: { class: { calendarEntry: { teacherId } } } });
  await prisma.registration.deleteMany({ where: { class: { calendarEntry: { teacherId } } } });
  await prisma.calendarEntry.deleteMany({ where: { teacherId } });
  await prisma.student.deleteMany({ where: { id: { in: [...fillerIds, ...studentIds] } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  await prisma.room.delete({ where: { id: roomId } });
  await prisma.teacher.delete({ where: { id: teacherId } });
  await prisma.account.delete({ where: { id: accountId } });
  await prisma.$disconnect();
});

/**
 * A one-minute class on the shared teacher's one generic date — `addToWaitlist`,
 * `promoteNext` and `removeFromWaitlist`'s guards below don't care what the
 * class's own schedule is, only that it exists and is `open`, so a distinct
 * minute per call (via `slotTime`) is all `CalendarEntry_teacher_slot_excl`
 * needs. `claimSpot`'s and `handleSpotFreed`'s guards build their own fixed-date
 * classes instead, because their window math is pinned against an exact
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
   * logs the loss at its kind's level on every tick — `TRANSIENT_KIND_LEVEL`
   * (`lib/api-errors.ts`) owns which, and the `55P03`/`lock_timeout` this test
   * provokes is `warn` there — and raises that to `error` regardless of kind
   * if the same class stays stuck for `MAX_CONSECUTIVE_CONTENDED_TICKS` in a
   * row. Neither level delivers anywhere on its own today — `lib/log.ts` is
   * pino to stdout with no transport, so nothing pages anyone off either one
   * (#157); the lines sit in the server log for whoever reads it. What
   * surfaces is `report`'s
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
  // One fixed class drives the window math, so nothing here reads the wall
  // clock:
  //   class starts             2026-06-01 09:00 UTC  (teacher default timezone UTC)
  //   claim window opens       2026-06-01 08:00 UTC  (start − CLAIM_WINDOW_MINUTES)
  // IN_CLAIM_WINDOW sits inside that final hour, before start itself — the
  // window is anchored on start, not on the cancel deadline (#236).
  const IN_CLAIM_WINDOW = new Date('2026-06-01T08:30:00Z');

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
    // removed too (confirmed: it still passes with `lockClassRow` commented
    // out and the two wait assertions above deleted). What the wait
    // assertions above prove is the serialization; this only confirms
    // `removeFromWaitlist` left the queue correctly renumbered once it ran.
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
  // `claimSpot (DB)` block above, two days later so the two don't overlap on
  // the shared teacher:
  //   class starts             2026-06-03 09:00 UTC  (teacher default timezone UTC)
  //   claim window opens       2026-06-03 08:00 UTC  (start − CLAIM_WINDOW_MINUTES)
  // Must land inside that window: it is what drives `getWaitlistWindow` to
  // `first_come_first_claimed`, the branch this test's `lockClassRow` guard
  // is about (#212) — outside it, `handleSpotFreed` runs `promoteNext`
  // instead, whose own `lockClassRow` call would produce the same 55P03 for
  // the wrong reason.
  const IN_CLAIM_WINDOW = new Date('2026-06-03T08:30:00Z');

  /**
   * #212. The capacity guard (`waitlist.test.ts`'s "stays silent when the
   * class is already full, and broadcasts when it is not") is proved by M4;
   * the lock that makes it MEAN anything was proved by nothing — deleting
   * `lockClassRow` left every test in `waitlist`/`capacity`/`gdpr` green.
   * That is the branch's whole argument (spec §2: an unlocked count moves the
   * race rather than closing it) sitting untested.
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
      // `.cause`, not the wrapper's own message. `.window` is set before the
      // broadcast transaction runs, so asserting it is what tells this
      // failure apart from the auto-promote branch's own `lockClassRow` call
      // inside `promoteNext` — that one would raise the identical 55P03 cause
      // with a different (or, before the window resolves, null) `.window`.
      (err: unknown) => ({
        ok: false as const,
        err: err instanceof Error ? String(err.cause) : String(err),
        window: err instanceof SpotFreedError ? err.window : null,
      }),
    );

    // Without `lockClassRow` the hook never asks for the row, counts a full
    // class, and returns `{ action: 'none' }` — `ok: true`, and this fails.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.err).toMatch(/55P03|lock timeout/i);
      // Pins the BROADCAST branch specifically — see the comment above.
      expect(outcome.window).toBe('first_come_first_claimed');
    }
    expect(released).toBe(false);

    await holder;

    // It wrote nothing on the way out, so the aborted broadcast cost the
    // waiting students nothing except the notice they never got.
    expect(await countBroadcasts()).toBe(broadcastsBefore);

    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: classId } } } });
  });
});

describe('withdrawWaitingEntriesForTeacher re-checks status against a promotion committed mid-wait (#241)', () => {
  // Local copy; the spy is scoped to this describe's tests.
  const captureLockSets = (): string[][] => {
    const original = dbLocks.lockClassRowsOrdered;
    const lockSets: string[][] = [];
    const spy = vi.spyOn(dbLocks, 'lockClassRowsOrdered').mockImplementation(async (tx, source) => {
      const ids = await original(tx, source);
      lockSets.push(ids);
      return ids;
    });
    onTestFinished(() => spy.mockRestore());
    return lockSets;
  };

  /**
   * Stages a promotion that commits WHILE the withdrawal's lock query is
   * blocked on the same `Class` row, so the join inside that query is built
   * from the snapshot taken when the statement started. The wait on `Class`
   * does not refresh that join: the holder here only locks `Class` and never
   * updates it, so no EvalPlanQual re-check runs once the wait ends — and
   * even when one does, it re-fetches only the tables named in
   * `FOR UPDATE OF`, never a joined table like `WaitlistEntry`. The entry the
   * holder promotes therefore still reads `waiting` inside that query, and
   * its class still lands in the ids handed back — so the entry surviving as
   * `promoted` here is entirely down to the subsequent `updateMany`
   * re-reading `status` for itself under a fresh snapshot, not to the lock
   * query having noticed the promotion.
   */
  it('leaves a promoted entry alone when the promotion committed while the withdrawal waited', async () => {
    // Its own full class: max 1, one filler registered, studentIds[0]
    // waiting at position 1.
    const classId = await makeClass(1);
    await prisma.registration.create({
      data: {
        classId,
        studentId: fillerIds[0]!,
        status: 'registered',
        tierAtBooking: 3,
      },
    });
    await addToWaitlist(prisma, classId, studentIds[0]!);

    const lockSets = captureLockSets();

    // A handshake, not a sleep: the sibling guards above measured
    // holder-acquisition latency reaching 486ms under load, well past a
    // fixed settle.
    let signalHeld!: () => void;
    const held = new Promise<void>((r) => {
      signalHeld = r;
    });

    let holderCommitting = false;
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
        signalHeld();
        await tx.waitlistEntry.update({
          where: { classId_studentId: { classId, studentId: studentIds[0]! } },
          data: { status: 'promoted' },
        });
        // A second handshake, not a fixed sleep: poll until Postgres reports
        // this backend blocking another one — the withdrawal's own
        // `FOR UPDATE` request landing on this same row — instead of
        // guessing how long that takes to arrive. Postgres holds one
        // `pg_stat_activity` snapshot per transaction, so each poll clears it
        // first — otherwise every poll re-reads the first one.
        const deadline = Date.now() + 5_000;
        for (;;) {
          await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`;
          const [row] = await tx.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))`;
          if ((row?.n ?? 0) > 0) break;
          if (Date.now() > deadline) throw new Error('withdrawal never blocked on the held Class row');
          await new Promise((r) => setTimeout(r, 25));
        }
        holderCommitting = true;
      },
      { timeout: 20_000 },
    );
    await held;

    try {
      // Precondition: exactly this fixture's own waiting entry. Without this,
      // a sibling that died mid-mutation and left studentIds[0] waiting on its
      // own class would surface here as a `lockSets`/`status` mismatch instead
      // of naming the real cause.
      expect(
        await prisma.waitlistEntry.count({
          where: {
            studentId: studentIds[0]!,
            status: 'waiting',
            class: { calendarEntry: { teacherId } },
          },
        }),
      ).toBe(1);

      await prisma.$transaction((tx) =>
        withdrawWaitingEntriesForTeacher(tx, { teacherId, studentId: studentIds[0]! }),
      );
      const holderCommittingAtReturn = holderCommitting;
      await holder;

      // True only if the holder set it before the withdrawal's blocked lock
      // request could return — the holder releases the row (ending its
      // transaction) only once it has set this; the `[[classId]]` check
      // below rules out the withdrawal arriving after the holder had already
      // committed. Neither assertion proves the window alone — together they
      // do.
      expect(holderCommittingAtReturn).toBe(true);

      expect(lockSets).toEqual([[classId]]);

      const entry = await prisma.waitlistEntry.findFirstOrThrow({
        where: { classId, studentId: studentIds[0]! },
      });
      expect(entry.status).toBe('promoted');
    } finally {
      await holder.catch(() => {});
      await prisma.waitlistEntry.deleteMany({ where: { classId } });
      await prisma.registration.deleteMany({ where: { classId } });
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: classId } } } });
    }
  }, 20_000);
});
