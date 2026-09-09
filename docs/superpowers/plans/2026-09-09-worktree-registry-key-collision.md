# Plan: worktree registry keyed by raw admin-dir name

Spec: `docs/superpowers/specs/2026-09-09-worktree-registry-key-collision-design.md`
Issue: #524

Two tasks. Task 2 depends on Task 1's finished API — it cannot start until
Task 1's types and exports are final, since it rewires three scripts against
them.

## Task 1 — Core library: rawName-keyed registry, dbSlug collision guard, migration-aware reap

Files: `src/lib/worktree/identity.ts`, `src/lib/worktree/registry.ts`,
`src/lib/worktree/live-slugs.ts`, `src/lib/worktree/reap.ts`, and their four
`*.test.ts` files. No other files change in this task.

### `identity.ts`

- `WorktreeIdentity`: replace `slug: string | null` with `rawName: string |
  null` and `dbSlug: string | null`.
- `resolveIdentity(gitDir, gitCommonDir)`: compute `rawName =
  isMainCheckout ? null : basename(gitDir)` (same computation as today's
  `slug`, renamed) and `dbSlug = rawName === null ? null :
  sanitizeSlug(rawName)`.
- `sanitizeSlug` and `dbNamesForSlug` are unchanged — still lossy, still the
  Postgres-name derivation, just no longer the identity/registry key.
- Test updates: `identity.test.ts`'s `resolveIdentity` cases assert
  `rawName`/`dbSlug` instead of `slug`; add a case where the raw name needs
  no sanitizing (`rawName === dbSlug`) and one where it does
  (`fix-517` → `rawName: 'fix-517'`, `dbSlug: 'fix_517'`) to make the
  distinction between the two fields explicit in the suite, not just in
  types.

### `registry.ts`

- `RegistryEntry` gains `dbSlug: string` (required).
- `readRegistry`: after parsing, backfill `dbSlug: key` for any entry
  missing it (pre-migration on-disk shape). Every entry `readRegistry`
  returns satisfies `RegistryEntry` — no caller downstream ever sees a
  missing `dbSlug`.
- `allocatePort(registry, rawName, dbSlug, range)`: new `dbSlug` parameter.
  Existing-entry-at-`rawName` path unchanged (return its port, ignore the
  passed `dbSlug` — the stored one is authoritative). New-entry path: scan
  `Object.entries(registry)` for any entry whose `dbSlug` equals the new
  one; if found, throw an error naming both the new `rawName` and the
  colliding entry's key, telling the caller to rename the worktree
  directory. Otherwise allocate as today, storing `{ port, pid: null,
  dbSlug }`.
- `setPid`, `removeSlug` (rename to `removeEntry`): same shape, parameter
  renamed `slug` → `key` for clarity (it's not necessarily a Postgres-safe
  value now).
- `diffOrphans`: keep as a small pure diff (`OrphanEntry.slug` → `.key`),
  still useful as a named building block even though `reapOrphans` (in
  `reap.ts`) now does more than call it — see Task 1's `reap.ts` section.
- Test updates in `registry.test.ts`: `allocatePort` new collision-throws
  case with two different keys and matching `dbSlug`; existing cases
  updated to pass/expect a `dbSlug` field; `readRegistry` backfill case
  (write a raw `{port, pid}` JSON entry with no `dbSlug` to a temp file,
  confirm the read-back result has `dbSlug` equal to that entry's key);
  `readRegistry` case confirming an entry that already has `dbSlug` is left
  untouched (not overwritten with the key).

### `live-slugs.ts`

- `WorktreeAdminEntry.slug` → `.rawName`.
- `listWorktreeAdminEntries`: stop calling `sanitizeSlug` on the raw
  directory name — use it directly as `rawName`. This deletes the
  try/catch around `sanitizeSlug` throwing (no longer applicable — a
  directory name that exists on disk needs no sanitizing to be a valid
  `Set`/JSON key).
- `computeLiveSlugs` → rename `computeLiveWorktreeNames`; `getLiveSlugs` →
  `getLiveWorktreeNames`. Same behavior (filter to `workingDirExists`,
  return a `Set<string>`), operating on raw names now.
- Test updates in `live-slugs.test.ts`: rename per the above; add a case
  with two admin-dir names that would have collided under the old
  sanitize-then-compare approach (e.g. `fix-517` and `fix_517` both present
  as live admin dirs) — assert `computeLiveWorktreeNames` returns *two*
  distinct entries, not one. This is the test that would have failed before
  this fix and is the direct regression test for the issue's own example.

### `reap.ts`

- `reapOrphans(registry, liveRawNames, deps)`: implement the three-case
  logic from the spec's §4 pseudocode — live (keep), legacy-rescue-by-dbSlug
  (rekey, or silently drop if the target already has its own row), and
  orphaned (kill pid if set, drop both databases via `dbNamesForSlug(entry.
  dbSlug)`, remove). Return shape gains `migrated: Array<{ from: string; to:
  string }>` alongside the existing `registry`/`reaped`.
- `runReap`: unchanged in shape (still wires real git/db/pid side effects
  through `writeRegistryLocked`); log migrated entries the same way it
  already logs reaped ones, for operator visibility.
- Test updates in `reap.test.ts`, all as pure-function cases (existing
  style, no real Postgres/git):
  - Rekeys a legacy row (key equals its own `dbSlug`) to the live raw name
    whose `sanitizeSlug` output matches that key; keeps `port`/`pid`.
  - Silently drops a legacy row when the target raw name already has its
    own entry — asserts no `killPid`/`dropDatabase` call for that row (its
    resources are already owned by the row at the target key).
  - Still reaps (kill + drop + remove) a legacy row with no live claimant.
  - Still reaps a rawName-keyed (non-legacy-shaped) dead row with no live
    claimant.
  - **Mutation check** (spec's explicit ask): a rawName-keyed dead row whose
    `dbSlug` happens to equal a *different, currently-live* worktree's
    `dbSlug` must still be reaped, not rescued — construct this by giving
    the dead row a `dbSlug` that differs from its own key (so the `key ===
    entry.dbSlug` gate is false) but matches a live entry's `dbSlug`; assert
    `killPid`/`dropDatabase` are still called and the row is removed. This
    proves the gate is load-bearing, not decorative — run it against the
    *pre-fix* three-case logic mentally (or literally, by temporarily
    dropping the gate while developing) to confirm it fails without the
    gate, per this project's "prove every guard bites" standard.
  - Existing "kills pid + drops both databases for an orphan", "does not
    call killPid for a pid-less orphan", "leaves a registry with no orphans
    untouched", and "one orphan's drop failure doesn't block reaping a
    later orphan in the same call" cases carry forward, updated for the
    `dbSlug` field now required on every `Registry` entry.

**Verification for Task 1**: `npx vitest run --project unit src/lib/worktree` green, and `npx tsc --noEmit` clean (this task changes exported types consumed by Task 2's files, which will be red until Task 2 lands — acceptable mid-plan, not a task-exit blocker by itself, but confirm no *other* file outside `scripts/` and `tests/setup/unit-db.ts` references the old field names before calling Task 1 done).

## Task 2 — Wire the three CLI scripts to the new API

Files: `scripts/worktree-setup.ts`, `scripts/worktree-up.ts`,
`scripts/worktree-down.ts`. Depends on Task 1.

- `worktree-setup.ts`: replace `identity.slug` usage with
  `identity.rawName` (registry key) and `identity.dbSlug` (passed to
  `dbNamesForSlug` and to the new `allocatePort` parameter). **Add a
  `runReap` call before `allocatePort`**, mirroring `worktree-up.ts`'s
  existing call — same non-fatal `try/catch`-and-warn treatment
  `worktree-up.ts` already uses (a reap failure must not block worktree
  setup). This is the spec's §5 addition, closing the false-collision gap
  during the migration transition window.
- `worktree-up.ts`: replace `identity.slug` with `identity.rawName` for the
  registry key and `identity.dbSlug` where `allocatePort` needs it.
- `worktree-down.ts`: replace `identity.slug` with `identity.rawName` for
  the registry key (`setPid` lookup). No `dbSlug`/`allocatePort` involvement
  here — unchanged otherwise.
- `tests/setup/unit-db.ts`: no code change expected (it only reads
  `identity.gitCommonDir`) — confirm this with a targeted read after Task 1
  lands, don't assume it from this plan.

**Verification for Task 2**: `npx tsc --noEmit` clean across the whole
project. `npx vitest run --project unit` green (full unit tier, not just
`src/lib/worktree`, to catch anything outside that directory this plan
didn't anticipate). Then the spec's acceptance criteria 2 and 3, run for
real against the actual shared registry file from this worktree:

1. Snapshot `psql -l` output for `ethical_yoga_%` databases and the current
   contents of `<main-repo>/.git/fairyoga-worktrees.json` *before*.
2. Run `npm run worktree:setup` then `npm run worktree:up` in this worktree.
3. Snapshot both again *after*. Diff: this worktree's own row should appear
   (rawName-keyed, with `dbSlug`); every *other* worktree's row that was
   present before and belongs to a still-live worktree (cross-check against
   `git worktree list` from the main checkout) must either be unchanged or
   rekeyed to its own live rawName with the same `port`/`pid` — never
   removed, never dropped, while its worktree is still live.
4. `npm run worktree:down` afterward to release this worktree's dev-server
   pid (port stays reserved, per existing behavior).

If step 3's diff shows any *other* live worktree's databases dropped or pid
nulled, that is a stop-ship finding against this plan's own stated safety
property (spec acceptance criterion 2) — fix before proceeding, don't file
it for later.

## Whole-branch review

Both tasks land in one branch feeding a shared type (`RegistryEntry`,
`WorktreeIdentity`) — after both tasks pass their own task-level review, run
one whole-branch review before opening the PR, per the skill's "2+ tasks"
rule. Specifically check: does Task 2's script wiring actually use
`dbSlug` everywhere `identity.dbSlug` is now the correct value (not a
leftover `identity.rawName` passed somewhere `dbSlug` belongs, which would
compile — both are `string | null` — but silently produce a wrong Postgres
identifier)?

🤖 Generated with [Claude Code](https://claude.com/claude-code)
