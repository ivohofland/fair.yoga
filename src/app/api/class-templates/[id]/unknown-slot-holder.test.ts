import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * ONE thing: that `heldBy: 'unknown'` reaching `PUT /api/class-templates/[id]`
 * maps to `TEMPLATE_SLOT_CONFLICT` and its sentence, not to the `regular` or
 * `studio` arm beside it in `SLOT_TAKEN` (this file's `route.ts`).
 *
 * `'unknown'` is the arm `ruleSlotHolder` (`src/lib/rule-slot-holder.ts`)
 * answers when the rule that made `ScheduleRule_teacher_slot_excl` raise
 * `23P01` is archived in the gap between that failure and the probe — a real
 * race, not a defensive-only branch. `as const satisfies
 * Record<RuleSlotHolder, …>` proves `SLOT_TAKEN` is exhaustively TYPED; it
 * proves nothing about which entry a given `heldBy` string indexes to at
 * runtime. A `SLOT_TAKEN` with `regular` and `unknown` swapped would compile
 * and ship, and no test caught that before this file.
 *
 * WHY THIS IS MOCKED, following `cross-family-conflict-level.test.ts` beside
 * `../route.ts` and `api/cron/daily-cleanup/route.test.ts`'s reasoning for the
 * same shape of problem: staging the actual race needs a second connection to
 * archive the conflicting rule inside the microtask gap between
 * `updateClassTemplate`'s failed transaction and its `ruleSlotHolder` probe —
 * a window with no synchronization point exposed to a test, and the
 * integration suite talks to a separate `next dev` process it cannot reach
 * into to add one. Forcing `updateClassTemplate` to resolve with `heldBy:
 * 'unknown'` instead reproduces exactly what the route sees once that race
 * lands, and it is the route's own indexing into `SLOT_TAKEN` that this file
 * is testing — not the race that produces the key.
 */

const updateClassTemplate = vi.fn();

vi.mock('@/services/class-template-lifecycle', () => ({
  updateClassTemplate: (...args: unknown[]) => updateClassTemplate(...args),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireTeacher: async () => ({ teacherId: 'teacher-1', accountId: 'acct-1' }) };
});
// `updateClassTemplate` is mocked, so the real `prisma` it would otherwise be
// called with is never read — stubbed to keep this file from opening a
// connection, matching `api/cron/daily-cleanup/route.test.ts`.
vi.mock('@/lib/db', () => ({ prisma: {} }));

const { PUT } = await import('./route');

function put(): NextRequest {
  return new NextRequest('http://localhost:3000/api/class-templates/tpl-1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ classType: 'Vinyasa' }),
  });
}

describe('PUT /api/class-templates/[id] — the unknown holder the race cannot stage', () => {
  it('answers TEMPLATE_SLOT_CONFLICT and the neither-family sentence for heldBy: unknown', async () => {
    updateClassTemplate.mockResolvedValue({ ok: false, reason: 'slot_conflict', heldBy: 'unknown' });

    const res = await PUT(put(), { params: Promise.resolve({ id: 'tpl-1' }) });

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: { message: string; code: string } };
    expect(payload.error.code).toBe('TEMPLATE_SLOT_CONFLICT');
    expect(payload.error.message).toBe(
      'You already have a recurring class or studio class at an overlapping time on that day.',
    );
  });
});
