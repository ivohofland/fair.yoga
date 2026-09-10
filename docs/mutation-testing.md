# Spec: safe mutation testing protocol & workspace isolation

Status: **implemented** · Scope: developer loop, review agents, subagent builds (#178)

## 1. Principle & Core Hazard

This project's standard is that **a guard that cannot fail certifies nothing**.
The primary method used to prove that a guard, filter, or constraint actually protects against regression is **mutation testing**: deliberately break the guard, observe a named test fail with the expected error, and restore.

### The Two Hazards of Shared Checkouts

1. **False Green (Disappearing Mutation)**:
   If a mutation is reverted or lost before the test suite executes, the suite passes (**green**). The reader falsely concludes that the guard is useless or untested — the exact inversion of what the probe exists to prove.
2. **False Red (Concurrent Writer Interference)**:
   When multiple agents share a single checkout and one mutates a module, concurrent review or test agents observe the half-mutated tree in flight. This was reproduced during PR #308 (#282) on 2026-08-24, where three parallel review agents independently reported broken modules and phantom file notices due to a fourth agent's in-place mutation probe.

---

## 2. Empirical Research Findings (#178)

*A dated record, measured under npm in 2026-08. Q2's `node_modules`
mechanics no longer hold under pnpm — §3 is the live protocol.*

### Q1 — Is there a non-agent background writer?
**Verdict: No.** Extensive empirical investigation across single-agent and multi-agent runs found zero evidence of background daemons, Next.js dev server watchers, or editor auto-save altering tracked source files unexpectedly. All observed file changes and phantom revert notices were entirely explained by concurrent agents sharing a single working tree.

### Q2 — What is the safe mutation protocol?
**Verdict: Git worktree isolation with symlinked `node_modules` and pre/post disk validation.**
A git worktree creates an isolated filesystem tree pointing to the same git repository. Symlinking `node_modules` eliminates install overhead, allowing the test suite to execute in ~3s.

### Q3 — Should parallel mutating agents be structurally prevented from sharing a checkout?
**Verdict: Yes.** Any agent, reviewer, or automated probe that mutates source code must execute inside an isolated git worktree or isolated subagent workspace (`Workspace: 'branch'` or `Workspace: 'share'`).

### Q4 — Is there a hazard beyond false greens?
**Verdict: Yes.** False reds (rejecting good code), wasted review cycles debugging transient disk states, and the danger of uncommitted test mutations leaking into commits or staging.

---

## 3. The Safe Mutation Protocol

### A. Isolated Worktree Recipe (Mandatory for parallel agents / mutating probes)

To measure a mutation probe without touching the primary checkout:

```bash
# 1. Create a dynamic detached worktree (avoids collision between parallel agents)
WT_DIR="/tmp/mutation-probe-$$"
git worktree add -f "$WT_DIR" HEAD

# 2. Give the worktree its OWN node_modules. Not a symlink — see below.
(cd "$WT_DIR" && pnpm install --frozen-lockfile)

# 3. Subshell preserves caller's PWD; `|| true` ensures cleanup runs even when tests fail (the expected probe outcome)
(
  cd "$WT_DIR"
  # <apply mutation to target file>
  git diff <modified-file>
  pnpm exec vitest run --project <tier> <files>
) || true

# 4. Clean up the worktree
git worktree remove --force "$WT_DIR"
```

**Step 2 installs rather than symlinking, and the difference is isolation, not
speed.** pnpm keeps its install state *inside* `node_modules`:
`node_modules/.pnpm-workspace-state-v1.json` keys its `projects` map by the
**absolute path** of the checkout that installed. A second checkout pointed at
that same directory is therefore reading state that names someone else's root,
and `verifyDepsBeforeRun: error` (`pnpm-workspace.yaml`) refuses to run — the
worktree's first `pnpm exec` exits 1 in ~0.1s with

```
Error: ERR_PNPM_VERIFY_DEPS_BEFORE_RUN

  × The workspace structure has changed since last install
  help: Run "pnpm install"
```

and installs nothing. That refusal is the protection: `pnpm run` and `pnpm exec`
otherwise reconcile a mismatched tree on their own, which for a shared
`node_modules` means a mutation agent writing into the very checkout the
worktree exists to keep clean. `docs/supply-chain.md` (§ *The door npm did not
have*) has that setting's own measurement.

**The install is not the overhead the symlink was avoiding.** pnpm hard-links
from its content-addressable store, so a warm store makes a second copy cheap.
Measured 2026-09-10 on this repo, pnpm 12.3.4:

```bash
WT=/tmp/probe-timing && git worktree add -f "$WT" HEAD
( cd "$WT" && time pnpm install --frozen-lockfile )
( cd "$WT" && time pnpm exec vitest run --project unit src/lib/script-install-census.test.ts )
git worktree remove --force "$WT"
```

**6.9s** for the install (exit 0), **4.2s** for the probe run that followed.
The primary checkout's `node_modules/.modules.yaml` is byte-identical before
and after — `shasum` it either side to confirm.

**THE ISOLATION IS OF INSTALL STATE, NOT OF FILE CONTENT.** Hard-linking is
what makes the second install cheap, and it is the same mechanism either way:
the worktree's `node_modules` files are hard links to the content-addressable
store, which the primary checkout's `node_modules` also links to. A probe
that mutates a file *inside* `node_modules` therefore writes through — to the
store, and to every checkout on this machine linked to it. In a document
about deliberately breaking things that is not hypothetical. Mutate the
repo's own source, never a dependency's; if a dependency really is the
target, copy the package out of `node_modules` first and point the probe at
the copy.

### B. Single-Agent In-Place Probes

When running in a confirmed single-agent context where no other agent is active:
1. In-place mutation is permissible.
2. The agent must verify `git diff` immediately before executing the test.
3. The agent must immediately run `git restore <modified-file>` (avoiding manual edits that can leave trailing whitespace) and verify `git status` is clean before proceeding.

---

## 4. Summary Table

| Context | Protocol | Overhead | Safety Guarantee |
|---|---|---|---|
| **Parallel Review Agents** | Separate git worktrees per agent, each with its own `node_modules` | ~7s (`pnpm install --frozen-lockfile`, warm store) | The primary checkout's install state is untouched (`.modules.yaml` byte-identical, measured); 0 false reds / false greens — but see the hard-link caveat below |
| **Mutation Testing Probes** | Temporary worktree in `/tmp/` | ~7s | Primary working tree remains clean at all times |
| **Single-Agent Inline Probe** | In-place edit + `git diff` check | 0s | Safe only when no other agent is active |
