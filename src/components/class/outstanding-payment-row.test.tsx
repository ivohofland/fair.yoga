import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
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
    // The two tests below spy on console.error, both to assert the log and to
    // keep the expected noise out of the suite's output.
    vi.restoreAllMocks();
  });

  function renderCollidingPair() {
    render(
      <>
        <OutstandingPaymentRow
          {...base}
          paymentId="pay-morning"
          classId="cls-morning"
          classContext="Vinyasa · 12 Jun · 09:30"
        />
        <OutstandingPaymentRow
          {...base}
          paymentId="pay-evening"
          classId="cls-evening"
          classContext="Vinyasa · 12 Jun · 18:00"
        />
      </>,
    );
  }

  it('gives the reminder buttons distinct accessible names', () => {
    renderCollidingPair();

    expect(
      screen.getByRole('button', { name: 'Send reminder to Ana de Vries for Vinyasa · 12 Jun · 09:30' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Send reminder to Ana de Vries for Vinyasa · 12 Jun · 18:00' }),
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
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 09:30' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 18:00' }),
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
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 09:30' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 18:00' }),
    );

    const morningUndo = await screen.findByRole('button', {
      name: 'Undo marking Ana de Vries as paid for Vinyasa · 12 Jun · 09:30',
    });
    expect(morningUndo).toBeInTheDocument();
    expect(
      await screen.findByRole('button', {
        name: 'Undo marking Ana de Vries as paid for Vinyasa · 12 Jun · 18:00',
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

    expect(screen.getByText('Vinyasa · 12 Jun · 09:30')).toBeInTheDocument();
    expect(screen.getByText('Vinyasa · 12 Jun · 18:00')).toBeInTheDocument();
  });

  /**
   * #58. `undo` renders whatever status the server's response carries, guard
   * included, rather than rendering the response verbatim or assuming the
   * result is always 'pending'. Today `unmarkPaymentPaid`
   * (services/payments.ts:91-97) always writes 'pending' unconditionally — the
   * daily dunning sweep re-derives 'overdue' later, from the payment's age —
   * so the 'overdue' response mocked below is a hypothetical exercising the
   * read path, not current server behavior. The round trip still earns its
   * keep: it is what keeps this correct the day `unmarkPaymentPaid` starts
   * returning a re-derived status itself, and this is the only test here that
   * fails if someone "simplifies" the round trip to a hardcoded 'pending'.
   */
  it('renders the status the undo response carries', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { status: 'overdue' } }) });
    vi.stubGlobal('fetch', fetchMock);
    renderCollidingPair();

    fireEvent.click(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 09:30' }),
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Undo marking Ana de Vries as paid for Vinyasa · 12 Jun · 09:30',
      }),
    );

    const overdueMarker = await screen.findByText('· ! overdue');
    expect(overdueMarker).toBeInTheDocument();
    expect(overdueMarker).toHaveClass('text-danger');
  });

  /**
   * The other half: a response the guard rejects falls back to 'pending', so no
   * overdue marker appears. Weak on its own — a hardcoded 'pending' would pass
   * it too — which is why the test above exists and is the load-bearing one.
   *
   * It also pins the log (#58 review). `readUndoStatus` now returns `null` for
   * a shape it cannot read and `undo` applies the `?? 'pending'`, so the
   * fabricated value is chosen where it is visible; the console line is the
   * only trace that it happened, since the banner deliberately stays empty —
   * the undo *did* succeed.
   */
  it('falls back to pending when the undo response carries a bad status', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { status: 'nonsense' } }) });
    vi.stubGlobal('fetch', fetchMock);
    renderCollidingPair();

    fireEvent.click(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 09:30' }),
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Undo marking Ana de Vries as paid for Vinyasa · 12 Jun · 09:30',
      }),
    );

    expect(
      await screen.findByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 09:30' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/! overdue/)).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      '[payment-undo] undone, but the response shape was unreadable',
      { paymentId: 'pay-morning' },
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * #58 review. `unmarkPaymentPaid` commits `status: 'pending'` before the
   * endpoint responds, so an `ok` response whose *body* will not parse — a
   * proxy error page, a truncated response on flaky wifi — describes a mutation
   * that already happened.
   *
   * That read used to sit inside the same `try` as the fetch, so a parse
   * failure set 'Network error. Try again.' and returned false: the row kept
   * `isPaid`, kept showing "✓ Paid" and its Undo button, and — because
   * `isOutstanding` derives from the same stale value — hid the reminder button
   * for a debt that now really existed. A second Undo then got the service's
   * contradictory `Cannot undo: current status is "pending"`.
   *
   * The three assertions are the three halves of that bug: the row leaves the
   * paid state, no error banner is raised, and `undo` returned true so the
   * caller's `router.refresh()` runs and reconciles against the server. Same
   * principle, and the same shape, as `send-reminder-button.tsx:71-86`.
   */
  it('treats a committed undo with an unreadable body as the success it is', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCollidingPair();

    fireEvent.click(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 09:30' }),
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Undo marking Ana de Vries as paid for Vinyasa · 12 Jun · 09:30',
      }),
    );

    expect(
      await screen.findByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 09:30' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(routerRefresh).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      '[payment-undo] undone, but the response body was unreadable',
      expect.objectContaining({ paymentId: 'pay-morning' }),
    );
  });

  /**
   * #133. The paid state renders from paymentStateText: label and className
   * are the contract.
   */
  it('renders the paid label with paymentStateText copy and styling', () => {
    render(
      <OutstandingPaymentRow
        {...base}
        paymentId="pay-paid"
        classId="cls-paid"
        classContext="Vinyasa · 12 Jun · 09:30"
        status="paid"
      />,
    );

    const paidBadge = screen.getByText('✓ Paid');
    expect(paidBadge).toBeInTheDocument();
    expect(paidBadge).toHaveClass('text-teal', 'type-caption');
  });

  /**
   * #134. When the mark-paid network request throws, the error is logged and
   * surfaced as a network error while the row stays in its unpaid state.
   */
  it('reports network failure on mark-paid when the request throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    renderCollidingPair();

    fireEvent.click(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 09:30' }),
    );

    expect(
      await screen.findByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 09:30' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Network error. Try again.');
    expect(consoleError).toHaveBeenCalledWith(
      '[payment-mark-paid] request failed',
      expect.objectContaining({ paymentId: 'pay-morning' }),
    );
  });

  /**
   * #134. A structured error body returned with a non-ok status is extracted
   * and displayed to the teacher rather than claiming a network error.
   */
  it('shows the server error message when mark-paid is refused with a JSON error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Payment already marked paid' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCollidingPair();

    fireEvent.click(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 09:30' }),
    );

    expect(
      await screen.findByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 09:30' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Payment already marked paid');
  });

  /**
   * #134. A non-ok response whose body does not parse as JSON (e.g. proxy HTML
   * error page) falls back to the generic server failure copy without claiming
   * the network failed.
   */
  it('reports a server error fallback rather than a network error when mark-paid returns an unreadable body', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCollidingPair();

    fireEvent.click(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 09:30' }),
    );

    expect(
      await screen.findByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 09:30' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not mark as paid. Try again.');
    expect(screen.queryByText('Network error. Try again.')).not.toBeInTheDocument();
  });
});
