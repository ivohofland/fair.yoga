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

### Q1 — Is there a non-agent background writer?
**Verdict: No.** Extensive empirical investigation across single-agent and multi-agent runs found zero evidence of background daemons, Next.js dev server watchers, or editor auto-save altering tracked source files unexpectedly. All observed file changes and phantom revert notices were entirely explained by concurrent agents sharing a single working tree.

### Q2 — What is the safe mutation protocol?
**Verdict: Git worktree isolation with symlinked `node_modules` and pre/post disk validation.**
A git worktree creates an isolated filesystem tree pointing to the same git repository. Symlinking `node_modules` eliminates npm install overhead, allowing the test suite to execute in ~3s.

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

# 2. Symlink node_modules from the primary checkout (instant, 0 install overhead)
ln -s "$(pwd)/node_modules" "$WT_DIR/node_modules"

# 3. Subshell preserves caller's PWD; `|| true` ensures cleanup runs even when tests fail (the expected probe outcome)
(
  cd "$WT_DIR"
  # <apply mutation to target file>
  git diff <modified-file>
  npx vitest run --project <tier> <files>
) || true

# 4. Clean up the worktree
git worktree remove --force "$WT_DIR"
```

### B. Single-Agent In-Place Probes

When running in a confirmed single-agent context where no other agent is active:
1. In-place mutation is permissible.
2. The agent must verify `git diff` immediately before executing the test.
3. The agent must immediately run `git restore <modified-file>` (avoiding manual edits that can leave trailing whitespace) and verify `git status` is clean before proceeding.

---

## 4. Summary Table

| Context | Protocol | Overhead | Safety Guarantee |
|---|---|---|---|
| **Parallel Review Agents** | Separate git worktrees per agent | ~0.5s (`ln -s node_modules`) | 100% isolation; 0 false reds / false greens |
| **Mutation Testing Probes** | Temporary worktree in `/tmp/` | ~0.5s | Primary working tree remains clean at all times |
| **Single-Agent Inline Probe** | In-place edit + `git diff` check | 0s | Safe only when no other agent is active |
