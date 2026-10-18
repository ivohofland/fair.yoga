# Payment Level 2, part 1: Mollie Connect, the method allowlist, and refunds (#896)

A teacher connects their own Mollie account by OAuth. The methods it enables
that fair.yoga's allowlist also holds appear as their own rows on the
existing pay page. A student taps one, goes to Mollie for that method only,
and the payment is marked paid by webhook. A teacher can refund any payment a
student made through Mollie, in full. Stripe follows separately (#386).

## Decisions

Taken with the issue author on 2026-10-18 and posted to #896 as a comment;
the numbering here is this spec's.

1. **The line is "no method whose product is deferred payment".** Cards are
   fine; pay-later credit is not. It is enforced by an allowlist, so no
   pay-later product needs naming: one Mollie adds tomorrow is excluded until a
   reviewed PR adds it.
2. **The allowlist, first version:** `ideal`, `wero`, `creditcard`,
   `applepay`, `bancontact`, `eps`, `blik`, `przelewy24`, `twint`, `paypal`.
   iDEAL and Wero are separate rows labelled "iDEAL" and "Wero"; Mollie has
   both as method ids, and the teacher's enablement decides which a student
   sees. Mollie's `banktransfer` is **not** on it: it duplicates the Level 1
   transfer and stays open up to 12 days, which would break Decision 6's
   short window. `googlepay` cannot be a payment `method` and is not on it.
3. **PayPal is on the allowlist, by the owner's decision: it matters in some
   countries.** Mollie's PayPal page lists PayPal's own pay-later products as
   part of the method (Pay in 4 in the US, FR and AU, Pay Monthly, Pay in 3 in
   the UK, ES and IT, PayPal Credit, Pay in 30 in DE) and documents no setting,
   on Mollie's side or the merchant's, that removes them, so a student may see
   them inside PayPal's own checkout. fair.yoga offers no pay-later method of
   its own; PayPal is the one allowed method whose checkout can show such an
   offer.
4. **No per-currency Level setting.** Mollie filters methods by currency once
   given the amount (iDEAL, Wero, Bancontact and EPS are EUR only; USD gets
   cards). An empty overlap shows the Level 1 rows alone. A currency
   Mollie rejects is an empty overlap, not a degradation.
5. **Every scope this issue uses is requested at connect**, `refunds.write`
   included, because adding a scope later forces every teacher to
   re-authorize. Nothing for customers, mandates or subscriptions.
6. **An open attempt is left to expire** when the teacher marks the payment
   paid by hand or waives it. No Mollie call on the manual paths. The window is
   the method's expiry, written on its allowlist entry (Data): Wero 10 min,
   iDEAL 15, card and Apple Pay 30, Twint 45, Bancontact, EPS and
   Przelewy24 60, PayPal 360, BLIK 1 (Mollie's BLIK page gives a 55-second
   session timeout; the expiry table has no row for it). A completion inside it is a double payment
   (Decision 7).
7. **A webhook reporting paid for a payment already settled** records the
   attempt as paid, leaves the `Payment` untouched, tells the teacher the
   student paid twice, and answers 200.
8. **Refunds: any Mollie-paid attempt, full amount only.** Mollie returns the
   money from the teacher's own balance to the original payer; fair.yoga never
   holds it. When the refunded attempt is the one that settled its `Payment`,
   the teacher chooses in the same dialog: **refund and waive**
   (`paid → not_charged`) or **refund and ask again** (`paid → pending`). The
   choice applies when the refund completes (Mollie reports it `refunded`);
   until then the payment stays `paid`. A refund of a duplicate attempt
   (Decision 7) changes no `Payment`.
9. **`paid → not_charged` becomes legal, through a refund only.** This
   narrows #47's "never a refund": `markPaymentNotCharged` still refuses a
   paid payment, and the only writer of the transition is the refund's
   completion, in the transaction that records the refund as `refunded`.
   Waiving after money has
   actually gone back is the leniency #47 describes, not a relabelled refund.
   Reporting is unaffected: it reads the completion snapshot.
10. **Tokens are encrypted at rest in their own table**, AES-256-GCM, key
    `PROCESSOR_TOKEN_KEY`, every ciphertext prefixed with a key-version byte.
    Never columns on `Teacher`, so no teacher read can carry them.
11. **Classic webhooks**, one `webhookUrl` per payment. The webhook's body is
    only an id; the attempt row names the teacher, and the fetch with that
    teacher's token is the authentication. Next-gen signed webhooks are
    per-organization subscriptions capped at about three in live mode, and the
    docs don't say they reach a Connect platform.
12. **Pay page order:** Mollie rows first, in allowlist order; the Level 1
    rows after them, unchanged. A Mollie row settles itself and the teacher has
    nothing to mark.
13. **`Payment.method` stays a column, its written values become a type**:
    `'manual' | 'mollie'`. The specific method lives on the attempt. A repeated
    webhook then hits `markPaymentPaid`'s existing same-method `unchanged`.
14. **A refresh answering `invalid_grant` disconnects**: the connection is
    marked disconnected, the pay page offers no Mollie rows from the next render, the teacher is
    told in-app and by email, and `logDegraded` records it. The disconnect
    applies only while the row still holds the refresh token that got
    `invalid_grant` (a newer grant, from a reconnect or a peer's refresh, wins),
    keeps `disconnectedAt` if it is already set, and tells the teacher only when
    the connection was not already disconnected.
15. **The methods list is cached in memory for 60 s** per `(teacher, currency,
    amount)`. One process on one VPS, so in-memory is shared by every request.
16. **The four placeholder columns go.** `Teacher.paymentLevel`,
    `Teacher.processorType`, `Teacher.processorAccountId` and
    `Payment.processorRef` have no reader in `src/` (only GDPR erasure writes
    them, to null). Keeping `paymentLevel` beside a connection row would be two
    spellings of one fact, and `processorRef` is the Mollie-id-on-`Payment` the
    issue's own design rules out. "Level 1" and "Level 2" are development
    shorthand, not a state the product has: what a student sees is the
    methods that exist for that payment, and nothing in the schema, the code's
    types or any copy names a level. A teacher reads "Mollie connected", never
    "Level 2".
17. **A payment Mollie settled cannot be reopened; a refund is how it leaves
    `paid`.** The webhook proved the money arrived, so "Mark unpaid" would make
    the record say unpaid while the money sits in the teacher's balance, and
    chase a student who paid. `reopenPayment` refuses (409
    `PAYMENT_SETTLED_BY_PROCESSOR`, "Mollie confirmed this payment. Refund it
    instead.") while an attempt with `settledPayment` exists that fair.yoga
    can still refund through — its connection exists and its grant is not
    revoked (`canRefundThroughGrant`, `src/lib/processor-liveness.ts`) — and
    a completing refund's "ask again" leaves out only the attempt it
    refunded; the teacher's row offers **Refund** in its place. Once the
    settling attempt's grant is revoked, or its connection is gone with an
    erased teacher, no refund can be made here: "Mark unpaid" returns, the
    row offers no Refund, and a refund request answers 409
    `PROCESSOR_NOT_CONNECTED` ("Mollie is no longer connected, so this can't
    be refunded here. Mark it unpaid or refund it in Mollie."). Two events
    release the settling attempt while its grant holds. A chargeback: once
    Mollie reports `amountChargedBack > 0` on it, the attempt records
    `chargedBackAt`, stops settling the payment, the teacher is told, and
    "Mark unpaid" returns; a charged-back attempt cannot be refunded. And
    refunds made in Mollie's own dashboard that together cover the attempt's
    amount (§5): the attempt stops settling the payment, the payment stays
    `paid`, and "Mark unpaid" returns; no notification type fits, so it is
    logged at info. A partial dashboard refund changes nothing.

## The premise, as measured (`main` at `31498958`)

| Issue claim | Measured |
|---|---|
| Payment Links can't start a mandate, so use the Payments API | **Wrong.** `POST /v2/payment-links` takes `sequenceType: first` with a `customerId`, and `allowedMethods`. The Payments API is still right: a single `method` skips Mollie's selection screen, and each attempt has its own id and webhook. |
| The Methods API gives the account's enabled methods for an amount and currency | Holds. `/v2/methods` lists enabled methods only (`/methods/all` is everything); with OAuth `profileId` is required; without `amount` it returns EUR methods only. Pay-later ids come back by name (`klarna`, `in3`, `riverty`, `billie`, `billink`, `alma`). |
| A single `method` opens that method directly | Holds, with a side effect: a student who cancels is redirected to our `redirectUrl` and **no webhook fires**. |
| A revoked grant shows as disconnected | **Only when we next refresh.** Mollie sends no revocation webhook; the next refresh answers `invalid_grant`. Access tokens live 60 min; refresh tokens don't expire. |
| `processorAccountId` comes from the OAuth grant | **Partly.** The token response carries no ids; `/v2/organizations/me` gives the organization, `/v2/profiles` its profiles, and a teacher with several picks one. |
| The payment's own currency (#758) | **Wrong.** `Payment` has no `currency`; it reads its class's (`Class.currency`). |
| "Methods that cost the student extra" need deciding | **Moot.** The Payments API has no surcharge field; a surcharge exists only in Mollie's shop plugins. |
| Erasure nulls `processorAccountId` | Holds (`src/services/gdpr.ts:1626`), and it is the column's only writer. |
| The exhaustive switch and `PAYMENT_METHOD_COPY`'s `satisfies` point at every consumer | Holds: `PAYMENT_METHOD_COPY` is `satisfies Record<PaymentMethodKind, …>` (`src/lib/payment-methods.ts:21`); the switch over kinds is `MethodPanel` in `src/app/(student)/bookings/[classId]/pay/page.tsx`. |
| The existing CAS-guarded transition | Holds: `markPaymentPaid` (`src/services/payments.ts:141`) answers `unchanged` for same-method, refuses `PAYMENT_ALREADY_PAID` for another method, `PAYMENT_WAIVED` for waived. |
| The two docs disagree about automatic charging | **Worse:** `docs/product-concept.md:244` ("Automatic charging after class") contradicts `:256` ("v1 Level 2 is payment links, not automated charging") in the same file. |

Also measured: `Payment.method` is free text and the UI writes only
`'manual'` (`src/lib/use-payment-actions.ts:68`); no encryption-at-rest helper
exists (`src/lib/push/encrypt.ts` is RFC 8291 per-message encryption); no
OAuth client code exists; `src/app/api/webhooks/` holds only `.gitkeep`;
`PayoutChangeKind` covers bank accounts and the link only; the payout
writers are not gated by the pause; the cross-origin guard passes a request
with neither `Origin` nor `Sec-Fetch-Site` (`src/lib/cross-origin.ts`), which
is what Mollie's server-side POST is.

## Data

- **`ProcessorConnection`** `{ id, teacherId @unique → Teacher onDelete
  Cascade, processor ProcessorType, organizationId, profileId String?,
  accessToken Bytes?, accessTokenExpiresAt DateTime?, refreshToken Bytes?,
  scopes String[], testmode Boolean, connectedAt, disconnectedAt DateTime?,
  revokeAfter DateTime?, revokedAt DateTime? }`.
  One per teacher. `accessToken`/`refreshToken` are ciphertexts (Decision 10).
  **Live** is `disconnectedAt IS NULL AND profileId IS NOT NULL`; a row with
  no profile is mid-connect and offers nothing. Disconnecting and revoking are
  separate moments: a disconnected row keeps its tokens until `revokedAt`,
  because its open attempts' webhooks still need them (§1). `CHECK`s pin that
  both tokens are present exactly when `revokedAt IS NULL`, and that
  `revokedAt` and `revokeAfter` are set only on a disconnected row.
  Reconnecting after a disconnect rewrites the row rather than adding one.
- **`ProcessorPayment`** (the attempt) `{ id, paymentId → Payment onDelete
  Cascade, connectionId → ProcessorConnection, processorPaymentId @unique,
  profileId String, testmode Boolean, method String, status ProcessorPaymentStatus, amount Decimal, currency
  Currency, checkoutUrl String?, expiresAt DateTime?, paidAt DateTime?,
  settledPayment Boolean, chargedBackAt DateTime?, createdAt, updatedAt }`. `ProcessorPaymentStatus`
  is Mollie's own set: `open`, `pending`, `authorized`, `paid`, `canceled`,
  `expired`, `failed`. `settledPayment` is true on at most one attempt per
  `Payment` (partial unique index `WHERE settled_payment`): the one whose
  webhook moved the `Payment` to `paid`. While it is set and the attempt's
  grant holds, `reopenPayment` refuses (Decision 17). It is cleared by a
  refund's outcome, in the transaction that applies the outcome, by a
  chargeback, which also stamps `chargedBackAt`, and by dashboard refunds
  that cover the attempt (§5); once cleared, a later settle cannot collide
  with the index. `currency` is a snapshot in the
  `docs/data-model.md` sense: what Mollie charged, which no later currency
  switch may relabel. `method` is a string, not the allowlist type, because
  a stored row must stay readable after its method leaves the allowlist.
- **`ProcessorRefund`** `{ id, attemptId → ProcessorPayment, processorRefundId
  @unique, amount Decimal, status ProcessorRefundStatus, outcome
  RefundOutcome?, requestedAt, updatedAt }`. Statuses are Mollie's
  (`queued`, `pending`, `processing`, `refunded`, `failed`, `canceled`).
  `RefundOutcome` is `waived | reopened` for a refund of the settling attempt
  and null for a duplicate; it is the teacher's choice, applied when the
  refund reaches `refunded`. At most one non-failed refund per attempt (partial
  unique index), so a second click cannot refund twice even before Mollie
  would refuse an amount above the remainder.
- **`OAuthState`** `{ id, stateHash @unique, teacherId, sessionId, expiresAt }`
  — sha256 (`hashToken`) of 32 random bytes, 10-minute TTL, deleted on use;
  the daily auth cleanup deletes expired rows.
- **`PayoutChangeKind`** gains `processor_connected`, `processor_changed`,
  `processor_disconnected`. Mollie links each balance to a profile, and each
  balance has its own bank account and payout settings, so a payment lands in
  the balance of the profile it was created under. The payout identity is
  therefore the live connection's **(organization, profile) pair**, and an
  event is written whenever the live identity becomes a new pair, at the
  moment it becomes live: by the OAuth callback (§1) or by choosing a profile.
  The kind is `processor_connected` when the row had no live identity just
  before the write, `processor_changed` otherwise. `before`/`after` carry the
  masked organization id (`org_…` plus its last four characters) and the
  profile's name (`org_…1234 · Studio Anna`); `before` is null for
  `processor_connected`, including one written by choosing a profile after a
  reconnect cleared it. A previous profile whose name the fetched profile list
  no longer holds is shown by its masked id (`pfl_…` plus its last four).
- **`NotificationType`** gains `processor_disconnected`,
  `payment_paid_twice`, `payment_charged_back` and `refund_failed` (teacher)
  and `payment_refunded` (student). Every
  `satisfies Record<NotificationType, …>` map (push policy, retention) then
  fails to compile until each has its row.
- **Dropped:** `Teacher.paymentLevel`, `Teacher.processorType`,
  `Teacher.processorAccountId`, `Payment.processorRef`, and the
  `PaymentLevel` enum (Decision 16). `ProcessorType` stays, now on the
  connection.

### The allowlist (`src/lib/processor-methods.ts`)

```ts
export const MOLLIE_METHODS = {
  ideal:      { label: 'iDEAL',       expiresMinutes: 15,  recurring: false },
  wero:       { label: 'Wero',        expiresMinutes: 10,  recurring: false },
  creditcard: { label: 'Card',        expiresMinutes: 30,  recurring: false },
  // …
} as const satisfies Record<string, MollieMethodEntry>;
export type AllowedMollieMethod = keyof typeof MOLLIE_METHODS;
```

Order of keys is the pay-page order (Decision 12). `recurring` is false
everywhere because nothing here uses it; it exists so that adding recurring
later is a filter on this constant, not a second list (#896, *Leaving room for
recurring*). `isAllowedMollieMethod(id: string): id is AllowedMollieMethod` is
the one way an id from Mollie becomes the type; an id not in the constant is
dropped and is the teacher's "not shown" list (§3).

## Locks

Every writer that changes a connection takes `lockTeacherForNoKeyUpdate`
first, as the payout writers do (`docs/lock-order.md`, "The `Teacher` row is
the first lock"), because each can write a `PayoutChangeEvent` and the resume
fingerprint must read a stable set.

Payment writers keep their CAS shape. The webhook's settle and a waived
refund's completion lock the `Payment` row (`FOR UPDATE`) and then its
attempts, the order every writer here uses; `markPaymentPaid`'s own CAS is
unchanged, so a manual mark-paid racing a webhook resolves by whichever
`updateMany` lands first and the loser's re-read classifies it. Completing a
refund whose outcome is `reopened` reuses `reopenPayment`'s transaction body,
so it takes that function's order — the `TeacherStudent` link first, then the
payment — rather than this one. A sync transaction that may complete such a
refund therefore starts with the link lock; whether it may is decided before
the transaction opens, from the fetched view and the stored rows: a fair.yoga
refund with that outcome that Mollie now reports `refunded` and the row does
not yet, counting a refund no row holds by the row the sync would adopt it
into (§5). The refund request's own answer transaction (§6 step 3) takes the
link itself, before the payment, when an ask-again it stores is already
`refunded`; its intent transaction locks the payment alone.

No database lock is ever held across a Mollie call. Refresh races are settled
by a single-flight promise per connection in process (one process, one VPS)
and a conditional write (`WHERE refreshToken = <the one we used>`): the loser
re-reads and uses the winner's token.

## 1 · Connecting

- **Where:** a new *Mollie* section on `/settings/profile`, beside the bank
  accounts and payment link it sits with, linked from the Settings index's
  payment row. `/settings/payments` stays the ledger.
- **Start:** `POST /api/teachers/[id]/processor/connect` writes an
  `OAuthState` bound to the session and answers the Mollie authorize URL
  (`response_type=code`, the scopes, `state`, `approval_prompt=force` on a
  reconnect — a `ProcessorConnection` row already exists for the teacher, in
  any state). The browser navigates there. A forced prompt on a reconnect
  makes Mollie show the scopes again and replaces the earlier authorization,
  which is what a re-authorization for new scopes needs; on a first connect it
  would be an extra screen for nothing.
- **Return:** `GET /api/processor/mollie/callback?code&state` — the session
  must be the one the state was bound to; the code (30-second lifetime) is
  exchanged immediately; `/v2/organizations/me` and `/v2/profiles` are read.
  Under the teacher lock the connection is rewritten, and its `profileId` is
  decided against the row's live identity read before the write:
  - **One usable profile:** it is chosen. When the (organization, profile)
    pair differs from the row's live identity, the `PayoutChangeEvent` is
    written (Data); the same pair writes none (a re-authorization for new
    scopes).
  - **Several:** when the organization is unchanged and the row's previous
    live profile is still in the list, that `profileId` is kept: the row stays
    live and no event is written. Otherwise `profileId` is set null — the row is
    not live, so no money can flow — no event is written, and the teacher is
    sent to a picker on the settings section.
  After commit, an event that was written gets `deliverPayoutChangedNotice`
  (#786's alert and *This wasn't me* link, unchanged).
- **Choosing a profile:** `PUT /api/teachers/[id]/processor/profile` sets the
  row's `profileId` from the picker, or switches it on a live row from the
  settings section. Under the teacher lock; a profile different from the row's
  current one writes the event (Data) and, after commit,
  `deliverPayoutChangedNotice`.
- **Refused** (409, registered codes): an unknown or expired state, a state
  from another session. A grant
  missing a requested scope is stored and the section says "reconnect to
  enable payments" rather than half-working.
- **Disconnect:** `DELETE /api/teachers/[id]/processor` — stamp
  `disconnectedAt` (the pay page offers no Mollie rows from then on), write
  `processor_disconnected` and alert, and set `revokeAfter` to the latest
  `expiresAt` among the connection's attempts still `open`, `pending` or
  `authorized`, or now when there are none. Open attempts finish: their
  webhooks still need a token. The daily auth cleanup revokes every row past
  `revokeAfter` (`DELETE /oauth2/tokens`), nulls its tokens and stamps
  `revokedAt`; one with no open attempts is revoked fire-and-forget right after
  the disconnect commits, and the sweep is its retry.
- **The pause (#786)** covers the connection: `payoutFingerprint` gains the
  live connection's `organizationId` and `profileId` (a row that is not live
  contributes null), so a reconnect or a profile switch during a pause
  changes what resume confirms. While paused the pay page already answers
  `paused` instead of every method, Mollie rows included; the attempt route
  refuses `PAYMENTS_PAUSED`.

## 2 · Tokens

`src/lib/processor-token-cipher.ts`: `seal(plaintext): Buffer` and
`open(sealed): string`, AES-256-GCM with a random 12-byte IV, layout
`[version][iv][tag][ciphertext]`, key from `PROCESSOR_TOKEN_KEY` (base64, 32
bytes). Unset key: Mollie is off, the connect section is not rendered, and
the config diagnosis follows `src/lib/push/config.ts`'s `{ ok: false, reason }`
shape and its consumer's logging: `unset` warns once, any other reason is a
`log.error` once, and Mollie stays off. Rotation: a new
version byte reads both keys and writes with the new one; out of scope beyond
leaving the byte.

`getAccessToken(db, connectionId)` answers a live token or a typed
`disconnected` result — refresh when within 5 minutes of expiry, single-flight
per connection; `invalid_grant` runs Decision 14 in one transaction (the
grant is already dead, so: null tokens, stamp `revokedAt`, and stamp `disconnectedAt`
only if it is not already set, all only while the row still holds the refresh token that
got `invalid_grant`; `processor_disconnected` notification only when the
connection was not already disconnected), then `logDegraded`. A network failure is not `invalid_grant`: it degrades that one
call and leaves the connection alone.

## 3 · Methods and the pay page

- `listOfferedMethods(connection, amount, currency)` calls
  `GET /v2/methods?profileId&amount[value]&amount[currency]` (plus `testmode`
  on a test connection), keeps the ids that pass `isAllowedMollieMethod`,
  orders them by the allowlist, and caches for 60 s. It answers
  `{ kind: 'methods', offered, excluded }`; `excluded` is what the settings
  section lists. A 422 for an unsupported currency answers empty, unlogged
  (Decision 4). Any other failure answers `{ kind: 'unavailable' }` and calls
  `logDegraded` with a new code.
- `PaymentMethod` gains `{ kind: 'processor'; method: AllowedMollieMethod }`;
  `PAYMENT_METHOD_COPY` gains its row; `MethodPanel` gains its case. The label
  comes from `MOLLIE_METHODS[method].label`. Because the pay page now awaits
  a network call, `paymentMethodsForTeacher` stays synchronous for every
  reader that only needs the Level 1 rows (email copy, reminders) and a new
  async `payPageMethods` adds the Mollie rows for the pay page alone. A Mollie
  outage never fails the page: `unavailable` renders the Level 1 rows.
- **Settings section:** connection state (organization, profile, test/live),
  the methods students will see in the teacher's currency, the methods
  excluded with one sentence ("fair.yoga doesn't offer pay-later credit at
  checkout" for the pay-later ids, "not offered yet" for the rest), Wero's
  120-day chargeback window when Wero is enabled, and the processor fees and
  net-payout note (product concept §7).

## 4 · Paying

- `POST /api/payments/[id]/processor-attempt { method }` — the student who
  owns the registration. Refuses (409): the payment not `pending`/`overdue`,
  the teacher paused, no live connection, `method` not in the overlap now.
  Reuses an `open` attempt for the same method, made under the connection's
  current `profileId` and `testmode`, that has not passed `expiresAt`. Otherwise creates the Mollie payment: `amount` (the class's
  currency), `description` (class title and date), `method` (one value),
  `redirectUrl` (the return page), `webhookUrl`, `profileId`,
  `metadata: { paymentId }`, no `applicationFee`. Records the attempt, answers
  `checkoutUrl`; the page navigates. The Mollie call is not in a transaction;
  the insert after it is, and a crash between them leaves a Mollie payment no
  row names — its webhook then answers 200 for an unknown id and it expires.
- **Return** `GET /api/payments/[id]/processor-return?attempt=…` fetches the
  attempt's status from Mollie (the student came back from Mollie; the webhook
  may not have arrived), applies it exactly as the webhook would, and
  redirects to the pay page with `?attempt=…`. The pay page then shows
  *Paid*, *Processing — we'll let you know*, or *Didn't go through* above its
  rows. `redirectUrl` points at this route; `webhookUrl` is omitted when the
  app URL's host is `localhost`, where Mollie cannot reach it, so development
  settles through the return alone.
- **"In progress":** an attempt in `pending` or `authorized` shows the same
  display state as #898's `studentReportedAt` claim, at both levels: the
  money is moving. An `open` attempt does not — a tap is not a payment.

## 5 · The webhook

`POST /api/webhooks/mollie`, form-encoded `id`. Unauthenticated, not
rate-limited: an unknown id costs one indexed read and answers 200 with no
Mollie call; a known id costs one Mollie GET whose answer is the only thing
believed. A refund webhook (`re_…` ids do not arrive on their own; Mollie calls
the payment's webhook) is handled by re-reading the payment's embedded refunds.

Applying a fetched status (`applyAttemptStatus`, shared with the return page):

| Mollie says | `Payment` is | Then |
|---|---|---|
| `paid` with `amountChargedBack > 0`, attempt not yet charged back | any | attempt `chargedBackAt`, `settledPayment = false`, `Payment` untouched (a settled one stays `paid`); teacher gets `payment_charged_back` ("<student> disputed <the amount Mollie reports charged back> with their bank and it was taken back. You can mark the payment unpaid to ask again."; for an attempt that did not settle the payment, the first sentence alone). Repeat → `unchanged`. Any amount above zero is a chargeback, a partial one included. This row is checked before the others |
| `paid` | `pending`/`overdue` | attempt `paid`, `settledPayment = true`, `markPaymentPaid(…, 'mollie')`; no notification, as for a manual mark-paid (nothing writes `payment_received` today) |
| `paid` | `paid` by this attempt | `unchanged` |
| `paid` | `paid` otherwise, or `not_charged` | attempt `paid`, `Payment` untouched, teacher gets `payment_paid_twice` with a refund action (Decision 7) |
| `pending`/`authorized` | any | attempt status only |
| `canceled`/`expired`/`failed` | any | attempt status only |
| refunds changed | any | `ProcessorRefund` rows fair.yoga created are updated by Mollie id. A row newly `refunded` completes the refund: its `outcome` applies — `waived` → CAS `paid → not_charged` and clear the attempt's `settledPayment`; `reopened` → `reopenPayment`'s body with the attempt named (link lock first, see *Locks*); null → no `Payment` change — and the student gets `payment_refunded`. A CAS miss (the payment is no longer `paid`) applies nothing and is logged at warn. A row newly `failed` changes no `Payment`, the attempt stays settling, and the teacher gets `refund_failed`; the live-refund index excludes `failed`, so the attempt can be refunded again. A refund fair.yoga cannot apply yet is left unwritten and the sync answers 503, so Mollie retries: a newly `refunded` row with outcome `reopened` met by a sync that did not start with the link lock (the row changed between the fetch and the lock), or a Mollie refund id with no row while every one of this attempt's fair.yoga refunds still lacking its Mollie id is younger than two minutes (`ADOPT_AFTER_MS`: its refund request may still store the id). A refund id with no row is adopted into the oldest of this attempt's fair.yoga refunds that lacks a Mollie id, is at least two minutes old and has the same amount and currency: the row takes the Mollie id and is then applied like any other row, and the adoption is logged. A refund id with no row that neither waits nor is adopted was made in Mollie's own dashboard: no row is created for it, and when such refunds reported `refunded` add up to the attempt's whole amount (in its currency), the attempt's `settledPayment` is cleared, as a chargeback clears it, with the `Payment` left `paid` and the release logged at info, so "Mark unpaid" applies again (Decision 17). A partial dashboard refund changes nothing. |

Every branch answers 200, except that a failure to reach Mollie or the
database, or a refund fair.yoga cannot apply yet, answers 503, so Mollie
retries (10 times over 26 h).

## 6 · Refunds

`POST /api/payments/[id]/refund { attemptId, choice }` — the teacher who
owns the payment. `choice` is required (`waive | ask_again`) when the
attempt settled the payment and null when it did not; a `choice` that does
not fit the attempt answers 400. Order, chosen because the money is the
irreversible part:

1. In a transaction: lock the payment; refuse (409) an attempt not `paid` or
   one charged back (`chargedBackAt`; the bank already took the money back),
   and refuse 409 `PROCESSOR_NOT_CONNECTED` one fair.yoga can no longer
   refund through (`canRefundThroughGrant`, Decision 17);
   answer an attempt whose refund is already `refunded` 200 `unchanged`;
   insert `ProcessorRefund` as `queued` with no Mollie id yet (the partial
   unique index stops a double click here). An earlier refund of the attempt
   that still has no Mollie id refuses the request (409) while it is younger
   than two minutes (`ADOPT_AFTER_MS`). An older one is first reconciled, as
   step 3 does: adopted, which answers the request as if it had made that
   refund (`unchanged` when it is already `refunded`); withdrawn when Mollie
   has none, and the request then proceeds; or, when Mollie cannot be asked,
   the request answers 503.
2. `POST /v2/payments/{id}/refunds` for the full amount.
3. The refund row is withdrawn (deleted) only when no refund can exist at
   Mollie: Mollie is not configured, no usable token can be had (a throw
   while getting one included), or Mollie refuses (balance and similar map to
   a registered code with copy). A token lookup that answers `disconnected`
   (the grant is revoked, or Mollie refused the refresh token) answers 409
   `PROCESSOR_NOT_CONNECTED`, as step 1 does; any other failure to get a
   token answers 503. When the request's outcome is unknown — it
   throws, times out, or answers 5xx or an unreadable body — the payment's
   refunds are fetched from Mollie once: a refund no row holds, with the
   attempt's amount and currency, is adopted as this request's (one not
   `failed` or `canceled` when there is one); with none,
   the row is withdrawn and the request answers 503; when that fetch fails
   too, the row is kept, logged at error, and the request answers 503. An
   accepted or adopted refund's id and status are stored in one transaction.
   Only when that status is already `refunded` does the refund complete in it
   (§5's *refunds changed* row: the `outcome` applies — `paid → not_charged`
   (Decision 9) or `paid → pending` (`reopenPayment`'s columns), CAS on
   `status = 'paid'` — and the student gets `payment_refunded`); when it is
   `failed`, the teacher gets `refund_failed`. Otherwise the payment stays
   `paid`, its attempt still settling, and the webhook completes the refund
   when Mollie reports it `refunded`. When that transaction fails, Mollie's
   refund id is logged at error and the request answers 500; the row, still
   without the id, is adopted by a later sync (§5) or reconciled by the next
   request (step 1). "Ask again" reopens through `reopenPayment`'s body with
   the refunded attempt named, which is the one reopen Decision 17 allows,
   and clears that attempt's `settledPayment`.
4. The payment row shows "Refund pending" while the refund is `queued`,
   `pending` or `processing`. A refund that fails leaves the payment `paid`;
   the teacher is told and can refund again.

On a payment an attempt settled, the teacher's row shows **Refund** where
"Mark unpaid" would be, while the attempt's grant holds (Decision 17). A chargeback is not a refund and is not
made here: §5 records it on the attempt, the teacher is told, and the row
then offers "Mark unpaid" and no Refund for that attempt. A partial
chargeback counts as a chargeback: any `amountChargedBack` above zero.

## 7 · Erasure and export

- Teacher erasure deletes the connection (revoking at Mollie after commit,
  fire-and-forget) and keeps attempts and refunds with their payments, which
  erasure already keeps as the student's record; `connectionId` becomes
  nullable for that reason.
- Student export lists each payment's attempts (method, status, amount, paid
  at) and refunds. No Mollie customer exists, so nothing else is held.
- The GDPR line at `src/services/gdpr.ts:1625–1626` goes with its columns.

## Docs

- `docs/product-concept.md` §7: replace "iDEAL, credit card, and other payment
  methods supported by the processor" with the allowlist rule and its
  reasoning; resolve `:244` against `:256` by stating that v1 has no automatic
  charging and that recurring is a later concept decision.
- `docs/technical-architecture.md`: the stack row's "payment links"; the
  webhook in *Unauthenticated API routes* (its table and count); the token
  cipher; the env block (`MOLLIE_CLIENT_ID`, `MOLLIE_CLIENT_SECRET`,
  `PROCESSOR_TOKEN_KEY` replace `MOLLIE_API_KEY`); `Payment` Level 2 retry
  note.
- `docs/data-model.md`: the three tables, the dropped columns, the narrowed
  #47 rule, and Decision 17's reopen rule with its chargeback exception.
- `docs/lock-order.md`: the connection writers under the teacher lock; the
  payment-then-attempt order.
- `docs/degradation-sites.md`: the new codes.
- CLAUDE.md *Payment Model*: Level 2's line, the grace-policy sentence on
  `paid → not_charged`, and that a Mollie-settled payment leaves `paid` only
  by refund until a chargeback (Decision 17).

## Mollie facts, as checked

Checked against docs.mollie.com on 2026-10-18; each line is the fact as found.

- **Refund webhooks.** The payment's `webhookUrl` is called when a refund on
  it reaches `processing`, `refunded` or `failed` (Payments API webhooks,
  https://docs.mollie.com/reference/webhooks); `queued`, `pending` and
  `canceled` do not call it (§5, §6).
- **Refund statuses and the low-balance error.** The statuses are `queued`,
  `pending`, `processing`, `refunded`, `failed`, `canceled`
  (https://docs.mollie.com/reference/create-refund); the docs give no meaning
  for any of them and no insufficient-balance error. Create-refund needs
  `refunds.write`, and its documented errors are 409 for a duplicate and 422
  for a missing field, each with `status`, `title`, `detail`, and `field` when
  a field is at fault. Treating a 422 as a refusal and `queued` as a low
  balance is therefore an assumption, held in §6 as copy fallbacks.
- **Unsupported currency.** Not documented as a 422. The Methods API says "If
  supplied, only payment methods that support the amount and currency are
  returned" (https://docs.mollie.com/reference/list-methods) and documents only
  400 and 429. The adapter answers `unsupported` for a 422 and for an empty
  list alike (§3, Decision 4).
- **Revocation and re-prompt.** `DELETE https://api.mollie.com/oauth2/tokens`
  with Basic client credentials, `token_type_hint` and `token`, answers 204;
  "Revoking a refresh token revokes all access tokens that were created using
  the same authorization" (https://docs.mollie.com/reference/oauth-revoke-tokens).
  The schema says JSON while the example is form-encoded. `approval_prompt` is
  `auto` (default) or `force`; `force` shows the consent screen, and "if a
  merchant creates a new authorization after a forced prompt, previously
  active authorizations will be revoked"
  (https://docs.mollie.com/reference/oauth2/authorize). The authorize URL is
  `https://my.mollie.com/oauth2/authorize` with `client_id`, `state`, `scope`
  (space-separated) and `response_type=code` required.
- **BLIK's expiry.** Not in the expiry table
  (https://docs.mollie.com/docs/handling-payment-status). Its page gives a
  "Session timeout: 55 seconds" (https://docs.mollie.com/docs/blik); for the
  other methods checked, the session timeout equals the table's expiry.
- **Payout scope.** Wrong as stated. "Each balance is linked to a profile" and
  "Payments processed with a profile's API key are credited to the balance
  linked to that profile"; each balance can have its own bank account and
  payout settings (https://docs.mollie.com/docs/balance). The docs do not say
  whether two profiles may share one balance.
- **`localhost` and `embed=refunds`.** Holds: "The webhookUrl must be reachable
  from Mollie's point of view, so you cannot use `localhost`"
  (https://docs.mollie.com/reference/create-payment). `embed` takes `captures`,
  `refunds`, `chargebacks`, and Get payment lists only `payments.read`
  (https://docs.mollie.com/reference/get-payment); `refunds.read` is still
  requested in case.
- **Refresh-token rotation.** Not documented. A refresh returns "The newly
  generated access token and refresh token", "The refresh token does not
  expire", and nothing says the old one is invalidated
  (https://docs.mollie.com/reference/oauth-generate-tokens). §2 stores whatever
  comes back. A revoked grant answers `invalid_grant` on the next refresh
  (https://docs.mollie.com/docs/connect-manage-merchants); the HTTP status of
  that answer is not documented.
- **PayPal pay-later.** Its products can appear inside PayPal's checkout and no
  switch is documented; PayPal is on the allowlist by decision (Decision 3).
- **Chargebacks.** (a) The payment carries `amountChargedBack`: "The total
  amount that was charged back for this payment. Only available when the total
  charged back amount is not zero"; the docs do not say that `status` changes,
  and its values stay `open`, `pending`, `authorized`, `paid`, `canceled`,
  `expired`, `failed`, so a charged-back payment can still read `paid`
  (https://docs.mollie.com/reference/get-payment). (b) Yes: "the webhook will
  be called when ... A chargeback is received on the payment"
  (https://docs.mollie.com/reference/webhooks). (c) `embed=chargebacks`
  exists on Get payment, which needs `payments.read`; listing a payment's
  chargebacks also needs `payments.read` only
  (https://docs.mollie.com/reference/list-payment-chargebacks).

## Out of scope

Stripe; recurring, mandates and Mollie customers; partial refunds; a
chargeback's reversal (the classic webhook is documented only for a received
chargeback, so an attempt keeps `chargedBackAt` once stamped); a retry policy
(CLAUDE.md, *Open Questions*); key rotation beyond the version byte.

## Testing

- **Unit:** the cipher (round trip, tamper → throws, wrong version → throws);
  `isAllowedMollieMethod` and overlap ordering; `applyAttemptStatus`'s table,
  row by row.
- **No test reaches Mollie, and no integration test sees the wire.**
  Integration tests run against a live dev server that a test cannot re-env
  (`docs/technical-architecture.md`, Testing conventions), so they follow the
  repo's provider pattern (email's dry-run, push's unconfigured retire):
  - *Adapter* (`src/lib/mollie/client.ts`), unit tier with a stubbed `fetch`:
    request shapes, timeouts, `invalid_grant` and 422 classification.
  - *Services*, unit tier against the real test database with the client
    injected (as `dispatchPushes(db, { send })` takes its sender): connect
    with one and several profiles (a kept previous profile and a cleared one
    both write no event); choosing a profile writes the event; state reuse
    and cross-session state refused; the overlap with a pay-later id enabled; unsupported currency
    and Mollie down answer the Level 1 rows; attempt reuse; each webhook row;
    a repeat webhook `unchanged`; double payment; a chargeback and its
    repeat; reopen of a Mollie-settled payment refused, and allowed after a
    chargeback; refund with each outcome and as a duplicate, each applied
    only once the refund is `refunded`; a failed refund leaving `paid`; a
    completion's CAS miss; a refund that cannot apply yet answering 503, and
    a dashboard refund ignored; a charged-back attempt refused; double-click
    refund; `invalid_grant` disconnects and
    notifies; pause refuses the attempt.
  - *Routes*, unit-tier `route.test.ts` with services mocked.
  - *Integration*, only paths that make no outbound call: with no live
    connection the pay page renders exactly today's rows; the webhook answers
    200 for an unknown id; the attempt route refuses a teacher without a
    connection; the connect section is absent when Mollie is unconfigured.
- **Guards to break and record** (plan step per guard): remove an allowlist
  label (compile error expected); make the injected client return an id not on
  the allowlist (absent from the offered methods); drop the session binding on the state
  (the cross-session test fails); remove the partial unique index (the
  double-click test fails); make `markPaymentNotCharged` accept `paid` (its
  refusal test fails); remove `reopenPayment`'s settled-by-Mollie refusal (its
  refusal test fails).
- **Manual, before merge:** one real connect against Mollie test mode.
