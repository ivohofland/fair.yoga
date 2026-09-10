# pnpm Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace npm with pnpm as this repo's only package manager, turning
#531's cooldown (#533) and install-script allowlist (part of #534) from
unbuilt machinery into enforced defaults.

**Architecture:** `pnpm-workspace.yaml` carries the supply-chain policy;
`packageManager` in `package.json` pins pnpm 12.3.4 with an integrity hash
that corepack verifies; every install path — Dockerfile, five CI jobs, the
worktree bootstrap script — runs `pnpm install --frozen-lockfile`. A ported
`script-install-census.test.ts` fails the build if imperative code ever runs
an install that resolves instead.

**Tech Stack:** pnpm 12.3.4, corepack (bundled with Node 22/24),
GitHub Actions, Docker (`node:22-alpine`), Vitest, TypeScript.

**Spec:** `docs/superpowers/specs/2026-09-10-pnpm-migration-design.md` — read
it first. It records what was measured, three corrected claims, and why each
approach was chosen over its alternatives.

## Global Constraints

- **pnpm version is exactly `12.3.4`.** Never `latest`, never 11.x, never
  12.4.0 (published but not the `latest` dist-tag).
- **`packageManager` must carry the integrity hash**, written by
  `corepack use pnpm@12.3.4` and never typed by hand.
- **`minimumReleaseAge: 10080`** (seven days, in minutes).
- **Dependabot `cooldown.default-days: 8`** — deliberately one day more than
  pnpm's window.
- **The lockfile-exact install command is `pnpm install --frozen-lockfile`,
  written in full every time.** Never a bare `pnpm install` in committed
  code, config, docs or CI, even though pnpm defaults the flag to true when
  `CI` is set. One command with two behaviours depending on the environment
  is the failure this migration exists to remove.
- **`npx <tool>` becomes `pnpm exec <tool>`; `npm run <s>` becomes
  `pnpm run <s>`; `npm test` becomes `pnpm test`; `npm ci` becomes
  `pnpm install --frozen-lockfile`.**
- **`docs/superpowers/plans/` and `docs/superpowers/specs/` are never
  rewritten** — historical records. This file and the spec are the sole
  exceptions, because they describe the post-migration world.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths
  containing parentheses.
- **Never edit an applied migration** — comment-only edits included. No
  migration is touched by this plan at all.
- The `allowBuilds` set is these six, and no others:
  `@prisma/client`, `@prisma/engines`, `esbuild`, `fsevents`, `prisma`,
  `unrs-resolver`.

## Where this runs, and the one-time setup

**This work happens in the main checkout at
`/Users/ivohofland/Projects/fair.yoga`, with the maintainer's explicit
authorisation to stop the dev server on `:3000`.** That is deliberate and it
is what makes local verification honest: nothing above the checkout has a
`node_modules`, so a phantom import fails locally exactly as it does in
Docker. A worktree would reintroduce the spike's false green.

Task 1 stops the dev server. Nothing restarts it until Task 6.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `pnpm-workspace.yaml` | create | The supply-chain policy: release-age window and build-script allowlist |
| `pnpm-lock.yaml` | create | Resolved tree, imported from `package-lock.json` so nothing re-resolves |
| `package-lock.json` | **delete** | Replaced |
| `package.json` | modify | `packageManager` pin, two phantom deps declared, scripts re-spelled |
| `.github/dependabot.yml` | modify | Cooldown aligned with `minimumReleaseAge` |
| `src/lib/script-install-census.test.ts` | modify | The guard — real logic, ported not renamed |
| `scripts/worktree-setup.ts` | modify | The one install in imperative code |
| `src/lib/worktree/dev-server.ts` + `.test.ts` | modify | Spawns the worktree dev server; uncounted by #540's census |
| `Dockerfile` | modify | corepack bootstrap; both install/exec paths |
| `.github/workflows/ci.yml` | modify | Five jobs' bootstrap, install, tool invocations, cache keys |
| `.github/workflows/e2e-flake-repro.yml` | modify | Same, one job |
| `playwright.config.ts`, `src/lib/db-provision.ts`, `scripts/worktree-up.ts` | modify | Executed commands and the messages that instruct a human |
| `docs/supply-chain.md` | rewrite | The rule, both censuses re-measured, what pnpm now enforces |
| 24 further files | modify | Instructional prose — see Task 5 |

## Task order is load-bearing

Task 1 must be first: nothing else can run `pnpm` until `packageManager` and
the lockfile exist. Task 2 before Task 3, because Task 2's guard is what
proves Task 3's `worktree-setup.ts` change is correct rather than merely
plausible. Task 4 needs a working pnpm install to re-measure the advisory
census. Task 5 is last among the edits because it is broad and mechanical,
and must not be allowed to mask a bucket-A regression.

---

### Task 1: Bootstrap pnpm and land the supply-chain policy

**Files:**
- Create: `pnpm-workspace.yaml`, `pnpm-lock.yaml`
- Delete: `package-lock.json`
- Modify: `package.json`, `.github/dependabot.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `pnpm` on PATH at 12.3.4; `pnpm install
  --frozen-lockfile` exits 0; every later task may assume `pnpm exec <tool>`
  resolves this repo's devDependencies.

- [ ] **Step 1: Stop the dev server on :3000**

The maintainer authorised this explicitly for this task. Confirm what is
there before killing it, so the PID in the record is the right one.

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
kill "$(lsof -nP -iTCP:3000 -sTCP:LISTEN -t)"
sleep 2 && lsof -nP -iTCP:3000 -sTCP:LISTEN || echo ":3000 is free"
```

- [ ] **Step 2: Enable corepack and stamp the pinned version**

`corepack use` writes `packageManager` **with the integrity hash** and then
runs an install. That install resolves fresh from `package.json` ranges and
its lockfile is discarded by Step 3 — that is expected, not a mistake.

```bash
corepack enable
corepack use pnpm@12.3.4
node -p "require('./package.json').packageManager"
```

Expected: `pnpm@12.3.4+sha512.<128 hex chars>`. If no `+sha512.` segment
appears, stop — the hash is the control this pin exists for.

- [ ] **Step 3: Import the resolved tree from package-lock.json**

This inherits npm's resolution rather than re-resolving, so the migration
changes the package manager and not the dependency versions.

```bash
pnpm import
head -3 pnpm-lock.yaml
```

Expected: `lockfileVersion: '9.0'` — the format Dependabot reads. Any other
value, stop and report it.

- [ ] **Step 4: Create `pnpm-workspace.yaml`**

Create the file with exactly this content. `allowBuilds` is a **map of
booleans**; a YAML list is coerced to `{'0': …}`, matches nothing, and is
ignored (it fails closed, so builds are blocked and the install exits 1 —
the safe direction, but not the intended one).

```yaml
# This repo's supply-chain policy. pnpm reads these settings HERE AND
# NOWHERE ELSE: in `.npmrc` (kebab or camel case) or under package.json's
# `pnpm` key they are silently ignored. A mistyped key in this file is one
# step better — pnpm 12 prints a [WARN] naming it — but still exits 0 with
# the control off, so neither mistake fails a build.
#
# Rationale, the measured behaviour of both settings, and the mutation tests
# that prove them live: docs/supply-chain.md.

# Seven days, in minutes. Verified at lockfile-check time, not download time.
minimumReleaseAge: 10080

# Dependencies permitted to run install scripts. `strictDepBuilds` defaults
# to true, so anything reaching this repo with a build script and no entry
# here ERRORS the install — on a contributor's laptop, not only in CI.
# Re-derive the set with the command in docs/supply-chain.md.
allowBuilds:
  '@prisma/client': true
  '@prisma/engines': true
  esbuild: true
  fsevents: true
  prisma: true
  unrs-resolver: true
```

- [ ] **Step 5: Declare the two phantom dependencies**

npm's flat `node_modules` hoisted these; pnpm's isolated layout will not, and
the Docker build fails without them. Add to `devDependencies` in
`package.json`, keeping the existing alphabetical order:

- `"dotenv": "^16.6.1"` — imported by `playwright.config.ts:2`
- `"vite": "^8.1.5"` — `loadEnv` imported by `vitest.config.ts:2`,
  `tests/setup/unit-db.ts:28`, `scripts/worktree-up.ts:3`

Those versions are what the current flat npm tree resolves; re-derive with
`node -p "require('./node_modules/vite/package.json').version"` before the
tree is replaced.

- [ ] **Step 6: Install, then drop the npm lockfile**

```bash
pnpm install
rm package-lock.json
pnpm install --frozen-lockfile
echo "frozen install exit: $?"
```

Expected: exit `0`. A non-zero exit here means `package.json` and
`pnpm-lock.yaml` disagree — re-run plain `pnpm install` and inspect the diff
rather than passing `--no-frozen-lockfile`.

- [ ] **Step 7: MUTATION 1 — prove `allowBuilds` bites**

A configuration that parses is not a configuration that is enforced. Break
it, record the exact text, restore, re-verify. The build scripts only run on
a fresh tree, so `node_modules` must go.

```bash
cp pnpm-workspace.yaml /tmp/ws.bak
sed -i '' '/^  esbuild: true$/d' pnpm-workspace.yaml
rm -rf node_modules
pnpm install --frozen-lockfile; echo "MUTATED exit: $?"
```

Expected: exit `1`, with

```
Error: ERR_PNPM_IGNORED_BUILDS
  × installing dependencies
  ╰─▶ Ignored build scripts: esbuild@<version>
```

Restore and re-verify:

```bash
cp /tmp/ws.bak pnpm-workspace.yaml && rm -rf node_modules
pnpm install --frozen-lockfile; echo "RESTORED exit: $?"
```

Expected: exit `0`. Record both exit codes and the error text — they go in
the PR body.

- [ ] **Step 8: MUTATION 2 — prove the `packageManager` hash bites**

**This must run against a cold corepack cache.** Run warm it passes while
proving nothing: corepack only verifies the hash when it actually downloads.
The cache lives at `~/.cache/node/corepack` on this machine, *not* the macOS
`~/Library/Caches` path — so isolate it with `COREPACK_HOME` rather than
deleting the real one.

```bash
cp package.json /tmp/pkg.bak
export COREPACK_HOME=/tmp/corepack-mutation COREPACK_ENABLE_DOWNLOAD_PROMPT=0
rm -rf "$COREPACK_HOME"
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));
 p.packageManager=p.packageManager.replace(/\+sha512\.(.)/,(m,c)=>"+sha512."+(c==="a"?"b":"a"));
 fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n");'
corepack pnpm --version; echo "TAMPERED exit: $?"
```

Expected: non-zero exit, with `Mismatch hashes. Expected <hash>, got <actualHash>`.

```bash
cp /tmp/pkg.bak package.json && rm -rf "$COREPACK_HOME"
corepack pnpm --version; echo "RESTORED exit: $?"
unset COREPACK_HOME COREPACK_ENABLE_DOWNLOAD_PROMPT
```

Expected: `12.3.4`, exit `0`. **Check `git diff package.json` is empty
afterwards** — the mutation rewrites the file with `JSON.stringify`, and the
restore must undo the formatting too.

- [ ] **Step 9: Align Dependabot with the pnpm window**

Without this, Dependabot PRs fail CI with
`[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION]` — reproduced during the spike at
17 lockfile entries. Add to the **npm** ecosystem block in
`.github/dependabot.yml` (that is the ecosystem that reads `pnpm-lock.yaml`;
do not invent a `pnpm` one):

```yaml
    # pnpm refuses a lockfile entry younger than `minimumReleaseAge`
    # (pnpm-workspace.yaml, 10080 minutes = 7 days) and CI installs with
    # --frozen-lockfile, so a PR proposing a fresher version fails the merge
    # gate. Eight days, not seven: pnpm counts minutes from publish, this
    # counts days at PR-creation time, and two clocks computing "7 days"
    # eventually disagree at the boundary. The cost of the margin is one
    # extra day of staleness; the cost of the boundary is a red PR.
    cooldown:
      default-days: 8
```

- [ ] **Step 10: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml package.json .github/dependabot.yml
git rm --cached package-lock.json
git commit -m "$(cat <<'MSG'
build(pnpm): pin pnpm 12.3.4 and land the supply-chain policy

Imports the resolved tree from package-lock.json rather than re-resolving,
so this changes the package manager and not a single dependency version.

Declares dotenv and vite, two phantom dependencies npm's flat node_modules
was hoisting: playwright.config.ts imports the first, and vitest.config.ts,
tests/setup/unit-db.ts and scripts/worktree-up.ts import loadEnv from the
second. pnpm's isolated layout makes an undeclared import fail.

Both new controls are mutation-tested, not merely configured:
dropping esbuild from allowBuilds gives ERR_PNPM_IGNORED_BUILDS exit 1, and
flipping one hex digit of the packageManager hash against a cold
COREPACK_HOME gives "Mismatch hashes" exit 1.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: Port the install-census guard

**Files:**
- Modify: `src/lib/script-install-census.test.ts`
- Modify: `scripts/worktree-setup.ts:47-52`

**Interfaces:**
- Consumes: a working `pnpm` from Task 1.
- Produces: `isLockfileInstall(command: string): boolean` replacing the
  `LOCKFILE_INSTALL` regex constant; `installInvocationsIn(file: string,
  text: string): Invocation[]` keeps its exported signature unchanged.

This is the one piece of real logic in the migration. **`npm ci` is a
subcommand; `pnpm install --frozen-lockfile` is a flag.** An anchored prefix
match cannot express the second, so the predicate changes shape, not just
spelling.

- [ ] **Step 1: Write the failing tests**

In `src/lib/script-install-census.test.ts`, replace the constants:

```ts
/**
 * The install-family spellings this guard recognises — NOT pnpm's full alias
 * set. pnpm's namespace has no type to tether a roster against, so this is a
 * floor rather than a census: it covers what a contributor plausibly writes.
 */
const INSTALL_FAMILY = ['install', 'i', 'add', 'update', 'up', 'import'] as const;

const INSTALL_COMMAND = new RegExp(`^pnpm\\s+(?:${INSTALL_FAMILY.join('|')})\\b`);

/**
 * pnpm's lockfile-exact install is `pnpm install --frozen-lockfile` — a
 * FLAG, not a subcommand, so unlike `npm ci` no anchored prefix can express
 * it. Both halves are required: the install family at the front, and the
 * flag somewhere after it.
 *
 * THE FLAG IS DEMANDED EXPLICITLY even though pnpm turns it on by default
 * when `CI` is set. Leaning on that default would leave one command frozen
 * on a runner and reconciling on a laptop — the same class of failure as a
 * setting that is accepted and quietly not applied, which is what this
 * repo's supply-chain rule exists to prevent (docs/supply-chain.md).
 */
function isLockfileInstall(command: string): boolean {
  return (
    /^pnpm\s+(?:install|i)\b/.test(command) &&
    /(?:^|\s)--frozen-lockfile(?=\s|$)/.test(command)
  );
}
```

Replace the three `LOCKFILE_INSTALL.test(command)` call sites with
`isLockfileInstall(command)`, and update the real assertion's name and the
fixtures:

```ts
  it('runs pnpm install --frozen-lockfile, never a command that resolves', () => {
    // Reports the offending invocations rather than a count, so a failure
    // names the file and the command it found.
    expect(installInvocations().filter(({ command }) => !isLockfileInstall(command))).toEqual([]);
  });
```

```ts
  it('reads the argv form, where the subcommand is not the first argument', () => {
    const source = "spawnSync('pnpm', ['install', '--frozen-lockfile'], { stdio: 'inherit' });";
    expect(installInvocationsIn('fixture.ts', source)).toEqual([
      { file: 'fixture.ts', command: 'pnpm install --frozen-lockfile' },
    ]);
  });

  it('does not treat prose quoting a call as an invocation', () => {
    const source = [
      "// Never write execSync('pnpm install') here.",
      "execSync('pnpm install --frozen-lockfile');",
    ].join('\n');
    expect(installInvocationsIn('fixture.ts', source)).toEqual([
      { file: 'fixture.ts', command: 'pnpm install --frozen-lockfile' },
    ]);
  });

  it('permits further flags alongside --frozen-lockfile', () => {
    const source = "execSync('pnpm install --frozen-lockfile --ignore-scripts');";
    expect(
      installInvocationsIn('fixture.ts', source).filter(({ command }) => !isLockfileInstall(command)),
    ).toEqual([]);
  });

  // The assertion npm's shape could not need: `npm ci` was lockfile-exact by
  // its own name, so there was nothing to omit. A bare `pnpm install`
  // resolves, and is frozen only by an environment variable this repo does
  // not control on a contributor's machine.
  it('treats a bare pnpm install as a violation', () => {
    const source = "execSync('pnpm install');";
    expect(
      installInvocationsIn('fixture.ts', source).filter(({ command }) => !isLockfileInstall(command)),
    ).toEqual([{ file: 'fixture.ts', command: 'pnpm install' }]);
  });

  it('does not read a command assembled by interpolation', () => {
    const source = 'execSync(`pnpm install --frozen-lockfile ${extra}`);';
    expect(installInvocationsIn('fixture.ts', source)).toEqual([]);
  });

  it('does not see a renamed or injected callee', () => {
    const source = ["run('pnpm install');", "installFn('pnpm install');"].join('\n');
    expect(installInvocationsIn('fixture.ts', source)).toEqual([]);
  });

  it('does not see a command whose pnpm is not immediately followed by the subcommand', () => {
    const source = [
      "execSync('cd packages/x && pnpm install --frozen-lockfile');",
      "execSync('pnpm --dir packages/x install --frozen-lockfile');",
    ].join('\n');
    expect(installInvocationsIn('fixture.ts', source)).toEqual([]);
  });
```

Then rewrite the file's docblock. Three paragraphs carry npm-specific
claims and must state pnpm's behaviour instead — replacing the claim, never
annotating it with what it used to say:

1. The opening two paragraphs (`npm ci` installs … / `npm install`
   reconciles) become the `pnpm install --frozen-lockfile` vs bare
   `pnpm install` contrast, and gain the "the flag is demanded explicitly"
   point above.
2. The `WHAT IT READS` paragraph's example `spawnSync('npm', ['install'])`
   becomes `spawnSync('pnpm', ['install', '--frozen-lockfile'])`. Its
   sentence about `worktree/dev-server.ts` using the argv shape for `npx`
   becomes `pnpm exec` — Task 3 makes that true; keep the two in step.
3. The `WHAT IT CANNOT SEE` bullet naming `npm --prefix x install` becomes
   `pnpm --dir x install`.

- [ ] **Step 2: Run the tests and watch them fail**

```bash
pnpm exec vitest run --project unit src/lib/script-install-census.test.ts
```

Expected: FAIL. `filesRunningAnInstall` still finds
`scripts/worktree-setup.ts`, but its command is `npm ci`, which is not an
`INSTALL_COMMAND` under the new pattern — so the discovery assertion fails
with `filesRunningAnInstall: []` against the expected
`['scripts/worktree-setup.ts']`. **That specific failure is the point:** it
proves the guard is looking, not merely passing.

- [ ] **Step 3: Update the one install in imperative code**

In `scripts/worktree-setup.ts`, replace lines 47-52. The four-line comment
above the call asserts npm-specific reasoning and must be rewritten with it,
not left pointing at a rule that no longer reads that way:

```ts
  // A worktree is a checkout of committed versions, so the frozen install:
  // it installs the lockfile exactly and fails when `package.json` disagrees
  // with it. Why that matters over a bare `pnpm install` — which resolves,
  // and which pnpm freezes only when `CI` is set — is in
  // `docs/supply-chain.md`. Pinned by `src/lib/script-install-census.test.ts`.
  console.log('[worktree:setup] running pnpm install --frozen-lockfile...');
  execSync('pnpm install --frozen-lockfile', { stdio: 'inherit' });
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
pnpm exec vitest run --project unit src/lib/script-install-census.test.ts
```

Expected: PASS, all assertions.

- [ ] **Step 5: MUTATION 3 — prove the guard rejects a resolving install**

```bash
sed -i '' "s/pnpm install --frozen-lockfile', { stdio/pnpm install', { stdio/" scripts/worktree-setup.ts
pnpm exec vitest run --project unit src/lib/script-install-census.test.ts; echo "MUTATED exit: $?"
```

Expected: FAIL, non-zero exit, naming
`{ file: 'scripts/worktree-setup.ts', command: 'pnpm install' }`. Restore
with `git checkout scripts/worktree-setup.ts` **only if nothing else in that
file is uncommitted** — otherwise revert the one line by hand; `git checkout`
discards sibling edits.

- [ ] **Step 6: Commit**

```bash
git add src/lib/script-install-census.test.ts scripts/worktree-setup.ts
git commit -m "$(cat <<'MSG'
build(pnpm): port the install-census guard to pnpm

Not a string swap. `npm ci` is a subcommand, so an anchored prefix expressed
the whole rule; `pnpm install --frozen-lockfile` is a flag that may sit
anywhere after the subcommand, so the predicate becomes a two-part function
and `LOCKFILE_INSTALL` stops being expressible as one regex.

The flag is demanded explicitly even though pnpm defaults it true under CI:
relying on that would leave one command frozen on a runner and reconciling
on a laptop, which is the failure docs/supply-chain.md exists to prevent.

Adds an assertion npm's shape could not need — that a bare `pnpm install` is
a violation — and keeps all six blind-spot fixtures, re-spelled (npm's
`--prefix` becomes pnpm's `--dir`).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: Rewrite every executable call site

**Files:**
- Modify: `Dockerfile`, `.github/workflows/ci.yml`,
  `.github/workflows/e2e-flake-repro.yml`, `package.json` (scripts),
  `playwright.config.ts`, `src/lib/db-provision.ts`,
  `scripts/worktree-up.ts`, `src/lib/worktree/dev-server.ts`,
  `src/lib/worktree/dev-server.test.ts`

**Interfaces:**
- Consumes: Task 1's pinned pnpm; Task 2's guard (which now constrains
  `worktree-setup.ts` and nothing here).
- Produces: `spawnDevServer` spawns `pnpm` with `exec` as its first argv
  element — `spawnFn('pnpm', ['exec', 'next', 'dev', '-p', String(port)])`.

- [ ] **Step 1: Dockerfile**

`corepack enable` goes in the `deps` stage before the install. **Keep every
existing comment** — the header docblock, the `mkdir -p public` note, the
dummy `DATABASE_URL` note. The spike's throwaway branch deleted them; that
must not be carried over.

Changes:
- `COPY package.json package-lock.json ./` →
  `COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./`
- add before the install:

```dockerfile
# corepack reads `packageManager` from package.json and VERIFIES the pinned
# integrity hash before running pnpm — the reason this repo bootstraps here
# rather than with `npm i -g pnpm`. Corepack ships with Node "from 14.19.0
# up to (but not including) 25.0.0"; node:22-alpine and node:24-alpine both
# have it. Bumping this base image past 24 fails loudly here with
# `corepack: not found`, and the fix is `RUN npm i -g corepack` above.
RUN corepack enable
```

- `RUN npm ci` → `RUN pnpm install --frozen-lockfile`
- `RUN npx prisma generate && npm run build` →
  `RUN pnpm exec prisma generate && pnpm run build`
- `CMD ["npx", "prisma", "migrate", "deploy"]` →
  `CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]` — **this line is
  invisible to #540's census** (JSON array form, no trailing space after
  `npx`), so it is easy to skip.

- [ ] **Step 2: `ci.yml` — the five installing jobs**

The jobs are `checks`, `test-components`, `test-unit`, `test-integration`,
`test-e2e`. `docker-build` and `test` install nothing and are unchanged.

In each of the five, replace the `setup-node` + install pair with:

```yaml
      - uses: actions/setup-node@v7
        with:
          node-version: '22'
          # No `cache:` key. `cache: 'pnpm'` needs pnpm resolvable when this
          # step runs, but `corepack enable` must come AFTER it — corepack
          # installs its shims into the active Node's bin directory. The
          # store is cached explicitly below instead.

      # `packageManager` in package.json pins the version AND its integrity
      # hash; corepack verifies the hash before running pnpm.
      - name: Enable pnpm
        run: |
          corepack enable
          echo "PNPM_STORE=$(pnpm store path)" >> "$GITHUB_ENV"

      - name: Cache pnpm store
        uses: actions/cache@v6
        with:
          path: ${{ env.PNPM_STORE }}
          key: pnpm-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
          restore-keys: |
            pnpm-${{ runner.os }}-

      - name: Install dependencies # postinstall runs prisma generate
        run: pnpm install --frozen-lockfile
```

`pnpm store path` prints exactly one line with no trailing whitespace —
verified locally, which is why no `--silent` or trimming is needed.

Then, throughout the file:
- every `npx <tool>` in a `run:` → `pnpm exec <tool>` (there are `prisma
  validate`, `prisma migrate deploy`, `prisma migrate diff`, `prisma db
  seed`, `vitest run` ×4, `playwright install`, `playwright test`)
- `npm run typecheck` / `npm run lint` / `npm run build` → `pnpm run …`
- `npm audit --audit-level=high` → `pnpm audit --audit-level=high`
  (`--audit-level` is supported; verified)
- **both** `hashFiles('package-lock.json')` cache keys (in `test-integration`
  and `test-e2e`) → `hashFiles('pnpm-lock.yaml')`. Missed, they key on the
  hash of a file that no longer exists.

Leave every explanatory comment intact — in particular the `--file-parallelism`
comment, the seed-job rationale, and the `test` aggregate-gate reasoning.

- [ ] **Step 3: `e2e-flake-repro.yml`**

Same bootstrap block; then `npm ci` → frozen install, `npx prisma migrate
deploy` / `npx playwright …` → `pnpm exec …`, `npm run build` /
`npm run start` → `pnpm run …`, and drop its `cache: 'npm'`.

- [ ] **Step 4: `package.json` scripts**

```json
    "test": "vitest run --project unit --project components && vitest run --project unit-sweeps --project integration",
    "verify": "pnpm run typecheck && pnpm run lint && pnpm test",
```

and `"prisma": { "seed": "pnpm exec tsx prisma/seed.ts" }`. The `test` script
itself invokes `vitest` directly and needs no change; only `verify`'s three
inner calls and the seed command do.

- [ ] **Step 5: The four remaining executable sites**

- `playwright.config.ts:69` — `: 'npm run dev',` → `: 'pnpm run dev',`, and
  the error-message string at :68 (`Run: npm run worktree:up`) → `pnpm run
  worktree:up`.
- `src/lib/db-provision.ts:46,61` — `execSync('npx prisma migrate deploy'…)`
  and `execSync('npx prisma db seed'…)` → `pnpm exec prisma …`.
- `scripts/worktree-up.ts:28,39` — two operator-facing messages naming
  `npm run dev` and `npm run worktree:setup`.
- `src/lib/worktree/dev-server.ts:17`:

```ts
    const child = spawnFn('pnpm', ['exec', 'next', 'dev', '-p', String(port)], {
```

- [ ] **Step 6: Update the dev-server test to match**

`src/lib/worktree/dev-server.test.ts:32` asserts the old literal. Change it:

```ts
    expect(spawnFn).toHaveBeenCalledWith(
      'pnpm',
      ['exec', 'next', 'dev', '-p', '3100'],
      expect.objectContaining({ cwd: '/worktree', detached: true }),
    );
```

- [ ] **Step 7: Run the unit and component tiers**

```bash
pnpm exec vitest run --project unit --project components
```

Expected: PASS. If `dev-server.test.ts` fails, Step 5 and Step 6 have
drifted apart — the argv array must match element for element, `exec`
included.

- [ ] **Step 8: MUTATION 4 — prove the phantom-dependency fix is load-bearing**

This is the one the spike's worktree could not run honestly. In the main
checkout there is no parent `node_modules`, so it must fail **locally too**;
a local pass means something unexpected is resolving `dotenv` and is itself
a finding.

```bash
cp package.json /tmp/pkg-phantom.bak
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));
 delete p.devDependencies.dotenv; fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n");'
pnpm install --no-frozen-lockfile
pnpm run build; echo "MUTATED build exit: $?"
```

Expected: non-zero, `Cannot find module 'dotenv'`.

```bash
cp /tmp/pkg-phantom.bak package.json
pnpm install --frozen-lockfile
git diff --stat package.json pnpm-lock.yaml
```

Expected: no diff in either. Record the error text.

- [ ] **Step 9: Build both Docker targets**

Docker remains the final gate for what it uniquely covers: Prisma engine
resolution under alpine, and the standalone bundle's traced `node_modules`.

```bash
docker build -t fairyoga . ; echo "runner exit: $?"
docker build --target migrate -t fairyoga-migrate . ; echo "migrate exit: $?"
```

Expected: both `0`. If the build context is enormous or slow, that is #559
(`.dockerignore` shipping worktree `node_modules`), a known pre-existing
defect — **#559 is unaffected by this branch**; note it and continue.

- [ ] **Step 10: Commit**

```bash
git add Dockerfile .github/workflows/ci.yml .github/workflows/e2e-flake-repro.yml \
  package.json playwright.config.ts src/lib/db-provision.ts scripts/worktree-up.ts \
  src/lib/worktree/dev-server.ts src/lib/worktree/dev-server.test.ts
git commit -m "$(cat <<'MSG'
build(pnpm): rewrite every executable call site

CI bootstraps pnpm with corepack AFTER setup-node, because corepack installs
its shims into the active Node's bin directory — which forfeits setup-node's
`cache: 'pnpm'`, so the store is cached explicitly with actions/cache, an
action this workflow already used twice. Both Next-build cache keys move
from package-lock.json to pnpm-lock.yaml.

Two of these sites are invisible to the census command in #540, which
anchors on `npx ` with a trailing space and so cannot see a quoted argv
element: Dockerfile's `CMD ["npx", "prisma", ...]`, and dev-server.ts's
`spawnFn('npx', ['next', 'dev', ...])` with its test assertion. Neither
would have broken — `next` is on node_modules/.bin under either layout — so
neither would have been caught by a failing build either.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: Rewrite `docs/supply-chain.md` with re-measured censuses

**Files:**
- Modify: `docs/supply-chain.md` (170 lines; substantially rewritten)

**Interfaces:**
- Consumes: a working pnpm install from Task 1; the guard's new shape from
  Task 2.
- Produces: the canonical statement of the rule that every later comment
  points at.

This document's discipline is that every number ships with the command that
re-derives it. Translating the commands while keeping npm's numbers would
break exactly that. **Every figure in this task is measured, not converted.**

- [ ] **Step 1: Re-measure the install census**

```bash
grep -rnE 'pnpm +(install|i|add|update|up|import)\b' \
  Dockerfile .github/workflows README.md AGENTS.md scripts src/lib \
  --exclude='*.test.ts' | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|#)'
```

Record the line count and the per-file breakdown for the table. Keep the
existing explanation of **why both filters are load-bearing** — that the
second `grep` is anchored, and that an unanchored version would swallow a
real `--registry https://…` line. That reasoning is unchanged by the
migration and was learned the hard way.

- [ ] **Step 2: Re-measure the advisory census**

**`pnpm audit --json` returns the npm *v6* audit shape, not npm v7+'s.** Top
level is `{ advisories, metadata }`, where `advisories` is keyed by advisory
id; there is no `vulnerabilities` key. Measured — so the doc's existing
one-liner cannot be translated field-for-field: `Object.entries(j.vulnerabilities)`
throws `TypeError` on `undefined` rather than reporting zero.

This is the replacement to ship in the document, so the numbers keep
travelling with their derivation:

```bash
pnpm audit --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s);
  console.log(JSON.stringify(j.metadata.vulnerabilities));
  for (const a of Object.values(j.advisories))
    console.log(a.module_name, a.severity, a.vulnerable_versions, "->", a.patched_versions);});'
```

Add `--prod` for the production tree (it replaces npm's `--omit=dev`).
`--audit-level` is also supported. The probe tree used to confirm the schema
had zero advisories, so **check the per-advisory field names against this
repo's real output** before publishing the table — `module_name`,
`severity`, `vulnerable_versions` and `patched_versions` are the npm v6
schema's names, and only the top-level shape was measured directly.

For the "reached through" column, `pnpm why <pkg>` replaces `npm ls <pkg>`.
Note npm's `fixAvailable` object — which the current document leans on to
distinguish a stale lockfile resolution from a constrained one — has no v6
equivalent, so that distinction must be re-derived from
`patched_versions` against the declared range instead. Keep the
distinction; it is the thing that decides the fix.

- [ ] **Step 3: Rewrite the document**

Sections, in order:

1. **The rule** — `pnpm install --frozen-lockfile` installs `pnpm-lock.yaml`
   exactly and fails when `package.json` disagrees; a bare `pnpm install`
   reconciles. State that the flag is written explicitly **because** pnpm
   defaults it true only when `CI` is set, so relying on the default gives
   one command two behaviours.
2. **Where this repo installs** — the re-measured table and its command,
   with the two-filter explanation preserved.
3. **What is enforced, and what is not** — `script-install-census.test.ts`
   with its new predicate shape; the declarative paths still unenforced.
4. **What pnpm enforces that nothing did before** (new). Two settings, both
   in `pnpm-workspace.yaml` and read nowhere else:
   - `minimumReleaseAge: 10080` — **a lockfile policy verification, not a
     download gate.** Packages are downloaded and `node_modules` is fully
     populated with the rejected version, and *then* the command exits 1.
     Sufficient for CI; not what stops fresh code executing.
   - `strictDepBuilds` (default true) + `allowBuilds` — this *is* what stops
     it, on every machine rather than only in CI. Ship the re-derivation
     command for the six-package set and note the `hasInstallScript`
     arithmetic.
   - The honest caveat: a **mistyped key** in this file gets a `[WARN]` and
     **exit 0**, and a setting in the wrong file gets nothing at all. Cite
     the mutation tests as what actually proves either control live.
5. **Known advisories** — re-measured numbers, pnpm commands. Keep the
   `--omit=dev`-equivalent (`--prod`) paragraph and its correct observation
   that neither shipped stage matches that proxy; the `migrate` stage's
   description as "a plain `npm ci`" becomes the frozen pnpm install.
6. **Not yet in place** — drop #533 (absorbed). Keep #535. Keep #534 **scoped
   to its remainder**: registry-host pinning of every `resolved`, an
   integrity-presence check, and a signature-verification step. Say plainly
   that its install-script allowlist half is now `allowBuilds`.

- [ ] **Step 4: Verify every command in the document actually runs**

Copy each fenced command out of the file and run it. A command that errors,
or that prints numbers different from the ones beside it, is a defect in
this task — not something for a later reviewer to find.

- [ ] **Step 5: Commit**

```bash
git add docs/supply-chain.md
git commit -m "$(cat <<'MSG'
docs(supply-chain): restate the rule for pnpm, with re-measured censuses

Both censuses are re-derived under pnpm rather than converted: this
document's discipline is that every number ships with the command that
reproduces it, so translating the commands while keeping npm's figures would
have broken the one property it is careful about.

Adds what pnpm enforces that nothing did before, including the caveat that
minimumReleaseAge is a lockfile policy verification rather than a download
gate — node_modules is fully populated with the rejected version before the
command exits 1 — so strictDepBuilds, not the cooldown, is what stops fresh
dependency code executing.

#533 is absorbed and leaves the "not yet in place" list. #534 stays, scoped
to the three of its four asks pnpm does not cover.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 5: Translate the 24 remaining instructional files

**Files:** every bucket-B file except `docs/supply-chain.md`, which Task 4
already rewrote. Bucket B is 25 files, so this task is **24**: `11 + 13`.

Eleven outside `src/` and `tests/`: `README.md` (18),
`docs/test-database.md` (14), `AGENTS.md` (12),
`.claude/skills/solve-issue/SKILL.md` (10), `.claude/skills/verify/SKILL.md`
(7), `CLAUDE.md` (2), `.env.example` (2), `docs/solve-issue-lessons.md` (2),
`docs/implementation-plan.md` (2), `docs/mutation-testing.md` (2),
`eslint.config.mjs` (2).

Thirteen under `src/` and `tests/`, all docblock prose:
`src/lib/census-walk-independence.test.ts`,
`src/lib/db-locks-verdict-census.test.ts`,
`src/lib/entry-rule-kind-guard.test.ts`, `src/lib/next-agent-rules.test.ts`,
`src/lib/probe-placement-census.test.ts`, `src/lib/room-identity.ts`,
`src/services/class-terminal-date.test.ts`,
`src/services/class-terminal-status.test.ts`, `tests/e2e/fixtures.ts`,
`tests/e2e/recurring.spec.ts`, `tests/e2e/visual.spec.ts`,
`tests/integration/verify-page.test.ts`,
`tests/integration/waitlist-display.test.ts`.

**Interfaces:** consumes the vocabulary fixed in Global Constraints;
produces nothing other tasks depend on.

- [ ] **Step 1: Apply the translation, one file at a time**

The mapping is in Global Constraints. **Do not run a repo-wide `sed`** —
`docs/superpowers/**` must not be touched, and two of these files need
judgment rather than substitution (Steps 2 and 3).

- [ ] **Step 2: `docs/mutation-testing.md` — two different treatments**

§3's recipe is live instruction and gets a full translation, including its
`npx vitest run --project <tier> <files>` line.

§2 is a **dated findings record** (#178, 2026-08-24). Its Q2 verdict reads
"Symlinking `node_modules` eliminates npm install overhead". Do not
translate it to "pnpm install overhead" — that would rewrite a past finding.
Drop the tool name instead: **"eliminates install overhead"**. Leaving "npm"
makes it a live-sounding claim about a tool this repo no longer runs;
changing it to "pnpm" makes it a false record of what was measured.

The general rule, applicable beyond this file: *translate anything that
instructs; leave anything that narrates a dated event; where a narrated
sentence names the tool as a live fact, remove the name rather than rewrite
the history.*

- [ ] **Step 3: `CLAUDE.md` — the reference table row**

Line 267's row for `docs/supply-chain.md` reads "why every path is `npm
ci`". That is a claim about another file's content, and Task 4 changed it.
Rewrite the row to match what that document now says.

Line 30's `npx prisma migrate dev --name <description>` is live instruction
and translates normally.

- [ ] **Step 4: Sweep for what was invalidated, not just what was edited**

Deleting `package-lock.json` invalidates references to it by name. Grep for
the removed names across the whole repo and give every hit a verdict —
expect legitimate survivors in `docs/superpowers/**`:

```bash
grep -rn 'package-lock' --exclude-dir=node_modules --exclude-dir=.git . | grep -v '^./docs/superpowers/'
grep -rn "npm ci\|npm install\|npx " --exclude-dir=node_modules --exclude-dir=.git \
  --exclude-dir=.next-build . | grep -v '^./docs/superpowers/'
```

Expected after this task: the first returns nothing outside
`docs/superpowers/`; the second returns only lines that are deliberately
about npm (for example, a sentence in `docs/supply-chain.md` explaining what
the repo migrated *from*, if Task 4 wrote one).

- [ ] **Step 5: Typecheck and lint, since docblocks live in compiled files**

```bash
pnpm run typecheck && pnpm run lint
```

Expected: exit 0 for both. Lint reports 6 pre-existing warnings and 0
errors.

- [ ] **Step 6: Commit**

```bash
git add README.md AGENTS.md CLAUDE.md .env.example eslint.config.mjs \
  docs/test-database.md docs/solve-issue-lessons.md docs/implementation-plan.md \
  docs/mutation-testing.md .claude/skills/solve-issue/SKILL.md \
  .claude/skills/verify/SKILL.md \
  src/lib/census-walk-independence.test.ts src/lib/db-locks-verdict-census.test.ts \
  src/lib/entry-rule-kind-guard.test.ts src/lib/next-agent-rules.test.ts \
  src/lib/probe-placement-census.test.ts src/lib/room-identity.ts \
  src/services/class-terminal-date.test.ts src/services/class-terminal-status.test.ts \
  tests/e2e/fixtures.ts tests/e2e/recurring.spec.ts tests/e2e/visual.spec.ts \
  tests/integration/verify-page.test.ts tests/integration/waitlist-display.test.ts
git commit -m "$(cat <<'MSG'
docs(pnpm): translate the instructional call sites

Twenty-four files whose npm vocabulary instructs a human or an agent.
docs/superpowers/plans/ and specs/ are deliberately untouched: they are
historical records, so this repo now carries both vocabularies on purpose.

Two needed judgment rather than substitution. docs/mutation-testing.md §2 is
a dated findings record (#178), so "eliminates npm install overhead" loses
the tool name rather than gaining a new one — translating it would rewrite
what was measured, leaving it would assert a live fact about a tool this repo
no longer runs. CLAUDE.md's reference-table row described what
docs/supply-chain.md says, and had to move with it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 6: Whole-branch verification

**Files:** none modified unless a defect is found.

**Interfaces:** consumes everything above.

- [ ] **Step 1: The full local gate**

```bash
pnpm run verify
```

Expected: exit 0. **"Green" is load-bearing here.** `test` chains two vitest
invocations with `&&`; one red unit test means the second — `unit-sweeps`
and `integration` — never runs and reports *nothing*, not zero failures.
While anything earlier is red, run the tiers directly rather than reading a
red `verify` as evidence about them.

- [ ] **Step 2: Start the app and run integration against the standalone bundle**

CI's merge gate runs the standalone bundle, not `next dev` (#127), and the
two can differ. Match it:

```bash
pnpm run build
cp -r .next-build/static .next-build/standalone/.next-build/static
[ -d public ] && cp -r public .next-build/standalone/public || true
node .next-build/standalone/server.js > /tmp/server.log 2>&1 &
for i in $(seq 1 30); do curl -sf http://localhost:3000/api/health >/dev/null && break; sleep 1; done
pnpm exec vitest run --project integration --file-parallelism
```

Record the file/test counts. Note that `tests/integration/reporting-page.test.ts`
has a known wall-clock boundary flake — **#558 is unaffected by this
branch**; if it fails, check the clock before believing it is a regression.

- [ ] **Step 3: Playwright against the same bundle**

```bash
pnpm exec playwright test
```

The spike measured 160 pass / 4 fail against a locally-served bundle, with
the same four failing under an npm control — artifacts of a non-standard port
with `NEXT_PUBLIC_APP_URL` pointing elsewhere. Compare against that, and
treat any *fifth* failure as real.

- [ ] **Step 4: Leave the app as you found it**

Stop the standalone server, then restart the maintainer's dev server:

```bash
kill "$(lsof -nP -iTCP:3000 -sTCP:LISTEN -t)"
pnpm run dev
```

- [ ] **Step 5: Reconcile the branch against the spec**

Not a keyword sweep — derive the checklist from the diff. `git diff
--stat main...HEAD`, list what changed, list what the spec said should
change, and reconcile the two in both directions. A file in the spec with no
diff, or a diff with no spec entry, is a finding.

- [ ] **Step 6: Confirm the census is exhausted**

```bash
git ls-files | grep -vE '^docs/superpowers/' \
  | xargs grep -lE "npm (run|ci|install|test|exec)|npx |['\"](npm|npx)['\"]"
```

Expected: only files that mention npm *deliberately* — the census guard's own
fixtures if any survive, and any sentence in `docs/supply-chain.md` about
what the repo migrated from. Every other hit is unfinished work.

---

## After the plan: PR and issue hygiene

Not build tasks; do them before requesting review.

- [ ] **PR body** records: the corrected census arithmetic (34/157 → 36/169,
  with the twelve-occurrence delta itemised); the install-script arithmetic
  (9 lock entries − 1 root − 2 nested duplicates = 6, correcting #534's
  seven); all four mutation results with their exact error text; which spike
  claims were inherited rather than re-measured; the corepack/Node-25 expiry;
  and the local run counts with the arithmetic showing `verify` covers every
  vitest project.
- [ ] **Closes #540 and #533.** For the third: write **"#534 is
  unaffected"** — never the negated auto-close phrase, which GitHub's parser
  matches through the negation.
- [ ] **Comment on #534** with the four-way absorption table from the spec,
  and correct its install-script census from seven to six (`sharp` no longer
  declares one).
- [ ] **Comment on #540** correcting its own census command, so the next
  reader of the issue is not misled by the figure that is still in its body.
- [ ] After merge, verify closure with `gh issue view <n> --json state` for
  #540, #533 **and** #534 — #534 must still be open.
