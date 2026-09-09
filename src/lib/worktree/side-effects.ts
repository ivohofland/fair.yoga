import { execFileSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { assertSafeDatabaseName, withDatabaseName } from '../db-provision';
import { isPidAlive } from './registry';

export async function dropDatabaseReal(dbName: string, anyDatabaseUrl: string): Promise<void> {
  assertSafeDatabaseName(dbName);
  const admin = new PrismaClient({ datasources: { db: { url: withDatabaseName(anyDatabaseUrl, 'postgres') } } });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await admin.$disconnect();
  }
}

const SHELL_OUT_TIMEOUT_MS = 5000;

/** Returns the pid of the process listening on `port`, or null when there is no confirmed listener. */
function getPortOwnerPidReal(port: number): number | null {
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }
  try {
    const out = execFileSync('lsof', ['-n', '-P', '-sTCP:LISTEN', '-ti', `:${port}`], {
      encoding: 'utf8',
      timeout: SHELL_OUT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) {
      return null;
    }
    // -sTCP:LISTEN excludes client sockets, so any line here is a listener;
    // take the first if more than one process is bound (e.g. SO_REUSEPORT).
    const firstPid = parseInt(out.split('\n')[0] ?? '', 10);
    return Number.isNaN(firstPid) ? null : firstPid;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn('[worktree] lsof is not installed — cannot confirm port ownership before signaling');
    }
    // No listener, lsof missing, or the call timed out — none of these
    // confirm an owner, so the caller must not signal anything.
    return null;
  }
}

/** Returns the process group id of `pid`, or null when it can't be read (the pid is gone, or the call failed). */
function getProcessGroupIdReal(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: SHELL_OUT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const pgid = parseInt(out, 10);
    return Number.isNaN(pgid) ? null : pgid;
  } catch {
    return null;
  }
}

/**
 * `signaled`/`already-gone` both mean nothing is left to do; `refused` and
 * `signal-failed` both mean a live process may still be running under `pid`
 * — kept apart from the first two so a caller never mistakes "couldn't
 * confirm" for "confirmed gone".
 */
export type KillPidResult = 'signaled' | 'already-gone' | 'refused' | 'signal-failed';

/**
 * Signals `pid`'s process group only after confirming `pid` is alive and is
 * still the group leader of whatever is currently listening on `port`.
 * `pid` alone isn't enough to identify the target: a registry pid can
 * outlive a reboot, and the OS may since have handed that number to an
 * unrelated process. Any alive pid that fails the port/group check, or that
 * throws while being signaled, is left alone and logged — never silently
 * folded into the same result as "already gone".
 */
export function killPidReal(
  pid: number,
  port: number,
  getPortOwnerPid: (port: number) => number | null = getPortOwnerPidReal,
  getProcessGroupId: (pid: number) => number | null = getProcessGroupIdReal,
  sendSignal: (pid: number, signal: NodeJS.Signals) => void = process.kill.bind(process),
): KillPidResult {
  if (!isPidAlive(pid)) {
    return 'already-gone';
  }
  const owner = getPortOwnerPid(port);
  const ownerGroup = owner === null ? null : getProcessGroupId(owner);
  if (ownerGroup !== pid) {
    console.warn(
      `[worktree] pid ${pid} no longer owns port ${port} (listener: ${owner ?? 'none'}, its group: ${ownerGroup ?? 'unknown'}) — refusing to signal a process that may not be the one we started`,
    );
    return 'refused';
  }
  try {
    // Signal the whole process group (negative pid): `pid` is expected to be
    // a process-group leader, and the confirmed listener above may be one of
    // its descendants rather than `pid` itself — signaling only `pid` would
    // leave that descendant running as an orphan.
    sendSignal(-pid, 'SIGTERM');
    return 'signaled';
  } catch (err) {
    console.warn(`[worktree] failed to signal process group ${pid} on port ${port}:`, err);
    return 'signal-failed';
  }
}

/**
 * Best-effort stop of a dev server this same process just spawned via
 * `spawnDevServer` — no port/identity check, because there's no persistence
 * gap for a pid reuse to hide in: this is the pid `spawnDevServer` handed
 * back moments ago, in this same run.
 */
export function killJustSpawnedPidReal(
  pid: number,
  sendSignal: (pid: number, signal: NodeJS.Signals) => void = process.kill.bind(process),
): void {
  try {
    sendSignal(-pid, 'SIGTERM');
  } catch (err) {
    console.warn(`[worktree] failed to signal just-spawned pid ${pid}:`, err);
  }
}

export { isPidAlive } from './registry';
