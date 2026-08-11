import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StudioTemplateForm } from './studio-template-form';
import { routerPush } from '../../../tests/setup/components';

/**
 * #136. This form enumerated its six fields four times — the `initial` prop's
 * inline type, `INITIAL_VALUES`, the POST/PUT body, and the caller's own
 * inline literal in `settings/studio-classes/[id]/page.tsx` — and nothing
 * checked that they agreed with each other or with
 * `createStudioClassTemplateSchema` / `updateStudioClassTemplateSchema`.
 * That fourth copy is why `StudioTemplateFormValues` is exported rather than
 * kept module-private. The compile-time pins in the source file hold it
 * against both wire schemas; this test holds what a pin cannot see, which is
 * what actually reaches the API in each mode.
 *
 * Neither mode fetches anything on mount, so the submit request is the first
 * (and only) `fetch` call.
 */
describe('StudioTemplateForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  /**
   * Returns the URL and method alongside the parsed body — not just the body
   * — so a test can pin `calls.at(-1)` to the request it means.
   */
  async function submit(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
    const button = await screen.findByRole('button', { name: /save|create/i });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
    const [url, options] = fetchMock.mock.calls.at(-1) ?? [];
    const opts = options as { method: string; body: string };
    return {
      url: url as string,
      method: opts.method,
      body: JSON.parse(opts.body) as Record<string, unknown>,
    };
  }

  const SIX_KEYS = ['classType', 'dayOfWeek', 'durationMinutes', 'hourlyRate', 'location', 'startTime'];

  /**
   * One body serves two endpoints, so the key-set has to hold in both modes —
   * a create-only or edit-only assertion would miss a schema that drifted
   * only on the other endpoint. Each mode gets its own `render`/`unmount`
   * rather than `rerender`, because `useState(initial ?? INITIAL_VALUES)`
   * only reads its initializer on mount: reusing one instance across modes
   * would carry the create-mode fill-ins into the edit-mode assertion instead
   * of exercising `initial` at all.
   */
  it('sends the same six fields in both create and update modes', async () => {
    stubFetch();
    const create = render(<StudioTemplateForm mode="create" />);
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });
    const created = await submit();
    expect(created.url).toBe('/api/studio-class-templates');
    expect(created.method).toBe('POST');
    expect(Object.keys(created.body).sort()).toEqual(SIX_KEYS);
    create.unmount();

    fetchMock.mockReset();
    stubFetch();
    render(
      <StudioTemplateForm
        mode="edit"
        templateId="tpl-1"
        initial={{
          classType: 'Vinyasa',
          dayOfWeek: 2,
          startTime: '09:30',
          durationMinutes: 60,
          location: 'Studio A',
          hourlyRate: 20,
        }}
      />,
    );
    const updated = await submit();
    expect(updated.url).toBe('/api/studio-class-templates/tpl-1');
    expect(updated.method).toBe('PUT');
    expect(Object.keys(updated.body).sort()).toEqual(SIX_KEYS);
  });

  /**
   * The key-set test above uses inputs with no whitespace, so it cannot see
   * `form.classType.trim()` / `form.location.trim()` in `handleSubmit`'s
   * payload construction. This asserts the full body by value.
   */
  it('trims classType and location before sending', async () => {
    stubFetch();
    render(<StudioTemplateForm mode="create" />);
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: '  Vinyasa  ' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: '  Studio A  ' } });
    const created = await submit();
    expect(created.body).toEqual({
      classType: 'Vinyasa',
      dayOfWeek: 0,
      startTime: '09:00',
      durationMinutes: 60,
      location: 'Studio A',
      hourlyRate: 0,
    });
  });

  /**
   * #40, the studio twin of the class-template guard. POST
   * /api/studio-class-templates is not idempotent: a second request creates a
   * second template and a second generated window, double-counting studio
   * income. Asserted on the fetch count, not on rendered text.
   *
   * `handleSubmit` only guards `location` before the request (not `classType`),
   * but both are filled here to match the create-mode setup used by the tests
   * above — an empty `classType` reaching the server is not this test's
   * concern, and filling it keeps this test unaffected if that guard changes.
   */
  // G9
  it('cannot submit twice when the create push commits nothing', async () => {
    stubFetch();
    render(<StudioTemplateForm mode="create" />);
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });

    const button = await screen.findByRole('button', { name: /create/i });
    fireEvent.click(button);

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/settings/studio-classes'));

    const callsAfterFirstSubmit = fetchMock.mock.calls.length;
    expect(screen.queryByRole('button', { name: /^create$/i })).toBeNull();
    expect(screen.getByText(/^Created/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /go to studio classes/i }));
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstSubmit);
    // Review F8, as in the class-template twin: one path, asserted on both the
    // create push and the settled retry.
    expect(routerPush).toHaveBeenNthCalledWith(2, '/settings/studio-classes');
  });
});
