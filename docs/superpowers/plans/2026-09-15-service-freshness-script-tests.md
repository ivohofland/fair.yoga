# Service Image Freshness Script Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #608 — cover `scripts/check-service-image-freshness.ts`'s two untested pieces of orchestration logic (the Docker Hub auth-token + manifest-HEAD flow, and the `image:tag` deduplication) with unit tests, without changing any observable behavior.

**Architecture:** Vitest's `unit` project only globs `src/**/*.test.ts` (`vitest.config.ts`), and this repo's established pattern — already followed by `check-package-manager-freshness.ts` / `src/lib/package-manager-freshness.ts` and by this exact script's own `src/lib/service-image-freshness.ts` (kept deliberately I/O-free per #603's plan doc) — is: pure/testable logic lives in `src/lib`, the script under `scripts/` is a thin orchestrator that imports it. Both untested pieces are extracted verbatim into `src/lib` (no behavior change) so they land under that glob and can be tested directly: the pure `image:tag` grouping joins the other pure functions already in `src/lib/service-image-freshness.ts`; the networked `fetchLatestDigest` — which does real I/O, so it doesn't belong in a file whose docblock promises "no I/O" — moves to a new sibling file, `src/lib/service-image-registry.ts`, and is tested with `vi.stubGlobal('fetch', ...)`, the same mocking convention `src/components/booking/booking-sign-in.test.tsx` already uses.

**Tech Stack:** TypeScript (`strict: true`, no `any`), vitest (`unit` project), no new dependencies.

**Spec:** None — classified "bounded" during premise verification: single reasonable design (mirrors this repo's existing script/lib split, applied to this script's own two untested pieces), no data-model/auth/money involved, test-only change with zero behavior change. Presented and approved via this session's explicit no-interaction instruction. Issue: #608 (parent #603, #562).

## Global Constraints

- TypeScript `strict: true` everywhere touched — no `any`, no implicit types.
- **Zero behavior change.** `fetchLatestDigest` and the grouping logic move verbatim; every message string, header, URL, and timeout stays byte-for-byte identical. This is a test-coverage issue, not a refactor of behavior.
- **Task order matters:** both tasks edit `scripts/check-service-image-freshness.ts`'s import block and `main()`. Complete Task 1 (including its commit) before starting Task 2 — they touch overlapping regions of the same file and must not run concurrently.
- Run `pnpm run verify` before pushing (needs the app live — see the `verify` skill). This branch has no UI surface, so no manual browser check is needed.
- New test files land under `src/lib/`, which the `unit` vitest project already globs (`src/**/*.test.ts`) — no `vitest.config.ts` change needed.

---

### Task 1: Extract and test `groupByImageTag`

**Files:**
- Modify: `src/lib/service-image-freshness.ts`
- Modify: `src/lib/service-image-freshness.test.ts`
- Modify: `scripts/check-service-image-freshness.ts:116-122` (grouping loop), `scripts/check-service-image-freshness.ts:4-10` (import block)

**Interfaces:**
- Produces (used by the script): `groupByImageTag<T extends ImagePin>(pins: readonly T[]): Map<string, T[]>` — groups pins by `` `${pin.image}:${pin.tag}` ``, preserving insertion order within each group and across group keys. Generic over any `ImagePin`-shaped type so it works with the script's own `LocatedPin` (which adds a `file` field) without either file depending on the other's extra fields.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/service-image-freshness.test.ts`, after the existing `checkServiceImageFreshness` describe block, and add `groupByImageTag` to the existing import from `./service-image-freshness`:

```ts
import {
  checkServiceImageFreshness,
  countImageKeyLines,
  extractImageReferences,
  groupByImageTag,
  parseImagePin,
} from './service-image-freshness';
```

```ts
describe('groupByImageTag', () => {
  it('groups multiple pins sharing the same image:tag under one key', () => {
    const pins = [
      { image: 'postgres', tag: '16-alpine', digest: 'sha256:aaa', file: 'ci.yml' },
      { image: 'postgres', tag: '16-alpine', digest: 'sha256:bbb', file: 'e2e-flake-repro.yml' },
    ];
    const groups = groupByImageTag(pins);
    expect(groups.size).toBe(1);
    expect(groups.get('postgres:16-alpine')).toEqual(pins);
  });

  it('keeps different image:tag pairs in separate groups, in first-seen order', () => {
    const pins = [
      { image: 'postgres', tag: '16-alpine', digest: 'sha256:aaa', file: 'ci.yml' },
      { image: 'redis', tag: '7', digest: 'sha256:bbb', file: 'ci.yml' },
    ];
    const groups = groupByImageTag(pins);
    expect(groups.size).toBe(2);
    expect([...groups.keys()]).toEqual(['postgres:16-alpine', 'redis:7']);
  });

  it('returns an empty map for no pins', () => {
    expect(groupByImageTag([]).size).toBe(0);
  });

  it("keeps each pin's own digest intact within a shared group, so a stale digest for one occurrence does not affect a sibling's fresh verdict", () => {
    const stale = { image: 'postgres', tag: '16-alpine', digest: 'sha256:stale', file: 'ci.yml' };
    const fresh = { image: 'postgres', tag: '16-alpine', digest: 'sha256:fresh', file: 'e2e-flake-repro.yml' };
    const group = groupByImageTag([stale, fresh]).get('postgres:16-alpine')!;
    const latest = 'sha256:fresh';
    expect(checkServiceImageFreshness(group[0]!.digest, latest).fresh).toBe(false);
    expect(checkServiceImageFreshness(group[1]!.digest, latest).fresh).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project unit src/lib/service-image-freshness.test.ts`
Expected: FAIL — `groupByImageTag` is not exported from `./service-image-freshness`.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/service-image-freshness.ts`, add after `parseImagePin` (i.e. after the current line 69, before the `checkServiceImageFreshness` comment/function):

```ts
export function groupByImageTag<T extends ImagePin>(pins: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const pin of pins) {
    const key = `${pin.image}:${pin.tag}`;
    const group = groups.get(key) ?? [];
    group.push(pin);
    groups.set(key, group);
  }
  return groups;
}
```

Update the file's header docblock (currently lines 1-7) to mention grouping alongside parsing/comparison, since it's still true that the file is pure/no-I/O — just add one clause rather than rewriting the whole comment:

```ts
/**
 * Pure functions over a Docker image reference — no I/O. Parses the
 * `<image>:<tag>@sha256:<digest>` shape this repo pins service-container
 * images to, groups references by image:tag, and compares a pinned digest
 * against one fetched elsewhere (`scripts/check-service-image-freshness.ts`).
 * Rationale and the measured state: docs/supply-chain.md ("The database
 * image").
 */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run --project unit src/lib/service-image-freshness.test.ts`
Expected: PASS — all tests in the file, existing and new.

- [ ] **Step 5: Wire the script to use it**

In `scripts/check-service-image-freshness.ts`, change the import block (currently lines 4-10) to add `groupByImageTag`:

```ts
import {
  checkServiceImageFreshness,
  countImageKeyLines,
  extractImageReferences,
  groupByImageTag,
  parseImagePin,
  type ImagePin,
} from '../src/lib/service-image-freshness';
```

Replace the inline grouping loop (currently lines 116-122):

```ts
  const byImageTag = new Map<string, LocatedPin[]>();
  for (const pin of pins) {
    const key = `${pin.image}:${pin.tag}`;
    const group = byImageTag.get(key) ?? [];
    group.push(pin);
    byImageTag.set(key, group);
  }
```

with:

```ts
  const byImageTag = groupByImageTag(pins);
```

- [ ] **Step 6: Confirm the script still typechecks and runs**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

Run: `pnpm run check-service-image-freshness`
Expected: same output shape as before the change (verifies against the live registry — a "could not reach the registry" skip is fine, a crash is not).

- [ ] **Step 7: Commit**

```bash
git add src/lib/service-image-freshness.ts src/lib/service-image-freshness.test.ts scripts/check-service-image-freshness.ts
git commit -m "test(supply-chain): extract and test image:tag grouping (#608)"
```

---

### Task 2: Extract and test `fetchLatestDigest`

**Files:**
- Create: `src/lib/service-image-registry.ts`
- Create: `src/lib/service-image-registry.test.ts`
- Modify: `scripts/check-service-image-freshness.ts` (remove the local `fetchLatestDigest` function; import it instead)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces (used by the script): `fetchLatestDigest(image: string, tag: string): Promise<string>` — resolves with the registry's current manifest digest for `image:tag`, or rejects with an `Error` whose message names which step failed (auth token non-OK, missing token field, manifest non-OK, missing digest header). Signature and behavior identical to the function currently inline in the script.

- [ ] **Step 1: Write the failing test**

Create `src/lib/service-image-registry.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchLatestDigest } from './service-image-registry';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<unknown>) {
  vi.stubGlobal('fetch', vi.fn(handler));
}

describe('fetchLatestDigest', () => {
  it('rejects when the auth token request responds non-OK', async () => {
    stubFetch((url) => {
      if (url.includes('auth.docker.io')) {
        return Promise.resolve({ ok: false, status: 401 });
      }
      throw new Error('manifest should not be fetched when the token request fails');
    });
    await expect(fetchLatestDigest('postgres', '16-alpine')).rejects.toThrow(
      'auth token request responded 401',
    );
  });

  it('rejects when the auth response has no usable "token" field', async () => {
    stubFetch((url) => {
      if (url.includes('auth.docker.io')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ nope: 'nope' }) });
      }
      throw new Error('manifest should not be fetched when no token is returned');
    });
    await expect(fetchLatestDigest('postgres', '16-alpine')).rejects.toThrow(
      'auth response had no "token" field',
    );
  });

  it('rejects when the manifest request responds non-OK', async () => {
    stubFetch((url) => {
      if (url.includes('auth.docker.io')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: 'tok' }) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    await expect(fetchLatestDigest('postgres', '16-alpine')).rejects.toThrow(
      'manifest request responded 404',
    );
  });

  it('rejects when the manifest response has no docker-content-digest header', async () => {
    stubFetch((url) => {
      if (url.includes('auth.docker.io')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: 'tok' }) });
      }
      return Promise.resolve({ ok: true, headers: new Headers() });
    });
    await expect(fetchLatestDigest('postgres', '16-alpine')).rejects.toThrow(
      'manifest response had no docker-content-digest header',
    );
  });

  it("resolves with the digest, namespacing an unnamespaced image under library/ and sending the token as a bearer header", async () => {
    stubFetch((url, init) => {
      if (url.includes('auth.docker.io')) {
        expect(url).toBe(
          'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/postgres:pull',
        );
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: 'tok' }) });
      }
      expect(url).toBe('https://registry-1.docker.io/v2/library/postgres/manifests/16-alpine');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      return Promise.resolve({ ok: true, headers: new Headers({ 'docker-content-digest': 'sha256:latest' }) });
    });
    await expect(fetchLatestDigest('postgres', '16-alpine')).resolves.toBe('sha256:latest');
  });

  it('uses a namespaced image string verbatim as the repository (no library/ prefix)', async () => {
    stubFetch((url) => {
      if (url.includes('auth.docker.io')) {
        expect(url).toContain('repository:bitnami/postgres:pull');
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: 'tok' }) });
      }
      expect(url).toBe('https://registry-1.docker.io/v2/bitnami/postgres/manifests/16-alpine');
      return Promise.resolve({ ok: true, headers: new Headers({ 'docker-content-digest': 'sha256:latest' }) });
    });
    await expect(fetchLatestDigest('bitnami/postgres', '16-alpine')).resolves.toBe('sha256:latest');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project unit src/lib/service-image-registry.test.ts`
Expected: FAIL — `./service-image-registry` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/service-image-registry.ts`:

```ts
/**
 * Fetches a Docker Hub image tag's current manifest digest — the networked
 * half of the freshness check whose parsing/comparison half is
 * `service-image-freshness.ts` (kept I/O-free there on purpose). Two-step
 * Docker Hub v2 flow: an anonymous auth token scoped to
 * `repository:<repo>:pull`, then a HEAD on the manifest whose
 * `docker-content-digest` response header is the current digest. Used by
 * `scripts/check-service-image-freshness.ts`.
 */

export async function fetchLatestDigest(image: string, tag: string): Promise<string> {
  const repository = image.includes('/') ? image : `library/${image}`;
  const tokenRes = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!tokenRes.ok) throw new Error(`auth token request responded ${tokenRes.status}`);
  const tokenData: unknown = await tokenRes.json();
  const token = (tokenData as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || token === '') {
    throw new Error(`auth response had no "token" field: ${JSON.stringify(tokenData)}`);
  }

  const manifestRes = await fetch(`https://registry-1.docker.io/v2/${repository}/manifests/${tag}`, {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.index.v1+json',
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!manifestRes.ok) throw new Error(`manifest request responded ${manifestRes.status}`);
  const digest = manifestRes.headers.get('docker-content-digest');
  if (!digest) throw new Error('manifest response had no docker-content-digest header');
  return digest;
}
```

This is byte-for-byte the function currently at `scripts/check-service-image-freshness.ts:56-81`, moved and exported.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run --project unit src/lib/service-image-registry.test.ts`
Expected: PASS — all 6 tests.

- [ ] **Step 5: Wire the script to use it**

In `scripts/check-service-image-freshness.ts`:

Add an import for the new module, right after the existing `service-image-freshness` import block:

```ts
import { fetchLatestDigest } from '../src/lib/service-image-registry';
```

Delete the now-duplicate local function — the entire `fetchLatestDigest` definition (the `async function fetchLatestDigest(...) { ... }` block, everything between the import block and `async function main()`).

- [ ] **Step 6: Confirm the script still typechecks and runs**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

Run: `pnpm run check-service-image-freshness`
Expected: same output shape as before the change.

- [ ] **Step 7: Commit**

```bash
git add src/lib/service-image-registry.ts src/lib/service-image-registry.test.ts scripts/check-service-image-freshness.ts
git commit -m "test(supply-chain): extract and test the registry auth+manifest fetch (#608)"
```

---

## Final Verification

- [ ] Run `pnpm run verify` (typecheck, lint, full test suite — needs the app live per the `verify` skill).
- [ ] Confirm `scripts/check-service-image-freshness.ts` no longer defines `fetchLatestDigest` or an inline grouping loop — `grep -n "async function fetchLatestDigest\|byImageTag.set" scripts/check-service-image-freshness.ts` should return nothing.
- [ ] Confirm the two new/modified test files are picked up: `pnpm exec vitest run --project unit src/lib/service-image-freshness.test.ts src/lib/service-image-registry.test.ts` passes.
