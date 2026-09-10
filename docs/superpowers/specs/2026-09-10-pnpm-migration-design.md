# Migrate from npm to pnpm

Issue #540, under tracking issue #531. The decision was settled by a spike run
on 2026-09-10 against `main` @ `a6758ed` (recorded in full at
[#540 comment 5615423656](https://github.com/ivohofland/fair.yoga/issues/540#issuecomment-5615423656));
this spec is the migration that spike authorised. It does **not** re-litigate
whether to migrate.

Two things it does add: a **version change** — `packageManager` pins
**pnpm 12.3.4**, not the 11.22.0 the spike measured — and a correction to
#540's own acceptance list, which asserts that #534 closes as absorbed. It
does not.

## What was re-derived for this spec, and what was inherited

A prior session's summary is prose with no commands attached, so the cheap
numbers were re-measured rather than copied. All four confirm the issue:

| Claim | Re-derived? | Result |
|---|---|---|
| `npm`/`npx` call sites: 34 files / 157 occurrences | yes, and then widened | issue's figure reproduced exactly — **and it is a floor, not a census.** True figure **36 files / 169 occurrences** |
| Install-script census = 6 packages | yes | confirmed — arithmetic below |
| `dotenv` and `vite` are undeclared phantoms | yes | confirmed, 4 import sites |
| pnpm lockfile format is Dependabot-readable | yes | `lockfileVersion: '9.0'` under both 11.22.0 and 12.3.4 |

The install-script arithmetic, because #540 and #534 disagree on it:
`package-lock.json` holds **9** entries with `hasInstallScript`, minus **1**
root entry (this repo's own `postinstall: prisma generate`, not a
dependency's), minus **2** nested duplicate copies of `fsevents` (under
`tsx/` and `vite/`) = **6 distinct packages**: `@prisma/client`,
`@prisma/engines`, `esbuild`, `fsevents`, `prisma`, `unrs-resolver`.
Re-derive with:

```bash
node -e 'const l=require("./package-lock.json");
 console.log([...new Set(Object.entries(l.packages)
   .filter(([k,v])=>k&&v.hasInstallScript)
   .map(([k])=>k.replace(/^.*node_modules\//,"")))].sort())'
```

**#534 says seven, naming `sharp`.** `sharp` no longer declares an install
script; it is still installed, as an optional dependency of `next`. That
correction belongs on #534 as well as here.

### The call-site census in #540 is a floor, and it hides executable code

#540's command anchors on `npx ` **with a trailing space**, so it cannot see
`npx` or `npm` as a quoted argv element — the exact shape `spawnSync`,
`spawn`, `execFile` and `execFileSync` require, and the shape a Dockerfile
`CMD` JSON array uses. Widening it by that one alternation:

```bash
git ls-files | grep -vE '^docs/superpowers/|^package-lock\.json$' \
  | xargs grep -lE "npm (run|ci|install|test|exec)|npx |['\"](npm|npx)['\"]"
```

**36 files / 169 occurrences**, against the issue's 34 / 157. The arithmetic,
so the delta is auditable: `157 + 5` (`cache: 'npm'` in `ci.yml`) `+ 1`
(`cache: 'npm'` in `e2e-flake-repro.yml`) `+ 1`
(`Dockerfile:33`'s `CMD ["npx", "prisma", …]`) `+ 1`
(`docs/supply-chain.md` prose quoting `spawnSync('npm', ['install'])`)
`+ 2` (the census test's docblock and one fixture) `+ 1 + 1`
(the two new files) `= 169`.

The two files #540's command misses are **both executable**:

- `src/lib/worktree/dev-server.ts:17` — `spawnFn('npx', ['next', 'dev',
  '-p', String(port)], …)`, the process `pnpm run worktree:up` starts;
- `src/lib/worktree/dev-server.test.ts:32` — the assertion pinning that
  literal.

Neither *breaks* under pnpm — `next` is on `node_modules/.bin` under either
layout, so `npx next dev` keeps working by luck — but leaving them
contradicts goal 1, and the census test's own docblock already names the
argv form as the shape a first-argument-only reader would miss. The irony is
the point: the docblock describes this blind spot in prose, and #540's
census walked into it.

This is still a floor, not a census: an interpolated or variable-held
command (`execSync(\`npm ${sub}\`)`) is invisible to any grep. `package-lock.json`
is excluded because it is deleted by this migration; it contains `"npm": ">=6"`
engine fields that are not call sites.

**The command above is valid only on a PRE-migration tree, and the figure was
measured there.** `pnpm` contains `npm` as a substring, so after the migration
every `pnpm run` matches the `npm (run|…)` alternation and the same command
returns a large, meaningless number. Confirmed harmless for the figure quoted
here: at `a6758ed` the repo contained zero `pnpm <subcommand>` occurrences
outside `docs/superpowers/`, so nothing was double-counted. To re-run it after
the migration, anchor the alternation against the preceding character:

```bash
git ls-files | grep -vE '^docs/superpowers/' \
  | xargs grep -lPE "(?<!p)npm (run|ci|install|test|exec)|(?<!p)npx |['\"](npm|npx)['\"]"
```

Inherited from the spike without re-measurement, because re-measuring means
re-running it: the standalone-build result, the full-suite and Playwright
parity numbers, the Docker image results, and the disk measurements
(≈43× marginal cost per worktree, measured on a dedicated APFS sparse
volume because `du` cannot see block sharing).

## What changed by moving the pin to pnpm 12.3.4

The spike's *behavioural* findings were measured on 11.22.0, so the four
that the migration depends on were re-confirmed under 12.3.4 before this
spec was written. All four survive the major bump:

| Fact | Probe | Result under 12.3.4 |
|---|---|---|
| `strictDepBuilds` defaults true | install `esbuild` with no config at all | `ERR_PNPM_IGNORED_BUILDS`, **exit 1** |
| `allowBuilds` is a boolean map in `pnpm-workspace.yaml` | the spike's exact file | accepted, `esbuild postinstall` ran, **exit 0** |
| a mistyped key is enforced **when `packageManager` is pinned** | append `minimumReleaseAgeTYPO: 10080` | with the pin: `ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS`, **exit 1**. Without it: `[WARN] … were ignored: "minimumReleaseAgeTYPO" (did you mean "minimumReleaseAge"?)`, **exit 0** |
| lockfile format | `head -3 pnpm-lock.yaml` | `lockfileVersion: '9.0'` — unchanged, so Dependabot still reads it |

The third row was measured twice and read wrongly the first time, which is
worth recording because the second reading is a stronger result. pnpm 12's
release notes say "a project's `pnpm-workspace.yaml` may no longer carry a
setting pnpm does not recognize". A first probe saw only a `[WARN]` and exit
0 and concluded the key names were surfaced but not tethered. That probe had
no `packageManager` field. **`packageManager` is the switch**: isolated by
adding it to the same probe and changing nothing else, the identical
mistyped key goes from `[WARN]`/exit 0 to
`ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS`/exit 1.

The behaviour is coherent: with a version pin, pnpm knows exactly which
version is authoritative, so an unrecognised key can only be a typo and is
safe to hard-error; without one, the key might belong to a pnpm version that
does recognise it, so warning is the only honest response.

**This repo pins `packageManager`, so its key names ARE tethered** — a typo
is a failing build, not a silent no-op. So the pin buys two controls, not
one: the integrity hash on the pnpm binary, and strict validation of the
settings file. The #533 failure mode — a setting believed on but silently
inert — is closed for key *names*. It remains open for the file's
*location*: a setting written into `.npmrc` or `package.json`'s `pnpm` key is
ignored with no diagnostic at all, which is why mutation 1 in §Testing, not
the config file's existence, is still what proves the allowlist live.

pnpm 12 also prints the release-age check explicitly
(`✓ Lockfile passes supply-chain policies (27 entries in 222ms)`), which
11 did not.

One caveat carried forward: pnpm **12.4.0** exists on the registry but the
`latest` dist-tag is 12.3.4. This spec pins 12.3.4 deliberately.

## The problem, restated as what pnpm buys

Two of #531's three substantive sub-issues are pnpm defaults rather than
machinery this repo has to build:

- **#533 (cooldown)** — `minimumReleaseAge` is a first-class setting. Under
  npm the same control needed `.npmrc`, `engines.npm >= 11.10.0`,
  `engine-strict=true`, and a pinned `npm i -g npm@11.19.0` before `npm ci`
  in six places, all of it to work around npm 10 accepting `min-release-age`
  and silently ignoring it.
- **#534 (install-script allowlist)** — `strictDepBuilds` defaults true, so
  an unreviewed dependency build script **errors the install on a
  contributor's laptop**, not merely in CI. That is strictly stronger than
  the CI-only check #534 describes.

Third, the repo-specific one: this project's workflow is worktree-based and
this machine currently carries **40 linked worktrees**
(`git worktree list | wc -l` reports 41, including the main checkout).
pnpm's content-addressable store makes the marginal cost of one roughly
18 MB against npm's 778 MB.

## Goals

1. Every install path in the repo runs pnpm, from the lockfile, at a pinned
   and integrity-verified version.
2. The two controls #533 and #534 exist to provide are on, enforced on every
   machine, and mutation-tested — not merely configured.
3. The repo's own documentation and skills tell a contributor the truth
   about which commands to run.
4. Dependabot keeps working, and its pull requests keep passing CI.
5. `docs/supply-chain.md` ships commands that reproduce the numbers printed
   beside them.

## Non-goals

- **Not re-running the spike.** Its result stands; §"Testing" below states
  what this migration verifies for itself and what it inherits.
- **Not bumping Node.** The Dockerfile stays on `node:22-alpine`. See
  §3 for why that interacts with corepack, and why it is still the right
  call today.
- **Not chasing pnpm 12.4.x or later.** 12.3.4 is `latest`; a future bump is
  its own change with its own re-verification.
- **Not rewriting `docs/superpowers/plans/` or `specs/`.** They say `npm`
  throughout and are historical records. The repo therefore carries both
  vocabularies permanently, deliberately. (This file is itself in that
  directory and describes commands as they will be *after* the migration —
  the exception that proves the rule, and the reason the rule is "do not
  rewrite", not "these are all npm".)
- **#558, #559 and #560 are unaffected** — three pre-existing defects the
  spike surfaced in passing, each reproducing under npm. **#535 is
  unaffected**; commit-pinning GitHub Actions stays open.
- **Not building #534's lockfile-invariant checks.** See §7.

## Approaches considered

### How pnpm gets onto PATH in CI and Docker

**Chosen: corepack, in both places, with an integrity-pinned
`packageManager`.**

`corepack use pnpm@12.3.4` writes
`packageManager: "pnpm@12.3.4+sha512.961aa41f…"`, and that hash is
load-bearing. Mutation-tested for this spec: flipping one hex digit of it,
with `COREPACK_HOME` pointed at an empty directory so the download actually
happens, gives **exit 1** and

```
throw new Error(`Mismatch hashes. Expected ${build[1]}, got ${actualHash}`);
```

Restoring the genuine hash on the same cold cache downloads and returns
`12.3.4`. **Corepack is the only one of the three candidates that verifies
the package manager binary itself.** In a sub-issue of #531 — supply-chain
hygiene — that is the point rather than a nicety.

A first run of this mutation *passed*, proving nothing: pnpm 12.3.4 was
already in corepack's cache, so no download occurred and no hash was
checked. It is recorded here because the same trap will catch the next
person: the cache lives at `~/.cache/node/corepack` on this machine, **not**
the macOS `~/Library/Caches` path.

Rejected, with reasons:

- **`pnpm/action-setup@v4`** — pnpm's own action, reads `packageManager`,
  and makes `actions/setup-node`'s `cache: 'pnpm'` work directly. Rejected
  because it executes whatever the registry serves, and because it adds a
  third-party action to five jobs in the very pull request whose sibling
  issue (#535) exists to commit-pin the actions already present.
- **`npm install -g pnpm@12.3.4`** — first-party, survives corepack's
  removal, but likewise unverified, and it repeats the version string
  outside `package.json`, so CI and Docker can drift.

**The cost of corepack, stated:** it is distributed with Node.js "from
version 14.19.0 up to (but not including) 25.0.0". Node 26 is current and
Node 24 (Krypton) is the active LTS; this repo's `node:22-alpine` (Jod) is
in maintenance. So a base-image bump past 24 breaks `corepack enable`. That
failure is loud (`corepack: not found`), dated, one line from the base image
that caused it, and repaired by `npm i -g corepack`. A comment in the
Dockerfile says so.

### Which pnpm version to pin

**Chosen: 12.3.4** (the `latest` dist-tag), over the 11.22.0 the spike
measured. The four behavioural facts the migration rests on were
re-confirmed under 12.3.4 rather than assumed — see the table above.
Landing on a version already a major behind would mean doing that
re-confirmation twice.

### Store caching in CI

**Chosen: an explicit `actions/cache@v6` step** on the path
`pnpm store path` reports, keyed by `pnpm-lock.yaml`.

`corepack enable` must run *after* `actions/setup-node`, because it installs
its shims into the active Node installation's bin directory. That ordering
forfeits `setup-node`'s `cache: 'pnpm'` convenience. `actions/cache@v6` is
already used twice in `ci.yml`, so this adds no new dependency.

**A local composite action was considered and rejected.** It would remove a
5× duplication, but `ci.yml` is deliberately explicit and heavily commented
— it already repeats `setup-node` + `npm ci` five times — and a composite
action hides those steps from the reader of that file.

## Design

### 1. `pnpm-workspace.yaml` (new)

```yaml
minimumReleaseAge: 10080
allowBuilds:
  '@prisma/client': true
  '@prisma/engines': true
  esbuild: true
  fsevents: true
  prisma: true
  unrs-resolver: true
```

Two properties of this file must be stated wherever it is documented,
because both are non-obvious and one of them is the exact failure #533
exists to prevent:

- **`allowBuilds` is a map of booleans, not a list.** A YAML list is coerced
  to `{'0': '@prisma/client', …}`, matches nothing, and is ignored — though
  it fails *closed* (builds blocked, exit 1), which is the safe direction.
  `pnpm approve-builds --all` writes the correct shape.
- **These settings are read from `pnpm-workspace.yaml` and nowhere else.**
  In `.npmrc` (kebab or camel case) or under `package.json`'s `pnpm` key
  they are silently ignored — no warning, no error, control off. A *mistyped
  key in the right file* is a different matter: because this repo pins
  `packageManager`, pnpm hard-errors with
  `ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS` and exit 1. So the key names are
  tethered and the file's location is not, and it is the location mistake
  that mutation-testing the behaviour has to catch.

`fsevents` is darwin-only and optional; it is in the list because it is in
the tree on this machine, and an entry for an absent package is inert.

### 2. `pnpm-lock.yaml`, and the deletion of `package-lock.json`

Generated by `pnpm import` from the existing `package-lock.json`, so the
migration inherits the resolved tree rather than re-resolving it. The spike
confirmed the repo's current pins already satisfy a seven-day cooldown, so
`pnpm install --frozen-lockfile` on the imported lockfile raises no
violation.

`package-lock.json` is then deleted. Two `ci.yml` cache keys hash it
(`hashFiles('package-lock.json')`, in `test-integration` and `test-e2e`) and
must move to `pnpm-lock.yaml` in the same change, or they silently key on an
empty hash.

### 3. Bootstrap

**Dockerfile**, `deps` stage: `RUN corepack enable` before the install, with
the Node 25 note above as a comment. `npm ci` becomes
`pnpm install --frozen-lockfile`; `npx prisma …` becomes `pnpm exec prisma
…` in the `build` and `migrate` stages. The existing header comments —
which explain the `migrate` stage's dual role, the `mkdir -p public` line,
and the dummy `DATABASE_URL` — are **kept**; the spike's throwaway branch
deleted them and that must not be carried over.

**`ci.yml`**, in each of the five jobs that install:

```yaml
- uses: actions/setup-node@v7
  with:
    node-version: '22'
- name: Enable pnpm (corepack; see docs/supply-chain.md)
  run: |
    corepack enable
    echo "PNPM_STORE=$(pnpm store path --silent)" >> "$GITHUB_ENV"
- uses: actions/cache@v6
  with:
    path: ${{ env.PNPM_STORE }}
    key: pnpm-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
- name: Install dependencies # postinstall runs prisma generate
  run: pnpm install --frozen-lockfile
```

The `cache: 'npm'` key on `setup-node` is removed in all five. Every
`npx <tool>` in a `run:` becomes `pnpm exec <tool>`, and `npm run <script>`
becomes `pnpm run <script>`. `e2e-flake-repro.yml` gets the same treatment.

The `docker-build` job is unchanged — it checks out and builds, and never
installs.

### 4. `package.json`

- `packageManager: "pnpm@12.3.4+sha512.<hash>"`, written by
  `corepack use pnpm@12.3.4` rather than typed.
- `dotenv` and `vite` added to `devDependencies`, at the versions the flat
  npm tree currently resolves (`dotenv 16.6.1`, `vite 8.1.5`). These are the
  two phantom dependencies pnpm's non-flat `node_modules` makes fatal:
  `dotenv` ← `playwright.config.ts:2`; `vite`'s `loadEnv` ←
  `vitest.config.ts:2`, `tests/setup/unit-db.ts:28`,
  `scripts/worktree-up.ts:3`.
- `scripts.verify` and `scripts.test` rewritten to `pnpm run …`;
  `prisma.seed` from `npx tsx` to `pnpm exec tsx`.

### 5. Dependabot

```yaml
  - package-ecosystem: npm     # unchanged — this is the ecosystem that reads pnpm-lock.yaml
    …
    cooldown:
      default-days: 8
```

The spike reproduced the failure this prevents: a lockfile resolved without
a cooldown, installed with `minimumReleaseAge: 10080`, gives
`[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 17 lockfile entries failed
verification`, exit 1 — which is what CI runs. This repo's Dependabot is
monthly with `versioning-strategy: increase` and most dependencies on
carets, so it is squarely in range.

**Eight days, not seven, and the extra day is the whole point.** pnpm counts
minutes from a package's publish timestamp; Dependabot counts days, at its
own granularity, at PR-creation time rather than CI time. Two systems
computing "seven days" from slightly different clocks will eventually
disagree at the boundary, and the symptom is a red Dependabot PR. One day of
margin costs one day of staleness.

`minimumReleaseAgeExclude` is deliberately **not** used. The spike confirmed
it clears the error, but it suppresses the check per-package rather than
stopping the violating PR being proposed, and it grows a list nobody prunes.

### 6. `src/lib/script-install-census.test.ts` — a port, not a rename

This file asserts that imperative code under `scripts/` and `src/lib/` runs
an install that comes from the lockfile. Its structure, its two real
assertions and all six of its blind-spot fixtures are kept. Three things
change *in kind*:

1. **`LOCKFILE_INSTALL` changes shape.** `npm ci` is a subcommand, so
   `/^npm\s+ci\b/` is a clean anchored match. pnpm's lockfile-exact install
   is `pnpm install --frozen-lockfile` — a **flag**, which may appear
   anywhere after the subcommand. The predicate becomes "matches the install
   family **and** carries a `--frozen-lockfile` token".
2. **`INSTALL_FAMILY` becomes pnpm's spellings.** The docblock already
   frames this as a floor rather than a census — pnpm's alias namespace has
   no type to tether against either — and that framing is kept verbatim in
   spirit.
3. **The prefixed-command blind-spot fixture changes spelling.** npm's
   `npm --prefix x install` becomes pnpm's `--dir`/`-C` equivalent. The
   property being pinned — that a global flag between the program and its
   subcommand defeats the anchored match — is unchanged.

**Why the flag stays explicit even though pnpm defaults it.** pnpm sets
`--frozen-lockfile` to true when `CI` is set. Relying on that would give the
same command two behaviours depending on environment — which is exactly the
class of failure `docs/supply-chain.md` was written about, npm 10 accepting
a setting and quietly not applying it. The guard demands the flag.

`scripts/worktree-setup.ts`'s `execSync('npm ci')` becomes
`execSync('pnpm install --frozen-lockfile')`, and the four-line comment above
it — which names `docs/supply-chain.md` and this test file — is rewritten to
match rather than left pointing at a rule that no longer reads that way.

### 7. `docs/supply-chain.md` — rewritten

- **"The rule"** becomes `pnpm install --frozen-lockfile`, and states why
  the flag is written explicitly despite pnpm's CI default.
- **The install census command and table** are re-spelled and re-derived.
- **The advisory census is re-measured**, not translated: `pnpm audit
  --json` for the whole tree and `--prod` for the production tree, `pnpm
  why <pkg>` in place of `npm ls <pkg>` for the "reached through" column.
  Leaving npm numbers under pnpm commands would ship a document whose own
  re-derivation instructions do not reproduce its figures — the precise
  drift that document is most careful about. The `--omit=dev` paragraph,
  including its correct observation that neither shipped stage matches that
  proxy, is kept with the flag re-spelled.
- **A new short section** records what pnpm now enforces that nothing did
  before, and the one thing it does not: `minimumReleaseAge` is a lockfile
  **policy verification**, not a download gate. Packages are downloaded and
  `node_modules` is fully populated with the rejected version, and *then*
  the command exits 1. That is sufficient for CI, but the control that stops
  fresh dependency code *executing* is `strictDepBuilds`.
- **"Not yet in place"** loses #533, keeps #535, and keeps a reduced #534 —
  see below.
- The `migrate`-stage note describing it as "a plain `npm ci`" is corrected.

### 8. The rewrite: 36 files, 169 occurrences

Every file is in exactly one bucket. The counts are per-file occurrence
counts of the **widened** pattern above, re-derived 2026-09-10; they are
here, in `docs/`, with the command that reproduces them, rather than in any
comment.

**A — executable; a wrong string breaks something, or misdirects a process
(11 files).** `ci.yml` (27), `e2e-flake-repro.yml` (8), `Dockerfile` (4),
`package.json` (4), `script-install-census.test.ts` (16),
`scripts/worktree-setup.ts` (5), `scripts/worktree-up.ts` (2),
`src/lib/db-provision.ts` (2), `playwright.config.ts` (3),
`src/lib/worktree/dev-server.ts` (1), `src/lib/worktree/dev-server.test.ts`
(1).

Four of these are run rather than described, and are easy to skim past:
`playwright.config.ts:69`'s `command: 'npm run dev'`; `db-provision.ts`'s two
`execSync('npx prisma …')` calls; `Dockerfile:33`'s
`CMD ["npx", "prisma", "migrate", "deploy"]`; and `dev-server.ts:17`'s
`spawnFn('npx', ['next', 'dev', '-p', String(port)])`, which becomes
`spawnFn('pnpm', ['exec', 'next', 'dev', '-p', String(port)])` — note `exec`
enters as its own argv element, and `dev-server.test.ts:32`'s assertion must
move with it.

**B — live instruction to a human or an agent (25 files).** Twelve outside
`src/` and `tests/`: `README.md` (18), `docs/test-database.md` (14),
`AGENTS.md` (12), `.claude/skills/solve-issue/SKILL.md` (10),
`docs/supply-chain.md` (7), `.claude/skills/verify/SKILL.md` (7),
`CLAUDE.md` (2), `.env.example` (2), `docs/solve-issue-lessons.md` (2),
`docs/implementation-plan.md` (2), `docs/mutation-testing.md` (2),
`eslint.config.mjs` (2). Plus thirteen under `src/` and `tests/` whose
docblocks cite a runnable command (`npx vitest run --project …`,
`npx playwright test --update-snapshots`) or name `npm run typecheck` /
`npm run verify` as the gate that holds a claim.

**11 + 25 = 36**, so every file in the widened census has a bucket.
Re-derive the split by running the widened census command and partitioning
on bucket A's eleven paths.

**C — historical narration; left alone.** `docs/superpowers/plans/` and
`specs/` in their entirety, already outside the census. Within bucket B,
one sentence needs care rather than translation: `docs/mutation-testing.md`
§2 is a dated findings record (#178, 2026-08-24) whose Q2 verdict reads
"Symlinking `node_modules` eliminates npm install overhead". The minimal
truthful edit is to drop the tool name — "install overhead" — because the
sentence is a record of a past finding, while leaving "npm" makes it a
stale claim about a tool the repo no longer runs. That file's §3 recipe is
live and gets a full translation.

The rule, so it is applicable rather than memorised: **translate anything
that instructs; leave anything that narrates a dated event; where a
narrated sentence names the tool as a live fact, remove the name rather
than rewrite the history.**

## Testing

**This work happens in the main checkout, and that is what makes local
verification honest.** The spike's sharpest finding was a false green:
`typecheck` and the full suite passed while `dotenv` and `vite` were
undeclared, because worktrees live at
`<main checkout>/.claude/worktrees/<n>` and Node's upward resolution
reached the parent checkout's flat npm `node_modules`. Docker, having no
parent, failed with `Cannot find module 'dotenv'`.

That mechanism is a property of **nesting**, not of pnpm. Verified for this
spec: walking from `/Users/ivohofland/Projects/fair.yoga` to `/` finds **no
`node_modules` at any level above it**, so the main checkout has nothing to
borrow from and a phantom import fails locally exactly as it does in the
image. Re-derive with:

```bash
d=$PWD; while [ "$d" != "/" ]; do d=$(dirname "$d"); \
  [ -d "$d/node_modules" ] && echo "FOUND: $d/node_modules"; done
```

Docker therefore remains the final gate for what it *uniquely* covers —
Prisma engine resolution under alpine, and the standalone bundle's traced
`node_modules` — rather than because local greens cannot be trusted. A
future contributor repeating this work **inside a worktree** gets the
spike's false green back, and must treat Docker as the only oracle.

Working in the main checkout costs one thing, taken deliberately with the
maintainer's authorisation: the dev server on `:3000` is stopped, and the
checkout's `node_modules` is replaced by a pnpm tree. The ~40 sibling
worktrees each carry their own flat npm `node_modules` from
`worktree:setup`, so their direct and hoisted imports keep resolving
locally and are unaffected.

Verified by this migration:

1. `docker build --target runner` and `docker build --target migrate`, both
   green. This is the acceptance gate, not a formality.
2. `pnpm run verify` — typecheck, lint, and every vitest project.
3. `--project integration` against the **standalone bundle**, not `next
   dev`, matching what CI's merge gate runs (#127).
4. `pnpm exec playwright test`.

Four mutation tests, each: break it, record the exact error text, restore,
re-verify. Mutations 1 and 2 are already done and their results are quoted
above; they are listed here because they must be re-run against the
*committed* configuration, not the probe.

| # | Mutation | Expected |
|---|---|---|
| 1 | drop `esbuild: true` from `allowBuilds`, install clean | `ERR_PNPM_IGNORED_BUILDS`, exit 1 |
| 2 | flip one hex digit of the `packageManager` hash, with `COREPACK_HOME` pointed at an empty directory | `Mismatch hashes`, exit 1 |
| 3 | change `worktree-setup.ts`'s install to a bare `pnpm install` | the census guard fails, naming that file and command |
| 4 | remove `dotenv` from `devDependencies`, reinstall, then `pnpm run build` **and** `docker build` | `Cannot find module 'dotenv'` in both |

Mutation 3 is what makes acceptance criterion 7 checkable: a guard that has
never been broken certifies nothing, and this one's predicate changed shape
rather than spelling, so passing tests are especially weak evidence.

Mutation 2 **must** use a cold `COREPACK_HOME`. Run warm, it passes while
proving nothing — as it did on the first attempt for this spec. The cache
is at `~/.cache/node/corepack` on this machine, not the macOS
`~/Library/Caches` path.

Mutation 4 proves the phantom-dependency fix is load-bearing. Because this
work happens in the main checkout it is expected to fail **locally as well
as** in Docker; a local pass here would mean the checkout is resolving
`dotenv` from somewhere unexpected, and is itself a finding worth chasing
rather than a green.

## Acceptance criteria

1. `package-lock.json` is gone; `pnpm-lock.yaml` and `pnpm-workspace.yaml`
   are committed; no `hashFiles('package-lock.json')` survives.
2. `packageManager` carries a version **and** an integrity hash, and
   mutation 2 fails as specified.
3. `pnpm install --frozen-lockfile` on a clean tree exits 0; removing an
   `allowBuilds` entry makes it exit 1 (mutation 1).
4. Both Docker targets build; mutation 3 fails as specified.
5. `pnpm run verify` is green — and "green" is load-bearing: `test` chains
   two vitest invocations with `&&`, so one red unit test means the second
   never runs and `integration` reports *nothing*, not zero failures. While
   anything earlier is red, run `pnpm exec vitest run --project integration`
   directly rather than reading a red `verify` as evidence about that tier.
6. CI is green on the pull request, including `docker-build` and the `test`
   aggregate gate.
7. `src/lib/script-install-census.test.ts` passes, and its two real
   assertions have been shown to fail against a deliberately wrong install
   command.
8. No file in bucket A or B still instructs a reader to run `npm` or `npx`;
   `docs/superpowers/**` is untouched.
9. `docs/supply-chain.md`'s commands, run as written, reproduce the numbers
   printed beside them.

## Issue closure — and where #540's acceptance list is wrong

**#533 closes as absorbed.** Its ask is a release-age cooldown plus the
machinery to stop npm silently ignoring it; `minimumReleaseAge: 10080` plus
the Dependabot cooldown delivers the control, and the entire npm-version
workaround becomes unnecessary. Its verification bar — "installing a package
published yesterday must be refused" — is met, with the nuance that pnpm
refuses at lockfile-verification time rather than at download time.

**#534 does not close.** #540's acceptance list calls it "#534
(install-script allowlist)", but that is one of four things #534 asks for:

| #534 asks for | Status under this migration |
|---|---|
| install-script set equals a committed allowlist | **absorbed**, and strengthened — `allowBuilds` + `strictDepBuilds` error on every machine, not only in CI |
| every `resolved` entry is on `registry.npmjs.org` | **not absorbed** — pnpm does not check registry host |
| every resolved entry carries an `integrity` | **not absorbed** as a check |
| `npm audit signatures` as a blocking CI step | **not absorbed** — no pnpm equivalent was found |

So the plan posts a comment on #534 recording which assertion the migration
absorbs, corrects its install-script census from seven to six (`sharp` no
longer declares one), and leaves it open scoped to the remaining three.
`docs/supply-chain.md`'s "Not yet in place" section reflects that reduced
scope. **This spec does not build those three checks**; they stay #534's
work, against a pnpm lockfile rather than an npm one.

The pull request body must therefore close #540 and #533 and say
**"#534 is unaffected"** — never the negated auto-close phrase, which
GitHub's parser matches regardless of the negation.
