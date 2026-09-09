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

/**
 * Warns when a shell-out's failure is itself diagnosable (missing binary,
 * timed out) rather than the routine "no match" case (a non-zero exit with
 * no special error code), which every caller already treats as "no owner".
 */
function warnOnDiagnosableShellOutFailure(command: string, err: unknown): void {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    console.warn(`[worktree] ${command} is not installed — cannot confirm process identity before signaling`);
  } else if (code === 'ETIMEDOUT') {
    console.warn(`[worktree] ${command} timed out after ${SHELL_OUT_TIMEOUT_MS}ms — cannot confirm process identity before signaling`);
  }
}

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
    warnOnDiagnosableShellOutFailure('lsof', err);
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
  } catch (err) {
    warnOnDiagnosableShellOutFailure('ps', err);
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
 * Signals `pid`'s process group as soon as a member of that group is
 * confirmed to hold `port` — checked ahead of, and independently of,
 * whether `pid` itself is still alive. A process group outlives its
 * original leader as long as any member remains, so a registry pid whose
 * own process already exited can still correctly identify a live
 * descendant still holding the port; checking `pid`'s own liveness first
 * would misreport that case as "already gone" while the descendant keeps
 * running. Only once no group member is confirmed to hold the port does
 * `pid`'s own liveness decide between "already gone" and "refused" (alive,
 * but its group doesn't hold the port — possibly a stale or reused pid).
 */
export function killPidReal(
  pid: number,
  port: number,
  getPortOwnerPid: (port: number) => number | null = getPortOwnerPidReal,
  getProcessGroupId: (pid: number) => number | null = getProcessGroupIdReal,
  sendSignal: (pid: number, signal: NodeJS.Signals) => void = process.kill.bind(process),
): KillPidResult {
  const owner = getPortOwnerPid(port);
  const ownerGroup = owner === null ? null : getProcessGroupId(owner);
  if (ownerGroup === pid) {
    try {
      // Signal the whole group (negative pid): the confirmed listener may
      // be a descendant of `pid` rather than `pid` itself — signaling only
      // `pid` would leave that descendant running as an orphan.
      sendSignal(-pid, 'SIGTERM');
      return 'signaled';
    } catch (err) {
      console.warn(`[worktree] failed to signal process group ${pid} on port ${port}:`, err);
      return 'signal-failed';
    }
  }
  if (!isPidAlive(pid)) {
    return 'already-gone';
  }
  console.warn(
    `[worktree] pid ${pid} no longer owns port ${port} (listener: ${owner ?? 'none'}, its group: ${ownerGroup ?? 'unknown'}) — refusing to signal a process that may not be the one we started`,
  );
  return 'refused';
}

/**
 * Best-effort stop of a dev server this same process just spawned via
 * `spawnDevServer` — no port/identity check, because there's no persistence
 * gap for a pid reuse to hide in: this is the pid `spawnDevServer` handed
 * back moments ago, in this same run. Returns whether `pid` is confirmed
 * gone afterward, so a caller knows whether it's safe to stop tracking it.
 */
export function killJustSpawnedPidReal(
  pid: number,
  sendSignal: (pid: number, signal: NodeJS.Signals) => void = process.kill.bind(process),
): boolean {
  try {
    sendSignal(-pid, 'SIGTERM');
  } catch (err) {
    // ESRCH means the group is already gone — the routine case for a
    // process that crashed or exited before this cleanup ran, not a
    // failure worth warning about.
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      console.warn(`[worktree] failed to signal just-spawned pid ${pid}:`, err);
    }
  }
  if (isPidAlive(pid)) {
    console.warn(`[worktree] pid ${pid} may still be running after cleanup — leaving it recorded for the next sweep to retry`);
    return false;
  }
  return true;
}

/**
 * Whether a `KillPidResult` means "confirmed nothing is left running" (safe
 * to stop tracking `pid`) or "unconfirmed" (a live process may still be
 * running under it, so it must stay tracked). Exhaustive by construction —
 * a `KillPidResult` variant this doesn't name fails to compile rather than
 * silently falling into either bucket.
 */
export function describeKillOutcome(
  result: KillPidResult,
  pid: number,
): { confirmedStopped: boolean; level: 'log' | 'warn'; message: string } {
  switch (result) {
    case 'signaled':
      return { confirmedStopped: true, level: 'log', message: `signal sent to pid ${pid}` };
    case 'already-gone':
      return { confirmedStopped: true, level: 'log', message: `pid ${pid} was already gone` };
    case 'refused':
    case 'signal-failed':
      return {
        confirmedStopped: false,
        level: 'warn',
        message: `could not confirm pid ${pid} was stopped (${result}) — leaving it recorded`,
      };
    default: {
      const unhandled: never = result;
      return {
        confirmedStopped: false,
        level: 'warn',
        message: `unrecognized kill result "${String(unhandled)}" for pid ${pid} — treating as unconfirmed`,
      };
    }
  }
}

export { isPidAlive } from './registry';
