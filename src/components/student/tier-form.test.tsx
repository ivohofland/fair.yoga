import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TierForm } from './tier-form';

/**
 * #136. The reverse pin in `tier-form.tsx` proves its key is one
 * `updateStudentSchema` accepts, but cannot see what reaches the API. That
 * is what these tests hold: what the pin cannot see — the exact key set
 * that reaches the API, and how the form behaves when the request fails.
 *
 * Nothing fetches on mount, so the save click is the first (and only) call.
 */
describe('TierForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch() {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  }

  async function save(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
    fireEvent.click(screen.getByRole('button', { name: /save tier/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    const opts = options as { method: string; body: string };
    return {
      url: url as string,
      method: opts.method,
      body: JSON.parse(opts.body) as Record<string, unknown>,
    };
  }

  it('introduces the picker in the product\'s own words, with no borrowed quote', () => {
    stubFetch();
    render(<TierForm studentId="student-1" currentTier={3} />);
    expect(
      screen.getByText(
        'Your price for every class is based on what you can comfortably contribute. Tiers are self-reported. No proof needed, and you can change yours here at any time.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Pick the tier that fits your life right now, not the one you feel you should be in.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Lasater/)).not.toBeInTheDocument();
    expect(screen.getByText('Bills covered, some left over')).toBeInTheDocument();
    expect(screen.getByText('Money isn\u2019t a worry')).toBeInTheDocument();
  });

  it('sends exactly incomeTier', async () => {
    stubFetch();
    render(<TierForm studentId="student-1" currentTier={3} />);
    const { url, method, body } = await save();
    expect(url).toBe('/api/students/student-1');
    expect(method).toBe('PUT');
    expect(Object.keys(body).sort()).toEqual(['incomeTier']);
    expect(body).toEqual({ incomeTier: 3 });
  });

  it('sends a newly selected tier, not just the initial one', async () => {
    stubFetch();
    render(<TierForm studentId="student-1" currentTier={3} />);
    fireEvent.click(screen.getByRole('radio', { name: /Tier 1 · Getting by/i }));
    const { body } = await save();
    expect(body).toEqual({ incomeTier: 1 });
  });

  it('selects nothing and refuses to save when the stored tier is unreadable', () => {
    stubFetch();
    render(<TierForm studentId="student-1" currentTier={null} />);
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveAttribute('aria-checked', 'false');
    }
    const button = screen.getByRole('button', { name: /save tier/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('saves the tier the student picks in place of an unreadable one', async () => {
    stubFetch();
    render(<TierForm studentId="student-1" currentTier={null} />);
    fireEvent.click(screen.getByRole('radio', { name: /Tier 4 · Doing well/i }));
    expect(screen.getByRole('button', { name: /save tier/i })).toBeEnabled();
    const { body } = await save();
    expect(body).toEqual({ incomeTier: 4 });
  });

  it('logs the failure and tells the student when fetch itself fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<TierForm studentId="student-1" currentTier={3} />);

    fireEvent.click(screen.getByRole('button', { name: /save tier/i }));
    await waitFor(() => {
      expect(screen.getByText('Network error. Try again.')).toBeInTheDocument();
    });
    expect(logged).toHaveBeenCalledWith('[tier-form] request failed', { err: expect.any(Error) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('logs and surfaces the server message when the response is not ok', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Income tier must be 1-5' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<TierForm studentId="student-1" currentTier={3} />);

    fireEvent.click(screen.getByRole('button', { name: /save tier/i }));
    await waitFor(() => {
      expect(screen.getByText('Income tier must be 1-5')).toBeInTheDocument();
    });
    expect(logged).toHaveBeenCalledWith('student tier save failed (HTTP)', 400);
  });
});
