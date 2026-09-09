import { describe, it, expect, vi } from 'vitest';
import { isPidAlive, killPidReal } from './side-effects';

describe('isPidAlive', () => {
  it('returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for a pid that does not exist', () => {
    // A pid astronomically unlikely to exist on any real system.
    expect(isPidAlive(999999)).toBe(false);
  });
});

describe('killPidReal', () => {
  it('returns false without checking the port or signaling when the pid is already gone', () => {
    const getPortOwnerPid = vi.fn().mockReturnValue(4242);
    const sendSignal = vi.fn();

    const result = killPidReal(999999, 3100, getPortOwnerPid, sendSignal);

    expect(result).toBe(false);
    expect(getPortOwnerPid).not.toHaveBeenCalled();
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it('refuses to signal a live pid that no longer owns the registered port', () => {
    const getPortOwnerPid = vi.fn().mockReturnValue(9999); // a different pid holds the port
    const sendSignal = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = killPidReal(process.pid, 3100, getPortOwnerPid, sendSignal);

    expect(result).toBe(false);
    expect(getPortOwnerPid).toHaveBeenCalledWith(3100);
    expect(sendSignal).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses to signal a live pid when nothing currently owns the port', () => {
    const getPortOwnerPid = vi.fn().mockReturnValue(null);
    const sendSignal = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = killPidReal(process.pid, 3100, getPortOwnerPid, sendSignal);

    expect(result).toBe(false);
    expect(sendSignal).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('signals a live pid that owns the registered port', () => {
    const getPortOwnerPid = vi.fn().mockReturnValue(process.pid);
    const sendSignal = vi.fn();

    const result = killPidReal(process.pid, 3100, getPortOwnerPid, sendSignal);

    expect(result).toBe(true);
    expect(sendSignal).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  it('warns and returns false when the identity-confirmed pid fails to receive the signal', () => {
    const getPortOwnerPid = vi.fn().mockReturnValue(process.pid);
    const sendSignal = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = killPidReal(process.pid, 3100, getPortOwnerPid, sendSignal);

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
