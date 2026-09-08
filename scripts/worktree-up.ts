// scripts/worktree-up.ts
import { loadEnv } from 'vite';
import { getWorktreeIdentity } from '../src/lib/worktree/identity';
import { getRegistryPath, writeRegistryLocked, allocatePort, setPid } from '../src/lib/worktree/registry';
import { runReap } from '../src/lib/worktree/reap';
import { provisionDatabase } from '../src/lib/db-provision';
import { spawnDevServer } from '../src/lib/worktree/dev-server';

async function main(): Promise<void> {
  const identity = getWorktreeIdentity();
  if (identity.isMainCheckout || !identity.slug) {
    console.log('[worktree:up] main checkout — run `npm run dev` directly instead');
    return;
  }
  const slug = identity.slug;

  const registryPath = getRegistryPath(identity.gitCommonDir);

  const fileEnv = loadEnv('', process.cwd(), '');
  const devUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL;
  if (!devUrl) {
    throw new Error('[worktree:up] DATABASE_URL not set — run `npm run worktree:setup` first');
  }

  const reaped = await runReap(identity.gitCommonDir, registryPath, devUrl);
  if (reaped.length > 0) {
    console.log(`[worktree:up] reaped orphaned worktree resources: ${reaped.join(', ')}`);
  }

  let port = 0;
  await writeRegistryLocked(registryPath, (registry) => {
    const result = allocatePort(registry, slug);
    port = result.port;
    return result.registry;
  });

  await provisionDatabase(devUrl, { seed: true });

  const pid = spawnDevServer(process.cwd(), port);
  await writeRegistryLocked(registryPath, (registry) => setPid(registry, slug, pid));

  console.log(`[worktree:up] dev server running at http://localhost:${port} (pid ${pid})`);
  console.log(`[worktree:up] INTEGRATION_BASE_URL=http://localhost:${port}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
