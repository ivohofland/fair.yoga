import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToggleTemplateButton } from './toggle-template-button';
import { routerRefresh } from '../../../tests/setup/components';
// Importing the mock fns from the setup file relies on Vitest giving the test
// and the setup file the same module instance. If that does not hold in
// practice, move the `vi.mock('next/navigation', …)` block into each test file
// instead and say so in your report — do not paper over it with a second mock.

/**
 * #99. The `?state=` target is derived inline, beside the label ternary that
 * reads the same prop — deliberately, so the two cannot disagree about which
 * direction a click means. Nothing asserted that they agree until this file.
 *
 * The resolver these buttons call is already unit-tested as a pure function;
 * what only a rendered test can see is whether the button *sends* the right
 * request and *displays* what the resolver returned.
 */
describe('ToggleTemplateButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch(response: {
    ok: boolean;
    json?: () => Promise<unknown>;
  }): void {
    fetchMock.mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
  }

  const pausedOk = {
    ok: true,
    json: async () => ({
      data: {
        action: 'paused',
        lastScheduled: { date: '2026-06-12T00:00:00.000Z', startTime: '09:30' },
      },
    }),
  };

  it('sends state=active when the template is not active', async () => {
    stubFetch({ ok: true, json: async () => ({ data: { action: 'active' } }) });
    render(<ToggleTemplateButton templateId="tpl-1" isActive={false} />);

    fireEvent.click(screen.getByRole('button'));

    // The whole URL, not a substring: `toContain('state=')` would survive the
    // template id being dropped, which is exactly the wiring error this catches.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/class-templates/tpl-1?state=active', {
        method: 'PATCH',
      }),
    );
  });

  it('sends state=paused when the template is active', async () => {
    stubFetch(pausedOk);
    render(<ToggleTemplateButton templateId="tpl-1" isActive={true} />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/class-templates/tpl-1?state=paused', {
        method: 'PATCH',
      }),
    );
  });

  it('renders the confirmation rather than merely computing it', async () => {
    stubFetch(pausedOk);
    render(<ToggleTemplateButton templateId="tpl-1" isActive={true} />);

    fireEvent.click(screen.getByRole('button'));

    // Queried from the DOM, and the whole string: `pauseMessage` interpolates
    // both `formatDayHeader(lastScheduled.date)` and `lastScheduled.startTime`,
    // so a component that dropped either — or passed the raw ISO string
    // instead of a `Date` — would fail this and pass a prefix-only regex.
    expect(
      await screen.findByText(
        'No new classes will be added to your schedule. The last one still scheduled is Friday, Jun 12 · 09:30.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('renders the server error message when the request fails', async () => {
    stubFetch({ ok: false, json: async () => ({ error: { message: 'Class template not found' } }) });
    render(<ToggleTemplateButton templateId="tpl-1" isActive={true} />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Class template not found')).toBeInTheDocument();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('disables the button while the request is in flight', async () => {
    let release!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ToggleTemplateButton templateId="tpl-1" isActive={true} />);
    const button = screen.getByRole('button');
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());

    release(pausedOk);
    await waitFor(() => expect(button).toBeEnabled());
  });
});
