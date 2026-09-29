# Fixture suffix collision (#705) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No DB-backed test file can match or delete another file's rows because both drew the same `Date.now()` suffix.

**Architecture:** Test-only change. The three files whose fixture suffix is a bare time value move to the existing `uniqueSuffix()` (`tests/helpers.ts`, time + 24 random bits); the two #705 named additionally match their own rows by exact address, so they cannot reach a sibling's rows whatever the suffix. The helper's docblock, which asserts a cross-file property #705 falsified, is corrected, and the rule plus the census that found the three files is recorded in `docs/technical-architecture.md`.

**Tech Stack:** Vitest 4 (`unit` project, `fileParallelism: true`), Prisma, PostgreSQL test database.

**Spec:** none — single subsystem, one approach (the solve-issue spec gate). The premise check below stands in for one.

## Premise check (measured 2026-09-29, before this plan)

- Both named files hold as #705 describes: `src/lib/auth/account.test.ts:6` and `tests/scoped-sweep.test.ts:6` are `Date.now()`, matched at `:63` (`contains: ${uniqueSuffix}`, a `deleteMany`) and `:113` (`contains: -${suffix}@`, a `findMany`). Both run in the parallel `unit` tier (neither is in `vitest.tiers.ts`).
- Census population — files that match fixture rows by substring:
  `grep -rlE '(contains|startsWith|endsWith)\s*:' --include='*.test.ts' --include='*.spec.ts' --include='*fixtures.ts' src tests` → **37** (36 test files + `tests/room-fixtures.ts`). No raw-SQL `LIKE`, no JS-side `.includes(suffix)` filtering (both grepped, zero hits).
- Of the 37: 33 derive their suffix from `uniqueSuffix()` or an inline `${Date.now()}-${randomBytes(3)}` — safe (a cross-file match needs the same millisecond **and** the same 24 random bits). 37 − 33 = 4 remain:
  - `account.test.ts`, `scoped-sweep.test.ts` — bare `Date.now()`, **unsafe** (#705).
  - `src/lib/auth/profile-authorization.test.ts:25` — `pa-${Date.now()}`, matched by `contains` in a `deleteMany`. Not named by #705. Safe today only because no other file writes a `pa-` prefix (`grep -rnE 'pa-\$\{' src tests` → this line alone); nothing holds that. **Fix.**
  - `src/lib/auth/magic-link.test.ts` — `Date.now()` addresses, but every match on them is exact (`where: { email }`, `in: [...]`); its only substring deletes are literal (`startsWith: 'magic-link-cleanup-'`, `endsWith: '@example.com'`). The `@example.com` sweep would reach `handoff.test.ts`/`link-delivery.test.ts`/`signup-ticket.test.ts` tokens if they ran concurrently — they cannot: the file is in `SWEEP_TESTS`, so it runs in `unit-sweeps`, a separate `vitest run` after `unit` (`package.json` `test`; `ci.yml` steps "unit" then "unit-sweeps"), serial, and integration uses a different database. **Ruled safe; no change.**
- Reproduction (the proof mechanism Task 1 reuses): with both suffixes forced to `1790690447845`, a plain parallel run was red 1 time in 5 — overlap is timing luck. With the three HOLD lines below added, 3/3 runs were red with **both** #705 symptoms: `expected [ …(7) ] to deeply equal [ …(4) ]` and `Foreign key constraint violated on the constraint: \`Teacher_accountId_fkey\``. A fixed suffix leaves 3 account rows behind per red run (the FK failure rolls back account's whole `deleteMany`); they must be removed between runs.

## Global Constraints

- TypeScript `strict`; no `any`.
- Never `git add -A` / `git add .`; stage exact paths.
- Comment discipline (CLAUDE.md): a comment annotates only the code it sits on; no counts or member lists in comments; state what is true now, no "previously read".
- Counts live in `docs/` only, with the command that re-derives them.
- A temporary mutation is stored as exact text in this plan and the tree must end clean (`git status --short` shows only intended changes).

## Review Focus

1. A fully identical suffix (time **and** random part) in both files — the fix must still keep them apart; this is Task 1's green proof, not a hope.
2. `account.test.ts`'s `resolveOrClaimAccount` claim test creates an Account for `unclaimedEmail`; an exact-address cleanup that omits it leaks a row per run.
3. `scoped-sweep`'s test is about the scope NOT narrowing Account — an exact-address read must still fail if Account were narrowed by the Teacher scope.
4. The helper docblock must not re-state a roster of where concurrency arises (that is a claim about other modules) — link to the doc instead.
5. The doc's census command must list `magic-link.test.ts` and not the three fixed files once the change lands.

---

### Task 1: Key the three time-only fixture suffixes on `uniqueSuffix()`, and match by exact address in the two #705 files

**Files:**
- Modify: `src/lib/auth/account.test.ts` (suffix at `:6`, `afterAll` delete at `:63`, and every use of `uniqueSuffix` in the file — the local const shadows the helper's name, so rename it)
- Modify: `tests/scoped-sweep.test.ts` (suffix at `:6`, the read at `:113` and its comment at `:111-112`)
- Modify: `src/lib/auth/profile-authorization.test.ts` (suffix at `:25`)

**Interfaces:**
- Consumes: `uniqueSuffix(): string` from `tests/helpers.ts` (returns `${Date.now()}-${6 hex}`). From `src/`, import it as `../../../tests/helpers` (see `src/lib/auth/magic-link.test.ts:9` for the relative-path idiom from this directory).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Reproduce the collision (red) on the unmodified files**

Apply these exact-text mutations (temporary — do not commit):

`src/lib/auth/account.test.ts`: line `const uniqueSuffix = Date.now();` → `const uniqueSuffix = 1790690447845;`, and line `afterAll(async () => {` → `afterAll(async () => { await new Promise((r) => setTimeout(r, 2000)); // HOLD-705`

`tests/scoped-sweep.test.ts`: line `const suffix = Date.now();` → `const suffix = 1790690447845;`; line `beforeAll(async () => {` → `beforeAll(async () => { await new Promise((r) => setTimeout(r, 1000)); // HOLD-705`; line `afterAll(async () => {` → `afterAll(async () => { await new Promise((r) => setTimeout(r, 3000)); // HOLD-705`

Why the holds: account's `afterAll` waits 2 s so all its rows (including the claimed account) are alive; scoped-sweep starts its tests 1 s in, inside that window; scoped-sweep's `afterAll` waits 3 s so its teachers still reference their accounts when account's `contains` delete runs at ~2 s.

Run: `pnpm exec vitest run --project unit src/lib/auth/account.test.ts tests/scoped-sweep.test.ts`
Expected: exit 1; `expected [ …(7) ] to deeply equal [ …(4) ]` and `Foreign key constraint violated on the constraint: \`Teacher_accountId_fkey\``.

Then remove the residue a red run leaves (3 accounts whose email contains `1790690447845`) from the test database — a throwaway script outside git, run with `pnpm exec tsx --env-file=.env <script>`, doing `account.deleteMany({ where: { email: { contains: '1790690447845' } } })` (also students, teachers first) on a `PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST })`. Then `git checkout -- src/lib/auth/account.test.ts tests/scoped-sweep.test.ts` (no other edits exist in those files yet).

- [ ] **Step 2: Fix `account.test.ts`**

Replace the local `const uniqueSuffix = Date.now();` with `const suffix = uniqueSuffix();`, importing `uniqueSuffix` from `../../../tests/helpers`, and replace every `${uniqueSuffix}` use in the file with `${suffix}` (the emails, `pageSlug`, and the `nobody-…` address in the last test). Change the `afterAll` account delete to match exactly the three addresses the file owns:

```ts
await db.account.deleteMany({
  where: { email: { in: [teacherEmail, claimedEmail, unclaimedEmail] } },
});
```

`unclaimedEmail` is in the list because the claim test creates an Account for it (Review Focus 2).

- [ ] **Step 3: Fix `scoped-sweep.test.ts`**

Replace `const suffix = Date.now();` with `const suffix = uniqueSuffix();`, importing it from `./helpers`. Change the read at `:113` to the exact addresses the file recorded:

```ts
const accounts = await s.db.account.findMany({ where: { email: { in: emails } } });
```

and reword the comment above it so it describes this read: Account is not named in the scope, so the read reaches every account this file created — by their exact addresses. (If the Teacher scope leaked onto Account, the Teacher ids would narrow it to none and the equality below would fail — Review Focus 3. State that in one line only if it reads naturally; do not add a count.)

- [ ] **Step 4: Fix `profile-authorization.test.ts`**

`const suffix = \`pa-${Date.now()}\`;` → `const suffix = \`pa-${uniqueSuffix()}\`;`, importing from `../../../tests/helpers`. The `contains: suffix` delete at `:32` stays; the random part is what protects it.

- [ ] **Step 5: Run the three files — green**

Run: `pnpm exec vitest run --project unit src/lib/auth/account.test.ts tests/scoped-sweep.test.ts src/lib/auth/profile-authorization.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth/account.test.ts tests/scoped-sweep.test.ts src/lib/auth/profile-authorization.test.ts
git commit -m "test(fixtures): key time-only fixture suffixes on uniqueSuffix() (#705)"
```

(Body: which files, and that the two #705 files now match by exact address.)

- [ ] **Step 7: Prove the fix bites — identical suffix, same holds, green**

Temporary, do not commit. In `tests/helpers.ts`, `return \`${Date.now()}-${crypto.randomBytes(3).toString('hex')}\`;` → `return '1790690447845-000000'; // HOLD-705` — both files now draw a **fully identical** suffix. Re-apply the three HOLD lines from Step 1 to the fixed files (`afterAll(async () => {` in account.test.ts; `beforeAll(async () => {` and `afterAll(async () => {` in scoped-sweep.test.ts).

With the fixed helper and the holds in place, run the Step 1 command for each variant below, removing residue rows between runs, and record each output:

- (a) The fix as committed → expected exit 0, 18 passed.
- (b) Additionally revert only scoped-sweep's read to `contains: \`-${suffix}@\`` → expected red, `expected [ …(7) ] to deeply equal [ …(4) ]`. Proves the exact read is what holds under a fully identical suffix. Undo (b) before (c).
- (c) Additionally revert only account.test's `afterAll` account delete to `{ email: { contains: \`${suffix}\` } }` → expected red, `Teacher_accountId_fkey`. Proves the exact delete is what holds.

Also one run with the helper's real `Date.now()` + random part restored but both files' changes reverted is **not** needed — the random part's protection is probabilistic (1 in 2²⁴) and no run can demonstrate it; the doc states it as arithmetic.

Restore: `git checkout -- tests/helpers.ts src/lib/auth/account.test.ts tests/scoped-sweep.test.ts`, then `git status --short` must be empty (Step 6 committed the fix, so checkout restores the fixed versions). Remove any residue rows as in Step 1 (search `1790690447845`).

### Task 2: Correct `uniqueSuffix()`'s docblock and record the rule and census

**Files:**
- Modify: `tests/helpers.ts:90-97` (the `uniqueSuffix` docblock)
- Modify: `docs/technical-architecture.md` (Testing conventions — new paragraph after **Shared fixtures.**)

**Interfaces:** none.

- [ ] **Step 1: Correct the docblock**

The current text says every file "already namespaces its fixtures with its own prefix, so the random component only matters for *overlapping* runs". #705 falsified both halves: `account.test.ts` had no namespace in its match, and the random part is what separates two files loading in the same millisecond within one run. Replace it with what is true now, annotating only this function:

```ts
/**
 * Per-run suffix for fixture identities (email, pageSlug, address). The
 * random part is what keeps two files' fixtures apart when both load in the
 * same millisecond, whether in parallel workers of one run or in two
 * overlapping runs — a file matching its rows by substring on this suffix
 * relies on it (#705). The rule is in `docs/technical-architecture.md`,
 * "Testing conventions".
 */
```

- [ ] **Step 2: Add the rule and census paragraph**

Insert after the **Shared fixtures.** paragraph in `docs/technical-architecture.md`:

```markdown
**Fixture suffixes.** A file that matches its own rows by substring — a `contains`, `startsWith` or `endsWith` on an email, slug or address — keys that match on `uniqueSuffix()`, never on a bare `Date.now()`. Test files load concurrently in the `unit` tier (`fileParallelism: true`), in CI's integration step (`--file-parallelism`) and across Playwright workers, and two files loading in the same millisecond draw the same `Date.now()`: each file's substring then matches the other's rows. In #705 that made a read return seven rows instead of four and a cleanup `deleteMany` fail on `Teacher_accountId_fkey`, because it reached a sibling file's account. `uniqueSuffix()`'s random part leaves only a 1-in-2²⁴ tie within one millisecond. Where a file holds the exact addresses or ids it created, matching them with `in: [...]` is stronger: that cannot reach another file's rows whatever the suffix.

Census (2026-09-29, #705). The files matching fixture rows by substring — 37 at the time:

    grep -rlE '(contains|startsWith|endsWith)\s*:' --include='*.test.ts' --include='*.spec.ts' --include='*fixtures.ts' src tests

The time-derived values among them with no random part on the same line — candidates, read by hand, since most hits are clock arithmetic (`expiresAt`, deadlines) rather than identities:

    grep -nE 'Date\.now\(\)|getTime\(\)|performance\.now\(\)' $(grep -rlE '(contains|startsWith|endsWith)\s*:' --include='*.test.ts' --include='*.spec.ts' --include='*fixtures.ts' src tests) | grep -v randomBytes

After #705 its identity hits sit only in `src/lib/auth/magic-link.test.ts`, which matches each such address exactly and runs in `SWEEP_TESTS` — serial, in a separate `vitest run` from the parallel tier.
```

Before committing, run both commands and confirm: the first prints 37 paths; the second's identity hits (template-literal addresses, not `expiresAt`/deadline arithmetic) are all in `magic-link.test.ts`. If `getTime\(\)` adds identity hits elsewhere, read each and either fix it in Task 1's manner or correct the paragraph — the paragraph must describe what the command prints.

- [ ] **Step 3: Commit**

```bash
git add tests/helpers.ts docs/technical-architecture.md
git commit -m "docs(tests): state what uniqueSuffix() guards and record the #705 census"
```
