# Service Image Freshness Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #603 — digest-pin the four GitHub Actions `services:` blocks that reference `postgres:16-alpine` (invisible to every Dependabot ecosystem today) and add a non-blocking CI check that compares those pinned digests against the registry, the same shape `check-package-manager-freshness.ts` already gives the pnpm binary.

**Architecture:** A pure comparison/parsing module (`src/lib/service-image-freshness.ts`, no I/O) plus a script (`scripts/check-service-image-freshness.ts`) that globs `.github/workflows/*.yml`, extracts every `image:` reference, and reports staleness against the Docker Hub registry. Wired as a new non-blocking `checks` step in `ci.yml`, mirroring the existing package-manager-freshness step exactly.

**Tech Stack:** TypeScript (`strict: true`, no `any`), tsx, vitest, no new dependencies — same `fetch`/`readdirSync`/`readFileSync` toolkit the existing freshness script uses.

**Spec:** None — classified "bounded" during brainstorming (mirrors the `check-package-manager-freshness.ts` precedent directly, single reasonable design, no data-model/auth/money involved). Design was presented in chat and approved via the session's explicit no-interaction instruction. Issue: #603 (parent #562).

## Global Constraints

- TypeScript `strict: true` everywhere touched — no `any`, no implicit types.
- The new CI step is non-blocking (`continue-on-error: true`), same as "Package manager pin freshness" — a registry hiccup or a stale image must not redden an unrelated PR.
- No new dependencies. `fetch`, `AbortSignal.timeout`, `node:fs` only.
- Digest to pin: `sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685` — re-resolved live against `registry-1.docker.io` on 2026-09-15 (matches what `docker-compose.yml`/`docker-compose.prod.yml` already pin).
- Run `pnpm run verify` before pushing (needs the app live — see the `verify` skill). This branch has no UI surface, so no manual browser check is needed.

---

### Task 1: Pure parse/compare module + unit tests

**Files:**
- Create: `src/lib/service-image-freshness.ts`
- Create: `src/lib/service-image-freshness.test.ts`

**Interfaces:**
- Produces (used by Task 2):
  - `interface ImagePin { readonly image: string; readonly tag: string; readonly digest: string }`
  - `extractImageReferences(yamlContent: string): string[]` — pulls the raw string after every `image:` key in a YAML file's content (one per line, e.g. `"postgres:16-alpine"` or `"postgres:16-alpine@sha256:…"`).
  - `parseImagePin(reference: string): ImagePin | null` — parses a `"<image>:<tag>@sha256:<64-hex>"` reference; `null` for anything else (a floating tag with no digest included).
  - `interface ServiceImageFreshness { readonly fresh: boolean; readonly pinned: string; readonly latest: string }`
  - `checkServiceImageFreshness(pinnedDigest: string, latestDigest: string): ServiceImageFreshness` — equality only, same reasoning as `checkPackageManagerFreshness`: the registry's digest for a mutable tag can move either direction, so any difference is worth a look.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/service-image-freshness.test.ts
import { describe, expect, it } from 'vitest';
import { checkServiceImageFreshness, extractImageReferences, parseImagePin } from './service-image-freshness';

describe('extractImageReferences', () => {
  it('pulls the reference after each image: key', () => {
    const yaml = [
      'services:',
      '  postgres:',
      '    image: postgres:16-alpine',
      '    ports:',
      '      - 5432:5432',
    ].join('\n');
    expect(extractImageReferences(yaml)).toEqual(['postgres:16-alpine']);
  });

  it('finds every image: line, in document order', () => {
    const yaml = 'image: a:1\nsomething: else\nimage: b:2@sha256:' + 'a'.repeat(64);
    expect(extractImageReferences(yaml)).toEqual(['a:1', `b:2@sha256:${'a'.repeat(64)}`]);
  });

  it('returns an empty array when no image: key is present', () => {
    expect(extractImageReferences('name: CI\non: push\n')).toEqual([]);
  });

  it('ignores a key that merely ends in "image:" (e.g. "base_image:")', () => {
    expect(extractImageReferences('base_image: postgres:16-alpine\n')).toEqual([]);
  });
});

describe('parseImagePin', () => {
  it('parses an image, tag and digest out of a pinned reference', () => {
    const digest = 'cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685';
    expect(parseImagePin(`postgres:16-alpine@sha256:${digest}`)).toEqual({
      image: 'postgres',
      tag: '16-alpine',
      digest: `sha256:${digest}`,
    });
  });

  it('trims surrounding whitespace', () => {
    const digest = 'a'.repeat(64);
    expect(parseImagePin(` postgres:16-alpine@sha256:${digest} `)).toEqual({
      image: 'postgres',
      tag: '16-alpine',
      digest: `sha256:${digest}`,
    });
  });

  it('returns null for a floating tag with no digest', () => {
    expect(parseImagePin('postgres:16-alpine')).toBeNull();
  });

  it('returns null when the digest is not exactly 64 hex characters', () => {
    expect(parseImagePin('postgres:16-alpine@sha256:abc123')).toBeNull();
  });

  it('returns null for a reference with no tag', () => {
    expect(parseImagePin(`postgres@sha256:${'a'.repeat(64)}`)).toBeNull();
  });
});

describe('checkServiceImageFreshness', () => {
  it('reports fresh when the pinned digest matches the registry latest', () => {
    expect(checkServiceImageFreshness('sha256:abc', 'sha256:abc')).toEqual({
      fresh: true,
      pinned: 'sha256:abc',
      latest: 'sha256:abc',
    });
  });

  it('reports stale when the pinned digest differs from the registry latest', () => {
    expect(checkServiceImageFreshness('sha256:abc', 'sha256:def')).toEqual({
      fresh: false,
      pinned: 'sha256:abc',
      latest: 'sha256:def',
    });
  });
});
```

Every test in this file is fully synthetic (no dependency on the real workflow files' current state) so it can be fully green as soon as the module exists — the tethered test proving this module reads the *real*, now-pinned workflow files is added in Task 3, at the point where that claim first becomes true.

- [ ] **Step 2: Run tests to verify the expected failure**

Run: `pnpm exec vitest run --project unit src/lib/service-image-freshness.test.ts`
Expected: FAIL — `Cannot find module './service-image-freshness'` (module doesn't exist yet).

- [ ] **Step 3: Implement the module**

```typescript
// src/lib/service-image-freshness.ts
/**
 * Pure functions over a Docker image reference — no I/O. Parses the
 * `<image>:<tag>@sha256:<digest>` shape this repo pins service-container
 * images to, and compares a pinned digest against one fetched elsewhere
 * (`scripts/check-service-image-freshness.ts`). Rationale and the measured
 * state: docs/supply-chain.md ("The database image").
 */

export interface ImagePin {
  readonly image: string;
  readonly tag: string;
  readonly digest: string;
}

export interface ServiceImageFreshness {
  readonly fresh: boolean;
  readonly pinned: string;
  readonly latest: string;
}

// Any line whose trimmed key is exactly "image" — not a suffix like
// "base_image:" — followed by the reference.
const IMAGE_LINE_PATTERN = /^\s*image:\s*(\S+)\s*$/gm;

// "<image>:<tag>@sha256:<64 hex>" — the shape docker-compose*.yml already
// pins to, and the shape #603 asks the GitHub Actions services: blocks to
// match.
const IMAGE_PIN_PATTERN = /^([^:@\s]+):([^@\s]+)@sha256:([0-9a-f]{64})$/;

export function extractImageReferences(yamlContent: string): string[] {
  return [...yamlContent.matchAll(IMAGE_LINE_PATTERN)].map((match) => match[1] ?? '');
}

export function parseImagePin(reference: string): ImagePin | null {
  const match = IMAGE_PIN_PATTERN.exec(reference.trim());
  if (!match) return null;
  const [, image, tag, digest] = match;
  if (!image || !tag || !digest) return null;
  return { image, tag, digest: `sha256:${digest}` };
}

// Equality, not "does the tag still resolve here": a registry digest behind
// a floating tag can move either direction (a bad release walked back, or a
// deliberate pin ahead of latest), so any difference is worth a human look —
// same reasoning checkPackageManagerFreshness gives for the pnpm pin.
export function checkServiceImageFreshness(pinnedDigest: string, latestDigest: string): ServiceImageFreshness {
  return { fresh: pinnedDigest === latestDigest, pinned: pinnedDigest, latest: latestDigest };
}
```

- [ ] **Step 4: Run tests to verify the expected state**

Run: `pnpm exec vitest run --project unit src/lib/service-image-freshness.test.ts`
Expected: PASS — every test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/lib/service-image-freshness.ts src/lib/service-image-freshness.test.ts
git commit -m "$(cat <<'EOF'
feat(supply-chain): add pure parse/compare module for service image pins

Mirrors package-manager-freshness.ts's shape for #603.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The freshness-check script

**Files:**
- Create: `scripts/check-service-image-freshness.ts`
- Modify: `package.json` (new `check-service-image-freshness` script entry)

**Interfaces:**
- Consumes from Task 1: `extractImageReferences`, `parseImagePin`, `checkServiceImageFreshness`, `ImagePin` from `../src/lib/service-image-freshness`.
- Produces: the `pnpm run check-service-image-freshness` command Task 4 wires into CI. No other task imports this script (it's an entry point, like `check-package-manager-freshness.ts`).

- [ ] **Step 1: Write the script**

```typescript
// scripts/check-service-image-freshness.ts
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  checkServiceImageFreshness,
  extractImageReferences,
  parseImagePin,
  type ImagePin,
} from '../src/lib/service-image-freshness';

const WORKFLOWS_DIR = '.github/workflows';

interface LocatedPin extends ImagePin {
  readonly file: string;
}

interface LocatedUnparsed {
  readonly file: string;
  readonly reference: string;
}

function scanWorkflows(root: string): { pins: LocatedPin[]; unparsed: LocatedUnparsed[] } {
  const dir = path.join(root, WORKFLOWS_DIR);
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const pins: LocatedPin[] = [];
  const unparsed: LocatedUnparsed[] = [];
  for (const file of files) {
    const contents = readFileSync(path.join(dir, file), 'utf8');
    for (const reference of extractImageReferences(contents)) {
      const pin = parseImagePin(reference);
      if (pin) {
        pins.push({ ...pin, file });
      } else {
        unparsed.push({ file, reference });
      }
    }
  }
  return { pins, unparsed };
}

async function fetchLatestDigest(image: string, tag: string): Promise<string> {
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

async function main(): Promise<void> {
  const root = process.cwd();
  const { pins, unparsed } = scanWorkflows(root);

  if (unparsed.length > 0) {
    // Present but unparseable is a real complaint, not "nothing to check" —
    // a floating tag reappearing in a services: block (or any shape this
    // pattern doesn't recognise) must not silently disable the check.
    for (const u of unparsed) {
      console.error(
        `${u.file}: "image: ${u.reference}" is not digest-pinned (expected "<image>:<tag>@sha256:<digest>"). ` +
          'See docs/supply-chain.md ("The database image") for why every service image reference here must be.',
      );
    }
    process.exitCode = 1;
  }

  if (pins.length === 0) {
    if (unparsed.length === 0) {
      console.log(`No service image references found under ${WORKFLOWS_DIR} — nothing to check.`);
    }
    return;
  }

  const byImageTag = new Map<string, LocatedPin[]>();
  for (const pin of pins) {
    const key = `${pin.image}:${pin.tag}`;
    const group = byImageTag.get(key) ?? [];
    group.push(pin);
    byImageTag.set(key, group);
  }

  let anyStale = false;
  for (const [key, group] of byImageTag) {
    const { image, tag } = group[0]!;
    let latest: string;
    try {
      latest = await fetchLatestDigest(image, tag);
    } catch (err) {
      const cause = err instanceof Error && err.cause ? ` — ${String(err.cause)}` : '';
      console.log(
        `Could not reach the registry to check ${key}'s latest digest (${err instanceof Error ? err.message : String(err)}${cause}) — skipping.`,
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

  if (anyStale) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Register the npm script**

Edit `package.json`, adding alongside the existing `check-*` entries (after `"check-package-manager-freshness": "tsx scripts/check-package-manager-freshness.ts",`):

```json
    "check-service-image-freshness": "tsx scripts/check-service-image-freshness.ts",
```

- [ ] **Step 3: Run it against today's (still-floating) workflow files — expect the RED/unparsed path**

Run: `pnpm run check-service-image-freshness`
Expected: exits 1, printing four lines like:
```
.github/workflows/ci.yml: "image: postgres:16-alpine" is not digest-pinned (expected "<image>:<tag>@sha256:<digest>"). See docs/supply-chain.md ("The database image") for why every service image reference here must be.
```
(three from `ci.yml`, one from `e2e-flake-repro.yml`). This proves the "present but unparseable" path fires correctly before Task 3 pins the lines — record the exact output in the PR body.

- [ ] **Step 4: Typecheck**

Run: `pnpm run typecheck`
Expected: PASS, no `any`, no implicit types.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-service-image-freshness.ts package.json
git commit -m "$(cat <<'EOF'
feat(supply-chain): add script to check service image digests against the registry

Confirmed RED against today's still-floating postgres:16-alpine
services: blocks — reports all four as not digest-pinned and exits 1.
Task 3 digest-pins them, which is what turns this green.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Digest-pin the four workflow lines, prove the check goes green, prove it catches staleness

**Files:**
- Modify: `.github/workflows/ci.yml:151`, `.github/workflows/ci.yml:234`, `.github/workflows/ci.yml:336`
- Modify: `.github/workflows/e2e-flake-repro.yml:87`
- Modify: `src/lib/service-image-freshness.test.ts` (add the tethered test from Task 1's note)

**Interfaces:**
- Consumes: `pnpm run check-service-image-freshness` (Task 2) and `extractImageReferences`/`parseImagePin` (Task 1).
- Produces: nothing new — this task is a config + verification task, no new production code.

- [ ] **Step 1: Pin all four lines**

In `.github/workflows/ci.yml`, at each of lines 151, 234 and 336, change:
```yaml
        image: postgres:16-alpine
```
to:
```yaml
        image: postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685
```

In `.github/workflows/e2e-flake-repro.yml`, at line 87, make the same change.

- [ ] **Step 2: Add the tethered unit test and confirm it passes**

Add this test to `src/lib/service-image-freshness.test.ts`, inside the existing `describe('parseImagePin', ...)` block (needs `readFileSync`/`readdirSync` from `node:fs` and `path` from `node:path`, plus a `const root = process.cwd();` near the top of the file alongside the existing imports):

```typescript
// Tethered to the real artifacts, the way parsePackageManagerPin's test
// reads package.json directly — if #603's digest pins are ever hand-edited
// back to a floating tag, this fails immediately instead of the check
// going quietly inert.
it('parses every image: reference this repo currently ships under .github/workflows', () => {
  const dir = path.join(root, '.github/workflows');
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const allPins = files.flatMap((file) =>
    extractImageReferences(readFileSync(path.join(dir, file), 'utf8')).map(parseImagePin),
  );
  expect(allPins.length).toBeGreaterThanOrEqual(4);
  for (const pin of allPins) {
    expect(pin).not.toBeNull();
    expect(pin?.image).toBe('postgres');
    expect(pin?.tag).toBe('16-alpine');
    expect(pin?.digest).toBe('sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685');
  }
});
```

Run: `pnpm exec vitest run --project unit src/lib/service-image-freshness.test.ts`
Expected: PASS — all tests, including the new tethered one (it only passes now that Step 1 has pinned the four lines).

- [ ] **Step 3: Confirm the script now reports fresh (GREEN)**

Run: `pnpm run check-service-image-freshness`
Expected: exits 0, printing four `✓ <file>: postgres:16-alpine@sha256:cf78e7… matches the registry's latest.` lines (one per pinned line — three from `ci.yml`, one from `e2e-flake-repro.yml`).

- [ ] **Step 4: Mutation-test the stale-digest path**

Temporarily corrupt one pinned digest — flip the last hex character on `.github/workflows/ci.yml:151` (e.g. `...fc20685` → `...fc20686`, a value the registry will never actually return). Run `pnpm run check-service-image-freshness` again.

Expected: exits 1, with a stale-digest line for that one location (`ci.yml: postgres:16-alpine is pinned at sha256:…20686; the registry's latest is sha256:…20685. Review whether to bump the digest…`) and three continuing `✓` lines for the other three, still-correct, locations. Record this exact output.

Then restore the line by hand back to `...fc20685` (do NOT run `git checkout -- .github/workflows/ci.yml` — Step 1's three pins in this file are not committed yet, so that would discard all of them, not just this one-character mutation) and re-run to confirm it's back to all-fresh, all-green.

- [ ] **Step 5: Sanity-check the pin format is one GitHub Actions itself accepts**

This is the same `<image>:<tag>@sha256:<digest>` reference already proven to work in `docker-compose.yml`/`docker-compose.prod.yml`, which `docker pull` resolves identically regardless of caller — no separate local proof needed. CI's `test-unit`, `test-integration`, `test-e2e` and `e2e-flake-repro` jobs each start this exact `services:` postgres container, so a bad reference surfaces immediately and unambiguously as a job-startup failure once this branch's CI runs (verify in Task 5's CI check, not here).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/e2e-flake-repro.yml src/lib/service-image-freshness.test.ts
git commit -m "$(cat <<'EOF'
fix(supply-chain): digest-pin the four GitHub Actions postgres:16-alpine services

Same digest already pinned in docker-compose.yml/docker-compose.prod.yml
(sha256:cf78e7…fc20685), re-resolved live against registry-1.docker.io
on 2026-09-15 and unchanged. Safe to pin now that
check-service-image-freshness.ts (#603) exists to track it — a digest
with no tracking mechanism freezes silently, which is why #562 left
these four lines floating.

Verified: check-service-image-freshness.ts goes from reporting all four
as not-digest-pinned (exit 1) to reporting all four fresh (exit 0), and
a corrupted digest is caught and reported stale (exit 1) before being
restored to green.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire the check into CI

**Files:**
- Modify: `.github/workflows/ci.yml` (the `checks` job, after the "Package manager pin freshness" step)

**Interfaces:**
- Consumes: `pnpm run check-service-image-freshness` (Task 2/3).
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Add the step**

In `.github/workflows/ci.yml`, immediately after the existing step (around line 104):
```yaml
      - name: Package manager pin freshness
        run: pnpm run check-package-manager-freshness
        continue-on-error: true
```
insert:
```yaml

      # Visible but non-blocking, same shape as the package manager pin
      # freshness check above. No Dependabot ecosystem scans a GitHub
      # Actions services: image reference (dependabot-core#5819, open as of
      # 2026-09-15) — this script is the substitute for the Dependabot PR
      # that ecosystem gap can't produce. #603. docs/supply-chain.md has the
      # reasoning and the mutation test that proves it catches a stale pin.
      - name: Service image digest freshness
        run: pnpm run check-service-image-freshness
        continue-on-error: true
```

- [ ] **Step 2: Confirm the workflow file is still valid YAML**

Run: `pnpm exec prettier --check .github/workflows/ci.yml || true` (formatting only — not required to pass, just a quick sanity read) and visually re-read the diff to confirm indentation matches the surrounding steps exactly (2 spaces under `steps:`, `-` aligned with `name:`).

Run: `pnpm run check-service-image-freshness` once more locally to confirm the underlying command the new step invokes still exits 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
feat(supply-chain): wire service image freshness check into CI (non-blocking)

Same continue-on-error: true shape as the package manager pin freshness
step it sits beside — a registry hiccup or a genuinely stale pin must
not redden an unrelated PR.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Document the resolution in docs/supply-chain.md

**Files:**
- Modify: `docs/supply-chain.md` ("The database image" section, and the "Not yet in place" section)

**Interfaces:** None — documentation only.

- [ ] **Step 1: Replace the "not covered, and can't be yet" paragraph**

In the `### The database image` section, replace this paragraph (currently ending "...Tracked as #603, parented to #562."):

```markdown
**The remaining four — the CI workflow `services:` blocks — are not
covered, and can't be yet.** No Dependabot ecosystem scans a GitHub Actions
`services:`/`container:` image reference at all: `github-actions` scans
`uses:` action references only. This is an open upstream gap
([dependabot-core#5819](https://github.com/dependabot/dependabot-core/issues/5819)),
not a configuration mistake in this repo. Digest-pinning those four lines
anyway would trade a visibly-floating tag for an invisibly-stale one — a
pin with no tracking mechanism freezes silently, which is worse, not
better, and is exactly why this file pairs a digest with a Dependabot
entry everywhere else rather than shipping either alone. Tracked as #603,
parented to #562.
```

with:

```markdown
**The remaining four — the CI workflow `services:` blocks — are now
covered a different way.** No Dependabot ecosystem scans a GitHub Actions
`services:`/`container:` image reference at all: `github-actions` scans
`uses:` action references only. This is an open upstream gap
([dependabot-core#5819](https://github.com/dependabot/dependabot-core/issues/5819),
still open as of 2026-09-15) — not a configuration mistake in this repo,
and not one this repo can fix directly. #603 closes it with a script
instead of a Dependabot entry, the same two-part shape used everywhere
else in this file: the four lines
(`.github/workflows/ci.yml:151,234,336`, `.github/workflows/e2e-flake-repro.yml:87`)
are now digest-pinned to the same `sha256:cf78e7…fc20685` the compose
files already carry, and `scripts/check-service-image-freshness.ts`
(`pnpm run check-service-image-freshness`, non-blocking in `checks` —
`ci.yml`) fetches that digest's tag from the registry and reports when
the pin no longer matches — a scripted stand-in for the Dependabot PR
this ecosystem gap can't produce.

All six `postgres:16-alpine` locations are covered now: two by the
`docker-compose` Dependabot ecosystem, four by this script (2 + 4 = 6).

Mutation-tested 2026-09-15: corrupting one pinned digest's last hex
character made the script report that one location stale (exit 1) while
the other three still reported fresh, then restoring it returned all
four to fresh. A reference reverted to a floating tag (no `@sha256:…`
suffix) is reported as "not digest-pinned" and also exits 1 — confirmed
against the real files before this same change pinned them.

Non-blocking for the same reason the package manager pin check above is:
a registry hiccup, or a genuine upstream rebuild of `16-alpine`, is a
reason to look, not a reason to stop an unrelated PR.
```

- [ ] **Step 2: Update the "Not yet in place" section**

Replace:

```markdown
**#562 (the base image and the pnpm binary) is now absorbed** — see
*The base image and the package manager binary* above. Reviewing its own
PR found a third artefact in the same class, `postgres:16-alpine`; four of
its six locations can't be covered by anything in this repo today — see
*The database image*, above, and **#603**.
```

with:

```markdown
**#562 (the base image and the pnpm binary) is now absorbed** — see
*The base image and the package manager binary* above. Reviewing its own
PR found a third artefact in the same class, `postgres:16-alpine`; four of
its six locations had no Dependabot ecosystem able to cover them — see
*The database image*, above.

**#603 (GitHub Actions service-container image tracking) is now
absorbed** — see *The database image* above. Resolved with a script
rather than a Dependabot entry, since no Dependabot ecosystem reaches a
`services:` image reference (dependabot-core#5819, still open).
```

- [ ] **Step 3: Grep for stale cross-references**

Run: `grep -rn "#603" docs/ .github/ src/ scripts/ 2>/dev/null | grep -v node_modules`
Expected: every remaining hit describes #603 as resolved/absorbed, none still say "not covered" or "can't be yet". Fix any that do.

- [ ] **Step 4: Commit**

```bash
git add docs/supply-chain.md
git commit -m "$(cat <<'EOF'
docs(supply-chain): record #603's resolution — service image freshness script

Updates "The database image" and "Not yet in place" to reflect all six
postgres:16-alpine locations now being covered (2 by Dependabot's
docker-compose ecosystem, 4 by the new script), with the mutation-test
results that prove the script catches a stale pin.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## After all tasks: whole-branch review

5 tasks — run one whole-branch review on the most capable model per the `solve-issue` skill, one fix wave, one scoped re-review. Then `pnpm run verify` (full suite — no DB schema change in this branch, but the integration suite still needs the worktree's dev server live per `pnpm run worktree:up`), push, open the PR, run `/pr-review-toolkit:review-pr`, aggregate findings, check CI, fix if needed, rebase-merge.
