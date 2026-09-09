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

/** Shells out to lsof. Not unit tested directly — killPidReal's decision logic is, via an injected fake. */
function getPortOwnerPidReal(port: number): number | null {
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }
  try {
    const out = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' }).trim();
    if (!out) {
      return null;
    }
    const firstPid = parseInt(out.split('\n')[0] ?? '', 10);
    return Number.isNaN(firstPid) ? null : firstPid;
  } catch {
    // No process holds the port, or lsof itself is unavailable — either way
    // there's no confirmed owner, so the caller must not signal anything.
    return null;
  }
}

/**
 * Signals `pid` only after confirming it's both alive and still the process
 * holding `port` — a registry pid persists across reboots and OS pid reuse
 * can hand it to an unrelated process, so a bare `process.kill` would risk
 * signaling the wrong target. Any pid that is alive but fails either check
 * is left alone and logged, never silently treated the same as "already gone".
 */
export function killPidReal(
  pid: number,
  port: number,
  getPortOwnerPid: (port: number) => number | null = getPortOwnerPidReal,
  sendSignal: (pid: number, signal: NodeJS.Signals) => void = process.kill.bind(process),
): boolean {
  if (!isPidAlive(pid)) {
    return false;
  }
  const owner = getPortOwnerPid(port);
  if (owner !== pid) {
    console.warn(
      `[worktree] pid ${pid} no longer owns port ${port} (current owner: ${owner ?? 'none'}) — refusing to signal a process that may not be the one we started`,
    );
    return false;
  }
  try {
    sendSignal(pid, 'SIGTERM');
    return true;
  } catch (err) {
    console.warn(`[worktree] failed to signal pid ${pid} on port ${port}:`, err);
    return false;
  }
}

export { isPidAlive } from './registry';
