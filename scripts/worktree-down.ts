// scripts/worktree-down.ts
import { getWorktreeIdentity } from '../src/lib/worktree/identity';
import { getRegistryPath, writeRegistryLocked, setPid } from '../src/lib/worktree/registry';
import { killPidReal, describeKillOutcome } from '../src/lib/worktree/side-effects';

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
    const outcome = describeKillOutcome(killPidReal(entry.pid, entry.port), entry.pid);
    console[outcome.level](`[worktree:down] ${outcome.message}`);
    // Leaving the pid recorded when unconfirmed keeps this registry row
    // truthfully uncertain rather than claiming a process is gone that
    // might not be.
    return outcome.confirmedStopped ? setPid(registry, rawName, null) : registry;
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
