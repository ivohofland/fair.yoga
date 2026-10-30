import { describe, it, expect, afterAll } from 'vitest';
import { createPrismaClient } from '@/lib/prisma-client';

const prisma = createPrismaClient();
const suffix = `share-schema-${Date.now()}`;

afterAll(async () => {
  await prisma.teacher.deleteMany({ where: { pageSlug: { startsWith: suffix } } });
  await prisma.account.deleteMany({ where: { email: { startsWith: suffix } } });
  await prisma.$disconnect();
});

let counter = 0;

async function makeTeacher(): Promise<string> {
  const tag = `${suffix}-${counter++}`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Share',
      lastName: 'Schema',
      email: `${tag}@test.local`,
      account: { create: { email: `${tag}@test.local` } },
      bio: 'Schedule share fixture',
      pageSlug: tag,
    },
  });
  return teacher.id;
}

describe('schedule sharing columns (#916)', () => {
  it('a fresh teacher has sharing off, four weeks and no studio classes', async () => {
    const id = await makeTeacher();
    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id } });
    expect(teacher.scheduleShareKey).toBeNull();
    expect(teacher.scheduleShareWeeks).toBe(4);
    expect(teacher.scheduleShareStudio).toBe(false);
  });

  it.each([0, 5])('refuses scheduleShareWeeks = %i with the named CHECK', async (weeks) => {
    const id = await makeTeacher();
    await expect(
      prisma.teacher.update({ where: { id }, data: { scheduleShareWeeks: weeks } }),
    ).rejects.toThrow(/Teacher_schedule_share_weeks_range/);
  });

  it.each([1, 4])('accepts scheduleShareWeeks = %i', async (weeks) => {
    const id = await makeTeacher();
    const updated = await prisma.teacher.update({ where: { id }, data: { scheduleShareWeeks: weeks } });
    expect(updated.scheduleShareWeeks).toBe(weeks);
  });
});
