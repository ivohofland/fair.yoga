# A sign-in racing a pause or a revoke link does not survive it (#811)

`pausePayments` (`src/services/payout-pause.ts`) and `revokePasskeyByLink`
(`src/services/passkey-revoke.ts`) both end every session on an account, and
both pages then say "Every device has been signed out". A sign-in that is
already under way when either runs can still leave a live session behind.
This spec closes both ways that happens, so the sentence is true.

## What was measured

At `74008c30` (main):

| Claim (issue #811) | Verdict |
|---|---|
| The pause deletes sessions (`signOutEverywhereTx`), then `MagicLinkToken` rows, then passkeys created at or after the cutoff | **Holds**: `payout-pause.ts:119`, `:120`, `:127`. |
| A passkey sign-in that inserts its `Session` between the session delete and the passkey delete survives, with its credential nulled | **Holds.** `authenticate/verify/route.ts` updates the counter (`:55`) and calls `createSession` (`:60`) on autocommit `prisma`, with no transaction. |
| A magic-link sign-in whose token was consumed before the token delete and whose session lands after the session delete survives | **Holds**, on two doors, not one: same-browser `magic-link/verify` (`verifyWithHandoff` → `consumeTokenRow` → `resolveOrClaimAccount` → `createSession`, `route.ts:99`) and cross-device `magic-link/claim` (`claimWithCode` → `consumeTokenRow` → … → `createSession`, `route.ts:90`). Both run on autocommit. |
| The magic-link window "cannot be closed from inside the pause's transaction" | **True of the pause alone, false of the fix.** It closes once the sign-in holds a lock the pause must wait for, from before the consume until the session commits (Decision 2). |
| The fix is confined to the pause | **No.** `revokePasskeyByLink` (#810) has the same magic-link race: `signOutEverywhereTx` at `:53`, the token delete at `:54`. Its passkey order is already right (`passkey-revoke-order.test.ts`). |

Session creators not affected: the teacher-profile and student-profile routes
(`createSession` at `teacher-profile/route.ts:199`, `student-profile/route.ts:219`)
consume a signup ticket and create the account in a nested `create`. An address
that already has an account fails that create with P2002 and answers 409, so
these routes never sign in an account that could be paused. The passkey route
is covered by Decision 1.

Erasure (`gdpr.ts`) also deletes sessions (`:813`, `:1573`) before tokens
(`:825`, `:1585`), so a sign-in can race it too. It is **not** in scope: the
erased profile is soft-deleted, and `validateSession` deletes any session whose
account has no live profile the first time that session is used. Erasure does
take part in the new lock (Decision 3).

## Decisions

1. **The pause deletes its passkeys before it ends sessions** (issue option 1,
   decided with the user). The order becomes: passkeys created at or after the
   cutoff, then `MagicLinkToken` rows, then sessions and push subscriptions.
   A passkey sign-in with a removed credential then either inserts its session
   before the passkey delete, and the later session delete removes it, or its
   insert's foreign-key check blocks on the deleted credential and fails once
   the pause commits. Its counter `update` can fail the same way. That losing
   sign-in answers 500, the same as the revoke link already accepts. A sign-in
   with an older, eligible passkey is unaffected: by the cutoff's trust model it
   belongs to the teacher.

2. **The account row is the gate between sign-in and sign-out.** Every
   magic-link door that can sign in an existing account opens one transaction
   that:
   1. takes `FOR SHARE` on the `Account` row whose `email` is the token row's
      email, if there is one;
   2. consumes the token (`consumeTokenRow`: the single-use delete, then the
      sibling purge);
   3. reads the account's profiles and calls `createSession`.

   `pausePayments` and `revokePasskeyByLink` take `FOR NO KEY UPDATE` on the
   same `Account` row before they touch passkeys, tokens or sessions. The two
   lock modes conflict, so a pause and a sign-in for the same account run one
   after the other:
   - **Sign-in first.** The pause waits until the session has committed. Its
     session delete, a later statement under READ COMMITTED, then sees that
     session and deletes it.
   - **Pause first.** The sign-in waits until the pause has committed. Its
     consume then finds the token deleted, and the link is refused as already
     used.

   `FOR NO KEY UPDATE`, not `FOR UPDATE`: it doesn't conflict with the
   `FOR KEY SHARE` that a foreign-key insert naming the account takes, so the
   pause doesn't block every insert on the account.

   The lock must be taken **before** the consume. Consuming first, on
   autocommit, would let a whole pause run between the consume and the lock.

   *Considered and dropped:* making both sides lock the address's token rows
   in id order instead. That only holds if every statement that touches more
   than one of an address's token rows does the same, and there are five
   writers outside the consume (the pause, the revoke link, erasure twice, and
   the handoff reaps). One `Account` row has no order to keep.

3. **No account, no lock, and the claim stays outside the transaction.**
   - **When the address has no account**, the transaction locks nothing, and
     the unclaimed-student claim (`resolveOrClaimAccount`'s `account.create`
     branch) runs after it commits. A pause needs a teacher with a
     `PayoutPauseToken`, and a revoke link needs an account. An account
     created after the consume has neither.
   - **The claim can't simply join the transaction.** Its P2002 catch-and-retry
     cannot work inside a Postgres transaction: the failed insert aborts the
     transaction, and the retry would fail with it.
   - **Erasure**: it updates `Account.email` (`gdpr.ts:819`, `:1579`), which
     takes a row lock that conflicts with `FOR SHARE`. It does that before its
     token delete, so it waits for an in-flight sign-in. It takes no lock the
     sign-in transaction then waits on, so the two cannot deadlock.

4. **`claimWithCode` splits at the match.** Its per-address budget
   reservations are transactions of their own (`reserveHandoffComparisons`),
   and Prisma's interactive transactions cannot nest. Finding the candidate,
   reserving the budget and handling a miss stay outside. The consume of the
   matched row moves into the claim route's sign-in transaction, as in
   Decision 2.

5. **The functions on the consume path take a transaction client.** These are
   `createSession`, `consumeTokenRow`, and the consume step of
   `verifyWithHandoff` and of the handoff claim. Their callers outside these
   doors (signup tickets, tests) keep working, since `PrismaClient` satisfies
   the narrower type.

6. **The page copy stays as it is.** "Every device has been signed out" is true
   once Decisions 1 and 2 hold. Someone who can still read the inbox can
   request a new link and sign in *after* the pause. That isn't a device the
   pause missed. It's the case the passkey resume gate exists for, and it's
   unchanged here.

## Lock order

The new entries in `docs/lock-order.md`:
- **Pause:** `Teacher` → `Account` → `PasskeyCredential` → `MagicLinkToken` →
  `Session`/`PushSubscription`.
- **Revoke link:** `Teacher` when there is one (`lockForPasskeyRemoval`) →
  `Account` → passkey → `MagicLinkToken` → `Session`.
- **Magic-link sign-in:** `Account` (`FOR SHARE`) → `MagicLinkToken` → a
  `Session` insert. `Session.accountId` has no foreign key, so the insert takes
  no further lock.

The plan checks `docs/lock-order.md` for any holder that takes `Account` before
`Teacher`, which would invert the pause's order.

**Accepted:** with the transaction, a consumed token row stays locked until the
session commits, where today it is released at once. A concurrent handoff
reap or a miss increment from the same browser, over an id list that includes
both that row and a sibling, can now deadlock against the sign-in's purge.
Postgres aborts one side, and that request answers 500. It needs the same
browser to send a wrong code and open its own link within the same few
milliseconds.

## Tests

- **Statement order of the pause:** the passkey `deleteMany` comes before the
  session `deleteMany`. Use the recording-client pattern from
  `passkey-revoke-order.test.ts`. The test must fail when the order is swapped
  back.
- **The gate, both directions, for the pause and for the revoke link:**
  - Hold a sign-in transaction open after its consume, on a second connection,
    and start the pause. The pause must block, and once the sign-in commits,
    the new session must be gone.
  - Run it the other way round: the sign-in must be refused, and no session
    must exist.
  - Each case must fail with the lock removed.
- **`claimWithCode`'s existing tests stay green**, and a claim's consume and
  session commit together: a failure injected into `createSession` leaves the
  token unconsumed.
- **The existing pause, revoke and magic-link suites stay green.**

## Docs that must agree

- `payout-pause.ts`'s and `passkey-revoke.ts`'s docblocks.
- The pause and revoke entries in `docs/lock-order.md`, plus a new sign-in
  entry. The pause entry's "sessions go before passkeys" paragraph is
  replaced, not amended.
- `docs/technical-architecture.md`, wherever it states either order.
- Both pages' copy, which is unchanged (Decision 6).
