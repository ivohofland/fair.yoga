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

### The door npm did not have

**pnpm installs as a side effect of running something.** `npm run` and `npx`
installed nothing, ever. `pnpm run` and `pnpm exec` first reconcile
`node_modules` against `package.json` whenever the two disagree, and that
reconcile is a plain install — not `--frozen-lockfile` unless `CI` is set. So
a contributor who pulls a branch that bumps a dependency and types `pnpm run
dev`, `pnpm test` or `pnpm exec prisma migrate dev --name x` resolves against
the registry and **rewrites the committed `pnpm-lock.yaml`**, silently, with
`RAN`-style success output and exit 0 — past `minimumReleaseAge`, past the
explicit flag above, and into their next commit. It is exactly the hazard the
explicit `--frozen-lockfile` exists to prevent, arriving through a door no
`npm` command had.

`verifyDepsBeforeRun: error` in `pnpm-workspace.yaml` closes it: pnpm compares
the two, refuses to run, and installs nothing. Reproduce both halves against a
clean tree — `git archive HEAD | tar -x -C "$T"`, then `pnpm install
--frozen-lockfile` in `$T` — and drop a devDependency:

```bash
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));
  delete p.devDependencies["pino-pretty"];
  fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'
grep -c pino-pretty pnpm-lock.yaml     # 3 before either run
pnpm exec node -e 'console.log("RAN")'; echo "exit=$?"
grep -c pino-pretty pnpm-lock.yaml
```

Measured 2026-09-10 under pnpm 12.3.4. **Without the setting**: pnpm
reconciles, reruns `postinstall` (`prisma generate`), prints `RAN`, **exit
0** — and the count goes `3 → 0`, the lockfile rewritten. **With
`verifyDepsBeforeRun: error`**: nothing runs and nothing installs, the count
stays `3`, and the output is

```
Error: ERR_PNPM_VERIFY_DEPS_BEFORE_RUN

  × a modified manifest is no longer satisfied by the lockfile
  help: Run "pnpm install"
```

**exit 1**. The other spelling of the same refusal — `× Cannot check whether
dependencies are outdated` — is what a checkout with no `node_modules` at all
answers, so the setting also turns "forgot to install" into a named error
instead of a missing-binary one.

The cost is that every `pnpm run`/`pnpm exec` now demands a `node_modules`
consistent with `package.json`. **CI does not pay it**: every job installs
before its first `pnpm run`/`pnpm exec` — *Where this repo installs* below
derives that ordering with a command — the bootstrap steps ahead of the
install run only `pnpm --version` and `pnpm store path`, neither of which is
`run` or `exec`, and `Dockerfile`'s `build` and `migrate` stages are
`FROM deps`, which installed. That those two are ungated is measured, not
assumed: against a checkout with no `node_modules` at all
(`git archive HEAD | tar -x -C "$T"`), both answer exit 0 while
`pnpm exec node -e 'console.log(1)'` in the same tree exits 1 with
`ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`.

**A FRESH WORKTREE DOES PAY IT**, and that is the case worth knowing. It has
no `node_modules`, so `pnpm run worktree:setup` — the script whose whole job
is to create one — refuses to start:

```
Error: ERR_PNPM_VERIFY_DEPS_BEFORE_RUN

  × Cannot check whether dependencies are outdated
  help: Run "pnpm install"
```

exit 1. Under npm the same sequence worked by accident: `npm run` prepends
every **ancestor** `node_modules/.bin` to PATH, and a worktree living inside
the main checkout inherited the parent's binaries. pnpm's deps check fires
first, before anything is on PATH to inherit. So `pnpm install
--frozen-lockfile` is written as the explicit first step everywhere this repo
records the sequence — `.claude/skills/verify/SKILL.md`,
`.claude/skills/solve-issue/SKILL.md`, `docs/test-database.md` §5, and
`AGENTS.md`'s mutation-probe recipe, which already had that shape. The
install inside `scripts/worktree-setup.ts` stays: a second run is a 45ms
no-op, and it is the only call site `src/lib/script-install-census.test.ts`
enforces.

The other tree that pays it is one someone shares `node_modules` into rather
than installing — see `docs/mutation-testing.md` §3, where that recipe no
longer holds.

## Where this repo installs

This census lives here rather than in a comment because it spans files that
have no single owner — a claim about `Dockerfile` written in a test file is
invalidated by an edit its author never sees. Re-derive it with:

```bash
grep -rnE 'pnpm +(install|i|add|update|up|import)\b' \
  Dockerfile .github README.md AGENTS.md .claude/skills docs/test-database.md \
  scripts src/lib \
  --exclude='*.test.ts' | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|#)'
```

**The path list is `.github`, not `.github/workflows`.** The CI install moved
out of the workflows and into `.github/actions/setup-pnpm/action.yml`, and a
census scoped one directory too narrowly would have reported the install
disappearing rather than moving. Same reason `.claude/skills` and
`docs/test-database.md` are here: those three sites instruct the worktree
install (*The door npm did not have*, above), so they run one as surely as
`README.md` does.

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

Measured 2026-09-10, the command returns **10 lines — 9 invocations, plus the
`console.log` in `scripts/worktree-setup.ts` that names the call on the line
below it**:

| Where | Invocations | Notes |
|---|---|---|
| `.github/actions/setup-pnpm/action.yml` | 1 | **the whole of CI's installing.** Six jobs call this composite action; it is one install written once, not six copies of one |
| `Dockerfile` | 1 | in the `deps` stage; `build` and `migrate` are `FROM deps` and inherit the layer rather than re-running it |
| `README.md` | 1 | step 1 of local setup |
| `AGENTS.md` | 2 | the quick-start block, and the worktree probe recipe under *Mutation testing protocol* |
| `.claude/skills/verify/SKILL.md` | 1 | the worktree bootstrap's mandatory first step |
| `.claude/skills/solve-issue/SKILL.md` | 1 | the same step, in the issue workflow |
| `docs/test-database.md` | 1 | the same step, in §5 |
| `scripts/worktree-setup.ts` | 1 | the only one in imperative code, and the only one a test enforces |

Which job owns which install is a separate claim from how many there are, and
the census line above cannot answer it: an install carries no job name, only
a line number a hundred lines below the `jobs:` key it belongs to. Since the
install moved into a composite action, the thing to order per job is the call
to that action. This does it, and it answers the ordering question in the
same pass:

```bash
awk 'FNR == 1                { job = "-" }
     /^  [a-z][a-z0-9-]*:$/  { job = $1; sub(/:$/, "", job) }
     /^[[:space:]]*#/        { next }
     /uses: \.\/\.github\/actions\/setup-pnpm/ { print FILENAME ":" FNR "\tSETUP-ACTION\t" job }
     /(^|[^[:alnum:]._-])pnpm[[:space:]]/ {
       if ($0 ~ /pnpm[[:space:]]+(install|i|add|update|up|import)([[:space:]]|$)/) kind = "INSTALL"
       else kind = "pnpm-call"
       print FILENAME ":" FNR "\t" kind "\t" job
     }' \
  .github/workflows/ci.yml .github/workflows/e2e-flake-repro.yml \
  .github/actions/setup-pnpm/action.yml
```

**The pattern is every `pnpm ` call, not `pnpm (run|exec|dlx) `.** The
narrower one was blind to the bootstrap's own `pnpm --version` and `pnpm
store path` — which is to say, blind to exactly the two calls that decide
whether the ordering argument below holds. A filter that cannot see the step
it exempts is not evidence about that step. Comment lines are skipped
instead, and the action file's own `description:` prose contributes one row
of noise that is neither.

Measured 2026-09-10: `SETUP-ACTION` at `ci.yml` lines 49, 95, 136, 214 and
316 — `checks`, `test-components`, `test-unit`, `test-integration`,
`test-e2e` — and `e2e-flake-repro.yml:118` in `repro`; in every one of the
six it precedes that job's first `pnpm-call` row. Inside the action itself
the only `INSTALL` row is line 88, and every `pnpm-call` row above it is the
`pnpm --version` / `pnpm store path` bootstrap or one of the two shell guards
quoting them. That ordering is what makes `verifyDepsBeforeRun: error` (see
*The rule*) cost CI nothing.

**The documentation sites are in this table too.** #540 converted `README.md`
and `AGENTS.md` to `pnpm install --frozen-lockfile`, and the worktree
bootstrap added three more, so the grep above finds them all the same way it
finds every other path. Nothing checks them mechanically, though — a `grep`
in a contributor's head is what maintains them, which is why the command is
here rather than the number alone, and why this file said `npm install` (not
even `npm ci`) until #532 the last time the two drifted apart. A line-wrapped
instruction is the failure mode to watch: `docs/test-database.md`'s went
missing from this census the moment `pnpm` and `install` landed on separate
lines.

## What pnpm's node_modules layout changes

**A top-level `node_modules` now resolves only DIRECT dependencies.** pnpm
links just what `package.json` declares into `node_modules/`; everything
transitive lives in `node_modules/.pnpm` and is reachable only from the
package that asked for it. npm hoisted the lot, so a bare `require('x')`
against the repo's `node_modules` used to work for packages nothing here
declares.

This bites scripts run from outside the repo with
`NODE_PATH=<repo>/node_modules`. Measured 2026-09-10 from `/tmp`:

```bash
for m in playwright @playwright/test @prisma/client typescript; do
  NODE_PATH=/path/to/fair.yoga/node_modules \
    node -e "try{require.resolve('$m');console.log('$m RESOLVES')}catch(e){console.log('$m '+e.code)}"
done
```

`@playwright/test`, `@prisma/client` and `typescript` resolve — all three are
in `package.json`. Bare `playwright` answers `MODULE_NOT_FOUND`: it is
`@playwright/test`'s dependency, not this repo's. Spell the direct package,
or install the tool where the script lives.

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
calls, including the argv form — `spawnSync('pnpm', ['install',
'--frozen-lockfile'])`, where the subcommand sits outside the first argument.
Matching is by callee **name**, though, and that bounds the coverage. The one
argv-shaped **`pnpm`** call this repo has is invisible to the guard:

```bash
grep -rnE "(exec|execSync|execFile|execFileSync|spawn|spawnSync|[A-Za-z]+Fn)\('[^']+', \[" \
  scripts src/lib --include='*.ts' --exclude='*.test.ts'
```

Measured 2026-09-10, three hits. Two are `side-effects.ts`'s `execFileSync`
calls to `lsof` and `ps` — argv-shaped, but their callee **is** on the list,
so the guard sees them fine and drops them only because `lsof` is not an
install. The third, `dev-server.ts:17`, is the invisible one, and it escapes
three separate ways: its callee is an injected `spawnFn` parameter, that
parameter's default is a renamed import, and `pnpm exec` is not
install-family in the first place. The test's own docblock is the authority
on the rest of the blind spots — a renamed or injected callee, an
interpolated command, a command whose `pnpm` is not immediately followed by
the subcommand, `pnpm dlx`, anything inside a shell script, and any install a
dependency performs itself.

`src/lib/pnpm-policy.test.ts` is the second guard, and it covers what CI
cannot. Three of the four settings below are gated by CI as a by-product of
what CI does; `verifyDepsBeforeRun` is not and structurally cannot be, because
every job installs before its first `pnpm run` — the very ordering that makes
the setting free. Delete the line and CI stays green. Worse, pnpm reads these
settings only from `pnpm-workspace.yaml`: moved into a `.npmrc` or under
`package.json`'s `pnpm` key they are ignored with no diagnostic, which is
what a contributor who hits `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` and relocates
them plausibly does. So that test asserts presence, values, and the absence of
both wrong homes, in one comparison that reports the whole object.
`src/lib/lockfile-policy.test.ts` reads a real committed file the same way —
see below for what it guards and why its own gap is different from the four
settings here.

Nothing enforces the declarative paths (`Dockerfile`, the workflows) or the
documentation — only a reviewer reads them. They were correct when measured;
the table above and its command are what make a regression visible.

**`src/lib/lockfile-policy.ts` enforces the registry-source and
integrity-hash checks #534 asked for** — every `pnpm-lock.yaml` package
resolves from the plain registry (no git/tarball/local source), and every
resolution carries an integrity hash — by reading the
lockfile directly rather than a `pnpm-workspace.yaml` setting. It parses the
lockfile's two concatenated YAML documents (see *The two-document lockfile,
and why Dependabot still reads it*, below) and flags any package whose
resolution is missing `integrity` or carries a git/tarball/local-source
marker instead of a plain registry one. `scripts/check-lockfile.ts` runs it
as `pnpm run check-lockfile`, a blocking step in `ci.yml`'s `checks` job.

**Why "pin to `registry.npmjs.org`" became "reject a non-registry resolution
shape".** The issue's original ask was written against npm's
`package-lock.json`, where every entry carries a literal `resolved:
"https://registry.npmjs.org/..."` URL. `pnpm-lock.yaml` v9 has no such field
for a plain registry entry — the registry is implicit, and the only way an
entry can name a *different* source is via one of the markers
`NON_REGISTRY_MARKERS` checks for in `src/lib/lockfile-policy.ts` (a
git-hosted, tarball-URL, or local-directory shape). Measured by adding a
`github:`-sourced dependency to a scratch project; pnpm wrote:

```yaml
lodash@https://codeload.github.com/lodash/lodash/tar.gz/f299b52f39486275a9e6483b60a410e06520c538:
  resolution: {gitHosted: true, integrity: sha512-efBiOJ+8VBM1YBhMBYwxS694ynOHtSIe8zadaogd9mpQ7NZ0m5wtGY1j2N2csRA26uVp7Kfuci1QIPP7HQZLZg==, tarball: https://codeload.github.com/lodash/lodash/tar.gz/f299b52f39486275a9e6483b60a410e06520c538}
```

Banning every such marker is the exact structural proxy this lockfile format
allows for "pinned to the registry".

Measured 2026-09-10 against the committed lockfile: **697 entries** (9 in the
`packageManagerDependencies` document, 688 in the app-graph document — the
same 697 total `pnpm audit signatures` reports), **zero violations**.
Re-derive the aggregate with `pnpm run check-lockfile`; re-derive the 9/688
split itself, independently of the checker, by counting `resolution:` lines
per `---`-delimited document:

```bash
awk '/^---$/{n++; next} /resolution:/{c[n]++} END{for (i=1;i<=n;i++) print "doc" i ":", c[i]+0}' pnpm-lock.yaml
```

The checker was mutation-tested three ways: replacing one entry's resolution
with a `tarball:` pointing off-registry (caught, reported as
`non-registry-source` naming the mutated package); reshaping the `packages:`
section itself — renaming the header and, separately, reindenting one
entry's key line — to simulate a future pnpm lockfile-format change the
parser can no longer read (both silently dropped entries rather than
erroring); and truncating the file to nothing, which drives both the parsed
count and a naive raw count of `resolution:` lines to zero at once — the one
case in which a raw-count comparison alone agrees with the parser and hides
the failure.

`checkParserCoverage` (`src/lib/lockfile-policy.ts`) is the exported,
unit-tested function `scripts/check-lockfile.ts` calls to guard against all
three. It counts lines containing the literal string `resolution:`
independently of the parser, and reports `ok: false` whenever
`parsePackageResolutions` returns fewer entries than that raw count (the
format-drift case above) — or fewer than `MIN_EXPECTED_LOCKFILE_ENTRIES`
(100), the floor that catches the all-the-way-to-zero case a raw-count
comparison by itself cannot, since an empty or `packages:`-less lockfile
parses to zero entries and a naive count over the same text also lands on
zero. The same per-entry gap the raw count already covered still holds — a
`resolution:` line matched while no key is pending is dropped by the parser
rather than counted, and the raw count still includes the orphaned line, so
the mismatch still fires.

`src/lib/lockfile-policy.test.ts` also reads this real lockfile directly (the
same pattern `src/lib/pnpm-policy.test.ts` uses for `pnpm-workspace.yaml`,
above) and asserts a floor of `MIN_EXPECTED_LOCKFILE_ENTRIES` on the entry
count plus zero violations, alongside dedicated `checkParserCoverage` tests
covering the real lockfile (`ok: true`), an empty one (`ok: false`), and an
entry count that is nonzero but still under the floor (`ok: false`). Its gap
is narrower than the four `pnpm-workspace.yaml` settings' guard, though:
`check-lockfile` already runs as its own blocking CI step, so this test
isn't covering something CI structurally can't reach. What it adds is
permanence — the mutation testing above is what first proved the parser
reads the real file's format correctly, and these tests are what keep that
proof standing on every `pnpm test` rather than leaving it a claim about a
run nobody can rerun.

**Signature verification is a blocking CI step, not just an available
capability.** `pnpm audit signatures` runs in `ci.yml`'s `checks` job — the
signature-verification step #534 asked for. Measured 2026-09-10: `audited
697 packages` / `697 packages have verified registry signatures`, exit 0 —
same count as above, since it audits every installed package. Unlike `pnpm
audit --audit-level=high` next to it, this reports a property of the
packages actually locked rather than the state of an advisory database, so
it blocks without going red on a PR that didn't touch dependencies —
barring a registry outage or rate-limit, since unlike the lockfile-shape
check above, this step fetches signature data over the network.

## What pnpm enforces that nothing did before

Four settings, all of them living only in `pnpm-workspace.yaml` and read
**nowhere else** — not in `.npmrc` (kebab-case or camelCase), not under
`package.json`'s `pnpm` key. Nothing under `npm ci` had an equivalent to any
of them. `verifyDepsBeforeRun: error` is covered under
[The rule](#the-rule) above, beside the hazard it closes; the other three are
here.

**`minimumReleaseAge: 10080`** (seven days, in minutes) rejects a lockfile
that resolves any package to a version published more recently than the
cutoff. It is a **lockfile policy verification, not a download gate** — the
distinction matters because it decides what the setting actually protects
against. Measured by deliberately setting the cutoff far enough back that
every resolved version violates it (`minimumReleaseAge: 5256000`, ~10 years)
and running `rm -rf node_modules && pnpm install --frozen-lockfile`: pnpm
prints `Verifying lockfile against supply-chain policies (688 entries)...`,
clones every package into the content-addressable virtual store
(`node_modules/.pnpm` — 572 directories, hundreds of megabytes, confirmed on
disk with `ls node_modules/.pnpm | wc -l` in exactly that blocked state), and
only *then* fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`:
`677 lockfile entries failed verification`, of which it prints **20 by name
and then `…and 657 more`**. The count is diagnostic; the listing is not, so
a real violation is read off the twenty that happen to sort first. Crucially,
the root-level `node_modules/`
never gets its package symlinks (`node_modules/next` etc. do not exist
afterward) and no lifecycle script runs — so nothing is *importable*, but the
package contents themselves are already unpacked on disk before the command
exits 1. Sufficient for a CI gate, which only reads the exit code; **not**
what stops a fresh dependency's install-time code from executing on a
contributor's own machine.

**`strictDepBuilds: true` + `allowBuilds`** is what stops that. Any
dependency that reaches this repo with a build/install script and no entry in
`allowBuilds` **errors the install** — on a laptop, not only in CI.
`allowBuilds` grants five packages, and every one of them is live:
`@prisma/client`, `@prisma/engines`, `esbuild`, `prisma`, `unrs-resolver`.

**`strictDepBuilds` is written out rather than left to the default**, for the
reason the census guard's docblock gives about `--frozen-lockfile`: a default
is a claim about pnpm's behaviour that nothing in this repo tethers. Were it
ever false, `Ignored build scripts: …` would be a warning, the install would
exit 0, and `allowBuilds` would quietly become an advisory list. Writing it
costs nothing and fails loudly in the other direction too — because
`packageManager` is pinned, a key pnpm later renames or drops is a hard
`ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS` rather than a silent no-op. That
it is a recognised key today is measured the same way: a clean tree carrying
the line loads its config and installs, exit 0.

**`fsevents` is deliberately not in that list.** It was there — inherited
from the npm-era `hasInstallScript` census below, which counts declarations
rather than what pnpm blocks. Entries here are asymmetric: a *missing* one
fails closed
(`ERR_PNPM_IGNORED_BUILDS`, exit 1, naming the package), while a *stale* one
is a standing silent grant — pnpm emits no "unused `allowBuilds` entry"
diagnostic, so nothing would ever retire it. The day some future `fsevents`
adds a `postinstall`, an entry left in place executes it with no prompt, no
error and no diff. Removed, that same day is a failed install that names the
package and asks a person. So the list is kept to what pnpm actually blocks.

Re-derive the set pnpm actually requires — not the same as reading the
allowlist back to itself — with a clean install against an emptied map
(`allowBuilds: {}`; an *incremental* install won't re-flag packages already
built, so `node_modules` must go first):

```bash
rm -rf node_modules && pnpm install --frozen-lockfile
```

Measured 2026-09-10 against today's lockfile, this blocks **five** packages,
reported both in the error (`Ignored build scripts: @prisma/client@6.19.3,
@prisma/engines@6.19.3, esbuild@0.28.1, prisma@6.19.3, unrs-resolver@1.11.1`)
and afterward in `node_modules/.modules.yaml`'s `ignoredBuilds` array —
exactly the five `allowBuilds` grants, and `fsevents` among neither. Both
`fsevents` versions this lockfile resolves (`2.3.2`, `2.3.3`) declare no
`install`/`preinstall`/`postinstall` script and ship a prebuilt native binary,
so pnpm's own build-script detector never gates it on this platform.

Run this against a scratch tree (`git archive HEAD | tar -x -C "$T"`), not
the working checkout: `rm -rf node_modules` there takes down whatever is
running out of it, and a blocked install rewrites `pnpm-workspace.yaml` (see
below).

An earlier **six**-package figure traces back to npm's `package-lock.json`,
whose `hasInstallScript` census this repo used before the migration. **It was
six, not the seven #534's body claims** (`sharp` was in that count but
declares no install script). That lockfile is deleted at HEAD, so re-derive
it from the last commit that carried one:

```bash
git show a6758edc:package-lock.json | node -e 'let s="";process.stdin.on("data",d=>s+=d)
  .on("end",()=>{const p=JSON.parse(s).packages;
  const hits=Object.keys(p).filter(k=>p[k].hasInstallScript);
  console.log(hits.length); for (const h of hits) console.log("  ", h || "(root)");});'
```

9 entries, minus 1 for this repo's own root (`postinstall: prisma generate`),
minus 2 for `fsevents`'s nested duplicate resolutions under `tsx` and `vite`,
leaves 6. That census has no direct pnpm equivalent — `pnpm-lock.yaml` does
not carry a per-package install-script marker the way `package-lock.json`
did — which is why the re-derivation above runs the install itself rather
than reading a lockfile field.

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
with this will reasonably read the diff as tampering — an unexplained edit to
the supply-chain policy file, arriving during an install. It is pnpm's own
prompt for a decision, surfacing every implicated package by name so the
maintainer only has to change `set this to true or false` to `true` or
`false`. Restore the file and decide deliberately; do not commit the
placeholders.

**No setting here is fully tethered, but not in the way that might be
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
step runs.

**`packageManager` is what makes that a hard error rather than a `[WARN]`**,
and pnpm says so itself in the `help:` line it prints — *"The project pins
pnpm to a version the running pnpm satisfies, so these settings cannot be
meant for a different pnpm version."* Without a pin the key might belong to
some other pnpm version, and warning is the only honest answer. Isolate it on
a clean tree (`git archive HEAD | tar -x -C "$T"`), changing that one field
and nothing else:

```bash
printf '\nminimumReleaseAgeTYPO: 10080\n' >> pnpm-workspace.yaml
pnpm install --frozen-lockfile; echo "pinned exit=$?"
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));
  delete p.packageManager; fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'
corepack pnpm@12.3.4 install --frozen-lockfile; echo "unpinned exit=$?"
```

Measured 2026-09-10: pinned, `ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS`,
**exit 1**; unpinned, `[WARN] … were ignored: "minimumReleaseAgeTYPO" (did
you mean "minimumReleaseAge"?)`, **exit 0**. The second command names its
pnpm version on purpose — a bare `pnpm` there runs a *different* pnpm
(corepack falls back to its own default, 10.33.2 on this machine), which
would confound the version with the pin and prove nothing. This repo pins
`packageManager`, so its key names are tethered: a typo is a failing build,
not a silent no-op.

**The pin also decides WHICH pnpm reads this file at all, and that is the
larger stake.** Measured 2026-09-10 on a two-package scratch project carrying
`minimumReleaseAge: 5256000` and a lockfile that violates it:
`pnpm@12.3.4 install --frozen-lockfile` prints `Verifying lockfile against
supply-chain policies` and exits **1**; `pnpm@10.33.2` — corepack's own
fallback default on this machine — performs no lockfile policy verification
at all and exits **0**. (pnpm 10 does honour `minimumReleaseAge` while
*resolving* a fresh install; it is the frozen path, the one CI and every
contributor take, where it checks nothing.) The lockfile format is no
backstop either: pnpm 10 read the pnpm-12 two-document lockfile without
complaint. Nobody has to delete anything to reach that state — a standalone
or global pnpm ahead of the corepack shim on PATH will do, and its
`pnpm install --frozen-lockfile` still succeeds, so the census guard is
satisfied too. What a maintainer observes is a fully green run.
`.github/actions/setup-pnpm` therefore compares `pnpm --version` against the
pin and fails the job on a mismatch, and `src/lib/pnpm-policy.test.ts` pins
the field's shape for laptops, where no runner is checking anything.

**The two-document lockfile, and why Dependabot still reads it.** With
`packageManager` set, pnpm 12 writes `pnpm-lock.yaml` as *two* YAML documents:
the first holds `packageManagerDependencies` (pnpm itself and its `@pnpm/exe.*`
binaries), the second the real graph. pnpm 11 wrote one. That shape decides
whether an outside tool sees this repo's dependencies at all, and the failure
mode is silence rather than an error, so it is measured here rather than
assumed. Measured 2026-09-10 against the committed lockfile:

| Reader | Result |
|---|---|
| `js-yaml` `load()` (single-document) | **throws** — `expected a single document in the stream, but found more` |
| Ruby `YAML.load_file` (Psych) | **silently returns document 0** — 0 dependencies, 0 devDependencies, no error |
| `js-yaml` `loadAll()` | both; document 1 holds 12 dependencies, 24 devDependencies, 688 packages |
| pnpm's own reader (`pnpm list --depth 0 --json`) | 12 dependencies, 24 devDependencies |

Re-derive the middle two with:

```bash
ruby -ryaml -e 'd=YAML.load_file("pnpm-lock.yaml"); i=d["importers"]["."]; \
  puts "deps=#{(i["dependencies"]||{}).size} dev=#{(i["devDependencies"]||{}).size}"'
pnpm list --depth 0 --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{ \
  const j=JSON.parse(s)[0]; console.log(Object.keys(j.dependencies||{}).length, Object.keys(j.devDependencies||{}).length)});'
```

The Ruby row is the one that would have mattered, because dependabot-core is
Ruby: a parser taking document 0 reports zero dependencies with no error,
which is indistinguishable from "nothing to update" and would go unnoticed at
`interval: monthly`. **It does not take that path.**
`npm_and_yarn/lib/dependabot/npm_and_yarn/file_parser/pnpm_lock.rb` shells out
to a JavaScript helper — `SharedHelpers.run_helper_subprocess(function:
"pnpm:parseLockfile", …)` — so the file is read by pnpm's own reader, the one
that wrote the format. No Ruby YAML is involved. That is why this repo does
not need a manual Dependabot trigger after a pnpm major bump; re-check the
parser, not the calendar, if the format changes again.

**The integrity hash is verified on first download, not on every run.**
Corepack keys its cache by name and version; a `COREPACK_HOME` that already
holds the version is reused without re-comparing the hash. Measured against a
`packageManager` field whose hash was replaced with 128 zeros: with the warm
default cache, `corepack pnpm --version` prints `12.3.4`, **exit 0**, no
warning; with `COREPACK_HOME` pointed at an empty directory, the same command
fails with `Error: Mismatch hashes. Expected 000…, got 961aa41f…`, **exit
1**. CI runners and Docker build stages are always cold, so there the hash is
a real gate; a developer laptop after its first install is not. Corepack is
still the right bootstrap — `pnpm/action-setup` and `npm i -g pnpm` verify
nothing on any path.

Three environment variables switch corepack's checks off with no other
signal, which is worth knowing when reading a runner log that looks fine:
`COREPACK_ENABLE_PROJECT_SPEC=0` (ignore `packageManager` entirely — the
fallback-version path above), `COREPACK_ENABLE_STRICT=0` and
`COREPACK_INTEGRITY_KEYS=0`.

A mistyped **package name inside `allowBuilds`** (`esbulid` for
`esbuild`) gets no such diagnostic — pnpm doesn't recognise it as an unused
key, it just never grants the real package permission, which still fails
closed (`ERR_PNPM_IGNORED_BUILDS` naming `esbuild`), just without a hint that
the cause was a typo rather than an intentional omission. So the honest
summary is: a mistake *inside* the right file is either caught by pnpm's own
schema validation (top-level keys) or fails safe by default (an unrecognised
`allowBuilds` entry); a mistake of **placement** — the right setting in the
wrong file — is invisible to everyone. The mutation tests above are what
prove any of this live; the file's mere existence proves nothing.

## Known advisories, and why the advisory audit step does not block

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
(vulnerable version range, advisory) pair** — `brace-expansion` alone
contributes 5 of the 15 against just **3** distinct GHSAs, because two of
those three are reported once per resolved major version; `js-yaml` and
`browserslist` contribute 2 apiece, there from two distinct GHSAs each. So
the pairs are what the total counts, and the GHSAs are fewer — group the
`--json` output by `module_name` and by `github_advisory_id` to see both.
npm v7+'s `vulnerabilities`
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

- The `runner` stage (`Dockerfile:45-59`) is **narrower**. The only
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
- The `migrate` stage (`Dockerfile:39`) is **wider**. It is `FROM deps`, i.e.
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
inside the eslint/typescript-eslint toolchain), `@humanfs/node` (through
`eslint` directly) and `js-yaml` (through `@eslint/eslintrc` → `eslint`),
`vitest` (a direct devDependency) and `@vitest/mocker` (not one: it arrives
through `vitest` and `@vitest/coverage-v8`, which are), the last two sharing
one advisory — a path-traversal / arbitrary-file-read via `@vitest/mocker`'s
redirect mock, GHSA-82fw-gwwq-j7x9. They run against
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

**#534 is now absorbed** — enforced by `src/lib/lockfile-policy.ts` and two
blocking `ci.yml` steps (`check-lockfile`, `pnpm audit signatures`); see
*What is enforced, and what is not* above.

**Not carried over from that work: `blockExoticSubdeps`.** pnpm 12
recognises this `pnpm-workspace.yaml` setting and it blocks a *transitive*
dependency from resolving to a git/tarball source — confirmed it does not
error against this repo's current lockfile. It was found while researching
#534 but left out of that fix: it only covers the transitive case (a direct
`github:`-sourced dependency in `package.json` still installs cleanly with it
on, confirmed by testing), so it would complement rather than replace
`src/lib/lockfile-policy.ts`'s check, and that investigation did not
construct a real transitive-exotic dependency to confirm it fails closed.
Still open work — worth a follow-up issue, not a line added on unverified
faith.

**#535 (commit-pinned GitHub Actions)** is unaffected by this migration and
stays open. See #531.
