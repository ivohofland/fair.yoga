import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { isPidAlive, killPidReal, killJustSpawnedPidReal, describeKillOutcome } from './side-effects';

// Only execFileSync is mocked (its default falls through to the real
// implementation) — spawn stays real, since the "real detached subtree"
// test below needs to spawn an actual OS process.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

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
  it(
    "signals the process group even when the recorded pid itself is no longer alive " +
      '(a process group survives its leader, so identity must not depend on the leader still being alive)',
    () => {
      const deadPid = 999999; // isPidAlive(deadPid) === false
      const getPortOwnerPid = vi.fn().mockReturnValue(8888); // a surviving descendant
      const getProcessGroupId = vi.fn().mockReturnValue(deadPid); // still in the dead leader's group
      const sendSignal = vi.fn();

      const result = killPidReal(deadPid, 3100, getPortOwnerPid, getProcessGroupId, sendSignal);

      expect(result).toBe('signaled');
      expect(sendSignal).toHaveBeenCalledWith(-deadPid, 'SIGTERM');
    },
  );

  it('returns "already-gone" when nothing owns the port and the pid is not alive', () => {
    const getPortOwnerPid = vi.fn().mockReturnValue(null);
    const getProcessGroupId = vi.fn();
    const sendSignal = vi.fn();

    const result = killPidReal(999999, 3100, getPortOwnerPid, getProcessGroupId, sendSignal);

    expect(result).toBe('already-gone');
    expect(getProcessGroupId).not.toHaveBeenCalled();
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it('refuses ("refused") when nothing owns the port but the pid is alive', () => {
    const getPortOwnerPid = vi.fn().mockReturnValue(null);
    const getProcessGroupId = vi.fn();
    const sendSignal = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = killPidReal(process.pid, 3100, getPortOwnerPid, getProcessGroupId, sendSignal);

    expect(result).toBe('refused');
    expect(getProcessGroupId).not.toHaveBeenCalled();
    expect(sendSignal).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses ("refused") when the listener\'s group differs from the recorded pid and the pid is alive', () => {
    const getPortOwnerPid = vi.fn().mockReturnValue(9999);
    const getProcessGroupId = vi.fn().mockReturnValue(5555);
    const sendSignal = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = killPidReal(process.pid, 3100, getPortOwnerPid, getProcessGroupId, sendSignal);

    expect(result).toBe('refused');
    expect(getPortOwnerPid).toHaveBeenCalledWith(3100);
    expect(getProcessGroupId).toHaveBeenCalledWith(9999);
    expect(sendSignal).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns "already-gone" when the listener\'s group differs from the recorded pid and the pid is not alive', () => {
    const getPortOwnerPid = vi.fn().mockReturnValue(9999); // unrelated process holds the port
    const getProcessGroupId = vi.fn().mockReturnValue(5555); // its own, unrelated group
    const sendSignal = vi.fn();

    const result = killPidReal(999999, 3100, getPortOwnerPid, getProcessGroupId, sendSignal);

    expect(result).toBe('already-gone');
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it('signals ("signaled") when the listener\'s group matches the recorded pid', () => {
    const getPortOwnerPid = vi.fn().mockReturnValue(9999); // a descendant pid holds the port
    const getProcessGroupId = vi.fn().mockReturnValue(process.pid); // in our recorded pid's group
    const sendSignal = vi.fn();

    const result = killPidReal(process.pid, 3100, getPortOwnerPid, getProcessGroupId, sendSignal);

    expect(result).toBe('signaled');
    expect(sendSignal).toHaveBeenCalledWith(-process.pid, 'SIGTERM');
  });

  it('returns "signal-failed" and warns when a group-confirmed pid fails to receive the signal', () => {
    const getPortOwnerPid = vi.fn().mockReturnValue(process.pid);
    const getProcessGroupId = vi.fn().mockReturnValue(process.pid);
    const sendSignal = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = killPidReal(process.pid, 3100, getPortOwnerPid, getProcessGroupId, sendSignal);

    expect(result).toBe('signal-failed');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('killPidReal with the real getPortOwnerPid/getProcessGroupId defaults (execFileSync mocked)', () => {
  it('takes the first pid when lsof reports more than one listener, and resolves identity through it', () => {
    const mocked = vi.mocked(execFileSync);
    mocked.mockReturnValueOnce('111\n222\n'); // lsof: two listeners, take the first
    mocked.mockReturnValueOnce('4242\n'); // ps -o pgid= for pid 111 -> group 4242
    const sendSignal = vi.fn();

    const result = killPidReal(4242, 3100, undefined, undefined, sendSignal);

    expect(result).toBe('signaled');
    expect(mocked).toHaveBeenNthCalledWith(1, 'lsof', expect.arrayContaining(['-ti', ':3100']), expect.anything());
    expect(mocked).toHaveBeenNthCalledWith(2, 'ps', expect.arrayContaining(['-p', '111']), expect.anything());
    expect(sendSignal).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });

  it('warns distinctly and refuses when lsof is not installed (ENOENT)', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = killPidReal(process.pid, 3100, undefined, undefined, vi.fn());

    expect(result).toBe('refused');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lsof is not installed'));
    warn.mockRestore();
  });

  it('warns distinctly when lsof times out', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = killPidReal(process.pid, 3100, undefined, undefined, vi.fn());

    expect(result).toBe('refused');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
    warn.mockRestore();
  });

  it('treats unparseable lsof output as no confirmed owner, without warning', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('not-a-pid\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = killPidReal(999999, 3100, undefined, undefined, vi.fn());

    expect(result).toBe('already-gone');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('killJustSpawnedPidReal', () => {
  it('signals the process group of the given pid, not just the pid itself', () => {
    const sendSignal = vi.fn();

    killJustSpawnedPidReal(4242, sendSignal);

    expect(sendSignal).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });

  it('returns true when the pid is confirmed gone after signaling', () => {
    const sendSignal = vi.fn();

    const result = killJustSpawnedPidReal(999999, sendSignal); // isPidAlive(999999) === false

    expect(result).toBe(true);
  });

  it('returns false and warns when the pid is still alive after signaling', () => {
    const sendSignal = vi.fn(); // the mock "succeeds" but does nothing
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = killJustSpawnedPidReal(process.pid, sendSignal); // process.pid stays alive

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('swallows ESRCH from the signal call without warning (the routine "already gone" case)', () => {
    const sendSignal = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = killJustSpawnedPidReal(999999, sendSignal);

    expect(result).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns (does not swallow) a non-ESRCH signal failure', () => {
    const sendSignal = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    killJustSpawnedPidReal(process.pid, sendSignal);

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('describeKillOutcome', () => {
  it.each([
    ['signaled', true, 'log'],
    ['already-gone', true, 'log'],
    ['refused', false, 'warn'],
    ['signal-failed', false, 'warn'],
  ] as const)('classifies "%s" as confirmedStopped=%s, level=%s', (result, confirmedStopped, level) => {
    const outcome = describeKillOutcome(result, 4242);
    expect(outcome.confirmedStopped).toBe(confirmedStopped);
    expect(outcome.level).toBe(level);
    expect(outcome.message).toContain('4242');
  });
});

// A script that reproduces the two-level process shape killPidReal's
// identity check must resolve: "outer" is spawned detached below, so it
// becomes a process-group leader, and "inner" — a plain, non-detached child
// of "outer" — inherits that group and is the one that actually binds the
// port. The listener's pid therefore differs from the recorded ("outer")
// pid even though both share a process group.
const TREE_SCRIPT = `
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const role = process.argv[2];
const portFile = process.argv[3];
if (role === 'outer') {
  spawn(process.execPath, [__filename, 'inner', portFile], { stdio: 'ignore' });
} else {
  const server = http.createServer();
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(portFile, String(server.address().port));
  });
}
`;

async function waitForPortFile(portFile: string, timeoutMs = 4000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
      if (!Number.isNaN(port)) {
        return port;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`port file ${portFile} did not appear within ${timeoutMs}ms`);
}

describe('killPidReal against a real detached subtree', () => {
  it(
    'confirms identity via process group (real lsof + real ps), not via the listener pid equaling the recorded pid',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-killpid-tree-'));
      const scriptPath = path.join(dir, 'tree.js');
      const portFile = path.join(dir, 'port');
      fs.writeFileSync(scriptPath, TREE_SCRIPT);

      const child = spawn(process.execPath, [scriptPath, 'outer', portFile], { detached: true, stdio: 'ignore' });
      child.unref();
      const outerPid = child.pid;
      expect(outerPid).toBeDefined();
      if (outerPid === undefined) {
        throw new Error('unreachable — asserted above');
      }

      try {
        const port = await waitForPortFile(portFile);
        // Real getPortOwnerPid/getProcessGroupId defaults (omit params 3-4);
        // only the actual signal is faked, so nothing real gets killed here.
        const sendSignal = vi.fn();

        const result = killPidReal(outerPid, port, undefined, undefined, sendSignal);

        expect(result).toBe('signaled');
        expect(sendSignal).toHaveBeenCalledWith(-outerPid, 'SIGTERM');
      } finally {
        try {
          process.kill(-outerPid, 'SIGKILL');
        } catch {
          // already gone
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    20000,
  );
});
