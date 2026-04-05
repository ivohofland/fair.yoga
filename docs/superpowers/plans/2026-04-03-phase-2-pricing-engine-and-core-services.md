# Phase 2: Pricing Engine & Core Services — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure business logic layer — 6 TypeScript services with comprehensive test suites. No HTTP, no UI. These are the most critical functions in the system.

**Architecture:** Each service is a set of pure TypeScript functions that take typed inputs and return typed outputs. Services import from `@prisma/client` for types and accept a `PrismaClient` (or transaction) as a parameter for DB access. The pricing engine is fully pure (no DB). All services are independently testable — no Next.js, no HTTP, no framework imports.

**Tech Stack:** TypeScript (strict), Prisma Client (types + DB), Vitest (testing), Decimal.js (via Prisma's Decimal)

---

## File Structure

```
src/services/
  pricing.ts                 # Pure pricing calculations — no DB, no side effects
  pricing.test.ts            # Most tested file in the system
  class-lifecycle.ts         # State machine: transitions, guards, side effects
  class-lifecycle.test.ts
  waitlist.ts                # Hybrid promotion: auto-promote + first-come-first-claimed
  waitlist.test.ts
  notifications.ts           # Create notification records, email fallback scheduling
  notifications.test.ts
  payments.ts                # Payment creation from pricing output, status transitions
  payments.test.ts
  class-generator.ts         # Rolling 4-week instance generation from templates
  class-generator.test.ts
```

**Existing files referenced:**
- `prisma/schema.prisma` — all model/enum definitions
- `src/lib/db.ts` — Prisma singleton (used in integration, not imported by services)
- `prisma/seed.ts` — reference pricing calculation for the completed class

---

## Task 1: Pricing Engine — Types & Core Calculation

**Files:**
- Create: `src/services/pricing.ts`
- Create: `src/services/pricing.test.ts`
- Delete: `src/services/.gitkeep`

This is the most critical code in the system. The pricing engine is 100% pure — no DB, no side effects. It takes numbers in and returns numbers out.

### Key formulas:

```
effective_teacher_rate = min_rate + (target_rate - min_rate) × (students - min_students) / (max_students - min_students)
  - Clamped: at or below min_students → min_rate; at or above max_students → target_rate

total_class_cost = room_cost + (effective_teacher_rate × student_count)

base_unit = total_class_cost / sum_of_all_tier_ratios

student_price = base_unit × student_tier_ratio
```

### Tier ratios (constants):

```
Tier 1: 0.65    Tier 2: 0.80    Tier 3: 1.00    Tier 4: 1.20    Tier 5: 1.35
```

- [ ] **Step 1: Write the failing tests**

```typescript
// src/services/pricing.test.ts
import { describe, it, expect } from 'vitest';
import {
  TIER_RATIOS,
  calculateEffectiveTeacherRate,
  calculateClassPricing,
  type ClassPricingInput,
  type PricingResult,
} from './pricing';

describe('TIER_RATIOS', () => {
  it('has 5 tiers with compressed 2x spread', () => {
    expect(TIER_RATIOS).toEqual({
      1: 0.65,
      2: 0.80,
      3: 1.00,
      4: 1.20,
      5: 1.35,
    });
  });

  it('tier 3 is the baseline at 1.0', () => {
    expect(TIER_RATIOS[3]).toBe(1.0);
  });

  it('max spread is approximately 2x', () => {
    const spread = TIER_RATIOS[5] / TIER_RATIOS[1];
    expect(spread).toBeCloseTo(2.077, 2);
  });
});

describe('calculateEffectiveTeacherRate', () => {
  it('returns min_rate at min_students', () => {
    const rate = calculateEffectiveTeacherRate({
      studentCount: 4,
      minStudents: 4,
      maxStudents: 12,
      minRate: 15,
      targetRate: 25,
    });
    expect(rate).toBe(15);
  });

  it('returns target_rate at max_students', () => {
    const rate = calculateEffectiveTeacherRate({
      studentCount: 12,
      minStudents: 4,
      maxStudents: 12,
      minRate: 15,
      targetRate: 25,
    });
    expect(rate).toBe(25);
  });

  it('interpolates linearly between min and max', () => {
    // midpoint: 4 + (12-4)/2 = 8 students → rate = 15 + (25-15)*0.5 = 20
    const rate = calculateEffectiveTeacherRate({
      studentCount: 8,
      minStudents: 4,
      maxStudents: 12,
      minRate: 15,
      targetRate: 25,
    });
    expect(rate).toBe(20);
  });

  it('caps at target_rate when students exceed max (walk-ins)', () => {
    const rate = calculateEffectiveTeacherRate({
      studentCount: 15,
      minStudents: 4,
      maxStudents: 12,
      minRate: 15,
      targetRate: 25,
    });
    expect(rate).toBe(25);
  });

  it('floors at min_rate when students at or below min', () => {
    const rate = calculateEffectiveTeacherRate({
      studentCount: 2,
      minStudents: 4,
      maxStudents: 12,
      minRate: 15,
      targetRate: 25,
    });
    expect(rate).toBe(15);
  });

  it('handles flat rate (min_rate equals target_rate)', () => {
    const rate = calculateEffectiveTeacherRate({
      studentCount: 8,
      minStudents: 4,
      maxStudents: 12,
      minRate: 20,
      targetRate: 20,
    });
    expect(rate).toBe(20);
  });

  it('handles negative min_rate (teacher subsidizes room)', () => {
    const rate = calculateEffectiveTeacherRate({
      studentCount: 4,
      minStudents: 4,
      maxStudents: 12,
      minRate: -5,
      targetRate: 25,
    });
    expect(rate).toBe(-5);
  });
});

describe('calculateClassPricing', () => {
  it('calculates correct pricing for seed data scenario', () => {
    // Matches the completed class in prisma/seed.ts:
    // 9 charged students, tiers: [1,1,2,3,3,4,4,5,5]
    const input: ClassPricingInput = {
      roomCost: 35,
      minRate: 15,
      targetRate: 25,
      minStudents: 4,
      maxStudents: 12,
      studentTiers: [1, 1, 2, 3, 3, 4, 4, 5, 5],
    };

    const result = calculateClassPricing(input);

    expect(result.effectiveTeacherRate).toBeCloseTo(21.25, 2);
    expect(result.totalCost).toBeCloseTo(226.25, 2);
    expect(result.studentCount).toBe(9);

    // Verify per-student prices by tier
    expect(result.studentPrices[0]).toBeCloseTo(15.99, 1); // tier 1
    expect(result.studentPrices[1]).toBeCloseTo(15.99, 1); // tier 1
    expect(result.studentPrices[2]).toBeCloseTo(19.67, 1); // tier 2
    expect(result.studentPrices[3]).toBeCloseTo(24.59, 1); // tier 3
    expect(result.studentPrices[4]).toBeCloseTo(24.59, 1); // tier 3
    expect(result.studentPrices[5]).toBeCloseTo(29.51, 1); // tier 4
    expect(result.studentPrices[6]).toBeCloseTo(29.51, 1); // tier 4
    expect(result.studentPrices[7]).toBeCloseTo(33.20, 1); // tier 5
    expect(result.studentPrices[8]).toBeCloseTo(33.20, 1); // tier 5

    // Sum of prices should equal totalCost
    const sum = result.studentPrices.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(result.totalCost, 1);
  });

  it('handles single student', () => {
    const result = calculateClassPricing({
      roomCost: 35,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 12,
      studentTiers: [3],
    });

    // 1 student at min → rate = 15
    // total = 35 + 15*1 = 50
    // single student pays everything: 50 / 1.00 * 1.00 = 50
    expect(result.effectiveTeacherRate).toBe(15);
    expect(result.totalCost).toBe(50);
    expect(result.studentPrices).toEqual([50]);
  });

  it('handles all students in same tier', () => {
    const result = calculateClassPricing({
      roomCost: 35,
      minRate: 15,
      targetRate: 25,
      minStudents: 4,
      maxStudents: 12,
      studentTiers: [3, 3, 3, 3, 3],
    });

    // 5 students → rate = 15 + (25-15) * (5-4)/(12-4) = 16.25
    // total = 35 + 16.25*5 = 116.25
    // all same tier: 116.25 / (5*1.00) * 1.00 = 23.25 each
    expect(result.effectiveTeacherRate).toBe(16.25);
    expect(result.totalCost).toBe(116.25);
    expect(result.studentPrices[0]).toBeCloseTo(23.25, 2);
    // All prices should be equal
    for (const price of result.studentPrices) {
      expect(price).toBeCloseTo(23.25, 2);
    }
  });

  it('handles walk-ins exceeding max (rate capped at target)', () => {
    // 14 students when max is 12
    const result = calculateClassPricing({
      roomCost: 35,
      minRate: 15,
      targetRate: 25,
      minStudents: 4,
      maxStudents: 12,
      studentTiers: [1, 1, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 5],
    });

    // Rate capped at target: 25
    expect(result.effectiveTeacherRate).toBe(25);
    // total = 35 + 25*14 = 385
    expect(result.totalCost).toBe(385);
    expect(result.studentCount).toBe(14);
  });

  it('handles negative min_rate', () => {
    const result = calculateClassPricing({
      roomCost: 50,
      minRate: -10,
      targetRate: 25,
      minStudents: 4,
      maxStudents: 12,
      studentTiers: [3, 3, 3, 3], // exactly min_students
    });

    // At min: rate = -10
    // total = 50 + (-10)*4 = 50 - 40 = 10
    expect(result.effectiveTeacherRate).toBe(-10);
    expect(result.totalCost).toBe(10);
    expect(result.studentPrices[0]).toBeCloseTo(2.5, 2);
  });

  it('handles flat rate (min equals target)', () => {
    const result = calculateClassPricing({
      roomCost: 30,
      minRate: 20,
      targetRate: 20,
      minStudents: 4,
      maxStudents: 12,
      studentTiers: [1, 3, 5],
    });

    // Rate is always 20 regardless of student count
    expect(result.effectiveTeacherRate).toBe(20);
    // total = 30 + 20*3 = 90
    expect(result.totalCost).toBe(90);
  });

  it('returns tier ratios for each student', () => {
    const result = calculateClassPricing({
      roomCost: 35,
      minRate: 15,
      targetRate: 25,
      minStudents: 4,
      maxStudents: 12,
      studentTiers: [1, 3, 5],
    });

    expect(result.studentTierRatios).toEqual([0.65, 1.0, 1.35]);
  });

  it('validates against pricing simulator test case 1', () => {
    // From pricing-simulator.html test case 1:
    // room=50, minRate=30, targetRate=55, min=6, max=14
    // 10 students: 2×T1, 2×T2, 3×T3, 2×T4, 1×T5
    // Using COMPRESSED 2x ratios: [0.65, 0.80, 1.00, 1.20, 1.35]
    const result = calculateClassPricing({
      roomCost: 50,
      minRate: 30,
      targetRate: 55,
      minStudents: 6,
      maxStudents: 14,
      studentTiers: [1, 1, 2, 2, 3, 3, 3, 4, 4, 5],
    });

    // rate = 30 + (55-30) * (10-6)/(14-6) = 30 + 25*0.5 = 42.50
    expect(result.effectiveTeacherRate).toBe(42.5);
    // total = 50 + 42.50*10 = 475
    expect(result.totalCost).toBe(475);
    // sum of ratios: 0.65*2 + 0.80*2 + 1.00*3 + 1.20*2 + 1.35*1 = 9.65
    // base = 475 / 9.65 = 49.2228...
    // tier 1: 49.22 * 0.65 = 31.99
    expect(result.studentPrices[0]).toBeCloseTo(31.99, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/pricing.test.ts`
Expected: FAIL — module `./pricing` not found

- [ ] **Step 3: Implement the pricing engine**

```typescript
// src/services/pricing.ts

export const TIER_RATIOS: Record<number, number> = {
  1: 0.65,
  2: 0.80,
  3: 1.00,
  4: 1.20,
  5: 1.35,
};

export interface TeacherRateInput {
  studentCount: number;
  minStudents: number;
  maxStudents: number;
  minRate: number;
  targetRate: number;
}

export interface ClassPricingInput {
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  studentTiers: number[]; // array of tier values (1-5), one per charged student
}

export interface PricingResult {
  effectiveTeacherRate: number;
  totalCost: number;
  studentCount: number;
  studentPrices: number[];      // price per student, same order as input tiers
  studentTierRatios: number[];  // ratio per student, same order as input tiers
}

export function calculateEffectiveTeacherRate(input: TeacherRateInput): number {
  const { studentCount, minStudents, maxStudents, minRate, targetRate } = input;

  if (studentCount >= maxStudents) return targetRate;
  if (studentCount <= minStudents) return minRate;

  const t = (studentCount - minStudents) / (maxStudents - minStudents);
  return minRate + (targetRate - minRate) * t;
}

export function calculateClassPricing(input: ClassPricingInput): PricingResult {
  const { roomCost, minRate, targetRate, minStudents, maxStudents, studentTiers } = input;
  const studentCount = studentTiers.length;

  const effectiveTeacherRate = calculateEffectiveTeacherRate({
    studentCount,
    minStudents,
    maxStudents,
    minRate,
    targetRate,
  });

  const totalCost = roomCost + effectiveTeacherRate * studentCount;

  const studentTierRatios = studentTiers.map((tier) => {
    const ratio = TIER_RATIOS[tier];
    if (ratio === undefined) {
      throw new Error(`Invalid tier: ${tier}. Must be 1-5.`);
    }
    return ratio;
  });

  const sumOfRatios = studentTierRatios.reduce((sum, r) => sum + r, 0);
  const baseUnit = totalCost / sumOfRatios;

  const studentPrices = studentTierRatios.map((ratio) =>
    Math.round(baseUnit * ratio * 100) / 100,
  );

  return {
    effectiveTeacherRate,
    totalCost,
    studentCount,
    studentPrices,
    studentTierRatios,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/pricing.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Verify sum-of-prices invariant**

The sum of `studentPrices` should closely match `totalCost` (within rounding). Check that the seed data scenario test confirms this. If rounding causes drift > 1 cent, add a rounding adjustment to the last student's price. Verify by re-running tests.

- [ ] **Step 6: Remove .gitkeep and commit**

```bash
rm src/services/.gitkeep
git add src/services/pricing.ts src/services/pricing.test.ts
git commit -m "feat: implement pricing engine with full test suite"
```

---

## Task 2: Class Lifecycle State Machine

**Files:**
- Create: `src/services/class-lifecycle.ts`
- Create: `src/services/class-lifecycle.test.ts`

The class lifecycle manages state transitions with guards and side effects. It uses the database (via injected PrismaClient) to update class records.

### State machine:

```
draft → open → full → in_progress → completed
                ↕                        ↗
              open ←──────────────────┘ (cancel from open/full)
                                         cancelled
```

Valid transitions:
- `draft → open` (teacher publishes)
- `open → full` (registrations reach max_students)
- `full → open` (student cancels, spot opens)
- `open → in_progress` (class start time reached)
- `full → in_progress` (class start time reached)
- `in_progress → completed` (teacher marks done or duration elapses)
- `open → cancelled` (auto-cancel: below min_students at check time)
- `full → cancelled` (edge case: multiple cancellations drop below min)
- `draft → cancelled` (teacher cancels draft)

### Guards:
- `settings_locked` flips to `true` on first registration — economic fields immutable after
- Cannot transition to `completed` unless `in_progress`
- Cannot transition backwards (e.g., `completed → open`)

- [ ] **Step 1: Write the failing tests**

```typescript
// src/services/class-lifecycle.test.ts
import { describe, it, expect } from 'vitest';
import {
  VALID_TRANSITIONS,
  canTransition,
  validateTransition,
  type TransitionResult,
} from './class-lifecycle';
import type { ClassStatus } from '@prisma/client';

describe('VALID_TRANSITIONS', () => {
  it('defines all valid state transitions', () => {
    expect(VALID_TRANSITIONS.draft).toContain('open');
    expect(VALID_TRANSITIONS.draft).toContain('cancelled');
    expect(VALID_TRANSITIONS.open).toContain('full');
    expect(VALID_TRANSITIONS.open).toContain('in_progress');
    expect(VALID_TRANSITIONS.open).toContain('cancelled');
    expect(VALID_TRANSITIONS.full).toContain('open');
    expect(VALID_TRANSITIONS.full).toContain('in_progress');
    expect(VALID_TRANSITIONS.full).toContain('cancelled');
    expect(VALID_TRANSITIONS.in_progress).toContain('completed');
    // Terminal states have no transitions
    expect(VALID_TRANSITIONS.completed).toEqual([]);
    expect(VALID_TRANSITIONS.cancelled).toEqual([]);
  });
});

describe('canTransition', () => {
  it('allows valid transitions', () => {
    expect(canTransition('draft', 'open')).toBe(true);
    expect(canTransition('open', 'full')).toBe(true);
    expect(canTransition('full', 'open')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(canTransition('draft', 'completed')).toBe(false);
    expect(canTransition('completed', 'open')).toBe(false);
    expect(canTransition('cancelled', 'open')).toBe(false);
    expect(canTransition('open', 'draft')).toBe(false);
    expect(canTransition('in_progress', 'open')).toBe(false);
  });
});

describe('validateTransition', () => {
  it('returns success for valid transition', () => {
    const result = validateTransition('draft', 'open');
    expect(result.ok).toBe(true);
  });

  it('returns error for invalid transition', () => {
    const result = validateTransition('draft', 'completed');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('draft');
      expect(result.error).toContain('completed');
    }
  });

  it('returns error for terminal state transitions', () => {
    const result = validateTransition('completed', 'open');
    expect(result.ok).toBe(false);
  });
});

describe('shouldLockSettings', () => {
  // settings_locked flips true on first registration
  // This is checked by the registration flow, not the state machine itself
  // But we export a helper to check if economic fields can be modified
  it('is tested via isEconomicFieldLocked', async () => {
    const { isEconomicFieldLocked } = await import('./class-lifecycle');
    expect(isEconomicFieldLocked(true)).toBe(true);
    expect(isEconomicFieldLocked(false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/class-lifecycle.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the class lifecycle service**

```typescript
// src/services/class-lifecycle.ts
import type { ClassStatus } from '@prisma/client';

export const VALID_TRANSITIONS: Record<ClassStatus, ClassStatus[]> = {
  draft: ['open', 'cancelled'],
  open: ['full', 'in_progress', 'cancelled'],
  full: ['open', 'in_progress', 'cancelled'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
};

export type TransitionResult =
  | { ok: true }
  | { ok: false; error: string };

export function canTransition(from: ClassStatus, to: ClassStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function validateTransition(from: ClassStatus, to: ClassStatus): TransitionResult {
  if (canTransition(from, to)) {
    return { ok: true };
  }
  return {
    ok: false,
    error: `Invalid transition: cannot move from '${from}' to '${to}'`,
  };
}

export function isEconomicFieldLocked(settingsLocked: boolean): boolean {
  return settingsLocked;
}

export const ECONOMIC_FIELDS = [
  'roomCost',
  'minRate',
  'targetRate',
  'minStudents',
  'maxStudents',
] as const;

export type EconomicField = (typeof ECONOMIC_FIELDS)[number];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/class-lifecycle.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/class-lifecycle.ts src/services/class-lifecycle.test.ts
git commit -m "feat: implement class lifecycle state machine with transition guards"
```

---

## Task 3: Class Lifecycle — DB Operations (Transition Execution)

**Files:**
- Modify: `src/services/class-lifecycle.ts`
- Modify: `src/services/class-lifecycle.test.ts`

Add functions that execute transitions against the database — `transitionClass`, `completeClass` (runs pricing + creates payments), and `autoCancelClass`.

- [ ] **Step 1: Write the failing tests for transitionClass**

Add to `src/services/class-lifecycle.test.ts`:

```typescript
import { PrismaClient } from '@prisma/client';

// Use a real test database — these are integration tests
const prisma = new PrismaClient();

describe('transitionClass (integration)', () => {
  let teacherId: string;
  let teacherRoomId: string;

  beforeAll(async () => {
    // Create minimal test fixtures
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Test',
        lastName: 'Teacher',
        email: `test-lifecycle-${Date.now()}@test.com`,
        bio: 'Test teacher',
        pageSlug: `test-lifecycle-${Date.now()}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Test Room',
        address: `Test Address ${Date.now()}`,
        city: 'Test',
        postcode: '0000',
        floor: '1',
        roomName: `Room ${Date.now()}`,
        maxCapacity: 20,
        createdById: teacherId,
      },
    });

    const teacherRoom = await prisma.teacherRoom.create({
      data: {
        teacherId,
        roomId: room.id,
        capacityOverride: 12,
        rentalRate: 35,
      },
    });
    teacherRoomId = teacherRoom.id;
  });

  afterAll(async () => {
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('transitions a draft class to open', async () => {
    const { transitionClass } = await import('./class-lifecycle');

    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Test',
        date: new Date(),
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

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('open');

    await prisma.class.delete({ where: { id: cls.id } });
  });

  it('rejects invalid transition', async () => {
    const { transitionClass } = await import('./class-lifecycle');

    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Test',
        date: new Date(),
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

    const result = await transitionClass(prisma, cls.id, 'completed');
    expect(result.ok).toBe(false);

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('draft'); // unchanged

    await prisma.class.delete({ where: { id: cls.id } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/class-lifecycle.test.ts`
Expected: FAIL — `transitionClass` is not exported

- [ ] **Step 3: Implement transitionClass**

Add to `src/services/class-lifecycle.ts`:

```typescript
import type { PrismaClient, ClassStatus } from '@prisma/client';

// ... existing code ...

export type TransitionDbResult =
  | { ok: true; newStatus: ClassStatus }
  | { ok: false; error: string };

export async function transitionClass(
  db: PrismaClient,
  classId: string,
  targetStatus: ClassStatus,
): Promise<TransitionDbResult> {
  const cls = await db.class.findUnique({ where: { id: classId } });
  if (!cls) {
    return { ok: false, error: `Class not found: ${classId}` };
  }

  const validation = validateTransition(cls.status, targetStatus);
  if (!validation.ok) {
    return validation;
  }

  await db.class.update({
    where: { id: classId },
    data: { status: targetStatus },
  });

  return { ok: true, newStatus: targetStatus };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/class-lifecycle.test.ts`
Expected: All tests PASS (requires running PostgreSQL via `docker compose up -d`)

- [ ] **Step 5: Commit**

```bash
git add src/services/class-lifecycle.ts src/services/class-lifecycle.test.ts
git commit -m "feat: add transitionClass DB operation with validation"
```

---

## Task 4: Complete Class — Pricing + Payment Creation

**Files:**
- Modify: `src/services/class-lifecycle.ts`
- Modify: `src/services/class-lifecycle.test.ts`

The `completeClass` function is the most important side effect: it transitions a class to `completed`, runs the pricing engine on all charged registrations, updates each registration with its calculated price, and creates Payment records.

**Charged registrations** = all registrations that are NOT `cancelled`. This includes `registered`, `attended`, `no_show`, and `late_cancel`.

- [ ] **Step 1: Write the failing test for completeClass**

Add to `src/services/class-lifecycle.test.ts`:

```typescript
describe('completeClass (integration)', () => {
  it('calculates pricing and creates payments for all charged registrations', async () => {
    const { completeClass } = await import('./class-lifecycle');

    // Create an in_progress class with registrations
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Vinyasa',
        date: new Date(),
        startTime: '09:00',
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

    // Create 5 students with different tiers
    const students = await Promise.all(
      [1, 2, 3, 4, 5].map((tier) =>
        prisma.student.create({
          data: {
            firstName: `Student${tier}`,
            lastName: 'Test',
            email: `complete-test-${tier}-${Date.now()}@test.com`,
            incomeTier: tier,
          },
        }),
      ),
    );

    // Create registrations: 4 attended, 1 cancelled (not charged)
    const registrations = await Promise.all(
      students.map((s, i) =>
        prisma.registration.create({
          data: {
            classId: cls.id,
            studentId: s.id,
            tierAtBooking: s.incomeTier,
            status: i === 4 ? 'cancelled' : 'registered',
            cancelledAt: i === 4 ? new Date() : null,
          },
        }),
      ),
    );

    const result = await completeClass(prisma, cls.id);
    expect(result.ok).toBe(true);

    // Verify class was updated
    const updatedClass = await prisma.class.findUniqueOrThrow({
      where: { id: cls.id },
    });
    expect(updatedClass.status).toBe('completed');
    expect(updatedClass.totalStudents).toBe(4); // 5 - 1 cancelled
    expect(updatedClass.effectiveTeacherRate).not.toBeNull();
    expect(updatedClass.totalRevenue).not.toBeNull();

    // Verify registrations have prices (except cancelled)
    const updatedRegs = await prisma.registration.findMany({
      where: { classId: cls.id },
      orderBy: { tierAtBooking: 'asc' },
    });

    for (const reg of updatedRegs) {
      if (reg.status === 'cancelled') {
        expect(reg.price).toBeNull();
        expect(reg.tierRatio).toBeNull();
      } else {
        expect(reg.price).not.toBeNull();
        expect(reg.tierRatio).not.toBeNull();
      }
    }

    // Verify payments were created for charged registrations
    const payments = await prisma.payment.findMany({
      where: {
        registrationId: { in: updatedRegs.filter((r) => r.status !== 'cancelled').map((r) => r.id) },
      },
    });
    expect(payments).toHaveLength(4);
    for (const payment of payments) {
      expect(payment.status).toBe('pending');
      expect(Number(payment.amount)).toBeGreaterThan(0);
    }

    // Cleanup
    await prisma.payment.deleteMany({ where: { registrationId: { in: registrations.map((r) => r.id) } } });
    await prisma.registration.deleteMany({ where: { classId: cls.id } });
    await prisma.class.delete({ where: { id: cls.id } });
    await prisma.student.deleteMany({ where: { id: { in: students.map((s) => s.id) } } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/class-lifecycle.test.ts`
Expected: FAIL — `completeClass` is not exported

- [ ] **Step 3: Implement completeClass**

Add to `src/services/class-lifecycle.ts`:

```typescript
import { calculateClassPricing } from './pricing';

// ... existing code ...

const CHARGED_STATUSES: RegistrationStatus[] = ['registered', 'attended', 'no_show', 'late_cancel'];

export async function completeClass(
  db: PrismaClient,
  classId: string,
): Promise<TransitionDbResult> {
  const cls = await db.class.findUnique({
    where: { id: classId },
    include: { registrations: true },
  });

  if (!cls) {
    return { ok: false, error: `Class not found: ${classId}` };
  }

  const validation = validateTransition(cls.status, 'completed');
  if (!validation.ok) {
    return validation;
  }

  const chargedRegistrations = cls.registrations.filter((r) =>
    CHARGED_STATUSES.includes(r.status),
  );

  if (chargedRegistrations.length === 0) {
    // Complete with zero revenue
    await db.class.update({
      where: { id: classId },
      data: {
        status: 'completed',
        effectiveTeacherRate: 0,
        totalStudents: 0,
        totalRevenue: 0,
      },
    });
    return { ok: true, newStatus: 'completed' };
  }

  const pricing = calculateClassPricing({
    roomCost: Number(cls.roomCost),
    minRate: Number(cls.minRate),
    targetRate: Number(cls.targetRate),
    minStudents: cls.minStudents,
    maxStudents: cls.maxStudents,
    studentTiers: chargedRegistrations.map((r) => r.tierAtBooking),
  });

  // Update class with pricing summary
  await db.class.update({
    where: { id: classId },
    data: {
      status: 'completed',
      effectiveTeacherRate: pricing.effectiveTeacherRate,
      totalStudents: pricing.studentCount,
      totalRevenue: pricing.totalCost,
    },
  });

  // Update each charged registration with its price and create payment
  for (let i = 0; i < chargedRegistrations.length; i++) {
    const reg = chargedRegistrations[i]!;
    const price = pricing.studentPrices[i]!;
    const tierRatio = pricing.studentTierRatios[i]!;

    await db.registration.update({
      where: { id: reg.id },
      data: { price, tierRatio },
    });

    await db.payment.create({
      data: {
        registrationId: reg.id,
        amount: price,
        status: 'pending',
      },
    });
  }

  return { ok: true, newStatus: 'completed' };
}
```

Also add the import at the top:

```typescript
import type { PrismaClient, ClassStatus, RegistrationStatus } from '@prisma/client';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/class-lifecycle.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/class-lifecycle.ts src/services/class-lifecycle.test.ts
git commit -m "feat: add completeClass with pricing calculation and payment creation"
```

---

## Task 5: Waitlist Service

**Files:**
- Create: `src/services/waitlist.ts`
- Create: `src/services/waitlist.test.ts`

The waitlist manages overflow when a class reaches max_students. It supports:
1. **Auto-promote** — before cancel deadline cutoff (1hr before deadline), first in queue is auto-promoted
2. **First-come-first-claimed** — in the final hour before deadline, all waitlisted are notified, first to claim gets the spot
3. **Frozen** — after deadline passes, no more promotions

- [ ] **Step 1: Write the failing tests**

```typescript
// src/services/waitlist.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  addToWaitlist,
  removeFromWaitlist,
  promoteNext,
  getWaitlistWindow,
  type WaitlistWindow,
} from './waitlist';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('getWaitlistWindow', () => {
  it('returns "auto_promote" when more than 1 hour before deadline', () => {
    const classDate = new Date('2026-04-10T09:00:00');
    const deadline = 'HOURS_24' as const;
    // Deadline = April 9 09:00. 1hr cutoff = April 9 08:00
    // Now = April 8 (well before)
    const now = new Date('2026-04-08T12:00:00');
    expect(getWaitlistWindow(classDate, '09:00', deadline, now)).toBe('auto_promote');
  });

  it('returns "first_come_first_claimed" in final hour before deadline', () => {
    const classDate = new Date('2026-04-10T09:00:00');
    const deadline = 'HOURS_24' as const;
    // Deadline = April 9 09:00. 1hr cutoff = April 9 08:00
    // Now = April 9 08:30 (between cutoff and deadline)
    const now = new Date('2026-04-09T08:30:00');
    expect(getWaitlistWindow(classDate, '09:00', deadline, now)).toBe('first_come_first_claimed');
  });

  it('returns "frozen" after deadline', () => {
    const classDate = new Date('2026-04-10T09:00:00');
    const deadline = 'HOURS_24' as const;
    // Deadline = April 9 09:00. Now = April 9 10:00 (after deadline)
    const now = new Date('2026-04-09T10:00:00');
    expect(getWaitlistWindow(classDate, '09:00', deadline, now)).toBe('frozen');
  });

  it('handles 6h deadline correctly', () => {
    const classDate = new Date('2026-04-10T09:00:00');
    const deadline = 'HOURS_6' as const;
    // Deadline = April 10 03:00. 1hr cutoff = April 10 02:00
    const now = new Date('2026-04-10T02:30:00');
    expect(getWaitlistWindow(classDate, '09:00', deadline, now)).toBe('first_come_first_claimed');
  });
});

describe('addToWaitlist (integration)', () => {
  let teacherId: string;
  let teacherRoomId: string;
  let classId: string;
  const studentIds: string[] = [];

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'WL',
        lastName: 'Teacher',
        email: `wl-teacher-${Date.now()}@test.com`,
        bio: 'Test',
        pageSlug: `wl-${Date.now()}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'WL Room',
        address: `WL Addr ${Date.now()}`,
        city: 'Test',
        postcode: '0000',
        floor: '1',
        roomName: `WLRoom ${Date.now()}`,
        maxCapacity: 20,
        createdById: teacherId,
      },
    });

    const tr = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 12, rentalRate: 35 },
    });
    teacherRoomId = tr.id;

    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Test',
        date: new Date('2026-04-10'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'full',
        settingsLocked: true,
      },
    });
    classId = cls.id;

    for (let i = 0; i < 3; i++) {
      const s = await prisma.student.create({
        data: {
          firstName: `WLStudent${i}`,
          lastName: 'Test',
          email: `wl-student-${i}-${Date.now()}@test.com`,
          incomeTier: 3,
        },
      });
      studentIds.push(s.id);
    }
  });

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { classId } });
    await prisma.class.delete({ where: { id: classId } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('adds students to waitlist with sequential positions', async () => {
    const entry1 = await addToWaitlist(prisma, classId, studentIds[0]!);
    expect(entry1.position).toBe(1);

    const entry2 = await addToWaitlist(prisma, classId, studentIds[1]!);
    expect(entry2.position).toBe(2);

    const entry3 = await addToWaitlist(prisma, classId, studentIds[2]!);
    expect(entry3.position).toBe(3);
  });

  it('reorders positions when a student is removed', async () => {
    await removeFromWaitlist(prisma, classId, studentIds[1]!);

    const remaining = await prisma.waitlistEntry.findMany({
      where: { classId, status: 'waiting' },
      orderBy: { position: 'asc' },
    });

    expect(remaining).toHaveLength(2);
    expect(remaining[0]!.position).toBe(1);
    expect(remaining[1]!.position).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/waitlist.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the waitlist service**

```typescript
// src/services/waitlist.ts
import type { PrismaClient, CancelDeadline, WaitlistEntry } from '@prisma/client';

export type WaitlistWindow = 'auto_promote' | 'first_come_first_claimed' | 'frozen';

const DEADLINE_HOURS: Record<CancelDeadline, number> = {
  HOURS_48: 48,
  HOURS_24: 24,
  HOURS_12: 12,
  HOURS_6: 6,
};

export function getWaitlistWindow(
  classDate: Date,
  startTime: string,
  cancelDeadline: CancelDeadline,
  now: Date = new Date(),
): WaitlistWindow {
  const [hours, minutes] = startTime.split(':').map(Number);
  const classStart = new Date(classDate);
  classStart.setHours(hours!, minutes!, 0, 0);

  const deadlineMs = DEADLINE_HOURS[cancelDeadline] * 60 * 60 * 1000;
  const deadlineTime = new Date(classStart.getTime() - deadlineMs);
  const cutoffTime = new Date(deadlineTime.getTime() - 60 * 60 * 1000); // 1 hour before deadline

  if (now >= deadlineTime) return 'frozen';
  if (now >= cutoffTime) return 'first_come_first_claimed';
  return 'auto_promote';
}

export async function addToWaitlist(
  db: PrismaClient,
  classId: string,
  studentId: string,
): Promise<WaitlistEntry> {
  // Get the current max position
  const lastEntry = await db.waitlistEntry.findFirst({
    where: { classId, status: 'waiting' },
    orderBy: { position: 'desc' },
  });

  const position = (lastEntry?.position ?? 0) + 1;

  return db.waitlistEntry.create({
    data: {
      classId,
      studentId,
      position,
      status: 'waiting',
    },
  });
}

export async function removeFromWaitlist(
  db: PrismaClient,
  classId: string,
  studentId: string,
): Promise<void> {
  const entry = await db.waitlistEntry.findUnique({
    where: { classId_studentId: { classId, studentId } },
  });

  if (!entry || entry.status !== 'waiting') return;

  // Mark as removed
  await db.waitlistEntry.update({
    where: { id: entry.id },
    data: { status: 'removed' },
  });

  // Reorder remaining positions
  const remaining = await db.waitlistEntry.findMany({
    where: { classId, status: 'waiting' },
    orderBy: { position: 'asc' },
  });

  for (let i = 0; i < remaining.length; i++) {
    await db.waitlistEntry.update({
      where: { id: remaining[i]!.id },
      data: { position: i + 1 },
    });
  }
}

export async function promoteNext(
  db: PrismaClient,
  classId: string,
): Promise<WaitlistEntry | null> {
  const next = await db.waitlistEntry.findFirst({
    where: { classId, status: 'waiting' },
    orderBy: { position: 'asc' },
  });

  if (!next) return null;

  // Create a registration for the promoted student
  const cls = await db.class.findUniqueOrThrow({ where: { id: classId } });
  const student = await db.student.findUniqueOrThrow({ where: { id: next.studentId } });

  const registration = await db.registration.create({
    data: {
      classId,
      studentId: next.studentId,
      tierAtBooking: student.incomeTier,
      status: 'registered',
    },
  });

  // Update waitlist entry
  const updated = await db.waitlistEntry.update({
    where: { id: next.id },
    data: {
      status: 'promoted',
      promotedAt: new Date(),
      registrationId: registration.id,
    },
  });

  // Reorder remaining
  const remaining = await db.waitlistEntry.findMany({
    where: { classId, status: 'waiting' },
    orderBy: { position: 'asc' },
  });

  for (let i = 0; i < remaining.length; i++) {
    await db.waitlistEntry.update({
      where: { id: remaining[i]!.id },
      data: { position: i + 1 },
    });
  }

  return updated;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/waitlist.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/waitlist.ts src/services/waitlist.test.ts
git commit -m "feat: implement waitlist service with auto-promote and position management"
```

---

## Task 6: Notification Dispatcher

**Files:**
- Create: `src/services/notifications.ts`
- Create: `src/services/notifications.test.ts`

Creates notification records in the database. Email fallback scheduling: if a notification is not read within 30 minutes, it should be flagged for email delivery. The actual email sending is deferred to Phase 3 (Resend integration) — this service just creates records and manages the `emailSent` flag.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/services/notifications.test.ts
import { describe, it, expect } from 'vitest';
import {
  createNotification,
  createBulkNotifications,
  getUnreadForEmailFallback,
  markAsRead,
  type CreateNotificationInput,
} from './notifications';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('createNotification (integration)', () => {
  let teacherId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Notif',
        lastName: 'Teacher',
        email: `notif-teacher-${Date.now()}@test.com`,
        bio: 'Test',
        pageSlug: `notif-${Date.now()}`,
      },
    });
    teacherId = teacher.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { recipientId: teacherId },
    });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('creates a notification record', async () => {
    const notif = await createNotification(prisma, {
      recipientType: 'teacher',
      recipientId: teacherId,
      type: 'payment_received',
      title: 'Payment received',
      body: 'Anna paid for Vinyasa class.',
    });

    expect(notif.id).toBeDefined();
    expect(notif.isRead).toBe(false);
    expect(notif.emailSent).toBe(false);
    expect(notif.type).toBe('payment_received');
  });

  it('creates notification with related class', async () => {
    const notif = await createNotification(prisma, {
      recipientType: 'teacher',
      recipientId: teacherId,
      type: 'booking_confirmed',
      title: 'New booking',
      body: 'Someone booked.',
      relatedClassId: undefined, // no class link for this test
    });

    expect(notif.relatedClassId).toBeNull();
  });
});

describe('markAsRead (integration)', () => {
  let teacherId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Read',
        lastName: 'Teacher',
        email: `read-teacher-${Date.now()}@test.com`,
        bio: 'Test',
        pageSlug: `read-${Date.now()}`,
      },
    });
    teacherId = teacher.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { recipientId: teacherId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('marks a notification as read', async () => {
    const notif = await createNotification(prisma, {
      recipientType: 'teacher',
      recipientId: teacherId,
      type: 'reminder',
      title: 'Test',
      body: 'Test body',
    });

    await markAsRead(prisma, notif.id);

    const updated = await prisma.notification.findUniqueOrThrow({
      where: { id: notif.id },
    });
    expect(updated.isRead).toBe(true);
  });
});

describe('getUnreadForEmailFallback (integration)', () => {
  let teacherId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Fallback',
        lastName: 'Teacher',
        email: `fallback-teacher-${Date.now()}@test.com`,
        bio: 'Test',
        pageSlug: `fallback-${Date.now()}`,
      },
    });
    teacherId = teacher.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { recipientId: teacherId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('returns unread notifications older than threshold', async () => {
    // Create a notification with createdAt 31 minutes ago
    const thirtyOneMinAgo = new Date(Date.now() - 31 * 60 * 1000);
    await prisma.notification.create({
      data: {
        recipientType: 'teacher',
        recipientId: teacherId,
        type: 'reminder',
        title: 'Old unread',
        body: 'Should be returned',
        createdAt: thirtyOneMinAgo,
      },
    });

    // Create a recent notification (should NOT be returned)
    await prisma.notification.create({
      data: {
        recipientType: 'teacher',
        recipientId: teacherId,
        type: 'reminder',
        title: 'Recent',
        body: 'Too new',
      },
    });

    const results = await getUnreadForEmailFallback(prisma, 30);
    const forTeacher = results.filter((n) => n.recipientId === teacherId);
    expect(forTeacher).toHaveLength(1);
    expect(forTeacher[0]!.title).toBe('Old unread');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/notifications.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the notification service**

```typescript
// src/services/notifications.ts
import type { PrismaClient, RecipientType, NotificationType, Notification } from '@prisma/client';

export interface CreateNotificationInput {
  recipientType: RecipientType;
  recipientId: string;
  type: NotificationType;
  title: string;
  body: string;
  relatedClassId?: string;
}

export async function createNotification(
  db: PrismaClient,
  input: CreateNotificationInput,
): Promise<Notification> {
  return db.notification.create({
    data: {
      recipientType: input.recipientType,
      recipientId: input.recipientId,
      type: input.type,
      title: input.title,
      body: input.body,
      relatedClassId: input.relatedClassId ?? null,
    },
  });
}

export async function createBulkNotifications(
  db: PrismaClient,
  inputs: CreateNotificationInput[],
): Promise<number> {
  const result = await db.notification.createMany({
    data: inputs.map((input) => ({
      recipientType: input.recipientType,
      recipientId: input.recipientId,
      type: input.type,
      title: input.title,
      body: input.body,
      relatedClassId: input.relatedClassId ?? null,
    })),
  });
  return result.count;
}

export async function markAsRead(
  db: PrismaClient,
  notificationId: string,
): Promise<void> {
  await db.notification.update({
    where: { id: notificationId },
    data: { isRead: true },
  });
}

export async function getUnreadForEmailFallback(
  db: PrismaClient,
  thresholdMinutes: number = 30,
): Promise<Notification[]> {
  const threshold = new Date(Date.now() - thresholdMinutes * 60 * 1000);

  return db.notification.findMany({
    where: {
      isRead: false,
      emailSent: false,
      createdAt: { lt: threshold },
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function markEmailSent(
  db: PrismaClient,
  notificationIds: string[],
): Promise<void> {
  await db.notification.updateMany({
    where: { id: { in: notificationIds } },
    data: { emailSent: true },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/notifications.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/notifications.ts src/services/notifications.test.ts
git commit -m "feat: implement notification dispatcher with email fallback scheduling"
```

---

## Task 7: Payment Service

**Files:**
- Create: `src/services/payments.ts`
- Create: `src/services/payments.test.ts`

Manages payment lifecycle: creation from pricing output (already done in `completeClass`), status transitions (`pending → paid`, `pending → overdue`), and reminder tracking. Note: `completeClass` creates payments — this service handles everything after creation.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/services/payments.test.ts
import { describe, it, expect } from 'vitest';
import {
  markPaymentPaid,
  markPaymentOverdue,
  sendPaymentReminder,
  getOutstandingPayments,
} from './payments';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('payment service (integration)', () => {
  let registrationId: string;
  let paymentId: string;
  let teacherId: string;
  let studentId: string;
  let classId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Pay',
        lastName: 'Teacher',
        email: `pay-teacher-${Date.now()}@test.com`,
        bio: 'Test',
        pageSlug: `pay-${Date.now()}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Pay Room',
        address: `Pay Addr ${Date.now()}`,
        city: 'Test',
        postcode: '0000',
        floor: '1',
        roomName: `PayRoom ${Date.now()}`,
        maxCapacity: 20,
        createdById: teacherId,
      },
    });

    const tr = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 12, rentalRate: 35 },
    });

    const student = await prisma.student.create({
      data: {
        firstName: 'Pay',
        lastName: 'Student',
        email: `pay-student-${Date.now()}@test.com`,
        incomeTier: 3,
      },
    });
    studentId = student.id;

    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId: tr.id,
        classType: 'Test',
        date: new Date(),
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
    classId = cls.id;

    const reg = await prisma.registration.create({
      data: {
        classId: cls.id,
        studentId: student.id,
        tierAtBooking: 3,
        status: 'attended',
        price: 24.59,
        tierRatio: 1.0,
      },
    });
    registrationId = reg.id;

    const payment = await prisma.payment.create({
      data: {
        registrationId: reg.id,
        amount: 24.59,
        status: 'pending',
      },
    });
    paymentId = payment.id;
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { registrationId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.class.delete({ where: { id: classId } });
    await prisma.student.delete({ where: { id: studentId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('marks a payment as paid', async () => {
    await markPaymentPaid(prisma, paymentId, 'bank_transfer');

    const updated = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(updated.status).toBe('paid');
    expect(updated.method).toBe('bank_transfer');
    expect(updated.paidAt).not.toBeNull();
  });

  it('marks a payment as overdue', async () => {
    // Reset to pending first
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'pending', paidAt: null, method: null },
    });

    await markPaymentOverdue(prisma, paymentId);

    const updated = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(updated.status).toBe('overdue');
  });

  it('records payment reminder sent timestamp', async () => {
    await sendPaymentReminder(prisma, paymentId);

    const updated = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(updated.reminderSentAt).not.toBeNull();
  });

  it('gets outstanding payments for a teacher', async () => {
    // Reset status
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'pending' },
    });

    const outstanding = await getOutstandingPayments(prisma, teacherId);
    expect(outstanding.length).toBeGreaterThanOrEqual(1);
    expect(outstanding.some((p) => p.id === paymentId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/payments.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the payment service**

```typescript
// src/services/payments.ts
import type { PrismaClient, Payment } from '@prisma/client';

export async function markPaymentPaid(
  db: PrismaClient,
  paymentId: string,
  method: string,
): Promise<Payment> {
  return db.payment.update({
    where: { id: paymentId },
    data: {
      status: 'paid',
      method,
      paidAt: new Date(),
    },
  });
}

export async function markPaymentOverdue(
  db: PrismaClient,
  paymentId: string,
): Promise<Payment> {
  return db.payment.update({
    where: { id: paymentId },
    data: { status: 'overdue' },
  });
}

export async function sendPaymentReminder(
  db: PrismaClient,
  paymentId: string,
): Promise<Payment> {
  return db.payment.update({
    where: { id: paymentId },
    data: { reminderSentAt: new Date() },
  });
}

export async function getOutstandingPayments(
  db: PrismaClient,
  teacherId: string,
): Promise<Payment[]> {
  return db.payment.findMany({
    where: {
      status: { in: ['pending', 'overdue'] },
      registration: {
        class: { teacherId },
      },
    },
    include: {
      registration: {
        include: {
          student: { select: { firstName: true, lastName: true, email: true } },
          class: { select: { classType: true, date: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function getPaymentsForClass(
  db: PrismaClient,
  classId: string,
): Promise<Payment[]> {
  return db.payment.findMany({
    where: {
      registration: { classId },
    },
    include: {
      registration: {
        include: {
          student: { select: { firstName: true, lastName: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/payments.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/payments.ts src/services/payments.test.ts
git commit -m "feat: implement payment service with status transitions and reminders"
```

---

## Task 8: Class Generator

**Files:**
- Create: `src/services/class-generator.ts`
- Create: `src/services/class-generator.test.ts`

Generates class instances from active ClassTemplates on a rolling 4-week basis. Must be **idempotent** — running it multiple times for the same period does not create duplicates.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/services/class-generator.test.ts
import { describe, it, expect } from 'vitest';
import { generateClassInstances, getNextOccurrences } from './class-generator';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('getNextOccurrences', () => {
  it('returns 4 dates for a weekly class', () => {
    // dayOfWeek 1 = Tuesday
    // Starting from Monday 2026-04-06
    const from = new Date('2026-04-06');
    const dates = getNextOccurrences(1, from, 4);

    expect(dates).toHaveLength(4);
    // First Tuesday on or after April 6 = April 7
    expect(dates[0]!.toISOString().slice(0, 10)).toBe('2026-04-07');
    expect(dates[1]!.toISOString().slice(0, 10)).toBe('2026-04-14');
    expect(dates[2]!.toISOString().slice(0, 10)).toBe('2026-04-21');
    expect(dates[3]!.toISOString().slice(0, 10)).toBe('2026-04-28');
  });

  it('includes today if today matches the day of week', () => {
    // If from is a Tuesday and dayOfWeek is 1 (Tuesday)
    const tuesday = new Date('2026-04-07'); // a Tuesday
    const dates = getNextOccurrences(1, tuesday, 4);
    expect(dates[0]!.toISOString().slice(0, 10)).toBe('2026-04-07');
  });
});

describe('generateClassInstances (integration)', () => {
  let teacherId: string;
  let teacherRoomId: string;
  let templateId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Gen',
        lastName: 'Teacher',
        email: `gen-teacher-${Date.now()}@test.com`,
        bio: 'Test',
        pageSlug: `gen-${Date.now()}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Gen Room',
        address: `Gen Addr ${Date.now()}`,
        city: 'Test',
        postcode: '0000',
        floor: '1',
        roomName: `GenRoom ${Date.now()}`,
        maxCapacity: 20,
        createdById: teacherId,
      },
    });

    const tr = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 12, rentalRate: 35 },
    });
    teacherRoomId = tr.id;

    const template = await prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Vinyasa',
        dayOfWeek: 1, // Tuesday
        startTime: '09:00',
        durationMinutes: 75,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        isActive: true,
      },
    });
    templateId = template.id;
  });

  afterAll(async () => {
    await prisma.class.deleteMany({ where: { templateId } });
    await prisma.classTemplate.delete({ where: { id: templateId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('generates 4 class instances from a template', async () => {
    const created = await generateClassInstances(prisma, new Date('2026-04-06'));

    const classes = await prisma.class.findMany({
      where: { templateId },
      orderBy: { date: 'asc' },
    });

    expect(classes).toHaveLength(4);
    expect(classes[0]!.classType).toBe('Vinyasa');
    expect(classes[0]!.status).toBe('open');
    expect(classes[0]!.startTime).toBe('09:00');
    expect(Number(classes[0]!.roomCost)).toBe(35);
    expect(Number(classes[0]!.minRate)).toBe(15);
    expect(Number(classes[0]!.targetRate)).toBe(25);
  });

  it('is idempotent — running again does not create duplicates', async () => {
    await generateClassInstances(prisma, new Date('2026-04-06'));

    const classes = await prisma.class.findMany({
      where: { templateId },
    });

    // Still 4, not 8
    expect(classes).toHaveLength(4);
  });

  it('skips inactive templates', async () => {
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { isActive: false },
    });

    // Clean up existing classes to test from scratch
    await prisma.class.deleteMany({ where: { templateId } });

    await generateClassInstances(prisma, new Date('2026-04-06'));

    const classes = await prisma.class.findMany({
      where: { templateId },
    });

    expect(classes).toHaveLength(0);

    // Re-activate for cleanup
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { isActive: true },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/services/class-generator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the class generator**

```typescript
// src/services/class-generator.ts
import type { PrismaClient } from '@prisma/client';

/**
 * Returns the next `weeks` occurrences of a given day-of-week starting from `from`.
 * dayOfWeek: 0 = Monday, 6 = Sunday (ISO convention used in schema)
 */
export function getNextOccurrences(dayOfWeek: number, from: Date, weeks: number): Date[] {
  const dates: Date[] = [];
  const current = new Date(from);
  current.setHours(0, 0, 0, 0);

  // JavaScript: getDay() returns 0=Sunday, 1=Monday, ...
  // Schema: dayOfWeek 0=Monday, 1=Tuesday, ...
  // Convert schema dayOfWeek to JS getDay: (dayOfWeek + 1) % 7
  const jsDayOfWeek = (dayOfWeek + 1) % 7;

  // Find the first occurrence on or after `from`
  const currentDay = current.getDay();
  let daysUntil = jsDayOfWeek - currentDay;
  if (daysUntil < 0) daysUntil += 7;

  current.setDate(current.getDate() + daysUntil);

  for (let i = 0; i < weeks; i++) {
    dates.push(new Date(current));
    current.setDate(current.getDate() + 7);
  }

  return dates;
}

/**
 * Generates class instances for all active templates, rolling 4 weeks from `from`.
 * Idempotent: skips dates that already have a class for the same template.
 */
export async function generateClassInstances(
  db: PrismaClient,
  from: Date = new Date(),
): Promise<number> {
  const templates = await db.classTemplate.findMany({
    where: { isActive: true },
  });

  let createdCount = 0;

  for (const template of templates) {
    const dates = getNextOccurrences(template.dayOfWeek, from, 4);

    for (const date of dates) {
      // Check if a class already exists for this template + date
      const existing = await db.class.findFirst({
        where: {
          templateId: template.id,
          date,
        },
      });

      if (existing) continue;

      await db.class.create({
        data: {
          teacherId: template.teacherId,
          teacherRoomId: template.teacherRoomId,
          templateId: template.id,
          classType: template.classType,
          description: template.description,
          date,
          startTime: template.startTime,
          durationMinutes: template.durationMinutes,
          roomCost: template.roomCost,
          minRate: template.minRate,
          targetRate: template.targetRate,
          minStudents: template.minStudents,
          maxStudents: template.maxStudents,
          cancelDeadline: template.cancelDeadline,
          autoCancelCheck: template.autoCancelCheck,
          status: 'open', // Generated classes are immediately open for registration
        },
      });

      createdCount++;
    }
  }

  return createdCount;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/services/class-generator.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/class-generator.ts src/services/class-generator.test.ts
git commit -m "feat: implement idempotent class generator for rolling 4-week instances"
```

---

## Task 9: Run Full Test Suite & Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run the complete test suite**

```bash
npm test
```

Expected: All test files pass:
- `src/lib/smoke.test.ts` — 1 test
- `src/services/pricing.test.ts` — ~12 tests
- `src/services/class-lifecycle.test.ts` — ~8 tests
- `src/services/waitlist.test.ts` — ~5 tests
- `src/services/notifications.test.ts` — ~4 tests
- `src/services/payments.test.ts` — ~4 tests
- `src/services/class-generator.test.ts` — ~4 tests

- [ ] **Step 2: Run type check**

```bash
npx tsc --noEmit
```

Expected: No TypeScript errors.

- [ ] **Step 3: Run linter**

```bash
npm run lint
```

Expected: No lint errors.

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 5: Final commit if any cleanup needed**

```bash
git add -A
git status
# Only commit if there are changes
git commit -m "chore: Phase 2 cleanup and verification"
```

---

## Verification Checklist

- [ ] `npm test` — all services have passing test suites
- [ ] Pricing engine: seed data scenario (9 students, tiers [1,1,2,3,3,4,4,5,5]) produces effectiveTeacherRate=21.25, totalRevenue=226.25
- [ ] Pricing engine: walk-ins beyond max cap rate at targetRate
- [ ] Pricing engine: negative minRate, flat rate, single student all handled
- [ ] Class lifecycle: all valid transitions accepted, invalid rejected
- [ ] Class lifecycle: completeClass runs pricing and creates payments
- [ ] Waitlist: positions reorder correctly on removal
- [ ] Waitlist: getWaitlistWindow returns correct window for all 3 phases
- [ ] Notifications: creates records, markAsRead works, email fallback query works
- [ ] Payments: markPaid, markOverdue, sendReminder all update correctly
- [ ] Class generator: creates 4 instances, idempotent on re-run, skips inactive templates
- [ ] `npx tsc --noEmit` — zero type errors
- [ ] `npm run lint` — zero lint errors
- [ ] `npm run build` — builds successfully
