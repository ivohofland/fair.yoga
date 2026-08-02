import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const suffix = `tier-check-${Date.now()}`;
const studentIds: string[] = [];

afterAll(async () => {
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.$disconnect();
});

/**
 * These assert the DATABASE rejects the write, not that any TypeScript
 * guard does. `toIncomeTier` degrades rather than throwing precisely
 * because it trusts these constraints; if they are absent, that fallback
 * silently becomes load-bearing and nobody finds out.
 */
describe('income tier range constraints', () => {
  it('rejects an out-of-range Student.incomeTier on create', async () => {
    await expect(
      prisma.student.create({
        data: {
          firstName: 'Out', lastName: 'OfRange',
          email: `out-of-range-${suffix}@test.local`,
          incomeTier: 0,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects an out-of-range Student.incomeTier on update', async () => {
    const student = await prisma.student.create({
      data: {
        firstName: 'In', lastName: 'Range',
        email: `in-range-${suffix}@test.local`,
        incomeTier: 3,
      },
    });
    studentIds.push(student.id);

    await expect(
      prisma.student.update({ where: { id: student.id }, data: { incomeTier: 6 } }),
    ).rejects.toThrow();

    // The row is untouched — a rejected write is not a partial write.
    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(after.incomeTier).toBe(3);
  });

  it('accepts both boundaries', async () => {
    for (const tier of [1, 5]) {
      const student = await prisma.student.create({
        data: {
          firstName: 'Edge', lastName: `T${tier}`,
          email: `edge-${tier}-${suffix}@test.local`,
          incomeTier: tier,
        },
      });
      studentIds.push(student.id);
      expect(student.incomeTier).toBe(tier);
    }
  });
});
