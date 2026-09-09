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
| `.github/workflows/ci.yml` | 5 | one in each job that checks out the repo; the `test` aggregate gate installs nothing |
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

## Not yet in place

The controls that would keep a *compromised* version out, rather than an
unchosen one, are open work — a release-age cooldown (#533), lockfile
invariant checks and an install-script allowlist (#534), commit-pinned GitHub
Actions (#535). See #531.
