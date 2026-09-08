import fs from 'fs';
import path from 'path';

export interface RegistryEntry {
  port: number;
  pid: number | null;
}

export type Registry = Record<string, RegistryEntry>;

export interface PortRange {
  min: number;
  max: number;
}

export const DEFAULT_PORT_RANGE: PortRange = { min: 3100, max: 3999 };

export function allocatePort(
  registry: Registry,
  slug: string,
  range: PortRange = DEFAULT_PORT_RANGE,
): { registry: Registry; port: number } {
  const existing = registry[slug];
  if (existing) {
    return { registry, port: existing.port };
  }
  const claimed = new Set(Object.values(registry).map((entry) => entry.port));
  for (let port = range.min; port <= range.max; port++) {
    if (!claimed.has(port)) {
      return { registry: { ...registry, [slug]: { port, pid: null } }, port };
    }
  }
  throw new Error(`No free port in range ${range.min}-${range.max}`);
}

export function setPid(registry: Registry, slug: string, pid: number | null): Registry {
  const existing = registry[slug];
  if (!existing) {
    throw new Error(`setPid: no registry entry for slug "${slug}" — call allocatePort first`);
  }
  return { ...registry, [slug]: { ...existing, pid } };
}

export function removeSlug(registry: Registry, slug: string): Registry {
  const next = { ...registry };
  delete next[slug];
  return next;
}

export interface OrphanEntry {
  slug: string;
  entry: RegistryEntry;
}

export function diffOrphans(registry: Registry, liveSlugs: ReadonlySet<string>): OrphanEntry[] {
  return Object.entries(registry)
    .filter(([slug]) => !liveSlugs.has(slug))
    .map(([slug, entry]) => ({ slug, entry }));
}

export function getRegistryPath(gitCommonDir: string): string {
  return path.join(gitCommonDir, 'fairyoga-worktrees.json');
}

export function readRegistry(registryPath: string): Registry {
  try {
    const raw = fs.readFileSync(registryPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Registry;
    }
    return {};
  } catch {
    return {};
  }
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
    fs.writeFileSync(registryPath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  } finally {
    releaseLock(lockDir);
  }
}
