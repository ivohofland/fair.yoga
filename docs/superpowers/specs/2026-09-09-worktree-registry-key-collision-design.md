# Worktree registry keyed on a lossy sanitized slug

Issue #524. Deferred from #517's PR (#523) — closing it means `RegistryEntry`'s
shape changing everywhere it's consumed, judged too large for that PR's final
fix wave.

## The problem, as the issue states it

`sanitizeSlug` (`src/lib/worktree/identity.ts`) lowercases and collapses every
non-`[a-z0-9_]` run to a single `_`, then truncates to 40 characters. Two
different raw git worktree admin-directory names can sanitize to the same
slug — different naming conventions (hyphen vs. underscore) over the same
issue-number namespace being the concrete case this machine already has.

`Registry` (`src/lib/worktree/registry.ts`) is `Record<string,
RegistryEntry>` keyed by that sanitized slug, and `live-slugs.ts` also
sanitizes admin-directory names before comparing them against registry keys.
A collision merges two distinct worktrees into one registry row and one
`Set` entry: if one collides worktree is live and the other dead, the live
one's presence in the `Set` makes `diffOrphans` treat the dead one's row —
its pid, its databases — as live forever. A subsequent `allocatePort` +
`setPid` from the live worktree silently overwrites the dead worktree's
tracked pid in that shared row, making the dead process permanently
untracked and its databases permanently unreapable.

## Verifying the premise

The issue's mechanism holds — traced through the actual code, not just
described:

- `identity.ts:60` — `slug: sanitizeSlug(basename(gitDir))` — the registry
  key is a lossy function of the raw admin-dir name.
- `live-slugs.ts:31` sanitizes admin-directory names the same way, so
  `computeLiveSlugs`'s `Set<string>` (`live-slugs.ts:11-12`) dedupes on the
  same lossy value before `diffOrphans` ever sees it.
- `registry.ts:23-26` — `allocatePort` returns the existing port for an
  already-registered slug (correct "reuse on restart" behavior) — but
  "already registered" means "some worktree, possibly not this one, already
  claimed this slug."

**One thing the issue does not raise, found in this investigation**: the
registry is not a scratch file. `getRegistryPath` (`registry.ts:61-63`)
resolves to `<git-common-dir>/fairyoga-worktrees.json` — inside *this
repository's own* `.git`, shared by every worktree on this machine.
`git worktree list` currently shows ~30 linked worktrees, most under
`.claude/worktrees/<hyphenated-name>` or
`~/.gemini/antigravity/worktrees/fair.yoga/<underscored_name>`. Both naming
conventions run `sanitizeSlug` at every `worktree:setup`/`worktree:up`/`npm
test` invocation (`tests/setup/unit-db.ts` calls `runReap` in the global
setup for the `unit`/`unit-sweeps` vitest projects, unconditionally, from
every worktree). A key-scheme change that swaps the registry key from
sanitized-slug to raw-admin-dir-name, with no transition handling, makes
**every currently-registered row look orphaned** the first time any
worktree's reap sweep runs post-merge — mine included, the moment I run
`npm test` in this worktree to verify the fix. Reap's job is to kill the
tracked pid and `DROP DATABASE` both databases for anything it decides is
orphaned (`reap.ts:19-31`). Shipping the key-scheme change without a
migration path means the first `npm test` run anywhere on this machine after
merge kills every other live worktree's dev server and drops its databases —
a self-inflicted, machine-wide version of the exact bug this issue reports,
just via a different mechanism (unconditional mass-reap instead of silent
masking). This spec's design section treats safe migration as a first-class
requirement, not a follow-up.

## Design

### 1. Identity: separate the registry key from the Postgres-safe name

`WorktreeIdentity` splits `slug` into two fields:

```ts
export interface WorktreeIdentity {
  isMainCheckout: boolean;
  rawName: string | null;   // git's own admin-dir basename — unique by git's
                             // own construction (verified empirically: two
                             // worktree paths sharing a basename produce
                             // "foo" and "foo1" under .git/worktrees/, git
                             // disambiguates on creation)
  dbSlug: string | null;    // sanitizeSlug(rawName) — Postgres-identifier-safe,
                             // used only to derive database names
  gitCommonDir: string;
}
```

`resolveIdentity` computes `rawName = basename(gitDir)` (unchanged
computation, renamed) and `dbSlug = sanitizeSlug(rawName)`. `sanitizeSlug`
itself is unchanged — still lossy, still 40-char truncated — because it now
only has to produce a legal Postgres identifier, not a unique one; uniqueness
moves to the registry key.

### 2. Registry: key by `rawName`, carry `dbSlug` as a value

```ts
export interface RegistryEntry {
  port: number;
  pid: number | null;
  dbSlug: string;
}
export type Registry = Record<string, RegistryEntry>;  // keyed by rawName
```

`allocatePort(registry, rawName, dbSlug, range)`:
- Existing entry at `rawName` → return its port unchanged (today's behavior).
- New entry → scan every *existing* entry's `dbSlug` for a collision with the
  new `dbSlug`. On collision, **throw**, naming both the new `rawName` and
  the colliding entry's key, telling the caller to rename the worktree
  directory. This is the issue's own first-listed resolution and matches
  this codebase's existing posture toward ambiguity: `readRegistry` already
  throws on a corrupt file rather than silently discarding it
  (`registry.ts:79,84`), and `worktree-setup.ts` warns loudly rather than
  silently overwriting a mismatched `.env`. A silent hash-suffix was
  considered and rejected: it would make `ethical_yoga_dev_<slug>` names
  unpredictable from the worktree name alone, defeating the point of the
  name being legible in `psql -l` or a manual `DROP DATABASE`.
- No collision → allocate the port as today, store `{ port, pid: null,
  dbSlug }`.

`setPid`, `removeSlug` (renamed `removeEntry`) — same shape, keyed by
`rawName`. `diffOrphans`'s returned `OrphanEntry.slug` is renamed to `key`
to stop implying it's a Postgres-safe value.

### 3. Live set: raw names, not sanitized ones

`live-slugs.ts`'s `listWorktreeAdminEntries` stops calling `sanitizeSlug` on
admin-directory names entirely — the directory name under
`<gitCommonDir>/worktrees/` *is* the value `identity.ts` computes as
`rawName` from inside that same worktree (confirmed: for a linked worktree,
`git rev-parse --git-dir` returns `<common-dir>/worktrees/<name>`, so
`basename(gitDir)` from inside the worktree equals the directory name
`live-slugs.ts` scans from outside). Comparing raw names directly removes
the collision from this side of the code entirely — no lossy step, nothing
to collide. `WorktreeAdminEntry.slug` → `WorktreeAdminEntry.rawName`;
`computeLiveSlugs`/`getLiveSlugs` → `computeLiveWorktreeNames`/
`getLiveWorktreeNames`. This also deletes the `sanitizeSlug`-can-throw
branch in `listWorktreeAdminEntries` (`live-slugs.ts:30-36`) — a raw
directory name that exists on disk needs no validation to be used as a
`Set<string>` member or JSON key.

### 4. Migration: reap becomes migration-aware, folded into one pass

Every registry row that exists before this ships is keyed by a sanitized
slug (today's scheme) and has no `dbSlug` field. `readRegistry` backfills
`dbSlug: <existing key>` for any entry parsed without one — this is not a
guess: under the code being replaced, the key *was* always exactly
`sanitizeSlug(rawName)`, so the key is the correct `dbSlug` value for that
row. After this backfill, every entry in memory satisfies `RegistryEntry`
with no union type or "maybe legacy" discriminant needed anywhere past
`readRegistry`.

`reapOrphans(registry, liveRawNames, deps)` gets a third case alongside
"live" and "orphaned":

```
for each [key, entry] in registry:
  if liveRawNames.has(key):
    keep as-is                                   # already rawName-keyed, live
  else if key === entry.dbSlug:                  # only true for a row whose key
                                                  # IS already a bare dbSlug —
                                                  # every pre-migration row, plus
                                                  # any post-fix row whose raw
                                                  # name happened to need no
                                                  # sanitizing
    target = liveRawNames.find(name => sanitizeSlug(name) === key)
    if target exists and registry[target] is undefined:
      rekey: move this entry to `target`, keep port/pid, dbSlug stays `key`
    else if target exists (registry[target] already has its own row):
      drop this row silently — stale leftover from that worktree's own
      earlier self-migration; its databases/pid are already owned by the
      row at `target`
    else:
      reap it (kill pid, drop both databases, remove) — no live worktree's
      dbSlug claims it
  else:
    reap it (kill pid, drop both databases, remove) — rawName-keyed and dead
```

The `key === entry.dbSlug` gate is what keeps this safe rather than
reopening the issue: it only ever applies the dbSlug-based rescue to rows
that are *structurally* pre-migration (or coincidentally clean). Every row
created by the new `allocatePort` collision guard (§2) is verified
dbSlug-unique at creation time, so for those rows this branch can only ever
be a no-op — `liveDbSlugToRawName.get(dbSlug)` can only resolve to that
row's own live rawName (which already took the first branch) or to nothing.
The rescue does real work only during the one-time transition, for exactly
the rows the guard did not exist to protect when they were created. Once
every pre-existing worktree has run `worktree:setup`/`worktree:up`/
`worktree:down` at least once post-merge, no legacy-keyed rows remain and
this branch stops firing in practice (leaving it in place is harmless, not
a maintenance burden — it's the same three-case shape either way).

**Consequence accepted, not hidden**: a worktree that had already
registered under the old scheme gets its port reassigned exactly once, at
whichever of its own `worktree:setup`/`up`/`down` invocations happens to run
after this merges but before any other worktree's reap sweep rekeys it out
from under it. `INTEGRATION_BASE_URL` in that worktree's `.env` goes stale
until it re-runs `worktree:setup`. This is a one-time, cosmetic cost — no
database is dropped and no live dev-server pid is killed for a still-live
worktree under this design, which is the property that matters.

### 5. `worktree-setup.ts` gains a reap call

`worktree-up.ts` already runs `runReap` before its own `allocatePort` call;
`worktree-setup.ts` does not, so a freshly-created worktree's very first
`allocatePort` call could hit a false collision against an orphaned-but-not-
yet-reaped row (more likely than usual during the transition window, since
every pre-existing row starts out "not yet migrated"). Adding the same
`runReap` call `worktree-up.ts` already makes, ahead of `allocatePort`,
closes this — in scope here because it's the same file being touched for
the key-scheme change and the transition window is this spec's own
consequence to close.

## Non-goals

- **Not retroactively re-validating every pre-existing row for a dbSlug
  collision the old code already let through.** If two already-registered,
  still-live worktrees already collide on `dbSlug` today, the migration
  above does not detect or resolve that on its own — it rekeys each row it
  can unambiguously attribute to a live worktree, one at a time, on
  whichever worktree's reap sweep happens to run first. If both are still
  registered under old-scheme keys that are identical to each other (the
  literal collision the issue reports), migration cannot disambiguate them
  either — this spec closes the structural cause going forward
  (`allocatePort`'s guard) and migrates what it safely can; a live
  double-registered collision already in progress right now needs a human
  to rename one of the two worktrees, same remedy the guard will hand a new
  collision.
- **Not deleting or archiving stale JSON rows left over from a worktree that
  self-migrated before its old row got swept.** They're a few bytes each and
  get dropped the next time any reap sweep observes that worktree already
  has a row at its rawName key (§4, "drop this row silently").

## Testing

All of §2-§4 are pure functions over an in-memory `Registry` and a
`ReadonlySet<string>` of live raw names — no real Postgres, no real git,
matching how `allocatePort`/`setPid`/`diffOrphans`/`reapOrphans` are already
tested today. New/updated unit coverage:

- `allocatePort` throws on a genuine `dbSlug` collision between two
  different rawName keys, naming both in the error; does not throw when the
  same rawName is re-allocated (idempotent re-run).
- `readRegistry` backfills `dbSlug` for an entry parsed without one; leaves
  an entry that already has `dbSlug` untouched.
- `reapOrphans`: the three-case migration behavior — rekeys a legacy row to
  a live worktree whose sanitized name matches it; silently drops a legacy
  row whose target rawName already has its own entry; still reaps (kill +
  drop + remove) a legacy row with no live claimant; still reaps a
  rawName-keyed row with no live claimant; leaves a live rawName-keyed row
  untouched. Mutation check: a rawName-keyed dead row whose `dbSlug`
  happens to collide with a *different* live worktree's `dbSlug` must still
  be reaped, not rescued — proves the `key === entry.dbSlug` gate is doing
  real work, not merely present.
- `listWorktreeAdminEntries` / `computeLiveWorktreeNames`: existing coverage
  ported to `rawName`, unchanged in intent — two worktrees whose raw names
  differ only by the characters `sanitizeSlug` used to collapse (e.g.
  `fix-517` vs `fix_517`) now produce two distinct live entries instead of
  one, the direct fix for the issue's own concrete example.

## Acceptance criteria

1. Two worktrees whose raw admin-dir names sanitize to the same `dbSlug` can
   both be registered without collision — the registry holds two distinct
   rows, one per rawName — until one of them is genuinely new and collides
   with the other's `dbSlug`, at which point `allocatePort` refuses with an
   actionable error instead of silently sharing the row.
2. Running the existing full `npm run verify` / `npm test` suite from this
   worktree does not remove, reassign, or corrupt any *other* currently-live
   worktree's registered pid or databases — verified by diffing
   `fairyoga-worktrees.json` and `psql -l` output for `ethical_yoga_%`
   before and after a local `--project unit` run in this worktree, not
   merely asserted from the code.
3. `npm run worktree:setup && npm run worktree:up` in this fresh worktree
   completes and serves the app on its allocated port, going through the
   real `allocatePort`/migration path against the real shared registry file.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
