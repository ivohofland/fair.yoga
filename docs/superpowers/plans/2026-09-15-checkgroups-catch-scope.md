# checkGroups Catch Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #611 — narrow `checkGroups`'s catch (`src/lib/service-image-check.ts`) so it only
skips-and-warns on failures `fetchLatestDigest` (`src/lib/service-image-registry.ts`) recognises as
"the registry itself is the problem," and lets anything else (a `SyntaxError` from a malformed
response body, or any other unexpected exception shape) propagate to the top-level `main().catch`
in `scripts/check-service-image-freshness.ts` instead of being silently folded into the same
"registry unreachable" warning a genuine outage gets.

**Architecture:** Add a marker error class, `RegistryUnreachableError`, exported from
`service-image-registry.ts`. `fetchLatestDigest` throws it for its four existing documented
failure points (auth non-OK, missing token, manifest non-OK, missing digest header) and for a raw
`fetch()` rejection (DNS failure, connection refused, `AbortSignal.timeout` firing) — the two
`fetch()` calls go through a small shared helper that catches and rewraps. `tokenRes.json()` stays
unwrapped, so a `SyntaxError` from an unparseable body propagates as itself. `checkGroups` then
narrows its catch to `if (!(err instanceof RegistryUnreachableError)) throw err;` before the
existing skip/warn logic, which also lets TypeScript narrow `err` for the rest of the catch block
(dropping the `instanceof Error` ternaries already there). No change needed in
`scripts/check-service-image-freshness.ts` — its `main().catch` already does
`console.error(err); process.exit(1)`, which is exactly the "fails loudly" behavior #611 wants.

**Tech Stack:** TypeScript (`strict: true`, no `any`), vitest (`unit` project), no new dependencies.

**Spec:** None — classified "bounded" during brainstorming (single file pair, one reasonable
design, no data-model/auth/money involved; the issue itself already argues the design: "narrowing
the catch... is additive, not a redesign"). Design was presented in chat and approved via the
session's explicit no-interaction instruction. Issue: #611.

## Global Constraints

- TypeScript `strict: true` everywhere touched — no `any`, no implicit types.
- No new dependencies — `Error`'s built-in `cause` option only (already read elsewhere in this
  file pair; Node 22 / `lib: ["dom", "dom.iterable", "esnext"]` support it).
- The four documented failure messages in `fetchLatestDigest` stay byte-for-byte unchanged — only
  their `Error` subtype changes, not their text — so the existing "rejects when..." tests in
  `service-image-registry.test.ts` keep passing on message content alone.
- `checkGroups`'s existing skip/warn log line format (`::warning::Could not reach the registry to
  check ${key}'s latest digest (...) — skipping.`) stays byte-for-byte unchanged.
- Run `pnpm run worktree:up` before running anything beyond the `unit` vitest project — not needed
  for this plan, since both tasks stay entirely inside the `unit` project (no HTTP app, no
  database). Run `pnpm run verify` before pushing regardless (needs the app live — see the
  `verify` skill).

---

### Task 1: `RegistryUnreachableError` + narrow `fetchLatestDigest`'s throws

**Files:**
- Modify: `src/lib/service-image-registry.ts`
- Test: `src/lib/service-image-registry.test.ts`

**Interfaces:**
- Produces (used by Task 2):
  - `export class RegistryUnreachableError extends Error` — constructor `(message: string, options?:
    { cause?: unknown })`, sets `this.name = 'RegistryUnreachableError'`.
  - `fetchLatestDigest(image: string, tag: string): Promise<string>` — signature unchanged, but now
    rejects with `RegistryUnreachableError` for its four documented failure points and for a raw
    `fetch()` rejection; rejects with whatever `tokenRes.json()` itself throws (typically
    `SyntaxError`) unwrapped for a malformed auth response body.

- [ ] **Step 1: Write the failing tests**

Add to the bottom of `src/lib/service-image-registry.test.ts` (inside the existing `describe('fetchLatestDigest', ...)` block, and update its import line):

```typescript
import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchLatestDigest, RegistryUnreachableError } from './service-image-registry';
```

```typescript
  it('rejects with a RegistryUnreachableError when the auth token request responds non-OK', async () => {
    stubFetch((url) => {
      if (url.includes('auth.docker.io')) {
        return Promise.resolve({ ok: false, status: 401 });
      }
      throw new Error('manifest should not be fetched when the token request fails');
    });
    await expect(fetchLatestDigest('postgres', '16-alpine')).rejects.toBeInstanceOf(
      RegistryUnreachableError,
    );
  });

  it('wraps a raw fetch() rejection (e.g. a DNS failure) as a RegistryUnreachableError, preserving message and cause', async () => {
    const cause = new Error('getaddrinfo ENOTFOUND auth.docker.io');
    stubFetch(() => Promise.reject(new TypeError('fetch failed', { cause })));

    const promise = fetchLatestDigest('postgres', '16-alpine');

    await expect(promise).rejects.toBeInstanceOf(RegistryUnreachableError);
    await expect(promise).rejects.toThrow('fetch failed');
    await expect(promise).rejects.toMatchObject({ cause });
  });

  it('propagates a SyntaxError from a malformed auth response body unwrapped, not as a RegistryUnreachableError', async () => {
    const parseError = new SyntaxError('Unexpected token < in JSON at position 0');
    stubFetch((url) => {
      if (url.includes('auth.docker.io')) {
        return Promise.resolve({ ok: true, json: () => Promise.reject(parseError) });
      }
      throw new Error('manifest should not be fetched when the auth body fails to parse');
    });

    await expect(fetchLatestDigest('postgres', '16-alpine')).rejects.toBe(parseError);
  });
```

These three tests must be added; do not modify any other existing test in this step.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run --project unit src/lib/service-image-registry.test.ts`
Expected: FAIL — `RegistryUnreachableError` is not exported yet (import error), so all tests in
the file fail, not just the three new ones.

- [ ] **Step 3: Implement `RegistryUnreachableError` and narrow the throws**

Replace the full contents of `src/lib/service-image-registry.ts` with:

```typescript
/**
 * Fetches a Docker Hub image tag's current manifest digest — the networked
 * half of the service-image freshness check
 * (`scripts/check-service-image-freshness.ts`). Two-step Docker Hub v2
 * flow: an anonymous auth token scoped to `repository:<repo>:pull`, then a
 * HEAD on the manifest whose `docker-content-digest` response header is the
 * current digest. Every failure mode recognised as "the registry itself is
 * the problem" — a non-OK response, a missing token or digest, or the
 * `fetch()` call itself rejecting — throws `RegistryUnreachableError`; an
 * unrecognised failure (e.g. `tokenRes.json()` rejecting because the body
 * isn't JSON) propagates as whatever it natively is, so `checkGroups`
 * (`service-image-check.ts`) doesn't fold a checker bug into a "registry
 * unreachable" warning. See docs/supply-chain.md ("The database image")
 * for why this fetch logic lives in its own file, separate from
 * `service-image-freshness.ts`.
 */

/** A `fetchLatestDigest` failure `checkGroups` treats as "skip this group", not a checker bug. */
export class RegistryUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RegistryUnreachableError';
  }
}

function toRegistryUnreachableError(err: unknown): RegistryUnreachableError {
  if (err instanceof Error) return new RegistryUnreachableError(err.message, { cause: err.cause });
  return new RegistryUnreachableError(String(err));
}

async function fetchOrThrowUnreachable(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw toRegistryUnreachableError(err);
  }
}

export async function fetchLatestDigest(image: string, tag: string): Promise<string> {
  const repository = image.includes('/') ? image : `library/${image}`;
  const tokenRes = await fetchOrThrowUnreachable(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!tokenRes.ok) throw new RegistryUnreachableError(`auth token request responded ${tokenRes.status}`);
  const tokenData: unknown = await tokenRes.json();
  const token = (tokenData as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || token === '') {
    throw new RegistryUnreachableError(`auth response had no "token" field: ${JSON.stringify(tokenData)}`);
  }

  const manifestRes = await fetchOrThrowUnreachable(
    `https://registry-1.docker.io/v2/${repository}/manifests/${tag}`,
    {
      method: 'HEAD',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.index.v1+json',
      },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!manifestRes.ok) throw new RegistryUnreachableError(`manifest request responded ${manifestRes.status}`);
  const digest = manifestRes.headers.get('docker-content-digest');
  if (!digest) throw new RegistryUnreachableError('manifest response had no docker-content-digest header');
  return digest;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run --project unit src/lib/service-image-registry.test.ts`
Expected: PASS — all tests (the 7 pre-existing plus the 3 new ones — 10 total).

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/service-image-registry.ts src/lib/service-image-registry.test.ts
git commit -m "$(cat <<'EOF'
feat(supply-chain): narrow fetchLatestDigest's throws to RegistryUnreachableError (#611)

fetchLatestDigest's four documented failure points, and any raw
fetch() rejection, now throw RegistryUnreachableError instead of a
plain Error — a marker checkGroups (next commit) will use to stop
folding an unrecognised failure shape (e.g. a SyntaxError from a
malformed auth response body) into the same "registry unreachable"
warning a genuine outage gets.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Narrow `checkGroups`'s catch, update its tests and docs

**Files:**
- Modify: `src/lib/service-image-check.ts`
- Test: `src/lib/service-image-check.test.ts`
- Modify: `docs/supply-chain.md`

**Interfaces:**
- Consumes (from Task 1): `RegistryUnreachableError` exported from `./service-image-registry`.
- Produces: `checkGroups`'s exported signature is unchanged
  (`checkGroups<T>(byImageTag, fetchDigest): Promise<CheckGroupsResult>`); only its catch's runtime
  behavior changes — a rejection that is not `instanceof RegistryUnreachableError` now propagates
  out of `checkGroups` instead of being counted in `skippedGroups`.

- [ ] **Step 1: Update the existing tests that model a "registry unreachable" rejection, and write the two new failing tests**

Replace the full contents of `src/lib/service-image-check.test.ts` with:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { checkGroups } from './service-image-check';
import { RegistryUnreachableError } from './service-image-registry';

function pin(image: string, tag: string, digest: string, file: string) {
  return { image, tag, digest, file };
}

describe('checkGroups', () => {
  it('fetches the digest exactly once for a group with multiple pins sharing the same image:tag', async () => {
    const group = [pin('postgres', '16-alpine', 'sha256:aaa', 'a.yml'), pin('postgres', '16-alpine', 'sha256:aaa', 'b.yml')];
    const byImageTag = new Map([['postgres:16-alpine', group]]);
    const fetchDigest = vi.fn().mockResolvedValue('sha256:aaa');

    await checkGroups(byImageTag, fetchDigest);

    expect(fetchDigest).toHaveBeenCalledTimes(1);
    expect(fetchDigest).toHaveBeenCalledWith('postgres', '16-alpine');
  });

  it('skips a group whose fetch rejects with a RegistryUnreachableError, without throwing, and counts it as skipped', async () => {
    const group = [pin('postgres', '16-alpine', 'sha256:aaa', 'a.yml')];
    const byImageTag = new Map([['postgres:16-alpine', group]]);
    const fetchDigest = vi.fn().mockRejectedValue(new RegistryUnreachableError('registry unreachable'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await checkGroups(byImageTag, fetchDigest);

    expect(result).toEqual({ anyStale: false, skippedGroups: 1 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('::warning::'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('registry unreachable'));
    logSpy.mockRestore();
  });

  it('propagates a rejection that is not a RegistryUnreachableError, rather than treating it as skippable', async () => {
    const group = [pin('postgres', '16-alpine', 'sha256:aaa', 'a.yml')];
    const byImageTag = new Map([['postgres:16-alpine', group]]);
    const unexpected = new SyntaxError('Unexpected token < in JSON at position 0');
    const fetchDigest = vi.fn().mockRejectedValue(unexpected);

    await expect(checkGroups(byImageTag, fetchDigest)).rejects.toBe(unexpected);
  });

  it('stops processing further groups once an unexpected error propagates, rather than continuing past it', async () => {
    const failingGroup = [pin('alpine', 'latest', 'sha256:aaa', 'a.yml')];
    const neverGroup = [pin('redis', '7', 'sha256:same', 'b.yml')];
    const byImageTag = new Map([
      ['alpine:latest', failingGroup],
      ['redis:7', neverGroup],
    ]);
    const unexpected = new SyntaxError('Unexpected token < in JSON at position 0');
    const fetchDigest = vi.fn((image: string) => {
      if (image === 'alpine') return Promise.reject(unexpected);
      return Promise.resolve('sha256:same');
    });

    await expect(checkGroups(byImageTag, fetchDigest)).rejects.toBe(unexpected);
    expect(fetchDigest).not.toHaveBeenCalledWith('redis', '7');
  });

  it('reports anyStale when a fetched digest differs from a pin, and does not let a skipped group affect a sibling group', async () => {
    const staleGroup = [pin('postgres', '16-alpine', 'sha256:old', 'a.yml')];
    const unreachableGroup = [pin('redis', '7', 'sha256:bbb', 'b.yml')];
    const byImageTag = new Map([
      ['postgres:16-alpine', staleGroup],
      ['redis:7', unreachableGroup],
    ]);
    const fetchDigest = vi.fn((image: string) => {
      if (image === 'postgres') return Promise.resolve('sha256:new');
      return Promise.reject(new RegistryUnreachableError('unreachable'));
    });

    const result = await checkGroups(byImageTag, fetchDigest);

    expect(result).toEqual({ anyStale: true, skippedGroups: 1 });
  });

  it('reports no stale groups and no skips when every pin matches the fetched digest', async () => {
    const group = [pin('postgres', '16-alpine', 'sha256:aaa', 'a.yml')];
    const byImageTag = new Map([['postgres:16-alpine', group]]);
    const fetchDigest = vi.fn().mockResolvedValue('sha256:aaa');

    const result = await checkGroups(byImageTag, fetchDigest);

    expect(result).toEqual({ anyStale: false, skippedGroups: 0 });
  });

  it('keeps checking groups after an earlier one is skipped — does not stop at the first unreachable group', async () => {
    const failingGroup = [pin('alpine', 'latest', 'sha256:aaa', 'a.yml')];
    const staleGroup = [pin('postgres', '16-alpine', 'sha256:old', 'b.yml')];
    const freshGroup = [pin('redis', '7', 'sha256:same', 'c.yml')];
    const byImageTag = new Map([
      ['alpine:latest', failingGroup],
      ['postgres:16-alpine', staleGroup],
      ['redis:7', freshGroup],
    ]);
    const fetchDigest = vi.fn((image: string) => {
      if (image === 'alpine') return Promise.reject(new RegistryUnreachableError('unreachable'));
      if (image === 'postgres') return Promise.resolve('sha256:new');
      return Promise.resolve('sha256:same');
    });

    const result = await checkGroups(byImageTag, fetchDigest);

    expect(fetchDigest).toHaveBeenCalledWith('postgres', '16-alpine');
    expect(fetchDigest).toHaveBeenCalledWith('redis', '7');
    expect(result).toEqual({ anyStale: true, skippedGroups: 1 });
  });

  it('visits every pin in a group, not just the first — a fresh pin does not stop the loop before a later stale one is seen', async () => {
    const group = [
      pin('postgres', '16-alpine', 'sha256:same', 'fresh.yml'),
      pin('postgres', '16-alpine', 'sha256:old', 'stale.yml'),
    ];
    const byImageTag = new Map([['postgres:16-alpine', group]]);
    const fetchDigest = vi.fn().mockResolvedValue('sha256:same');

    const result = await checkGroups(byImageTag, fetchDigest);

    expect(result).toEqual({ anyStale: true, skippedGroups: 0 });
  });

  it('visits every pin in a group even in the opposite order — a stale pin does not stop the loop before a later fresh one is checked', async () => {
    const group = [
      pin('postgres', '16-alpine', 'sha256:old', 'stale.yml'),
      pin('postgres', '16-alpine', 'sha256:same', 'fresh.yml'),
    ];
    const byImageTag = new Map([['postgres:16-alpine', group]]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchDigest = vi.fn().mockResolvedValue('sha256:same');

    const result = await checkGroups(byImageTag, fetchDigest);

    expect(result).toEqual({ anyStale: true, skippedGroups: 0 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('fresh.yml'));
    logSpy.mockRestore();
  });
});
```

(This changes the two `new Error('unreachable')` rejections to `new RegistryUnreachableError('unreachable')` in the two tests that need a *skippable* rejection, adds the `RegistryUnreachableError` import, and adds the two new tests proving a non-`RegistryUnreachableError` rejection propagates and halts the loop. Every other test is untouched.)

- [ ] **Step 2: Run tests to verify the two new tests fail and nothing else regresses on the old catch**

Run: `pnpm exec vitest run --project unit src/lib/service-image-check.test.ts`
Expected: FAIL on the two new tests only ("propagates a rejection that is not a
RegistryUnreachableError..." and "stops processing further groups...") — today's catch swallows
every rejection regardless of type, so both currently resolve instead of rejecting. The other 7
pre-existing tests still pass unchanged, since `RegistryUnreachableError extends Error` and
today's catch is `instanceof Error`-based.

- [ ] **Step 3: Narrow `checkGroups`'s catch**

Replace the full contents of `src/lib/service-image-check.ts` with:

```typescript
/**
 * Runs the per-`image:tag` freshness check for
 * `scripts/check-service-image-freshness.ts`'s main loop: fetches each
 * group's latest digest (injected, so tests can substitute a mock without
 * touching the network) and reports every pin's freshness against it,
 * skipping — not crashing — a group whose fetch rejects with a
 * `RegistryUnreachableError`. Any other rejection propagates rather than
 * being folded into that skip path. Extracted so the loop has a home
 * under `src/lib` that vitest's `unit` project collects, letting #608's
 * acceptance criteria (one fetch per group; a rejected fetch skips rather
 * than throws) be asserted directly.
 */
import { checkServiceImageFreshness, type ImagePin } from './service-image-freshness';
import { RegistryUnreachableError } from './service-image-registry';

export interface CheckGroupsResult {
  readonly anyStale: boolean;
  readonly skippedGroups: number;
}

export async function checkGroups<T extends ImagePin & { readonly file: string }>(
  byImageTag: ReadonlyMap<string, readonly T[]>,
  fetchDigest: (image: string, tag: string) => Promise<string>,
): Promise<CheckGroupsResult> {
  let anyStale = false;
  let skippedGroups = 0;
  for (const [key, group] of byImageTag) {
    const { image, tag } = group[0]!;
    let latest: string;
    try {
      latest = await fetchDigest(image, tag);
    } catch (err) {
      if (!(err instanceof RegistryUnreachableError)) throw err;
      const cause = err.cause ? ` — ${String(err.cause)}` : '';
      skippedGroups++;
      console.log(
        `::warning::Could not reach the registry to check ${key}'s latest digest (${err.message}${cause}) — skipping.`,
      );
      continue;
    }

    for (const pin of group) {
      const result = checkServiceImageFreshness(pin.digest, latest);
      if (result.fresh) {
        console.log(`✓ ${pin.file}: ${key}@${pin.digest} matches the registry's latest.`);
      } else {
        anyStale = true;
        console.error(
          `${pin.file}: ${key} is pinned at ${result.pinned}; the registry's latest is ${result.latest}. ` +
            `Review whether to bump the digest (see docs/supply-chain.md, "The database image").`,
        );
      }
    }
  }

  return { anyStale, skippedGroups };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run --project unit src/lib/service-image-check.test.ts`
Expected: PASS — all 9 tests (7 pre-existing plus the 2 new ones: `9 = 7 + 2`).

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Update `docs/supply-chain.md`**

In the "### The database image" section, find the paragraph that ends:

```
...and if every image
group was unreachable in a given run, one further `::warning::` line says
so explicitly, since that run verified nothing at all.
```

Immediately after that paragraph (before the "Four pieces of the script's orchestration logic were
extracted..." paragraph), insert this new paragraph:

```markdown
#611 narrowed that catch further: `fetchLatestDigest` throws `RegistryUnreachableError`
(`service-image-registry.ts`) for its four documented failure points and for a raw `fetch()`
rejection (DNS failure, connection refused, the 5s `AbortSignal.timeout` firing), and only that
type routes to the skip-and-warn path above. Anything else — a `SyntaxError` from an auth response
body that isn't valid JSON, or any other unrecognised failure shape — propagates out of
`checkGroups`, out of `main()`, and fails the run loudly at `main().catch`
(`scripts/check-service-image-freshness.ts`) instead of being folded into the same "registry
unreachable" warning a genuine outage gets.
```

- [ ] **Step 7: Run the full unit project to confirm no other file regressed**

Run: `pnpm exec vitest run --project unit src/lib/service-image-check.test.ts src/lib/service-image-registry.test.ts src/lib/service-image-freshness.test.ts src/lib/service-image-scan.test.ts`
Expected: PASS — all tests across all four files.

- [ ] **Step 8: Commit**

```bash
git add src/lib/service-image-check.ts src/lib/service-image-check.test.ts docs/supply-chain.md
git commit -m "$(cat <<'EOF'
fix(supply-chain): checkGroups only skips a RegistryUnreachableError (#611)

checkGroups's catch previously swallowed any exception fetchDigest
threw and reported it as "could not reach the registry" — including a
SyntaxError from an unparseable response body, which would have hidden
a broken checker behind that same message forever. It now only skips
a RegistryUnreachableError; anything else propagates to the top-level
main().catch in scripts/check-service-image-freshness.ts, which
already fails loudly (console.error + exit 1).

Closes #611

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final Verification (after both tasks)

- [ ] Run `pnpm exec tsc --noEmit` — no errors.
- [ ] Run `pnpm exec eslint src/lib/service-image-registry.ts src/lib/service-image-check.ts src/lib/service-image-registry.test.ts src/lib/service-image-check.test.ts` — no errors.
- [ ] Run `pnpm run verify` (needs the app live — see the `verify` skill) before pushing; this
  branch has no UI surface, so no manual browser check is needed.
