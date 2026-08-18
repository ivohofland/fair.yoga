import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, ClassStatus } from '@prisma/client';
import { classStartInstant } from '@/lib/timezone';
import {
  VALID_TRANSITIONS,
  TERMINAL_CLASS_STATUSES,
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

/**
 * `CompletionTiming` is REQUIRED, and this is what enforces it.
 *
 * The union's whole argument is that silence must not mean "skip the clock" —
 * but a default (`timing: CompletionTiming = { finishedEarly: true }`) restores
 * exactly that and passes `tsc` and every runtime test, because no call site
 * omits the argument. Only an unused `@ts-expect-error` can catch it: this
 * function is never called, and `tsconfig.json` includes every `.ts` in the
 * repo, so weakening the signature fails the build on this line rather than
 * leaving a green suite. Same instrument, same reason, as
 * `_theBrandRejectsABareClient` in `lib/db-locks.test.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _completionTimingIsRequired(db: PrismaClient): Promise<void> {
  // @ts-expect-error Omitting the timing must never mean "do not check the clock".
  await completeClass(db, 'never-called');
}

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

/**
 * Turns a running total-minutes-from-9am into a valid `HH:MM`, wrapping into
 * the next hour rather than ever emitting an invalid minute like `'09:60'`
 * once a block's fixture counter crosses 30. `startTime` is a plain `String`
 * with no CHECK constraint, occupancy is string equality, and
 * `Class_teacher_slot_unique` compares strings too — so a raw `HH:${counter}`
 * literal would accept an out-of-range value silently instead of exercising
 * the constraint a fixture counter exists to dodge collisions with. Both
 * blocks below use it, one at a `9 + n` hour offset (`slotTime(counter)`
 * itself), the other at an `18:xx` offset (`slotTime(540 + counter)`) so
 * neither counter's values can ever land in the other's hour. Mirrors
 * `class-template-lifecycle.test.ts`'s `slotTime`.
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

describe('transitionClass (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let studentId: string;

  // Per-test classes for the queue-close tests below (#216) — a date none of
  // the four hand-written tests above use, so the counter-derived startTime
  // only has to avoid colliding with itself across the two calls in this
   // describe, not with those tests' literal '09:00'/'10:00' slots. Mirrors
   // `completeClass (DB)`'s own `makeClass` below.
  /**
   * 2099, not "a couple of months out". #249's publish guard reads the clock,
   * so a fixture dated in what was the future when it was written fails once
   * enough time passes. These were `2026-06-0X` and had already aged into the
   * past by the time that guard was added.
   */
  let makeClassCounter = 0;
  const makeClass = ({ status }: { status: ClassStatus }) => {
    makeClassCounter += 1;
    return prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Vinyasa',
        date: new Date('2099-06-05'),
        startTime: slotTime(makeClassCounter),
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status,
      },
    });
  };

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

    // Needed by the queue-close tests below (#216), which put a waiting
    // WaitlistEntry under a class this block owns — hoisted here rather than
    // created inline, per this file's fixture rule.
    const student = await prisma.student.create({
      data: {
        firstName: 'Transition',
        lastName: 'Student',
        email: `transition-student-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    studentId = student.id;
  });

  afterAll(async () => {
    // Not because it blocks `class.deleteMany`: `WaitlistEntry.class` is
    // `onDelete: Cascade` (`prisma/schema.prisma:575`), so a waitlist row
    // disappears with its class whether or not this line ever runs. What
    // actually blocks teardown is the surviving `Class` row itself, via the
    // plain `Class.teacherRoomId` FK — `class.deleteMany` below has to run
    // before `teacherRoom.deleteMany`/`room.delete` further down, or those
    // fail on the FK instead. Kept anyway: harmless, and mildly defensive.
    // Same shape as `completeClass (DB)`'s afterAll below and
    // `addToWaitlist + removeFromWaitlist (DB)`'s in waitlist.test.ts.
    await prisma.waitlistEntry.deleteMany({ where: { class: { teacherId } } });
    // Clean up all classes created during tests, then fixtures
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.student.delete({ where: { id: studentId } });
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
        date: new Date('2099-06-01'),
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
    // Also #249's fall-through: this class is dated in the past AND targeted at
    // `open`, so a publish guard that refused instead of falling through would
    // answer STARTS_IN_PAST here. Its fixture stays past-dated for that reason.
    if (!illegal.ok) expect(illegal.error).toMatch(/Invalid transition/);

    const missing = await transitionClass(prisma, 'no-such-class-id', 'open');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/Class not found/);
  });

  it('closes the waitlist when it moves a class to in_progress', async () => {
    const cls = await makeClass({ status: 'open' });
    const entry = await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId, position: 1, status: 'waiting' },
    });

    const result = await transitionClass(prisma, cls.id, 'in_progress');
    expect(result.ok).toBe(true);

    const after = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after.status).toBe('expired');
  });

  it('leaves the waitlist alone when it moves a class to open', async () => {
    // The close is predicated on the TARGET, not on "any successful CAS".
    // Without that predicate this row would be expired by a draft -> open
    // publish, which is the opposite of what the queue means.
    const cls = await makeClass({ status: 'draft' });
    const entry = await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId, position: 1, status: 'waiting' },
    });

    const result = await transitionClass(prisma, cls.id, 'open');
    expect(result.ok).toBe(true);

    const after = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after.status).toBe('waiting');
  });

  it('refuses to publish a draft whose start has already passed (#249)', async () => {
    // No typo needed for this one — a draft written for last Friday and
    // published the following week is enough. `transitionClass` had no date
    // predicate at all before #249.
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Vinyasa',
        date: new Date('2020-01-01'),
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
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('STARTS_IN_PAST');

    // Refused means not written.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.status).toBe('draft');
  });

  it('still starts an open class whose time has come (#249)', async () => {
    // The target conjunct. `open -> in_progress` is a class starting, so its
    // start instant being in the past is not merely allowed, it is the whole
    // precondition. A guard that fired on every target would stop every class
    // in the product from ever starting.
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Vinyasa',
        date: new Date('2020-01-01'),
        startTime: '10:00',
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'open',
      },
    });

    const result = await transitionClass(prisma, cls.id, 'in_progress');
    expect(result.ok).toBe(true);
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
  // Counter-derived startTime: the beforeAll below plants a class at
  // 18:00 for this same teacher/date, and both call sites in this block
  // (the lock test and the already-cancelled test) need their own slot too
  // — under Class_teacher_slot_unique none of these tests read or assert
  // the literal startTime, only the id, so a distinct minute per call is
  // enough to keep every create legal without touching any assertion.
  // Routed through the module-level `slotTime` at an `18:xx` offset
  // (`slotTime(540 + counter)`) rather than a raw `18:${counter}` literal.
  let makeClassCounter = 0;
  const makeClass = ({ status }: { status: ClassStatus }) => {
    makeClassCounter += 1;
    return prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Vinyasa',
        date: new Date('2026-06-01'),
        startTime: slotTime(540 + makeClassCounter),
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
  };

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
    // Clean up in dependency order: waitlist entries → payments → registrations → class → students → teacherRoom → room → teacher.
    // Filtered by teacherId, not just the fixed `classId`, so this also
    // catches the extra classes `makeClass` creates in the lock tests below.
    // Not because it blocks `class.deleteMany`: `WaitlistEntry.class` is
    // `onDelete: Cascade` (`prisma/schema.prisma:575`), so a waitlist row
    // disappears with its class whether or not this line ever runs. What
    // actually blocks teardown is the surviving `Class` row itself, via the
    // plain `Class.teacherRoomId` FK — `class.deleteMany` below has to run
    // before `teacherRoom.delete` further down, or that fails on the FK
    // instead. Kept anyway: harmless, and mildly defensive.
    await prisma.waitlistEntry.deleteMany({ where: { class: { teacherId } } });
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
    const result = await completeClass(prisma, classId, { finishedEarly: true });
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
    const result = await completeClass(prisma, 'non-existent-id', { finishedEarly: true });
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

    const result = await completeClass(prisma, cls.id, { finishedEarly: true });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Invalid transition/);
    expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(0);
  });

  it('closes the waitlist when a teacher completes an open class directly', async () => {
    const cls = await makeClass({ status: 'open' });
    await prisma.registration.create({
      data: { classId: cls.id, studentId: studentIds[0]!, status: 'registered', tierAtBooking: 3 },
    });
    const entry = await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: studentIds[1]!, position: 1, status: 'waiting' },
    });

    const result = await completeClass(prisma, cls.id, { finishedEarly: true });
    expect(result.ok).toBe(true);

    const after = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
    // `expired`, not `removed`: this student never got in, they did not leave.
    expect(after.status).toBe('expired');
  });

  it('refuses to complete a class that has not ended when requireEndedBy is given', async () => {
    const cls = await makeClass({ status: 'in_progress' });
    // This block's `makeClass` plants the class on 2026-06-01 at
    // `slotTime(540 + counter)` — 18:01, 18:02, … — for 75 minutes, teacher
    // timezone Europe/Amsterdam (schema default). June is CEST, so 18:01
    // local is 16:01Z and the class ends at 17:16Z. The counter makes the
    // exact minute depend on how many tests in this block called
    // `makeClass` first, so this instant is safely inside the class for ANY
    // counter value rather than derived from a specific start.
    const result = await completeClass(prisma, cls.id, {
      requireEndedBy: new Date('2026-06-01T16:30:00Z'),
    });
    expect(result.ok).toBe(false);
    // The REASON, not the message. `autoCompleteClasses` branches on this value
    // to downgrade exactly this refusal to `log.warn`; `error` beside it is free
    // text for humans and nothing may branch on it. The previous version of this
    // assertion checked the message with `toContain` while the sweep matched it
    // with `endsWith`, so appending anything to the producer's message kept this
    // green and silently desynced the sweep.
    if (!result.ok) expect(result.reason).toBe('NOT_ENDED_YET');
    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('in_progress');
  });

  /**
   * The boundary itself. `requireEndedBy < end` refuses; `=== end` must
   * complete, because a class that has just reached its end time HAS ended and
   * the sweep runs on a 60-second tick that will land on that instant.
   * Flipping the comparison to `<=` survived the suite before this existed.
   *
   * The instant is computed from the row rather than written as a literal, for
   * the reason the sibling test above spells out: this block's `makeClass`
   * derives `startTime` from a counter, so a hardcoded time would pin the wrong
   * minute as soon as another test is added ahead of it.
   */
  /**
   * The `Number.isNaN` guard. An `Invalid Date` is truthy and every comparison
   * against it is false, so without this check a broken clock passes straight
   * through the timing guard and completes the class — writing `Payment` rows.
   * Deleting the check is otherwise green.
   */
  it('throws rather than completing when requireEndedBy is not a real date', async () => {
    const cls = await makeClass({ status: 'in_progress' });
    await expect(
      completeClass(prisma, cls.id, { requireEndedBy: new Date('not-a-date') }),
    ).rejects.toThrow(TypeError);

    const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(unchanged.status).toBe('in_progress');
  });

  it('completes a class at exactly its end instant, not one tick later', async () => {
    const cls = await makeClass({ status: 'in_progress' });
    const row = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    const start = classStartInstant(row.date, row.startTime, 'Europe/Amsterdam');
    const end = new Date(start.getTime() + row.durationMinutes * 60 * 1000);

    const result = await completeClass(prisma, cls.id, { requireEndedBy: end });
    expect(result.ok).toBe(true);

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('completed');
  });

  /**
   * The OTHER direction of the reschedule the guard exists to catch. Moving a
   * class LATER must block completion (the sibling above); moving it EARLIER
   * must not, because the class really has ended. Nothing pinned this, so a
   * future "improvement" that compared the absolute distance between the two
   * instants — rather than their order — would look correct and quietly refuse
   * to complete classes that finished early.
   */
  it('completes a class rescheduled EARLIER, where the guard must not fire', async () => {
    const cls = await makeClass({ status: 'in_progress' });
    await prisma.class.update({
      where: { id: cls.id },
      data: { date: new Date('2026-05-25') },
    });

    const result = await completeClass(prisma, cls.id, {
      requireEndedBy: new Date('2026-06-01T16:30:00Z'),
    });
    expect(result.ok).toBe(true);

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('completed');
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
   * tests are (`class-generator.test.ts`): the lower one proves it really
   * waited on the row rather than sailing through, the upper that it gave up on
   * the 2s bound rather than Prisma's 5s. Neither pins the bound's VALUE, which
   * belongs to `db-locks.ts`.
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
      await expect(transitionClass(prisma, cls.id, 'in_progress')).rejects.toThrow();
      const waited = Date.now() - startedAt;

      expect(waited).toBeGreaterThan(1_000);
      expect(waited).toBeLessThan(4_000);

      const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
      expect(unchanged.status).toBe('open');
    } finally {
      release();
      await holder;
    }
  }, 20_000);

  it('still completes early for a teacher, who passes no requireEndedBy', async () => {
    // The option is what makes the sweep strict; omitting it must NOT become
    // strict by default, or a teacher can no longer finish a class early.
    const cls = await makeClass({ status: 'in_progress' });
    const result = await completeClass(prisma, cls.id, { finishedEarly: true });
    expect(result.ok).toBe(true);
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

      await expect(
        completeClass(prisma, classId, { finishedEarly: true }),
      ).rejects.toThrow(/outside 1-5/);

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
  //
  // `status` (#247) is the same shortcut for the same reason: writing a
  // terminal status directly is an INPUT precondition for updateClass's own
  // guard, not the behaviour under test, and it bypasses `completeClass` /
  // `transitionClass` and the state machine's own transition guards entirely.
  // A test that claims to cover a class actually REACHING a terminal status —
  // as opposed to what updateClass does once it is already sitting in one —
  // needs to drive it through those, not through this fixture.
  // Counter-derived startTime: every test in this block shares one teacher and
  // one date, and none of them reads or asserts the created row's literal
  // startTime (the one test that changes it does so via an updateClass() call,
  // asserted against its new value, not this one) — so a distinct minute per
  // call is enough to keep every create legal under Class_teacher_slot_unique
  // without touching any assertion. Deliberately stated without a call count:
  // the previous wording named one ("8 times"), and #247 adding tests here
  // falsified it silently. Routed through the module-level `slotTime` rather
  // than a raw `09:${counter}` literal.
  let makeClassCounter = 0;
  /**
   * FAR-FUTURE ON PURPOSE, and it is not cosmetic.
   *
   * `autoCompleteClasses` sweeps `{ status: 'in_progress' }` GLOBALLY — no
   * teacher filter — and `class-transitions.test.ts`'s `'does not complete a
   * class rescheduled after the sweep read it'` asserts the global count is
   * 0 against a frozen clock of 2026-07-20. This block's `it.each` control
   * plants `in_progress` fixtures, so on the previous date of 2026-06-01 any
   * of them surviving an interrupted run (the `afterAll` cleans up, a killed
   * process does not) would fail a test in another file, in a way that
   * self-heals on the next run because the sweep consumes the leftover. That
   * is the shape of a flake that gets three sessions of investigation.
   *
   * A 2099 date is outside every sweep window, so a leftover is inert.
   */
  const FIXTURE_DATE = '2099-06-01';
  /**
   * #249 needs fixtures on both sides of "now". `FIXTURE_DATE` (2099) is the
   * default and stays the default; `PAST_FIXTURE_DATE` is unambiguously behind
   * every clock this suite will ever run under, so no test here needs an
   * injected `now`.
   */
  const PAST_FIXTURE_DATE = '2020-01-01';
  const makeClass = (
    settingsLocked: boolean,
    status: ClassStatus = 'draft',
    date: string = FIXTURE_DATE,
  ) => {
    makeClassCounter += 1;
    return prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date(date),
        startTime: slotTime(makeClassCounter),
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status,
        settingsLocked,
      },
    });
  };

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

  it('refuses a date edit on a completed class, and writes nothing (#247)', async () => {
    const cls = await makeClass(false, 'completed');

    const result = await updateClass(prisma, cls.id, { date: new Date('2020-01-01') });
    expect(result).toEqual({ ok: false, reason: 'terminal', status: 'completed' });

    // "Refused" has to mean "did not write". #247 is a data-loss issue: the
    // wrong date is what makes waitlist-retention's sweep delete this class's
    // unfulfilled queue, so a refusal that still moved the column would close
    // nothing.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.date.toISOString().slice(0, 10)).toBe(FIXTURE_DATE);
  });

  it('refuses a date edit on a cancelled class too', async () => {
    const cls = await makeClass(false, 'cancelled');

    const result = await updateClass(prisma, cls.id, { date: new Date('2020-01-01') });
    expect(result).toEqual({ ok: false, reason: 'terminal', status: 'cancelled' });

    // Same "did not write" check as the completed case above, and not
    // optional here either: `reapClosedWaitlistEntries` reaps a `cancelled`
    // class's queue too, not only a `completed` one, so a refuse-but-write bug
    // on this path is the identical data-loss shape as T1's.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.date.toISOString().slice(0, 10)).toBe(FIXTURE_DATE);
  });

  it('freezes the whole class, not a field list — a description edit is refused', async () => {
    const cls = await makeClass(false, 'completed');

    const result = await updateClass(prisma, cls.id, { description: 'Annotated afterwards' });
    expect(result).toEqual({ ok: false, reason: 'terminal', status: 'completed' });

    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.description).toBeNull();
  });

  it('refuses an economic edit on a completed class nobody booked', async () => {
    // settingsLocked is written by the FIRST REGISTRATION, so a class that
    // reached `completed` with no bookings still carries `false` and would
    // otherwise accept this edit — on a row whose totals completeClass has
    // already written. The economic lock and the terminal freeze gate on
    // different events; this is the gap between them.
    const cls = await makeClass(false, 'completed');

    const result = await updateClass(prisma, cls.id, { roomCost: 999 });
    expect(result).toEqual({ ok: false, reason: 'terminal', status: 'completed' });

    // Cheap and consistent with T1/T2: assert the economic column did not move.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(Number(after.roomCost)).toBe(35);
  });

  it('reports terminal, not locked, when the class is both', async () => {
    // Pins the ORDER of the two early checks. Neither freeze lifts, so "which
    // one lifts" cannot be the tiebreak — `updateClass`'s docblock owns that
    // argument and an earlier copy of it here got it wrong, which is why this
    // one cites rather than restates. SCOPE is the tiebreak, and the
    // consequence is what belongs in a test comment: `locked` reports the
    // refusal as being about economic fields when every field is refused, so a
    // teacher told "locked: roomCost" reasonably retries with a `description`
    // edit, which also fails. `terminal` is the answer that does not invite a
    // wrong retry.
    const cls = await makeClass(true, 'completed');

    const result = await updateClass(prisma, cls.id, { roomCost: 999 });
    expect(result).toEqual({ ok: false, reason: 'terminal', status: 'completed' });

    // Cheap and consistent with T1/T2/T4: assert the economic column did not
    // move — under either refusal reason this class would refuse the write,
    // but only `terminal` is the true one here.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(Number(after.roomCost)).toBe(35);
  });

  it('refuses a date edit that moves a live class into the past (#249)', async () => {
    const cls = await makeClass(false, 'open');

    const result = await updateClass(prisma, cls.id, { date: new Date('2020-01-01') });
    expect(result).toEqual({ ok: false, reason: 'past_start' });

    // "Refused" has to mean "did not write" — the same assertion #247's tests
    // make, for the same reason. A refusal that still moved the column is what
    // leaves `waitlist-retention`'s sweep a class dated 2020 to reap, and the
    // sweep is a `deleteMany`.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.date.toISOString().slice(0, 10)).toBe(FIXTURE_DATE);
  });

  it('leaves a non-scheduling edit alone on a class that has already started (#249)', async () => {
    // The conjunct test. An `open` class whose start has passed is a state the
    // system legitimately produces — the generator makes one every time it runs
    // after a template's own weekday start time, and every class is in it for
    // up to the 60 seconds before the transition sweep. Editing its description
    // must stay legal; only a write that MOVES the start is refused.
    const cls = await makeClass(false, 'open', PAST_FIXTURE_DATE);

    const result = await updateClass(prisma, cls.id, { description: 'Updated' });
    expect(result.ok).toBe(true);
  });

  it('checks a startTime-only edit against the stored date (#249)', async () => {
    // The other conjunct. The obvious wrong guard fires only when `date` is
    // sent; this class's date is already past, so moving only its startTime
    // still lands in the past and must still be refused.
    const cls = await makeClass(false, 'open', PAST_FIXTURE_DATE);

    const result = await updateClass(prisma, cls.id, { startTime: '10:00' });
    expect(result).toEqual({ ok: false, reason: 'past_start' });

    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.startTime).not.toBe('10:00');
  });

  /**
   * Derived, not listed. `class-terminal-date.test.ts` builds the same control
   * set as the enum minus the terminal constant and says in its own docblock
   * that this literal is the inferior version it is mirroring — so the two
   * shapes shipped side by side. A literal generates the same three cases
   * today and silently generates the wrong ones tomorrow: add a status to the
   * enum and it is never exercised; move one INTO the terminal set and the
   * literal keeps asserting that a now-frozen class still updates.
   */
  const NON_TERMINAL_STATUSES = Object.values(ClassStatus).filter(
    (s) => !TERMINAL_CLASS_STATUSES.includes(s),
  );

  it.each(NON_TERMINAL_STATUSES)(
    'still updates a %s class — the freeze starts at terminality, not at "not editable in the UI"',
    async (status) => {
      // `in_progress` is here deliberately. The teacher edit page redirects
      // away from it, but the API allows it and should: the retention sweep
      // reads only terminal classes, and completeClass's `requireEndedBy`
      // already handles a class rescheduled out from under a completion.
      // Without this case a mutation that froze `in_progress` too would pass
      // every other test in this file.
      const cls = await makeClass(false, status);

      const result = await updateClass(prisma, cls.id, { description: `Edited while ${status}` });
      expect(result.ok).toBe(true);

      const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
      expect(after.description).toBe(`Edited while ${status}`);
    },
  );

  /**
   * THE COMPARE-AND-SWAP, AGAINST A REAL DATABASE. Every other test of the
   * `notIn` conjunct is a stub that asserts the SHAPE OF THE OBJECT HANDED TO
   * PRISMA — replace `status: { notIn: [...] }` with `{}` and only those stub
   * tests redden, because nothing else demonstrates that Postgres actually
   * refuses the write.
   *
   * That gap matters more than it looks. The DB trigger backstops `date` and
   * ONLY `date`. For any other column — `description` here — the conjunct is
   * the sole thing standing between a completion that commits mid-request and
   * a write onto a frozen class, and this suite's own standard is that a
   * refusal has to mean the row was not written, not merely that an error was
   * returned. Until this test, that standard was unmet for exactly the path
   * the conjunct exists to cover.
   *
   * The race is staged, not waited for: a query extension flips the class to
   * `completed` after `updateClass`'s OPENING read has already returned
   * `open`, so the early return sees a live class and steps aside. Same shape
   * as `class-transitions.test.ts`'s `'does not complete a class rescheduled
   * after the sweep read it'`. `reads` is asserted because a hook that fired
   * on the wrong call would stage a different race than the one described and
   * still produce a green `terminal`.
   */
  it('refuses the write at the database when the class completes mid-request', async () => {
    const cls = await makeClass(false, 'open');

    let reads = 0;
    const racing = prisma.$extends({
      query: {
        class: {
          async findUnique({ args, query }) {
            const row = await query(args);
            reads += 1;
            if (reads === 1) {
              await prisma.class.update({ where: { id: cls.id }, data: { status: 'completed' } });
            }
            return row;
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await updateClass(racing, cls.id, { description: 'Edited mid-completion' });

    expect(result).toEqual({ ok: false, reason: 'terminal', status: 'completed' });
    // The opening read, then the re-read in the `count === 0` branch. Three
    // would mean the write was retried; one would mean the early return
    // answered and the CAS never ran.
    expect(reads).toBe(2);

    // The assertion the stubs cannot make: the row is untouched. `description`
    // is not economic and not `date`, so no trigger and no `settingsLocked`
    // check was ever involved — this is the conjunct alone.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.description).toBeNull();
    expect(after.status).toBe('completed');
  });

  it('answers terminal, not no_fields, for a body that asks for nothing', async () => {
    // Pins the OTHER ordering the early return participates in. #247 put the
    // terminal check above the `hasEdit` check, so an empty or all-undefined
    // `PUT` to a terminal class answers 409 `terminal` where it used to answer
    // 400 `no_fields`. Nothing was wrong with either answer and nothing broke;
    // what was missing is a record that the order is CHOSEN. The sibling
    // ordering — `terminal` before `locked` — has such a record in
    // `'reports terminal, not locked, when the class is both'`, and this one
    // did not, so moving the early return below `hasEdit` (a plausible
    // tidy-up, since the cheapest check conventionally goes first) would have
    // silently changed a status code with no test to notice.
    //
    // The choice: `terminal` describes the CLASS, `no_fields` describes the
    // payload, and only one of them survives the obvious retry. A teacher told
    // "no fields" adds fields and fails again; a teacher told "that class can
    // no longer be changed" stops. Same reasoning as the `locked` case, which
    // is why the two orderings agree.
    const cls = await makeClass(false, 'completed');

    expect(await updateClass(prisma, cls.id, {})).toEqual({
      ok: false,
      reason: 'terminal',
      status: 'completed',
    });

    // Both no-op shapes, because they are not the same code path until they
    // reach `hasEdit`: `'treats an all-undefined payload as no edit, not as a
    // vanished row'` above exists precisely because `{ description: undefined }`
    // once reached the write and came back with a zero count. Pinning only `{}`
    // would leave the shape that actually caused a bug unpinned.
    expect(await updateClass(prisma, cls.id, { description: undefined })).toEqual({
      ok: false,
      reason: 'terminal',
      status: 'completed',
    });
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

  function stubDb(opts: {
    settingsLocked: boolean;
    rowSurvives: boolean;
    // Reported by updateClass's opening read. Defaults to a non-terminal value
    // so every pre-#247 case in this block behaves exactly as it did.
    status?: ClassStatus;
    // Reported by the re-read inside the `count === 0` branch. Defaults to
    // `status`; set it different to stage the completion race.
    statusAfter?: ClassStatus;
  }) {
    const updateManyCalls: UpdateManyArgs[] = [];
    // Resolved once rather than as a `??` chain at each use, so "statusAfter
    // defaults to status, which defaults to open" is a statement rather than
    // operator precedence, and `'open'` appears in one place.
    const statusOnRead = opts.status ?? 'open';
    const statusOnReRead = opts.statusAfter ?? statusOnRead;
    let reads = 0;
    const db = {
      class: {
        findUnique: async () => {
          reads += 1;
          if (reads === 1) {
            return {
              id: 'stub-class',
              settingsLocked: opts.settingsLocked,
              status: statusOnRead,
              // #249's guard reads these. Future-dated and UTC so every
              // existing case in this block behaves exactly as it did: no stub
              // test sends a past date, so the guard never fires here.
              date: new Date('2099-06-01T00:00:00.000Z'),
              startTime: '09:00',
              teacher: { defaultTimezone: 'UTC' },
            };
          }
          return opts.rowSurvives ? { id: 'stub-class', status: statusOnReRead } : null;
        },
        updateMany: async (args: UpdateManyArgs) => {
          updateManyCalls.push(args);
          return { count: 0 };
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
    expect(updateManyCalls[0]?.where).toEqual({
      id: 'stub-class',
      settingsLocked: false,
      status: { notIn: [...TERMINAL_CLASS_STATUSES] },
    });

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
    expect(updateManyCalls[0]?.where).toEqual({
      id: 'stub-class',
      status: { notIn: [...TERMINAL_CLASS_STATUSES] },
    });

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

  it('reports terminal when the class completed between the read and the write', async () => {
    const stub = stubDb({
      settingsLocked: false,
      rowSurvives: true,
      status: 'open',
      statusAfter: 'completed',
    });
    const { db, updateManyCalls } = stub;

    // A date-only edit, so `sentEconomic` is null. FUTURE-dated deliberately:
    // #249's guard sits above this path and would answer a past date first,
    // which would leave this branch untested while the test still looked green.
    const result = await updateClass(db, 'stub-class', { date: new Date('2099-07-01') });
    expect(result).toEqual({ ok: false, reason: 'terminal', status: 'completed' });

    // Proves the CAS path ran rather than the early return, which is
    // otherwise indistinguishable — it returns the same shape.
    expect(updateManyCalls).toHaveLength(1);
    expect(stub.reads).toBe(2);
  });

  it('constrains the write to non-terminal rows under both filter shapes', async () => {
    // Asserted against the constant, not a `['completed','cancelled']`
    // literal: what this test owns is "the conjunct is present and derived",
    // while the constant's own VALUES are pinned against the trigger SQL by
    // class-terminal-status.test.ts. Restating them here would duplicate that
    // pin badly — it would go stale independently.
    //
    // Task 1's two pre-existing stub tests already pin these same two `where`
    // shapes individually; kept anyway as the only test whose name states the
    // property and the only one showing both arms side by side under the
    // derived constant.
    const live = { status: { notIn: [...TERMINAL_CLASS_STATUSES] } };

    const economic = stubDb({ settingsLocked: false, rowSurvives: false });
    await updateClass(economic.db, 'stub-class', { roomCost: 42 });
    expect(economic.updateManyCalls[0]?.where).toEqual({
      id: 'stub-class',
      settingsLocked: false,
      ...live,
    });

    const plain = stubDb({ settingsLocked: false, rowSurvives: false });
    await updateClass(plain.db, 'stub-class', { description: 'x' });
    expect(plain.updateManyCalls[0]?.where).toEqual({ id: 'stub-class', ...live });
  });

  it('answers a visibly-terminal row from the read, without attempting the write', async () => {
    const { db, updateManyCalls } = stubDb({
      settingsLocked: false,
      rowSurvives: true,
      status: 'completed',
    });

    const result = await updateClass(db, 'stub-class', { date: new Date('2020-01-01') });
    expect(result).toEqual({ ok: false, reason: 'terminal', status: 'completed' });

    // The point of this case, and the mirror of its `locked` sibling above:
    // the pre-check answered it WITHOUT attempting a write. That is the
    // query-count half of the evidence, and this test owns it. It is not the
    // only test that can see the early return, and deleting it does not leave
    // the result identical everywhere: Task 1's `'reports terminal, not
    // locked, when the class is both'` (T5) owns the correctness half — a
    // class that is both terminal and settings-locked with an economic field
    // sent falls through to `locked` once this check is gone, before the CAS
    // ever runs.
    expect(updateManyCalls).toHaveLength(0);
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
