import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The four cells of `casMatchedNothing`'s per-caller truth table (route.ts)
 * that #500's PR review found untested (#513) — `PUT`+gone, `DELETE`+accepted,
 * and `'unread'` for both callers. The CAS-race and comparative-oracle
 * behavior itself is already proven at the integration tier
 * (`tests/integration/invitations-api.test.ts`); this file pins the
 * function's own branching instead.
 *
 * Of the four, only `DELETE`+accepted is actually unreachable at the
 * integration tier: DELETE's `not-declined` CAS admits `accepted` rows
 * outright, so the only way its re-read can still find one after a miss is
 * `resolveInvitationOnLink` flipping a `declined` row back to `accepted`
 * mid-request (see `casMatchedNothing`'s docblock above) — an
 * unsynchronizable race, not a lock a second request can park on. Issue
 * #513's "Why this wasn't closed in #500's own PR" section is about this one
 * cell, not all four.
 *
 * `PUT`+gone IS reachable there — the same lock-chokepoint harness the
 * integration suite already runs for DELETE+gone ("404s a delete whose row
 * vanished mid-request...", `tests/integration/invitations-api.test.ts:3474`)
 * would reach it too, since Postgres blocks an `UPDATE` on a row an
 * uncommitted `DELETE` holds the same way it blocks a second `DELETE`. It's
 * pinned here instead because mocking makes it cheap to cover alongside the
 * two cells that truly can't be reached by any race: the `'unread'` arm for
 * both callers, which needs the re-read itself to reject (a real database
 * fault), not a timing race.
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
    // Proves the flow actually reached the CAS write (and therefore that the
    // SECOND `findFirst` call — the post-CAS re-read — is what produced the
    // 404 above), not just that `PUT`'s own pre-check saw a gone row and
    // returned the identical 404 before ever calling `updateMany`. Swapping
    // the two `mockResolvedValueOnce` values above would make the pre-check
    // see `null` first and short-circuit, so `updateMany` would never run.
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("DELETE falls through to the generic 409 when the re-read finds an accepted row, proving cas === 'pending' is what excludes it", async () => {
    findFirst.mockResolvedValueOnce(PENDING_ROW).mockResolvedValueOnce(ACCEPTED_ROW);
    deleteMany.mockResolvedValueOnce({ count: 0 });

    const res = await DELETE(del(), { params: params() });

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: { message: string; code?: string } };
    expect(payload.error.code).toBeUndefined();
    expect(payload.error.message).toBe(
      'This contact changed while you were working on it. Reload and try again.',
    );
    // The HTTP response and `deleteMany`'s call count are BOTH invariant to
    // swapping the two `findFirst` values above: DELETE's own pre-check
    // passes on `PENDING_ROW` or `ACCEPTED_ROW` alike (it only refuses
    // `declined`), so `deleteMany` runs once either way, and with `cas` fixed
    // at `'not-declined'` a `pending` or an `accepted` re-read both fall
    // through to this same generic 409 — neither takes the `NOT_PENDING`
    // branch. So pin what each of the two calls actually resolved to
    // directly, which a mock-order swap WOULD change.
    expect(findFirst).toHaveBeenCalledTimes(2);
    const [preCheck, reRead] = findFirst.mock.results;
    await expect(preCheck?.value).resolves.toEqual(PENDING_ROW);
    await expect(reRead?.value).resolves.toEqual(ACCEPTED_ROW);
  });

  it("PUT answers the generic 409 for the 'unread' arm when the re-read itself rejects", async () => {
    findFirst.mockResolvedValueOnce(PENDING_ROW).mockRejectedValueOnce(new Error('connection lost'));
    updateMany.mockResolvedValueOnce({ count: 0 });

    const res = await PUT(put(), { params: params() });

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: { message: string; code?: string } };
    expect(payload.error.code).toBeUndefined();
    expect(payload.error.message).toBe(
      'This contact changed while you were working on it. Reload and try again.',
    );
  });

  it("DELETE answers the generic 409 for the 'unread' arm when the re-read itself rejects", async () => {
    findFirst.mockResolvedValueOnce(PENDING_ROW).mockRejectedValueOnce(new Error('connection lost'));
    deleteMany.mockResolvedValueOnce({ count: 0 });

    const res = await DELETE(del(), { params: params() });

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: { message: string; code?: string } };
    expect(payload.error.code).toBeUndefined();
    expect(payload.error.message).toBe(
      'This contact changed while you were working on it. Reload and try again.',
    );
  });
});
