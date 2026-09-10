// scripts/worktree-setup.ts
import { execSync } from 'child_process';
import path from 'path';
import { getWorktreeIdentity, dbNamesForSlug } from '../src/lib/worktree/identity';
import { getRegistryPath, allocatePort, writeRegistryLockedOrExplain } from '../src/lib/worktree/registry';
import { runReap } from '../src/lib/worktree/reap';
import { writeEnvIfMissing, generateCronSecret, findStaleEnvKeys } from '../src/lib/worktree/env-file';
import { buildEnvOverrides } from '../src/lib/worktree/env-overrides';

const DB_HOST = 'postgresql://yoga:yoga_dev_password@localhost:5432';

async function main(): Promise<void> {
  const identity = getWorktreeIdentity();
  if (identity.isMainCheckout || !identity.rawName || !identity.dbSlug) {
    console.log('[worktree:setup] main checkout — nothing to do');
    return;
  }
  const rawName = identity.rawName;
  const dbSlug = identity.dbSlug;

  const registryPath = getRegistryPath(identity.gitCommonDir);

  // reapFailed means the whole runReap sweep threw; reapResult.failed names
  // individual rows the sweep tried and failed to reap. Different failure
  // modes — only reapFailed is threaded into the collision-explaining path below.
  let reapFailed = false;
  try {
    const reapResult = await runReap(identity.gitCommonDir, registryPath, `${DB_HOST}/postgres`);
    if (reapResult.reaped.length > 0) {
      console.log(`[worktree:setup] reaped orphaned worktree resources: ${reapResult.reaped.join(', ')}`);
    }
    if (reapResult.failed.length > 0) {
      console.error(
        `[worktree:setup] FAILED to reap ${reapResult.failed.length} orphaned worktree resource(s) — will retry on next sweep: ${reapResult.failed.map((f) => f.key).join(', ')}`,
      );
    }
  } catch (err) {
    reapFailed = true;
    console.warn('[worktree:setup] reap sweep failed — continuing without it, this worktree is unaffected:', err);
  }

  const port = await writeRegistryLockedOrExplain(registryPath, reapFailed, (registry) => {
    const result = allocatePort(registry, rawName, dbSlug);
    return { registry: result.registry, result: result.port };
  });

  // A worktree is a checkout of committed versions, so the frozen install:
  // it installs the lockfile exactly and fails when `package.json` disagrees
  // with it. Why that matters over a bare `pnpm install` — which resolves,
  // and which pnpm freezes only when `CI` is set — is in
  // `docs/supply-chain.md`. Pinned by `src/lib/script-install-census.test.ts`.
  console.log('[worktree:setup] running pnpm install --frozen-lockfile...');
  execSync('pnpm install --frozen-lockfile', { stdio: 'inherit' });

  const { test, dev } = dbNamesForSlug(dbSlug);
  const envPath = path.resolve(process.cwd(), '.env');
  const examplePath = path.resolve(process.cwd(), '.env.example');
  const overrides = buildEnvOverrides(DB_HOST, dev, test, port);
  const wrote = writeEnvIfMissing(envPath, examplePath, { ...overrides, CRON_SECRET: generateCronSecret() });

  console.log(`[worktree:setup] rawName: ${rawName}`);
  console.log(`[worktree:setup] dbSlug: ${dbSlug}`);
  console.log(`[worktree:setup] port: ${port}`);
  console.log(`[worktree:setup] databases: ${dev}, ${test}`);
  console.log(wrote ? '[worktree:setup] wrote .env' : '[worktree:setup] .env already exists — left untouched');

  if (!wrote) {
    const mismatched = findStaleEnvKeys(envPath, overrides);
    if (mismatched.length > 0) {
      console.warn(`[worktree:setup] .env already exists and does not match this worktree's isolation settings for: ${mismatched.join(', ')}`);
      console.warn('[worktree:setup] if this .env was copied from elsewhere, delete it and re-run this command to regenerate it correctly');
    }
    if (mismatched.includes('CRON_SECRET')) {
      console.warn('[worktree:setup] CRON_SECRET is blank — add a value yourself (e.g. `openssl rand -hex 24`) rather than deleting .env for it; /api/cron/* will 500 until it has one');
    }
  }

  console.log('[worktree:setup] next: pnpm run worktree:up');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
