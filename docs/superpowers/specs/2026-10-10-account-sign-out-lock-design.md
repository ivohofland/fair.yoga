# The `Account` row orders every multi-session sign-out write (#811, PR #820)

PR #820 reorders `pausePayments` so its recent passkeys go before its
sessions. Review found that the reorder opens a deadlock with the Settings
"sign out everywhere" button. This spec replaces the per-pair lock reasoning
for these writers with one rule. The sign-in side is out of scope: the
magic-link window stays accepted (`docs/lock-order.md`, the pause entry), as
decided with the user.

## The deadlock, and its family

`Session.passkeyCredentialId` is `ON DELETE SET NULL`. So a passkey delete is
also an `UPDATE` of every session that names one of the deleted passkeys, and
it locks those session rows without the statement ever naming `Session`.

Take an account with two sessions: S_a, signed in by magic link, and S_b,
signed in with passkey P.

1. The pause deletes P. The `SET NULL` locks S_b.
2. Sign-out-everywhere runs `DELETE FROM "Session" WHERE "accountId" = …`. It
   locks S_a, then waits on S_b.
3. The pause's own session delete waits on S_a.

Neither side can move. Postgres aborts one (40P01, which is answered 503 and
retryable), and both sides roll back.

The same shape appears wherever two writers lock more than one of an
account's sessions in different orders:

| Pair | Status |
|---|---|
| Pause × sign-out-everywhere | Opened by #820's reorder |
| Revoke link × sign-out-everywhere | Since #810. **Student-only accounts included**: `lockForPasskeyRemoval` takes no lock without a teacher, so a teacher lock cannot fix it. |
| `deletePasskey` × sign-out-everywhere | The `SET NULL` locks every session on the passkey, one statement against another's scan. Needs a passkey with two or more sessions. |
| Erasure × any of the above | Erasure deletes the sessions (`gdpr.ts:813`, `:1573`) *before* its `Account` update (`:819`, `:1579`). |

## Decision

1. **One rule.** A transaction that writes more than one of an account's
   `Session` rows first takes `FOR NO KEY UPDATE` on that account's `Account`
   row. "Writes" includes writing them through the `SET NULL` of a passkey
   delete. Two such writers on the same account then queue one behind the
   other: one row, nothing to order.
   - **Why `FOR NO KEY UPDATE`:** it doesn't conflict with the `FOR KEY SHARE`
     that a foreign-key insert naming the account takes. Erasure's
     `Account.email` update takes this same lock mode, so the update needs no
     extra lock of its own.
   - **Why not session rows locked in id order:** that was considered and
     dropped (decided with the user). One row has no order to keep, it covers
     student-only accounts, and it is the lock a sign-in side would join if the
     magic-link window ever needs closing
     (`docs/superpowers/specs/2026-10-10-sign-out-race-design.md`).

2. **The holders.** Each one takes the lock once, before its first `Session`
   or `PasskeyCredential` write:

   | Holder | Lock order |
   |---|---|
   | `signOutEverywhere` (Settings) | `Account` |
   | `pausePayments` | `Teacher` → `Account` |
   | `revokePasskeyByLink` | `Teacher`, when there is one → `Account` |
   | `deletePasskey` | `Teacher`, when there is one → `Account` |
   | `deleteStudentAccount` | `Student` → `Account`, taken at the start of its sessions-and-passkeys block, only when that block runs |
   | `deleteTeacherAccount` | `Teacher` → `Account`, the same way |

   No holder takes `Account` and then `Teacher` or `Student`, so there is no
   inversion. The plan confirms this against `docs/lock-order.md`.

3. **Tethered to the compiler.** `lockAccountForSignOut(tx, accountId)` (in
   `src/lib/db-locks.ts`) returns a branded `AccountSignOutLock`, or `null`
   when the account row is gone. The functions that write several sessions
   require that lock as a parameter, and assert it was taken on the same
   transaction client, as `ClassLock` does:
   - `signOutEverywhereTx`;
   - `removePasskeyLocked`;
   - a new `deleteAccountPasskeys`, which wraps the pause's passkey delete.

   Erasure's session, push-subscription and passkey deletes go through
   `signOutEverywhereTx` and these functions, so a new sign-out path that
   skips the lock fails to compile.

4. **Single-row writers stay out.** These lock at most one `Session` row per
   statement and wait on nothing after it, so they cannot close a cycle:
   - `validateSession`'s delete of an expired or profile-less session;
   - single sign-out;
   - `revokeRequestSession`;
   - `createSession`;
   - the passkey sign-in's counter `update`.

## Accepted

**The daily sweep.** `cleanupExpiredAuth` deletes expired sessions across all
accounts in one statement. It can cross a holder of this lock when an account
has two expired sessions at the moment the sweep runs. That is unchanged by
this spec, and the account lock cannot order a statement that spans accounts.
Postgres aborts one side and both retry: the sweep the next day, the sign-out
on a click. It is documented in the lock-order entry.

## Tests

- **A lock-order test on two connections** (`@serial-tier lock-contention`):
  - Recreate the review's setup: a magic-link session and a session signed in
    with a recent passkey.
  - Hold a pause at its passkey delete, then start sign-out-everywhere.
  - Assert, via `pg_blocking_pids`, that the sign-out parks on the `Account`
    row, not on a session.
  - Assert that both commit, and no session is left.
  - Mutation: drop `signOutEverywhere`'s lock, and record the failure (a
    deadlock, or parking on `Session`).
- **The same check for the revoke link on a student-only account.**
- **The compiler as a guard:** a `@ts-expect-error` call to
  `signOutEverywhereTx` without a lock, as the `ClassLock` pins do.
- **The existing suites stay green**, including the gdpr suites, with the
  existing pause order test and the re-aimed lock-order test.

## Docs

- `docs/lock-order.md`: a new entry, "The `Account` row orders multi-session
  sign-out writes", stating the rule and the holders table above. The pause,
  revoke and `deletePasskey` entries, and both erasure entries, gain the lock
  in their stated order and link to the new entry. The sweep's crossing goes
  there as accepted.
- `docs/technical-architecture.md`, wherever it states how sign-out everywhere
  works.
