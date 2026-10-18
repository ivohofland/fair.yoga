import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionUser } from '@/lib/types';

const m = vi.hoisted(() => ({
  validateSession: vi.fn<(db: unknown, token: string) => Promise<SessionUser | null>>(),
  syncAttempt: vi.fn(),
  mollieDeps: vi.fn(),
  findPayment: vi.fn(),
  findAttempt: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: { marker: 'db', payment: { findFirst: m.findPayment }, processorPayment: { findFirst: m.findAttempt } },
}));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  validateSession: m.validateSession,
}));
vi.mock('@/services/processor-attempts', () => ({ syncAttempt: m.syncAttempt }));
vi.mock('@/services/mollie-deps', () => ({ mollieDeps: m.mollieDeps }));
vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { GET } = await import('./route');

const STUDENT: SessionUser = { sessionId: 's1', accountId: 'acct-1', teacherId: null, studentId: 'stu-1' };
const DEPS = { marker: 'deps' };
const ctx = { params: Promise.resolve({ id: 'pay-1' }) };

function request(attempt: string | null = 'att-1'): NextRequest {
  const query = attempt === null ? '' : `?attempt=${encodeURIComponent(attempt)}`;
  return new NextRequest(`http://localhost/api/payments/pay-1/processor-return${query}`, {
    headers: { Cookie: 'fair_yoga_session=tok' },
  });
}

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.validateSession.mockResolvedValue(STUDENT);
  m.mollieDeps.mockReturnValue(DEPS);
  m.findPayment.mockResolvedValue({ registration: { classId: 'cls-1' } });
  m.findAttempt.mockResolvedValue({ processorPaymentId: 'tr_1' });
});

describe('GET /api/payments/[id]/processor-return', () => {
  it("syncs the student's own attempt, then sends them to the pay page with it", async () => {
    m.syncAttempt.mockResolvedValue('settled');
    const res = await GET(request(), ctx);
    expect(m.syncAttempt).toHaveBeenCalledWith(expect.objectContaining({ marker: 'db' }), DEPS, 'tr_1');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost/bookings/cls-1/pay?attempt=att-1');
    expect(m.findPayment).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'pay-1', registration: { studentId: 'stu-1' } } }));
    expect(m.findAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'att-1', paymentId: 'pay-1', payment: { registration: { studentId: 'stu-1' } } } }),
    );
  });

  it('still redirects when Mollie is unavailable', async () => {
    m.syncAttempt.mockResolvedValue('unavailable');
    const res = await GET(request(), ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost/bookings/cls-1/pay?attempt=att-1');
  });

  it("sends the student to the pay page without syncing an attempt that is not theirs", async () => {
    m.findAttempt.mockResolvedValue(null);
    const res = await GET(request('att-other'), ctx);
    expect(m.syncAttempt).not.toHaveBeenCalled();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost/bookings/cls-1/pay?attempt=att-other');
  });

  it("sends the student to their bookings for a payment that is not theirs", async () => {
    m.findPayment.mockResolvedValue(null);
    const res = await GET(request(), ctx);
    expect(m.syncAttempt).not.toHaveBeenCalled();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost/bookings');
  });

  it('sends the student to the pay page without syncing when no attempt is named', async () => {
    const res = await GET(request(null), ctx);
    expect(m.syncAttempt).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe('http://localhost/bookings/cls-1/pay');
  });

  it('refuses a request without a student session', async () => {
    m.validateSession.mockResolvedValue(null);
    expect((await GET(request(), ctx)).status).toBe(401);
    expect(m.syncAttempt).not.toHaveBeenCalled();
  });
});
