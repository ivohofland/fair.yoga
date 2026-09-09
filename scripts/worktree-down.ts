// scripts/worktree-down.ts
import { getWorktreeIdentity } from '../src/lib/worktree/identity';
import { getRegistryPath, writeRegistryLocked, setPid } from '../src/lib/worktree/registry';
import { killPidReal } from '../src/lib/worktree/side-effects';

async function main(): Promise<void> {
  const identity = getWorktreeIdentity();
  if (identity.isMainCheckout || !identity.rawName) {
    console.log('[worktree:down] main checkout — nothing to do');
    return;
  }
  const rawName = identity.rawName;

  const registryPath = getRegistryPath(identity.gitCommonDir);
  await writeRegistryLocked(registryPath, (registry) => {
    const entry = registry[rawName];
    if (!entry) {
      console.log(`[worktree:down] no registry entry for ${rawName} — nothing to do`);
      return registry;
    }
    if (entry.pid !== null) {
      const stopped = killPidReal(entry.pid, entry.port);
      console.log(stopped ? `[worktree:down] stopped pid ${entry.pid}` : `[worktree:down] pid ${entry.pid} was already gone`);
    }
    return setPid(registry, rawName, null);
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
