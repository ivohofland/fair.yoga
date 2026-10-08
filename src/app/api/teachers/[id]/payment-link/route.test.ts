import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionUser } from '@/lib/types';

const m = vi.hoisted(() => ({
  validateSession: vi.fn<(db: unknown, token: string) => Promise<SessionUser | null>>(),
  savePaymentLink: vi.fn(),
  removePaymentLink: vi.fn(),
  deliverPayoutChangedNotice: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: { marker: 'db' } }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  validateSession: m.validateSession,
}));
vi.mock('@/services/payment-link', () => ({
  savePaymentLink: m.savePaymentLink,
  removePaymentLink: m.removePaymentLink,
}));
vi.mock('@/services/payout-notice', () => ({ deliverPayoutChangedNotice: m.deliverPayoutChangedNotice }));
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { PUT, DELETE } = await import('./route');

const SESSION: SessionUser = { sessionId: 's1', accountId: 'acct-1', teacherId: 't-1', defaultTimezone: 'UTC', studentId: null };
const ctx = { params: Promise.resolve({ id: 't-1' }) };

function request(method: 'PUT' | 'DELETE'): NextRequest {
  return new NextRequest('http://localhost/api/teachers/t-1/payment-link', {
    method,
    headers: { Cookie: 'fair_yoga_session=tok', 'Content-Type': 'application/json' },
    body: method === 'PUT' ? JSON.stringify({ paymentLink: 'https://pay.example/x' }) : undefined,
  });
}

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.validateSession.mockResolvedValue(SESSION);
});

describe('payment-link route payout alert', () => {
  it('delivers the saved event after a save', async () => {
    m.savePaymentLink.mockResolvedValue({ kind: 'saved', paymentLink: 'https://pay.example/x', eventId: 'ev-1' });
    const res = await PUT(request('PUT'), ctx);
    expect(res.status).toBe(200);
    expect(m.deliverPayoutChangedNotice).toHaveBeenCalledTimes(1);
    expect(m.deliverPayoutChangedNotice).toHaveBeenCalledWith({ marker: 'db' }, 'ev-1');
  });

  it('delivers the removed event after a removal', async () => {
    m.removePaymentLink.mockResolvedValue({ kind: 'removed', eventId: 'ev-2' });
    const res = await DELETE(request('DELETE'), ctx);
    expect(res.status).toBe(200);
    expect(m.deliverPayoutChangedNotice).toHaveBeenCalledWith({ marker: 'db' }, 'ev-2');
  });

  it.each([
    ['unchanged save', () => m.savePaymentLink.mockResolvedValue({ kind: 'unchanged', paymentLink: 'https://pay.example/x' }), 'PUT'],
    ['invalid save', () => m.savePaymentLink.mockResolvedValue({ kind: 'invalid', error: 'not_https' }), 'PUT'],
    ['erased save', () => m.savePaymentLink.mockResolvedValue({ kind: 'teacher_gone' }), 'PUT'],
    ['absent removal', () => m.removePaymentLink.mockResolvedValue({ kind: 'absent' }), 'DELETE'],
    ['erased removal', () => m.removePaymentLink.mockResolvedValue({ kind: 'teacher_gone' }), 'DELETE'],
  ] as const)('does not deliver on an %s', async (_name, arrange, method) => {
    arrange();
    await (method === 'PUT' ? PUT : DELETE)(request(method), ctx);
    expect(m.deliverPayoutChangedNotice).not.toHaveBeenCalled();
  });
});
