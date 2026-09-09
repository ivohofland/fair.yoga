# Supply chain

How dependency code gets into this repo, and what stops the wrong version
arriving. Tracking issue: **#531**.

## The rule

**Everything installs from the lockfile.** `npm ci` installs
`package-lock.json` exactly and fails when `package.json` disagrees with it.
`npm install` reconciles instead — it may resolve a range afresh against the
registry, and it may rewrite the lockfile.

`npm ci` is therefore the command everywhere, including a first clone: the
point of a committed lockfile is that a fresh checkout reproduces it or says
why it cannot.

## Where this repo installs

This census lives here rather than in a comment because it spans files that
have no single owner — a claim about `Dockerfile` written in a test file is
invalidated by an edit its author never sees. Re-derive it with:

```bash
grep -rnE 'npm +(ci|install|i|add|update|up)\b' \
  Dockerfile .github/workflows README.md AGENTS.md scripts src/lib \
  --exclude='*.test.ts' | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|#)'
```

Both filters are load-bearing. Without `--exclude`, the census test file's
fixtures and docblock dominate the output; without the second `grep`, every
comment discussing a command counts as running one.

**The second filter is anchored, and that anchor is the whole point.** An
unanchored `:[[:space:]]*(//|\*|#)` matches a colon *anywhere* on the line, so
`https://` matches it — and a real
`RUN npm install --registry https://registry.npmjs.org` would vanish from the
census meant to reveal it. That is not hypothetical: this file shipped the
unanchored version first. Checking a filter against today's output only shows
it keeps what is already there; feed it a line it must **not** drop.

Measured 2026-09-09, the command returns **11 lines — 10 invocations, plus the
`console.log` in `scripts/worktree-setup.ts` that names the call on the line
below it**:

| Where | Invocations | Notes |
|---|---|---|
| `.github/workflows/ci.yml` | 5 | one in each job that installs; `docker-build` checks out without installing, and the `test` aggregate gate does neither |
| `.github/workflows/e2e-flake-repro.yml` | 1 | manual-dispatch only |
| `Dockerfile` | 1 | in the `deps` stage; `build` and `migrate` are `FROM deps` and inherit the layer rather than re-running it |
| `scripts/worktree-setup.ts` | 1 | the only one in imperative code, and the only one a test enforces |
| `README.md`, `AGENTS.md` | 1 each | human-facing setup instructions |

The two documentation sites are the reason this list is worth keeping: they
said `npm install` until #532, so the repo's own instructions contradicted
every automated path. Nothing checks them mechanically — a `grep` in a
contributor's head is what maintains them, which is why the command above is
here rather than the number alone.

## What is enforced, and what is not

`src/lib/script-install-census.test.ts` fails the build when imperative code
under `scripts/` or `src/lib/` runs an install that is not `npm ci`. It parses
each file and reads the command out of `child_process`-shaped calls, including
the argv form (`spawnSync('npm', ['install'])`). Its own docblock states what
it cannot see — a renamed or injected callee, an interpolated command, a
prefixed one, anything inside a shell script.

Nothing enforces the declarative paths (`Dockerfile`, the workflows) or the
documentation — only a reviewer reads them. They were correct when measured;
the table above and its command are what make a regression visible.

## Known advisories, and why the audit step does not block

`ci.yml` runs `npm audit --audit-level=high` with `continue-on-error: true`.
The census belongs here rather than beside that step for the same reason the
install census does: what it counts lives in `package-lock.json`, and a new
advisory published against an unchanged tree falsifies it without anyone
editing the workflow.

Re-derive with:

```bash
npm audit --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s);
  console.log(JSON.stringify(j.metadata.vulnerabilities));
  for (const [n,v] of Object.entries(j.vulnerabilities))
    console.log(n, v.severity, JSON.stringify(v.fixAvailable));});'
```

Add `--omit=dev` for the production dependency tree. Both numbers are worth
having, because most of what the unqualified command reports is lint and test
tooling.

**`--omit=dev` is a proxy for "ships to production", not a description of any
image this repo builds.** Neither of the two stages that ship matches it:

- The `runner` stage (`Dockerfile:36-50`) is **narrower**. The only
  `node_modules` it gets is the one inside `.next-build/standalone`, which Next
  populates by tracing actual imports — so it holds far less than the
  production dependency tree. (It copies two other trees, `.next-build/static`
  and `public`; neither carries dependencies. This repo has never tracked a
  `public/` of its own — icons are Next's file-based `app/icon.svg` convention
  instead — so the `build` stage creates one empty before the copy; #543 has
  the history.)
  Check what is really in it with
  ```bash
  for p in nanoid baseline-browser-mapping postcss prisma @prisma/config deepmerge-ts; do
    [ -d ".next-build/standalone/node_modules/$p" ] && echo "$p present" || echo "$p absent"
  done
  ```
  after a build.
- The `migrate` stage (`Dockerfile:30`) is **wider**. It is `FROM deps`, i.e. a
  plain `npm ci`, so it ships the entire tree — every devDependency included.

Read `--omit=dev` as "could plausibly execute at runtime somewhere", and check
the image when the answer matters.

Measured 2026-09-09, immediately after #539 took `next` to `16.3.4`: **12 in
the whole tree** (5 moderate, 7 high, 0 critical), of which **5 are in the
production tree** (1 moderate, 4 high, 0 critical). The remaining 7 are
therefore dev-only. `next` itself reports nothing.

**In the production dependency tree** — none is a direct *production*
dependency; all five arrive through one. (`prisma` is a direct
**dev**Dependency, and `npm audit --omit=dev` reports it as `isDirect: true` —
it is in this table because `@prisma/client` pulls it into the production tree
as well.)

| Package | Reached through | Forward fix |
|---|---|---|
| `prisma`, `@prisma/config`, `deepmerge-ts` | `@prisma/client` | **None.** npm's suggestion is `prisma@6.12.0`, `isSemVerMajor: true` — a *downgrade* from the `6.19.3` the lockfile resolves |
| `nanoid` | `next` → `postcss` | `npm update nanoid` |
| `baseline-browser-mapping` | `next` | `npm update baseline-browser-mapping` |

Re-derive the "reached through" column with `npm ls <package> --omit=dev`, and
the dev-only paragraph below with `npm ls <package>` — these edges rot faster
than the totals do, and this table has already carried one wrong one.

The last two are stale lockfile resolutions, not constrained versions, and the
distinction decides the fix. `postcss` declares `nanoid: ^3.3.16` and `next`
declares `baseline-browser-mapping: ^2.9.19`; the first fixed versions —
`3.3.18` (advisory range `<3.3.18`) and `2.11.0` (`>=2.0.0 <2.11.0`) — both
satisfy those ranges, so nothing upstream is holding them back — the committed
lockfile is, and refreshing it is enough. That is what npm's bare
`fixAvailable: true` means, as against the object form the three
`prisma`-rooted entries get. An `overrides` block would work and is the wrong
tool: heavier, and pinned against a range that will drift.

**Dev-only** — `browserslist` arrives through `eslint-config-next`, `js-yaml`
and `@humanfs/node` through `eslint`, and `brace-expansion` through both;
`vitest` and `@vitest/coverage-v8` are direct devDependencies and
`@vitest/mocker` comes with them. They run against this repo's own source on a
developer's machine and on CI, and every advisory among them needs hostile
input fed to the tool — which here would mean this repo's own files. Mostly
denial-of-service and path traversal, though not only: `browserslist`'s
GHSA-73wf-gq98-2v4g is a prototype write via an untrusted
`browserslist-stats.json`, and `@humanfs/node`'s is a symlink escape during a
recursive copy.

So the step reports real things, and none of them is a reason to stop a pull
request that did not cause them. What would change that: an advisory against a
package this app's *request path* actually executes, or any critical. Either
is a reason to fix rather than to note.

## Not yet in place

The controls that would keep a *compromised* version out, rather than an
unchosen one, are open work — a release-age cooldown (#533), lockfile
invariant checks and an install-script allowlist (#534), commit-pinned GitHub
Actions (#535). See #531.
