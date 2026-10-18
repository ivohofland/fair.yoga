import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionUser } from '@/lib/types';
import { codedRefusal } from '@/lib/api-error-codes';
import { expectApplied, expectRefusal, expectUnchanged } from '../../../../../../tests/api-assertions';

const m = vi.hoisted(() => ({
  validateSession: vi.fn<(db: unknown, token: string) => Promise<SessionUser | null>>(),
  refundAttempt: vi.fn(),
  mollieDeps: vi.fn(),
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
}));

const DB = { marker: 'db', payment: { findUnique: m.findUnique, findUniqueOrThrow: m.findUniqueOrThrow } };
vi.mock('@/lib/db', () => ({ prisma: DB }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  validateSession: m.validateSession,
}));
vi.mock('@/services/processor-refunds', () => ({ refundAttempt: m.refundAttempt }));
vi.mock('@/services/mollie-deps', () => ({ mollieDeps: m.mollieDeps }));
vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { POST } = await import('./route');

const TEACHER: SessionUser = { sessionId: 's1', accountId: 'acct-1', teacherId: 't-1', defaultTimezone: 'UTC', studentId: null };
const STUDENT: SessionUser = { sessionId: 's1', accountId: 'acct-1', teacherId: null, studentId: 'stu-1' };
const DEPS = { marker: 'deps' };
const ATTEMPT_ID = '6f1c1c2e-8a52-4d0e-9a3c-2f7c6d1e9b10';
const ctx = { params: Promise.resolve({ id: 'pay-1' }) };
const PAYMENT = { id: 'pay-1', status: 'paid', amount: '10.00' };

function owned(teacherId: string) {
  return { id: 'pay-1', registration: { class: { calendarEntry: { teacherId } } } };
}

function request(body: unknown = { attemptId: ATTEMPT_ID, choice: 'waive' }): NextRequest {
  return new NextRequest('http://localhost/api/payments/pay-1/refund', {
    method: 'POST',
    headers: { Cookie: 'fair_yoga_session=tok', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.validateSession.mockResolvedValue(TEACHER);
  m.mollieDeps.mockReturnValue(DEPS);
  m.findUnique.mockResolvedValue(owned('t-1'));
  m.findUniqueOrThrow.mockResolvedValue(PAYMENT);
});

describe('POST /api/payments/[id]/refund', () => {
  it('answers 200 with the refund’s status and the payment row', async () => {
    m.refundAttempt.mockResolvedValue({ kind: 'requested', refundStatus: 'queued', outcomeApplied: false });

    expect(await expectApplied(await POST(request(), ctx))).toEqual({ refundStatus: 'queued', outcomeApplied: false, payment: PAYMENT });
    expect(m.refundAttempt).toHaveBeenCalledWith(DB, DEPS, { paymentId: 'pay-1', attemptId: ATTEMPT_ID, choice: 'waive' });
  });

  it('answers unchanged with the payment row for an attempt already refunded', async () => {
    m.refundAttempt.mockResolvedValue({ kind: 'unchanged' });
    expect(await expectUnchanged(await POST(request(), ctx))).toEqual({ refundStatus: 'refunded', payment: PAYMENT });
  });

  it('passes a null choice through for a duplicate', async () => {
    m.refundAttempt.mockResolvedValue({ kind: 'requested', refundStatus: 'queued', outcomeApplied: false });
    await POST(request({ attemptId: ATTEMPT_ID, choice: null }), ctx);
    expect(m.refundAttempt).toHaveBeenCalledWith(DB, DEPS, { paymentId: 'pay-1', attemptId: ATTEMPT_ID, choice: null });
  });

  it('answers 400 with the message for an invalid choice', async () => {
    m.refundAttempt.mockResolvedValue({ kind: 'invalid', message: 'Choose whether to waive the payment or ask again.' });
    const res = await POST(request(), ctx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Choose whether to waive the payment or ask again.');
  });

  it.each(['NOT_FOUND', 'REFUND_NOT_ALLOWED', 'REFUND_ALREADY_REQUESTED', 'REFUND_REFUSED', 'PROCESSOR_NOT_CONNECTED'] as const)(
    'answers the refusal %s at its registered status',
    async (code) => {
      m.refundAttempt.mockResolvedValue({ kind: 'refused', refusal: codedRefusal(code, 'refused') });
      await expectRefusal(await POST(request(), ctx), code);
    },
  );

  it('answers 503 PROCESSOR_UNAVAILABLE when Mollie cannot be reached', async () => {
    m.refundAttempt.mockResolvedValue({ kind: 'unavailable' });
    await expectRefusal(await POST(request(), ctx), 'PROCESSOR_UNAVAILABLE');
  });

  it("answers 403 for another teacher's payment, without refunding", async () => {
    m.findUnique.mockResolvedValue(owned('t-2'));
    expect((await POST(request(), ctx)).status).toBe(403);
    expect(m.refundAttempt).not.toHaveBeenCalled();
  });

  it('answers NOT_FOUND for a payment that does not exist, without refunding', async () => {
    m.findUnique.mockResolvedValue(null);
    await expectRefusal(await POST(request(), ctx), 'NOT_FOUND');
    expect(m.refundAttempt).not.toHaveBeenCalled();
  });

  it('refuses a session without a teacher profile', async () => {
    m.validateSession.mockResolvedValue(STUDENT);
    expect((await POST(request(), ctx)).status).toBe(403);
    expect(m.refundAttempt).not.toHaveBeenCalled();
  });

  it.each([
    ['no attempt', { choice: 'waive' }],
    ['an attempt that is not a uuid', { attemptId: 'att-1', choice: 'waive' }],
    ['a missing choice', { attemptId: ATTEMPT_ID }],
    ['an unknown choice', { attemptId: ATTEMPT_ID, choice: 'keep' }],
    ['an extra field', { attemptId: ATTEMPT_ID, choice: 'waive', amount: 5 }],
  ])('answers 400 for %s, without refunding', async (_name, body) => {
    expect((await POST(request(body), ctx)).status).toBe(400);
    expect(m.refundAttempt).not.toHaveBeenCalled();
  });
});
