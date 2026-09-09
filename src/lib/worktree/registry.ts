import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { RawName, DbSlug } from './identity';

export interface RegistryEntry {
  port: number;
  pid: number | null;
  /** sanitizeSlug(rawName) at creation time, fixed thereafter — derives database names and identifies legacy (pre-migration) rows in reap.ts. */
  dbSlug: DbSlug;
}

/** Keyed by rawName going forward; a pre-migration row may still be keyed by its own dbSlug until reapOrphans (reap.ts) rekeys or removes it. */
export type Registry = Record<string, RegistryEntry>;

export interface PortRange {
  min: number;
  max: number;
}

export const DEFAULT_PORT_RANGE: PortRange = { min: 3100, max: 3999 };

export class RegistryCollisionError extends Error {
  readonly rawName: string;
  readonly dbSlug: string;
  readonly collidingKey: string;
  /** True when the colliding row's own registry key textually equals this
   *  run's dbSlug — i.e. that row is legacy-shaped (unmigrated), so it could
   *  be this worktree's own not-yet-migrated past self rather than a
   *  genuinely different worktree. See explainCollision. */
  readonly collidingKeyIsLegacyShaped: boolean;

  constructor(rawName: RawName, dbSlug: DbSlug, collidingKey: string) {
    super(
      `allocatePort: worktree "${rawName}" sanitizes to database slug "${dbSlug}", which is already claimed by ` +
        `registered worktree "${collidingKey}" — rename one of the two worktree directories to resolve the collision.`,
    );
    this.name = 'RegistryCollisionError';
    this.rawName = rawName;
    this.dbSlug = dbSlug;
    this.collidingKey = collidingKey;
    this.collidingKeyIsLegacyShaped = collidingKey === dbSlug;
  }
}

/**
 * Enriches a RegistryCollisionError with a hint when the collision could
 * plausibly be against this worktree's own not-yet-migrated legacy row
 * rather than a genuinely different worktree — see
 * docs/superpowers/specs/2026-09-09-worktree-registry-followups-design.md §2.
 * Returns `err` unchanged otherwise.
 */
export function explainCollision(err: RegistryCollisionError, reapFailed: boolean): Error {
  if (!reapFailed || !err.collidingKeyIsLegacyShaped) {
    return err;
  }
  return new Error(
    `${err.message}\n` +
      'note: the reap/migration sweep failed earlier in this run (see the warning above) — this collision ' +
      "may be against this worktree's own not-yet-migrated legacy registry entry, not a genuinely different " +
      'worktree. Re-run this command: if the reap sweep succeeds, migration happens automatically and the ' +
      'collision should clear.',
    { cause: err },
  );
}

export function allocatePort(
  registry: Registry,
  rawName: RawName,
  dbSlug: DbSlug,
  range: PortRange = DEFAULT_PORT_RANGE,
): { registry: Registry; port: number } {
  const existing = registry[rawName];
  if (existing) {
    return { registry, port: existing.port };
  }
  const collision = Object.entries(registry).find(([, entry]) => entry.dbSlug === dbSlug);
  if (collision) {
    const [collidingKey] = collision;
    throw new RegistryCollisionError(rawName, dbSlug, collidingKey);
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
      backfilled[key] = { ...entry, dbSlug: (entry.dbSlug ?? key) as DbSlug };
    }
    return backfilled;
  }
  throw new Error(`[registry] ${registryPath} does not contain a JSON object`);
}

export interface LockOptions {
  retries?: number;
  delayMs?: number;
  staleMs?: number;
}

export const DEFAULT_LOCK_OPTIONS: Required<LockOptions> = {
  retries: 50,
  delayMs: 20,
  staleMs: 60_000,
};

export interface LockInfo {
  pid: number;
  createdAt: number;
  token?: string;
}

export interface LockHandle {
  lockDir: string;
  pid: number;
  token: string;
}

export function parseLockInfo(raw: string): LockInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.pid !== 'number' || !Number.isInteger(obj.pid) || obj.pid <= 0) {
    return null;
  }
  if (typeof obj.createdAt !== 'number' || !Number.isFinite(obj.createdAt) || obj.createdAt <= 0) {
    return null;
  }
  const token = typeof obj.token === 'string' ? obj.token : undefined;
  return {
    pid: obj.pid,
    createdAt: obj.createdAt,
    token,
  };
}

export function readLockInfo(lockDir: string): { info: LockInfo | null; error?: NodeJS.ErrnoException } {
  const ownerPath = path.join(lockDir, 'owner.json');
  try {
    const raw = fs.readFileSync(ownerPath, 'utf8');
    const info = parseLockInfo(raw);
    return { info };
  } catch (err) {
    return { info: null, error: err as NodeJS.ErrnoException };
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return false;
    }
    // EPERM or any ambiguous system error: assume the process is alive (conservative guard against lock theft)
    return true;
  }
}

function sleepSync(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

export function isLockStale(lockDir: string, staleMs: number): { stale: boolean; reason?: string } {
  if (!fs.existsSync(lockDir)) {
    return { stale: false };
  }

  const ownerPath = path.join(lockDir, 'owner.json');
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(ownerPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[registry] unreadable lock info at ${ownerPath} (${err}): falling back to directory age check`);
    }
  }

  const info = raw !== null ? parseLockInfo(raw) : null;
  if (raw !== null && info === null) {
    console.warn(`[registry] corrupted lock info at ${ownerPath}: falling back to directory age check`);
  }

  // 1. PID-based staleness: evaluated when PID is known.
  if (info !== null) {
    if (!isPidAlive(info.pid)) {
      return { stale: true, reason: `holder pid ${info.pid} is not alive` };
    }
    // Holder PID is confirmed alive. Never reclaim an active process's lock by age.
    return { stale: false };
  }

  // 2. Age-based staleness: fallback only when PID is absent or unparseable.
  let lockTime: number | null = null;
  try {
    const stat = fs.statSync(lockDir);
    lockTime = stat.mtimeMs;
  } catch {
    return { stale: false };
  }

  if (Date.now() - lockTime >= staleMs) {
    return {
      stale: true,
      reason: `unidentified lock age (${Date.now() - lockTime}ms) exceeded threshold of ${staleMs}ms`,
    };
  }

  return { stale: false };
}

export function reclaimStaleLock(lockDir: string, staleMs: number): boolean {
  const nonce = crypto.randomBytes(4).toString('hex');
  const reclaimingDir = `${lockDir}.reclaiming.${process.pid}.${Date.now()}.${nonce}`;

  try {
    fs.renameSync(lockDir, reclaimingDir);
  } catch {
    // Another concurrent process already renamed or removed lockDir
    return false;
  }

  const check = isLockStale(reclaimingDir, staleMs);
  if (check.stale) {
    console.warn(`[registry] reclaimed stale lock at ${lockDir} (${check.reason})`);
    fs.rmSync(reclaimingDir, { recursive: true, force: true });
    return true;
  }

  // The lock was unexpectedly alive; restore it back to lockDir if possible
  try {
    fs.renameSync(reclaimingDir, lockDir);
  } catch {
    fs.rmSync(reclaimingDir, { recursive: true, force: true });
  }
  return false;
}

export function acquireLock(lockDir: string, options?: LockOptions): LockHandle {
  const retries = options?.retries ?? DEFAULT_LOCK_OPTIONS.retries;
  const delayMs = options?.delayMs ?? DEFAULT_LOCK_OPTIONS.delayMs;
  const staleMs = options?.staleMs ?? DEFAULT_LOCK_OPTIONS.staleMs;

  let reclaimedStale = false;
  let observedToken: string | null | undefined = undefined;

  while (true) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        fs.mkdirSync(lockDir);
        const token = `${process.pid}:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`;
        const ownerInfo: LockInfo = { pid: process.pid, createdAt: Date.now(), token };
        try {
          fs.writeFileSync(path.join(lockDir, 'owner.json'), `${JSON.stringify(ownerInfo)}\n`);
        } catch (writeErr) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          throw writeErr;
        }
        return { lockDir, pid: process.pid, token };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }
        if (observedToken === undefined) {
          const { info } = readLockInfo(lockDir);
          observedToken = info?.token ?? null;
        }
        sleepSync(delayMs);
      }
    }

    if (!fs.existsSync(lockDir)) {
      continue;
    }

    const { stale } = isLockStale(lockDir, staleMs);
    if (stale && !reclaimedStale) {
      const reclaimed = reclaimStaleLock(lockDir, staleMs);
      if (reclaimed) {
        reclaimedStale = true;
      }
      observedToken = undefined;
      continue;
    }

    // Check if the lock holder changed while we were waiting
    const { info: currentInfo } = readLockInfo(lockDir);
    const currentToken = currentInfo?.token ?? null;
    if (observedToken !== undefined && currentToken !== observedToken) {
      observedToken = currentToken;
      continue;
    }

    throw new Error(`Timed out waiting for lock at ${lockDir}`);
  }
}

export function releaseLock(lockDir: string, expectedTokenOrPid?: string | number): void {
  try {
    if (expectedTokenOrPid !== undefined) {
      const { info, error } = readLockInfo(lockDir);
      if (info) {
        // owner.json read cleanly — only a genuine, verified mismatch blocks release.
        // isLockStale never reclaims a lock whose recorded pid is alive, so the only
        // way another process now owns this path is if we (the caller) are that dead
        // holder — impossible, since we're the ones running this code.
        const matches =
          typeof expectedTokenOrPid === 'string' ? info.token === expectedTokenOrPid : info.pid === expectedTokenOrPid;
        if (!matches) {
          return;
        }
      } else if (error && error.code !== 'ENOENT') {
        // owner.json exists but couldn't be verified (EACCES/EMFILE/EIO/corrupt JSON).
        // Refusing to delete here would leak the lock permanently: once our own pid is
        // what isLockStale sees as "alive", nobody — including us on a later attempt —
        // can ever reclaim it. The caller reached this point holding `expectedTokenOrPid`,
        // so a stale read here is far likelier to be transient noise on our own file than
        // evidence of a different owner. Warn and proceed rather than wedge indefinitely.
        console.warn(`[registry] could not verify lock ownership at ${lockDir} before release (${error}) — releasing anyway`);
      }
      // error.code === 'ENOENT': nothing there to protect; fall through and clean up.
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Ignore release errors to avoid masking caller errors or failed operations
  }
}

const ASSERT_LOCK_HELD_RETRIES = 3;
const ASSERT_LOCK_HELD_RETRY_DELAY_MS = 5;

export function assertLockHeld(handle: LockHandle): void {
  let result = readLockInfo(handle.lockDir);
  // A non-ENOENT error is ambiguous (EACCES/EMFILE/EIO) — retry briefly before
  // concluding anything, since a transient read glitch on our own just-read file is
  // far more likely than a genuine mid-mutation theft (isLockStale never reclaims a
  // lock whose pid is alive, and we are that pid). ENOENT means the directory is
  // genuinely gone, so there's nothing to gain from retrying it.
  for (
    let attempt = 1;
    attempt < ASSERT_LOCK_HELD_RETRIES && !result.info && result.error && result.error.code !== 'ENOENT';
    attempt++
  ) {
    sleepSync(ASSERT_LOCK_HELD_RETRY_DELAY_MS);
    result = readLockInfo(handle.lockDir);
  }
  const { info, error } = result;

  if (info) {
    if (info.pid === handle.pid && info.token === handle.token) {
      return;
    }
    throw new Error(
      `[registry] lock at ${handle.lockDir} was lost during mutation (held by ${info.pid}, expected ${handle.pid})`,
    );
  }

  if (!error || error.code === 'ENOENT') {
    throw new Error(
      `[registry] lock at ${handle.lockDir} was lost during mutation (held by unknown, expected ${handle.pid})`,
    );
  }

  // Read kept failing for a reason unrelated to the lock's actual state. Abort the
  // commit rather than guess — but say what actually happened instead of implying
  // the lock was confirmed stolen.
  throw new Error(
    `[registry] could not verify lock ownership at ${handle.lockDir} before commit (${error}) — aborting rather than risk an unsynchronized write`,
  );
}

export async function writeRegistryLocked(
  registryPath: string,
  mutate: (registry: Registry) => Registry | Promise<Registry>,
  lockOptions?: LockOptions,
): Promise<Registry> {
  const lockDir = `${registryPath}.lock`;
  const handle = acquireLock(lockDir, lockOptions);
  try {
    const current = readRegistry(registryPath);
    const next = await mutate(current);
    const tmpPath = `${registryPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`);
      assertLockHeld(handle);
      fs.renameSync(tmpPath, registryPath);
    } catch (writeErr) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // Ignore tmp cleanup error
      }
      throw writeErr;
    }
    return next;
  } finally {
    releaseLock(lockDir, handle.token);
  }
}
