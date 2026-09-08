import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The four cells of `casMatchedNothing`'s per-caller truth table (route.ts)
 * that #500's PR review found untested (#513) — `PUT`+gone, `DELETE`+accepted,
 * and `'unread'` for both callers. The CAS-race and comparative-oracle
 * behavior itself is already proven at the integration tier
 * (`tests/integration/invitations-api.test.ts`); this file pins the
 * function's own branching, which that tier cannot reach for two of these
 * cells (no lock chokepoint exists for an HTTP-level race on a `deleteMany`
 * miss or an unlocked re-read) and does not attempt to for the other two,
 * which need a rejected re-read rather than a real database fault.
 *
 * WHY THIS IS MOCKED, following `class-templates/[id]/unknown-slot-holder.test.ts`'s
 * reasoning for the same shape of problem: each scenario needs the re-read
 * inside `casMatchedNothing` to resolve to an exact scripted value (or
 * reject) independently of the pre-check read that runs earlier in the same
 * request — two calls to the same query, two different answers, on demand.
 * Mocking `@/lib/db` is also what keeps this file from opening a real
 * database connection at all.
 */

const findFirst = vi.fn();
const updateMany = vi.fn();
const deleteMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    invitation: {
      findFirst: (...args: unknown[]) => findFirst(...args),
      updateMany: (...args: unknown[]) => updateMany(...args),
      deleteMany: (...args: unknown[]) => deleteMany(...args),
    },
  },
}));
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return {
    ...actual,
    requireTeacher: async () => ({ teacherId: 'teacher-1', accountId: 'acct-1' }),
  };
});

const { PUT, DELETE } = await import('./route');

const PENDING_ROW = { id: 'inv-1', status: 'pending', isArchived: false, email: 'contact@test.local' };
const ACCEPTED_ROW = { id: 'inv-1', status: 'accepted', isArchived: false, email: 'contact@test.local' };

function put(): NextRequest {
  return new NextRequest('http://localhost:3000/api/invitations/inv-1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Updated' }),
  });
}

function del(): NextRequest {
  return new NextRequest('http://localhost:3000/api/invitations/inv-1', { method: 'DELETE' });
}

const params = () => Promise.resolve({ id: 'inv-1' });

beforeEach(() => {
  findFirst.mockReset();
  updateMany.mockReset();
  deleteMany.mockReset();
});

describe("casMatchedNothing's per-caller truth table (#513)", () => {
  it('PUT answers 404 when the post-CAS re-read finds the row gone', async () => {
    findFirst.mockResolvedValueOnce(PENDING_ROW).mockResolvedValueOnce(null);
    updateMany.mockResolvedValueOnce({ count: 0 });

    const res = await PUT(put(), { params: params() });

    expect(res.status).toBe(404);
    const payload = (await res.json()) as { error: { message: string; code?: string } };
    expect(payload.error.message).toBe('Contact not found');
  });

  it("DELETE falls through to the generic 409 when the re-read finds an accepted row, proving cas === 'pending' is what excludes it", async () => {
    findFirst.mockResolvedValueOnce(PENDING_ROW).mockResolvedValueOnce(ACCEPTED_ROW);
    deleteMany.mockResolvedValueOnce({ count: 0 });

    const res = await DELETE(del(), { params: params() });

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: { message: string; code?: string } };
    expect(payload.error.code).toBeUndefined();
  });

  it("PUT answers the generic 409 for the 'unread' arm when the re-read itself rejects", async () => {
    findFirst.mockResolvedValueOnce(PENDING_ROW).mockRejectedValueOnce(new Error('connection lost'));
    updateMany.mockResolvedValueOnce({ count: 0 });

    const res = await PUT(put(), { params: params() });

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: { message: string; code?: string } };
    expect(payload.error.code).toBeUndefined();
  });

  it("DELETE answers the generic 409 for the 'unread' arm when the re-read itself rejects", async () => {
    findFirst.mockResolvedValueOnce(PENDING_ROW).mockRejectedValueOnce(new Error('connection lost'));
    deleteMany.mockResolvedValueOnce({ count: 0 });

    const res = await DELETE(del(), { params: params() });

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: { message: string; code?: string } };
    expect(payload.error.code).toBeUndefined();
  });
});
