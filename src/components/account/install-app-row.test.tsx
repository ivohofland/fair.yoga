import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { InstallSupport } from '@/lib/install-support';

let support: InstallSupport = 'unknown';
const promptInstall = vi.fn();
vi.mock('@/components/layout/install-store', () => ({
  useInstallSupport: () => support,
  installStore: { promptInstall: (...args: unknown[]) => promptInstall(...args) },
}));

import { InstallAppRow } from './install-app-row';

describe('InstallAppRow', () => {
  beforeEach(() => {
    promptInstall.mockReset();
  });

  it.each(['unknown', 'installed', 'unsupported'] as const)('renders nothing when support is %s', (value) => {
    support = value;
    const { container } = render(<InstallAppRow />);
    expect(container).toBeEmptyDOMElement();
  });

  it('expands the iOS steps in place', () => {
    support = 'ios-safari';
    render(<InstallAppRow />);
    const row = screen.getByRole('button', { name: 'Add to Home Screen' });
    expect(row).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(row);

    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Add to Home Screen\. You may need to scroll/)).toBeInTheDocument();
  });

  it('opens the browser prompt when one is held', () => {
    support = 'prompt';
    promptInstall.mockResolvedValue('accepted');
    render(<InstallAppRow />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Home Screen' }));
    expect(promptInstall).toHaveBeenCalledTimes(1);
  });

  it('shows the browser-menu route once the prompt is spent', () => {
    support = 'manual';
    render(<InstallAppRow />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Home Screen' }));
    expect(promptInstall).not.toHaveBeenCalled();
    expect(screen.getByText(/browser’s menu/)).toBeInTheDocument();
  });
});
