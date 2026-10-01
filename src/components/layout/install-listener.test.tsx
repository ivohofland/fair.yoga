import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

describe('installStore', () => {
  it('captures a prompt that fired before any component rendered', async () => {
    vi.resetModules();
    const { useInstallSupport } = await import('./install-store');
    window.dispatchEvent(
      Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
        prompt: vi.fn().mockResolvedValue(undefined),
        userChoice: Promise.resolve({ outcome: 'accepted' as const, platform: 'web' }),
      }),
    );

    function Probe() {
      return <span>{useInstallSupport()}</span>;
    }
    render(<Probe />);

    expect(screen.getByText('prompt')).toBeInTheDocument();
  });
});
