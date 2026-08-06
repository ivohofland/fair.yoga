import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, type ClassStatus } from '@prisma/client';
import {
  VALID_TRANSITIONS,
  ECONOMIC_FIELDS,
  canTransition,
  validateTransition,
  sourceStatesFor,
  isEconomicFieldLocked,
  transitionClass,
  completeClass,
  updateClass,
  UpdateClassInvariantError,
  type EconomicField,
} from './class-lifecycle';

// We use string literals matching the Prisma ClassStatus enum values.
// This keeps tests independent of the Prisma client being generated.

describe('VALID_TRANSITIONS', () => {
  it('defines transitions for every ClassStatus value', () => {
    const allStatuses = [
      'draft',
      'open',
      'in_progress',
      'completed',
      'cancelled',
    ] as const;

    for (const status of allStatuses) {
      expect(VALID_TRANSITIONS).toHaveProperty(status);
      expect(Array.isArray(VALID_TRANSITIONS[status])).toBe(true);
    }
  });

  it('draft can transition to open or cancelled', () => {
    expect(VALID_TRANSITIONS['draft']).toEqual(
      expect.arrayContaining(['open', 'cancelled']),
    );
    expect(VALID_TRANSITIONS['draft']).toHaveLength(2);
  });

  it('open can transition to in_progress or cancelled', () => {
    expect(VALID_TRANSITIONS['open']).toEqual(
      expect.arrayContaining(['in_progress', 'cancelled']),
    );
    expect(VALID_TRANSITIONS['open']).toHaveLength(2);
  });

  it('in_progress can only transition to completed', () => {
    expect(VALID_TRANSITIONS['in_progress']).toEqual(['completed']);
  });

  it('completed is a terminal state with no transitions', () => {
    expect(VALID_TRANSITIONS['completed']).toEqual([]);
  });

  it('cancelled is a terminal state with no transitions', () => {
    expect(VALID_TRANSITIONS['cancelled']).toEqual([]);
  });
});

describe('canTransition', () => {
  it('returns true for valid transitions', () => {
    expect(canTransition('draft', 'open')).toBe(true);
    expect(canTransition('draft', 'cancelled')).toBe(true);
    expect(canTransition('open', 'in_progress')).toBe(true);
    expect(canTransition('open', 'cancelled')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
  });

  it('returns false for invalid transitions', () => {
    expect(canTransition('draft', 'completed')).toBe(false);
    expect(canTransition('draft', 'in_progress')).toBe(false);
    expect(canTransition('open', 'draft')).toBe(false);
    expect(canTransition('open', 'completed')).toBe(false);
    expect(canTransition('in_progress', 'draft')).toBe(false);
    expect(canTransition('in_progress', 'open')).toBe(false);
    expect(canTransition('in_progress', 'cancelled')).toBe(false);
  });

  it('returns false for transitions out of terminal states', () => {
    expect(canTransition('completed', 'open')).toBe(false);
    expect(canTransition('completed', 'draft')).toBe(false);
    expect(canTransition('completed', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'open')).toBe(false);
    expect(canTransition('cancelled', 'draft')).toBe(false);
    expect(canTransition('cancelled', 'completed')).toBe(false);
  });

  it('returns false for self-transitions', () => {
    expect(canTransition('draft', 'draft')).toBe(false);
    expect(canTransition('open', 'open')).toBe(false);
    expect(canTransition('in_progress', 'in_progress')).toBe(false);
    expect(canTransition('completed', 'completed')).toBe(false);
    expect(canTransition('cancelled', 'cancelled')).toBe(false);
  });
});

describe('validateTransition', () => {
  it('returns { ok: true } for valid transitions', () => {
    expect(validateTransition('draft', 'open')).toEqual({ ok: true });
    expect(validateTransition('open', 'in_progress')).toEqual({ ok: true });
    expect(validateTransition('in_progress', 'completed')).toEqual({
      ok: true,
    });
  });

  it('returns { ok: false, error } for invalid transitions', () => {
    const result = validateTransition('draft', 'completed');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('draft');
      expect(result.error).toContain('completed');
    }
  });

  it('returns { ok: false, error } for transitions out of terminal states', () => {
    const result = validateTransition('completed', 'open');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('completed');
    }
  });

  it('error message describes the invalid transition', () => {
    const result = validateTransition('cancelled', 'draft');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

// `sourceStatesFor` is the inverse of `VALID_TRANSITIONS` above, and it is
// what `transitionClass`'s compare-and-swap predicate is built from — a
// silent drift here (say, a target status left out when a new transition is
// added) would show up as `transitionClass` refusing a transition that
// `VALID_TRANSITIONS` calls legal, or vice versa. Hand-derived per status,
// the same way `describe('VALID_TRANSITIONS', ...)` above pins each row by
// hand, rather than re-deriving the expectation from `VALID_TRANSITIONS`
// itself, which would only prove the function agrees with itself.
describe('sourceStatesFor', () => {
  it('draft has no source states — nothing transitions into the initial state', () => {
    // Load-bearing, not incidental: transitionClass's CAS predicate becomes
    // `status: { in: [] }` for a `draft` target, which Prisma turns into a
    // Postgres `IN ()` that matches no row. `updateMany` therefore always
    // reports `count: 0` for a `draft` target, so a request to transition
    // *into* `draft` — which `transitionClassSchema` (`schemas.ts`, whose
    // `z.enum` still lists `'draft'`) does
    // accept as a target — is always refused, and the row is left untouched.
    expect(sourceStatesFor('draft')).toEqual([]);
  });

  it('open is reachable only from draft', () => {
    expect(sourceStatesFor('open')).toEqual(['draft']);
  });

  it('in_progress is reachable only from open', () => {
    expect(sourceStatesFor('in_progress')).toEqual(['open']);
  });

  it('completed is reachable only from in_progress', () => {
    expect(sourceStatesFor('completed')).toEqual(['in_progress']);
  });

  it('cancelled is reachable from draft and open', () => {
    expect(sourceStatesFor('cancelled')).toEqual(['draft', 'open']);
  });
});

describe('isEconomicFieldLocked', () => {
  it('returns true when settingsLocked is true', () => {
    expect(isEconomicFieldLocked(true)).toBe(true);
  });

  it('returns false when settingsLocked is false', () => {
    expect(isEconomicFieldLocked(false)).toBe(false);
  });
});

describe('ECONOMIC_FIELDS', () => {
  it('contains exactly the 5 economic fields', () => {
    expect(ECONOMIC_FIELDS).toEqual([
      'roomCost',
      'minRate',
      'targetRate',
      'minStudents',
      'maxStudents',
    ]);
  });

  it('is readonly (frozen)', () => {
    expect(Object.isFrozen(ECONOMIC_FIELDS)).toBe(true);
  });
});

// ===========================================================================
// Integration tests — DB operations
// ===========================================================================

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

describe('transitionClass (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Transition',
        lastName: 'Teacher',
        email: `transition-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `transition-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Test teacher for transition tests',
        pageSlug: `transition-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Transition Studio',
        address: `${uniqueSuffix} Transition St`,
        city: 'Amsterdam',
        postcode: '1234AB',
        floor: '1',
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
    // Clean up all classes created during tests, then fixtures
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('transitions draft to open', async () => {
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2026-06-01'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'draft',
      },
    });

    const result = await transitionClass(prisma, cls.id, 'open');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newStatus).toBe('open');
    }

    const updated = await prisma.class.findUnique({ where: { id: cls.id } });
    expect(updated?.status).toBe('open');
  });

  it('rejects invalid transition (draft to completed)', async () => {
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2026-06-02'),
        startTime: '10:00',
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'draft',
      },
    });

    const result = await transitionClass(prisma, cls.id, 'completed');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('draft');
      expect(result.error).toContain('completed');
    }

    const unchanged = await prisma.class.findUnique({ where: { id: cls.id } });
    expect(unchanged?.status).toBe('draft');
  });

  it('returns error for non-existent class', async () => {
    const result = await transitionClass(prisma, 'non-existent-id', 'open');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not found');
    }
  });

  /**
   * Two sequential statements in one test body cannot pin a race by
   * themselves: cancelling the row *before* calling `transitionClass` just
   * gives a read-then-write implementation a fresh row to read, and it
   * correctly refuses too — proven by running this test against the
   * pre-fix body, which also passes it. What a real interleaving requires is
   * a caller whose *read* is already stale by the time it decides, which a
   * sequential test cannot produce without interposing on the read itself.
   *
   * So the row is genuinely cancelled up front, and then the read
   * `transitionClass` performs is hooked to keep reporting `open` regardless
   * — standing in for a read taken before the cancel committed. A
   * read-then-write implementation trusts that lie and writes `in_progress`
   * straight over the real `cancelled` row via a plain `update`, which this
   * hook does not intercept. The CAS's `updateMany` predicate, by contrast,
   * is evaluated by Postgres against the real row at write time, independent
   * of anything any `SELECT` reported — so it is the write itself that has
   * to refuse here, not a second read noticing the row moved.
   */
  it('refuses to write over a status that changed after the caller decided', async () => {
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2026-06-03'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'open',
      },
    });

    await prisma.class.updateMany({
      where: { id: cls.id, status: 'open' },
      data: { status: 'cancelled' },
    });

    // Cast for the same reason as the interposition tests in
    // `class-template-lifecycle.test.ts`'s `updateClassTemplate`,
    // `archiveOrUnarchiveTemplate`, and `pauseOrResumeTemplate` blocks, and
    // `invitations.revive.test.ts` (`:99`): `$extends` returns a client
    // missing `$on`, so it is not assignable to `transitionClass`'s
    // `PrismaClient`-typed `db` parameter even though every method it calls
    // here is the real one, running against the real database.
    const stale = prisma.$extends({
      query: {
        class: {
          async findUnique({ args, query }) {
            const row = await query(args);
            return row === null ? row : { ...row, status: 'open' as const };
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await transitionClass(stale, cls.id, 'in_progress');

    // Order matters for what a regression reports: checking the row first
    // means a read-then-write implementation's failure shows as the actual
    // overwrite ("expected 'in_progress' to be 'cancelled'"), not just a
    // wrong boolean.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.status).toBe('cancelled');

    // The error text is asserted, not just `ok === false`: after Task 8
    // lands a Postgres trigger, a bare `ok === false` would also be
    // satisfiable by the trigger throwing instead of by this CAS refusing —
    // `Concurrent modification` is this function's own vocabulary for
    // exactly this case (`updateMany` matched nothing, yet the read now
    // calls the move legal), not the trigger's.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Concurrent modification/);
  });

  it('reports a missing class differently from an illegal transition', async () => {
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2026-06-04'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'completed',
      },
    });

    const illegal = await transitionClass(prisma, cls.id, 'open');
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) expect(illegal.error).toMatch(/Invalid transition/);

    const missing = await transitionClass(prisma, 'no-such-class-id', 'open');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/Class not found/);
  });
});

describe('completeClass (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let classId: string;
  const studentIds: string[] = [];

  // For the lock tests below, which each need their own class rather than
  // sharing the fixture `classId` the other tests in this block mutate to
  // 'completed'. Mirrors `updateClass (DB)`'s `makeClass` closure — reuses
  // the shared teacher/room fixture from `beforeAll` instead of standing up
  // a fresh one per test.
  const makeClass = ({ status }: { status: ClassStatus }) =>
    prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Vinyasa',
        date: new Date('2026-06-01'),
        startTime: '18:00',
        durationMinutes: 75,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status,
        settingsLocked: true,
      },
    });

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Complete',
        lastName: 'Teacher',
        email: `complete-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `complete-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Test teacher for complete tests',
        pageSlug: `complete-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Complete Studio',
        address: `${uniqueSuffix} Complete St`,
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

    // Create the in_progress class
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Vinyasa',
        date: new Date('2026-06-01'),
        startTime: '18:00',
        durationMinutes: 75,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'in_progress',
        settingsLocked: true,
      },
    });
    classId = cls.id;

    // Create 5 students with tiers 1-5
    for (let i = 1; i <= 5; i++) {
      const student = await prisma.student.create({
        data: {
          firstName: `Student${i}`,
          lastName: 'Test',
          email: `student-${i}-${uniqueSuffix}@test.local`,
          incomeTier: i,
        },
      });
      studentIds.push(student.id);
    }

    // Create 4 'registered' registrations (tiers 1-4) and 1 'cancelled' (tier 5)
    for (let i = 0; i < 4; i++) {
      await prisma.registration.create({
        data: {
          classId,
          studentId: studentIds[i]!,
          status: 'registered',
          tierAtBooking: i + 1,
        },
      });
    }
    await prisma.registration.create({
      data: {
        classId,
        studentId: studentIds[4]!,
        status: 'cancelled',
        tierAtBooking: 5,
        cancelledAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    // Clean up in dependency order: payments → registrations → class → students → teacherRoom → room → teacher.
    // Filtered by teacherId, not just the fixed `classId`, so this also
    // catches the extra classes `makeClass` creates in the lock tests below.
    await prisma.payment.deleteMany({
      where: { registration: { class: { teacherId } } },
    });
    await prisma.registration.deleteMany({ where: { class: { teacherId } } });
    await prisma.class.deleteMany({ where: { teacherId } });
    for (const sid of studentIds) {
      await prisma.student.delete({ where: { id: sid } });
    }
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('calculates pricing and creates payments for charged registrations', async () => {
    const result = await completeClass(prisma, classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newStatus).toBe('completed');
    }

    // Verify class was updated
    const cls = await prisma.class.findUnique({ where: { id: classId } });
    expect(cls?.status).toBe('completed');
    expect(cls?.totalStudents).toBe(4);
    expect(cls?.effectiveTeacherRate).not.toBeNull();
    expect(cls?.totalRevenue).not.toBeNull();

    // Verify charged registrations have price and tierRatio set
    const chargedRegs = await prisma.registration.findMany({
      where: { classId, status: { not: 'cancelled' } },
      orderBy: { tierAtBooking: 'asc' },
    });
    expect(chargedRegs).toHaveLength(4);
    for (const reg of chargedRegs) {
      expect(reg.price).not.toBeNull();
      expect(reg.tierRatio).not.toBeNull();
      expect(Number(reg.price)).toBeGreaterThan(0);
    }

    // Verify cancelled registration has no price
    const cancelledReg = await prisma.registration.findFirst({
      where: { classId, status: 'cancelled' },
    });
    expect(cancelledReg?.price).toBeNull();

    // Verify 4 Payment records exist
    const payments = await prisma.payment.findMany({
      where: { registration: { classId } },
    });
    expect(payments).toHaveLength(4);
    for (const payment of payments) {
      expect(payment.status).toBe('pending');
      expect(Number(payment.amount)).toBeGreaterThan(0);
    }

    // Verify each charged student received a payment-request notification
    // carrying their exact price, and the teacher got a summary.
    const studentNotes = await prisma.notification.findMany({
      where: { relatedClassId: classId, recipientType: 'student', type: 'payment_request' },
    });
    expect(studentNotes).toHaveLength(4);
    for (const reg of chargedRegs) {
      const note = studentNotes.find((n) => n.recipientId === reg.studentId);
      expect(note).toBeDefined();
      expect(note!.body).toContain(`€${Number(reg.price).toFixed(2)}`);
    }

    const teacherNote = await prisma.notification.findFirst({
      where: { relatedClassId: classId, recipientType: 'teacher', type: 'payment_request' },
    });
    expect(teacherNote).not.toBeNull();

    await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
  });

  it('returns error for non-existent class', async () => {
    const result = await completeClass(prisma, 'non-existent-id');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not found');
    }
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
        await tx.class.updateMany({
          where: { id: cls.id, status: 'in_progress' },
          data: { status: 'cancelled' },
        });
        holderFinishedWork = true;
      },
      { timeout: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 150));

    const completingResult = completeClass(prisma, cls.id);
    const completing = completingResult.then(() => 'returned' as const);
    const outcome = await Promise.race([
      completing,
      new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 400)),
    ]);

    expect(outcome).toBe('waiting');
    expect(holderFinishedWork).toBe(false);

    await holder;
    const result = await completingResult;

    // Without the lock, this reads 'in_progress' — the value that was
    // current before the wait began — and reports success, having already
    // clobbered the holder's cancellation on the way out.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Invalid transition/);

    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.status).toBe('cancelled');

    // The registration was never priced and no Payment exists — the
    // pricing engine never ran, because the refusal happened before
    // `completeClass` got past its own status gate.
    const reg = await prisma.registration.findFirstOrThrow({ where: { classId: cls.id } });
    expect(reg.price).toBeNull();
    expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(0);
  });

  /**
   * The refusal's SHAPE is the assertion, not the absence of Payment rows.
   * After the terminality trigger lands (Task 8), "no Payment rows" is
   * satisfied by the trigger alone and would no longer prove this lock.
   *
   * Renamed from 'refuses cleanly when the class was cancelled while it
   * waited' — nothing here waits or races; the cancel is a plain,
   * already-committed update issued before `completeClass` is even called.
   * What this actually pins is `completeClass`'s own status gate (the
   * `validateTransition` call, not the lock this file is otherwise about).
   * Mutating that gate to a no-op fails this test — and, an earlier version
   * of this comment claimed, ONLY this test in the whole suite. That was
   * wrong: re-measured across all 592 unit tests, two fail, both in this
   * file. The other is "decides from the class row the holder left behind,
   * not from a read taken before the wait" immediately above, whose own
   * refusal also comes from this gate — it asserts the refusal's shape
   * precisely because "no Payment rows" would be satisfied by the terminality
   * trigger alone. So the gate is not uniquely pinned here; what IS unique
   * here is that this is the only one of the two that reaches it without any
   * concurrency at all.
   */
  it('refuses to complete a class that is already cancelled', async () => {
    const cls = await makeClass({ status: 'in_progress' });
    await prisma.class.updateMany({
      where: { id: cls.id, status: 'in_progress' },
      data: { status: 'cancelled' },
    });

    const result = await completeClass(prisma, cls.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Invalid transition/);
    expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(0);
  });
});

// ===========================================================================

describe('completeClass — billing path throws rather than mis-charging a bypassed tier', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let studentId: string;
  let classId: string;
  let registrationId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'BadTier',
        lastName: 'Teacher',
        email: `bad-tier-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `bad-tier-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Test teacher for the bypassed-constraint billing test',
        pageSlug: `bad-tier-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Bad Tier Studio',
        address: `${uniqueSuffix} Bad Tier St`,
        city: 'Amsterdam',
        postcode: '1357BT',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 10,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 8, rentalRate: 15 },
    });
    teacherRoomId = teacherRoom.id;

    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Bad Tier Flow',
        date: new Date('2026-06-01'),
        startTime: '18:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: 'in_progress',
        settingsLocked: true,
      },
    });
    classId = cls.id;

    const student = await prisma.student.create({
      data: {
        firstName: 'Bad',
        lastName: 'Tier',
        email: `bad-tier-student-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    studentId = student.id;

    const registration = await prisma.registration.create({
      data: { classId, studentId, status: 'registered', tierAtBooking: 3 },
    });
    registrationId = registration.id;
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { registration: { classId } } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.class.delete({ where: { id: classId } });
    await prisma.student.delete({ where: { id: studentId } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('rejects and rolls back a class completion when a registration carries a tier outside 1-5', async () => {
    // This engineers a state the type system AND the database's CHECK
    // constraint both say is impossible: `tierAtBooking` outside 1-5. It can
    // only be reached here by dropping the constraint out from under Prisma
    // with raw SQL. That is deliberate — this test is the only thing standing
    // between a one-word edit (reverting `completeClass`'s
    // `toIncomeTierOrThrow` call to `toIncomeTier`) and a silent mis-charge:
    // without it, completeClass would degrade the bad tier to
    // DEFAULT_INCOME_TIER and bill the student at the wrong price with
    // nothing anywhere to fail.
    //
    // The constraint drop must be committed before completeClass runs its own
    // transaction: completeClass opens its own `db.$transaction`, so a drop
    // issued inside some other interactive transaction here would not be
    // visible to it. Issuing it directly against `prisma` (no wrapping
    // transaction) commits it immediately.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Registration" DROP CONSTRAINT "Registration_tier_at_booking_check"`,
    );
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "Registration" SET "tierAtBooking" = 0 WHERE id = $1`,
        registrationId,
      );

      await expect(completeClass(prisma, classId)).rejects.toThrow(/outside 1-5/);

      // The transaction rolled back — the class must not have completed.
      const cls = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
      expect(cls.status).not.toBe('completed');
    } finally {
      // Restoring here, rather than after the assertions above, means a
      // failure in those assertions still leaves the database with its
      // constraint intact for every other test that depends on it.
      await prisma.$executeRawUnsafe(
        `UPDATE "Registration" SET "tierAtBooking" = 3 WHERE id = $1`,
        registrationId,
      );
      // Copied verbatim from
      // prisma/migrations/20260802150845_income_tier_range_check/migration.sql
      // rather than retyped, so a restored constraint can never drift from
      // the one the migration actually defines.
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "Registration" ADD CONSTRAINT "Registration_tier_at_booking_check"
  CHECK ("tierAtBooking" BETWEEN 1 AND 5)`,
      );
    }
  });
});

// ===========================================================================

describe('updateClass (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;

  // `settingsLocked` is written directly here because it is an INPUT
  // precondition for this function, not the behaviour under test. The genuine
  // flip — a real registration setting it — is covered by
  // registrations-api's `locks settings atomically with the first
  // registration`. Do not copy this shortcut into a test that claims to cover
  // the flip itself.
  const makeClass = (settingsLocked: boolean) =>
    prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2026-06-01'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'draft',
        settingsLocked,
      },
    });

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Update',
        lastName: 'Teacher',
        email: `update-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `update-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Test teacher for updateClass tests',
        pageSlug: `update-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Update Studio',
        address: `${uniqueSuffix} Update St`,
        city: 'Amsterdam',
        postcode: '1234AB',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 35 },
    });
    teacherRoomId = teacherRoom.id;
  });

  afterAll(async () => {
    // Guarded: an undefined filter turns deleteMany into an unfiltered
    // delete-all across the table.
    if (teacherId) {
      await prisma.class.deleteMany({ where: { teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    }
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('returns not_found for an unknown class', async () => {
    const result = await updateClass(prisma, 'non-existent-id', { classType: 'Vinyasa' });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('applies a non-economic edit to an unlocked class', async () => {
    const cls = await makeClass(false);

    const result = await updateClass(prisma, cls.id, { description: 'Updated' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cls.description).toBe('Updated');

    const stored = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(stored.description).toBe('Updated');
  });

  it('applies an economic edit to an unlocked class', async () => {
    const cls = await makeClass(false);

    const result = await updateClass(prisma, cls.id, {
      roomCost: 42,
      minRate: 5,
      targetRate: 60,
      minStudents: 2,
      maxStudents: 20,
    });
    expect(result.ok).toBe(true);

    // Every economic field, not a sample: these are the pricing engine's
    // inputs, and stripping any one of them from the write used to leave this
    // suite green.
    const stored = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(Number(stored.roomCost)).toBe(42);
    expect(Number(stored.minRate)).toBe(5);
    expect(Number(stored.targetRate)).toBe(60);
    expect(stored.minStudents).toBe(2);
    expect(stored.maxStudents).toBe(20);
  });

  it('applies the non-economic fields, including clearing description to null', async () => {
    const cls = await makeClass(false);
    await prisma.class.update({ where: { id: cls.id }, data: { description: 'Set first' } });

    const result = await updateClass(prisma, cls.id, {
      classType: 'Vinyasa',
      startTime: '18:30',
      durationMinutes: 75,
      description: null,
      date: new Date('2027-03-09'),
    });
    expect(result.ok).toBe(true);

    const stored = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(stored.classType).toBe('Vinyasa');
    expect(stored.startTime).toBe('18:30');
    expect(stored.durationMinutes).toBe(75);
    expect(stored.description).toBeNull();
    // Compared as a date string, not with toEqual, so timezone handling on
    // this @db.Date column can't produce a false pass or fail around midnight.
    expect(stored.date.toISOString().slice(0, 10)).toBe('2027-03-09');
  });

  it('rejects an economic edit to a locked class, naming the fields sent', async () => {
    const cls = await makeClass(true);

    // Sent in the reverse of ECONOMIC_FIELDS' own declaration order, so the
    // returned tuple's ordering is shown to come from the constant rather
    // than from the caller.
    const result = await updateClass(prisma, cls.id, { minRate: 1, roomCost: 999 });
    expect(result).toEqual({ ok: false, reason: 'locked', fields: ['roomCost', 'minRate'] });

    const stored = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(Number(stored.roomCost)).toBe(35);
    expect(Number(stored.minRate)).toBe(15);
  });

  it('allows a non-economic edit to a locked class — the lock is scoped to economics', async () => {
    const cls = await makeClass(true);

    const result = await updateClass(prisma, cls.id, { description: 'Still editable' });
    expect(result.ok).toBe(true);

    const stored = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(stored.description).toBe('Still editable');
    expect(Number(stored.roomCost)).toBe(35);
  });

  it('rejects a mixed economic + non-economic body atomically', async () => {
    const cls = await makeClass(true);

    const result = await updateClass(prisma, cls.id, { description: 'x', roomCost: 999 });
    expect(result).toEqual({ ok: false, reason: 'locked', fields: ['roomCost'] });

    const stored = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(stored.description).toBeNull();
    expect(Number(stored.roomCost)).toBe(35);
  });

  it('returns no_fields for an empty body', async () => {
    const cls = await makeClass(false);

    const result = await updateClass(prisma, cls.id, {});
    expect(result).toEqual({ ok: false, reason: 'no_fields' });
  });

  it('treats an all-undefined payload as no edit, not as a vanished row', async () => {
    const cls = await makeClass(false);

    // Prisma issues no UPDATE at all for a data object whose every value is
    // undefined, returning { count: 0 } regardless of the row's existence.
    // Before this was handled, that zero count was read as "the row vanished"
    // and — with no economic fields to blame — reached an invariant throw,
    // surfacing as a 500 for a request that asked for nothing.
    const result = await updateClass(prisma, cls.id, { description: undefined });
    expect(result).toEqual({ ok: false, reason: 'no_fields' });
  });
});

describe('updateClass — the count === 0 branches', () => {
  // Reaching `count === 0` needs the row to change between updateClass's read
  // and its write. Against a real database that is a genuine race with no
  // deterministic trigger — which is why #72's wrong status shipped unnoticed.
  //
  // The stub RECORDS what it was called with. That matters: a stub that only
  // returns `{ count: 0 }` proves the classification is right while proving
  // nothing about the query that produced it — with such a stub, deleting the
  // `settingsLocked: false` guard from the compare-and-swap left every test
  // passing.
  type UpdateManyArgs = { where: Record<string, unknown>; data: Record<string, unknown> };

  function stubDb(opts: { settingsLocked: boolean; rowSurvives: boolean }) {
    const updateManyCalls: UpdateManyArgs[] = [];
    let reads = 0;
    const db = {
      class: {
        findUnique: async () => {
          reads += 1;
          // Read 1 (updateClass's opening read) always reports the locked
          // flag; every read after that reports current existence. The stub
          // only distinguishes first from rest — it does not itself enforce
          // that there are exactly two; `reads` below lets a test pin that.
          if (reads === 1) return { id: 'stub-class', settingsLocked: opts.settingsLocked };
          return opts.rowSurvives ? { id: 'stub-class' } : null;
        },
        updateMany: async (args: UpdateManyArgs) => {
          updateManyCalls.push(args);
          return { count: 0 };
        },
        findUniqueOrThrow: async () => {
          throw new Error('findUniqueOrThrow must not be reached when count === 0');
        },
      },
    } as unknown as PrismaClient;
    // A getter, not a snapshot: it must read the live `reads` closure
    // variable at assertion time, after updateClass has run.
    return { db, updateManyCalls, get reads() { return reads; } };
  }

  it('reports locked when the row survives — the compare-and-swap lost its race', async () => {
    const stub = stubDb({ settingsLocked: false, rowSurvives: true });
    const { db, updateManyCalls } = stub;

    const result = await updateClass(db, 'stub-class', { roomCost: 42 });
    expect(result).toEqual({ ok: false, reason: 'locked', fields: ['roomCost'] });

    // Proves the CAS path actually ran rather than the early lock-check, which
    // returns an identical value and would otherwise be indistinguishable —
    // and pins the guard whose removal this suite previously did not notice.
    expect(updateManyCalls).toHaveLength(1);
    expect(updateManyCalls[0]?.where).toEqual({ id: 'stub-class', settingsLocked: false });

    // Exactly the opening read plus one re-check — a spurious third
    // `findUnique` would be invisible to every other assertion here. Read via
    // `stub.reads`, not a destructured copy, because a getter destructured
    // before `updateClass` runs captures its value at that instant (0), not
    // the live count.
    expect(stub.reads).toBe(2);
  });

  it('reports not_found when economic fields were sent but the row is gone', async () => {
    // The Critical finding from PR #78's review: this combination used to be
    // reported as `locked`, naming a plausible field, for a class that had
    // actually been deleted mid-request.
    const { db } = stubDb({ settingsLocked: false, rowSurvives: false });

    const result = await updateClass(db, 'stub-class', { roomCost: 42 });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('reports not_found when no economic field was sent — the row was deleted (#72)', async () => {
    // The originally-filed bug. Before the fix this returned the `locked`
    // reason with an empty field list, rendered as
    // "Cannot update economic fields when settings are locked: " with a 409.
    const stub = stubDb({ settingsLocked: false, rowSurvives: false });
    const { db, updateManyCalls } = stub;

    const result = await updateClass(db, 'stub-class', { description: 'x' });
    expect(result).toEqual({ ok: false, reason: 'not_found' });

    // No economic fields sent, so the filter must NOT constrain settingsLocked.
    expect(updateManyCalls[0]?.where).toEqual({ id: 'stub-class' });

    // Exactly the opening read plus one re-check — a spurious third
    // `findUnique` would be invisible to every other assertion here. Read via
    // `stub.reads`, not a destructured copy — see the comment in the case above.
    expect(stub.reads).toBe(2);
  });

  it('answers a visibly-locked row from the read, without attempting the write', async () => {
    const { db, updateManyCalls } = stubDb({ settingsLocked: true, rowSurvives: true });

    const result = await updateClass(db, 'stub-class', { roomCost: 42 });
    expect(result).toEqual({ ok: false, reason: 'locked', fields: ['roomCost'] });

    // The point of this case: the pre-check answered it. Deleting that check
    // leaves the result identical (the compare-and-swap re-derives it), so
    // only the absence of a write attempt distinguishes the two.
    expect(updateManyCalls).toHaveLength(0);
  });

  it('throws rather than guessing when a zero count contradicts a surviving row', async () => {
    const { db } = stubDb({ settingsLocked: false, rowSurvives: true });

    // Only the stub can produce this: a real Prisma UPDATE with a defined
    // value cannot report zero matches for a row that still exists. Pinned
    // because the alternative — inventing a plausible reason — is the exact
    // defect #72 was filed for.
    await expect(updateClass(db, 'stub-class', { description: 'x' }))
      .rejects.toThrow(UpdateClassInvariantError);
  });
});

describe("updateClass's non-empty tuple guarantee", () => {
  it('depends on noUncheckedIndexedAccess, which is pinned here', () => {
    const [first] = [] as EconomicField[];
    // @ts-expect-error `first` is `EconomicField | undefined` under
    // noUncheckedIndexedAccess (tsconfig.json). If that flag is ever relaxed
    // this assignment stops erroring, this directive becomes the error, and
    // the build tells us — instead of updateClass's "proven, not asserted"
    // narrowing quietly becoming a no-op.
    const pinned: EconomicField = first;
    expect(pinned).toBeUndefined();
  });
});
