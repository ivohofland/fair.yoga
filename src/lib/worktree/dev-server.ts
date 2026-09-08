import { spawn as spawnReal } from 'child_process';
import fs from 'fs';
import path from 'path';

export function buildDevServerLogPath(cwd: string): string {
  return path.join(cwd, 'worktree-dev.log');
}

export function spawnDevServer(
  cwd: string,
  port: number,
  spawnFn: typeof spawnReal = spawnReal,
): number {
  const logPath = buildDevServerLogPath(cwd);
  const logFd = fs.openSync(logPath, 'a');
  try {
    const child = spawnFn('npx', ['next', 'dev', '-p', String(port)], {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    if (child.pid === undefined) {
      throw new Error('failed to spawn next dev — no pid assigned');
    }
    return child.pid;
  } finally {
    fs.closeSync(logFd);
  }
}
