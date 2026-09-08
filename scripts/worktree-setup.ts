// scripts/worktree-setup.ts
import { execSync } from 'child_process';
import path from 'path';
import { getWorktreeIdentity, dbNamesForSlug } from '../src/lib/worktree/identity';
import { getRegistryPath, writeRegistryLocked, allocatePort } from '../src/lib/worktree/registry';
import { writeEnvIfMissing } from '../src/lib/worktree/env-file';

const DB_HOST = 'postgresql://yoga:yoga_dev_password@localhost:5432';

async function main(): Promise<void> {
  const identity = getWorktreeIdentity();
  if (identity.isMainCheckout || !identity.slug) {
    console.log('[worktree:setup] main checkout — nothing to do');
    return;
  }
  const slug = identity.slug;

  const registryPath = getRegistryPath(identity.gitCommonDir);
  let port = 0;
  await writeRegistryLocked(registryPath, (registry) => {
    const result = allocatePort(registry, slug);
    port = result.port;
    return result.registry;
  });

  console.log('[worktree:setup] running npm install...');
  execSync('npm install', { stdio: 'inherit' });

  const { test, dev } = dbNamesForSlug(slug);
  const envPath = path.resolve(process.cwd(), '.env');
  const examplePath = path.resolve(process.cwd(), '.env.example');
  const wrote = writeEnvIfMissing(envPath, examplePath, {
    DATABASE_URL: `${DB_HOST}/${dev}`,
    DATABASE_URL_TEST: `${DB_HOST}/${test}`,
    INTEGRATION_BASE_URL: `http://localhost:${port}`,
  });

  console.log(`[worktree:setup] slug: ${slug}`);
  console.log(`[worktree:setup] port: ${port}`);
  console.log(`[worktree:setup] databases: ${dev}, ${test}`);
  console.log(wrote ? '[worktree:setup] wrote .env' : '[worktree:setup] .env already exists — left untouched');
  console.log('[worktree:setup] next: npm run worktree:up');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
