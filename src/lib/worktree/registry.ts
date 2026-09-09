import fs from 'fs';
import path from 'path';

export interface RegistryEntry {
  port: number;
  pid: number | null;
  /** sanitizeSlug(rawName) at creation time, fixed thereafter — derives database names and identifies legacy (pre-migration) rows in reap.ts. */
  dbSlug: string;
}

/** Keyed by rawName going forward; a pre-migration row may still be keyed by its own dbSlug until reapOrphans (reap.ts) rekeys or removes it. */
export type Registry = Record<string, RegistryEntry>;

export interface PortRange {
  min: number;
  max: number;
}

export const DEFAULT_PORT_RANGE: PortRange = { min: 3100, max: 3999 };

export function allocatePort(
  registry: Registry,
  rawName: string,
  dbSlug: string,
  range: PortRange = DEFAULT_PORT_RANGE,
): { registry: Registry; port: number } {
  const existing = registry[rawName];
  if (existing) {
    return { registry, port: existing.port };
  }
  const collision = Object.entries(registry).find(([, entry]) => entry.dbSlug === dbSlug);
  if (collision) {
    const [collidingKey] = collision;
    throw new Error(
      `allocatePort: worktree "${rawName}" sanitizes to database slug "${dbSlug}", which is already claimed by ` +
        `registered worktree "${collidingKey}" — rename one of the two worktree directories to resolve the collision.`,
    );
  }
  const claimed = new Set(Object.values(registry).map((entry) => entry.port));
  for (let port = range.min; port <= range.max; port++) {
    if (!claimed.has(port)) {
      return { registry: { ...registry, [rawName]: { port, pid: null, dbSlug } }, port };
    }
  }
  throw new Error(`No free port in range ${range.min}-${range.max}`);
}

export function setPid(registry: Registry, key: string, pid: number | null): Registry {
  const existing = registry[key];
  if (!existing) {
    throw new Error(`setPid: no registry entry for key "${key}" — call allocatePort first`);
  }
  return { ...registry, [key]: { ...existing, pid } };
}

export function removeEntry(registry: Registry, key: string): Registry {
  const next = { ...registry };
  delete next[key];
  return next;
}

export interface OrphanEntry {
  key: string;
  entry: RegistryEntry;
}

export function diffOrphans(registry: Registry, liveKeys: ReadonlySet<string>): OrphanEntry[] {
  return Object.entries(registry)
    .filter(([key]) => !liveKeys.has(key))
    .map(([key, entry]) => ({ key, entry }));
}

export function getRegistryPath(gitCommonDir: string): string {
  return path.join(gitCommonDir, 'fairyoga-worktrees.json');
}

export function readRegistry(registryPath: string): Registry {
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(`[registry] could not read ${registryPath}: ${err}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[registry] ${registryPath} contains invalid JSON — refusing to silently discard it: ${err}`);
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    // Pre-migration on-disk shape has no dbSlug field; under the scheme it
    // replaces, the key WAS always exactly sanitizeSlug(rawName), so the key
    // is the correct backfilled dbSlug for that row.
    const entries = parsed as Record<string, Omit<RegistryEntry, 'dbSlug'> & { dbSlug?: string }>;
    const backfilled: Registry = {};
    for (const [key, entry] of Object.entries(entries)) {
      if (typeof entry?.port !== 'number' || (entry.pid !== null && typeof entry.pid !== 'number')) {
        throw new Error(`[registry] ${registryPath} entry "${key}" has a missing or invalid port/pid — refusing to silently treat it as valid`);
      }
      backfilled[key] = { ...entry, dbSlug: entry.dbSlug ?? key };
    }
    return backfilled;
  }
  throw new Error(`[registry] ${registryPath} does not contain a JSON object`);
}

function sleepSync(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

function acquireLock(lockDir: string, retries = 50, delayMs = 20): void {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      fs.mkdirSync(lockDir);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      sleepSync(delayMs);
    }
  }
  throw new Error(`Timed out waiting for lock at ${lockDir}`);
}

function releaseLock(lockDir: string): void {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

export async function writeRegistryLocked(
  registryPath: string,
  mutate: (registry: Registry) => Registry | Promise<Registry>,
): Promise<Registry> {
  const lockDir = `${registryPath}.lock`;
  acquireLock(lockDir);
  try {
    const current = readRegistry(registryPath);
    const next = await mutate(current);
    const tmpPath = `${registryPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmpPath, registryPath);
    return next;
  } finally {
    releaseLock(lockDir);
  }
}
