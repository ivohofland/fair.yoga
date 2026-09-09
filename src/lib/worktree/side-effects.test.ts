import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { isPidAlive, killPidReal, killJustSpawnedPidReal } from './side-effects';

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
  it('returns "already-gone" without checking the port, group, or signaling when the pid is already gone', () => {
    const getPortOwnerPid = vi.fn().mockReturnValue(4242);
    const getProcessGroupId = vi.fn().mockReturnValue(4242);
    const sendSignal = vi.fn();

    const result = killPidReal(999999, 3100, getPortOwnerPid, getProcessGroupId, sendSignal);

    expect(result).toBe('already-gone');
    expect(getPortOwnerPid).not.toHaveBeenCalled();
    expect(getProcessGroupId).not.toHaveBeenCalled();
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it('refuses ("refused") without checking the group when nothing currently owns the port', () => {
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

  it('refuses ("refused") when the port\'s listener belongs to a different process group than the recorded pid', () => {
    const getPortOwnerPid = vi.fn().mockReturnValue(9999); // some listener pid
    const getProcessGroupId = vi.fn().mockReturnValue(5555); // its group — not process.pid
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

  it('signals ("signaled") the process group when the port\'s listener belongs to the recorded pid\'s group — pid itself need not be the listener', () => {
    const getPortOwnerPid = vi.fn().mockReturnValue(9999); // a descendant pid holds the port
    const getProcessGroupId = vi.fn().mockReturnValue(process.pid); // but it's in our recorded pid's group
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

describe('killJustSpawnedPidReal', () => {
  it('signals the process group of the given pid, not just the pid itself', () => {
    const sendSignal = vi.fn();

    killJustSpawnedPidReal(4242, sendSignal);

    expect(sendSignal).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });

  it('warns instead of throwing when the signal fails', () => {
    const sendSignal = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() => killJustSpawnedPidReal(4242, sendSignal)).not.toThrow();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// A script that reproduces the one property killPidReal's identity check
// depends on: `spawnDevServer` starts its child detached, so the recorded
// pid becomes that subtree's process-group leader, while the port is
// actually bound by a *descendant* with its own, different pid. "outer"
// spawns "inner" as a plain (non-detached) child, so inner inherits outer's
// process group; inner binds an OS-assigned port and writes it to a file.
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
    10000,
  );
});
