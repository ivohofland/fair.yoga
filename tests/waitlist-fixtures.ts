import type { PrismaClient } from '@prisma/client';
import { expect } from 'vitest';
import { runWaitlistReconciliationTick, type SkipReason } from '@/services/waitlist-reconciliation';
import { scopeSweep } from './scoped-sweep';

/**
 * Runs the production reconciliation tick narrowed to `classIds` (must be
 * non-empty) and asserts it skipped every one of them for `reason`.
 *
 * Call it once the fixture holds the state it needs — after any direct
 * `waiting` write or direct seat-free (`docs/test-database.md` §3.4) — and
 * before any span the sweep could act in; where the entry only appears inside
 * the test's action, once that action is over. A class the running app's own
 * scheduler would otherwise promote or broadcast on at some unpredictable
 * point mid-test does so here instead, under this call's own tick — and the
 * assertion below fails loudly, rather than the fixture being silently
 * mutated later by the live app.
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
 * `classId`, in one transaction, so a failure part-way creates none of them.
 * Emails are `${tag}-filler-${i}@test.local`. Returns their ids for teardown.
 * Deleting the students cascades their registrations.
 */
export async function fillSeats(
  prisma: PrismaClient,
  classId: string,
  count: number,
  tag: string,
): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const student = await tx.student.create({
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
  });
}
