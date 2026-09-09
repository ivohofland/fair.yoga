import { removeEntry, writeRegistryLocked, type Registry, type RegistryEntry } from './registry';
import { dbNamesForSlug, sanitizeSlug } from './identity';
import { getLiveWorktreeNames } from './live-slugs';
import { dropDatabaseReal, killPidReal } from './side-effects';

export interface ReapDeps {
  dropDatabase: (dbName: string) => Promise<void>;
  killPid: (pid: number) => void;
}

export interface ReapResult {
  registry: Registry;
  reaped: string[];
  migrated: Array<{ from: string; to: string }>;
}

/** Kills the pid (if any), drops both of the entry's databases, and removes it from `registry`. */
async function reapEntry(
  registry: Registry,
  key: string,
  entry: RegistryEntry,
  deps: ReapDeps,
  reaped: string[],
): Promise<Registry> {
  try {
    if (entry.pid !== null) {
      deps.killPid(entry.pid);
    }
    const { test, dev } = dbNamesForSlug(entry.dbSlug);
    await deps.dropDatabase(test);
    await deps.dropDatabase(dev);
    reaped.push(key);
    return removeEntry(registry, key);
  } catch (err) {
    console.warn(`[reap] failed to reap orphaned worktree "${key}" — will retry on the next sweep:`, err);
    return registry;
  }
}

/**
 * Classifies every registry row as live, a legacy pre-migration row rescuable
 * by dbSlug, or orphaned, and applies the matching action. Deliberately not
 * built on `diffOrphans` — the three-way classification needs the same
 * live-set membership test done once per row, and a "diff then extra step"
 * shape would recompute it, risking the legacy-rescue branch. See
 * docs/superpowers/specs/2026-09-09-worktree-registry-key-collision-design.md
 * (§4) for the full rationale and pseudocode this follows.
 */
export async function reapOrphans(
  registry: Registry,
  liveRawNames: ReadonlySet<string>,
  deps: ReapDeps,
): Promise<ReapResult> {
  let next = registry;
  const reaped: string[] = [];
  const migrated: Array<{ from: string; to: string }> = [];

  for (const [key, entry] of Object.entries(registry)) {
    if (liveRawNames.has(key)) {
      continue; // already rawName-keyed, live
    }

    // Only true for a row whose key IS already a bare dbSlug — every
    // pre-migration row, plus any post-fix row whose raw name happened to
    // need no sanitizing. This gate is load-bearing: without it, a
    // rawName-keyed dead row whose dbSlug happens to collide with a
    // different live worktree's dbSlug would wrongly take the legacy-rescue
    // path below instead of being reaped outright.
    if (key === entry.dbSlug) {
      const target = [...liveRawNames].find((name) => sanitizeSlug(name) === key);
      if (target !== undefined) {
        if (registry[target] === undefined) {
          // Rekey: move this entry to the live worktree's real name, keep
          // port/pid, dbSlug stays `key`.
          next = removeEntry(next, key);
          next = { ...next, [target]: { ...entry } };
          migrated.push({ from: key, to: target });
        } else {
          // `target` already has its own row — stale leftover from that
          // worktree's own earlier self-migration; its resources are
          // already owned by the row at `target`.
          next = removeEntry(next, key);
        }
        continue;
      }
      // else: no live worktree's dbSlug claims it — fall through to reap.
    }

    next = await reapEntry(next, key, entry, deps, reaped);
  }

  return { registry: next, reaped, migrated };
}

/** Real IO wired up: live git state in, dropped databases and a persisted registry out. */
export async function runReap(
  gitCommonDir: string,
  registryPath: string,
  anyDatabaseUrl: string,
): Promise<string[]> {
  const liveRawNames = getLiveWorktreeNames(gitCommonDir);
  let reapedKeys: string[] = [];
  await writeRegistryLocked(registryPath, async (registry) => {
    const { registry: next, reaped, migrated } = await reapOrphans(registry, liveRawNames, {
      dropDatabase: (dbName) => dropDatabaseReal(dbName, anyDatabaseUrl),
      killPid: killPidReal,
    });
    reapedKeys = reaped;
    if (migrated.length > 0) {
      console.log(
        `[reap] migrated legacy registry entries to their live raw name: ${migrated
          .map((m) => `${m.from} -> ${m.to}`)
          .join(', ')}`,
      );
    }
    return next;
  });
  return reapedKeys;
}
