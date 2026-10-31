import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('@/embed/schedule-widget', () => ({ defineScheduleElement: vi.fn() }));

import { ShareSchedule } from './share-schedule';
import type { ScheduleShareState } from '@/services/schedule-share';

const ON: ScheduleShareState = { key: 'k7Qm2xR9vT', weeks: 4, includeStudio: false };
const OFF: ScheduleShareState = { key: null, weeks: 4, includeStudio: false };

function renderPage(initial: ScheduleShareState = ON) {
  return render(<ShareSchedule origin="https://fair.yoga" slug="anna" initial={initial} />);
}

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: body }), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ShareSchedule', () => {
  it('offers only a Turn on button while sharing is off', () => {
    renderPage(OFF);
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeInTheDocument();
    expect(screen.queryByText('Your code')).not.toBeInTheDocument();
  });

  it('shows the embed code and the feed link while sharing is on', () => {
    renderPage();
    expect(screen.getByText(/<fair-yoga-schedule schedule-key="k7Qm2xR9vT" theme="themed" color-scheme="light">/)).toBeInTheDocument();
    expect(screen.getByText('https://fair.yoga/feed/k7Qm2xR9vT.ics')).toBeInTheDocument();
  });

  it('defaults Colours to Light, and labels Auto so a teacher knows what it follows', () => {
    renderPage();
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Auto follows the visitor’s dark mode. Pick it if your site does too.')).toBeInTheDocument();
  });

  it('hides Colours, and the code drops color-scheme, when "Your site\'s" is picked', () => {
    renderPage();
    expect(screen.getByRole('radiogroup', { name: 'Colours' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Your site’s' }));
    expect(screen.queryByRole('radiogroup', { name: 'Colours' })).not.toBeInTheDocument();
    expect(screen.queryByText(/color-scheme/)).not.toBeInTheDocument();
    expect(screen.getByText('On your site this takes your own fonts and colours.')).toBeInTheDocument();
  });

  it('saves weeks ahead and the studio switch with a PATCH', async () => {
    const fetchMock = stubFetch({ ...ON, weeks: 2 });
    renderPage();
    fireEvent.click(screen.getByRole('radio', { name: '2' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/account/schedule-share');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ weeks: 2 });
    await waitFor(() => expect(screen.getByRole('radio', { name: '2' })).toHaveAttribute('aria-checked', 'true'));
  });

  it('spells out all three consequences in the turn-off sheet, with Keep sharing focused', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off sharing…' }));
    const sheet = await screen.findByRole('dialog', { hidden: true });
    expect(within(sheet).getByText('Turn off sharing?')).toBeInTheDocument();
    expect(
      within(sheet).getByText('Your schedule disappears from every website where you pasted the code. Visitors see only a link to your fair.yoga page.'),
    ).toBeInTheDocument();
    expect(within(sheet).getByText('Students subscribed to your calendar feed stop getting updates.')).toBeInTheDocument();
    expect(
      within(sheet).getByText('If you turn sharing on again, you get new code and a new feed link — the old ones won’t come back.'),
    ).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Turn off', hidden: true })).toBeInTheDocument();
    await waitFor(() => expect(within(sheet).getByRole('button', { name: 'Keep sharing', hidden: true })).toHaveFocus());
  });

  it('states what a reset takes away before it happens', async () => {
    renderPage();
    expect(
      screen.getByText(
        'Takes your schedule off sites you can’t edit anymore, like an old website or a page someone copied your code to. Your own site needs the new code afterwards, and the calendar feed link changes, so students who subscribed will need the new link.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset embed key…' }));
    const sheet = await screen.findByRole('dialog', { hidden: true });
    expect(within(sheet).getByText('Students subscribed to your calendar feed will stop getting updates.')).toBeInTheDocument();
  });

  it('shows a failed turn-off inside the sheet, where the page behind is inert', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off sharing…' }));
    const sheet = await screen.findByRole('dialog', { hidden: true });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Turn off', hidden: true }));
    expect(await within(sheet).findByRole('alert', { hidden: true })).toHaveTextContent('Network error. Please try again.');
  });

  it('switches to the off state, closes the sheet and says so when a reset finds sharing already off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Sharing is off, so there is no link to reset.', code: 'SCHEDULE_SHARE_OFF' } }), { status: 409 })),
    );
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Reset embed key…' }));
    const sheet = await screen.findByRole('dialog', { hidden: true });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Reset key', hidden: true }));
    expect(await screen.findByRole('button', { name: 'Turn on' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Sharing was already off.');
    expect(screen.queryByText('Your code')).not.toBeInTheDocument();
  });

  it('shows the state the server returns when turning on was already done', async () => {
    stubFetch({ ...ON, weeks: 3 });
    renderPage(OFF);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: '3' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText('https://fair.yoga/feed/k7Qm2xR9vT.ics')).toBeInTheDocument();
  });

  it('announces a copy and forgets it when the code changes', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Code copied');
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
});
