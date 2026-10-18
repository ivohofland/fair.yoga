import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const m = vi.hoisted(() => ({
  readConnectionView: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: { marker: 'db' } }));
vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: m.logError, debug: vi.fn() } }));
vi.mock('@/services/processor-connection', () => ({ readConnectionView: m.readConnectionView }));
vi.mock('./mollie-connection-section', () => ({
  MollieConnectionSection: (props: Record<string, unknown>) => <span data-testid="mollie-section" data-props={JSON.stringify(props)} />,
}));

import { MollieConnectionPanel, MollieConnectionFallback } from './mollie-connection-panel';
import type { MollieDeps } from '@/services/mollie-deps';

const DEPS = { marker: 'deps' } as unknown as MollieDeps;

function props(): Record<string, unknown> {
  return JSON.parse(screen.getByTestId('mollie-section').getAttribute('data-props') ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  m.readConnectionView.mockReset();
  m.logError.mockReset();
});

describe('MollieConnectionPanel', () => {
  it('hands the section the connection as Mollie describes it', async () => {
    m.readConnectionView.mockResolvedValue({ kind: 'none' });
    render(await MollieConnectionPanel({ teacherId: 't1', deps: DEPS, status: 'connected' }));
    expect(props()).toEqual({ teacherId: 't1', view: { kind: 'none' }, status: 'connected' });
    expect(m.readConnectionView).toHaveBeenCalledWith({ marker: 'db' }, DEPS, 't1');
  });

  it('shows the unavailable view, and logs, when reading the connection throws', async () => {
    const boom = new Error('db down');
    m.readConnectionView.mockRejectedValue(boom);
    render(await MollieConnectionPanel({ teacherId: 't1', deps: DEPS, status: null }));
    expect(props()).toEqual({ teacherId: 't1', view: { kind: 'unavailable' }, status: null });
    expect(m.logError).toHaveBeenCalledWith({ err: boom, teacherId: 't1' }, expect.any(String));
  });
});

describe('MollieConnectionFallback', () => {
  it('holds the section’s place under its heading', () => {
    render(<MollieConnectionFallback />);
    expect(screen.getByRole('heading', { name: 'Mollie' })).toBeInTheDocument();
  });
});
