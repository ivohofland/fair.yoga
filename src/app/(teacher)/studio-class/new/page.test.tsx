import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewStudioClassPage from './page';

/**
 * #136. This page keeps its six fields in separate `useState` hooks and used to
 * restate them again in the POST body, with nothing checking the two agreed
 * with `createStudioClassSchema`. The hooks are still there; only the
 * duplication in the body went — the body is now spread from
 * `StudioClassFormValues`. The compile-time pins in the source file hold
 * `StudioClassFormValues` against the schema with no exclusions — `studentCount`
 * and `templateId` are gone from the create schema entirely as of #148, for
 * the reasons at `page.tsx:28-40` — this test holds what a pin cannot see,
 * which is what actually reaches the API.
 *
 * The page fetches nothing on mount, so the submit request is the first (and
 * only) `fetch` call.
 */
describe('NewStudioClassPage', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: 'studio-class-1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('sends exactly these six fields', async () => {
    stubFetch();
    render(<NewStudioClassPage />);

    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:00' } });

    const button = screen.getByRole('button', { name: /log class/i });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));

    const [url, options] = fetchMock.mock.calls.at(-1) ?? [];
    const opts = options as { method: string; body: string };
    const body = JSON.parse(opts.body) as Record<string, unknown>;

    expect(url).toBe('/api/studio-classes');
    expect(opts.method).toBe('POST');
    expect(Object.keys(body).sort()).toEqual([
      'classType',
      'date',
      'durationMinutes',
      'hourlyRate',
      'location',
      'startTime',
    ]);
  });

  /**
   * The key-set test above uses inputs with no whitespace and numeric fields
   * that happen to look the same whether or not `Number(...)` runs, so it
   * cannot see `classType.trim()`, `location.trim()`, or the `Number(...)`
   * calls on `durationMinutes`/`hourlyRate` in `page.tsx`'s `handleSubmit`.
   * This test feeds padded text and asserts the full body by value —
   * including `typeof` via `toEqual`, which distinguishes `75` from `'75'`.
   */
  it('trims text fields and sends duration and rate as numbers', async () => {
    stubFetch();
    render(<NewStudioClassPage />);

    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: '  Vinyasa  ' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: '  Studio A  ' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '10:15' } });
    fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '75' } });
    fireEvent.change(screen.getByLabelText('Hourly rate'), { target: { value: '22.5' } });

    const button = screen.getByRole('button', { name: /log class/i });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));

    const [, options] = fetchMock.mock.calls.at(-1) ?? [];
    const opts = options as { method: string; body: string };
    const body = JSON.parse(opts.body) as Record<string, unknown>;

    expect(body).toEqual({
      classType: 'Vinyasa',
      location: 'Studio A',
      date: '2026-08-10',
      startTime: '10:15',
      durationMinutes: 75,
      hourlyRate: 22.5,
    });
  });
});
