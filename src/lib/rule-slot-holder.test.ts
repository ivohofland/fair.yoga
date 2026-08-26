import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ruleSlotHolder } from './rule-slot-holder';

const prisma = new PrismaClient();
const suffix = `holder-${Date.now()}`;
let teacherId: string;
let otherTeacherId: string;
const accountIds: string[] = [];

async function makeTeacher(tag: string): Promise<string> {
  const email = `${tag}-${suffix}@test.local`;
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Holder', lastName: tag, email, bio: 'rule slot holder fixture',
      pageSlug: `${tag}-${suffix}`, account: { create: { email } },
    },
  });
  accountIds.push(t.accountId);
  return t.id;
}

beforeAll(async () => {
  await prisma.$connect();
  teacherId = await makeTeacher('owner');
  otherTeacherId = await makeTeacher('other');
});

afterAll(async () => {
  const teachers = [teacherId, otherTeacherId];
  await prisma.scheduleRule.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teachers } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

const at = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);

const rule = (teacher: string, over: Record<string, unknown> = {}) => ({
  teacherId: teacher, kind: 'regular' as const, classType: 'Yoga',
  dayOfWeek: 1, startTime: at('05:00'), durationMinutes: 60, ...over,
});

// Each case sits on its own dayOfWeek — this file's fixture shape is
// `schedule-rule-constraints.test.ts`'s, and that file's own isolation is
// disjoint (dayOfWeek, slot) pairs rather than weekday alone; a fresh day per
// case here is simply the cheapest way to get that with only eight cases.
describe('ruleSlotHolder', () => {
  it('names the regular family when a live regular rule overlaps', async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 1 }) });
    const holder = await ruleSlotHolder(prisma, {
      teacherId, dayOfWeek: 1, startMinutes: 5 * 60 + 15, durationMinutes: 30,
    });
    expect(holder).toBe('regular');
  });

  it('names the studio family when a live studio rule overlaps', async () => {
    await prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 2, kind: 'studio' }),
    });
    const holder = await ruleSlotHolder(prisma, {
      teacherId, dayOfWeek: 2, startMinutes: 5 * 60 + 15, durationMinutes: 30,
    });
    expect(holder).toBe('studio');
  });

  it('answers unknown for an ARCHIVED rule — archiving frees it', async () => {
    await prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 3, isArchived: true, archivedAt: new Date() }),
    });
    const holder = await ruleSlotHolder(prisma, {
      teacherId, dayOfWeek: 3, startMinutes: 5 * 60 + 15, durationMinutes: 30,
    });
    expect(holder).toBe('unknown');
  });

  it('names the kind of a PAUSED rule, not unknown — pausing does not free the slot', async () => {
    await prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 4, isActive: false }),
    });
    const holder = await ruleSlotHolder(prisma, {
      teacherId, dayOfWeek: 4, startMinutes: 5 * 60 + 15, durationMinutes: 30,
    });
    expect(holder).toBe('regular');
  });

  it('answers unknown for a rule starting exactly where the probe ends — half-open', async () => {
    // The rule occupies [360, 420) (dayOfWeek 5's default 05:00+60 shifted to
    // 06:00 here). The probe is [300, 360) — its own UPPER bound is what the
    // `'[)'` in the query builds, so this is the case (not the mirror, where
    // a rule's own fixed generated-column bound is what would decide it) that
    // is actually sensitive to that bound's character: `'[)'` → `'[]'` turns
    // the probe into [300, 361), which DOES reach the rule's 360 and would
    // wrongly report its kind instead of `'unknown'`.
    await prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 5, startTime: at('06:00') }),
    });
    const holder = await ruleSlotHolder(prisma, {
      teacherId, dayOfWeek: 5, startMinutes: 5 * 60, durationMinutes: 60,
    });
    expect(holder).toBe('unknown');
  });

  it('answers unknown for a rule on a different dayOfWeek', async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 6 }) });
    const holder = await ruleSlotHolder(prisma, {
      // dayOfWeek 0 has no rule for this teacher at all.
      teacherId, dayOfWeek: 0, startMinutes: 5 * 60 + 15, durationMinutes: 30,
    });
    expect(holder).toBe('unknown');
  });

  it('answers unknown for another teacher\'s overlapping rule', async () => {
    // dayOfWeek 0: the only day `teacherId` has not already claimed above —
    // this case's whole point is that `otherTeacherId`'s rule there must NOT
    // be seen when the probe asks about `teacherId`.
    await prisma.scheduleRule.create({ data: rule(otherTeacherId, { dayOfWeek: 0 }) });
    const holder = await ruleSlotHolder(prisma, {
      teacherId, dayOfWeek: 0, startMinutes: 5 * 60 + 15, durationMinutes: 30,
    });
    expect(holder).toBe('unknown');
  });

  it('answers unknown when excludeRuleId names the only overlapping rule', async () => {
    const mover = await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 0 }) });
    const holder = await ruleSlotHolder(prisma, {
      teacherId, dayOfWeek: 0, startMinutes: 5 * 60 + 15, durationMinutes: 30,
      excludeRuleId: mover.id,
    });
    expect(holder).toBe('unknown');
  });

  /**
   * Both call sites run this INSIDE a `catch` block — `api/class-templates`
   * and `api/studio-class-templates`, each after
   * `ScheduleRule_teacher_slot_excl` has already refused their write and each
   * having already decided on 409. A throw from here escapes that catch,
   * reaches `withErrorHandler` and answers 5xx: a write the database correctly
   * refused, reported as one that may have happened.
   *
   * A pool or lock timeout on this extra query is the realistic failure and not
   * a hypothetical one — it is likeliest under exactly the contention that
   * produced the conflict. `probeConflictingEntry` (`./entry-conflict`) carries
   * the same contract one layer down and has carried it since #327; this is
   * the sibling that did not.
   */
  it('answers unknown rather than throwing when the query itself fails', async () => {
    const spy = vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('connection reset'));
    try {
      await expect(ruleSlotHolder(prisma, {
        teacherId, dayOfWeek: 2, startMinutes: 9 * 60, durationMinutes: 60,
      })).resolves.toBe('unknown');
    } finally {
      spy.mockRestore();
    }
  });
});
