# The passkey-added email carries a "This wasn't me" button

The email sent when a passkey is added (`renderPasskeyAddedEmail`) names where
to undo it in words and carries no link. This spec gives it one: a button that
signs the account out everywhere and removes that passkey. It reverses the
"no link" precedent the payout-change alert's Decision 2 already reversed for
one email
(`docs/superpowers/specs/2026-10-08-payout-change-alert-design.md`).

No GitHub issue exists for it; one is filed with the PR.

## Why

The email is the only signal an owner gets that someone signed in by an emailed
link has registered a passkey, which is how that someone stays in after the
sessions end. Its remedy today is five steps the owner must take while the
other party is already inside: sign in, open Settings, remove the passkey,
choose sign out everywhere. `docs/technical-architecture.md` ("Resuming paused
payments") already names this email as *the* signal for the residual risk of a
passkey registered more than `PAUSE_PASSKEY_LOOKBACK_DAYS` before a payout
change. A button makes the signal actionable at the moment it is read.

## What was measured

Inherited claims, each checked against the code at `726627e8`:

| Claim | Verdict |
|---|---|
| A link is safe when it holds no credential, signs no one in, and can only do things that fail toward safety (payout Decision 2) | **Holds** for this link: it ends sessions and removes one credential. Both are reversible by a magic-link sign-in and a re-registration. |
| The payout pause token can serve here | **No.** `PayoutPauseToken` has `teacherId` and `eventId` foreign keys (`prisma/schema.prisma`); this email also goes to students, who have no teacher row. A new table keyed by account. |
| `signOutEverywhere` is enough | **No, as the payout spec already found.** It leaves pending sign-in links (`MagicLinkToken`); `pausePayments` deletes those separately, and so must this. |
| Removing a passkey is a single delete | **No.** `deletePasskey` writes a `RemovedPasskey` row in the same transaction and refuses while the account's teacher has payments paused (`PASSKEY_REMOVAL_PAUSED`). Both rules exist for payout Decision 4 and bind this link too. |
| The email is teacher-only | **No.** `POST /api/auth/passkey/register/verify` sends it for any account. |

## Decisions

1. **The link signs out everywhere and removes the one passkey the email is
   about.** Not "recent passkeys" as the pause does: this email names one
   credential, and the link is scoped to it. It does not pause payments (decided
   with the user): the thief's next move, a payout change, sends its own alert
   with its own pause button, and a false alarm here must not stop a teacher's
   income.

2. **A new token, keyed by account.** `PasskeyRevokeToken`:
   `tokenHash` (unique, SHA-256 of 32 random bytes, the pause token's scheme),
   `accountId`, `credentialId`, `expiresAt`, `createdAt`. No foreign key on
   either id: `PasskeyCredential` has no relation to `Account` and the
   credential may be gone by redemption. Its lifetime is a constant of its own,
   14 days, the length of the pause link's. `cleanupExpiredAuth` reaps expired rows
   (its result gains a count); both erasure paths in `gdpr.ts` that delete the
   account's passkeys delete its tokens in the same place.

3. **Fragment token, button POST, no session.** The mail carries
   `${baseUrl}/passkey-revoke#t=<raw>`; the page reads the fragment after
   hydration and posts it only on a press, so a scanner that opens the link does
   nothing. Same shape as `/payout-pause`, same IP rate limit (20 per 15
   minutes), under its own limiter key.

4. **Redemption, in one transaction.** In order:
   1. Look the token up by hash; unknown, used or expired answers `invalid`.
   2. If the account has a live teacher profile, take that teacher row's lock
      first (`docs/lock-order.md`, "The `Teacher` row is the first lock"); then
      consume the token (`deleteMany` where `expiresAt > now`, `count === 0`
      answers `invalid`).
   3. Remove the credential **only if** `deletePasskey`'s own rules allow it:
      it exists and belongs to the account, and the teacher (if any) is not
      paused. Removal writes a `RemovedPasskey` row, exactly as `deletePasskey`
      does. The rule is shared, not copied: the removal body is extracted from
      `deletePasskey` into a transaction-taking function both call, so the two
      cannot drift.
   4. `signOutEverywhereTx`, then delete the account's `MagicLinkToken` rows.
      The removal comes first because a passkey sign-in that inserts a
      `Session` after the passkey's delete fails its foreign key, and one that
      inserted before it is caught by this delete; the other order lets a
      sign-in land between the two deletes and survive.
   5. If the removal wrote a row, `deliverPasskeyRemovedNotice` runs after
      commit, as for a Settings removal.

5. **Recording the removal is not optional.** Without the `RemovedPasskey`
   row, anyone who can read the owner's inbox could use the link on the owner's
   own legitimate passkey, sign in by magic link, change the payout details and
   find the passkey requirement already lifted. That is the case Decision 4 of
   the payout spec closes for the Settings route; the link must not be the door
   around it. The cost: an owner who disowns a thief's passkey and later pauses
   inside the lookback is held to the 14-day fallback rather than a passkey. It
   is the same cost a Settings removal carries.

6. **While paused, sign out and keep the passkey** (decided with the user). The
   frozen cutoff makes older passkeys the ones that may resume; deleting one
   from a link would strand the owner, so the removal is skipped and the sign-out
   still happens. Refining this to "remove only passkeys created at or after the
   cutoff" is a second rule next to the pause and is out of scope.

7. **One answer, no oracle.** The response is `{ revoked: true }` whether the
   passkey was removed, was already gone, or was kept by a pause; a link that
   cannot act answers `404 REVOKE_LINK_INVALID`, registered in
   `src/lib/api-error-codes.ts`. The page's copy is neutral across the three:
   it says the account is signed out everywhere and that, if the passkey is
   still listed under the owner's passkeys, it can be removed there. A
   paused account's Settings removal explains itself
   (`PASSKEY_REMOVAL_PAUSED`).

8. **A second click answers `invalid`**, the pause link's behaviour, rather than
   `respondUnchanged`: the token is consumed, and distinguishing "used" from
   "never existed" would tell a link-holder more than the pause route does.

9. **Mint failures.** `deliverPasskeyAddedNotice` mints the token in its
   `FireAndForget` body. A mint that fails for any reason is logged and the
   email is **still sent without the button**, rather than dropped: the notice
   is the signal and the button is its convenience, unlike the payout alert,
   whose whole point is the link. `renderPasskeyAddedEmail` takes the link as
   optional and renders the button only when given one; the existing
   word-for-word remedy stays in the body either way.

10. **Copy.** The button reads **This wasn't me**. Above it: "Or do it now:
    this signs you out on every device and removes this passkey. Anyone who can
    read this inbox can still ask for a new sign-in link, so check your
    email account too." The last sentence states the limit this link cannot
    cross.

## What this does not do

- It does not pause payments or touch the teacher row beyond the lock.
- It does not remove other passkeys. A thief who registered two is removed by
  the owner in Settings, and the second registration has its own email.
- It does not make `renderPasskeyRemovedEmail` carry a link. Its docblock says
  "No link, for the reason `renderPasskeyAddedEmail` gives", a reason this spec
  deletes; the sentence is replaced with the removed email's own reason (a
  removal is not undone by a button) rather than left pointing at a docblock
  that no longer says it.

## Surfaces touched, and the twins to sweep

Source: `prisma/schema.prisma` + a migration; `src/services/passkey-revoke.ts`
(new) and `passkey-revoke-token.ts` (new); `passkey-credentials.ts` (extract the
transaction body); `passkey-notice.ts`; `auth-cleanup.ts`; `gdpr.ts`;
`src/lib/email.ts`, `email-templates.ts`; `src/lib/schemas.ts`;
`src/lib/api-error-codes.ts`; `src/app/api/passkey-revoke/route.ts` (new);
`src/app/(public)/passkey-revoke/` (new page and form).

Claims to replace, not annotate (grep each across spec, plan, source, tests, docs,
PR body): `renderPasskeyAddedEmail`'s docblock ("No link and no token…");
`renderPasskeyRemovedEmail`'s docblock; `renderPayoutChangedEmail`'s
"Unlike `renderPasskeyAddedEmail`, this one carries a link"; the notice
paragraph in `docs/technical-architecture.md` ("Resuming paused payments");
`docs/data-model.md` (the new model); `docs/lock-order.md` (the new
redemption's lock order); the payout spec's Decision 2 stays as written,
it is the record of a decision at its date.

## Tests, test-first

Unit/service: redemption signs out, deletes sign-in links, removes the
credential and writes `RemovedPasskey`; a second use, an expired token and an
unknown token answer `invalid`; a credential already gone still signs out; a
paused teacher keeps the passkey and is still signed out; a student account
(no teacher row) works; another account's credential id in a token cannot
remove it (the filter carries `accountId`); a lock-order test beside
`payout-pause-lock-order.test.ts`. Mail: the email carries the button when a
token minted, and is sent without it when the mint throws. Route: rate limit,
body validation, `404 REVOKE_LINK_INVALID`. Cleanup and erasure: expired tokens
reaped; erasure removes the account's tokens. Page: nothing posts on load; the
token is dropped from the address after success.

**Guards that must be shown to bite** (break, record the exact failure, restore):
the `RemovedPasskey` write (Decision 5), the paused skip (Decision 6), and the
`accountId` filter on the credential delete. Each is a one-line mutation of the
shared removal function.

## Residual risk

The link authenticates by possession of the email. Anyone with the inbox can
press it: the harm is a sign-out and one passkey removal, both recoverable by a
magic-link sign-in and a re-registration, and the removal is recorded for the
payout gate. An inbox thief gains nothing the inbox did not already give, apart
from removing a passkey without a session, which is why Decision 5 exists.
