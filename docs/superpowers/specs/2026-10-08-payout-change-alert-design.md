# Payout-change alert, with a "This wasn't me" pause (#786)

## Decisions

The issue author asked for an uninterrupted end-to-end run, so the
implementing session took each gate itself; the reasoning is recorded here.
An adversarial review of the first draft found four holes in the resume gate,
and the rules below are the corrected ones — the PR body records what the
draft said.

1. **Alert on bank-account add / edit / remove and payment-link set / change /
   remove. Not on a currency switch.** A switch changes nothing a student sees
   today (measured below), and the only thing it can point future payments at
   is a bank account in another currency, whose creation already alerted.
2. **The alert carries a link**, reversing the passkey-added email's "no link"
   precedent for this one email. The link carries no credential and signs no
   one in; the most it can do is pause, which fails toward safety.
3. **The token rides in the URL fragment, and the pause is a button** (a POST
   with the token in its body). A fragment never reaches the server's logs or
   a Referer; a GET, or a page posting on load, would let a mail scanner pause
   the teacher after every honest edit.
4. **Passkey eligibility is frozen at the pause.** The pause writes
   `Teacher.pausePasskeyCutoff` = `windowStart − PAUSE_PASSKEY_LOOKBACK_DAYS`
   (7) when the account then holds a passkey created before that instant, or
   holds a `RemovedPasskey` whose `credentialCreatedAt` is before it and whose
   `removedAt` is at or after it; else null. A passkey removal records that
   row in the delete's own transaction and emails the account address, so a
   thief signed in by an emailed link who removes the teacher's passkeys and
   then changes the details leaves the requirement standing. The removal must
   fall at or after the cutoff, not the window start: the thief removes
   before changing, so a removal bounded by the window start would miss
   exactly that case; one older than the lookback is a week-old email the
   teacher had the chance to act on. When only a removed passkey made the
   cutoff non-null, no live passkey can satisfy it, the resume screen says
   "A passkey on this account was removed recently; resuming opens on
   <date>", and only the fallback (Decision 5) opens. Resume reads only the
   snapshot: a non-null cutoff requires a session signed in with a passkey
   created before it. A passkey registered after the pause, or racing it, is
   never eligible; deleting the teacher's passkeys after the pause is refused
   and would change nothing. The pause also deletes passkeys created at or
   after the cutoff — defence in depth against a thief signing back in, not
   the gate — and records no removal for them, since none could ever count.
5. **Lost-passkey fallback.** Fourteen days after `paymentsPausedAt`
   (`PAUSE_PASSKEY_FALLBACK_DAYS`), resume no longer requires the passkey. A
   frozen requirement with no exit would lock a teacher who lost their device
   out of collecting payments for good; fourteen days is two weeks in which the
   teacher, who chose to pause, can act.
6. **Paused is a state of the method helper's return type, never "zero
   methods"** — zero methods renders "pay directly", the opposite of holding
   off — so every reader must handle it to compile.
7. **The overdue clock restarts at resume**, and students with an outstanding
   payment are told on resume that they can pay.
8. **No payment-status history table.** What the threat needs — payments a
   signed-in party marked paid or not charged inside the window — is
   `paidAt` / `notChargedAt` in the window; a reopened payment is outstanding
   and lands in list 2. Only net-zero flips (paid → reopened → paid) are lost.
9. **A no-op bank-account re-save answers `respondUnchanged`** and does not
   alert, as the payment link already does.

**Residual risk, stated plainly:** a teacher with no passkey older than the
cutoff (and none removed since it) can be resumed by anyone holding their
inbox, and after fourteen days so can one who has. A thief who registers a
passkey from a magic-link session more than `PAUSE_PASSKEY_LOOKBACK_DAYS`
before changing the details holds a passkey older than the cutoff, which the
resume trusts; the passkey-added email to the account address is the signal
for it. The pause still signs everyone out, removes recent
passkeys and stops students paying; the resume screen nudges a teacher without
a passkey to add one after resuming.

## The premise, as measured (worktree at `136b4d0e`)

| Issue claim | Measured |
|---|---|
| Bank writers notify no one | Holds — `src/services/bank-accounts.ts` has no notify or email call; nor do `payment-link.ts` or `currency-switch.ts`. |
| A currency switch "changes which account students are pointed at" | **Only payments not yet created.** Every method reader passes the *class's* `currency` snapshot to `paymentMethodsForTeacher`; a switch relabels only unlocked, uncompleted classes. |
| `payment-reminders.ts` gates on `paymentMethodsFor`, so the pause should make that answer "no methods" | **False, and backfires.** Methods choose copy only; reminders send regardless. Zero methods renders "Pay {name} directly — cash or transfer" on the pay page and "Pay your teacher directly" in request and reminder copy. |
| Resuming with a passkey is "the one step an inbox thief can't take" | **Not as stated.** From a magic-link session a thief can register a passkey (registration needs only recent auth) or delete the teacher's (passkey DELETE is ungated). Decision 4 is the fix. |
| `signOutEverywhere` exists to reuse | Holds, but it takes a `PrismaClient`, not a transaction, and leaves passkeys and sign-in links. |
| Teachers can't change their account email | Holds — the only `account.update` writers are in GDPR erasure. |
| "Payment status changes made in that window" | Partly answerable — `paidAt` / `notChargedAt` survive until a reopen clears them (Decision 8). |

Also measured: `saveBankAccount` has no unchanged detection; nothing records
*when* payout details changed; `MagicLinkToken` cannot hold the pause token
(any sign-in by that address purges every row for it, and verify does not
filter on `purpose`); `Session` records no authentication method; the payment
link masks to a host, and for every link product the payee is in the path.

## Data

- `Teacher.paymentsPausedAt DateTime?` — set by a pause, cleared by a resume;
  a second pause keeps the earlier instant.
- `Teacher.paymentsResumedAt DateTime?` — set by a resume.
- `Teacher.pausePasskeyCutoff DateTime?` — Decision 4; cleared by a resume.
  A re-pause while paused keeps the existing value.
- `Teacher.pauseWindowStart DateTime?` — the pause's `windowStart`, stored
  because the resume screen may be read after the floor has moved past it;
  cleared by a resume, kept by a re-pause.
- `Session.passkeyCredentialId String?` — written only by passkey sign-in
  (`passkey/authenticate/verify`), `onDelete: SetNull`.
- `PayoutChangeEvent { id, teacherId, kind PayoutChangeKind, accountCurrency
  Currency?, before String?, after String?, identifierChanged Boolean?,
  createdAt }`. `identifierChanged` is set on the two `_changed` kinds only:
  for a bank account, whether any of `iban`, `accountNumber`, `sortCode`,
  `routingNumber` differs; for a link, whether the full URL does. `before`/`after` are
  masked strings only: `•••• 1234` (`maskedIdentifier`) for a bank account,
  host plus the path's last four characters (`revolut.me/…cher`) for a link.
  `accountCurrency` names which account, not a frozen price, so it is not a
  `currency` column in the `docs/data-model.md` sense. `PayoutChangeKind`:
  `bank_account_added`, `bank_account_changed`, `bank_account_removed`,
  `payment_link_added`, `payment_link_changed`, `payment_link_removed`.
  Written in the change's own transaction.
- `PayoutPauseToken { id, tokenHash @unique, teacherId, eventId → event
  onDelete Cascade, expiresAt, createdAt }` — sha256 (`hashToken`) of 32 random
  bytes, `PAUSE_TOKEN_TTL_DAYS` = 14. A resume deletes the teacher's tokens:
  everything they pointed at has just been confirmed.
- `RemovedPasskey { id, accountId, credentialCreatedAt, removedAt }` —
  written by a passkey removal in the delete's own transaction (Decision 4),
  never by the pause's own deletions or by erasure.
- Erasure deletes the teacher's events and tokens, and the account's
  `RemovedPasskey` rows wherever it deletes its passkeys; the GDPR export
  includes the events (it lists no passkeys, so no removals); the daily auth
  cleanup deletes expired tokens.

## Locks

The pause, the resume, and all four payout writers take
`lockTeacherForNoKeyUpdate` as their first statement. The bank writers move
up from `FOR SHARE`: under `FOR SHARE` two saves both read the same "before",
and a resume's fingerprint read could interleave with a save. Every one returns
`teacher_gone` before any insert, so no event outlives an erasure.
`docs/lock-order.md` ("The `Teacher` row is the first lock") gains the pause,
the resume and the link writers and records the bank writers' new mode.

## 1 · The alert

Each writer reads the current value under the lock, writes, and records the
event, returning it. The route delivers after commit through
`deliverPayoutChangedNotice(db, eventId): FireAndForget` (the
`deliverPasskeyAddedNotice` pattern): it mints a pause token and emails
`Account.email` immediately — not a notification, no preference, not the
30-minute fallback. The email says what changed (kind and currency), masked
before and after, and when (teacher's timezone). Equal masks do not mean an
equal account, and the attacker picks the new value, so the writer decides
from the full values under its lock and records `identifierChanged` on the
event. When before and after mask alike, the email reassures ("a detail other
than the account number changed") only for a bank change whose identifier did
not change; a bank change whose identifier did warns that the account number
changed to one ending in the same digits, and a link change warns that the
new link looks like the old one and should be checked in full. The resume
screen's change list carries the same sentence. Its
**This wasn't me** button opens `/payout-pause#t=…`. A send failure is
logged, never returned.

`saveBankAccount` answers `unchanged` when every stored field matches.
`bank-account-form.tsx` handles that answer.

## 2 · Pausing

`/payout-pause` (public, no session) explains what pausing does — every
device is signed out, passkeys added recently are removed, students are told
to hold off — and offers one button. `POST /api/payout-pause { token }`, rate
limited per IP under a new prefix, runs one transaction:

1. resolve the token's teacher, `lockTeacherForNoKeyUpdate`;
2. consume the token (`deleteMany` by hash, unexpired); none →
   404 `PAUSE_LINK_INVALID`, the one answer for unknown, used, expired and
   erased alike — a used token never answers "already paused", which would
   tell an unauthenticated caller the pause state;
3. `windowStart` = the earliest event at or after the floor
   `max(paymentsResumedAt, now − PAUSE_TOKEN_TTL_DAYS)`, or the token's event
   if none is; the token's event is ignored when it predates
   `paymentsResumedAt`;
4. `cutoff` = `windowStart − PAUSE_PASSKEY_LOOKBACK_DAYS`; unless already
   paused, set `paymentsPausedAt` = now, `pauseWindowStart` = `windowStart`, and `pausePasskeyCutoff` = `cutoff`
   when a passkey created before it exists or was removed at or after it
   (Decision 4), else null;
5. delete the account's sessions, push subscriptions and sign-in links (a
   transaction-taking form of `signOutEverywhere`), and its passkeys created
   at or after `cutoff` (a re-pause computes its own, possibly later, one).

A failure anywhere rolls the consume back, so a 503 does not burn the link.

## 3 · What paused covers

`paymentMethodsForTeacher` answers `{ kind: 'paused' } | { kind: 'methods',
methods }`, with `paymentsPausedAt` in `teacherPaymentSelect`. Its readers:

| Reader | Paused behaviour |
|---|---|
| Pay page | No methods; "Payment details are being checked — please hold off for now." |
| Bookings list | No Pay now; the same line. |
| Completion payment request | Still created; hold-off copy. |
| Manual reminder | Refused, 409 `PAYMENTS_PAUSED`. |
| Overdue reminder sweep | Skips a paused teacher. |
| Fallback email | No Pay now button. |

The overdue sweep skips a paused teacher and otherwise counts seven days from
the later of `createdAt` and `paymentsResumedAt`. Known and accepted: a
completion that reads the teacher just before a pause commits sends method
copy, and a request created during a pause but emailed after the resume says
hold off beside a live Pay now. `hasPayoutDetails` is unaffected. The teacher
may still edit payout details while paused; each edit alerts. Passkey DELETE
is refused while paused, 409 `PASSKEY_REMOVAL_PAUSED`.

## 4 · Resuming

The schedule home shows a "Payments are paused" card linking to
`/settings/resume-payments`:

1. the change events since `pauseWindowStart`;
2. payments outstanding now that were created before the pause — the
   students who may have paid the wrong destination;
3. payments marked paid (`paidAt`) or not charged (`notChargedAt`) between
   `pauseWindowStart` and the pause;
4. the current payout details **in full** — IBAN or account number, holder,
   BIC, the whole link — with **Resume payments**; and, when a passkey is
   required, whether this session satisfies it, or the date the fallback
   opens.

`POST /api/teachers/[id]/payments-resume { fingerprint }`, in this order:

1. ownership;
2. `requireRecentAuth`;
3. not paused → `respondUnchanged` (a double-submit is answered, not refused;
   the subject is the caller's own teacher, so no oracle);
4. `pausePasskeyCutoff` set, fallback not open, and the session's
   `passkeyCredentialId` not naming a credential created before the cutoff →
   403 `PASSKEY_REQUIRED`;
5. in the transaction, under the lock: re-check paused; the fingerprint — a
   hash of the payout details the screen showed — must match the details now,
   else 409 `PAYOUT_DETAILS_CHANGED`.

Success clears `paymentsPausedAt`, `pauseWindowStart` and `pausePasskeyCutoff`, sets
`paymentsResumedAt`, deletes the teacher's pause tokens, and sends each
student with an outstanding payment a `reminder` notification that they can
pay now (stamping `reminderSentAt`).

## Docs

`docs/technical-architecture.md` (Recent authentication) gains the passkey
session column and the paused DELETE refusal; the comment on the passkey
DELETE route stops calling it ungated; `docs/data-model.md` gains the models;
`docs/lock-order.md` as above.

## Out of scope

- A hold period before new details go live; logging pay-page views.
- Level 2 processor connect/disconnect (#386): `PayoutChangeKind` grows with
  that writer.
- Free text: a signed-in attacker can type an IBAN into an announcement or
  the bio. No payout write is involved.
- Rate-limiting the resume route: it needs a fresh session and ownership.

## Testing

Test-first; each guard gets a recorded mutation.

- Writers: each kind records exactly one event with masked strings; a no-op
  re-save records none and answers unchanged; the email goes after commit and
  a send failure is logged.
- Template: a full IBAN or link in the input never reaches the HTML; alike
  masks reassure only on `identifierChanged: false` for a bank change, and
  warn otherwise.
- Pause: single use; unknown, expired and used refused alike with
  `PAUSE_LINK_INVALID`; a throw after the consume leaves the token usable;
  sessions, push subscriptions, sign-in links and post-cutoff passkeys gone,
  older passkeys kept; window floor; re-pause keeps the earlier instant and
  cutoff; the page does not pause on load.
- Surfaces: each reader's paused branch; manual reminder 409; sweep skip;
  overdue predicate both halves.
- Resume: stale session 403; passkeys removed from a magic-link session
  before a change leave the pause's cutoff set and the resume refused until
  the fallback; a magic-link session refused while a cutoff is
  set, a post-cutoff passkey session refused, a pre-cutoff passkey session
  accepted, the fallback after fourteen days; passkey DELETE refused while
  paused; fingerprint mismatch 409; not paused 200 unchanged; window lists
  bounded at both ends; students notified.
- Locks: a held bank save parks a resume.
- New routes join the census guards (`FALLBACK_ROUTES`, loading coverage).
