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
    if (entry.pid === null) {
      return registry;
    }
    const result = killPidReal(entry.pid, entry.port);
    switch (result) {
      case 'signaled':
        console.log(`[worktree:down] stopped pid ${entry.pid}`);
        return setPid(registry, rawName, null);
      case 'already-gone':
        console.log(`[worktree:down] pid ${entry.pid} was already gone`);
        return setPid(registry, rawName, null);
      case 'refused':
      case 'signal-failed':
        // Leave the pid recorded — it may still be running, and clearing it
        // here would let the next worktree:up spawn a second dev server on
        // the same port.
        console.warn(`[worktree:down] could not confirm pid ${entry.pid} was stopped (${result}) — leaving it recorded`);
        return registry;
    }
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
