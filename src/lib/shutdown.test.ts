import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('@/lib/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { log } from '@/lib/log';
import { beginShutdown, installShutdownSignal, isShuttingDown, onShutdown } from './shutdown';

afterEach(() => {
  delete globalThis.__fairYogaShutdown;
  vi.mocked(log.error).mockClear();
  vi.mocked(log.info).mockClear();
});

describe('shutdown', () => {
  it('is not shutting down by default, and beginShutdown flips it', () => {
    expect(isShuttingDown()).toBe(false);
    beginShutdown();
    expect(isShuttingDown()).toBe(true);
  });

  it('runs each subscriber once, even when beginShutdown is called twice', () => {
    const a = vi.fn();
    const b = vi.fn();
    onShutdown(a);
    onShutdown(b);
    beginShutdown();
    beginShutdown();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does not run an unsubscribed handler', () => {
    const fn = vi.fn();
    const unsubscribe = onShutdown(fn);
    unsubscribe();
    beginShutdown();
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs a subscription made after shutdown immediately', () => {
    beginShutdown();
    const fn = vi.fn();
    onShutdown(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('logs that shutdown began, with the signal and subscriber count, on the first call only', () => {
    onShutdown(() => {});
    onShutdown(() => {});

    beginShutdown('SIGTERM');
    beginShutdown('SIGINT');

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      { signal: 'SIGTERM', subscribers: 2 },
      expect.stringContaining('shutdown'),
    );
  });

  it('logs a throwing subscriber and still runs the others', () => {
    const boom = new Error('boom');
    const before = vi.fn();
    const after = vi.fn();
    onShutdown(before);
    onShutdown(() => {
      throw boom;
    });
    onShutdown(after);
    beginShutdown();
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.error).mock.calls[0]?.[0]).toMatchObject({ err: boom });
    expect(vi.mocked(log.error).mock.calls[0]?.[1]).toContain('kills');
  });

  it('shares its state across module instances', async () => {
    vi.resetModules();
    const a = await import('./shutdown');
    vi.resetModules();
    const b = await import('./shutdown');
    expect(a).not.toBe(b);
    const fn = vi.fn();
    b.onShutdown(fn);

    a.beginShutdown();

    expect(b.isShuttingDown()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  describe('installShutdownSignal', () => {
    it('begins shutdown on SIGTERM', () => {
      const target = new EventEmitter();
      installShutdownSignal(target);
      target.emit('SIGTERM', 'SIGTERM');
      expect(isShuttingDown()).toBe(true);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ signal: 'SIGTERM' }),
        expect.any(String),
      );
    });

    it('begins shutdown on SIGINT', () => {
      const target = new EventEmitter();
      installShutdownSignal(target);
      target.emit('SIGINT');
      expect(isShuttingDown()).toBe(true);
    });

    it('installs one listener per signal however often it is called', () => {
      const target = new EventEmitter();
      installShutdownSignal(target);
      installShutdownSignal(target);
      expect(target.listenerCount('SIGTERM')).toBe(1);
      expect(target.listenerCount('SIGINT')).toBe(1);
    });
  });
});
