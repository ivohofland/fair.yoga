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
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/log', () => ({ log }));

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
  m.findAttempt.mockResolvedValue({ processorPaymentId: 'tr_1', payment: { registration: { classId: 'cls-1' } } });
  log.error.mockReset();
});

function loginTarget(res: Response): string | null {
  const location = res.headers.get('location');
  return location === null ? null : new URL(location).searchParams.get('redirect');
}

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

  it("sends the student to the pay page, naming no attempt, for an attempt that is not theirs", async () => {
    m.findAttempt.mockResolvedValue(null);
    const res = await GET(request('att-other'), ctx);
    expect(m.syncAttempt).not.toHaveBeenCalled();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost/bookings/cls-1/pay');
  });

  it('still redirects, logging the error, when the sync throws', async () => {
    m.syncAttempt.mockRejectedValue(new Error('lock timeout'));
    const res = await GET(request(), ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost/bookings/cls-1/pay?attempt=att-1');
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'pay-1', attemptId: 'att-1' }), expect.any(String));
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

  it('sends a visitor without a session to sign in, returning to the pay page with the attempt', async () => {
    m.validateSession.mockResolvedValue(null);
    const res = await GET(request(), ctx);
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
    expect(loginTarget(res)).toBe('/bookings/cls-1/pay?attempt=att-1');
    expect(m.findAttempt).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'att-1', paymentId: 'pay-1' } }));
    expect(m.syncAttempt).not.toHaveBeenCalled();
  });

  it('sends a session without a student profile to sign in too', async () => {
    m.validateSession.mockResolvedValue({ sessionId: 's1', accountId: 'acct-1', teacherId: 't-1', defaultTimezone: 'UTC', studentId: null });
    const res = await GET(request(), ctx);
    expect(res.status).toBe(303);
    expect(loginTarget(res)).toBe('/bookings/cls-1/pay?attempt=att-1');
    expect(m.syncAttempt).not.toHaveBeenCalled();
  });

  it('returns a visitor without a session to their bookings when the attempt does not name the payment', async () => {
    m.validateSession.mockResolvedValue(null);
    m.findAttempt.mockResolvedValue(null);
    const res = await GET(request(), ctx);
    expect(loginTarget(res)).toBe('/bookings');
  });

  it('returns a visitor without a session to their bookings when no attempt is named', async () => {
    m.validateSession.mockResolvedValue(null);
    const res = await GET(request(null), ctx);
    expect(loginTarget(res)).toBe('/bookings');
    expect(m.findAttempt).not.toHaveBeenCalled();
  });
});
