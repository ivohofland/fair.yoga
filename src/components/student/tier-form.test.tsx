import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TierForm } from './tier-form';

/**
 * #136. This form's reverse pin proves its one key, `incomeTier`, is one
 * `updateStudentSchema` accepts. Like `notifications-form.tsx`, it
 * deliberately has no forward pin — see that file's comment for why. This
 * test holds what the pin cannot see: the exact key set that reaches the
 * API, and that picking a different tier changes the value sent.
 *
 * Nothing fetches on mount, so the save click is the first (and only) call.
 */
describe('TierForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
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
});
