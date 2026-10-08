import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionUser } from '@/lib/types';

const m = vi.hoisted(() => ({
  validateSession: vi.fn<(db: unknown, token: string) => Promise<SessionUser | null>>(),
  saveBankAccount: vi.fn(),
  removeBankAccount: vi.fn(),
  deliverPayoutChangedNotice: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: { marker: 'db' } }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  validateSession: m.validateSession,
}));
vi.mock('@/services/bank-accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/bank-accounts')>()),
  saveBankAccount: m.saveBankAccount,
  removeBankAccount: m.removeBankAccount,
}));
vi.mock('@/services/payout-notice', () => ({ deliverPayoutChangedNotice: m.deliverPayoutChangedNotice }));
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { PUT, DELETE } = await import('./route');

const SESSION: SessionUser = { sessionId: 's1', accountId: 'acct-1', teacherId: 't-1', defaultTimezone: 'UTC', studentId: null };
const ctx = { params: Promise.resolve({ id: 't-1', currency: 'EUR' }) };

function request(method: 'PUT' | 'DELETE'): NextRequest {
  return new NextRequest('http://localhost/api/teachers/t-1/bank-accounts/EUR', {
    method,
    headers: { Cookie: 'fair_yoga_session=tok', 'Content-Type': 'application/json' },
    body: method === 'PUT' ? JSON.stringify({ holderName: 'A', iban: 'NL91ABNA0417164300' }) : undefined,
  });
}

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.validateSession.mockResolvedValue(SESSION);
});

describe('bank-account route payout alert', () => {
  it('delivers the saved event after a save', async () => {
    m.saveBankAccount.mockResolvedValue({ kind: 'saved', account: { id: 'b' }, eventId: 'ev-1' });
    const res = await PUT(request('PUT'), ctx);
    expect(res.status).toBe(200);
    expect(m.deliverPayoutChangedNotice).toHaveBeenCalledTimes(1);
    expect(m.deliverPayoutChangedNotice).toHaveBeenCalledWith({ marker: 'db' }, 'ev-1');
  });

  it('delivers the removed event after a removal', async () => {
    m.removeBankAccount.mockResolvedValue({ kind: 'removed', eventId: 'ev-2' });
    const res = await DELETE(request('DELETE'), ctx);
    expect(res.status).toBe(200);
    expect(m.deliverPayoutChangedNotice).toHaveBeenCalledWith({ marker: 'db' }, 'ev-2');
  });

  it.each([
    ['unchanged save', () => m.saveBankAccount.mockResolvedValue({ kind: 'unchanged', account: { id: 'b' } }), 'PUT'],
    ['invalid save', () => m.saveBankAccount.mockResolvedValue({ kind: 'invalid', failure: { error: 'iban_invalid', field: 'iban' } }), 'PUT'],
    ['erased save', () => m.saveBankAccount.mockResolvedValue({ kind: 'teacher_gone' }), 'PUT'],
    ['absent removal', () => m.removeBankAccount.mockResolvedValue({ kind: 'absent' }), 'DELETE'],
    ['erased removal', () => m.removeBankAccount.mockResolvedValue({ kind: 'teacher_gone' }), 'DELETE'],
  ] as const)('does not deliver on an %s', async (_name, arrange, method) => {
    arrange();
    await (method === 'PUT' ? PUT : DELETE)(request(method), ctx);
    expect(m.deliverPayoutChangedNotice).not.toHaveBeenCalled();
  });
});
