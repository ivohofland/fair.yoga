# Lockfile Supply-Chain Policy (#534) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the two supply-chain assertions issue #534 still asks for — every `pnpm-lock.yaml` package resolves from the plain npm registry (no git/tarball/local source), and every resolution carries an integrity hash — plus wire `pnpm audit signatures` in as a blocking CI step, closing out #534's third ask.

**Architecture:** A pure-function parser/checker (`src/lib/lockfile-policy.ts`) reads `pnpm-lock.yaml` as text and flags any package entry that is missing an integrity hash or resolves from a non-registry source. A thin CLI wrapper (`scripts/check-lockfile.ts`) runs it and exits non-zero on any violation. Both new checks (`check-lockfile` and `pnpm audit signatures`) become blocking steps in `ci.yml`'s `checks` job, alongside the existing non-blocking `pnpm audit --audit-level=high`.

**Tech Stack:** TypeScript, no new dependencies — the parser is a line-based scanner over `pnpm-lock.yaml`'s text, matching the existing house style in `src/lib/pnpm-policy.test.ts` (which reads `pnpm-workspace.yaml` the same way, deliberately avoiding a YAML library).

**Spec:** No separate spec doc — issue #534's body and its own two follow-up comments, plus `docs/supply-chain.md`'s "Not yet in place" section (already written by a prior PR, #540, specifically to name this remaining scope), together state the design precisely enough that this plan implements them directly. Read both before starting; the measurements below were re-derived against `origin/main` on 2026-09-10.

## Global Constraints

- No new npm dependencies — parse `pnpm-lock.yaml` with plain string/regex scanning, not a YAML library (matches `src/lib/pnpm-policy.test.ts`'s existing convention for `pnpm-workspace.yaml`).
- `pnpm-lock.yaml` is **two concatenated YAML documents** separated by `^---$` lines (pnpm 12's `packageManagerDependencies` doc, then the real app-graph doc) — the parser must read `packages:` entries from **both**, not just the second. Measured 2026-09-10: doc 1 (lines 1–100) holds **9** entries (`pnpm` itself plus its `@pnpm/exe.*` platform binaries), doc 2 (lines 101–6594) holds **688**. `9 + 688 = 697`, which is exactly what `pnpm audit signatures` reports (`audited 697 packages`) — re-derive both with:
  ```bash
  awk '/^packages:$/{p++} p==1 && /^  [^ ]/{c++} /^snapshots:$/{if(p==1) exit} END{print c+0}' pnpm-lock.yaml   # doc 1
  awk '/^packages:$/{p++} p==2 && /^  [^ ]/{c++} /^snapshots:$/{if(p==2) exit} END{print c+0}' pnpm-lock.yaml   # doc 2
  pnpm audit signatures | head -1
  ```
- A plain-registry package entry's `resolution: {...}` holds only `integrity` (plus, for platform-specific optionals, sibling `cpu`/`os`/`libc` keys **outside** the resolution object — not inside it). A non-registry (git/tarball) entry's `resolution` carries `gitHosted: true`, `integrity`, and `tarball: <url>` — measured 2026-09-10 by actually adding `"pkg": "github:lodash/lodash#4.17.21"` to a scratch project and inspecting the lockfile it produced:
  ```yaml
  lodash@https://codeload.github.com/lodash/lodash/tar.gz/f299b52f39486275a9e6483b60a410e06520c538:
    resolution: {gitHosted: true, integrity: sha512-efBiOJ+8VBM1YBhMBYwxS694ynOHtSIe8zadaogd9mpQ7NZ0m5wtGY1j2N2csRA26uVp7Kfuci1QIPP7HQZLZg==, tarball: https://codeload.github.com/lodash/lodash/tar.gz/f299b52f39486275a9e6483b60a410e06520c538}
  ```
  Note it **does** carry `integrity` — a non-registry source is not the same failure as a missing hash, and the checker must be able to report both independently.
- **Reinterpreted premise, correct it in the PR body too:** the issue's original ask was "pin every `resolved` entry to `registry.npmjs.org`", written against npm's `package-lock.json` format, where every entry carries a literal `resolved: "https://registry.npmjs.org/..."` URL. `pnpm-lock.yaml` v9 has **no such field for a plain registry entry** — the registry is implicit, and the only way an entry can express a *different* source is via the git/tarball/local shapes above. So the check is "no entry uses a non-registry resolution shape", which is the exact structural proxy for "everything is pinned to the plain registry" that this lockfile format allows.
- No `blockExoticSubdeps: true` in this plan. It is a real, pnpm-12-recognized `pnpm-workspace.yaml` setting that blocks a *transitive* dependency from resolving to a git/tarball source (confirmed: adding it does not error on this repo's current lockfile). It was found during this issue's investigation but is out of scope here because (a) issue #534 and its comments never ask for it, (b) it does **not** cover a *direct* exotic dependency added to `package.json` — confirmed by testing (`pnpm install` with a direct `github:` dependency succeeds, exit 0, with the setting on) — so it complements rather than replaces this plan's checker, and (c) proving the *transitive* case fails closed needs a real transitive-exotic dependency to test against, which this session did not construct with enough confidence to ship as a verified security control. File a follow-up issue after this PR merges instead of adding it here.

---

## File Structure

- **Create `src/lib/lockfile-policy.ts`** — pure functions: parse `pnpm-lock.yaml` text into package entries, then classify each entry as compliant or in violation. No I/O, no `fs` import — matches `docs/technical-architecture.md`'s services-are-framework-agnostic pattern applied to a script's logic (same shape `scripts/worktree-setup.ts` already splits into `src/lib/worktree/*`).
- **Create `src/lib/lockfile-policy.test.ts`** — unit tests over the pure functions, using inline lockfile-shaped text fixtures (no dependency on the real committed lockfile, so the tests don't rot as real dependencies change). Picked up automatically by the `unit` vitest project's `src/**/*.test.ts` glob.
- **Create `scripts/check-lockfile.ts`** — thin CLI wrapper: reads `pnpm-lock.yaml` from the repo root, calls the two functions above, prints violations and exits 1, or prints a pass line and exits 0.
- **Modify `package.json`** — add a `check-lockfile` script entry.
- **Modify `.github/workflows/ci.yml`** — two new blocking steps in the `checks` job: `pnpm run check-lockfile`, and `pnpm audit signatures`.
- **Modify `docs/supply-chain.md`** — move #534 out of "Not yet in place", document what is now enforced and how, with measured counts and their re-derivation commands.

---

### Task 1: `src/lib/lockfile-policy.ts` — parser and policy checker

**Files:**
- Create: `src/lib/lockfile-policy.ts`
- Test: `src/lib/lockfile-policy.test.ts`

**Interfaces:**
- Produces: `parsePackageResolutions(lockfileText: string): LockfilePackageEntry[]`, `findLockfileViolations(entries: LockfilePackageEntry[]): LockfileViolation[]`, and the types `LockfilePackageEntry { key: string; resolution: string | null }`, `LockfileViolationReason = 'missing-integrity' | 'non-registry-source' | 'unparseable-entry'`, `LockfileViolation { key: string; reason: LockfileViolationReason }`. Task 2's `scripts/check-lockfile.ts` imports all of these by name.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/lockfile-policy.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { findLockfileViolations, parsePackageResolutions } from './lockfile-policy';

describe('parsePackageResolutions', () => {
  it('returns nothing for text with no packages: section', () => {
    expect(parsePackageResolutions('lockfileVersion: 9.0\n\nimporters:\n  .: {}\n')).toEqual([]);
  });

  it('parses a plain registry entry, unquoting a quoted key', () => {
    const text = [
      'packages:',
      '',
      "  '@prisma/client@6.19.3':",
      '    resolution: {integrity: sha512-mKq3jQFhjvko5LTJFHGilsuQs+W+T3Gm451NzuTDGQxwCzwXHYnIu2zGkRoW+Exq3Rob7yp2MfzSrdIiZVhrBg==}',
      '    engines: {node: \'>=18.18\'}',
      '',
      'snapshots:',
      '',
    ].join('\n');

    expect(parsePackageResolutions(text)).toEqual([
      {
        key: '@prisma/client@6.19.3',
        resolution:
          'integrity: sha512-mKq3jQFhjvko5LTJFHGilsuQs+W+T3Gm451NzuTDGQxwCzwXHYnIu2zGkRoW+Exq3Rob7yp2MfzSrdIiZVhrBg==',
      },
    ]);
  });

  it('parses an unquoted key with an embedded colon (a git tarball URL)', () => {
    const text = [
      'packages:',
      '',
      '  lodash@https://codeload.github.com/lodash/lodash/tar.gz/f299b52f:',
      '    resolution: {gitHosted: true, integrity: sha512-efBiOJ, tarball: https://codeload.github.com/lodash/lodash/tar.gz/f299b52f}',
      '',
    ].join('\n');

    const entries = parsePackageResolutions(text);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe('lodash@https://codeload.github.com/lodash/lodash/tar.gz/f299b52f');
    expect(entries[0]?.resolution).toContain('tarball:');
  });

  it('reads packages: from both documents of a two-document lockfile', () => {
    const text = [
      '---',
      'lockfileVersion: 9.0',
      '',
      'packages:',
      '',
      '  pnpm@12.3.4:',
      '    resolution: {integrity: sha512-aaaa}',
      '    hasBin: true',
      '',
      'snapshots:',
      '',
      '  pnpm@12.3.4: {}',
      '---',
      'lockfileVersion: 9.0',
      '',
      'packages:',
      '',
      '  is-number@6.0.0:',
      '    resolution: {integrity: sha512-bbbb}',
      '',
      'snapshots:',
      '',
      '  is-number@6.0.0: {}',
    ].join('\n');

    expect(parsePackageResolutions(text).map((e) => e.key)).toEqual(['pnpm@12.3.4', 'is-number@6.0.0']);
  });

  it('records a key with no resolution line as an unparseable entry rather than dropping it', () => {
    const text = ['packages:', '', '  weird-entry@1.0.0:', '  another-entry@1.0.0:', '    resolution: {integrity: sha512-cccc}', ''].join(
      '\n',
    );

    expect(parsePackageResolutions(text)).toEqual([
      { key: 'weird-entry@1.0.0', resolution: null },
      { key: 'another-entry@1.0.0', resolution: 'integrity: sha512-cccc' },
    ]);
  });

  it('flushes a trailing pending key with no resolution at end of input', () => {
    const text = ['packages:', '', '  trailing@1.0.0:'].join('\n');
    expect(parsePackageResolutions(text)).toEqual([{ key: 'trailing@1.0.0', resolution: null }]);
  });
});

describe('findLockfileViolations', () => {
  it('reports nothing for a compliant registry entry', () => {
    const entries = [{ key: 'is-number@6.0.0', resolution: 'integrity: sha512-bbbb' }];
    expect(findLockfileViolations(entries)).toEqual([]);
  });

  it('flags a resolution missing integrity', () => {
    const entries = [{ key: 'tampered@1.0.0', resolution: 'cpu: [x64]' }];
    expect(findLockfileViolations(entries)).toEqual([{ key: 'tampered@1.0.0', reason: 'missing-integrity' }]);
  });

  it('flags a tarball-sourced resolution as non-registry, even though it carries integrity', () => {
    const entries = [
      {
        key: 'lodash@https://codeload.github.com/lodash/lodash/tar.gz/x',
        resolution: 'gitHosted: true, integrity: sha512-efBiOJ, tarball: https://codeload.github.com/lodash/lodash/tar.gz/x',
      },
    ];
    expect(findLockfileViolations(entries)).toEqual([
      { key: 'lodash@https://codeload.github.com/lodash/lodash/tar.gz/x', reason: 'non-registry-source' },
    ]);
  });

  it('flags a null resolution as unparseable rather than silently skipping it', () => {
    const entries = [{ key: 'weird-entry@1.0.0', resolution: null }];
    expect(findLockfileViolations(entries)).toEqual([{ key: 'weird-entry@1.0.0', reason: 'unparseable-entry' }]);
  });

  it('reports one violation per bad entry, not just the first', () => {
    const entries = [
      { key: 'ok@1.0.0', resolution: 'integrity: sha512-good' },
      { key: 'bad-one@1.0.0', resolution: 'cpu: [x64]' },
      { key: 'bad-two@1.0.0', resolution: null },
    ];
    expect(findLockfileViolations(entries)).toEqual([
      { key: 'bad-one@1.0.0', reason: 'missing-integrity' },
      { key: 'bad-two@1.0.0', reason: 'unparseable-entry' },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit src/lib/lockfile-policy.test.ts`
Expected: FAIL — `Cannot find module './lockfile-policy'` (the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/lib/lockfile-policy.ts`:

```typescript
/**
 * Pure functions over pnpm-lock.yaml text — no I/O. Enforces #534's two
 * remaining assertions: every package resolves from the plain registry (no
 * git/tarball/local source), and every resolution carries an integrity hash.
 * Rationale, the lockfile's two-document shape, and the measured entry
 * counts: docs/supply-chain.md.
 */

export interface LockfilePackageEntry {
  key: string;
  resolution: string | null;
}

export type LockfileViolationReason = 'missing-integrity' | 'non-registry-source' | 'unparseable-entry';

export interface LockfileViolation {
  key: string;
  reason: LockfileViolationReason;
}

const PACKAGES_HEADER = /^packages:\s*$/;
const TOP_LEVEL_KEY = /^[^\s]/;
const PACKAGE_KEY_LINE = /^ {2}('.*'|[^\s'][^\s]*?):$/;
const RESOLUTION_LINE = /^ {4}resolution: \{(.*)\}$/;

/** The only shapes pnpm's lockfile format uses for a non-registry
 *  resolution — git-hosted (`gitHosted`, `tarball`), a plain tarball URL
 *  (`tarball` alone), or a local workspace/`file:` link (`directory`,
 *  `type`). A plain registry entry's resolution holds only `integrity`
 *  (`cpu`/`os`/`libc` for platform-specific optionals are sibling keys of
 *  `resolution`, not inside it, and never appear here). Measured shape for
 *  a git dependency: docs/supply-chain.md.
 */
const NON_REGISTRY_MARKERS = ['tarball:', 'gitHosted:', 'repo:', 'commit:', 'type:', 'directory:'];

/**
 * Extracts every `packages:` entry's key and inlined `resolution: {...}`
 * content. pnpm 12's lockfile is two concatenated YAML documents (one for
 * packageManagerDependencies, one for the real app graph) — this scans line
 * by line rather than parsing YAML, so it reads both without treating `---`
 * specially: it enters a `packages:` block on that exact top-level line and
 * leaves it on the next top-level (column-0) line, in either document.
 *
 * A key with no `resolution:` line before the next key (or the end of the
 * block) comes back with `resolution: null` rather than being dropped — a
 * parser that silently skips what it can't read would make this policy
 * check quietly stop checking anything if pnpm ever changes this format.
 */
export function parsePackageResolutions(lockfileText: string): LockfilePackageEntry[] {
  const entries: LockfilePackageEntry[] = [];
  let inPackages = false;
  let pendingKey: string | null = null;

  const flushPending = (): void => {
    if (pendingKey !== null) {
      entries.push({ key: pendingKey, resolution: null });
      pendingKey = null;
    }
  };

  for (const line of lockfileText.split('\n')) {
    if (PACKAGES_HEADER.test(line)) {
      flushPending();
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (TOP_LEVEL_KEY.test(line)) {
      flushPending();
      inPackages = false;
      continue;
    }

    const keyMatch = PACKAGE_KEY_LINE.exec(line);
    if (keyMatch) {
      flushPending();
      pendingKey = (keyMatch[1] ?? '').replace(/^'|'$/g, '');
      continue;
    }

    const resolutionMatch = RESOLUTION_LINE.exec(line);
    if (resolutionMatch && pendingKey !== null) {
      entries.push({ key: pendingKey, resolution: resolutionMatch[1] ?? '' });
      pendingKey = null;
    }
  }
  flushPending();

  return entries;
}

function isNonRegistrySource(resolution: string): boolean {
  return NON_REGISTRY_MARKERS.some((marker) => resolution.includes(marker));
}

function hasIntegrity(resolution: string): boolean {
  return /(^|,\s*)integrity:/.test(resolution);
}

/**
 * One violation per bad entry, prioritising `non-registry-source` over
 * `missing-integrity` when both would apply — the source is the more
 * specific diagnosis, and a caller only needs one reason to fail the build
 * and name the package.
 */
export function findLockfileViolations(entries: LockfilePackageEntry[]): LockfileViolation[] {
  const violations: LockfileViolation[] = [];
  for (const entry of entries) {
    if (entry.resolution === null) {
      violations.push({ key: entry.key, reason: 'unparseable-entry' });
      continue;
    }
    if (isNonRegistrySource(entry.resolution)) {
      violations.push({ key: entry.key, reason: 'non-registry-source' });
      continue;
    }
    if (!hasIntegrity(entry.resolution)) {
      violations.push({ key: entry.key, reason: 'missing-integrity' });
    }
  }
  return violations;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit src/lib/lockfile-policy.test.ts`
Expected: PASS, all 12 tests.

- [ ] **Step 5: Mutation-test against the real committed lockfile**

This proves the checker bites on the actual file it will run against, not just the inline fixtures above. Run from the repo root:

```bash
pnpm exec tsx -e '
import { readFileSync } from "node:fs";
import { parsePackageResolutions, findLockfileViolations } from "./src/lib/lockfile-policy";
const text = readFileSync("pnpm-lock.yaml", "utf8");
const entries = parsePackageResolutions(text);
console.log("entries parsed:", entries.length);
console.log("violations on the real lockfile:", findLockfileViolations(entries).length);
'
```

Expected: `entries parsed: 697` (9 + 688, per Global Constraints), `violations on the real lockfile: 0`.

Then mutate a copy to prove a violation is actually caught — do this against a scratch copy, never the committed file:

```bash
cp pnpm-lock.yaml /tmp/mutated-lockfile.yaml
node -e '
const fs = require("fs");
let text = fs.readFileSync("/tmp/mutated-lockfile.yaml", "utf8");
text = text.replace(
  "is-number@6.0.0:\n    resolution: {integrity: sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==}",
  "is-number@6.0.0:\n    resolution: {tarball: https://evil.example/is-number-6.0.0.tgz}"
);
fs.writeFileSync("/tmp/mutated-lockfile.yaml", text);
'
pnpm exec tsx -e '
import { readFileSync } from "node:fs";
import { parsePackageResolutions, findLockfileViolations } from "./src/lib/lockfile-policy";
const text = readFileSync("/tmp/mutated-lockfile.yaml", "utf8");
const violations = findLockfileViolations(parsePackageResolutions(text));
console.log(JSON.stringify(violations));
'
rm /tmp/mutated-lockfile.yaml
```

Expected: the mutated run prints exactly one violation naming `is-number@6.0.0` with reason `non-registry-source` (the mutated entry lost `integrity` too, but `non-registry-source` takes priority per the function's own doc comment above). If `is-number@6.0.0` is not present in the committed lockfile by the time this runs (dependency churn), substitute any other plain-registry entry from `pnpm-lock.yaml` at that time — the point is proving the mutation is caught, not this exact package name.

Record the actual output (entry count and the mutation result) in this task's commit message or the PR body — this is the "prove the guard bites" evidence, not a claim to take on faith.

- [ ] **Step 6: Commit**

```bash
git add src/lib/lockfile-policy.ts src/lib/lockfile-policy.test.ts
git commit -m "$(cat <<'EOF'
feat(supply-chain): add lockfile policy checker for #534

Pure functions parsing pnpm-lock.yaml's two-document format, flagging
any package entry that resolves from a non-registry source (git,
tarball, local) or is missing an integrity hash.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `scripts/check-lockfile.ts` — CLI wrapper, wired into CI

**Files:**
- Create: `scripts/check-lockfile.ts`
- Modify: `package.json` (add `check-lockfile` script)
- Modify: `.github/workflows/ci.yml` (`checks` job)

**Interfaces:**
- Consumes: `parsePackageResolutions`, `findLockfileViolations`, `LockfileViolation` from `src/lib/lockfile-policy.ts` (Task 1).

- [ ] **Step 1: Write the script**

Create `scripts/check-lockfile.ts`:

```typescript
// scripts/check-lockfile.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { findLockfileViolations, parsePackageResolutions } from '../src/lib/lockfile-policy';

const lockfilePath = path.resolve(process.cwd(), 'pnpm-lock.yaml');
const text = readFileSync(lockfilePath, 'utf8');
const entries = parsePackageResolutions(text);
const violations = findLockfileViolations(entries);

if (violations.length > 0) {
  console.error(`pnpm-lock.yaml fails supply-chain policy — ${violations.length} of ${entries.length} entries:`);
  for (const violation of violations) {
    console.error(`  ${violation.key}: ${violation.reason}`);
  }
  process.exit(1);
}

console.log(`✓ pnpm-lock.yaml passes supply-chain policy (${entries.length} entries checked)`);
```

- [ ] **Step 2: Run it against the real lockfile to verify it passes**

Run: `pnpm exec tsx scripts/check-lockfile.ts`
Expected: `✓ pnpm-lock.yaml passes supply-chain policy (697 entries checked)`, exit 0.

- [ ] **Step 3: Add the package.json script**

In `package.json`'s `"scripts"` object, add a line after `"typecheck": "tsc --noEmit",` (matching where the other static-check scripts live):

```json
    "check-lockfile": "tsx scripts/check-lockfile.ts",
```

- [ ] **Step 4: Verify the script alias works**

Run: `pnpm run check-lockfile`
Expected: same output as Step 2, exit 0.

- [ ] **Step 5: Wire it into CI as a blocking step**

In `.github/workflows/ci.yml`, in the `checks` job, add a new step immediately after the existing `Dependency audit` step (the one with `continue-on-error: true`):

```yaml
      # Blocking, unlike the advisory audit above: this reports a property of
      # the packages actually locked (registry source + integrity), not the
      # state of an advisory database, so it cannot go red on a PR that
      # didn't touch dependencies. #534. docs/supply-chain.md has the
      # measurements and the mutation test that proves it catches a bad entry.
      - name: Lockfile supply-chain policy (registry source + integrity)
        run: pnpm run check-lockfile
```

- [ ] **Step 6: Commit**

```bash
git add scripts/check-lockfile.ts package.json .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
feat(supply-chain): wire the lockfile policy check into CI (#534)

Blocking step in the checks job — every package in pnpm-lock.yaml
must resolve from the registry and carry an integrity hash.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `pnpm audit signatures` as a blocking CI step

**Files:**
- Modify: `.github/workflows/ci.yml` (`checks` job)

**Interfaces:** None — this task adds one native `pnpm` command as a workflow step, no new code.

- [ ] **Step 1: Confirm it currently passes**

Run: `pnpm audit signatures`
Expected: `audited 697 packages` / `697 packages have verified registry signatures`, exit 0. (This is pnpm's own subcommand, already measured in `docs/supply-chain.md`; this step is re-confirming it before wiring it in, not re-deriving it from scratch.)

- [ ] **Step 2: Add the CI step**

In `.github/workflows/ci.yml`'s `checks` job, add a new step immediately after the `Lockfile supply-chain policy` step added in Task 2:

```yaml
      # #534's third ask. Unlike the two steps above, this checks the
      # packages actually installed against the registry's own signatures —
      # a property neither the advisory audit nor the lockfile-shape check
      # covers. docs/supply-chain.md has the measurement.
      - name: Verify package registry signatures
        run: pnpm audit signatures
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
feat(supply-chain): block CI on pnpm audit signatures (#534)

The capability already existed and already passed (confirmed in
#540's migration); this was only ever missing the CI wiring.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Update `docs/supply-chain.md`

**Files:**
- Modify: `docs/supply-chain.md`

**Interfaces:** None — documentation only. Depends on Tasks 1–3 being complete, since it cites their actual output.

- [ ] **Step 1: Re-run the measurements this task will cite**

```bash
pnpm run check-lockfile
pnpm audit signatures
```

Record the exact entry count and audited-package count printed — use those numbers, not the ones written elsewhere in this plan, in case dependency churn between writing this plan and executing it changed them.

- [ ] **Step 2: Replace the "Not yet in place" section's #534 paragraph**

Find this text in `docs/supply-chain.md` (in the `## Not yet in place` section):

```markdown
**#534 remains open, scoped to the two of its four asks pnpm does not
cover.** Its install-script half is absorbed and strengthened: `allowBuilds`
+ `strictDepBuilds` is a committed allowlist that errors on every machine, not
only in CI, which is more than #534 originally asked for. What is still
missing: pinning every `resolved` entry to `registry.npmjs.org`, and checking
every resolved entry carries an `integrity` hash.

**Signature verification is available and passes — it is a CI step away.**
`pnpm audit` takes exactly one subcommand, and it is this one: *"The only
supported subcommand is `signatures`, which verifies registry signatures for
the installed packages"* (`pnpm audit --help`). Measured 2026-09-10 against
the committed lockfile:

```bash
pnpm audit signatures
```

`audited 697 packages` / `697 packages have verified registry signatures`,
**exit 0**. So #534's third ask needs a workflow step, not a replacement
tool — and unlike `pnpm audit --audit-level=high` next to it, this one
reports a property of the packages actually installed rather than the state
of an advisory database, so it can block without stopping unrelated pull
requests. Adding that step belongs to #534; this migration establishes only
that the control exists and that the tree passes it today.
```

Replace it with (fill in `<N>` with Step 1's actual entry count if it differs from 697):

```markdown
**#534 is now fully enforced.** `src/lib/lockfile-policy.ts` parses
`pnpm-lock.yaml`'s two concatenated YAML documents (see *The two-document
lockfile, and why Dependabot still reads it*, above) and flags any package
whose resolution is missing
`integrity` or carries a git/tarball/local-source marker instead of a plain
registry one. `scripts/check-lockfile.ts` runs it as `pnpm run
check-lockfile`, a blocking step in `ci.yml`'s `checks` job. The install-script
half was already absorbed and strengthened by the pnpm migration:
`allowBuilds` + `strictDepBuilds` is a committed allowlist that errors on
every machine, not only in CI.

**Why "pin to `registry.npmjs.org`" became "reject a non-registry resolution
shape".** The issue's original ask was written against npm's
`package-lock.json`, where every entry carries a literal `resolved:
"https://registry.npmjs.org/..."` URL. `pnpm-lock.yaml` v9 has no such field
for a plain registry entry — the registry is implicit, and the only way an
entry can name a *different* source is via a `gitHosted`/`tarball`/`repo`/
`directory` marker in its `resolution` block (measured by adding a
`github:`-sourced dependency to a scratch project and reading what pnpm wrote
for it — see `src/lib/lockfile-policy.ts`'s docblock). Banning every such
marker is the exact structural proxy this lockfile format allows for "pinned
to the registry".

Measured 2026-09-10 against the committed lockfile: **<N> entries** (9 in the
`packageManagerDependencies` document, 688 in the app-graph document — the
same 697 total `pnpm audit signatures` reports), **zero violations**.
Re-derive with `pnpm run check-lockfile`. The checker was mutation-tested
against a copy of the lockfile with one entry's resolution replaced by a
`tarball:` pointing off-registry — confirmed caught, reported as
`non-registry-source` naming the mutated package.

**Signature verification is now a blocking CI step, not just an available
capability.** `pnpm audit signatures` runs in `ci.yml`'s `checks` job.
Measured 2026-09-10: `audited <N> packages` / `<N> packages have verified
registry signatures`, exit 0 — same count as above, since it audits every
installed package. Unlike `pnpm audit --audit-level=high` next to it, this
reports a property of the packages actually locked rather than the state of
an advisory database, so it blocks without going red on a PR that didn't
touch dependencies.

**Not carried over from this investigation: `blockExoticSubdeps`.** pnpm 12
recognises this `pnpm-workspace.yaml` setting and it blocks a *transitive*
dependency from resolving to a git/tarball source — confirmed it does not
error against this repo's current lockfile. It was found while researching
this issue but left out here: it only covers the transitive case (a direct
`github:`-sourced dependency in `package.json` still installs cleanly with it
on, confirmed by testing), so it would complement rather than replace the
check above, and this investigation did not construct a real transitive-exotic
dependency to confirm it fails closed. Worth a follow-up issue, not a line
added on unverified faith.
```

The cross-reference above points at the existing bolded lead-in **"The
two-document lockfile, and why Dependabot still reads it"** inside the `##
What pnpm enforces that nothing did before` section of this same file —
confirm that heading text hasn't drifted before pasting; if it has, point at
whatever it now reads.

- [ ] **Step 3: Check for other stale references to #534 in this file**

```bash
grep -n "534" docs/supply-chain.md
```

Every remaining hit should describe #534 as resolved/enforced, not open. Fix any that still read as open work.

- [ ] **Step 4: Commit**

```bash
git add docs/supply-chain.md
git commit -m "$(cat <<'EOF'
docs(supply-chain): record #534 as enforced, not open work

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## After all tasks: whole-branch review

This plan has 4 tasks, so per the solve-issue skill, run one whole-branch review after all four are done, before pushing. Give the reviewer:
- The diff across all 4 commits.
- This plan's Global Constraints section (the two-document lockfile shape, the reinterpreted "registry pinning" premise, and the deliberate exclusion of `blockExoticSubdeps`) so it isn't re-litigated as a finding.
- A specific instruction to check: does `findLockfileViolations`'s priority order (non-registry-source over missing-integrity) ever hide a real problem from the printed output? Does the CI step order (check-lockfile, then audit signatures) matter? Does `docs/supply-chain.md`'s edit leave any other file's #534 reference stale (the issue itself will need a closing comment, but that happens at merge time per the skill, not in this doc edit).

Fix findings in one wave, one scoped re-review, then push and open the PR.
