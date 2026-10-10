import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/shutdown', () => ({ installShutdownSignal: vi.fn() }));
vi.mock('@/lib/scheduler', () => ({ startScheduler: vi.fn() }));

import { installShutdownSignal } from '@/lib/shutdown';
import { startScheduler } from '@/lib/scheduler';
import { register } from './instrumentation';

const originalRuntime = process.env.NEXT_RUNTIME;

beforeEach(() => {
  vi.mocked(installShutdownSignal).mockClear();
  vi.mocked(startScheduler).mockClear();
});

afterEach(() => {
  if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = originalRuntime;
});

describe('register', () => {
  it('installs the shutdown signal before the scheduler starts on the node runtime', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    await register();
    expect(installShutdownSignal).toHaveBeenCalledTimes(1);
    expect(startScheduler).toHaveBeenCalledTimes(1);
    const [installOrder = Infinity] = vi.mocked(installShutdownSignal).mock.invocationCallOrder;
    const [startOrder = -Infinity] = vi.mocked(startScheduler).mock.invocationCallOrder;
    expect(installOrder).toBeLessThan(startOrder);
  });

  it('does neither on the edge runtime', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    await register();
    expect(installShutdownSignal).not.toHaveBeenCalled();
    expect(startScheduler).not.toHaveBeenCalled();
  });
});
