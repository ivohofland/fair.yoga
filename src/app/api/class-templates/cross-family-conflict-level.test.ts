import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * ONE thing: that if a `YG001` reached `POST /api/class-templates`'s catch, it
 * would still map to the instance-level sentence rather than the template-level
 * one.
 *
 * NOTHING RAISES `YG001` SINCE #327, so this pins a mapping the app can no
 * longer exercise. The route's own comment beside that arm says the same, and
 * `docs/lock-order.md` ("One teacher, one slot") carries the census and the
 * query that re-derives it. This file lives or dies with the arm: removing the
 * arm is a change to what the endpoint answers, and this test goes with it.
 *
 * WHY IT IS MOCKED, kept because the argument is what made the mock legitimate
 * rather than lazy — the same one `api/cron/daily-cleanup/route.test.ts` makes.
 * Before issue 298 this catch could be reached by `YG001` from TWO different
 * statements — the template's own insert (a live studio TEMPLATE holds this
 * weekday slot) or generation's `Class` insert (a live studio CLASS holds one
 * of the dates) — and a `conflict.level` object told them apart so each got
 * its own sentence. Issue 298 replaced the template-level trigger with
 * `ScheduleRule_teacher_slot_excl`, which raises `23P01`, caught by
 * `isExclusionConflictOn` earlier in this same catch; #327 replaced the
 * entry-level ones with `CalendarEntry_teacher_slot_excl` and left generation
 * unable to raise anything at all, its entry insert being an
 * `ON CONFLICT DO NOTHING`. So `conflict.level` lost its second value at #298
 * and its first at #327.
 *
 * Nothing here asserts wiring — not that the route calls the generator, not
 * what the generator did. Only the mapping.
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

describe('POST /api/class-templates — the arm no error can reach any more', () => {
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

    // Logged rather than answered silently — no `conflictLevel` any more: a
    // field whose entire job was telling two raisers apart has nothing to say
    // once there is at most one.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: 'teacher-1' }),
      'recurring class create refused: the studio family holds that slot',
    );
  });
});
