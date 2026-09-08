import { diffOrphans, removeSlug, writeRegistryLocked, type Registry } from './registry';
import { dbNamesForSlug } from './identity';
import { getLiveSlugs } from './live-slugs';
import { dropDatabaseReal, killPidReal } from './side-effects';

export interface ReapDeps {
  dropDatabase: (dbName: string) => Promise<void>;
  killPid: (pid: number) => void;
}

export async function reapOrphans(
  registry: Registry,
  liveSlugs: ReadonlySet<string>,
  deps: ReapDeps,
): Promise<{ registry: Registry; reaped: string[] }> {
  const orphans = diffOrphans(registry, liveSlugs);
  let next = registry;
  const reaped: string[] = [];
  for (const { slug, entry } of orphans) {
    try {
      if (entry.pid !== null) {
        deps.killPid(entry.pid);
      }
      const { test, dev } = dbNamesForSlug(slug);
      await deps.dropDatabase(test);
      await deps.dropDatabase(dev);
      next = removeSlug(next, slug);
      reaped.push(slug);
    } catch (err) {
      console.warn(`[reap] failed to reap orphaned worktree "${slug}" — will retry on the next sweep:`, err);
    }
  }
  return { registry: next, reaped };
}

/** Real IO wired up: live git state in, dropped databases and a persisted registry out. */
export async function runReap(
  gitCommonDir: string,
  registryPath: string,
  anyDatabaseUrl: string,
): Promise<string[]> {
  const liveSlugs = getLiveSlugs(gitCommonDir);
  let reapedSlugs: string[] = [];
  await writeRegistryLocked(registryPath, async (registry) => {
    const { registry: next, reaped } = await reapOrphans(registry, liveSlugs, {
      dropDatabase: (dbName) => dropDatabaseReal(dbName, anyDatabaseUrl),
      killPid: killPidReal,
    });
    reapedSlugs = reaped;
    return next;
  });
  return reapedSlugs;
}
