import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ArchiveTemplateButton } from './archive-template-button';
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
describe('ArchiveTemplateButton', () => {
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

  function rejectFetch(error: Error): void {
    fetchMock.mockRejectedValue(error);
    vi.stubGlobal('fetch', fetchMock);
  }

  const archivedOk = {
    ok: true,
    json: async () => ({ data: { action: 'archived', deleted: 2, remaining: 1 } }),
  };

  it('sends state=archived when the template is not archived', async () => {
    stubFetch(archivedOk);
    render(<ArchiveTemplateButton templateId="tpl-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    // The whole URL, not a substring: `toContain('state=')` would survive the
    // template id being dropped, which is exactly the wiring error this catches.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/class-templates/tpl-1?state=archived', {
        method: 'PATCH',
      }),
    );
  });

  /**
   * The class-family twin of `archive-studio-template-button.test.tsx`'s
   * "reports that un-archiving left the template paused". Both directions of
   * `archiveOrUnarchiveTemplate` force `isActive: false` and the archive has
   * already deleted the future classes, so the teacher lands on a paused
   * template with an empty window; until #116 the class family said nothing
   * about it, which let them leave believing the class was restored.
   *
   * DOM-level rather than resolver-level on purpose: `template-action-messages
   * .test.ts` pins the string, this pins that the button actually renders it.
   */
  it('reports that un-archiving left the recurring class paused', async () => {
    stubFetch({ ok: true, json: async () => ({ data: { action: 'unarchived' } }) });
    render(<ArchiveTemplateButton templateId="tpl-1" isArchived={true} />);

    fireEvent.click(screen.getByRole('button'));

    expect(
      await screen.findByText(
        'Un-archived. This recurring class is paused — resume it to put classes back on your schedule.',
      ),
    ).toBeInTheDocument();
  });

  it('sends state=unarchived when the template is archived', async () => {
    stubFetch({ ok: true, json: async () => ({ data: { action: 'unarchived' } }) });
    render(<ArchiveTemplateButton templateId="tpl-1" isArchived={true} />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/class-templates/tpl-1?state=unarchived', {
        method: 'PATCH',
      }),
    );
  });

  it('renders the confirmation rather than merely computing it', async () => {
    stubFetch(archivedOk);
    render(<ArchiveTemplateButton templateId="tpl-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    // Queried from the DOM, and the whole string rather than a shared prefix:
    // "Classes on the schedule without bookings are now deleted." opens two
    // branches of `archiveMessage` (template-action-messages.ts), and only the
    // text after it depends on `deleted`/`remaining`. A component that
    // silently dropped `remaining` — the #93 bug this file's docblock cites —
    // would render the other branch and still match a prefix-only regex.
    // Asserting the resolver's return value would prove nothing this project
    // does not already prove in `unit`.
    expect(
      await screen.findByText(
        'Classes on the schedule without bookings are now deleted. 1 class still on the schedule — cancel individually if needed.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('renders the server error message when the request fails', async () => {
    stubFetch({ ok: false, json: async () => ({ error: { message: 'Class template not found' } }) });
    render(<ArchiveTemplateButton templateId="tpl-1" isArchived={false} />);

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

    render(<ArchiveTemplateButton templateId="tpl-1" isArchived={false} />);
    const button = screen.getByRole('button');
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());

    release(archivedOk);
    await waitFor(() => expect(button).toBeEnabled());
  });

  /** #193: unreadable 2xx body confirms the update and refreshes without reporting network error. */
  it('does not report a network error when the update succeeds but the body cannot be read', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    });
    render(<ArchiveTemplateButton templateId="tpl-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    expect(
      await screen.findByText('Updated, but could not read confirmation details.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Network error. Please try again.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(routerRefresh).toHaveBeenCalled();
    expect(screen.getByRole('button')).toBeEnabled();
    expect(consoleError).toHaveBeenCalledWith(
      '[archive-template] updated, but response body was unreadable',
      expect.objectContaining({ templateId: 'tpl-1' }),
    );
  });

  it('does not report a network error and still refreshes when the parsed body has no data field', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch({
      ok: true,
      json: async () => ({}),
    });
    render(<ArchiveTemplateButton templateId="tpl-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    expect(
      await screen.findByText('Updated, but could not read confirmation details.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Network error. Please try again.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(routerRefresh).toHaveBeenCalled();
    expect(screen.getByRole('button')).toBeEnabled();
    expect(consoleError).toHaveBeenCalledWith(
      '[archive-template] updated, but the confirmation could not be resolved',
      expect.objectContaining({ templateId: 'tpl-1' }),
    );
  });

  it('reports a network error when fetch itself throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    rejectFetch(new TypeError('Failed to fetch'));
    render(<ArchiveTemplateButton templateId="tpl-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(
      screen.queryByText('Updated, but could not read confirmation details.'),
    ).not.toBeInTheDocument();
    expect(routerRefresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button')).toBeEnabled();
    expect(consoleError).toHaveBeenCalledWith(
      '[archive-template] request failed',
      expect.objectContaining({ templateId: 'tpl-1' }),
    );
  });
});
