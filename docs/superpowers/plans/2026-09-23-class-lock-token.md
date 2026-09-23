# ClassLock Token Implementation Plan (#219)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `readSeatCount`'s "caller must hold the `Class` row lock" precondition a compile-time requirement: it accepts a `ClassLock` token that only `lockClassRow` can produce, instead of a raw `classId`.

**Architecture:** `lockClassRow` (`src/lib/db-locks.ts`) returns an opaque branded `ClassLock` carrying the `classId` it locked. `readSeatCount` (`src/services/capacity.ts`) takes that token and counts `lock.classId`, so the class counted is by definition the class locked. The `TransactionClientOnly` brand stays on both. The token and the brand cover different gaps and are used together. No runtime or SQL change.

**Tech Stack:** TypeScript strict, Prisma, Vitest (`unit` project, real test DB), `tsc --noEmit` for the compile-time pins.

**Spec:** None — gated out. Single subsystem, one design, agreed at the direction gate in the #219 session: **option A without the `unsafeClassLockTaken` escape hatch**. The issue body is the design record: `gh issue view 219`.

## Global Constraints

- TypeScript `strict: true`. No `any`. The only `as ClassLock` cast in `src/` is inside `lockClassRow`.
- Branded types follow the house pattern (`src/lib/auth/link-delivery.ts`, `src/lib/timezone.ts`): `declare const xBrand: unique symbol;` plus `{ readonly [xBrand]: true }`. The issue's sketch (`{ readonly __classLock: unique symbol }`) also compiles (checked with `tsc --strict` on 2026-09-23), but it names the brand with a readable string key. Use the house pattern for consistency, and because a non-exported symbol key cannot be spelled at all outside `db-locks.ts`.
- Comment Discipline (CLAUDE.md): no counts or caller rosters in comments, no "this used to say…" history, and correct a claim by replacing it.
- Never `git add -A` / `git add .` — stage exact paths.
- Do not edit applied migrations or older specs/plans under `docs/superpowers/`; they are records.

## Premise, as measured on 2026-09-23 (main @ 63cda560)

The issue was filed while four of the five `readSeatCount` callers still used an inline `FOR UPDATE`. That no longer holds:

- #104, #215, #182 and #212 are all CLOSED.
- All five `readSeatCount` call sites are preceded, in the same transaction, by `lockClassRow(tx, <same id>)`:
  - `src/app/api/registrations/route.ts` 119 → 193
  - `src/services/waitlist.ts` 251 → 269, 525 → 560, 661 → 713, 949 → 951

  Re-derive with: `git grep -n "readSeatCount(\|lockClassRow(" -- src/app/api/registrations/route.ts src/services/waitlist.ts`
- Consequently, the escape hatch the issue sized by "the four inline sites (#104)" has nothing to cover and is **not built**.
- Option B was rejected on current code: `lockClassRow` now also runs `setLockTimeout` and locks the companion `CalendarEntry` row. A bare `FOR UPDATE` inside `readSeatCount` would be unbounded for a caller that skipped `lockClassRow`, which is the regression #104 closed. It would also break the convention in `docs/lock-order.md` that a `Class` row is locked together with its entry.

## Out of scope

- `lockClassRowsOrdered` does **not** return tokens. No `readSeatCount` caller uses it, so a token it produced would certify a type nothing consumes.
- Case 3 from the issue (a nested client that never took the lock) stays open. TypeScript cannot bind a value to a closure. The docblock says so in one line.
- `waitlist-reconciliation.ts:570-584` ("Deliberately NOT `readSeatCount`") stays true as written, so leave it.
- The `db-locks.ts` register entry for `readSeatCount` ("it issues no transaction-scoped statement, only reads") stays true under option A, so leave it.
- The `capacity.ts` module header's count of write paths predates this issue. Do not touch it.

---

### Task 1: `ClassLock` token from `lockClassRow`, required by `readSeatCount`

**Files:**
- Modify: `src/lib/db-locks.ts`: add `ClassLock` and its brand next to `TransactionClientOnly` (line ~73); change `lockClassRow` (line ~279) to return `Promise<ClassLock>` and add a paragraph on the return value to its docblock.
- Modify: `src/services/capacity.ts`: change `readSeatCount`'s signature and body (line ~93), and rewrite its docblock (lines ~65-92).
- Modify: `src/app/api/registrations/route.ts` (lines 119, 193).
- Modify: `src/services/waitlist.ts` (lines 251/269, 525/560, 661/713, 949/951).
- Test: `src/lib/db-locks.test.ts`: compile-time pins in the never-called block (lines ~59-90), plus one runtime test using the existing `captureStatements` helper (line ~590).
- Test: `src/services/capacity.test.ts`: each `readSeatCount` call (lines 120, 127, 140, 166) takes the lock first.

**Interfaces:**
- Produces:
  ```ts
  // src/lib/db-locks.ts
  declare const classLockBrand: unique symbol;
  export type ClassLock = { readonly classId: string; readonly [classLockBrand]: true };
  export async function lockClassRow(tx: TransactionClientOnly, classId: string): Promise<ClassLock>;

  // src/services/capacity.ts
  export async function readSeatCount(tx: TransactionClientOnly, lock: ClassLock): Promise<SeatCount>;
  ```
- Callers of `lockClassRow` that do not count seats keep writing `await lockClassRow(tx, id);` and discard the token. That is intended, and none of them change.

- [ ] **Step 1: Write the failing compile-time pins**

In `src/lib/db-locks.test.ts`, import the type: add `type ClassLock,` to the `./db-locks` import list.

In `_theBrandRejectsABareClient`, add a `lock: ClassLock` parameter and change the `readSeatCount` line so that the bare client is the **only** thing wrong with it. With the raw string still in place, the directive would be satisfied by the string argument too, and would keep passing if the brand were removed:

```ts
async function _theBrandRejectsABareClient(client: PrismaClient, lock: ClassLock): Promise<void> {
  // …existing lines unchanged…
  // @ts-expect-error Read-only, but meaningless off a bare client: it would
  // count outside the caller's lock, which is the defect it exists to prevent.
  await readSeatCount(client, lock);
  // …existing lines unchanged…
}
```

Directly after that function, add a second never-called function:

```ts
/**
 * `readSeatCount` counts only a class some statement has locked (#219). The
 * brand above proves the caller is inside a transaction; this proves the
 * caller holds a `ClassLock`, which only `lockClassRow` mints, for the class
 * being counted. Neither implies the other, so each has its own pins.
 *
 * One directive per way of reaching the count without a lock, because each
 * one fails under a different weakening: widening the parameter to accept a
 * string frees the first, and dropping the brand from `ClassLock` frees the
 * second.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _readSeatCountRequiresALock(tx: TransactionClientOnly): Promise<void> {
  // @ts-expect-error A raw id is a class nobody locked — #212's shape exactly.
  await readSeatCount(tx, 'never-called');
  // @ts-expect-error A hand-built token is the same thing with a costume on.
  await readSeatCount(tx, { classId: 'never-called' });
}
```

- [ ] **Step 2: Add the failing runtime test**

In `src/lib/db-locks.test.ts`, inside the `describe` that defines `captureStatements` (line ~590), add:

```ts
it('lockClassRow hands back a token naming the class it locked', async () => {
  const { tx } = captureStatements();
  const lock = await lockClassRow(tx, 'class-219');
  expect(lock.classId).toBe('class-219');
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `pnpm run typecheck`
Expected: FAIL. Two `error TS2578: Unused '@ts-expect-error' directive.` lines in `db-locks.test.ts`, on the two new directives, because `readSeatCount` still accepts a string. There is also a `TS2345` on `readSeatCount(client, lock)` (a `ClassLock` is not a `string`), which the existing directive absorbs.

Run: `pnpm exec vitest run src/lib/db-locks.test.ts -t "token naming"`
Expected: FAIL. `lock` is `undefined`, with `TypeError: Cannot read properties of undefined (reading 'classId')`.

- [ ] **Step 4: Implement the token in `db-locks.ts`**

Next to `TransactionClientOnly` (line ~73):

```ts
declare const classLockBrand: unique symbol;

/**
 * Proof that this transaction holds the `Class` row lock for `classId`.
 *
 * Minted only by `lockClassRow` below, which is the only `as ClassLock` in
 * `src/`. `readSeatCount` (`services/capacity.ts`) requires one, so counting a
 * class nobody locked, or a different class from the one locked, does not
 * compile (#219). It does not tie the token to a particular transaction
 * client; `TransactionClientOnly` narrows that but cannot close it.
 */
export type ClassLock = { readonly classId: string; readonly [classLockBrand]: true };
```

Change `lockClassRow`:

```ts
export async function lockClassRow(tx: TransactionClientOnly, classId: string): Promise<ClassLock> {
  await setLockTimeout(tx);
  await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
  await tx.$queryRaw`
    SELECT e.id FROM "CalendarEntry" e
    JOIN "Class" c ON c."calendarEntryId" = e.id
    WHERE c.id = ${classId}
    FOR UPDATE OF e`;
  return { classId } as ClassLock;
}
```

Append to its docblock, before the "Must be given a transaction client…" paragraph:

```
 * Returns a `ClassLock` for the row it just locked. Callers that only need the
 * lock discard it; a caller that counts seats passes it to `readSeatCount`.
```

- [ ] **Step 5: Change `readSeatCount` and rewrite its docblock**

In `src/services/capacity.ts`, change the import to `import type { ClassLock, TransactionClientOnly } from '@/lib/db-locks';` and the function to:

```ts
export async function readSeatCount(
  tx: TransactionClientOnly,
  lock: ClassLock,
): Promise<SeatCount> {
  const { classId } = lock;
  const cls = await tx.class.findUniqueOrThrow({
    where: { id: classId },
    select: { maxStudents: true },
  });

  const activeCount = await tx.registration.count({
    where: { classId, status: { in: [...ACTIVE_REGISTRATION_STATUSES] } },
  });

  const freeSeats = cls.maxStudents - activeCount;
  return { maxStudents: cls.maxStudents, activeCount, freeSeats, isFull: freeSeats <= 0 };
}
```

Replace the docblock's first two paragraphs (the "**Precondition…**" and "deliberately does NOT take the lock" paragraphs) and its last paragraph (the one about the `TransactionClientOnly` brand and #219). Keep the middle "It reads the class rather than accepting one…" paragraph verbatim. The new text:

```
 * Counts the seats left in a class, under the caller's `Class` row lock.
 *
 * **It takes the lock as a `ClassLock`, not a class id.** Only `lockClassRow`
 * (`db-locks.ts`) mints one, so a count with no lock behind it does not
 * compile, and the class counted is the class locked — it has no other id to
 * read. Without the lock the answer would be a snapshot with no meaning: a
 * registration committing a millisecond later makes it wrong, which is the
 * defect this module exists to fix (#212).
 *
 * It does not take the lock itself: `lockClassRow` also bounds the wait and
 * locks the class's `CalendarEntry` alongside it, and a second, bare
 * `FOR UPDATE` here would do neither.
 *
 * …"It reads the class rather than accepting one" paragraph, unchanged…
 *
 * The `TransactionClientOnly` brand rejects a bare `PrismaClient` at compile
 * time (see `db-locks.ts`). What neither it nor the token can check is that
 * `tx` is the same transaction that took the lock, so do not hand a token
 * across a transaction boundary.
```

- [ ] **Step 6: Update the five call sites**

Each one keeps the token from the lock it already takes. `src/app/api/registrations/route.ts`:

```ts
      const lock = await lockClassRow(tx, body.classId);   // was line 119
      …
      const { isFull } = await readSeatCount(tx, lock);    // was line 193
```

`src/services/waitlist.ts`, with the same pattern at each pair (251/269, 525/560, 661/713, 949/951):

```ts
    const lock = await lockClassRow(tx, classId);
    …
    const { isFull } = await readSeatCount(tx, lock);
```

(and at 951: `const seats = await readSeatCount(tx, lock);`). If `lock` shadows an existing name in any of those scopes, use `classLock` there. Check with `pnpm run typecheck`, not by eye.

- [ ] **Step 7: Update `capacity.test.ts` to lock before counting**

Add `import { lockClassRow } from '@/lib/db-locks';` and change each `readSeatCount(tx, X)` call (lines 120, 127, 140, 166) to:

```ts
await prisma.$transaction(async (tx) => readSeatCount(tx, await lockClassRow(tx, classId)));
```

(with `overClassId` at line 166). This is also the honest form of these tests: they previously counted with no lock, which is the exact usage #219 removes.

- [ ] **Step 8: Run to verify green**

Run: `pnpm run typecheck`
Expected: PASS, with no output after `tsc --noEmit`.

Run: `pnpm exec vitest run src/lib/db-locks.test.ts src/services/capacity.test.ts`
Expected: PASS, both files.

Run: `pnpm run lint`
Expected: PASS.

- [ ] **Step 9: Prove every pin bites (mutate → record exact text → restore)**

Commit Steps 1–8 first (Step 10's commit) **before** mutating. Otherwise restoring a mutation with `git checkout` discards the uncommitted work. Apply each mutation alone, run `pnpm run typecheck` (M4: the vitest command), record the exact error line in the ledger, restore with `git checkout -- <file>`, and confirm `git status --porcelain` is empty before the next one.

| # | Mutation (exact) | Expected RED |
|---|---|---|
| M1 | `capacity.ts`: `lock: ClassLock,` → `lock: ClassLock \| string,` and `const { classId } = lock;` → `const classId = typeof lock === 'string' ? lock : lock.classId;` (the realistic "convenience overload" regression) | `TS2578: Unused '@ts-expect-error' directive.` on the raw-id line of `_readSeatCountRequiresALock` |
| M2 | `db-locks.ts`: `export type ClassLock = { readonly classId: string; readonly [classLockBrand]: true };` → `export type ClassLock = { readonly classId: string };` | `TS2578` on the hand-built-token line |
| M3 | `capacity.ts`: `tx: TransactionClientOnly,` → `tx: Prisma.TransactionClient,` (add `import type { Prisma } from '@prisma/client';`) | `TS2578` on `readSeatCount(client, lock)` in `_theBrandRejectsABareClient`. **This is the one Step 1 re-armed.** Also re-run M3 with that line temporarily reverted to `readSeatCount(client, 'never-called')` and record that it stays GREEN. That records why the pin had to change. |
| M4 | `db-locks.ts`: `return { classId } as ClassLock;` → `return { classId: '' } as ClassLock;` | vitest: `lockClassRow hands back a token naming the class it locked` fails with `expected '' to be 'class-219'`. `capacity.test.ts` should also go red (counts the wrong class). Record which of its tests fail. |

After the sweep: `git status --porcelain` is empty and `pnpm run typecheck` passes.

- [ ] **Step 10: Commit**

```bash
git add src/lib/db-locks.ts src/lib/db-locks.test.ts src/services/capacity.ts src/services/capacity.test.ts src/app/api/registrations/route.ts src/services/waitlist.ts
git commit -m "fix(capacity): readSeatCount takes a ClassLock from lockClassRow (#219)"
```

(Commit before Step 9's mutations. The step numbering is reading order, not execution order.)

- [ ] **Step 11: Sweep for what this invalidated**

Each hit gets a verdict in the ledger (keep / rewritten / not ours):

```bash
git grep -n "#219" -- src docs/*.md CLAUDE.md
git grep -n "review obligation\|does not take the lock\|does NOT take the lock" -- src
git grep -n "readSeatCount(" -- src | grep -v "\.test\.ts"
git grep -n "as ClassLock" -- src
```

Expected: `#219` appears only in the new text; no "review obligation" remains in `capacity.ts`; each `readSeatCount(` production call passes a token; there is exactly one `as ClassLock` (in `lockClassRow`). The last two are PR-body facts, with the command shown. They do not go in a comment. Hits in `docs/superpowers/specs|plans/` are records and are left alone.

If anything changed, commit it: `git commit -m "docs: sweep stale lock-precondition wording (#219)"` with exact paths.

---

## Finishing (per the solve-issue skill)

Single-task plan, so there is **no** whole-branch review. Go straight to: `pnpm run verify` (needs the app live, and in this worktree that means `pnpm install --frozen-lockfile`, `pnpm run worktree:setup`, then `pnpm run worktree:up`), push, open the PR with `Closes #219` in a `--body-file`, then `/pr-review-toolkit:review-pr <N>`. Type-design review **is** in scope, since the PR's subject is a type.

The PR body records: the premise corrections above (the escape hatch dropped because #104 landed; B rejected on the current `lockClassRow`); M1–M4 with their exact error text, including M3's "stays green with the old line" result; and the census commands from Step 11 with their output.
