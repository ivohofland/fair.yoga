import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ShareSchedule } from './share-schedule';

const ON = { key: 'k7Qm2xR9vT', weeks: 4, includeStudio: false };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ShareSchedule live preview (real widget)', () => {
  it('fetches the schedule bypassing the browser cache', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ timezone: 'UTC', classes: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ShareSchedule origin="https://fair.yoga" slug="anna" initial={ON} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${window.location.origin}/api/public/v1/schedule/k7Qm2xR9vT`);
    expect(init.cache).toBe('no-store');
  });

  it('says so when the preview cannot load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    render(<ShareSchedule origin="https://fair.yoga" slug="anna" initial={ON} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByText('The preview is unavailable right now. Try again in a minute.')).toBeInTheDocument();
  });

  it('says so when the fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
    render(<ShareSchedule origin="https://fair.yoga" slug="anna" initial={ON} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByText('The preview is unavailable right now. Try again in a minute.')).toBeInTheDocument();
  });
});
