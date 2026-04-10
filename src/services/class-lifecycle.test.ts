import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  VALID_TRANSITIONS,
  ECONOMIC_FIELDS,
  canTransition,
  validateTransition,
  isEconomicFieldLocked,
  transitionClass,
  completeClass,
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
});

describe('completeClass (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let classId: string;
  const studentIds: string[] = [];

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Complete',
        lastName: 'Teacher',
        email: `complete-teacher-${uniqueSuffix}@test.local`,
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
    // Clean up in dependency order: payments → registrations → class → students → teacherRoom → room → teacher
    await prisma.payment.deleteMany({
      where: { registration: { classId } },
    });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.class.delete({ where: { id: classId } });
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
  });

  it('returns error for non-existent class', async () => {
    const result = await completeClass(prisma, 'non-existent-id');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not found');
    }
  });
});
