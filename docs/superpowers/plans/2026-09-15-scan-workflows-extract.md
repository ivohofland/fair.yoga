# scanWorkflows Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #609 — `scanWorkflows`, the third piece of `scripts/check-service-image-freshness.ts`'s orchestration logic (alongside the auth+manifest fetch extracted to `src/lib/service-image-registry.ts` and the per-group freshness loop extracted to `src/lib/service-image-check.ts`, both by #608), is neither exported nor tested. Its only existing coverage — `service-image-freshness.test.ts`'s "parses every image: reference..." test — re-implements the scan loop (`readdirSync` + `extractImageReferences` + `parseImagePin`) instead of calling the real function, so it can silently pass against its own copy of the old logic while `scanWorkflows` itself diverges untested. Extract it, export it, wire the script to call it, and replace the duplicated test logic with a direct call.

**Architecture:** Same script/lib split #608 already established for this exact script's other two orchestration pieces: pure/testable logic lives in `src/lib`, the script under `scripts/` is a thin orchestrator that imports it. `scanWorkflows` does real I/O (`readFileSync`, `readdirSync`) — it cannot join `service-image-freshness.ts`, whose docblock promises "no I/O" — so it moves to a new sibling file, `src/lib/service-image-scan.ts`, mirroring `service-image-registry.ts` (the other I/O-doing sibling in this family). It imports the pure helpers (`extractImageReferences`, `countImageKeyLines`, `parseImagePin`, `type ImagePin`) from `service-image-freshness.ts` exactly as the script currently does.

**Premise verified:** Read `scripts/check-service-image-freshness.ts` (108 lines) and `src/lib/service-image-freshness.test.ts` (198 lines) directly. `scanWorkflows` (lines 30-52 of the script) is a private, unexported function; the "parses every image: reference..." test (line ~126) independently calls `readdirSync` + `extractImageReferences` + `parseImagePin` in its own loop and never touches `scanWorkflows`, confirming the issue's premise exactly as stated — including that this duplicate loop cannot see `scanWorkflows`'s `coverageGaps`/`unparsed` branches, which currently have zero test coverage of any kind (direct or duplicated).

**Tech Stack:** TypeScript (`strict: true`, no `any`), vitest (`unit` project), no new dependencies.

**Spec:** None — classified "bounded" during premise verification: single reasonable design (mirrors #608's already-applied script/lib split for this same script's other two pieces), no data-model/auth/money involved, zero behavior change. Presented and approved via this session's explicit no-interaction instruction. Issue: #609 (parent #608, #603, #562).

## Global Constraints

- TypeScript `strict: true` everywhere touched — no `any`, no implicit types.
- **Zero behavior change.** `scanWorkflows`'s logic (the file loop, the `coverageGaps` check, the pin/unparsed split) moves verbatim — same `pins`/`unparsed`/`coverageGaps` shape, same skip/error semantics, same `WORKFLOWS_DIR` value (`.github/workflows`).
- New test file lands at `src/lib/service-image-scan.test.ts`, which the `unit` vitest project already globs (`src/**/*.test.ts`, per `vitest.config.ts`) — no config change needed.
- Run `pnpm run verify` before pushing (needs the app live — see the `verify` skill). This branch has no UI surface, so no manual browser check is needed.

---

### Task 1: Extract `scanWorkflows` into `src/lib/service-image-scan.ts`, test it directly, wire the script

**Files:**
- Create: `src/lib/service-image-scan.ts`
- Create: `src/lib/service-image-scan.test.ts`
- Modify: `src/lib/service-image-freshness.test.ts` (remove the duplicated scan loop from the "parses every image: reference..." test)
- Modify: `scripts/check-service-image-freshness.ts` (delete the inline `scanWorkflows` + its three local interfaces + `WORKFLOWS_DIR`; import and call the extracted version instead)

**Interfaces:**
- Produces (used by the script and the new test file):
  ```ts
  export const WORKFLOWS_DIR = '.github/workflows';

  export interface LocatedPin extends ImagePin {
    readonly file: string;
  }

  export interface LocatedUnparsed {
    readonly file: string;
    readonly reference: string;
  }

  export interface CoverageGap {
    readonly file: string;
    readonly imageKeyLines: number;
    readonly referencesFound: number;
  }

  export function scanWorkflows(
    root: string,
  ): { pins: LocatedPin[]; unparsed: LocatedUnparsed[]; coverageGaps: CoverageGap[] }
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/service-image-scan.test.ts`:

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractImageReferences, parseImagePin } from './service-image-freshness';
import { scanWorkflows } from './service-image-scan';

const root = process.cwd();

// Builds a throwaway `<root>/.github/workflows/` directory so scanWorkflows's
// three branches (coverageGaps, unparsed, pins) can each be exercised without
// touching this repo's real workflow files. Callers must rmSync the returned
// root in a finally block.
function makeWorkflowsFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'scan-workflows-'));
  const workflowsDir = join(dir, '.github', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(workflowsDir, name), contents);
  }
  return dir;
}

describe('scanWorkflows', () => {
  it('collects a digest-pinned reference into pins, tagged with its file', () => {
    const digest = 'a'.repeat(64);
    const fixtureRoot = makeWorkflowsFixture({
      'ci.yml': `services:\n  postgres:\n    image: postgres:16-alpine@sha256:${digest}\n`,
    });
    try {
      const { pins, unparsed, coverageGaps } = scanWorkflows(fixtureRoot);
      expect(pins).toEqual([{ image: 'postgres', tag: '16-alpine', digest: `sha256:${digest}`, file: 'ci.yml' }]);
      expect(unparsed).toEqual([]);
      expect(coverageGaps).toEqual([]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('collects a non-digest-pinned reference into unparsed, tagged with its file and the raw reference', () => {
    const fixtureRoot = makeWorkflowsFixture({
      'ci.yml': 'services:\n  postgres:\n    image: postgres:16-alpine\n',
    });
    try {
      const { pins, unparsed, coverageGaps } = scanWorkflows(fixtureRoot);
      expect(pins).toEqual([]);
      expect(unparsed).toEqual([{ file: 'ci.yml', reference: 'postgres:16-alpine' }]);
      expect(coverageGaps).toEqual([]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('reports a coverage gap when an image: key line yields no extracted reference (e.g. an indented continuation line)', () => {
    const fixtureRoot = makeWorkflowsFixture({
      'ci.yml': 'services:\n  postgres:\n    image:\n      postgres:16-alpine\n',
    });
    try {
      const { pins, unparsed, coverageGaps } = scanWorkflows(fixtureRoot);
      expect(pins).toEqual([]);
      expect(unparsed).toEqual([]);
      expect(coverageGaps).toEqual([{ file: 'ci.yml', imageKeyLines: 1, referencesFound: 0 }]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('scans every .yml/.yaml file in the directory, ignoring other extensions', () => {
    const digest = 'b'.repeat(64);
    const fixtureRoot = makeWorkflowsFixture({
      'a.yml': `image: x:1@sha256:${digest}\n`,
      'b.yaml': `image: y:2@sha256:${digest}\n`,
      'README.md': 'image: z:3@sha256:' + digest + '\n',
    });
    try {
      const { pins } = scanWorkflows(fixtureRoot);
      expect(pins.map((p) => p.file).sort()).toEqual(['a.yml', 'b.yaml']);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  // Tethered to the real artifacts, the way parsePackageManagerPin's test
  // reads package.json directly — if #603's digest pins are ever hand-edited
  // back to a floating tag, this fails immediately instead of the check
  // going quietly inert. Replaces service-image-freshness.test.ts's former
  // inline re-implementation of this same scan (#609): calls the real
  // scanWorkflows instead of readdirSync + extractImageReferences +
  // parseImagePin duplicated in the test.
  it("parses every image: reference this repo currently ships under .github/workflows, all matching docker-compose.yml's pinned digest", () => {
    const { pins, unparsed, coverageGaps } = scanWorkflows(root);
    expect(coverageGaps).toEqual([]);
    expect(unparsed).toEqual([]);
    expect(pins.length).toBeGreaterThanOrEqual(4);

    const composeContent = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
    const composePin = extractImageReferences(composeContent).map(parseImagePin).find((pin) => pin !== null);
    expect(composePin).not.toBeNull();

    for (const pin of pins) {
      expect(pin.digest).toBe(composePin?.digest);
    }
  });

  it('the fixture helper itself only ever writes files scanWorkflows can see, sanity-checked against a real readdirSync', () => {
    const fixtureRoot = makeWorkflowsFixture({ 'x.yml': 'image: a:1\n' });
    try {
      const workflowsDir = join(fixtureRoot, '.github', 'workflows');
      expect(readdirSync(workflowsDir)).toEqual(['x.yml']);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
```

Note: the last test ("the fixture helper itself...") is a throwaway sanity check on the fixture helper, not on `scanWorkflows` — drop it if it feels redundant once the other five are green; it exists only to catch a broken fixture helper producing false negatives in the others.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run --project unit src/lib/service-image-scan.test.ts`
Expected: FAIL — `./service-image-scan` has no exported member `scanWorkflows` (module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/lib/service-image-scan.ts`:

```ts
/**
 * Scans `.github/workflows/*.yml` for image: references and classifies
 * each into a digest-pinned pin, an unparseable reference, or a coverage
 * gap (an `image:` key line that yielded no reference at all — e.g. an
 * indented continuation line `extractImageReferences` can't see). Does
 * real file I/O, which is why it lives apart from the pure parse/compare
 * functions in `service-image-freshness.ts`. The networked half of this
 * script's orchestration lives in `service-image-registry.ts`; the
 * per-group freshness loop in `service-image-check.ts`. See
 * docs/supply-chain.md ("The database image").
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { countImageKeyLines, extractImageReferences, parseImagePin, type ImagePin } from './service-image-freshness';

export const WORKFLOWS_DIR = '.github/workflows';

export interface LocatedPin extends ImagePin {
  readonly file: string;
}

export interface LocatedUnparsed {
  readonly file: string;
  readonly reference: string;
}

export interface CoverageGap {
  readonly file: string;
  readonly imageKeyLines: number;
  readonly referencesFound: number;
}

export function scanWorkflows(
  root: string,
): { pins: LocatedPin[]; unparsed: LocatedUnparsed[]; coverageGaps: CoverageGap[] } {
  const dir = path.join(root, WORKFLOWS_DIR);
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const pins: LocatedPin[] = [];
  const unparsed: LocatedUnparsed[] = [];
  const coverageGaps: CoverageGap[] = [];
  for (const file of files) {
    const contents = readFileSync(path.join(dir, file), 'utf8');
    const references = extractImageReferences(contents);
    const imageKeyLines = countImageKeyLines(contents);
    if (imageKeyLines !== references.length) {
      coverageGaps.push({ file, imageKeyLines, referencesFound: references.length });
    }
    for (const reference of references) {
      const pin = parseImagePin(reference);
      if (pin) {
        pins.push({ ...pin, file });
      } else {
        unparsed.push({ file, reference });
      }
    }
  }
  return { pins, unparsed, coverageGaps };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run --project unit src/lib/service-image-scan.test.ts`
Expected: PASS — all tests in the new file.

- [ ] **Step 5: Wire the script to use the extracted function**

In `scripts/check-service-image-freshness.ts`:

Replace the import block:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  countImageKeyLines,
  extractImageReferences,
  groupByImageTag,
  parseImagePin,
  type ImagePin,
} from '../src/lib/service-image-freshness';
import { fetchLatestDigest } from '../src/lib/service-image-registry';
import { checkGroups } from '../src/lib/service-image-check';

const WORKFLOWS_DIR = '.github/workflows';

interface LocatedPin extends ImagePin {
  readonly file: string;
}

interface LocatedUnparsed {
  readonly file: string;
  readonly reference: string;
}

interface CoverageGap {
  readonly file: string;
  readonly imageKeyLines: number;
  readonly referencesFound: number;
}

function scanWorkflows(
  root: string,
): { pins: LocatedPin[]; unparsed: LocatedUnparsed[]; coverageGaps: CoverageGap[] } {
  const dir = path.join(root, WORKFLOWS_DIR);
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const pins: LocatedPin[] = [];
  const unparsed: LocatedUnparsed[] = [];
  const coverageGaps: CoverageGap[] = [];
  for (const file of files) {
    const contents = readFileSync(path.join(dir, file), 'utf8');
    const references = extractImageReferences(contents);
    const imageKeyLines = countImageKeyLines(contents);
    if (imageKeyLines !== references.length) {
      coverageGaps.push({ file, imageKeyLines, referencesFound: references.length });
    }
    for (const reference of references) {
      const pin = parseImagePin(reference);
      if (pin) {
        pins.push({ ...pin, file });
      } else {
        unparsed.push({ file, reference });
      }
    }
  }
  return { pins, unparsed, coverageGaps };
}
```

with:

```ts
import { groupByImageTag } from '../src/lib/service-image-freshness';
import { fetchLatestDigest } from '../src/lib/service-image-registry';
import { checkGroups } from '../src/lib/service-image-check';
import { WORKFLOWS_DIR, scanWorkflows } from '../src/lib/service-image-scan';
```

Everything else in the script — `main()`'s body, the `coverageGaps`/`unparsed`/`pins` handling, the `WORKFLOWS_DIR` reference in the "nothing to check" message, `main().catch` — is unchanged; `scanWorkflows(root)` at the top of `main()` now calls the imported function instead of the local one.

- [ ] **Step 6: Remove the duplicated scan loop from `service-image-freshness.test.ts`**

Delete the "parses every image: reference..." test (the one starting `it("parses every image: reference this repo currently ships under .github/workflows..."`, using `readdirSync`/`readFileSync`/`path` and asserting against `docker-compose.yml`) from `src/lib/service-image-freshness.test.ts` — its replacement now lives in `src/lib/service-image-scan.test.ts` (Step 1), calling the real `scanWorkflows` instead of re-implementing its loop.

If `readdirSync`, `readFileSync`, or `path` become unused imports in `service-image-freshness.test.ts` once this test is removed, delete those imports too — check the rest of the file before removing any of the three, since other tests in it may still use them.

- [ ] **Step 7: Run the full affected test suite**

Run: `pnpm exec vitest run --project unit src/lib/service-image-scan.test.ts src/lib/service-image-freshness.test.ts src/lib/service-image-check.test.ts src/lib/service-image-registry.test.ts`
Expected: PASS — every test in all four files, including the ones untouched by this task.

- [ ] **Step 8: Sanity-check the script still runs end-to-end**

Run: `pnpm exec tsx scripts/check-service-image-freshness.ts`
Expected: exits 0 (or reports pre-existing registry-unreachable warnings if the sandbox has no network access to Docker Hub — that is pre-existing `checkGroups` behavior, unrelated to this task; it must NOT report a coverage gap or an unparsed reference for this repo's real `.github/workflows` files, since none existed before this change).

- [ ] **Step 9: Commit**

Commit message: `test(supply-chain): extract and test scanWorkflows (#609)`
