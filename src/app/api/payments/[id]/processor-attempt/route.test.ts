import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionUser } from '@/lib/types';
import { codedRefusal } from '@/lib/api-error-codes';
import { expectApplied, expectRefusal } from '../../../../../../tests/api-assertions';

const m = vi.hoisted(() => ({
  validateSession: vi.fn<(db: unknown, token: string) => Promise<SessionUser | null>>(),
  createAttempt: vi.fn(),
  mollieDeps: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: { marker: 'db' } }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  validateSession: m.validateSession,
}));
vi.mock('@/services/processor-attempts', () => ({ createAttempt: m.createAttempt }));
vi.mock('@/services/mollie-deps', () => ({ mollieDeps: m.mollieDeps }));
vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { POST } = await import('./route');

const STUDENT: SessionUser = { sessionId: 's1', accountId: 'acct-1', teacherId: null, studentId: 'stu-1' };
const TEACHER: SessionUser = { sessionId: 's1', accountId: 'acct-1', teacherId: 't-1', defaultTimezone: 'UTC', studentId: null };
const DEPS = { marker: 'deps' };
const ctx = { params: Promise.resolve({ id: 'pay-1' }) };

function request(body: unknown = { method: 'ideal' }): NextRequest {
  return new NextRequest('http://localhost/api/payments/pay-1/processor-attempt', {
    method: 'POST',
    headers: { Cookie: 'fair_yoga_session=tok', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.validateSession.mockResolvedValue(STUDENT);
  m.mollieDeps.mockReturnValue(DEPS);
});

describe('POST /api/payments/[id]/processor-attempt', () => {
  it("answers the checkout URL for the session's own student", async () => {
    m.createAttempt.mockResolvedValue({ kind: 'checkout', attemptId: 'att-1', checkoutUrl: 'https://www.mollie.com/checkout/x' });
    expect(await expectApplied(await POST(request(), ctx))).toEqual({ checkoutUrl: 'https://www.mollie.com/checkout/x' });
    expect(m.createAttempt).toHaveBeenCalledWith({ marker: 'db' }, DEPS, { paymentId: 'pay-1', studentId: 'stu-1', method: 'ideal' });
  });

  it('passes a null deps through when Mollie is not configured', async () => {
    m.mollieDeps.mockReturnValue(null);
    m.createAttempt.mockResolvedValue({ kind: 'refused', refusal: codedRefusal('PROCESSOR_NOT_CONNECTED', 'x') });
    await expectRefusal(await POST(request(), ctx), 'PROCESSOR_NOT_CONNECTED');
    expect(m.createAttempt).toHaveBeenCalledWith({ marker: 'db' }, null, expect.anything());
  });

  it.each(['PAYMENT_SETTLED', 'PAYMENTS_PAUSED', 'PROCESSOR_METHOD_UNAVAILABLE'] as const)('answers the refusal %s', async (code) => {
    m.createAttempt.mockResolvedValue({ kind: 'refused', refusal: codedRefusal(code, 'refused') });
    await expectRefusal(await POST(request(), ctx), code);
  });

  it('answers NOT_FOUND for a payment that is not the student’s', async () => {
    m.createAttempt.mockResolvedValue({ kind: 'refused', refusal: codedRefusal('NOT_FOUND', 'Payment not found.') });
    await expectRefusal(await POST(request(), ctx), 'NOT_FOUND');
  });

  it('answers 503 PROCESSOR_UNAVAILABLE when Mollie cannot be reached', async () => {
    m.createAttempt.mockResolvedValue({ kind: 'unavailable' });
    await expectRefusal(await POST(request(), ctx), 'PROCESSOR_UNAVAILABLE');
  });

  it('refuses a session without a student profile', async () => {
    m.validateSession.mockResolvedValue(TEACHER);
    expect((await POST(request(), ctx)).status).toBe(403);
    expect(m.createAttempt).not.toHaveBeenCalled();
  });

  it.each([
    ['no method', {}],
    ['an empty method', { method: '' }],
    ['an over-long method', { method: 'x'.repeat(33) }],
    ['a blank method', { method: '   ' }],
    ['a method with a hidden character', { method: 'ideal\u200b' }],
    ['an extra field', { method: 'ideal', amount: 1 }],
  ])('answers 400 for %s', async (_name, body) => {
    expect((await POST(request(body), ctx)).status).toBe(400);
    expect(m.createAttempt).not.toHaveBeenCalled();
  });
});
