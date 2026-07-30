import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OutstandingPaymentRow } from './outstanding-payment-row';

/**
 * #59. Two Outstanding rows for the same student used to share accessible
 * names. The reminder button had a partial disambiguator — class type and
 * date, no time — so it collided for a morning and an evening class of the
 * same type on one day; "Mark paid" and "Undo" had none at all and collided
 * for any two outstanding payments the student had.
 *
 * The fixture is the narrowest case that breaks all three: one student, one
 * class type, one day, two times. A fixture differing in type or date would
 * pass on the pre-fix code for the reminder button and prove nothing.
 */
describe('OutstandingPaymentRow', () => {
  const base = {
    studentName: 'Ana de Vries',
    amount: 18,
    status: 'pending' as const,
    reminderSentAt: null,
  };

  function renderCollidingPair() {
    render(
      <>
        <OutstandingPaymentRow
          {...base}
          paymentId="pay-morning"
          classId="cls-morning"
          classContext="Vinyasa · Jun 12 · 09:30"
        />
        <OutstandingPaymentRow
          {...base}
          paymentId="pay-evening"
          classId="cls-evening"
          classContext="Vinyasa · Jun 12 · 18:00"
        />
      </>,
    );
  }

  it('gives the reminder buttons distinct accessible names', () => {
    renderCollidingPair();

    expect(
      screen.getByRole('button', { name: 'Send reminder to Ana de Vries for Vinyasa · Jun 12 · 09:30' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Send reminder to Ana de Vries for Vinyasa · Jun 12 · 18:00' }),
    ).toBeInTheDocument();
  });

  it('gives the mark-paid buttons distinct accessible names', () => {
    renderCollidingPair();

    expect(
      screen.getByRole('button', { name: "Mark Ana de Vries's payment as paid for Vinyasa · Jun 12 · 09:30" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: "Mark Ana de Vries's payment as paid for Vinyasa · Jun 12 · 18:00" }),
    ).toBeInTheDocument();
  });

  /**
   * The collision is visual too — two identical captions with the same amount
   * are ambiguous to a sighted teacher. Asserted separately from the labels
   * because they are one string by design: if that ever stops being true,
   * this is the test that notices.
   */
  it('renders distinct visible captions', () => {
    renderCollidingPair();

    expect(screen.getByText('Vinyasa · Jun 12 · 09:30')).toBeInTheDocument();
    expect(screen.getByText('Vinyasa · Jun 12 · 18:00')).toBeInTheDocument();
  });
});
