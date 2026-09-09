// scripts/worktree-down.ts
import { getWorktreeIdentity } from '../src/lib/worktree/identity';
import { getRegistryPath, writeRegistryLocked, setPid } from '../src/lib/worktree/registry';
import { killPidReal } from '../src/lib/worktree/side-effects';

async function main(): Promise<void> {
  const identity = getWorktreeIdentity();
  if (identity.isMainCheckout || !identity.slug) {
    console.log('[worktree:down] main checkout — nothing to do');
    return;
  }
  const slug = identity.slug;

  const registryPath = getRegistryPath(identity.gitCommonDir);
  await writeRegistryLocked(registryPath, (registry) => {
    const entry = registry[slug];
    if (!entry) {
      console.log(`[worktree:down] no registry entry for ${slug} — nothing to do`);
      return registry;
    }
    if (entry.pid !== null) {
      const stopped = killPidReal(entry.pid);
      console.log(stopped ? `[worktree:down] stopped pid ${entry.pid}` : `[worktree:down] pid ${entry.pid} was already gone`);
    }
    return setPid(registry, slug, null);
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
