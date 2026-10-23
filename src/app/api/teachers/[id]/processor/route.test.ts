import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionUser } from '@/lib/types';
import { expectApplied, expectUnchanged } from '../../../../../../tests/api-assertions';

const m = vi.hoisted(() => ({
  validateSession: vi.fn<(db: unknown, token: string) => Promise<SessionUser | null>>(),
  disconnect: vi.fn(),
  revokeConnection: vi.fn(),
  forgetOfferedMethods: vi.fn(),
  deliverPayoutChangedNotice: vi.fn(),
  mollieDeps: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: { marker: 'db' } }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  validateSession: m.validateSession,
}));
vi.mock('@/services/processor-connection', () => ({ disconnect: m.disconnect, revokeConnection: m.revokeConnection }));
vi.mock('@/services/processor-methods-cache', () => ({ forgetOfferedMethods: m.forgetOfferedMethods }));
vi.mock('@/services/payout-notice', () => ({ deliverPayoutChangedNotice: m.deliverPayoutChangedNotice }));
vi.mock('@/services/mollie-deps', () => ({ mollieDeps: m.mollieDeps }));
vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { DELETE } = await import('./route');

const SESSION: SessionUser = { sessionId: 's1', accountId: 'acct-1', teacherId: 't-1', defaultTimezone: 'UTC', studentId: null };
const DEPS = { marker: 'deps' };
const ctx = { params: Promise.resolve({ id: 't-1' }) };

function request(): NextRequest {
  return new NextRequest('http://localhost/api/teachers/t-1/processor', { method: 'DELETE', headers: { Cookie: 'fair_yoga_session=tok' } });
}

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.validateSession.mockResolvedValue(SESSION);
  m.mollieDeps.mockReturnValue(DEPS);
});

describe('DELETE /api/teachers/[id]/processor', () => {
  it('disconnects, alerts, forgets the cached methods and revokes at once when nothing is open', async () => {
    m.disconnect.mockResolvedValue({ kind: 'disconnected', eventId: 'ev-1', connectionId: 'c-1', revokeNow: true });
    await expectApplied(await DELETE(request(), ctx));
    expect(m.disconnect).toHaveBeenCalledWith({ marker: 'db' }, { teacherId: 't-1' });
    expect(m.deliverPayoutChangedNotice).toHaveBeenCalledWith({ marker: 'db' }, 'ev-1');
    expect(m.forgetOfferedMethods).toHaveBeenCalledWith('c-1');
    expect(m.revokeConnection).toHaveBeenCalledWith({ marker: 'db' }, DEPS, 'c-1');
  });

  it('leaves the revoke to the sweep while an attempt is open', async () => {
    m.disconnect.mockResolvedValue({ kind: 'disconnected', eventId: 'ev-1', connectionId: 'c-1', revokeNow: false });
    await expectApplied(await DELETE(request(), ctx));
    expect(m.deliverPayoutChangedNotice).toHaveBeenCalledWith({ marker: 'db' }, 'ev-1');
    expect(m.revokeConnection).not.toHaveBeenCalled();
  });

  it('sends no payout notice for a disconnect that recorded no event', async () => {
    m.disconnect.mockResolvedValue({ kind: 'disconnected', eventId: null, connectionId: 'c-1', revokeNow: true });
    await expectApplied(await DELETE(request(), ctx));
    expect(m.deliverPayoutChangedNotice).not.toHaveBeenCalled();
    expect(m.forgetOfferedMethods).toHaveBeenCalledWith('c-1');
    expect(m.revokeConnection).toHaveBeenCalledWith({ marker: 'db' }, DEPS, 'c-1');
  });

  it('disconnects without Mollie configured, leaving the revoke to the sweep', async () => {
    m.mollieDeps.mockReturnValue(null);
    m.disconnect.mockResolvedValue({ kind: 'disconnected', eventId: 'ev-1', connectionId: 'c-1', revokeNow: true });
    await expectApplied(await DELETE(request(), ctx));
    expect(m.revokeConnection).not.toHaveBeenCalled();
  });

  it('answers unchanged when nothing is connected', async () => {
    m.disconnect.mockResolvedValue({ kind: 'unchanged' });
    await expectUnchanged(await DELETE(request(), ctx));
    expect(m.deliverPayoutChangedNotice).not.toHaveBeenCalled();
  });

  it('answers 404 for an erased teacher', async () => {
    m.disconnect.mockResolvedValue({ kind: 'teacher_gone' });
    expect((await DELETE(request(), ctx)).status).toBe(404);
    expect(m.deliverPayoutChangedNotice).not.toHaveBeenCalled();
  });

  it('refuses another teacher', async () => {
    const res = await DELETE(request(), { params: Promise.resolve({ id: 't-2' }) });
    expect(res.status).toBe(403);
    expect(m.disconnect).not.toHaveBeenCalled();
  });
});
