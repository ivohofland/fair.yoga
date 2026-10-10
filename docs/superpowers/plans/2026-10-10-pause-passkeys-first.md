# The pause removes recent passkeys before it ends sessions (#811)

**Decided with the user:** issue #811's option 1. The magic-link window stays
open and is written down as accepted. The page copy does not change.
`docs/superpowers/specs/2026-10-10-sign-out-race-design.md` records the design
that was considered and not built. No spec is needed for this change: it is
one file, with one obvious approach.

## Why only the passkey window

- **The passkey window is worth closing.** A session that lands in it can
  outlive the pause, and the pause deletes the passkey that would have been
  the thief's way back in.
- **The magic-link window gives the thief nothing new.** A session that lands
  in it is one a holder of the inbox could start a second after the pause
  anyway. The resume gate is the defence against that, and it is unchanged.

## Task 1: reorder `pausePayments`, with the tests and docs that state the order

**Files:** `src/services/payout-pause.ts`, a new
`src/services/payout-pause-order.test.ts`,
`src/services/payout-pause-lock-order.test.ts`, `docs/lock-order.md` (the pause
entry and the revoke entry), `docs/technical-architecture.md` (only where it
states the pause's order), and the spec named above.

1. **Write the failing test first.** Add `payout-pause-order.test.ts`, copying
   the recording-client pattern from `passkey-revoke-order.test.ts`. Seed a
   teacher, a `PayoutChangeEvent`, a `PayoutPauseToken`, a passkey created now
   (so it is past the cutoff and gets deleted) and a session. Assert that
   `passkeyCredential.deleteMany` comes before `session.deleteMany` in the call
   order, and that both are present. Run it and record that it fails.
2. **Reorder `pausePayments`.**
   - The new order is: the passkey delete (with its `removeFrom` calculation),
     then `signOutEverywhereTx`, then the `MagicLinkToken` delete.
   - That puts the token delete after the sessions. This is deliberate: the
     token-versus-session order cannot close the magic-link window, because
     the consume has already happened outside the pause, and keeping it
     unchanged leaves fewer lines moved.
   - Rewrite the function's docblock or inline comment so it states the
     passkey-first reason, as `passkey-revoke.ts`'s docblock does. It must
     also state the accepted magic-link window in one line, linking to the
     lock-order entry rather than arguing the point.
   - Run the new test and see it pass.
3. **Prove the test bites.** Swap the two statements back, run the test,
   record the exact failure text, restore, and run it again.
4. **Re-aim `payout-pause-lock-order.test.ts`.** It holds a passkey row so the
   pause's *last* statement times out, and it asserts that the session
   survived. After the reorder, the passkey delete is no longer last, so that
   assertion would pass without proving anything.
   - Hold the seeded `Session` row (`FOR UPDATE`) instead, since sessions now
     come after passkeys.
   - Add an assertion that the passkey still exists, which proves the earlier
     passkey delete rolled back.
   - Check that the seeded session names no credential, so the passkey
     delete's `SET NULL` does not block first. If it does block first, the
     test would still time out, but on the wrong statement.
   - Update the file's header and the "Recent, so…" comment.
   - Prove it bites: make the held row one the pause never touches (a session
     on another account), and record that the test fails because the pause
     succeeds.
5. **Docs.**
   - **`docs/lock-order.md`, pause entry.** Restate the statement order. Replace
     the "Sessions go before passkeys" paragraph, don't amend it. The new
     reasoning: a passkey sign-in with a removed credential either committed
     before the delete, so the later session delete catches it, or blocks on
     the credential and then fails its foreign key, or its counter `update`
     fails, and that sign-in answers 500. Add the magic-link window as
     accepted, with the reason given above. Keep the deadlock paragraph with
     `deletePasskey`: the teacher lock still orders the two.
   - **`docs/lock-order.md`, revoke entry.** It has the same magic-link
     window. One sentence pointing at the pause entry's reasoning.
   - **`docs/technical-architecture.md`.** `grep -n` for the pause's order and
     for "sessions" near `pausePayments`, and fix any statement that names the
     old order.
   - **The spec.** Add a status line at the top: considered and not built,
     #811 took option 1, kept for its survey of sign-in paths. Keep the body.
   - Sweep: `grep -rn -i "sessions go before passkeys\|before the passkey\|then the passkeys"`
     across `docs/` and `src/`, and give every hit a verdict.
6. **Verify.** Run `pnpm exec vitest run --project integration` on the three
   pause test files and `passkey-revoke-order.test.ts`, then `pnpm run verify`
   against this worktree's app (`pnpm run worktree:up`).

The page copy in `payout-pause-form.tsx` does not change.

---

## Task 2: the `Account` row orders every multi-session sign-out write

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-10-10-account-sign-out-lock-design.md`.
Read it first. It states the deadlock, the rule and the table of holders this
task implements.

**Goal:** every transaction that writes more than one of an account's
`Session` rows, directly or through a passkey delete's `ON DELETE SET NULL`,
first takes `FOR NO KEY UPDATE` on that `Account` row. The functions that do
those writes require proof of that lock, so a path that skips it fails to
compile.

**Architecture:** a new branded lock, `AccountSignOutLock`, minted only by
`lockAccountForSignOut` in `src/lib/db-locks.ts` and bound at runtime to the
transaction client that minted it, exactly as `ClassLock` is. Three writer
functions take the lock as a parameter in place of a bare `accountId`:
`signOutEverywhereTx`, `removePasskeyLocked`, and a new
`deleteAccountPasskeys`. Six holders take the lock: `signOutEverywhere`,
`pausePayments`, `revokePasskeyByLink`, `deletePasskey`,
`deleteStudentAccount` and `deleteTeacherAccount`.

**Tech stack:** Prisma interactive transactions, Postgres row locks, Vitest.
The `unit` tier for logic, `unit-sweeps` for `@serial-tier lock-contention`
files. Check `vitest.tiers.ts` for which tier a file lands in.

### Global constraints

- Lock order: `Teacher` or `Student` first, then `Account`, never the reverse
  (`docs/lock-order.md`, "The `Teacher` row is the first lock").
- `FOR NO KEY UPDATE`, never `FOR UPDATE`. It must not conflict with the
  `FOR KEY SHARE` that foreign-key inserts naming the account take.
- Every lock helper calls `setLockTimeout(tx)` first, as its siblings do.
- Comment Discipline (CLAUDE.md): no prose counts or rosters in comments. The
  holders table lives in `docs/lock-order.md`. The `db-locks.ts` adoption
  register is the one exception that already exists, and it gains entries in
  its own format.
- Sign-in paths are not touched. The magic-link window stays accepted.

### Review focus

Each line below is pinned by a test in the steps that follow.

1. **A revoke link whose account row is gone** (erased between minting and
   use): the lock returns `null`, and the link answers `invalid` with nothing
   consumed.
2. **Two "sign out everywhere" requests at once on one account**: they queue
   on the `Account` row, and both answer success.
3. **Erasing a student whose account still has a live teacher profile**: the
   sessions-and-passkeys block is skipped and no `Account` lock is taken. The
   teacher's sessions survive, as today.
4. **A sign-out held behind another holder for longer than `lock_timeout`**:
   it fails with a lock timeout, answers 503, and deletes nothing.
5. **A lock minted in one transaction, passed into another**: the writer
   throws rather than writing unprotected.

### Files

- Modify `src/lib/db-locks.ts`: the brand, `lockAccountForSignOut`,
  `assertAccountSignOutLockHeldBy`, and adoption-register entries.
- Modify `eslint.config.mjs`: a cast selector for `AccountSignOutLock`,
  modelled on `classLockCastSelector`.
- Modify `src/services/account-sign-out.ts`: `signOutEverywhereTx` takes the
  lock, and `signOutEverywhere` takes it.
- Modify `src/services/passkey-credentials.ts`: `removePasskeyLocked` takes the
  lock, `deleteAccountPasskeys` is new, and `deletePasskey` takes the lock.
- Modify `src/services/payout-pause.ts`, `src/services/passkey-revoke.ts`
  and `src/services/gdpr.ts`: each takes the lock and calls the branded
  writers.
- Modify the existing tests that call the changed signatures:
  `src/services/passkey-credentials.test.ts` and any other the compiler names.
- Create `src/services/account-sign-out-lock-order.test.ts`, marked
  `@serial-tier lock-contention`.
- Modify `src/lib/db-locks.test.ts` for the `@ts-expect-error` pins and the
  runtime refusal.
- Modify `docs/lock-order.md` and `docs/technical-architecture.md`.

### Interfaces (produced by this task)

```ts
// src/lib/db-locks.ts
export type AccountSignOutLock = { readonly accountId: string; readonly [accountSignOutLockBrand]: true };
export async function lockAccountForSignOut(tx: TransactionClientOnly, accountId: string): Promise<AccountSignOutLock | null>;
export function assertAccountSignOutLockHeldBy(tx: TransactionClientOnly, lock: AccountSignOutLock): void;

// src/services/account-sign-out.ts
export async function signOutEverywhereTx(tx: TransactionClientOnly, lock: AccountSignOutLock): Promise<{ sessions: number; pushSubscriptions: number }>;

// src/services/passkey-credentials.ts
export async function removePasskeyLocked(tx: TransactionClientOnly, lock: AccountSignOutLock, credentialId: string): Promise<{ status: 'deleted'; removedAt: Date } | { status: 'not_found' }>;
/** All the account's passkeys, or those created at or after `createdFrom`. No `RemovedPasskey` row. */
export async function deleteAccountPasskeys(tx: TransactionClientOnly, lock: AccountSignOutLock, createdFrom: Date | null): Promise<number>;
```

### Steps

- [ ] **Step 1: write the failing lock-order test.**
  Create `src/services/account-sign-out-lock-order.test.ts`. Copy the
  `latch`, `ownPid` and `waiterOf` helpers and the header style from
  `passkey-credentials-lock-order.test.ts`. Add one helper that reports which
  table a parked backend is waiting on:

  ```ts
  /** The table of the row the parked `pid` is queued for. */
  async function waitedTable(pid: number): Promise<string | null> {
    const [row] = await prisma.$queryRaw<Array<{ rel: string }>>`
      SELECT relation::regclass::text AS rel FROM pg_locks
       WHERE pid = ${pid} AND locktype = 'tuple' LIMIT 1`;
    return row?.rel ?? null;
  }
  ```

  A backend queued behind a row lock holds a `tuple` lock on that row while it
  waits on the holder's `transactionid`, so `relation` names the table. In
  `describe('every multi-session sign-out writer parks on the Account row')`,
  write one case per holder. Each case:
  1. seeds its fixture;
  2. opens a holder transaction on a second `PrismaClient` that runs
     `SELECT id FROM "Account" WHERE id = ${accountId} FOR NO KEY UPDATE`, then
     waits on a latch;
  3. starts the writer under test;
  4. asserts that `waiterOf(holderPid)` finds it and that
     `waitedTable(waiter)` is `'"Account"'` (the regclass text quotes the
     mixed-case name; check the exact literal on the first run and pin that);
  5. releases the holder and asserts the writer's normal outcome.

  The cases and their fixtures:
  - `signOutEverywhere(prisma, accountId)`: an account with two seeded
    sessions. Outcome: `{ sessions: 2, pushSubscriptions: 0 }`.
  - `pausePayments(prisma, raw, now)`: the fixture from
    `payout-pause-order.test.ts`. Outcome: `{ status: 'paused' }`.
  - `revokePasskeyByLink(prisma, raw)` on a **student-only** account (an
    `Account` with a passkey, no teacher), using `mintPasskeyRevokeToken`.
    Outcome: `status: 'revoked'`.
  - `deletePasskey(prisma, { accountId, credentialId })` on a student-only
    account. Outcome: `status: 'deleted'`.
  - `deleteStudentAccount(prisma, studentId)` for a student whose account has
    no teacher, and `deleteTeacherAccount(prisma, teacherId)` for a teacher
    whose account has no student. Reuse the fixture builders the existing
    gdpr tests use (`grep -rln "deleteTeacherAccount" src tests`). If a
    fixture is too heavy to build here, make that case assert only the parking
    and say so in the case's name.

  Add two more cases from the review focus:
  - **Item 2:** two concurrent `signOutEverywhere` calls on one account both
    resolve, and the account is left with zero sessions.
  - **Item 4:** hold the `Account` row past the shared `lock_timeout`. Assert
    that `signOutEverywhere` rejects with `isLockTimeout(err) === true`, and
    that both seeded sessions still exist.

- [ ] **Step 2: run it and record the failure.**
  `pnpm exec vitest run --project unit-sweeps src/services/account-sign-out-lock-order.test.ts`.
  Expected: the parking cases fail, because `waiterOf` returns `null` (nothing
  parks: no writer takes the lock yet) or `waitedTable` names
  `"Session"`/`"PasskeyCredential"`. Record the exact text.

- [ ] **Step 3: add the lock and its brand to `src/lib/db-locks.ts`.**
  Next to `ClassLock`, mirroring it line for line:

  ```ts
  declare const accountSignOutLockBrand: unique symbol;

  /**
   * Proof that a transaction holds `FOR NO KEY UPDATE` on an `Account` row, taken
   * before it writes more than one of that account's sessions. Minted only by
   * `lockAccountForSignOut` and bound at runtime to the transaction client that
   * minted it, as `ClassLock` is. The rule and its holders:
   * `docs/lock-order.md`, "The `Account` row orders multi-session sign-out writes".
   */
  export type AccountSignOutLock = { readonly accountId: string; readonly [accountSignOutLockBrand]: true };

  const accountSignOutHolders = new WeakMap<AccountSignOutLock, TransactionClientOnly>();

  /** The account row's lock, or `null` when the row is gone. */
  export async function lockAccountForSignOut(
    tx: TransactionClientOnly,
    accountId: string,
  ): Promise<AccountSignOutLock | null> {
    await setLockTimeout(tx);
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Account" WHERE id = ${accountId} FOR NO KEY UPDATE`;
    if (rows.length === 0) return null;
    // The one mint site the AccountSignOutLock selector in eslint.config.mjs
    // exists to be the sole exception to.
    // eslint-disable-next-line no-restricted-syntax
    const lock = Object.freeze({ accountId }) as AccountSignOutLock;
    accountSignOutHolders.set(lock, tx);
    return lock;
  }

  /** Throws unless `tx` minted `lock`; a programmer error, not a condition to handle. */
  export function assertAccountSignOutLockHeldBy(tx: TransactionClientOnly, lock: AccountSignOutLock): void {
    if (accountSignOutHolders.get(lock) !== tx) {
      throw new Error(
        `AccountSignOutLock for account ${lock.accountId} was not minted by lockAccountForSignOut on this transaction client — it is forged, or was carried across a transaction boundary.`,
      );
    }
  }
  ```

  In `eslint.config.mjs`, add `accountSignOutLockCastSelector` in the shape of
  `classLockCastSelector`, and register it wherever that one is registered.
  Add adoption-register entries in `db-locks.ts`'s docblock for
  `lockAccountForSignOut` and `deleteAccountPasskeys`, in the register's
  existing format. Update the `removePasskeyLocked` entry: it now trusts the
  `AccountSignOutLock` it is handed.

- [ ] **Step 4: brand the writers.**
  - `signOutEverywhereTx(tx, lock)`: call `assertAccountSignOutLockHeldBy(tx,
    lock)` first, then delete by `lock.accountId`.
  - `signOutEverywhere(db, accountId)`: inside its transaction, call
    `lockAccountForSignOut`. When it returns `null`, return
    `{ sessions: 0, pushSubscriptions: 0 }`. Otherwise call
    `signOutEverywhereTx(tx, lock)`.
  - `removePasskeyLocked(tx, lock, credentialId)`: assert first. `owned`
    becomes `{ id: credentialId, accountId: lock.accountId }`.
  - New `deleteAccountPasskeys(tx, lock, createdFrom)`: assert, then
    `tx.passkeyCredential.deleteMany({ where: { accountId: lock.accountId, ...(createdFrom === null ? {} : { createdAt: { gte: createdFrom } }) } })`,
    returning the count.
  - `deletePasskey`: after `lockForPasskeyRemoval` and its paused branch, take
    `lockAccountForSignOut(tx, input.accountId)`. When it returns `null`,
    answer `{ status: 'not_found' }`. Otherwise call
    `removePasskeyLocked(tx, lock, input.credentialId)`.

- [ ] **Step 5: the holders.**
  - **`pausePayments`.** Right after reading the teacher, before the paused
    branch's `teacher.update`, take
    `lockAccountForSignOut(tx, teacher.accountId)`. A live teacher's account
    cannot be gone, so throw an `Error` naming the teacher when it is `null`.
    Replace the passkey `deleteMany` with
    `deleteAccountPasskeys(tx, lock, removeFrom)`, and pass `lock` to
    `signOutEverywhereTx`. Keep the order: passkeys, sessions, tokens.
  - **`revokePasskeyByLink`.** Right after `lockForPasskeyRemoval`, before the
    consume, take `lockAccountForSignOut(tx, token.accountId)`. Return
    `{ status: 'invalid' }` when it is `null`; this is review focus item 1, and
    nothing has been consumed at that point. Call
    `removePasskeyLocked(tx, lock, token.credentialId)` and
    `signOutEverywhereTx(tx, lock)`.
  - **`deleteStudentAccount` and `deleteTeacherAccount`.** Inside the
    `if (!teacherOnAccount)` and `if (!studentOnAccount)` blocks, first take
    `lockAccountForSignOut(tx, <accountId>)`, throwing when it is `null`.
    Then replace the session, push-subscription and passkey deletes with
    `signOutEverywhereTx(tx, lock)` and
    `deleteAccountPasskeys(tx, lock, null)`. Leave the `removedPasskey`,
    `passkeyRevokeToken` and `account.update` statements where they are. The
    blocks keep their existing guard, so review focus item 3 holds by
    construction. Add a gdpr assertion only if an existing test already
    covers a dual-profile erasure: find it with
    `grep -rn "teacherOnAccount\|studentOnAccount" src tests`.

- [ ] **Step 6: fix every caller the compiler names.**
  Run `pnpm exec tsc --noEmit`. Each error is a caller of a changed signature,
  mostly in `passkey-credentials.test.ts`. A test that calls
  `removePasskeyLocked` directly takes the lock first in its transaction.
  **Don't cast to `AccountSignOutLock` in a test to get it compiling**; take
  the lock.

- [ ] **Step 7: the compile-time and runtime pins**, in
  `src/lib/db-locks.test.ts`, next to the `ClassLock` ones:
  - `// @ts-expect-error` on `signOutEverywhereTx(tx, accountId)` called with a
    plain string;
  - `// @ts-expect-error` on `lockAccountForSignOut(prisma, id)` called with a
    bare `PrismaClient`;
  - a runtime case (review focus item 5): a lock minted in one
    `prisma.$transaction`, handed to `signOutEverywhereTx` inside a second,
    throws `/not minted by lockAccountForSignOut on this transaction client/`,
    and both sessions still exist.

- [ ] **Step 8: run Step 1's file and the touched suites, and see them pass.**
  The new file, `payout-pause*.test.ts`, `passkey-revoke*.test.ts`,
  `passkey-credentials*.test.ts`, `db-locks.test.ts`, and every gdpr test file
  the grep in Step 5 found.

- [ ] **Step 9: prove the guards bite.** Record the exact failure text for
  each mutation, restore, and re-run green:
  - In `lockAccountForSignOut`, change `FOR NO KEY UPDATE` to
    `FOR KEY SHARE`. Expected: every parking case fails, because nothing
    parks.
  - In `signOutEverywhere` only, replace the lock call with a cast. That
    needs an eslint disable, which proves the selector. Expected: lint fails
    on the cast.
  - Remove the `@ts-expect-error` comment from one pin. Expected: `tsc` fails
    with the argument-type error.
  - In `assertAccountSignOutLockHeldBy`, make the check always pass.
    Expected: the runtime pin fails.

- [ ] **Step 10: docs.**
  - **`docs/lock-order.md`.** Add a new entry, "The `Account` row orders
    multi-session sign-out writes". It states the rule, the `SET NULL`
    mechanism, the spec's holders table with each holder's lock order, the
    single-row writers that are exempt and why, and the daily sweep as
    accepted. Re-derive the holders from code with
    `grep -rn "lockAccountForSignOut(" src | grep -v test` and put that command
    beside the table.
  - **The pause, revoke, `deletePasskey` and both erasure entries.** Add the
    `Account` lock to each one's stated order and link the new entry. In the
    pause entry, "None of those rows is locked by a transaction that then
    waits on `Teacher`" must still hold. Check it now that `Account` is
    involved: no holder takes `Account` before `Teacher`.
  - **`docs/technical-architecture.md`.** Wherever it describes sign out
    everywhere or the erasure's session deletes, `grep -n` and fix.
  - **Sweep** for the removed signature shapes:
    `grep -rn "signOutEverywhereTx(tx, [a-z]*\.accountId\|removePasskeyLocked(tx, {" src docs`.
    Give each hit a verdict.

- [ ] **Step 11: commit in reviewable pieces.**
  Stage exact paths only, and end each message with the Co-Authored-By line:
  1. the failing lock-order test;
  2. the lock, brand, eslint selector and branded writers;
  3. the holders;
  4. the pins;
  5. the docs.

- [ ] **Step 12: verify.**
  `pnpm run worktree:up`, then `pnpm run verify`, then
  `pnpm run worktree:down`. Report the test-count arithmetic it prints.

### After Task 2

This plan now has two tasks, so a whole-branch review follows on the most
capable model. It is looking for what crosses the two tasks: Task 1's order
test and re-aimed lock-order test against Task 2's new lock, and whether the
pause entry in `docs/lock-order.md` reads as one consistent account.
