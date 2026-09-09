// scripts/worktree-setup.ts
import { execSync } from 'child_process';
import path from 'path';
import { getWorktreeIdentity, dbNamesForSlug } from '../src/lib/worktree/identity';
import { getRegistryPath, writeRegistryLocked, allocatePort } from '../src/lib/worktree/registry';
import { runReap } from '../src/lib/worktree/reap';
import { writeEnvIfMissing, findMismatchedEnvKeys } from '../src/lib/worktree/env-file';
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

  try {
    const reaped = await runReap(identity.gitCommonDir, registryPath, `${DB_HOST}/postgres`);
    if (reaped.length > 0) {
      console.log(`[worktree:setup] reaped orphaned worktree resources: ${reaped.join(', ')}`);
    }
  } catch (err) {
    console.warn('[worktree:setup] reap sweep failed — continuing without it, this worktree is unaffected:', err);
  }

  let port = 0;
  await writeRegistryLocked(registryPath, (registry) => {
    const result = allocatePort(registry, rawName, dbSlug);
    port = result.port;
    return result.registry;
  });

  // A worktree is a checkout of committed versions, so `npm ci`: it installs
  // the lockfile exactly and fails when `package.json` disagrees with it.
  // Why that matters over `npm install`: `docs/supply-chain.md`.
  // Pinned by `src/lib/script-install-census.test.ts`.
  console.log('[worktree:setup] running npm ci...');
  execSync('npm ci', { stdio: 'inherit' });

  const { test, dev } = dbNamesForSlug(dbSlug);
  const envPath = path.resolve(process.cwd(), '.env');
  const examplePath = path.resolve(process.cwd(), '.env.example');
  const overrides = buildEnvOverrides(DB_HOST, dev, test, port);
  const wrote = writeEnvIfMissing(envPath, examplePath, overrides);

  console.log(`[worktree:setup] rawName: ${rawName}`);
  console.log(`[worktree:setup] dbSlug: ${dbSlug}`);
  console.log(`[worktree:setup] port: ${port}`);
  console.log(`[worktree:setup] databases: ${dev}, ${test}`);
  console.log(wrote ? '[worktree:setup] wrote .env' : '[worktree:setup] .env already exists — left untouched');

  if (!wrote) {
    const mismatched = findMismatchedEnvKeys(envPath, overrides);
    if (mismatched.length > 0) {
      console.warn(`[worktree:setup] .env already exists and does not match this worktree's isolation settings for: ${mismatched.join(', ')}`);
      console.warn('[worktree:setup] if this .env was copied from elsewhere, delete it and re-run this command to regenerate it correctly');
    }
  }

  console.log('[worktree:setup] next: npm run worktree:up');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
