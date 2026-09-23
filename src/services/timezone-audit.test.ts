import { describe, it, expect, vi, beforeAll, onTestFinished } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { log } from '@/lib/log';
import { auditTeacherTimezones, InvalidTimezoneError } from './timezone-audit';
import type { TimezoneAuditSummary } from './timezone-audit';
import { scopeSweep } from '../../tests/scoped-sweep';

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
 * THIS FILE RUNS IN THE PARALLEL `unit` TIER, so a test that calls
 * `auditTeacherTimezones` passes it a client scoped (`scopeSweep`) to the
 * teacher ids this file itself created — a concurrent file creates teachers
 * freely, earlier runs leave live ones behind, and `auditTeacherTimezones`'s
 * own `groupBy` reads every live one regardless of where it came from. Scoping is what makes an exact `checked`
 * or `teachers` count safe, and what keeps a test whose call is not wrapped
 * in `.rejects` from throwing over a concurrent file's own bad zone.
 *
 * It stays out of `SWEEP_TESTS` because that list's membership rule is
 * "a sweep that WRITES rows it was never handed" (vitest.tiers.ts) and this
 * sweep writes nothing at all. What it does do is READ database-wide when
 * unscoped, which is why every call here passes a scoped client instead.
 */
beforeAll(async () => {
  // Hygiene: removes sentinel teachers a crashed run left behind. The scoped
  // calls below cannot see them, so nothing here depends on this.
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
    const teacherId = await seedTeacher('good', 'America/Los_Angeles');
    const scoped = scopeSweep(prisma, { Teacher: { id: { in: [teacherId] } } });
    const summary = await auditTeacherTimezones(scoped.db);
    // Scoped to this fixture's own teacher: `checked` counts only its one
    // zone regardless of what else is live in the shared database.
    expect(summary).toBeDefined();
    expect(summary.checked).toBe(1);
  });

  it('names an unresolvable stored zone and throws', async () => {
    const teacherId = await seedTeacher('bad', SENTINEL);
    const scoped = scopeSweep(prisma, { Teacher: { id: { in: [teacherId] } } });
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => { vi.restoreAllMocks(); });
    await expect(auditTeacherTimezones(scoped.db)).rejects.toThrow(InvalidTimezoneError);
  });

  it('carries the offending zone on the error, so the log line names it', async () => {
    const teacherId = await seedTeacher('named', SENTINEL);
    const scoped = scopeSweep(prisma, { Teacher: { id: { in: [teacherId] } } });
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());
    await expect(auditTeacherTimezones(scoped.db)).rejects.toMatchObject({
      zones: expect.arrayContaining([SENTINEL]),
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ invalid: expect.arrayContaining([SENTINEL]) }),
      expect.stringContaining('unresolvable'),
    );
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
    const scoped = scopeSweep(prisma, { Teacher: { id: { in: [id] } } });
    expect(await scoped.db.teacher.count()).toBe(1);
    const summary = await auditTeacherTimezones(scoped.db);
    expect(summary.invalid).not.toContain(SENTINEL);
    expect(summary.checked).toBe(0);
  });

  it('counts every live teacher holding a bad zone, not just the distinct zones', async () => {
    const idA = await seedTeacher('dup-a', SENTINEL);
    const idB = await seedTeacher('dup-b', SENTINEL);
    const scoped = scopeSweep(prisma, { Teacher: { id: { in: [idA, idB] } } });
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());
    await expect(auditTeacherTimezones(scoped.db)).rejects.toThrow(InvalidTimezoneError);

    // Scoped to idA/idB: the audit reads only these two teachers regardless
    // of what else is live in the shared database, so `teachers` is exact.
    expect(error).toHaveBeenCalledTimes(1);
    const [summary, message] = error.mock.calls[0] as [TimezoneAuditSummary, string];
    expect(summary).toMatchObject({
      invalid: expect.arrayContaining([SENTINEL]),
    });
    expect(summary.teachers).toBe(2);
    expect(message).toContain('unresolvable');
  });
});
