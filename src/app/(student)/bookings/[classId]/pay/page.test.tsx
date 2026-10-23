import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Prisma, type PaymentStatus, type ProcessorPaymentStatus } from '@/lib/prisma-client';
import type { PaymentMethodsAnswer } from '@/lib/payment-methods';

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  findUnique: vi.fn(),
  payPageMethods: vi.fn(),
  mollieDeps: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: m.getSession }));
vi.mock('@/lib/student-guard', () => ({ redirectNonStudent: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { registration: { findUnique: m.findUnique } } }));
vi.mock('@/services/pay-page-methods', () => ({ payPageMethods: m.payPageMethods, payPageTeacherSelect: {} }));
vi.mock('@/services/mollie-deps', () => ({ mollieDeps: m.mollieDeps }));
vi.mock('@/lib/payment-breakdown.server', () => ({ resolveReportedPaymentBreakdown: () => ({ kind: 'hidden' }) }));
vi.mock('@/lib/pay-page.server', () => ({
  markedPaidLine: () => 'Marked paid.',
  offersSentClaim: () => false,
  reportMissingPayment: vi.fn(),
  sentClaimLine: () => '',
}));
vi.mock('@/components/pay/processor-pay-button', () => ({
  ProcessorPayButton: (props: { paymentId: string; method: string; label: string }) => (
    <span data-testid="processor-pay-button" data-props={JSON.stringify(props)} />
  ),
}));

import PayPage from './page';

const DEPS = { marker: 'deps' };

function registration(status: PaymentStatus, attempts: { id: string; status: ProcessorPaymentStatus }[] = []) {
  return {
    id: 'reg-1',
    status: 'attended',
    payment: {
      id: 'pay-1', amount: new Prisma.Decimal('12.50'), status, paidAt: status === 'paid' ? new Date('2026-06-02T10:00:00Z') : null,
      method: status === 'paid' ? 'mollie' : null, studentReportedAt: null, processorAttempts: attempts,
    },
    class: {
      id: 'class-1', status: 'completed', currency: 'EUR', roomCost: 20, totalRevenue: 30, vatTotal: 0, vatPercent: 0, totalStudents: 1,
      calendarEntry: {
        classType: 'Vinyasa', date: new Date('2026-06-01T00:00:00Z'),
        teacher: { firstName: 'Ana', lastName: 'Teacher', defaultTimezone: 'Europe/Amsterdam' },
      },
    },
  };
}

async function show(searchParams: Record<string, string> = {}) {
  render(await PayPage({ params: Promise.resolve({ classId: 'class-1' }), searchParams: Promise.resolve(searchParams) }));
}

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.getSession.mockResolvedValue({ studentId: 'stu-1' });
  m.mollieDeps.mockReturnValue(DEPS);
});

describe('PayPage', () => {
  it('renders a Mollie method as its row with a pay button for that method', async () => {
    m.findUnique.mockResolvedValue(registration('pending'));
    const methods: PaymentMethodsAnswer = { kind: 'methods', methods: [{ kind: 'processor', method: 'ideal' }] };
    m.payPageMethods.mockResolvedValue(methods);

    await show();

    expect(m.payPageMethods).toHaveBeenCalledWith(expect.anything(), DEPS, expect.anything(), 'EUR', new Prisma.Decimal('12.50'));
    const row = screen.getByText('iDEAL').closest('details');
    expect(row).not.toBeNull();
    const button = within(row!).getByTestId('processor-pay-button');
    expect(JSON.parse(button.getAttribute('data-props') ?? '{}')).toEqual({ paymentId: 'pay-1', method: 'ideal', label: 'iDEAL' });
  });

  it('thanks the student who comes back from a paid attempt', async () => {
    m.findUnique.mockResolvedValue(registration('paid', [{ id: 'att-1', status: 'paid' }]));

    await show({ attempt: 'att-1' });

    expect(screen.getByTestId('attempt-banner')).toHaveTextContent('Paid — thank you.');
    expect(m.payPageMethods).not.toHaveBeenCalled();
  });
});
