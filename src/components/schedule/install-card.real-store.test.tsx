import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Renders `InstallCard` against the real, unmocked install store, so a
 * dispatched `beforeinstallprompt` reaches the card through
 * `useSyncExternalStore`.
 */
describe('InstallCard against the real install store', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('stays visible after a dismissed prompt and offers the manual route', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(pointer: coarse)',
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    // A fresh module graph: the store's module-scope singleton is created
    // from `window` the moment it loads, and the card keeps its own
    // once-per-page dismissal guard at module scope too.
    vi.resetModules();
    const { InstallCard } = await import('./install-card');

    render(<InstallCard dismissed={false} />);

    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: 'dismissed' as const, platform: 'web' }),
    });
    window.dispatchEvent(event);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Show me how' })).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
