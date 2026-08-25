import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * ONE thing: that `heldBy: 'unknown'` reaching `PUT
 * /api/studio-class-templates/[id]` maps to `STUDIO_TEMPLATE_SLOT_CONFLICT`
 * and its sentence, not to the `regular` or `studio` arm beside it in
 * `SLOT_TAKEN` (this file's `route.ts`). Mirrors
 * `../../class-templates/[id]/unknown-slot-holder.test.ts` — see that file
 * for why `'unknown'` is a real race and why mocking is the right instrument
 * for it, not a shortcut around it.
 */

const updateStudioClassTemplate = vi.fn();

vi.mock('@/services/studio-class-template-lifecycle', () => ({
  updateStudioClassTemplate: (...args: unknown[]) => updateStudioClassTemplate(...args),
}));
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireTeacher: async () => ({ teacherId: 'teacher-1', accountId: 'acct-1' }) };
});
// `updateStudioClassTemplate` is mocked, so the real `prisma` it would
// otherwise be called with is never read — stubbed to keep this file from
// opening a connection, matching `api/cron/daily-cleanup/route.test.ts`.
vi.mock('@/lib/db', () => ({ prisma: {} }));

const { PUT } = await import('./route');

function put(): NextRequest {
  return new NextRequest('http://localhost:3000/api/studio-class-templates/tpl-1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ classType: 'Vinyasa' }),
  });
}

describe('PUT /api/studio-class-templates/[id] — the unknown holder the race cannot stage', () => {
  it('answers STUDIO_TEMPLATE_SLOT_CONFLICT and the neither-family sentence for heldBy: unknown', async () => {
    updateStudioClassTemplate.mockResolvedValue({ ok: false, reason: 'slot_conflict', heldBy: 'unknown' });

    const res = await PUT(put(), { params: Promise.resolve({ id: 'tpl-1' }) });

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: { message: string; code: string } };
    expect(payload.error.code).toBe('STUDIO_TEMPLATE_SLOT_CONFLICT');
    expect(payload.error.message).toBe(
      'You already have a recurring class or studio class at an overlapping time on that day.',
    );
  });
});
