// scripts/worktree-up.ts
import fs from 'fs';
import { loadEnv } from 'vite';
import { getWorktreeIdentity } from '../src/lib/worktree/identity';
import { getRegistryPath, writeRegistryLocked, allocatePort, setPid, writeRegistryLockedOrExplain } from '../src/lib/worktree/registry';
import { runReap } from '../src/lib/worktree/reap';
import { provisionDatabase } from '../src/lib/db-provision';
import { spawnDevServer, buildDevServerLogPath } from '../src/lib/worktree/dev-server';
import { killJustSpawnedPidReal, isPidAlive } from '../src/lib/worktree/side-effects';

async function waitForServer(port: number, timeoutMs = 15000, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}`);
      if (res.status < 500) return true;
    } catch {
      // not accepting connections yet
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function main(): Promise<void> {
  const identity = getWorktreeIdentity();
  if (identity.isMainCheckout || !identity.rawName || !identity.dbSlug) {
    console.log('[worktree:up] main checkout — run `npm run dev` directly instead');
    return;
  }
  const rawName = identity.rawName;
  const dbSlug = identity.dbSlug;

  const registryPath = getRegistryPath(identity.gitCommonDir);

  const fileEnv = loadEnv('', process.cwd(), '');
  const devUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL;
  if (!devUrl) {
    throw new Error('[worktree:up] DATABASE_URL not set — run `npm run worktree:setup` first');
  }

  // reapFailed means the whole runReap sweep threw; reapResult.failed names
  // individual rows the sweep tried and failed to reap. Different failure
  // modes — only reapFailed is threaded into the collision-explaining path below.
  let reapFailed = false;
  try {
    const reapResult = await runReap(identity.gitCommonDir, registryPath, devUrl);
    if (reapResult.reaped.length > 0) {
      console.log(`[worktree:up] reaped orphaned worktree resources: ${reapResult.reaped.join(', ')}`);
    }
    if (reapResult.failed.length > 0) {
      console.error(
        `[worktree:up] FAILED to reap ${reapResult.failed.length} orphaned worktree resource(s) — will retry on next sweep: ${reapResult.failed.map((f) => f.key).join(', ')}`,
      );
    }
  } catch (err) {
    reapFailed = true;
    console.warn('[worktree:up] reap sweep failed — continuing without it, this worktree is unaffected:', err);
  }

  const slot = await writeRegistryLockedOrExplain<
    { kind: 'already-running'; port: number; pid: number } | { kind: 'allocated'; port: number }
  >(registryPath, reapFailed, (registry) => {
    const existing = registry[rawName];
    if (existing?.pid != null && isPidAlive(existing.pid)) {
      return { registry, result: { kind: 'already-running' as const, port: existing.port, pid: existing.pid } };
    }
    const result = allocatePort(registry, rawName, dbSlug);
    return { registry: result.registry, result: { kind: 'allocated' as const, port: result.port } };
  });

  if (slot.kind === 'already-running') {
    console.log(`[worktree:up] already running at http://localhost:${slot.port} (pid ${slot.pid})`);
    return;
  }
  const port = slot.port;

  await provisionDatabase(devUrl, { seed: true });

  const pid = spawnDevServer(process.cwd(), port);
  try {
    await writeRegistryLocked(registryPath, (registry) => setPid(registry, rawName, pid));
  } catch (err) {
    killJustSpawnedPidReal(pid);
    throw err;
  }

  const up = await waitForServer(port);
  if (!up) {
    const confirmedStopped = killJustSpawnedPidReal(pid);
    await writeRegistryLocked(registryPath, (registry) => setPid(registry, rawName, confirmedStopped ? null : pid));
    let logTail = '(log unavailable)';
    try {
      logTail = fs.readFileSync(buildDevServerLogPath(process.cwd()), 'utf8').split('\n').slice(-20).join('\n');
    } catch {
      // log genuinely unreadable — report without it rather than masking the real failure
    }
    throw new Error(`[worktree:up] dev server did not come up on port ${port} within 15s:\n${logTail}`);
  }

  console.log(`[worktree:up] dev server running at http://localhost:${port} (pid ${pid})`);
  console.log(`[worktree:up] INTEGRATION_BASE_URL=http://localhost:${port}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
