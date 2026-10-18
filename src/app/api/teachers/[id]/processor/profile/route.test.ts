import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionUser } from '@/lib/types';
import { expectApplied, expectRefusal, expectUnchanged } from '../../../../../../../tests/api-assertions';

const m = vi.hoisted(() => ({
  validateSession: vi.fn<(db: unknown, token: string) => Promise<SessionUser | null>>(),
  chooseProfile: vi.fn(),
  deliverPayoutChangedNotice: vi.fn(),
  mollieDeps: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: { marker: 'db' } }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  validateSession: m.validateSession,
}));
vi.mock('@/services/processor-connection', () => ({ chooseProfile: m.chooseProfile }));
vi.mock('@/services/payout-notice', () => ({ deliverPayoutChangedNotice: m.deliverPayoutChangedNotice }));
vi.mock('@/services/mollie-deps', () => ({ mollieDeps: m.mollieDeps }));
vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { PUT } = await import('./route');

const SESSION: SessionUser = { sessionId: 's1', accountId: 'acct-1', teacherId: 't-1', defaultTimezone: 'UTC', studentId: null };
const DEPS = { marker: 'deps' };
const ctx = { params: Promise.resolve({ id: 't-1' }) };

function request(body: unknown = { profileId: 'pfl_abc123' }): NextRequest {
  return new NextRequest('http://localhost/api/teachers/t-1/processor/profile', {
    method: 'PUT',
    headers: { Cookie: 'fair_yoga_session=tok', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.validateSession.mockResolvedValue(SESSION);
  m.mollieDeps.mockReturnValue(DEPS);
});

describe('PUT /api/teachers/[id]/processor/profile', () => {
  it('chooses the profile and delivers the event', async () => {
    m.chooseProfile.mockResolvedValue({ kind: 'chosen', eventId: 'ev-1' });
    expect(await expectApplied(await PUT(request(), ctx))).toEqual({ profileId: 'pfl_abc123' });
    expect(m.chooseProfile).toHaveBeenCalledWith({ marker: 'db' }, DEPS, { teacherId: 't-1', profileId: 'pfl_abc123' });
    expect(m.deliverPayoutChangedNotice).toHaveBeenCalledWith({ marker: 'db' }, 'ev-1');
  });

  it('answers unchanged for the profile already chosen', async () => {
    m.chooseProfile.mockResolvedValue({ kind: 'unchanged' });
    await expectUnchanged(await PUT(request(), ctx));
    expect(m.deliverPayoutChangedNotice).not.toHaveBeenCalled();
  });

  it('refuses PROCESSOR_NOT_CONNECTED without a connection', async () => {
    m.chooseProfile.mockResolvedValue({ kind: 'not_connected' });
    await expectRefusal(await PUT(request(), ctx), 'PROCESSOR_NOT_CONNECTED');
    expect(m.deliverPayoutChangedNotice).not.toHaveBeenCalled();
  });

  it('answers 400 for a profile Mollie does not list', async () => {
    m.chooseProfile.mockResolvedValue({ kind: 'unknown_profile' });
    expect((await PUT(request(), ctx)).status).toBe(400);
    expect(m.deliverPayoutChangedNotice).not.toHaveBeenCalled();
  });

  it('answers 503 PROCESSOR_UNAVAILABLE when Mollie cannot be reached', async () => {
    m.chooseProfile.mockResolvedValue({ kind: 'unavailable' });
    await expectRefusal(await PUT(request(), ctx), 'PROCESSOR_UNAVAILABLE');
  });

  it('answers 503 PROCESSOR_UNAVAILABLE when Mollie is not configured', async () => {
    m.mollieDeps.mockReturnValue(null);
    await expectRefusal(await PUT(request(), ctx), 'PROCESSOR_UNAVAILABLE');
    expect(m.chooseProfile).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-profile id', { profileId: 'org_abc' }],
    ['an extra field', { profileId: 'pfl_abc', extra: 1 }],
    ['no id', {}],
  ])('answers 400 for %s', async (_name, body) => {
    expect((await PUT(request(body), ctx)).status).toBe(400);
    expect(m.chooseProfile).not.toHaveBeenCalled();
  });
});
