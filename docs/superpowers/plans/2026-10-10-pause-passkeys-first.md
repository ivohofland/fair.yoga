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

There is no whole-branch review: this plan has one task.
