import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import type { AttemptView } from '@/lib/processor-attempt-view';
import { ReceivedPaymentRow } from './received-payment-row';

/**
 * #140. `Payment.paidAt` is a `DateTime` — an instant, the moment the teacher
 * tapped "Mark paid" — while `formatDateShort` reads with `getUTC*` accessors,
 * which is right for a `@db.Date` calendar value and wrong for an instant. The
 * page rendered it raw, so a teacher who settled up on Friday evening in
 * Portland saw the payment dated Saturday.
 *
 * Both fixtures below are chosen so the teacher's zone and UTC fall on
 * *different* calendar days. That property is the whole test: an instant where
 * they agree would pass whether or not the code applied a timezone at all. If
 * either instant is ever changed, re-check it rather than assuming.
 *
 * They also shift in opposite directions — Los Angeles backwards over
 * midnight, Kolkata forwards — which additionally rules out an implementation
 * that always subtracts.
 */
describe('ReceivedPaymentRow', () => {
  const base = {
    paymentId: 'pay-1',
    studentName: 'Ana D.',
    classType: 'Vinyasa',
    classDate: new Date('2026-06-12T00:00:00.000Z'),
    startTime: new Date('1970-01-01T09:30:00.000Z'),
    amount: 14,
    processorAttempts: [] as AttemptView[],
  };

  it('shows the teacher’s day, not UTC’s, west of the meridian', () => {
    // 18:00 on 12 June in Los Angeles is 01:00 on 13 June UTC.
    render(
      <ReceivedPaymentRow currency="EUR"
        {...base}
        paidAt={new Date('2026-06-13T01:00:00.000Z')}
        timeZone="America/Los_Angeles"
      />,
    );

    expect(screen.getByText(/✓ paid 12 Jun/)).toBeInTheDocument();
    expect(screen.queryByText(/13 Jun/)).not.toBeInTheDocument();
  });

  it('shows the teacher’s day east of the meridian too', () => {
    // 20:00 on 12 June UTC is 01:30 on 13 June in Kolkata.
    render(
      <ReceivedPaymentRow currency="EUR"
        {...base}
        paidAt={new Date('2026-06-12T20:00:00.000Z')}
        timeZone="Asia/Kolkata"
      />,
    );

    expect(screen.getByText(/✓ paid 13 Jun/)).toBeInTheDocument();
  });

  /**
   * `paidAt` is nullable on `Payment`. A row with no timestamp renders no
   * caption rather than an empty one — the `&&` guard the page already had.
   */
  it('renders no paid caption when paidAt is null', () => {
    render(<ReceivedPaymentRow currency="EUR" {...base} paidAt={null} timeZone="America/Los_Angeles" />);

    expect(screen.queryByText(/✓ paid/)).not.toBeInTheDocument();
    expect(screen.getByText(/Vinyasa · 12 Jun · 09:30/)).toBeInTheDocument();
  });

  /**
   * #128. ReceivedPaymentRow threads studentName and classContext to
   * MarkUnpaidButton so the button has a distinct accessible name.
   */
  it('renders the mark-unpaid button with a disambiguated accessible name', () => {
    render(<ReceivedPaymentRow currency="EUR" {...base} paidAt={null} timeZone="America/Los_Angeles" />);

    expect(
      screen.getByRole('button', { name: 'Mark unpaid — Ana D., Vinyasa · 12 Jun · 09:30' }),
    ).toBeInTheDocument();
  });

  describe('a payment Mollie took (Decision 17)', () => {
    function attempt(over: Partial<AttemptView> = {}): AttemptView {
      return {
        id: 'att-1', method: 'ideal', status: 'paid', settledPayment: true, chargedBackAt: null, amount: 14, currency: 'EUR', refunds: [],
        ...over,
      };
    }

    function renderWith(processorAttempts: AttemptView[]) {
      render(<ReceivedPaymentRow currency="EUR" {...base} paidAt={null} timeZone="UTC" processorAttempts={processorAttempts} />);
    }

    it('settled by Mollie offers Refund in place of Mark unpaid', () => {
      renderWith([attempt()]);
      expect(screen.getByRole('button', { name: /^Refund iDEAL €14\.00 — Ana D\./ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Mark unpaid/ })).not.toBeInTheDocument();
    });

    it('whose settling attempt was charged back offers Mark unpaid and no Refund', () => {
      renderWith([attempt({ settledPayment: false, chargedBackAt: new Date('2026-06-14T10:00:00Z') })]);
      expect(screen.getByRole('button', { name: /Mark unpaid/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Refund/ })).not.toBeInTheDocument();
    });

    it('paid by hand is unchanged: Mark unpaid and no Refund', () => {
      renderWith([]);
      expect(screen.getByRole('button', { name: /Mark unpaid/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Refund/ })).not.toBeInTheDocument();
    });

    it('with a refund on its way says so, offering neither', () => {
      renderWith([attempt({ refunds: [{ status: 'processing' }] })]);
      expect(screen.getByText('Refund pending')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Refund/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Mark unpaid/ })).not.toBeInTheDocument();
    });

    it('whose refund failed says so and offers Refund again', () => {
      renderWith([attempt({ refunds: [{ status: 'failed' }] })]);
      expect(screen.getByText('Refund failed')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Refund iDEAL/ })).toBeInTheDocument();
    });

    it('paid by hand and again through Mollie offers the duplicate’s Refund beside Mark unpaid', () => {
      renderWith([attempt({ settledPayment: false, method: 'creditcard' })]);
      expect(screen.getByRole('button', { name: /Mark unpaid/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Refund Card €14\.00/ })).toBeInTheDocument();
    });

    describe('refunded from the row', () => {
      afterEach(() => vi.unstubAllGlobals());

      it('shows Refund pending once Mollie accepts the refund, and refreshes', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ data: { refundStatus: 'queued', outcomeApplied: false, payment: { id: 'pay-1' } } }), { status: 200 }),
        );
        vi.stubGlobal('fetch', fetchMock);
        renderWith([attempt()]);

        fireEvent.click(screen.getByRole('button', { name: /^Refund iDEAL/ }));
        fireEvent.click(screen.getByRole('radio', { name: 'Refund and waive' }));
        fireEvent.click(screen.getByRole('button', { name: 'Refund €14.00' }));

        expect(await screen.findByText('Refund pending')).toBeInTheDocument();
        await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.getByText('Refund pending')).toHaveFocus();
      });

      it('shows a refund Mollie answered failed as failed, offering it again', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ data: { refundStatus: 'failed', outcomeApplied: false, payment: { id: 'pay-1' } } }), { status: 200 }),
        ));
        renderWith([attempt()]);

        fireEvent.click(screen.getByRole('button', { name: /^Refund iDEAL/ }));
        fireEvent.click(screen.getByRole('radio', { name: 'Refund and ask again' }));
        fireEvent.click(screen.getByRole('button', { name: 'Refund €14.00' }));

        expect(await screen.findByText('Refund failed')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^Refund iDEAL/ })).toBeInTheDocument();
      });

      it('follows the server once its refunds change after the refresh', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ data: { refundStatus: 'queued', outcomeApplied: false, payment: { id: 'pay-1' } } }), { status: 200 }),
        ));
        const { rerender } = render(<ReceivedPaymentRow currency="EUR" {...base} paidAt={null} timeZone="UTC" processorAttempts={[attempt()]} />);
        fireEvent.click(screen.getByRole('button', { name: /^Refund iDEAL/ }));
        fireEvent.click(screen.getByRole('radio', { name: 'Refund and waive' }));
        fireEvent.click(screen.getByRole('button', { name: 'Refund €14.00' }));
        expect(await screen.findByText('Refund pending')).toBeInTheDocument();

        rerender(<ReceivedPaymentRow currency="EUR" {...base} paidAt={null} timeZone="UTC" processorAttempts={[attempt({ refunds: [{ status: 'failed' }] })]} />);

        expect(screen.getByText('Refund failed')).toBeInTheDocument();
      });
    });
  });
});
