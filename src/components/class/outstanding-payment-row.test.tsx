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
 * The fixture is one student, one class type, one day, two times — the
 * narrowest case that breaks all three *on the real page*.
 *
 * Be clear about what that means here, because it is easy to overread: at this
 * level only the mark-paid test fails against the pre-fix component, since its
 * label carried no context at all and so collides however the two rows differ.
 * A type- or date-varying fixture would have failed exactly the same one test.
 * The time fixture is preferred for what it documents, not for what it catches:
 * it encodes the case the reminder button's partial disambiguator could not
 * tell apart, which is the product bug #59 reports.
 *
 * The other two tests pass before and after. They are not decoration — they are
 * the only thing enforcing "one string, three consumers": the reminder test
 * pins that the row keeps passing `classContext` into a `context` prop that is
 * `string | null` and that a sibling consumer (`payment-checklist.tsx`)
 * deliberately passes `null` to; the caption test pins that what is on screen
 * is that same string and not a derived subset.
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
