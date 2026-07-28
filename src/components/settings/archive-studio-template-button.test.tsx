import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ArchiveStudioTemplateButton } from './archive-studio-template-button';
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
describe('ArchiveStudioTemplateButton', () => {
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

  const archivedOk = {
    ok: true,
    json: async () => ({ data: { action: 'archived', deleted: 4, remaining: 1 } }),
  };

  it('sends state=archived when the template is not archived', async () => {
    stubFetch(archivedOk);
    render(<ArchiveStudioTemplateButton templateId="tpl-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    // The whole URL, not a substring: `toContain('state=')` would survive the
    // template id being dropped, which is exactly the wiring error this catches.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/studio-class-templates/tpl-1?state=archived', {
        method: 'PATCH',
      }),
    );
  });

  it('sends state=unarchived when the template is archived', async () => {
    stubFetch({ ok: true, json: async () => ({ data: { action: 'unarchived' } }) });
    render(<ArchiveStudioTemplateButton templateId="tpl-1" isArchived={true} />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/studio-class-templates/tpl-1?state=unarchived', {
        method: 'PATCH',
      }),
    );
  });

  it('renders the confirmation rather than merely computing it', async () => {
    stubFetch(archivedOk);
    render(<ArchiveStudioTemplateButton templateId="tpl-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    // Queried from the DOM, and the whole string rather than a shared prefix:
    // `archiveStudioMessage` has a `deleted === 0` branch and a `remaining === 0`
    // branch that both mention counts, and a component that silently dropped
    // `remaining` — the #93 bug this file's docblock cites — would render a
    // different branch and still match a prefix-only regex.
    expect(
      await screen.findByText(
        'Deleted 4 scheduled studio classes. 1 class still on the schedule — cancel individually if needed.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('renders the server error message when the request fails', async () => {
    stubFetch({ ok: false, json: async () => ({ error: { message: 'Studio class template not found' } }) });
    render(<ArchiveStudioTemplateButton templateId="tpl-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Studio class template not found')).toBeInTheDocument();
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

    render(<ArchiveStudioTemplateButton templateId="tpl-1" isArchived={false} />);
    const button = screen.getByRole('button');
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());

    release(archivedOk);
    await waitFor(() => expect(button).toBeEnabled());
  });
});
