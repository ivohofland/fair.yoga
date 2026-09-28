import type { PrismaClient } from '@prisma/client';
import { expect } from 'vitest';
import { runWaitlistReconciliationTick, type SkipReason } from '@/services/waitlist-reconciliation';
import { scopeSweep } from './scoped-sweep';

/**
 * Runs the production reconciliation tick narrowed to `classIds` and asserts
 * it skipped every one of them for `reason`.
 *
 * Call this after building a fixture that writes a `waiting` `WaitlistEntry`
 * directly and before the test's own action, so a class the running app's
 * scheduler would otherwise promote or broadcast on is caught here instead of
 * silently mutated mid-test. See `docs/test-database.md` §3.4.
 */
export async function expectReconciliationSkips(
  prisma: PrismaClient,
  classIds: readonly string[],
  reason: SkipReason,
): Promise<void> {
  expect(classIds.length).toBeGreaterThan(0);
  const scoped = scopeSweep(prisma, { WaitlistEntry: { classId: { in: [...classIds] } } });
  const summary = await runWaitlistReconciliationTick(scoped.db);
  for (const classId of classIds) {
    expect(summary.skipped).toContainEqual({ classId, reason });
  }
  expect(summary.reconciledClassIds.filter((id) => classIds.includes(id))).toEqual([]);
}

/**
 * Creates `count` students with an active (`registered`) registration on
 * `classId`. Emails are `${tag}-filler-${i}@test.local`. Returns their ids for
 * teardown. Deleting the students cascades their registrations.
 */
export async function fillSeats(
  prisma: PrismaClient,
  classId: string,
  count: number,
  tag: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const student = await prisma.student.create({
      data: {
        firstName: 'Filler',
        lastName: tag,
        email: `${tag}-filler-${i}@test.local`,
        incomeTier: 3,
        registrations: {
          create: { classId, status: 'registered', tierAtBooking: 3 },
        },
      },
    });
    ids.push(student.id);
  }
  return ids;
}
