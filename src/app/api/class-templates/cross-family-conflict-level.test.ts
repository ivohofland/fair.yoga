import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * ONE thing: that `POST /api/class-templates` still answers `YG001` from
 * generation's own `Class` insert with the instance-level sentence, even
 * though issue 298 removed the only OTHER thing this file used to test.
 *
 * WHY THIS IS MOCKED, and why that is the point — the same argument
 * `api/cron/daily-cleanup/route.test.ts` makes, for a stronger reason.
 *
 * Before issue 298 this catch could be reached by `YG001` from TWO different
 * statements — the template's own insert (a live studio TEMPLATE holds this
 * weekday slot) or generation's `Class` insert (a live studio CLASS holds one
 * of the dates) — and a `conflict.level` object told them apart so each got
 * its own sentence. The template-level trigger that raised the FIRST one is
 * gone: issue 298 replaced it with `ScheduleRule_teacher_slot_excl`, which
 * raises `23P01`, not `YG001` — caught by `isExclusionConflictOn` earlier in
 * this same catch, never reaching the branch below. So `conflict.level` had
 * only one value left to carry, and the object that carried it is gone too
 * (see the route's own comment where it stood).
 *
 * What is left, and why it still needs a mock: generation's race is covered
 * end-to-end nowhere else. The generator pre-checks the sibling table with
 * the same predicate the trigger carries, so a pre-existing studio class is
 * SKIPPED (`blocked_by_other_family`) and never reaches the insert. The only
 * way generation raises is a row committing inside the window between that
 * pre-check's `findMany` and its `createManyAndReturn` — the race
 * `docs/lock-order.md` records as knowingly accepted. An integration test
 * cannot stage it against a live app; this file forces it instead.
 *
 * Nothing here asserts wiring — not that the route calls the generator, not
 * what the generator did. Only that a `YG001` reaching this catch still maps
 * to the instance-level sentence.
 */

const generateInstancesForTemplate = vi.fn();
const warn = vi.fn();

vi.mock('@/services/class-generator', () => ({
  generateInstancesForTemplate: (...args: unknown[]) => generateInstancesForTemplate(...args),
}));
vi.mock('@/lib/log', () => ({ log: { warn: (...a: unknown[]) => warn(...a), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireTeacher: async () => ({ teacherId: 'teacher-1', accountId: 'acct-1' }) };
});

const classTemplateCreate = vi.fn();
vi.mock('@/lib/db', () => ({
  prisma: {
    teacherRoom: { findUnique: async () => ({ id: 'room-1', teacherId: 'teacher-1' }) },
    // Runs the callback inline and lets its rejection propagate, which is what
    // Prisma does — the point of the fixture is that the route sees the error
    // the callback threw.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ classTemplate: { create: (...a: unknown[]) => classTemplateCreate(...a) } }),
  },
}));

/** The shape a typed model call produces — see `lib/cross-family-conflict.ts`. */
function yg001(tail: string): Error {
  return new Error(
    'Invalid `prisma.class.createManyAndReturn()` invocation\n' +
      'Error occurred during query execution:\n' +
      'ConnectorError(ConnectorError { user_facing_error: None, kind: ' +
      `QueryError(PostgresError { code: "YG001", message: "${tail}", ` +
      'severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
  );
}

const body = {
  teacherRoomId: '11111111-1111-4111-8111-111111111111',
  classType: 'Vinyasa',
  dayOfWeek: 2,
  startTime: '09:00',
  durationMinutes: 60,
  roomCost: 20,
  minRate: 30,
  targetRate: 60,
  minStudents: 3,
  maxStudents: 10,
};

const post = async () => {
  const { POST } = await import('./route');
  return POST(
    new NextRequest('http://localhost:3000/api/class-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  classTemplateCreate.mockResolvedValue({ id: 'tpl-1', teacher: { defaultTimezone: 'UTC' } });
});

describe('POST /api/class-templates — the race integration cannot stage', () => {
  it('words a GENERATION-time conflict for the instance family, and logs it', async () => {
    generateInstancesForTemplate.mockRejectedValue(
      yg001('Teacher teacher-1 already has a live studio class (sc-1) at 2031-05-06 09:00'),
    );

    const res = await post();

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: { message: string; code: string } };
    expect(payload.error.code).toBe('CROSS_FAMILY_STUDIO_SLOT');
    // NOT "recurring studio class" — the blocker is a one-off.
    expect(payload.error.message).not.toMatch(/recurring/i);
    expect(payload.error.message).toMatch(/studio class/i);

    // Logged so the accepted race stays countable in production — no
    // `conflictLevel` any more: with only one reachable raiser left, a field
    // whose entire job was telling two apart has nothing left to say.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: 'teacher-1' }),
      'recurring class create refused: the studio family holds that slot',
    );
  });
});
