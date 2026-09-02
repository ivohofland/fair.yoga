import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GettingStarted } from './getting-started';
import { routerRefresh } from '../../../tests/setup/components';

type Props = ComponentProps<typeof GettingStarted>;

/**
 * #385 (Task 6). The five-state checklist: four rows (profile → bank → room
 * → class) plus a completion card, replacing the old three-row version that
 * had no profile row, no share state, and no Skip control at all.
 *
 * Each row's Skip control must be a SIBLING of the row's `<Link>`, never
 * nested inside it — a `<button>` inside an `<a>` is invalid interactive
 * content nesting and a real screen-reader defect, which is exactly the shape
 * the old whole-row `<Link>` would produce if a Skip button were dropped in
 * naively. `link.parentElement === skipButton.parentElement` pins the two as
 * siblings under the same row container; `skipButton.closest('a')` pins the
 * button as never nested inside an anchor.
 */
describe('GettingStarted', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch(response: { ok: boolean; json?: () => Promise<unknown> } = { ok: true }): void {
    fetchMock.mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
  }

  const nothingDone: Props = {
    bio: '',
    bankIban: null,
    roomCount: 0,
    classCount: 0,
    skipped: [],
    pageSlug: 'jane-doe',
  };

  describe('the checklist', () => {
    it('renders the four rows in order profile, bank, room, class', () => {
      stubFetch();
      render(<GettingStarted {...nothingDone} />);

      const links = screen.getAllByRole('link');
      expect(links.map((l) => l.textContent)).toEqual([
        expect.stringContaining('Complete your profile'),
        expect.stringContaining('Add your bank details'),
        expect.stringContaining('Add a room'),
        expect.stringContaining('Create your first class'),
      ]);
    });

    it('shows a Skip control on exactly the first two rows', () => {
      stubFetch();
      render(<GettingStarted {...nothingDone} />);

      expect(screen.getByRole('button', { name: 'Skip complete your profile' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Skip add your bank details' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /skip add a room/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /skip create your first class/i })).not.toBeInTheDocument();

      // Exactly two Skip buttons total — room and class carry no control at all.
      const skipButtons = screen.getAllByRole('button', { name: /^Skip /i });
      expect(skipButtons).toHaveLength(2);
    });

    it('renders each Skip button as a sibling of its row link, never nested inside it', () => {
      stubFetch();
      render(<GettingStarted {...nothingDone} />);

      const profileLink = screen.getByRole('link', { name: /Complete your profile/ });
      const profileSkip = screen.getByRole('button', { name: 'Skip complete your profile' });

      expect(profileSkip.closest('a')).toBeNull();
      expect(profileLink.parentElement).toBe(profileSkip.parentElement);
    });

    it('posts the step key and refreshes when a row is skipped', async () => {
      stubFetch({ ok: true });
      render(<GettingStarted {...nothingDone} />);

      screen.getByRole('button', { name: 'Skip add your bank details' }).click();

      await vi.waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith('/api/account/onboarding', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ step: 'bank' }),
        }),
      );
      await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    });

    it('does not render the completion card while a row is still todo', () => {
      stubFetch();
      render(<GettingStarted {...nothingDone} />);

      expect(screen.queryByText(/Share booking link/i)).not.toBeInTheDocument();
    });

    it('renders a skipped row muted, with a dash icon and no detail, chevron, or Skip control, while other rows are still todo', () => {
      stubFetch();
      const mixed: Props = { ...nothingDone, skipped: ['bank'] };
      render(<GettingStarted {...mixed} />);

      // The row list is still showing — this is the mid-checklist state, not
      // the completion card.
      expect(screen.getByRole('link', { name: /Complete your profile/ })).toBeInTheDocument();

      const bankRow = screen.getByRole('link', { name: /Add your bank details/ }).closest('div');
      expect(bankRow).not.toBeNull();
      // The dash icon (aria-hidden, since the row's accessible name already
      // says "skipped" via its text) in place of the todo/done indicator.
      expect(bankRow!.querySelector('[aria-hidden="true"]')?.textContent).toBe('–');
      // No detail line, no chevron, and no Skip button for a settled row —
      // those are `step.state === 'todo'`-gated in GettingStarted.
      expect(screen.queryByText('Students see them when it’s time to pay — skip if you take cash')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /skip add your bank/i })).not.toBeInTheDocument();
      // Muted text colour (text-brown), not the todo colour (text-ink).
      const bankLabel = screen.getByText('Add your bank details');
      expect(bankLabel.className).toContain('text-brown');
      expect(bankLabel.className).not.toContain('text-ink');

      // The still-todo rows are unaffected: profile keeps its Skip control.
      expect(screen.getByRole('button', { name: 'Skip complete your profile' })).toBeInTheDocument();
    });
  });

  describe('the completion card', () => {
    const settled: Props = {
      bio: 'Yoga since 2009.',
      bankIban: null,
      roomCount: 1,
      classCount: 1,
      skipped: ['bank'],
      pageSlug: 'jane-doe',
    };

    it('appears once every step is done or skipped, and the rows disappear', () => {
      stubFetch();
      render(<GettingStarted {...settled} />);

      expect(screen.queryAllByRole('link')).toHaveLength(0);
      expect(screen.getByText(/Share booking link/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
    });

    it('dismisses by posting step: share and refreshing', async () => {
      stubFetch({ ok: true });
      render(<GettingStarted {...settled} />);

      screen.getByRole('button', { name: /dismiss/i }).click();

      await vi.waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith('/api/account/onboarding', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ step: 'share' }),
        }),
      );
      await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    });
  });

  describe('once share is dismissed', () => {
    it('renders nothing at all', () => {
      stubFetch();
      const { container } = render(
        <GettingStarted
          bio="Yoga since 2009."
          bankIban="NL00BANK0123456789"
          roomCount={1}
          classCount={1}
          skipped={['bank', 'share']}
          pageSlug="jane-doe"
        />,
      );

      expect(container).toBeEmptyDOMElement();
    });

    // Even mid-flow (a required step still todo), a dismissed share should
    // never resurrect the card — the row list only ever renders while share
    // has NOT been dismissed, and this input pairs "share dismissed" with an
    // otherwise-impossible-via-the-page combination on purpose, to pin that
    // the component's own null-return does not depend on `settled`.
    it('renders nothing even if a required step is still outstanding', () => {
      stubFetch();
      const { container } = render(
        <GettingStarted
          bio=""
          bankIban={null}
          roomCount={0}
          classCount={0}
          skipped={['share']}
          pageSlug="jane-doe"
        />,
      );

      expect(container).toBeEmptyDOMElement();
    });
  });
});
