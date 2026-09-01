import { describe, it, expect, vi, beforeAll, onTestFinished } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { log } from '@/lib/log';
import { auditTeacherTimezones, InvalidTimezoneError } from './timezone-audit';

const prisma = new PrismaClient();
const uniqueSuffix = `tza-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * `Invalid/` is not one of IANA's ten areas, so no tzdata release can turn
 * this into a resolvable zone — the reserved-value rule, applied to timezones.
 * A plausible-looking string such as `Europe/Atlantis` would be a worse
 * choice for the same reason RFC 5737 addresses beat made-up ones.
 */
const SENTINEL = 'Invalid/Test_Zone_145';

/**
 * THIS FILE RUNS IN THE PARALLEL `unit` TIER, so every assertion below is
 * scoped to its own fixture. It must never assert that the database holds
 * ZERO bad zones, nor an exact `checked` count: concurrent files create
 * teachers freely, and a global assertion would be measuring them.
 *
 * It stays out of `SWEEP_TESTS` because that list's membership rule is
 * "a sweep that WRITES rows it was never handed" (vitest.config.ts) and this
 * sweep writes nothing at all. What it does do is READ database-wide, which
 * is why the containment-only discipline above is load-bearing rather than
 * stylistic.
 */
beforeAll(async () => {
  // Defence against a previous crashed run leaving a sentinel teacher behind:
  // one would make every later run of this file's clean case throw.
  const stale = await prisma.teacher.findMany({
    where: { defaultTimezone: SENTINEL },
    select: { id: true, accountId: true },
  });
  for (const t of stale) {
    await prisma.teacher.delete({ where: { id: t.id } });
    await prisma.account.delete({ where: { id: t.accountId } });
  }
});

async function seedTeacher(label: string, defaultTimezone: string): Promise<string> {
  const email = `${uniqueSuffix}-${label}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: label,
      lastName: 'Teacher',
      email,
      account: { create: { email } },
      bio: `timezone audit fixture ${label}`,
      pageSlug: `${uniqueSuffix}-${label}`,
      defaultTimezone,
    },
  });
  // Account too — an orphaned Account row is what #177 cleaned up across the
  // suite's fixtures.
  onTestFinished(async () => {
    await prisma.teacher.delete({ where: { id: teacher.id } }).catch(() => {});
    await prisma.account.delete({ where: { id: teacher.accountId } }).catch(() => {});
  });
  return teacher.id;
}

describe('auditTeacherTimezones', () => {
  it('returns a summary and does not throw when every live zone resolves', async () => {
    await seedTeacher('good', 'America/Los_Angeles');
    const summary = await auditTeacherTimezones(prisma);
    // This fixture only seeds a valid zone, so we assert the function resolves.
    // We do NOT assert summary.invalid is globally empty nor summary.teachers is
    // globally zero — other concurrent tests may seed bad zones, making any global
    // zero-count assertion a latent flake. Only the `checked` lower bound is
    // fixture-scoped and assertable.
    expect(summary).toBeDefined();
    expect(summary.checked).toBeGreaterThanOrEqual(1);
  });

  it('names an unresolvable stored zone and throws', async () => {
    await seedTeacher('bad', SENTINEL);
    await vi.spyOn(log, 'error').mockImplementation(() => undefined);
    await expect(auditTeacherTimezones(prisma)).rejects.toThrow(InvalidTimezoneError);
    vi.restoreAllMocks();
  });

  it('carries the offending zone on the error, so the log line names it', async () => {
    await seedTeacher('named', SENTINEL);
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    await expect(auditTeacherTimezones(prisma)).rejects.toMatchObject({
      zones: expect.arrayContaining([SENTINEL]),
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ invalid: expect.arrayContaining([SENTINEL]) }),
      expect.stringContaining('unresolvable'),
    );
    vi.restoreAllMocks();
  });

  /**
   * Erasure soft-deletes and leaves `defaultTimezone` untouched
   * (`gdpr.ts`'s teacher `updateMany` writes twelve fields and not this one),
   * so a soft-deleted teacher's stale zone must not flag: nothing reads it —
   * `validateSession` resolves only live profiles — and there is nothing an
   * operator could do about it.
   */
  it('ignores soft-deleted teachers', async () => {
    const id = await seedTeacher('erased', SENTINEL);
    await prisma.teacher.update({ where: { id }, data: { deletedAt: new Date() } });
    const summary = await auditTeacherTimezones(prisma);
    expect(summary.invalid).not.toContain(SENTINEL);
  });

  it('counts every live teacher holding a bad zone, not just the distinct zones', async () => {
    await seedTeacher('dup-a', SENTINEL);
    await seedTeacher('dup-b', SENTINEL);
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    await expect(auditTeacherTimezones(prisma)).rejects.toThrow(InvalidTimezoneError);

    // Fixture-scoped assertions: we created two teachers with SENTINEL, so:
    // - SENTINEL must be in invalid (but other concurrent bad zones may exist too)
    // - teachers >= 2 (proves both my duplicate SENTINEL teachers were counted)
    // Changing from exact match to fixture-scoped prevents latent flakes from
    // concurrent tests seeding unrelated bad zones into the shared database.
    expect(error).toHaveBeenCalledTimes(1);
    const [summary, message] = error.mock.calls[0];
    expect(summary).toMatchObject({
      invalid: expect.arrayContaining([SENTINEL]),
    });
    expect(summary.teachers).toBeGreaterThanOrEqual(2);
    expect(message).toContain('unresolvable');
    vi.restoreAllMocks();
  });
});
