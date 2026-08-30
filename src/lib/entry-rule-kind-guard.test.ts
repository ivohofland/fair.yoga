import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { classifyApiError } from './api-errors';
import { hhmmToTime } from './time-of-day';

/**
 * Pure DB-invariant tests for issue 328's triggers:
 * - `entry_rule_kind_mismatch_guard` on CalendarEntry
 * - `schedule_rule_kind_immutability_guard` on ScheduleRule
 *
 * `CalendarEntry.scheduleRuleId` is the single-column edge into a kind-discriminated
 * parent (`ScheduleRule`). Prisma cannot express a composite FK with
 * `ON DELETE SET NULL ("scheduleRuleId")`, so these triggers enforce kind consistency
 * and rule kind immutability at the database level.
 *
 * Manual mutation-proof recipe (against DATABASE_URL_TEST):
 *
 *   docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test \
 *     -c 'DROP TRIGGER entry_rule_kind_mismatch_guard ON "CalendarEntry";'
 *   npx vitest run --project unit src/lib/entry-rule-kind-guard.test.ts
 *   # First test fails: mismatch is silently accepted without throwing 23514
 *
 * To restore:
 *
 *   docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test -c \
 *     'CREATE TRIGGER entry_rule_kind_mismatch_guard
 *        BEFORE INSERT OR UPDATE OF "scheduleRuleId", "kind"
 *        ON "CalendarEntry" FOR EACH ROW
 *        EXECUTE FUNCTION entry_reject_rule_kind_mismatch();'
 */
const prisma = new PrismaClient();
const suffix = `rule-kind-guard-${Date.now()}`;

let teacherId: string;
let accountId: string;
let regularRuleId: string;
let studioRuleId: string;

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

beforeAll(async () => {
  await prisma.$connect();

  const email = `rule-kind-guard-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'RuleKind',
      lastName: 'Guard',
      email,
      bio: 'test fixture',
      pageSlug: `rule-kind-guard-${suffix}`,
      account: { create: { email } },
    },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;

  const regularRule = await prisma.scheduleRule.create({
    data: {
      teacherId,
      kind: 'regular',
      classType: 'Regular Rule',
      dayOfWeek: 1,
      startTime: hhmmToTime('08:00'),
      durationMinutes: 60,
    },
  });
  regularRuleId = regularRule.id;

  const studioRule = await prisma.scheduleRule.create({
    data: {
      teacherId,
      kind: 'studio',
      classType: 'Studio Rule',
      dayOfWeek: 2,
      startTime: hhmmToTime('10:00'),
      durationMinutes: 60,
    },
  });
  studioRuleId = studioRule.id;
});

afterAll(async () => {
  await prisma.calendarEntry.deleteMany({ where: { teacherId } });
  await prisma.scheduleRule.deleteMany({ where: { teacherId } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: accountId } });
  await prisma.$disconnect();
});

describe('entry_rule_kind_mismatch_guard', () => {
  it('refuses inserting a regular entry referencing a studio rule', async () => {
    let caught: unknown;
    try {
      await prisma.calendarEntry.create({
        data: {
          teacherId,
          kind: 'regular',
          classType: 'Mismatched Entry',
          date: day('2099-07-01'),
          startTime: hhmmToTime('08:00'),
          durationMinutes: 60,
          scheduleRuleId: studioRuleId,
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(String(caught)).toMatch(/23514/);
    expect(String(caught)).toMatch(/which is terminal/);
    expect(String(caught)).toMatch(/cannot attach to mismatched rule kind/);

    const classification = classifyApiError(caught);
    expect(classification.status).toBe(409);
    expect(classification.detail).toEqual({ trigger: 'entry_rule_kind' });
  });

  it('refuses inserting a studio entry referencing a regular rule', async () => {
    let caught: unknown;
    try {
      await prisma.calendarEntry.create({
        data: {
          teacherId,
          kind: 'studio',
          classType: 'Mismatched Studio Entry',
          date: day('2099-07-02'),
          startTime: hhmmToTime('08:00'),
          durationMinutes: 60,
          scheduleRuleId: regularRuleId,
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(String(caught)).toMatch(/23514/);
    expect(String(caught)).toMatch(/which is terminal/);
    expect(String(caught)).toMatch(/cannot attach to mismatched rule kind/);

    const classification = classifyApiError(caught);
    expect(classification.status).toBe(409);
    expect(classification.detail).toEqual({ trigger: 'entry_rule_kind' });
  });

  it('refuses updating an entry to point at a rule of the wrong kind', async () => {
    const entry = await prisma.calendarEntry.create({
      data: {
        teacherId,
        kind: 'regular',
        classType: 'Valid Regular Entry',
        date: day('2099-07-03'),
        startTime: hhmmToTime('08:00'),
        durationMinutes: 60,
        scheduleRuleId: regularRuleId,
      },
    });

    let caught: unknown;
    try {
      await prisma.calendarEntry.update({
        where: { id: entry.id },
        data: { scheduleRuleId: studioRuleId },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(String(caught)).toMatch(/23514/);
    expect(String(caught)).toMatch(/which is terminal/);
    expect(String(caught)).toMatch(/cannot attach to mismatched rule kind/);
  });

  it('allows entries with scheduleRuleId: null to insert and update freely', async () => {
    const entry = await prisma.calendarEntry.create({
      data: {
        teacherId,
        kind: 'regular',
        classType: 'Manual Class Entry',
        date: day('2099-07-04'),
        startTime: hhmmToTime('08:00'),
        durationMinutes: 60,
        scheduleRuleId: null,
      },
    });

    expect(entry.id).toBeDefined();
    expect(entry.scheduleRuleId).toBeNull();

    const updated = await prisma.calendarEntry.update({
      where: { id: entry.id },
      data: { classType: 'Updated Manual Class Entry' },
    });

    expect(updated.classType).toBe('Updated Manual Class Entry');
    expect(updated.scheduleRuleId).toBeNull();
  });
});

describe('schedule_rule_kind_immutability_guard', () => {
  it('refuses updating ScheduleRule.kind after creation', async () => {
    let caught: unknown;
    try {
      await prisma.scheduleRule.update({
        where: { id: regularRuleId },
        data: { kind: 'studio' },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(String(caught)).toMatch(/23514/);
    expect(String(caught)).toMatch(/which is terminal/);
    expect(String(caught)).toMatch(/cannot change its kind/);

    const classification = classifyApiError(caught);
    expect(classification.status).toBe(409);
    expect(classification.detail).toEqual({ trigger: 'rule_kind' });
  });

  it('permits updating other ScheduleRule fields while kind is unchanged', async () => {
    const updated = await prisma.scheduleRule.update({
      where: { id: regularRuleId },
      data: { classType: 'Renamed Regular Rule', kind: 'regular' },
    });

    expect(updated.classType).toBe('Renamed Regular Rule');
    expect(updated.kind).toBe('regular');
  });
});
