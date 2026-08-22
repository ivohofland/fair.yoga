import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * ONE thing: that `POST /api/class-templates` words its cross-family 409 for
 * the statement that actually raised, and logs which one it was.
 *
 * WHY THIS IS MOCKED, and why that is the point — the same argument
 * `api/cron/daily-cleanup/route.test.ts` makes, for a stronger reason.
 *
 * The route answers two different sentences behind one status. A `YG001` from
 * the TEMPLATE insert means a live studio TEMPLATE holds this weekday slot; one
 * from GENERATION means a live studio CLASS holds one of the dates. The remedies
 * differ, and telling a teacher to go find a recurring studio class that does
 * not exist is the defect this branch exists to avoid.
 *
 * The template arm is covered end-to-end by `tests/integration/
 * cross-family-slot-api.test.ts`. **The instance arm cannot be**, and not for
 * want of effort: the generator pre-checks the sibling table with the same
 * predicate the trigger carries, so a pre-existing studio class is SKIPPED
 * (`blocked_by_other_family`) and never reaches the insert. The only way
 * generation raises is a row committing inside the window between that
 * pre-check's `findMany` and its `createManyAndReturn` — the race
 * `docs/lock-order.md` records as knowingly accepted. An integration test
 * cannot stage it against a live app.
 *
 * So without this file, deleting `if (isCrossFamilySlotConflict(err))
 * conflict.level = 'instance';` fails nothing, and the race ships the wrong
 * sentence — which is exactly the outcome the `let`-to-object change was
 * measured against. That change hardened the read against a TYPO and left the
 * write unpinned against DELETION; this closes the other half.
 *
 * Nothing here asserts wiring — not that the route calls the generator, not
 * what the generator did. Only the mapping from "which statement raised" to
 * "which sentence and which log field".
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

describe('POST /api/class-templates — which statement raised', () => {
  it('words a GENERATION-time conflict for the instance family, and logs it as such', async () => {
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

    // The field that makes the accepted race countable in production.
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ conflictLevel: 'instance' });
  });

  it('words a TEMPLATE-insert conflict for the template family, and logs it as such', async () => {
    classTemplateCreate.mockRejectedValue(
      yg001('Teacher teacher-1 already has an active studio class template (st-1) on day 2 at 09:00'),
    );

    const res = await post();

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: { message: string; code: string } };
    expect(payload.error.code).toBe('CROSS_FAMILY_STUDIO_TEMPLATE_SLOT');
    expect(payload.error.message).toMatch(/recurring studio class/i);
    // `'untagged'`, not `'template'`: nothing tagged this error, and the log
    // says what was observed rather than what is inferred. The RESPONSE still
    // treats untagged as template — sound while the template insert is the
    // only other raiser — but the two must not be conflated in the field
    // someone greps to count races.
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ conflictLevel: 'untagged' });
  });
});
