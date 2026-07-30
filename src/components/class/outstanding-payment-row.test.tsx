import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
 * Be clear about what that means here, because it is easy to overread. Two of
 * these tests fail against the pre-fix component — mark-paid and undo — and
 * neither fails because of a collision. Both labels were rewritten outright
 * (`"Mark {name} payment as paid"` → `"Mark paid — {name}, {context}"`,
 * `"Undo marking {name} as paid"` → the same plus `" for {context}"`), so the
 * strings asserted below are simply *absent* pre-fix; each would fail against a
 * *single* row too. The pair fixture is not what makes them red. It guards
 * against a future collision, by the mechanism described next. A type- or
 * date-varying fixture would have failed exactly the same two tests: the time
 * fixture is preferred for what it documents, not for what it catches — it
 * encodes the case the reminder button's partial disambiguator could not tell
 * apart, which is the product bug #59 reports.
 *
 * The names are asserted as exact whole strings. Be precise about what that
 * buys, because the intuitive answer is wrong: exactness is *not* the collision
 * guard. On a colliding pair both accessible names are identical, so any query
 * — substring or exact — matches zero or two elements and `getByRole` throws
 * either way. Collisions are caught by that duplicate-match throw, and by
 * nothing else here. Which means the second row is load-bearing: delete it and
 * collision coverage goes with it, however exact the remaining strings are.
 *
 * What exactness buys is the copy. Superstring mutants — a label with
 * " (outstanding)" appended, a caption with " (unpaid)" — die under an exact
 * match and survive a substring one.
 *
 * Four of these tests pin the whole string reaching every consumer of
 * `classContext`: the two aria-labels this component builds itself, the
 * `context` prop it hands to `SendReminderButton`, and the visible caption.
 * That is literally every consumer, which it was not before the undo test
 * existed. The fifth pins something different and is described where it sits.
 * Little else pins any of this — `teacher-journey.spec.ts` reaches only the
 * reminder button and the two page-built captions, and asserts that each
 * *contains* the class start time rather than what the whole string is. The reminder test also pins
 * that the row keeps passing `classContext` into a `context` prop typed
 * `string | null`, which a sibling consumer (`payment-checklist.tsx`)
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

  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

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

  /**
   * These two lead with "Mark paid" rather than following the "… for {context}"
   * shape the other two labels share, and that asymmetry is the point: WCAG
   * 2.5.3 requires the visible text to sit contiguously and in order inside the
   * accessible name, and leading with it is what speech input matches on.
   * Asserted as whole strings, so a reshape of the *label* back to the parallel
   * phrasing is caught here and not in a speech-input user's session.
   */
  it('gives the mark-paid buttons distinct accessible names', () => {
    renderCollidingPair();

    expect(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · Jun 12 · 09:30' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · Jun 12 · 18:00' }),
    ).toBeInTheDocument();
  });

  /**
   * 2.5.3 is a relation between two strings, and every other test in this file
   * — and every test in the repo that reaches these buttons — pins only one of
   * them, the accessible name. That leaves the visible copy invisible to CI:
   * rename the button to "Settle" and the aria-label still says "Mark paid",
   * which is a clean 2.5.3 failure with a green suite. Found in review by
   * mutating exactly that and watching all 36 component tests and 18 e2e tests
   * pass.
   *
   * So assert the containment directly. The regexes deliberately pin only that
   * the name *starts with* the visible text — the rest of each label is pinned
   * by the tests above, and duplicating that here would mean two places to
   * update for one copy change. Undo is covered in the undo test below, which
   * already has that button in hand.
   */
  it('keeps each button visible text inside its accessible name', () => {
    renderCollidingPair();

    const markPaid = screen.getAllByRole('button', { name: /^Mark paid/ });
    expect(markPaid).toHaveLength(2);
    markPaid.forEach((button) => expect(button).toHaveTextContent('Mark paid'));

    const reminder = screen.getAllByRole('button', { name: /^Send reminder/ });
    expect(reminder).toHaveLength(2);
    reminder.forEach((button) => expect(button).toHaveTextContent('Send reminder'));
  });

  /**
   * Undo only renders for a payment marked paid *in this session* (the
   * `justMarked` gate), so reaching it means going through mark-paid — which
   * calls `fetch`. The stub is scaffolding to get past that gate, not the
   * subject: nothing below asserts on it. Both rows are clicked because both
   * can show Undo at once on the real page, each owning its own
   * `usePaymentActions` state — the same collision risk as the other two
   * labels, and until this test the only one of the three with no coverage
   * anywhere. (`teacher-journey.spec.ts` asserts an Undo name, but on
   * `payment-checklist.tsx`, a different component.)
   *
   * Note the coupling: this reaches Undo by clicking mark-paid *by its exact
   * accessible name*, so a mark-paid copy regression turns this test red too.
   * Two failures for one defect, which is noise but not a wrong signal.
   */
  it('gives the undo buttons distinct accessible names', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    renderCollidingPair();

    fireEvent.click(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · Jun 12 · 09:30' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · Jun 12 · 18:00' }),
    );

    const morningUndo = await screen.findByRole('button', {
      name: 'Undo marking Ana de Vries as paid for Vinyasa · Jun 12 · 09:30',
    });
    expect(morningUndo).toBeInTheDocument();
    expect(
      await screen.findByRole('button', {
        name: 'Undo marking Ana de Vries as paid for Vinyasa · Jun 12 · 18:00',
      }),
    ).toBeInTheDocument();
    // Undo's half of the 2.5.3 relation the test above pins for the other two.
    expect(morningUndo).toHaveTextContent('Undo');
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

  /**
   * #58. `undo` reads the post-undo status from the server rather than assuming
   * 'pending', because undo's result is a service decision and the domain
   * admits 'overdue' for an aged payment. This test is what makes that real:
   * it is the only one here that fails if someone "simplifies" the round trip
   * to a hardcoded 'pending'.
   */
  it('renders the status the undo response carries', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { status: 'overdue' } }) });
    vi.stubGlobal('fetch', fetchMock);
    renderCollidingPair();

    fireEvent.click(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · Jun 12 · 09:30' }),
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Undo marking Ana de Vries as paid for Vinyasa · Jun 12 · 09:30',
      }),
    );

    expect(await screen.findByText(/! overdue/)).toBeInTheDocument();
  });

  /**
   * The other half: a response the guard rejects falls back to 'pending', so no
   * overdue marker appears. Weak on its own — a hardcoded 'pending' would pass
   * it too — which is why the test above exists and is the load-bearing one.
   */
  it('falls back to pending when the undo response carries a bad status', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { status: 'nonsense' } }) });
    vi.stubGlobal('fetch', fetchMock);
    renderCollidingPair();

    fireEvent.click(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · Jun 12 · 09:30' }),
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Undo marking Ana de Vries as paid for Vinyasa · Jun 12 · 09:30',
      }),
    );

    expect(
      await screen.findByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · Jun 12 · 09:30' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/! overdue/)).not.toBeInTheDocument();
  });
});
