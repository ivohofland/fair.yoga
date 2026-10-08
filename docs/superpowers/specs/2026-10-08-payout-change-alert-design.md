# Payout-change alert, with a "This wasn't me" pause (#786)

## Decisions (made by the implementing session — the issue author asked for an
## uninterrupted end-to-end run, so each gate below records its reasoning)

1. **Alert on bank-account add / edit / remove and payment-link set / change /
   remove. Not on a currency switch.** Measured below: a switch changes nothing
   a student sees today, and the only thing it can redirect future payments to
   is a bank account in another currency, whose creation already alerted.
2. **The alert carries a link**, reversing the passkey-added email's "no link"
   precedent for this one email. The link carries no credential and signs no
   one in; the most it can do is pause, which fails toward safety. A forged
   copy can phish, as any email can — it cannot borrow this link's power,
   because the link has none beyond pausing.
3. **The link opens a page; the pause is a button on it** (a POST). A GET, or a
   page that posts on load, would let a mail scanner pause the teacher and sign
   them out after every honest edit.
4. **The pause removes every passkey registered from seven days before the
   earliest unconfirmed change.** An inbox thief signs in by magic link,
   registers a passkey, then changes the IBAN; without this, "resume needs a
   passkey" accepts the attacker's own. Seven days is a named heuristic
   (`PAUSE_PASSKEY_LOOKBACK_DAYS`), not a proof — each passkey registration
   also emailed the teacher.
5. **Paused is its own state on every pay surface, never "zero methods".**
6. **The overdue clock restarts at resume**: a payment becomes overdue seven
   days after the later of its creation and the teacher's last resume, and
   never while the teacher is paused.
7. **Payment-status history is recorded from this change on**
   (`PaymentStatusChange`), so the resume screen can list what changed in the
   window. Nothing earlier can be reconstructed.
8. **A no-op bank-account re-save answers `respondUnchanged` and does not
   alert**, matching the payment link and the project's "already done" rule.

## The premise, as measured (worktree at `136b4d0e`)

| Issue claim | Measured |
|---|---|
| Bank writers notify no one | Holds — `src/services/bank-accounts.ts` has no notify/email call; nor do `payment-link.ts` or `currency-switch.ts`. |
| A currency switch "changes which account students are pointed at" | **Only payments not yet created.** Every method reader passes the *class's* `currency` snapshot to `paymentMethodsForTeacher`; a switch relabels only unlocked, uncompleted classes. Every account it could point at was itself created through an alerting write. |
| `payment-reminders.ts` gates on `paymentMethodsFor`, so the pause should make that answer "no methods" | **False, and backfires.** Methods choose copy only; reminders send regardless. Zero methods renders "Pay {name} directly — cash or transfer" on the pay page and adds "Pay your teacher directly" to request/reminder copy. |
| Resuming with a passkey is "the one step an inbox thief can't take" | **Not as stated** — an inbox thief can register their own passkey from a magic-link session (Decision 4). |
| `signOutEverywhere` exists to reuse | Holds, but it takes a `PrismaClient`, not a transaction, and leaves passkeys. |
| Teachers can't change their account email | Holds — the only `account.update` writers are in GDPR erasure. |
| "Payment status changes made in that window" | **Not answerable from today's columns** — `reopenPayment` clears `paidAt`/`notChargedAt`; no history table exists. |

Also measured: `saveBankAccount` has no unchanged detection (a re-save
answers `saved`); there is no record of *when* payout details changed (a
removal leaves no row); `MagicLinkToken` cannot hold the pause token — any
sign-in by that address purges every token row for it, and verify does not
filter on `purpose`; `Session` records no authentication method and no passkey
step-up ceremony exists.

## Data

- `Teacher.paymentsPausedAt DateTime?` — set by a pause, cleared by a resume.
  A second pause keeps the earlier instant.
- `Teacher.paymentsResumedAt DateTime?` — set by a resume. Bounds the next
  window and restarts the overdue clock.
- `PayoutChangeEvent { id, teacherId, kind PayoutChangeKind, currency Currency?,
  before String?, after String?, createdAt }` — `before`/`after` are masked
  display strings only (`•••• 1234` from `maskedIdentifier`, a link's host),
  never a full value. `PayoutChangeKind`: `bank_account_added`,
  `bank_account_changed`, `bank_account_removed`, `payment_link_added`,
  `payment_link_changed`, `payment_link_removed`. Written in the same
  transaction as the change it records.
- `PayoutPauseToken { id, tokenHash @unique, teacherId, eventId, expiresAt,
  createdAt }` — sha256 of a 32-byte random token (`hashToken`), 30-day TTL,
  consumed by an atomic `deleteMany`. Its own table (see the premise).
- `PaymentStatusChange { id, paymentId, fromStatus, toStatus, createdAt }`,
  cascading with its payment, written by every teacher-driven status writer
  (`markPaymentPaid`, `reopenPayment`, `markPaymentNotCharged`, the student
  archive's bulk waive). The overdue sweep and creation are not recorded: the
  resume screen asks what a signed-in party did.
- Erasure deletes the teacher's events and tokens; the daily auth cleanup
  deletes expired tokens.

## 1 · The alert

The payout writers return the event they recorded; the route delivers after
commit through `deliverPayoutChangedNotice(db, eventId): FireAndForget` (the
`deliverPasskeyAddedNotice` pattern), which mints a pause token and emails
`Account.email` immediately — not a notification, no preference, not the
30-minute fallback. Content: what changed (kind and currency), masked before
and after, when (in the teacher's timezone), and a **This wasn't me** button to
`/payout-pause?token=…`. A delivery failure is logged, never surfaced to the
writer's response.

`saveBankAccount` reads the existing row inside its transaction before the
upsert, answers `unchanged` when every stored field matches, and otherwise
records `added` or `changed`. `removeBankAccount` reads the row before
deleting it to record `before`. The payment-link writers record inside a
transaction with the update.

## 2 · Pausing

`/payout-pause` (public) explains what pausing does — every device is signed
out, passkeys added recently are removed, students are told to hold off — and
offers one button. `POST /api/payout-pause { token }` (IP rate-limited):

1. consumes the token; an unknown, used or expired one answers one generic
   refusal (no oracle on which);
2. in one transaction: locks the teacher; sets `paymentsPausedAt` if unset;
   deletes the account's sessions and push subscriptions (a transaction-taking
   form of `signOutEverywhere`); deletes passkeys registered at or after
   `windowStart − PAUSE_PASSKEY_LOOKBACK_DAYS`, where `windowStart` is the
   earlier of the token's event and the earliest event since the last resume.

Already paused: the sign-out and passkey removal still run (the attacker may
have signed back in); the pause instant stays the earlier one.

## 3 · What paused covers

| Surface | Paused behaviour |
|---|---|
| Pay page | No methods; the line "Payment details are being checked — please hold off for now." |
| Bookings list | No Pay now; the same line as its caption. |
| Completion payment request | Still created (billing is unchanged), with hold-off copy instead of either method variant. |
| Manual reminder | Refused, 409 `PAYMENTS_PAUSED`. |
| Overdue reminder sweep | Skips a paused teacher's payments. |
| Fallback email | No Pay now button. |
| Overdue sweep | Skips a paused teacher; otherwise counts from the later of `createdAt` and `paymentsResumedAt`. |

Inbox rows keep linking to the pay page, which itself shows the hold-off line.
Push carries no details already. `hasPayoutDetails` (onboarding) is unaffected.
The teacher may still edit payout details while paused; each edit alerts.

## 4 · Resuming

The schedule home shows a "Payments are paused" card linking to
`/settings/resume-payments`, which shows:

1. the change events since the last resume (what changed, when);
2. payments outstanding now that were created before the pause — the students
   who may have paid the wrong destination;
3. `PaymentStatusChange` rows on this teacher's payments between the window
   start and the pause instant;
4. the current payout details, masked, with a **Resume payments** button.

`POST /api/teachers/[id]/payments-resume { fingerprint, passkey? }`:

- `requireRecentAuth` — a fresh sign-in;
- when the account has any passkey, a passkey assertion against a challenge
  from `POST …/payments-resume/options` (authenticated, keyed by session,
  `allowCredentials` = this account's passkeys), verified for this account
  without minting a session; absent or failing → 403;
- `fingerprint` is a hash of the payout details the screen showed; it must
  match the details now (in-transaction, teacher locked), or 409
  `PAYOUT_DETAILS_CHANGED` — confirming a screen is not confirming whatever
  replaced it;
- not paused → `respondUnchanged`.

Success clears `paymentsPausedAt` and sets `paymentsResumedAt`.

## Out of scope

- A hold period before new details go live; logging pay-page views (the
  issue's own out-of-scope list).
- Level 2 processor connect/disconnect (#386) — `PayoutChangeKind` grows when
  that writer exists.
- Free text: a signed-in attacker can type an IBAN into an announcement or the
  bio. No payout write is involved and nothing here sees it.
- A notice to students when payments resume; the pay page and the next
  reminder carry the live state.

## Testing

Test-first; each guard below gets a recorded mutation.

- Writers: each kind records exactly one event with masked strings; a no-op
  re-save records none and answers unchanged; the email is sent after commit
  and a sender failure is logged, not returned.
- Template: masked strings only — a full IBAN or full link in the input never
  reaches the HTML.
- Pause: single use; expired/unknown refused alike; sessions, push
  subscriptions and in-lookback passkeys gone, older passkeys kept;
  already-paused keeps the earlier instant; GET page does not pause.
- Surfaces: paused branch on the pay page, bookings list, request copy,
  fallback email button; manual reminder 409; sweep skip; overdue predicate
  both halves (paused skip, resume restart).
- Resume: stale session 403; passkey required iff the account has one, and an
  assertion by another account's credential refused; fingerprint mismatch 409;
  not paused 200 unchanged; window lists bounded at both ends.
