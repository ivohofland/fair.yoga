# Supply chain

How dependency code gets into this repo, and what stops the wrong version
arriving. Tracking issue: **#531**.

## The rule

**Everything installs from the lockfile.** `pnpm install --frozen-lockfile`
installs `pnpm-lock.yaml` exactly and fails when `package.json` disagrees
with it. A bare `pnpm install` reconciles instead — it may resolve a range
afresh against the registry, and it may rewrite the lockfile.

The flag is written explicitly everywhere it appears, never left to pnpm's
default. pnpm turns `--frozen-lockfile` on by itself only when the `CI`
environment variable is set — relying on that default would give one
command two behaviours: frozen on a runner, reconciling on a contributor's
laptop, with nothing in the command line to tell them apart.

## Where this repo installs

This census lives here rather than in a comment because it spans files that
have no single owner — a claim about `Dockerfile` written in a test file is
invalidated by an edit its author never sees. Re-derive it with:

```bash
grep -rnE 'pnpm +(install|i|add|update|up|import)\b' \
  Dockerfile .github/workflows README.md AGENTS.md scripts src/lib \
  --exclude='*.test.ts' | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|#)'
```

Both filters are load-bearing. Without `--exclude`, the census test file's
fixtures and docblock dominate the output; without the second `grep`, every
comment discussing a command counts as running one.

**The second filter is anchored, and that anchor is the whole point.** An
unanchored `:[[:space:]]*(//|\*|#)` matches a colon *anywhere* on the line, so
`https://` matches it — and a real
`RUN pnpm install --registry https://registry.npmjs.org` would vanish from the
census meant to reveal it. That is not hypothetical: this file shipped the
unanchored version first, back when the command it protected was `npm`'s.
Checking a filter against today's output only shows it keeps what is already
there; feed it a line it must **not** drop.

Measured 2026-09-10, the command returns **9 lines — 8 invocations, plus the
`console.log` in `scripts/worktree-setup.ts` that names the call on the line
below it**:

| Where | Invocations | Notes |
|---|---|---|
| `.github/workflows/ci.yml` | 5 | one each in `checks`, `test-components`, `test-unit`; `test-integration` has two — one before its integration-test phase, one before its end-to-end phase; `docker-build` checks out without installing, and the `test` aggregate gate does neither |
| `.github/workflows/e2e-flake-repro.yml` | 1 | manual-dispatch only |
| `Dockerfile` | 1 | in the `deps` stage (lines 8-19); `build` and `migrate` are `FROM deps` and inherit the layer rather than re-running it |
| `scripts/worktree-setup.ts` | 1 | the only one in imperative code, and the only one a test enforces |

**`README.md` and `AGENTS.md` are absent from this table, and not because
they stopped installing anything.** Both still instruct `npm ci` — this
migration has not reached them yet, so as written today they would fail
outright: `package-lock.json` no longer exists in this tree. That conversion
is separate, ongoing work under #540; this table only re-derives the
automated and imperative paths, which are already pnpm-only. Nothing checks
the two documentation sites mechanically — a `grep` in a contributor's head
is what maintains them, which is why the command above is here rather than
the number alone, and why this file said `npm install` (not even `npm ci`)
until #532 the last time the two drifted apart.

## What is enforced, and what is not

`src/lib/script-install-census.test.ts` fails the build when imperative code
under `scripts/` or `src/lib/` runs an install that is not
`pnpm install --frozen-lockfile`. Unlike `npm ci`, pnpm's lockfile-exact
install is a **flag**, not a subcommand, so the guard's predicate has two
parts: the command must start with the install family
(`install`/`i`/`add`/`update`/`up`/`import`), restricted further to
`install`/`i`, **and** `--frozen-lockfile` must appear somewhere after it.
Either half missing is a violation — a bare `pnpm install` fails it exactly
as a `pnpm add` would.

It parses each file and reads the command out of `child_process`-shaped
calls, including the argv form (`spawnSync('pnpm', ['install',
'--frozen-lockfile'])`, which `worktree/dev-server.ts` uses for `pnpm exec`).
Its own docblock states what it cannot see — a renamed or injected callee, an
interpolated command, a command whose `pnpm` is not immediately followed by
the subcommand, anything inside a shell script, and any install a dependency
performs itself.

Nothing enforces the declarative paths (`Dockerfile`, the workflows) or the
documentation — only a reviewer reads them. They were correct when measured;
the table above and its command are what make a regression visible.

## What pnpm enforces that nothing did before

Two settings, both live only in `pnpm-workspace.yaml` and read **nowhere
else** — not in `.npmrc` (kebab-case or camelCase), not under `package.json`'s
`pnpm` key. Nothing under `npm ci` had an equivalent to either.

**`minimumReleaseAge: 10080`** (seven days, in minutes) rejects a lockfile
that resolves any package to a version published more recently than the
cutoff. It is a **lockfile policy verification, not a download gate** — the
distinction matters because it decides what the setting actually protects
against. Measured by deliberately setting the cutoff far enough back that
every resolved version violates it (`minimumReleaseAge: 5256000`, ~10 years)
and running `rm -rf node_modules && pnpm install --frozen-lockfile`: pnpm
prints `Verifying lockfile against supply-chain policies (688 entries)...`,
clones every package into the content-addressable virtual store
(`node_modules/.pnpm` — 574 directories, hundreds of megabytes, confirmed
on disk), and only *then* fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`,
naming all 677 rejected entries. Crucially, the root-level `node_modules/`
never gets its package symlinks (`node_modules/next` etc. do not exist
afterward) and no lifecycle script runs — so nothing is *importable*, but the
package contents themselves are already unpacked on disk before the command
exits 1. Sufficient for a CI gate, which only reads the exit code; **not**
what stops a fresh dependency's install-time code from executing on a
contributor's own machine.

**`strictDepBuilds` (default `true`) + `allowBuilds`** is what stops that.
Any dependency that reaches this repo with a build/install script and no
entry in `allowBuilds` **errors the install** — on a laptop, not only in CI.
`allowBuilds` currently grants six packages: `@prisma/client`,
`@prisma/engines`, `esbuild`, `fsevents`, `prisma`, `unrs-resolver`.

Re-derive the set pnpm actually requires — not the same as reading the
allowlist back to itself — with a clean install against an emptied map
(`allowBuilds: {}`; an *incremental* install won't re-flag packages already
built, so `node_modules` must go first):

```bash
rm -rf node_modules && pnpm install --frozen-lockfile
```

Measured against today's lockfile, this blocks **five** packages, reported
both in the error (`Ignored build scripts: @prisma/client@6.19.3,
@prisma/engines@6.19.3, esbuild@0.28.1, prisma@6.19.3, unrs-resolver@1.11.1`)
and afterward in `node_modules/.modules.yaml`'s `ignoredBuilds` array.
**`fsevents` is not among them.** Both versions this lockfile resolves
(`2.3.2`, `2.3.3`) declare no `install`/`preinstall`/`postinstall` script and
ship a prebuilt native binary, so pnpm's own build-script detector does not
gate it on this platform — its `allowBuilds` entry is a harmless no-op today,
not a live requirement.

The six-package figure traces back to npm's `package-lock.json`, whose
`hasInstallScript` census this repo used before the migration. **It was six,
not the seven #534's body claims** (`sharp` was in that count but declares no
install script): `package-lock.json` had 9 `hasInstallScript` entries, minus
1 for this repo's own root (`postinstall: prisma generate`), minus 2 for
`fsevents`'s nested duplicate resolutions, leaves 6. That census has no
direct pnpm equivalent — `pnpm-lock.yaml` does not carry a per-package
install-script marker the way `package-lock.json` did — which is why the
re-derivation above runs the install itself rather than reading a lockfile
field.

Placeholder values fail closed, and there is no filesystem check that can
substitute for actually running the install. Setting a single package's
value to the exact placeholder text pnpm itself writes (see below) —
`esbuild: set this to true or false` — and reinstalling clean reproduces the
same `ERR_PNPM_IGNORED_BUILDS`, naming only that package
(`Ignored build scripts: esbuild@0.28.1`), exit 1. Setting it to `esbuild:
true` installs clean, exit 0. **There is no filesystem oracle for this on
arm64**: the optional `@esbuild/darwin-arm64` package ships esbuild's native
binary (`bin/esbuild`) regardless of whether esbuild's own script ran — it is
present in `node_modules/.pnpm/@esbuild+darwin-arm64@0.28.1` either way. The
exit code is the only contract; checking whether a binary exists on disk
proves nothing.

**pnpm 12 writes to this file itself during a blocked install.** Running
`pnpm install --frozen-lockfile` with `allowBuilds` emptied does not just
fail — it rewrites `pnpm-workspace.yaml`, inserting a placeholder line per
blocked package: `<pkg>: set this to true or false`. A reader unfamiliar
with this will reasonably read the diff as tampering; it is pnpm's own
prompt for a decision, surfacing every implicated package by name so the
maintainer only has to change `set this to true or false` to `true` or
`false`. (One implementer on this migration saw exactly this diff and
raised it as a suspected injection — the caution was right, the conclusion
was not.)

**Neither setting is fully tethered, but not in the way that might be
assumed.** A setting placed in the **wrong file** gets nothing at all:
`.npmrc`'s `strict-dep-builds=false`, sitting next to a repo that also has
`esbuild` unapproved in `pnpm-workspace.yaml`, changes nothing — the install
still fails with `ERR_PNPM_IGNORED_BUILDS` for `esbuild`, no warning that the
`.npmrc` line was ever read. A **mistyped top-level key inside
`pnpm-workspace.yaml`**, on the other hand, is caught immediately: both a
near-miss (`minimumReleaseAg`) and a nonsense key
(`totallyMadeUpSetting`) make pnpm refuse to run at all —
`ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS`, naming the key and, for the
near-miss, suggesting the correct spelling — exit 1, before any install
step runs. A mistyped **package name inside `allowBuilds`** (`esbulid` for
`esbuild`) gets no such diagnostic — pnpm doesn't recognise it as an unused
key, it just never grants the real package permission, which still fails
closed (`ERR_PNPM_IGNORED_BUILDS` naming `esbuild`), just without a hint that
the cause was a typo rather than an intentional omission. So the honest
summary is: a mistake *inside* the right file is either caught by pnpm's own
schema validation (top-level keys) or fails safe by default (an unrecognised
`allowBuilds` entry); a mistake of **placement** — the right setting in the
wrong file — is invisible to everyone. The mutation tests above are what
prove any of this live; the file's mere existence proves nothing.

## Known advisories, and why the audit step does not block

`ci.yml` runs `pnpm audit --audit-level=high` with `continue-on-error: true`.
The census belongs here rather than beside that step for the same reason the
install census does: what it counts lives in `pnpm-lock.yaml`, and a new
advisory published against an unchanged tree falsifies it without anyone
editing the workflow.

**`pnpm audit --json` returns npm's *v6* audit shape, not v7+'s.** Top level
is `{ advisories, metadata }`, where `advisories` is keyed by numeric
advisory id — there is no top-level `vulnerabilities` object to iterate, so
the old one-liner's `Object.entries(j.vulnerabilities)` throws `TypeError`
on `undefined` rather than reporting zero. Re-derive with:

```bash
pnpm audit --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s);
  console.log(JSON.stringify(j.metadata.vulnerabilities));
  for (const a of Object.values(j.advisories))
    console.log(a.module_name, a.severity, a.vulnerable_versions, "->", a.patched_versions);});'
```

Add `--prod` for the production dependency tree (pnpm's equivalent of npm's
`--omit=dev`); `--audit-level` is also supported and is what `ci.yml` uses.

**`metadata.vulnerabilities` and npm v7+'s field of the same name count
different things — confirmed, not assumed.** Measured 2026-09-10: the whole
tree returns `{moderate:4, high:11, critical:0}`, summing to **15**, which is
exactly `Object.values(advisories).length`. pnpm's count is **one entry per
(package, advisory) pair** — `brace-expansion` alone contributes 5 of the 15,
one for each distinct GHSA against it across two resolved major versions, and
`js-yaml` and `browserslist` each contribute 2. npm v7+'s `vulnerabilities`
object, by contrast, is *keyed by package name* (`Object.entries` over it, as
this file's previous one-liner did) — structurally one entry per distinct
vulnerable package, however many advisories affect it. This is why this
document's previous measurement (npm, 2026-09-09) read **12** against today's
**15**: not three new advisories on an unchanged tree, but two things at
once — a different denominator (9 distinct packages are flagged today, not
12), *and* a genuinely different vulnerable set than a day earlier. The
`prisma`/`@prisma/config` advisory that dominated the old production table is
gone entirely from today's output (no finding at any severity), while
`brace-expansion` and `js-yaml` — absent from the old table — now carry fresh
GHSAs against both. Advisory databases change under an unchanged lockfile;
that is the whole reason this census lives here rather than in a comment.

Add `--prod` for the production dependency tree. Measured 2026-09-10: `{
moderate: 1, high: 4, critical: 0 }`, summing to **5** — this figure agrees
with the npm-era measurement's production count exactly (1 moderate + 4
high), even though the whole-tree number moved.

**`--prod` is a proxy for "could plausibly execute at runtime somewhere", not
a description of any image this repo builds.** Neither of the two stages
that ship matches it:

- The `runner` stage (`Dockerfile:43-57`) is **narrower**. The only
  `node_modules` it gets is the one inside `.next-build/standalone`, which
  Next populates by tracing actual imports — so it holds far less than the
  production dependency tree. (It copies two other trees,
  `.next-build/static` and `public`; neither carries dependencies. This repo
  has never tracked a `public/` of its own — icons are Next's file-based
  `app/icon.svg` convention instead — so the `build` stage creates one empty
  before the copy; #543 has the history.)
  Check what is really in it with
  ```bash
  for p in nanoid baseline-browser-mapping postcss prisma @prisma/config deepmerge-ts browserslist @babel/core; do
    [ -d ".next-build/standalone/node_modules/$p" ] && echo "$p present" || echo "$p absent"
  done
  ```
  after a build — every one of them, `browserslist` and `@babel/core`
  included, comes back `absent`.
- The `migrate` stage (`Dockerfile:37`) is **wider**. It is `FROM deps`, i.e.
  the same frozen `pnpm install --frozen-lockfile` as the `deps` stage with
  nothing filtered out, so it ships the entire tree — every devDependency
  included.

Read `--prod` as "could plausibly execute at runtime somewhere", and check
the image when the answer matters. `browserslist` is the case in point this
measurement turned up: it now shows up under `--prod` at all only because
`next` (a production dependency) ships `styled-jsx`, which declares
`@babel/core` as an *optional* peer dependency — `peerDependenciesMeta:
{ "@babel/core": { "optional": true } }` — and pnpm links that peer to the
`@babel/core` already present for the eslint/babel devDependency toolchain.
`pnpm why browserslist --prod` shows the resulting chain: `next → styled-jsx
→ @babel/core → @babel/helper-compilation-targets → browserslist`. Nothing on
that chain is a hard runtime dependency of `next`'s own code, and the
standalone-image check above confirms it: `browserslist` never reaches the
image that actually ships. It is exactly the situation this section already
warns about, from a fresh package.

**In the production dependency tree** — none is a direct *production*
dependency; all four packages arrive through one:

| Package | Reached through | Forward fix |
|---|---|---|
| `deepmerge-ts` | `@prisma/client` → `prisma` → `@prisma/config` (also directly via the `prisma` devDependency) | **None.** `@prisma/config@6.19.3` pins `deepmerge-ts` to the **exact** version `7.1.5` (no range), and the patched version is `>=8.0.0` — no lockfile refresh can satisfy an exact pin |
| `nanoid` | `postcss` (pulled in by `@tailwindcss/postcss`, `next`, and `vite`) | `pnpm update nanoid` — `postcss` declares `nanoid: ^3.3.16`, and the patched `3.3.18` satisfies that range; the committed lockfile is simply stale |
| `browserslist` | `next` → `styled-jsx` → `@babel/core` (optional peer) → `@babel/helper-compilation-targets`; also via `update-browserslist-db` | `pnpm update browserslist` — both dependents' declared ranges (`^4.24.0`, `>=4.21.0`) already admit the patched `4.28.7` |
| `baseline-browser-mapping` | `next` (direct) | `pnpm update baseline-browser-mapping` — `next` declares `^2.9.19`, which admits the patched `2.11.0` |

Re-derive the "reached through" column with `pnpm why <package> --prod`, and
the dev-only paragraph below with `pnpm why <package> --dev` — these edges
rot faster than the totals do, and this table has already replaced one
entirely (the `prisma`-rooted trio is gone; `browserslist` is new here).

The last three are stale lockfile resolutions, not constrained versions, and
the distinction decides the fix, same as it did under npm — only `pnpm audit`
carries no `fixAvailable` object to read that distinction off directly, so it
is re-derived by hand: compare each dependent's declared range (from its own
`package.json` inside `node_modules/.pnpm`) against the advisory's
`patched_versions`. `deepmerge-ts` is the one case where that comparison
fails — an exact pin, not a range — which is what makes it, alone among the
four, a "no forward fix" entry. An `overrides` block would work for the other
three and is the wrong tool regardless: heavier, and pinned against a range
that will drift.

**Dev-only** — `brace-expansion` (two resolved major versions, both entirely
inside the eslint/typescript-eslint toolchain), `js-yaml` and `@humanfs/node`
(both through `eslint` directly), `vitest` and `@vitest/mocker` (direct
devDependencies, sharing one advisory — a path-traversal / arbitrary-file-read
via `@vitest/mocker`'s redirect mock, GHSA-82fw-gwwq-j7x9). They run against
this repo's own source on a developer's machine and on CI, and every advisory
among them needs hostile input fed to the tool — which here would mean this
repo's own files. Mostly denial-of-service, though not only:
`@humanfs/node`'s GHSA-p498-v437-472g is a symlink escape during a recursive
copy.

So the step reports real things, and none of them is a reason to stop a pull
request that did not cause them. What would change that: an advisory against
a package this app's *request path* actually executes, or any critical.
Either is a reason to fix rather than to note.

## Not yet in place

The controls that would keep a *compromised* version out, rather than an
unchosen one, are open work.

**#533 (a release-age cooldown) is absorbed** — `minimumReleaseAge` above is
exactly that control, so it leaves this list.

**#534 remains open, scoped to the three of its four asks pnpm does not
cover.** Its install-script half is absorbed and strengthened: `allowBuilds`
+ `strictDepBuilds` is a committed allowlist that errors on every machine, not
only in CI, which is more than #534 originally asked for. What is still
missing: pinning every `resolved` entry to `registry.npmjs.org`, checking
every resolved entry carries an `integrity` hash, and running
`npm audit signatures` (or an equivalent) as a blocking CI step — no pnpm
equivalent to that last one was found during this migration.

**#535 (commit-pinned GitHub Actions)** is unaffected by this migration and
stays open. See #531.
