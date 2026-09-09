# Worktree registry: branded types, migration-window robustness

Issue #528. Four findings deferred from PR #527's review (closing #524, the
registry re-key from a lossy sanitized slug to git's own raw admin-dir name).
All four touch the same migration-transition window PR #527 introduced, which
is why they're one piece of work rather than four separate issues.

## Verifying the premise

Traced through the current code (post-#527, pre-this-issue), not just the
issue text:

1. **Branded types** — `identity.ts:39-49`: `WorktreeIdentity.rawName` and
   `.dbSlug` are both `string | null`. `registry.ts:22-25`: `allocatePort`
   takes `rawName: string, dbSlug: string` as adjacent positional params.
   `identity.ts:22`: `dbNamesForSlug(slug: string)`. Nothing in the type
   system stops a swap at either call site
   (`scripts/worktree-setup.ts:34,46`, `scripts/worktree-up.ts:59`). This
   codebase already has the fix for exactly this shape of problem —
   `WeekKeyBrand` (`timezone.ts:138`), `browserNonceBrand`
   (`auth/origin-nonce.ts:5`), `boundLinkBrand` (`auth/link-delivery.ts:6`) —
   including a `@ts-expect-error` compile-pin test proving the brand actually
   rejects an unbranded value (`timezone.test.ts:469-474`).

2. **`runReap`-before-`allocatePort` interaction** — confirmed by reading
   `worktree-setup.ts:23-37` (identical shape in `worktree-up.ts:42-62`):
   `runReap` runs in a `try/catch` that only logs on failure
   (`console.warn(...continuing without it...)`) — it never stops `main()`.
   The very next statement calls `allocatePort(registry, rawName, dbSlug)`
   regardless. If this worktree still has a legacy row (registered under the
   pre-#527 scheme, keyed by its own `dbSlug` because it hasn't run
   `setup`/`up` since #527 shipped) and `runReap` didn't get to migrate it
   this run, `allocatePort`'s own collision check
   (`registry.ts:32`: `Object.entries(registry).find(([, entry]) =>
   entry.dbSlug === dbSlug)`) finds that exact row — because its `dbSlug`
   field is by construction equal to this run's freshly-computed `dbSlug` —
   and throws, naming the colliding key (`collidingKey`, which for a legacy
   row equals the `dbSlug` string itself) as though it belonged to some
   other, currently-registered worktree. The thrown message
   (`registry.ts:35-38`) says nothing about the reap failure three lines
   earlier in the same log. Confirmed reproducible in shape: a fresh
   `allocatePort` call against a registry containing only this worktree's own
   unmigrated row hits this exact branch.

3. **`reapEntry` failure classification** — `reap.ts:31-52`: the single
   `catch` block logs `"will retry on the next sweep"` for every failure and
   returns the registry unchanged, with no record of which key failed or why.
   `ReapResult` (`reap.ts:11-15`) carries `reaped` and `migrated` but no
   `failed`. `runReap` (`reap.ts:112-135`) returns only `Promise<string[]>` —
   there is no way for any of its three callers (`worktree-setup.ts:24`,
   `worktree-up.ts:43`, `tests/setup/unit-db.ts:52`) to know a row is stuck.

4. **`resolveIdentity`'s unguarded `sanitizeSlug`** — `identity.ts:68`:
   `dbSlug: rawName === null ? null : sanitizeSlug(rawName)`, no
   `try/catch`. `sanitizeSlug` throws
   (`identity.ts:11-13`) for a raw name that sanitizes to the empty string
   (e.g. `___`). `reap.ts:23-29`'s `sanitizesTo` wraps the identical call in
   a `try/catch` for exactly this reason, for *live* names it's comparing
   against — `resolveIdentity` has no equivalent for the worktree's *own*
   identity, so `getWorktreeIdentity()` throws `sanitizeSlug`'s generic
   `"produced an empty slug"` uncaught, with no worktree-specific context.

All four premises hold as stated. One correction to the issue's own
framing, found while sizing the type-branding work: `RegistryEntry.dbSlug`
and every registry-literal test fixture that sets it are typed today as
plain `string` — branding it (as the issue's suggested shape explicitly
asks for) means every existing `Registry`-literal test fixture across
`reap.test.ts` (28 occurrences) and `registry.test.ts` (30 occurrences)
needs a cast to keep compiling, plus the `Set(['...'])` live-name literals
in `reap.test.ts` (10) and `live-slugs.test.ts` (2). This is mechanical and
low-risk (the compiler rejects any fixture the cast doesn't fix), but it's
the bulk of Task 1's diff — called out here so it isn't mistaken for scope
creep when the PR shows up mostly as test-file changes.

## Design

### 1. Branded `RawName` / `DbSlug`

In `identity.ts`, using the issue's own suggested shape (matching
`WeekKeyBrand`'s idiom exactly):

```ts
declare const rawNameBrand: unique symbol;
declare const dbSlugBrand: unique symbol;
export type RawName = string & { readonly [rawNameBrand]: true };
export type DbSlug = string & { readonly [dbSlugBrand]: true };
```

Threaded through:

- `WorktreeIdentity.rawName: RawName | null`, `.dbSlug: DbSlug | null`.
- `allocatePort(registry: Registry, rawName: RawName, dbSlug: DbSlug, range?): {...}`
  — the swap this issue exists to close.
- `dbNamesForSlug(slug: DbSlug): DatabaseNames`.
- `RegistryEntry.dbSlug: DbSlug`.
- `live-slugs.ts`: `WorktreeAdminEntry.rawName: RawName`,
  `computeLiveWorktreeNames(entries): Set<RawName>`,
  `getLiveWorktreeNames(gitCommonDir): Set<RawName>`.
- `reap.ts`: `reapOrphans(registry: Registry, liveRawNames: ReadonlySet<RawName>, deps): Promise<ReapResult>`,
  `sanitizesTo(rawName: RawName, dbSlug: DbSlug): boolean`.

**`Registry`'s key type is explicitly excluded**, per the issue's own
non-goal — `Record<string, RegistryEntry>` stays plain-`string`-keyed. It is
genuinely dual-meaning during the migration window (a legacy row's key IS a
bare `DbSlug`; a migrated row's key IS a `RawName`), and branding it either
way would assert something false about the other half of the transition.

**Cast sites** — every one is a runtime-proven narrowing, not a blind
assertion, and gets a one-line comment saying so:

- `resolveIdentity`: `basename(gitDir) as RawName` (git's own admin-dir
  basename — unique by git's own construction, per the existing docblock);
  `sanitizeSlug(rawName) as DbSlug` inside the new try/catch (§4).
- `registry.ts`'s `readRegistry` backfill: `dbSlug: (entry.dbSlug ?? key) as DbSlug`
  — under the pre-migration scheme the key *was* always exactly
  `sanitizeSlug(rawName)`, so a missing `dbSlug` field is safely backfilled
  from the key.
- `live-slugs.ts`'s `listWorktreeAdminEntries`: `rawName: rawName as RawName`
  at the point a directory name read off disk under
  `<gitCommonDir>/worktrees/` is packaged into a `WorktreeAdminEntry` — the
  same equivalence `live-slugs.ts`'s own docblock already states.
- `reap.ts`'s `reapOrphans` loop: `liveRawNames.has(key as RawName)` at the
  top of the loop (probing whether this dual-meaning registry key already
  happens to be a live raw name) and, inside the `key === entry.dbSlug`
  legacy-rescue branch, `sanitizesTo(name, key as DbSlug)` — the branch
  condition immediately above the cast is the proof.

**Compile-time pins** (this issue's "prove the guard bites" for a
compile-time guard — the proof *is* `@ts-expect-error` catching a real
type error, not a runtime assertion):

- `identity.test.ts`, matching `timezone.test.ts:469-474`'s exact pattern:
  an unexported function assigning a plain string/`RawName` where a
  `DbSlug` is required, and vice versa, each behind `@ts-expect-error`.
- `registry.test.ts`: an unexported function calling
  `allocatePort(registry, dbSlug, rawName)` (arguments swapped) behind
  `@ts-expect-error` — this is the direct pin for the defect three review
  rounds on #527 had to check by hand.
- `identity.test.ts`: `dbNamesForSlug(rawName)` behind `@ts-expect-error` —
  the lesser mistake of passing a `RawName` where a `DbSlug` is required.

### 2. The `runReap`-before-`allocatePort` interaction

`allocatePort` throws a new typed error instead of a plain `Error`:

```ts
export class RegistryCollisionError extends Error {
  readonly rawName: string;
  readonly dbSlug: string;
  readonly collidingKey: string;
  /** True when the colliding row's own registry key textually equals this
   *  run's dbSlug — i.e. that row is legacy-shaped (unmigrated), so it could
   *  be this worktree's own not-yet-migrated past self rather than a
   *  genuinely different worktree. */
  readonly collidingKeyIsLegacyShaped: boolean;

  constructor(rawName: string, dbSlug: string, collidingKey: string) {
    super(
      `allocatePort: worktree "${rawName}" sanitizes to database slug "${dbSlug}", which is already claimed by ` +
        `registered worktree "${collidingKey}" — rename one of the two worktree directories to resolve the collision.`,
    );
    this.name = 'RegistryCollisionError';
    this.rawName = rawName;
    this.dbSlug = dbSlug;
    this.collidingKey = collidingKey;
    this.collidingKeyIsLegacyShaped = collidingKey === dbSlug;
  }
}
```

A new pure, exported function, also in `registry.ts`:

```ts
export function explainCollision(err: RegistryCollisionError, reapFailed: boolean): Error {
  if (!reapFailed || !err.collidingKeyIsLegacyShaped) {
    return err;
  }
  return new Error(
    `${err.message}\n` +
      'note: the reap/migration sweep failed earlier in this run (see the warning above) — this collision ' +
      "may be against this worktree's own not-yet-migrated legacy registry entry, not a genuinely different " +
      'worktree. Re-run this command: if the reap sweep succeeds, migration happens automatically and the ' +
      'collision should clear.',
  );
}
```

`worktree-setup.ts` and `worktree-up.ts` both already have a `try/catch`
around their `runReap` call that sets no state today beyond a log line —
each gains a local `let reapFailed = false` set to `true` in that catch, and
wraps its `allocatePort` call:

```ts
try {
  await writeRegistryLocked(registryPath, (registry) => {
    const result = allocatePort(registry, rawName, dbSlug);
    port = result.port;
    return result.registry;
  });
} catch (err) {
  throw err instanceof RegistryCollisionError ? explainCollision(err, reapFailed) : err;
}
```

This is deliberately **not** a heuristic over registry contents alone — an
earlier design considered inferring "is this collision against my own row"
purely from `collidingKey === entry.dbSlug === dbSlug`, but that predicate
is also true for a genuine collision against a *different* worktree that
independently hasn't migrated yet. `reapFailed` (this run's own outcome,
already computed) is what makes the hint honest: it fires only when this
run's own migration attempt didn't get a chance to run, which is precisely
the scenario the issue describes. Worded as "may be", not "is" — the
`collidingKeyIsLegacyShaped` half of the condition alone still can't rule
out the genuine-different-worktree case.

`explainCollision` is the unit under test the issue asks for
("add a test for the interaction") — it needs no real IO, no registry file,
no git: construct a `RegistryCollisionError` directly and call it.

### 3. `reapEntry` failure visibility

```ts
export interface ReapResult {
  registry: Registry;
  reaped: string[];
  migrated: Array<{ from: string; to: string }>;
  failed: Array<{ key: string; error: unknown }>;
}
```

`reapEntry` gains a `failed` accumulator parameter (mirroring the existing
`reaped` one) and pushes `{ key, error: err }` in its catch, alongside the
existing `console.warn`. `reapOrphans` collects and returns it.

`runReap`'s return type changes from `Promise<string[]>` to a named result
type:

```ts
export interface RunReapResult {
  reaped: string[];
  failed: Array<{ key: string; error: unknown }>;
}
export async function runReap(...): Promise<RunReapResult>
```

All three callers (`worktree-setup.ts`, `worktree-up.ts`,
`tests/setup/unit-db.ts`) update from `reaped.length`/`reaped.join` to
`result.reaped...`, and each gains a parallel, more visible line for
failures — `console.error`, not `console.warn`, since `reapEntry` already
warns per-row and this is the summary a human actually scans for:

```ts
if (result.failed.length > 0) {
  console.error(
    `[worktree:setup] FAILED to reap ${result.failed.length} orphaned worktree resource(s) — will retry on next sweep: ${result.failed.map((f) => f.key).join(', ')}`,
  );
}
```

Scope note, matching the issue's own framing: this makes a stuck row
*visible* to whoever is watching the log. It does not attempt to
distinguish transient from permanent failure across sweeps (no
failure-history tracking) — the issue frames that as the harder, unsolved
part ("no way... to know a row is stuck versus successfully reaped");
visibility is the fix in scope here.

### 4. `resolveIdentity`'s unguarded `sanitizeSlug`

Keeps the throw — an admin-dir name that sanitizes to nothing is a genuine
problem needing a rename, and silently returning `dbSlug: null` here (the
`isMainCheckout`/`rawName === null` convention) would collide with the
existing `!identity.dbSlug` early-return in every script, which prints
`"main checkout — nothing to do"` — actively misleading for a non-main
worktree with an unsanitizable name. Instead, wraps the call for a
worktree-specific, actionable message:

```ts
let dbSlug: DbSlug | null = null;
if (rawName !== null) {
  try {
    dbSlug = sanitizeSlug(rawName) as DbSlug;
  } catch (err) {
    throw new Error(
      `resolveIdentity: worktree admin-dir name "${rawName}" cannot be turned into a database slug ` +
        `(${(err as Error).message}) — rename this worktree's directory to include at least one of [a-z0-9_]`,
    );
  }
}
```

Mirrors `reap.ts`'s `sanitizesTo` in mechanism (same underlying throw,
guarded) but not in outcome — `sanitizesTo` treats an unsanitizable *live*
name as "not a match" and continues the sweep; this is the worktree's *own*
identity, so there is nothing to continue with, and the guard exists only
to make the failure legible instead of leaking `sanitizeSlug`'s generic
message.

## Non-goals

- **Not distinguishing transient from permanent reap failures** (§3) — see
  above; that needs failure-history tracking across sweeps, out of scope
  for a visibility fix.
- **Not resolving `resolveIdentity`'s failure automatically** (§4) — an
  unsanitizable admin-dir name still requires a human to rename the
  directory; this only makes the resulting error actionable.
- **Not touching `diffOrphans`/`OrphanEntry`** — confirmed dead in
  production code (only referenced from its own test file and from a
  comment in `reap.ts` explaining why `reapOrphans` doesn't use it). Neither
  the issue nor this investigation found a reason to change it, and
  removing genuinely dead code is a separate concern from this issue's four
  findings.
- **Not re-litigating #524's migration design** — §1-4 sit on top of it
  unchanged; no change to the three-case classification in `reapOrphans`,
  the rekey/drop/reap decision, or the `key === entry.dbSlug` gate.

## Testing

- **§1**: existing `identity.test.ts`, `registry.test.ts`, `reap.test.ts`,
  `live-slugs.test.ts` fixtures updated to compile under the branded types
  with **unchanged assertions** — this task changes types, not behavior.
  New: the three `@ts-expect-error` compile-pins described above.
- **§2**: new tests for `RegistryCollisionError.collidingKeyIsLegacyShaped`
  (true when `collidingKey === dbSlug`, false otherwise) and for
  `explainCollision` — unchanged when `reapFailed` is `false`; unchanged
  when `collidingKeyIsLegacyShaped` is `false` even if `reapFailed` is
  `true` (a provably-different worktree's collision must not get the
  "might be your own row" hint); enriched (message gains the note, original
  message preserved as a prefix) only when both are `true`. `allocatePort`'s
  existing collision test updated to assert `instanceof RegistryCollisionError`
  and its fields.
- **§3**: `reapOrphans`'s existing
  "does not let one orphan's failure prevent a later orphan..." test
  extended to also assert `result.failed` names the failed key and carries
  the thrown error.
- **§4**: new `resolveIdentity` test — a `gitDir` whose basename is `___`
  (unsanitizable, matching `sanitizeSlug`'s own test coverage) throws an
  error naming the raw name and the fix, rather than `sanitizeSlug`'s bare
  `"produced an empty slug"`.

## Acceptance criteria

1. `allocatePort(registry, dbSlug, rawName)` (arguments swapped) fails to
   compile; `dbNamesForSlug(rawName)` fails to compile. Both proven by
   `@ts-expect-error` pins, not by inspection.
2. A `RegistryCollisionError` thrown after a same-run reap failure, whose
   colliding key is legacy-shaped, carries a message explaining the
   ambiguity and naming the retry; the same collision after a *successful*
   reap, or against a provably different (non-legacy-shaped) worktree, does
   not.
3. `ReapResult`/`runReap`'s return value names every row that failed to
   reap; all three callers log it distinctly from the routine "N reaped"
   line.
4. `resolveIdentity` on an unsanitizable raw name throws an error naming
   that raw name and the fix (rename the directory), not
   `sanitizeSlug`'s generic message.
5. `npm run verify` and the full worktree test suite
   (`src/lib/worktree/*.test.ts`) pass with no behavior change to any
   existing assertion outside what §2-§4 explicitly add.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
