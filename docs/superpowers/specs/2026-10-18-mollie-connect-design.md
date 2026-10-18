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
3. **PayPal is conditional.** Before the allowlist entry merges, the build
   confirms whether PayPal's own pay-later ("Pay in 4", "Pay Later") can
   appear inside a Mollie-created PayPal checkout, and whether it can be
   switched off. If it can appear and cannot be switched off, PayPal is
   removed from the allowlist. The finding is recorded in the PR body.
4. **No per-currency Level setting.** Mollie filters methods by currency once
   given the amount (iDEAL, Wero, Bancontact and EPS are EUR only; USD gets
   card and PayPal). An empty overlap shows the Level 1 rows alone. A currency
   Mollie rejects is an empty overlap, not a degradation.
5. **Every scope this issue uses is requested at connect**, `refunds.write`
   included, because adding a scope later forces every teacher to
   re-authorize. Nothing for customers, mandates or subscriptions.
6. **An open attempt is left to expire** when the teacher marks the payment
   paid by hand or waives it. No Mollie call on the manual paths. The window is
   the method's expiry, written on its allowlist entry (Data): Wero 10 min,
   iDEAL 15, card and Apple Pay 30, Twint 45, Bancontact, EPS and
   Przelewy24 60, PayPal 360; BLIK's is not in Mollie's table and is to verify. A completion inside it is a double payment
   (Decision 7).
7. **A webhook reporting paid for a payment already settled** records the
   attempt as paid, leaves the `Payment` untouched, tells the teacher the
   student paid twice, and answers 200.
8. **Refunds: any Mollie-paid attempt, full amount only.** Mollie returns the
   money from the teacher's own balance to the original payer; fair.yoga never
   holds it. When the refunded attempt is the one that settled its `Payment`,
   the teacher chooses in the same dialog: **refund and waive**
   (`paid → not_charged`) or **refund and ask again** (`paid → pending`). A
   refund of a duplicate attempt (Decision 7) changes no `Payment`.
9. **`paid → not_charged` becomes legal, through a refund only.** This
   narrows #47's "never a refund": `markPaymentNotCharged` still refuses a
   paid payment, and the only writer of the transition is the refund service,
   in the same transaction that records the refund. Waiving after money has
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
    told in-app and by email, and `logDegraded` records it.
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
  method String, status ProcessorPaymentStatus, amount Decimal, currency
  Currency, checkoutUrl String?, expiresAt DateTime?, paidAt DateTime?,
  settledPayment Boolean, createdAt, updatedAt }`. `ProcessorPaymentStatus`
  is Mollie's own set: `open`, `pending`, `authorized`, `paid`, `canceled`,
  `expired`, `failed`. `settledPayment` is true on at most one attempt per
  `Payment` (partial unique index `WHERE settled_payment`): the one whose
  webhook moved the `Payment` to `paid`. Every writer that moves a `Payment`
  out of `paid` (`reopenPayment`, a refund's outcome) clears it in the same
  transaction, or a later settle would collide with the index. `currency` is a snapshot in the
  `docs/data-model.md` sense: what Mollie charged, which no later currency
  switch may relabel. `method` is a string, not the allowlist type, because
  a stored row must stay readable after its method leaves the allowlist.
- **`ProcessorRefund`** `{ id, attemptId → ProcessorPayment, processorRefundId
  @unique, amount Decimal, status ProcessorRefundStatus, outcome
  RefundOutcome?, requestedAt, updatedAt }`. Statuses are Mollie's
  (`queued`, `pending`, `processing`, `refunded`, `failed`, `canceled`).
  `RefundOutcome` is `waived | reopened` for a refund of the settling attempt
  and null for a duplicate. At most one non-failed refund per attempt (partial
  unique index), so a second click cannot refund twice even before Mollie
  would refuse an amount above the remainder.
- **`OAuthState`** `{ id, stateHash @unique, teacherId, sessionId, expiresAt }`
  — sha256 (`hashToken`) of 32 random bytes, 10-minute TTL, deleted on use;
  the daily auth cleanup deletes expired rows.
- **`PayoutChangeKind`** gains `processor_connected`, `processor_changed`,
  `processor_disconnected`. `before`/`after` carry the masked organization id
  (`org_…` plus its last four characters) and the organization's name.
  `processor_changed` is a reconnect landing on a different organization.
  The organization, not the profile, is the payout identity: Mollie pays a
  balance out per organization, so choosing between an organization's
  profiles writes no event.
- **`NotificationType`** gains `processor_disconnected`,
  `payment_paid_twice` and `refund_failed` (teacher) and `payment_refunded`
  (student). Every
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
the first lock"), because each writes a `PayoutChangeEvent` and the resume
fingerprint must read a stable set.

Payment writers keep their CAS shape. The webhook's settle and the refund's
outcome lock the `Payment` row (`FOR UPDATE`) and then its attempts, the
order every writer here uses; `markPaymentPaid`'s own CAS is unchanged, so a
manual mark-paid racing a webhook resolves by whichever `updateMany` lands
first and the loser's re-read classifies it. "Refund and ask again" reuses
`reopenPayment`'s transaction body, so it takes that function's order — the
`TeacherStudent` link first, then the payment — rather than this one.

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
  reconnect). The browser navigates there.
- **Return:** `GET /api/processor/mollie/callback?code&state` — the session
  must be the one the state was bound to; the code (30-second lifetime) is
  exchanged immediately; `/v2/organizations/me` and `/v2/profiles` are read;
  one profile is chosen automatically, several send the teacher to a picker on
  the settings section. Under the teacher lock: rewrite the connection, write
  the `PayoutChangeEvent`, then after commit `deliverPayoutChangedNotice`
  (#786's alert and *This wasn't me* link, unchanged).
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
  live connection's `organizationId`, so a reconnect during a pause
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
grant is already dead, so: null tokens, stamp `disconnectedAt` and
`revokedAt`, `processor_disconnected` notification), then
`logDegraded`. A network failure is not `invalid_grant`: it degrades that one
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
  Reuses an `open` attempt for the same method that has not passed
  `expiresAt`. Otherwise creates the Mollie payment: `amount` (the class's
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
| `paid` | `pending`/`overdue` | attempt `paid`, `settledPayment = true`, `markPaymentPaid(…, 'mollie')`; no notification, as for a manual mark-paid (nothing writes `payment_received` today) |
| `paid` | `paid` by this attempt | `unchanged` |
| `paid` | `paid` otherwise, or `not_charged` | attempt `paid`, `Payment` untouched, teacher gets `payment_paid_twice` with a refund action (Decision 7) |
| `pending`/`authorized` | any | attempt status only |
| `canceled`/`expired`/`failed` | any | attempt status only |
| refunds changed | any | `ProcessorRefund` rows fair.yoga created are updated by Mollie id; a newly `failed` one sends the teacher `refund_failed`. A refund made in Mollie's own dashboard has no row and is not created here. |

Every branch answers 200. Only a failure to reach Mollie or the database
answers 500, so Mollie retries (10 times over 26 h).

## 6 · Refunds

`POST /api/payments/[id]/refund { attemptId, outcome? }` — the teacher who
owns the payment. `outcome` is required (`waive | ask_again`) when the attempt
settled the payment and refused when it did not. Order, chosen because the
money is the irreversible part:

1. In a transaction: lock the payment and attempt; refuse (409) an attempt not
   `paid`, one with a non-failed refund, a payment no longer `paid` by it when
   `outcome` is given; insert `ProcessorRefund` as `queued` with no Mollie id
   yet (the partial unique index stops a double click here).
2. `POST /v2/payments/{id}/refunds` for the full amount.
3. Mollie refuses: delete the row, answer the refusal (balance and similar
   map to a registered code with copy). Mollie accepts: store its id and
   status, and in the same transaction apply `outcome` — `paid →
   not_charged` (Decision 9) or `paid → pending` (`reopenPayment`'s columns) —
   CAS on `status = 'paid'`. A CAS miss (the teacher reopened it meanwhile)
   leaves the state the teacher chose and says so; the money has gone back
   either way.
4. The student gets `payment_refunded`. A `queued` refund (low balance) is
   shown as queued on the payment row until a webhook moves it.

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
  #47 rule.
- `docs/lock-order.md`: the connection writers under the teacher lock; the
  payment-then-attempt order.
- `docs/degradation-sites.md`: the new codes.
- CLAUDE.md *Payment Model*: Level 2's line and the grace-policy sentence on
  `paid → not_charged`.

## To verify against Mollie before the plan

Each is stated above as the design assumes it; the plan's first task checks
them and the spec is corrected where one fails.

- A refund's status change calls the payment's `webhookUrl` (§5, §6).
- The refund statuses and the error answered for a low balance (§6).
- The Methods API's answer for an unsupported currency is a 422 (§3).
- `DELETE /oauth2/tokens` revokes, and `approval_prompt=force` re-prompts (§1).
- BLIK's default expiry (Decision 6).
- Mollie pays balances out per organization, not per profile (Data).
- Mollie refuses a `localhost` `webhookUrl` (§4), and which scope `embed=refunds`
  needs (`refunds.read` is requested in case).
- Whether refresh tokens rotate (§2 handles either; the conditional write
  matters only if they do).
- The PayPal pay-later check (Decision 3).

## Out of scope

Stripe; recurring, mandates and Mollie customers; partial refunds; chargebacks
(an attempt's chargeback is recorded as its Mollie status and nothing more —
the teacher reopens by hand if they want to chase it); a retry policy
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
    with one and several profiles; state reuse and cross-session state
    refused; the overlap with a pay-later id enabled; unsupported currency
    and Mollie down answer the Level 1 rows; attempt reuse; each webhook row;
    a repeat webhook `unchanged`; double payment; refund with each outcome
    and as a duplicate; double-click refund; `invalid_grant` disconnects and
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
  refusal test fails).
- **Manual, before merge:** one real connect against Mollie test mode, and the
  PayPal pay-later check (Decision 3).
