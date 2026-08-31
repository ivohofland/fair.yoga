import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    studentName: 'Ana d.',
    classType: 'Vinyasa',
    classDate: new Date('2026-06-12T00:00:00.000Z'),
    startTime: new Date('1970-01-01T09:30:00.000Z'),
    amount: 14,
  };

  it('shows the teacher’s day, not UTC’s, west of the meridian', () => {
    // 18:00 on 12 June in Los Angeles is 01:00 on 13 June UTC.
    render(
      <ReceivedPaymentRow
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
      <ReceivedPaymentRow
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
    render(<ReceivedPaymentRow {...base} paidAt={null} timeZone="America/Los_Angeles" />);

    expect(screen.queryByText(/✓ paid/)).not.toBeInTheDocument();
    expect(screen.getByText(/Vinyasa · 12 Jun · 09:30/)).toBeInTheDocument();
  });

  /**
   * #128. ReceivedPaymentRow threads studentName and classContext to
   * MarkUnpaidButton so the button has a distinct accessible name.
   */
  it('renders the mark-unpaid button with a disambiguated accessible name', () => {
    render(<ReceivedPaymentRow {...base} paidAt={null} timeZone="America/Los_Angeles" />);

    expect(
      screen.getByRole('button', { name: 'Mark unpaid — Ana d., Vinyasa · 12 Jun · 09:30' }),
    ).toBeInTheDocument();
  });
});
