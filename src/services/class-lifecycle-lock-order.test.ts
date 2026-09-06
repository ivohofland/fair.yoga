/**
 * @serial-tier lock-contention — both cases below hold a `Class` row
 * `FOR UPDATE` open on a second connection while the code under test parks on
 * that row under `lockClassRow`'s 2s `lock_timeout`. Each is therefore both a
 * source of seconds-long lock noise and an assertion a tier-mate's noise can
 * falsify, and they fail in opposite directions.
 *
 * `decides from the class row the holder left behind, not from a read taken
 * before the wait` holds for 900ms and races `completeClass` against a 400ms
 * timer to show it is still waiting — noise only makes that half safer. What
 * it endangers is the margin AFTER it: the holder still has to commit and
 * `completeClass` still has to acquire the row inside the same 2s bound, about
 * 1.2s of room. Delay the holder's commit past that and the expected
 * `reason: 'CANCELLED'` arrives as a thrown `55P03` instead — a failure from
 * the wrong cause rather than from the stale read the case watches for.
 *
 * `gives up on the 2s bound when another transaction holds the class row`
 * holds past the bound deliberately and asserts a `55P03` with
 * `waited >= 1_800`, so noise cannot break the lower bound; it can only break
 * the SHAPE of the failure. The transition runs inside a Prisma transaction on
 * the default 5s budget, of which the 2s bound leaves roughly three seconds
 * spare — and a tier-mate that eats that spare before the locking statement
 * issues turns the `55P03` into a `P2028`, which is exactly the symptom this
 * case exists to prove `setLockTimeout` prevents. It would then report the
 * defect while the guard is still in place.
 *
 * SPLIT OUT OF `class-lifecycle.test.ts` (#468), AND NOT ON COST. A file named
 * on `LOCK_CONTENTION_TESTS` (`vitest.tiers.ts`) becomes the default home for
 * every test added to it afterwards; `class-lifecycle.test.ts` is general and
 * actively grown, so listing it would have pulled its whole future into the
 * serial tier, where this sibling grows only when someone writes another
 * contention case. What moving that file whole would have cost was measured
 * and is not what decided this —
 * `docs/superpowers/specs/2026-09-06-lock-contention-rest-design.md` §2.1.
 *
 * WHY `class-lifecycle.test.ts` NOW HAS TWO SERIAL SIBLINGS, WHICH ARE NOT TO
 * BE MERGED. The other is `class-lifecycle-tier-guard.test.ts`, and it left
 * for a different mechanism entirely: its case drops and re-adds a CHECK on
 * `Registration` with raw DDL, and `ALTER TABLE` takes ACCESS EXCLUSIVE, which
 * conflicts with every concurrent reader and writer of a table the parallel
 * tier touches all over. Nothing below takes a table lock and nothing there
 * holds a row, so neither file's reason covers the other's cases. Its name is
 * about the tier guard it certifies rather than about lock order, which is why
 * these two cases are here under the established `*-lock-order.test.ts` name
 * instead of being appended to it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, ClassStatus } from '@prisma/client';
import { hhmmToTime } from '@/lib/time-of-day';
import { completeClass, transitionClass } from './class-lifecycle';
import { createClassFixture, slotDate } from '../../tests/class-fixtures';

const prisma = new PrismaClient();
// PREFIXED, not just timestamped — the convention
// `class-lifecycle-tier-guard.test.ts` states in its own header, and for the
// same reason: this file and `class-lifecycle.test.ts` share one test database
// and both mint fixtures from a clock value, so a bare `Date.now()` in each
// could collide on a unique email or slug. The prefix makes the namespaces
// disjoint by construction rather than by luck, and the `afterAll` below
// sweeps this file's teacher only.
const uniqueSuffix = `lockorder-${Date.now()}`;

describe('the Class row lock under real contention (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  const studentIds: string[] = [];

  // A class per case, off one shared teacher/room fixture. Both cases below
  // hold their own class's row against a second connection, so neither can
  // share a class with the other.
  //
  // Counter-derived DATE, one day per call (`slotDate`, `tests/class-fixtures.ts`):
  // since #327 `CalendarEntry_teacher_slot_excl` is a RANGE overlap scoped per
  // teacher, and a day per call is disjoint whatever the duration. The start
  // time is a constant because neither case reads or asserts it — only the id.
  let makeClassCounter = 0;
  const makeClass = ({ status }: { status: ClassStatus }) => {
    makeClassCounter += 1;
    return createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'Vinyasa',
      date: slotDate('2026-06-01', makeClassCounter),
      startTime: hhmmToTime('18:00'),
      durationMinutes: 75,
      roomCost: 35,
      minRate: 15,
      targetRate: 25,
      minStudents: 4,
      maxStudents: 12,
      status,
      settingsLocked: true,
    });
  };

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'LockOrder',
        lastName: 'Teacher',
        email: `lock-order-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `lock-order-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Test teacher for the class-row lock races',
        pageSlug: `lock-order-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Lock Order Studio',
        address: `${uniqueSuffix} Lock Order St`,
        city: 'Amsterdam',
        postcode: '5678CD',
        floor: '2',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: {
        teacherId,
        roomId,
        capacityOverride: 15,
        rentalRate: 35,
      },
    });
    teacherRoomId = teacherRoom.id;
  });

  afterAll(async () => {
    // Dependency order: waitlist entries -> payments -> registrations ->
    // entries (which take their classes with them) -> students -> teacherRoom
    // -> room -> teacher. Filtered by this file's own `teacherId` throughout,
    // so it sweeps its own rows and nothing else's.
    await prisma.waitlistEntry.deleteMany({ where: { class: { calendarEntry: { teacherId } } } });
    await prisma.payment.deleteMany({
      where: { registration: { class: { calendarEntry: { teacherId } } } },
    });
    await prisma.registration.deleteMany({ where: { class: { calendarEntry: { teacherId } } } });
    // Before `teacherRoom.delete`: what blocks teardown is the surviving
    // `Class` row via the plain `Class.teacherRoomId` FK.
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    for (const sid of studentIds) {
      await prisma.student.delete({ where: { id: sid } });
    }
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  /**
   * The lock cannot be seen in the rows afterwards — it is the timing that
   * differs. But timing alone does not falsify this: `completeClass` always
   * ends with a `class.update`, and that statement blocks behind another
   * transaction's `FOR UPDATE` whether or not the read above it was taken
   * under a lock — a holder that only sleeps produces the same
   * wait-then-return shape either way (confirmed: this was tried first, and
   * it passed against the unlocked implementation, which is why it was
   * rewritten). So the holder here also commits a status change — while
   * `completeClass` is blocked, not before it starts — and the assertion
   * is on what the eventual decision was made from, not just on the wait:
   * a read taken under the lock (after the holder's commit) sees the
   * cancellation and refuses; a read taken before the wait is stale, and
   * the unconditional `class.update` that follows — once the lock frees —
   * clobbers the holder's cancellation with 'completed'. Held well under
   * the 2s `lock_timeout` the new site sets, so this observes the wait and
   * not the timeout.
   *
   * One charged registration is attached rather than none: the lock's
   * stated purpose covers the registration set the pricing engine consumes
   * and the `payment.create` it feeds, not just the status field, and a
   * class with zero registrations only ever exercises `completeClass`'s
   * zero-charged short-circuit — proving nothing about that half of the
   * rationale beyond inference.
   */
  it('decides from the class row the holder left behind, not from a read taken before the wait', async () => {
    const cls = await makeClass({ status: 'in_progress' });
    const student = await prisma.student.create({
      data: {
        firstName: 'Lock',
        lastName: 'Test',
        email: `lock-test-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    studentIds.push(student.id);
    await prisma.registration.create({
      data: { classId: cls.id, studentId: student.id, status: 'registered', tierAtBooking: 3 },
    });

    // Set when the holder's own work — the sleep and its status update — is
    // done, which happens before its transaction callback returns and
    // therefore before Prisma issues `COMMIT` and before Postgres actually
    // releases the row lock. Named for what it observes: not "released",
    // which happens later, on both counts.
    let holderFinishedWork = false;

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${cls.id} FOR UPDATE`;
        await new Promise((r) => setTimeout(r, 900));
        await tx.calendarEntry.update({
          where: { id: cls.calendarEntryId },
          data: { cancelledAt: new Date() },
        });
        holderFinishedWork = true;
      },
      { timeout: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 150));

    const completingResult = completeClass(prisma, cls.id, { finishedEarly: true });
    const completing = completingResult.then(() => 'returned' as const);
    const outcome = await Promise.race([
      completing,
      new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 400)),
    ]);

    expect(outcome).toBe('waiting');
    expect(holderFinishedWork).toBe(false);

    await holder;
    const result = await completingResult;

    // Without the lock, this reads an uncancelled entry — the state that was
    // current before the wait began — and reports success, having already
    // clobbered the holder's cancellation on the way out.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('CANCELLED');

    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
    expect(after.status).toBe('in_progress');
    expect(after.calendarEntry.cancelledAt).not.toBeNull();

    // The registration was never priced and no Payment exists — the
    // pricing engine never ran, because the refusal happened before
    // `completeClass` got past its own status gate.
    const reg = await prisma.registration.findFirstOrThrow({ where: { classId: cls.id } });
    expect(reg.price).toBeNull();
    expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(0);
  });

  /**
   * `setLockTimeout` in `transitionClass`, which was the entire subject of the
   * commit that added it and which nothing pinned — deleting the call passed
   * 1172 unit and integration tests.
   *
   * `transitionClass` takes its `Class` row lock through the CAS rather than
   * through `lockClassRow`, so it inherited no per-statement bound. Once the
   * CAS moved inside an interactive transaction that mattered: an unbounded
   * wait becomes Prisma's 5s budget expiring mid-transaction (`P2028`, which
   * `classifyApiError` answers with a 503 the caller cannot act on) instead of
   * the 2s `55P03` every sibling gets and which maps to retry advice.
   *
   * The bounds are deliberately loose, as this repo's sibling lock-timeout
   * tests are (`class-generator-lock-order.test.ts`): the lower one proves it
   * really waited on the row rather than sailing through, the upper that it
   * gave up on the 2s bound rather than Prisma's 5s. Neither pins the bound's
   * VALUE, which belongs to `db-locks.ts`.
   */
  it('gives up on the 2s bound when another transaction holds the class row', async () => {
    const cls = await makeClass({ status: 'open' });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${cls.id} FOR UPDATE`;
        await held;
      },
      { timeout: 20_000 },
    );
    await new Promise((r) => setTimeout(r, 150));

    try {
      const startedAt = Date.now();
      await expect(transitionClass(prisma, cls.id, 'in_progress')).rejects.toThrow(/55P03|lock timeout/i);
      const waited = Date.now() - startedAt;

      // Lower bound proves it waited rather than failing instantly. The 2s
      // value is pinned by `db-locks.test.ts`, and there is deliberately no
      // wall-clock upper bound (#323, `waitlist-lock-order.test.ts`'s "gives up
      // on the 2s bound when another transaction holds the class row" docblock).
      expect(waited).toBeGreaterThanOrEqual(1_800);

      const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
      expect(unchanged.status).toBe('open');
    } finally {
      release();
      await holder;
    }
  }, 20_000);
});
