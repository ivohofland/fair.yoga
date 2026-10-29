# Degradation sites

Which server log lines are *degradations* — recorded by `logDegraded`
(`src/lib/degradation.ts`), stored in `DegradationEvent` and emailed to
`OPERATOR_EMAIL` in the daily digest — and why every other `warn` and `error`
line is not. The registry of codes is `DEGRADATION_CODES`
(`src/lib/degradation-codes.ts`); what to do when each code arrives is the last
section of this file. Issue #157; the design is
`docs/superpowers/specs/2026-10-02-degradation-events-design.md`.

## The rule

**A site is a *degradation* iff it substitutes, or withholds, a value a user
will see, because data that should have been impossible turned up. It is
*routine* otherwise.**

Calibration, fixed by the spec:

- Lock contention (`isLockTimeout` branches), rate-limit throttles, 4xx
  refusals and documented races (the `session.studentId` hard-delete race on the
  public page among them) are routine.
- A caught exception the user sees as an error is a *failure*, not a
  degradation: it substitutes nothing. Recorded as "failure, surfaced as an
  error".

Three further readings, stated so they can be argued with:

- **A failure the user does not see is still not a degradation** unless its
  cause is impossible *data*. A dropped notification because a query timed out
  withholds something, but an outage is not a corrupt value, and the job-health
  and log lines that already exist are the right channel. Recorded as "failure
  (an exception or outage), not impossible data".
- **One incident, one code.** Where an impossible value is reported at its root
  and a caller then reacts to the sentinel the root returned, the caller's line
  is an *echo*: the incident is already in the digest, under the root's code.
  Recorded as "echo of `CODE`". The echo lines are still useful — several carry
  the row ids the root cannot — and the code's section below says to search the
  log for them.
- **An operational fault the operator must hear about may be recorded.** A
  fault that users meet as an error, and that nothing else reports in time,
  may be given a code so the digest carries it. This is admitted per code, by
  name here, never by analogy: `DATABASE_POOL_EXHAUSTED` is admitted because a
  request that times out waiting for a pooled connection has no other channel
  to the operator (#939). Recorded under *Degradations* as "an operational
  fault, admitted under the rule's third reading".

When a verdict was not obvious, it is recorded as routine and the doubt is
written under "Close calls".

## Re-deriving this list

Run from the repository root. Each count comes from its own command; nothing
is truncated.

```bash
# The surface: every non-test line that calls log.warn( or log.error(.
grep -rnE "log\.(warn|error)\(" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'

# Its two halves, counted separately.
grep -rnE "log\.warn\(" src --include='*.ts' --include='*.tsx' | grep -vc '\.test\.'
grep -rnE "log\.error\(" src --include='*.ts' --include='*.tsx' | grep -vc '\.test\.'

# A call split as `log\n  .warn(` would escape the first pattern. This finds none.
grep -rnE "^\s*\.(warn|error)\(" src --include='*.ts' --include='*.tsx' | grep -vc '\.test\.'

# Calls whose level is computed (`log[level](`), which the first pattern also misses.
grep -rnE "\blog\[" src --include='*.ts' --include='*.tsx' | grep -vc '\.test\.'

# The degradations themselves.
grep -rnE "logDegraded\(" src --include='*.ts' --include='*.tsx' | grep -vc '\.test\.'
```

Measured when the tables below were last brought up to date:

| command | count |
|---|---|
| `log.warn(` lines | 109 |
| `log.error(` lines | 96 |
| surface (`log.warn(` or `log.error(`) | **109 + 96 = 205** |
| split `.warn(` / `.error(` continuation lines | 0 |
| `log[…](` lines | 18 |
| `logDegraded(` call lines | 42 |

One of the 205 is not a call: `src/lib/log.ts` carries a usage example inside
its docblock. One of the 18 is not a site: `src/lib/degradation.ts`
(`logDegraded`) is the line `logDegraded` itself emits. That leaves 204 static
calls and 17 computed-level calls. Every one of the 42 `logDegraded` calls has
a row under *Degradations* below, and so does every computed-level call. The
surface table has 176 rows: the docblock line and 175 calls. The other
204 − 175 = 29 static calls have no row yet, which is what the next audit
owes. Per file, the calls without a row are the first command's lines a file
has beyond its rows here.

Each row names its file and the function its call sits in, not a line number,
so an edit elsewhere in the file does not move it; a function with several
calls has one row for each, in source order. The commands are the source of
truth. A new `log.warn(` or `log.error(` raises the first count and appears in
the first command's output without a row here — that row is what the next
audit owes.

**Out of scope:** `console.warn(` / `console.error(` lines (count:
`grep -rnE "console\.(warn|error)\(" src --include='*.ts' --include='*.tsx' | grep -vc '\.test\.'`).
They are in client components and in the worktree tooling under
`src/lib/worktree/`; `logDegraded` is `server-only` and cannot run in a
browser, so none of them can be a recorded degradation without a client-to-server
reporting channel this project does not have.

## Close calls

The sites where the verdict took judgment, and why each landed where it did.

- **The unreadable-instant branches** — `timezone.ts` (`startOfLocalDay`,
  `formatInstantInZone`) and `finish-window.ts` (`formatClockInZone`). Each
  substitutes `Invalid Date` or the literal string `'Invalid Date'`, which a
  user can see. Ruled *routine (echo)*: every instant they are handed is either
  `new Date()`, a Prisma `DateTime` (always readable), or arithmetic on
  `classStartInstant`'s answer — so the only data path to an unreadable one is
  an unreadable class start, already recorded as `CLASS_START_UNREADABLE`.
  Any other path is a code defect producing NaN, not stored data. *Unclear:*
  if a future caller passes an instant read from somewhere else, these become
  roots of their own and should be converted.
- **The echoes that carry ids** — `class-reminders.ts` ("unreadable class
  start; skipped", `classId`), `entry-generation.ts` ("no candidate dates
  because their start instants could not be read", `templateId`, `teacherId`)
  and `class-lifecycle.ts` ("refusing completion: this class schedule is
  unreadable", `classId`). Each withholds something user-visible (a reminder, a
  window of classes, a completion). Ruled *routine (echo)*: `classStartInstant`
  records the incident in the same call, just before. Converting them would
  split one incident across codes (two of the three log at `error`, which a
  code shared with the `warn`-level root cannot). Their ids are what
  `CLASS_START_UNREADABLE`'s runbook below sends you to the log for.
- **`rate-limit.ts` unresolved client IP.** It substitutes a shared bucket key
  for a missing address, and its docblock calls itself the operator's only
  signal that the trusted-proxy assumption broke. Ruled *routine*: the trigger
  is configuration (a proxy not setting `x-forwarded-for`), not stored data,
  and the user-visible effect is at most a throttle, which the calibration
  names routine. *Unclear:* whether configuration faults should reach the
  digest at all is a question this rule does not answer; it would be a
  separate decision, not a reading of this one.
- **`timezone-audit.ts`.** It finds stored timezones that are impossible data.
  Ruled *routine*: it substitutes and withholds nothing — it is a detector, it
  throws so `daily-cleanup` reports unhealthy, and every substitution such a
  zone causes is recorded at the use site as `TIMEZONE_INVALID_FALLBACK_UTC`.
- **The impossible-by-invariant 404s in `rule-lifecycle.ts`** (archive and
  pause/resume finding no child row to lock, or none on re-read under the lock).
  The data is impossible by the invariant `docs/data-model.md` records, but the
  teacher is answered 404: *failure, surfaced as an error*.
- **`signup-ticket.ts` — a `student_signup` token whose redirect is missing or
  unsafe.** Stored data that should not exist, but the reader is answered with
  an error, not a substitute: *failure, surfaced as an error*.
- **`class-transitions.ts` — "start sweep: CAS lost under a held row lock".**
  The class misses its `in_progress` transition for that tick, which a user can
  notice. Ruled *routine*: the impossible thing is lock behaviour, not a value
  in a row, and the line logs at `error` on every tick it recurs.
- **`entry-generation.ts` — the first-effective-week probe's arithmetic
  threw.** The confirmation withholds the week it would have named. Ruled
  *routine*: the docblock says a throw there is a defect in that function, not
  a stored value, and the edit itself saved.
- **The slot-holder probes** — `entry-conflict.ts` and `rule-slot-holder.ts`
  when their own query fails. The 409 the teacher sees is less specific. Ruled
  *failure, not impossible data*. Their unknown-*kind* branches are
  degradations, recorded as `ENTRY_CONFLICT_KIND_UNKNOWN` and
  `RULE_SLOT_KIND_UNKNOWN`: a holder the query found, withheld from the 409
  because its kind has no name here. `ruleSlotHolder` keeps its routine
  "no holder row" outcome (the rule was archived meanwhile) silent and apart
  from that branch.

- **`processor-refunds.ts` (`storeAnswer`) — a refund Mollie took that
  fair.yoga could not store.** The cause is usually an outage (a lock timeout,
  the database), which the reading above calls a failure, not a degradation.
  Ruled a *degradation* (`PROCESSOR_REFUND_UNRECORDED`, `store_failed`) all
  the same: money has moved at Mollie, fair.yoga holds no record of it until
  a sync adopts the refund, and the teacher's 503 cannot tell the operator. The
  `intent_gone` branch is the same record withheld, with the intent row
  deleted under it, and answers the teacher as if the refund were requested.
- **The unknown refund status** — `storeAnswer` and `syncAttempt`. Mollie
  answering a refund status the client does not name is a value that should
  be impossible; `storeAnswer` substitutes `queued`, which the teacher sees as
  "Refund pending", and `syncAttempt` withholds that refund's update. Ruled a
  *degradation* (`PROCESSOR_REFUND_UNRECORDED`, `status_unknown`), as the
  payment's own unknown status is.
- **`processor-refunds.ts` (`unheldRefund`, `reconcileStale`) — Mollie
  cannot be asked which refunds a payment has.** Ruled *routine*: an outage,
  answered to the teacher as `unavailable` ("try again in a moment"), or as
  `unconfirmed` with `MOLLIE_UNAVAILABLE` recorded by `requestRefund`. A
  `getPayment` answering null (Mollie no longer knows a payment fair.yoga
  holds) is impossible data, but here it too surfaces as that error; the sync
  that meets it records `PROCESSOR_PAYMENT_UNCONFIRMED`.
- **`processor-attempts.ts` (`completeRefund`) — a completed refund whose
  payment is no longer `paid`.** Its outcome is not applied. Ruled *routine*:
  the payment can only have left `paid` through the teacher's own edit, a
  state the teacher made rather than impossible data,
  and the student is still told their money is on its way back.

## Classification

### Degradations

Every `logDegraded` call. The level is the code's, from the registry.

| site (file, function) | level | verdict | code or reason |
|---|---|---|---|
| `src/lib/email-templates.ts` (`studentAction`) | warn | degradation | `PAYMENT_NOTIFICATION_WITHOUT_CLASS` |
| `src/lib/email-templates.ts` (`studentAction`) | warn | degradation | `DONATION_INVITATION_WITHOUT_CLASS` |
| `src/lib/entry-conflict.ts` (`probeConflictingEntry`) | error | degradation | `ENTRY_CONFLICT_KIND_UNKNOWN` |
| `src/lib/finish-window.ts` (`formatClockInZone`) | error | degradation | `TIMEZONE_INVALID_FALLBACK_UTC` |
| `src/lib/pay-page.server.ts` (`markedPaidLine`) | warn | degradation | `PAYMENT_PAID_WITHOUT_TIMESTAMP` |
| `src/lib/pay-page.server.ts` (`reportMissingPayment`) | warn | degradation | `CHARGED_REGISTRATION_WITHOUT_PAYMENT` |
| `src/lib/payment-breakdown.server.ts` (`resolveReportedPaymentBreakdown`) | warn | degradation | `PAYMENT_SNAPSHOT_MISSING` |
| `src/lib/pool-exhaustion.ts` (`recordPoolExhaustion`) | error | degradation | `DATABASE_POOL_EXHAUSTED` (an operational fault, admitted under the rule's third reading) |
| `src/lib/rule-slot-holder.ts` (`ruleSlotHolder`) | error | degradation | `RULE_SLOT_KIND_UNKNOWN` |
| `src/lib/tiers.server.ts` (`readIncomeTier`) | warn | degradation | `INCOME_TIER_OUT_OF_RANGE` |
| `src/lib/timezone.ts` (`startOfLocalDay`) | error | degradation | `TIMEZONE_INVALID_FALLBACK_UTC` |
| `src/lib/timezone.ts` (`formatInstantInZone`) | error | degradation | `TIMEZONE_INVALID_FALLBACK_UTC` |
| `src/lib/timezone.ts` (`classStartInstant`) | warn | degradation | `CLASS_START_UNREADABLE` |
| `src/lib/timezone.ts` (`classStartInstant`) | warn | degradation | `CLASS_START_UNREADABLE` |
| `src/lib/timezone.ts` (`classStartInstant`) | error | degradation | `TIMEZONE_INVALID_FALLBACK_UTC` |
| `src/services/email-fallback.ts` (`processEmailFallback`) | error | degradation | `TEACHER_NOTIFICATION_TYPE_UNKNOWN` |
| `src/services/gdpr.ts` (`deleteTeacherAccount`) | error | degradation | `PROCESSOR_TOKEN_UNREADABLE` (the erased teacher's grant, after commit) |
| `src/services/processor-attempts.ts` (`createAttempt`) | warn | degradation | `MOLLIE_UNAVAILABLE` (`createPayment` failed) |
| `src/services/processor-attempts.ts` (`createAttempt`) | warn | degradation | `MOLLIE_UNAVAILABLE` (`createPayment` gave no checkout URL) |
| `src/services/processor-attempts.ts` (`syncAttempt`) | warn | degradation | `PROCESSOR_PAYMENT_UNCONFIRMED` (`teacher_erased`) |
| `src/services/processor-attempts.ts` (`syncAttempt`) | warn | degradation | `PROCESSOR_PAYMENT_UNCONFIRMED` (`connection_revoked`) |
| `src/services/processor-attempts.ts` (`syncAttempt`) | warn | degradation | `MOLLIE_UNAVAILABLE` (`getPayment`) |
| `src/services/processor-attempts.ts` (`syncAttempt`) | warn | degradation | `PROCESSOR_PAYMENT_UNCONFIRMED` (`mollie_unknown`) |
| `src/services/processor-attempts.ts` (`syncAttempt`) | warn | degradation | `PROCESSOR_PAYMENT_UNCONFIRMED` (`status_unknown`) |
| `src/services/processor-attempts.ts` (`syncAttempt`) | error | degradation | `PROCESSOR_REFUND_UNRECORDED` (`status_unknown`: the refund is skipped) |
| `src/services/processor-attempts.ts` (`syncAttempt`) | warn | degradation | `PROCESSOR_PAYMENT_UNCONFIRMED` (`row_gone`) |
| `src/services/processor-attempts.ts` (`chargedBackLine`) | warn | degradation | `PROCESSOR_CHARGEBACK_CURRENCY_MISMATCH` |
| `src/services/processor-connection.ts` (`unrevokedRefresh`) | error | degradation | `PROCESSOR_TOKEN_UNREADABLE` (the grant a reconnect replaced) |
| `src/services/processor-connection.ts` (`revokeDroppedGrant`) | warn | degradation | `MOLLIE_UNAVAILABLE` (`revoke`) |
| `src/services/processor-connection.ts` (`mollieUnavailable`) | warn | degradation | `MOLLIE_UNAVAILABLE` (`exchangeCode`, `organization`, `profiles`), for `completeConnect`, `chooseProfile` and `readConnectionView` |
| `src/services/processor-connection.ts` (`revokeDueConnection`) | error | degradation | `PROCESSOR_TOKEN_UNREADABLE` |
| `src/services/processor-connection.ts` (`revokeDueConnection`) | warn | degradation | `MOLLIE_UNAVAILABLE` (`revoke`) |
| `src/services/processor-methods-offer.ts` (`listOfferedMethods`) | warn | degradation | `MOLLIE_UNAVAILABLE` (`listMethods`) |
| `src/services/processor-refunds.ts` (`requestRefund`) | warn | degradation | `MOLLIE_UNAVAILABLE` (`createRefund` failed) |
| `src/services/processor-refunds.ts` (`requestRefund`) | warn | degradation | `MOLLIE_UNAVAILABLE` (`createRefund` unconfirmed: the refund may exist) |
| `src/services/processor-refunds.ts` (`storeAnswer`) | error | degradation | `PROCESSOR_REFUND_UNRECORDED` (`status_unknown`: recorded as `queued`) |
| `src/services/processor-refunds.ts` (`storeAnswer`) | error | degradation | `PROCESSOR_REFUND_UNRECORDED` (`intent_gone`) |
| `src/services/processor-refunds.ts` (`storeAnswer`) | error | degradation | `PROCESSOR_REFUND_UNRECORDED` (`store_failed`) |
| `src/services/processor-token.ts` (`getAccessToken`) | error | degradation | `PROCESSOR_TOKEN_UNREADABLE` |
| `src/services/processor-token.ts` (`refreshOnce`) | warn | degradation | `MOLLIE_UNAVAILABLE` (`refresh`) |
| `src/services/processor-token.ts` (`refreshOnce`) | warn | degradation | `PROCESSOR_DISCONNECTED` |
| `src/services/processor-token.ts` (`settledLookup`) | error | degradation | `PROCESSOR_TOKEN_UNREADABLE` |

### The `log.warn(` / `log.error(` surface

| site (file, function) | level | verdict | code or reason |
|---|---|---|---|
| `src/app/(public)/[slug]/page.tsx` (`TeacherBookingPage`) | warn | routine | documented race (hard delete vs session); the page falls back to its signed-out view |
| `src/app/(student)/bookings/[classId]/pay/page.tsx` (`attemptBanner`) | error | routine | failure (an exception or outage), not impossible data (unreachable `never` branch; a code defect, not data) |
| `src/app/(student)/bookings/[classId]/pay/page.tsx` (`PayBody`) | error | routine | failure (an exception or outage), not impossible data (unreachable `never` branch; a code defect, not data) |
| `src/app/(student)/bookings/page.tsx` (`StudentBookingsPage`) | warn | routine | documented race (hard delete vs session); redirects |
| `src/app/(student)/bookings/page.tsx` (`OutstandingPayAction`) | error | routine | failure (an exception or outage), not impossible data (unreachable `never` branch; a code defect, not data) |
| `src/app/api/account/route.ts` (`DELETE`) | error | routine | failure, surfaced as an error (answered busy) |
| `src/app/api/account/student-profile/route.ts` (`POST`) | error | routine | failure, surfaced as an error (throws, 500) |
| `src/app/api/account/student-profile/route.ts` (`POST`) | warn | routine | documented race; the loser is refused or retried (409) |
| `src/app/api/account/student-profile/route.ts` (`POST`) | error | routine | failure, surfaced as an error (throws, 500) |
| `src/app/api/account/teacher-profile/route.ts` (`POST`) | error | routine | failure, surfaced as an error (throws, 500) |
| `src/app/api/account/teacher-profile/route.ts` (`POST`) | warn | routine | documented race; the loser is refused or retried (409) |
| `src/app/api/account/teacher-profile/route.ts` (`POST`) | error | routine | failure, surfaced as an error (throws, 500) |
| `src/app/api/auth/magic-link/verify/route.ts` (`POST`) | error | routine | failure, surfaced as an error (400); reachable by an erasure racing the link |
| `src/app/api/auth/passkey/authenticate/verify/route.ts` (`POST`) | warn | routine | refusal (4xx); nothing substituted |
| `src/app/api/auth/student-signup/route.ts` (`POST`) | warn | routine | rate-limit throttle |
| `src/app/api/auth/student-signup/route.ts` (`POST`) | warn | routine | rate-limit throttle |
| `src/app/api/auth/student-signup/route.ts` (`POST`) | error | routine | failure (an exception or outage), not impossible data |
| `src/app/api/auth/teacher-signup/route.ts` (`POST`) | error | routine | failure (an exception or outage), not impossible data |
| `src/app/api/class-templates/[id]/route.ts` (`PUT`) | warn | routine | refusal (4xx); nothing substituted (room not found) |
| `src/app/api/class-templates/[id]/route.ts` (`PUT`) | warn | routine | failure, surfaced as an error (rethrown) |
| `src/app/api/class-templates/[id]/route.ts` (`PUT`) | warn | routine | documented race; the loser is refused or retried (room deleted) |
| `src/app/api/class-templates/[id]/route.ts` (`PUT`) | warn | routine | documented race; the loser is refused or retried (room archived) |
| `src/app/api/class-templates/[id]/route.ts` (`PUT`) | warn | routine | documented race; the loser is refused or retried (room reopened) |
| `src/app/api/class-templates/[id]/route.ts` (`PATCH`) | warn | routine | documented race; the loser is refused or retried (room archived) |
| `src/app/api/class-templates/route.ts` (`POST`) | warn | routine | failure, surfaced as an error (rethrown) |
| `src/app/api/class-templates/route.ts` (`POST`) | warn | routine | documented race; the loser is refused or retried (room deleted) |
| `src/app/api/class-templates/route.ts` (`POST`) | warn | routine | documented race; the loser is refused or retried (room archived) |
| `src/app/api/class-templates/route.ts` (`POST`) | warn | routine | documented race; the loser is refused or retried (room reopened) |
| `src/app/api/class-templates/route.ts` (`POST`) | warn | routine | refusal (4xx); nothing substituted (slot taken) |
| `src/app/api/classes/[id]/route.ts` (`PUT`) | error | routine | documented race; the loser is refused or retried (entry frozen mid-edit, 409) |
| `src/app/api/classes/[id]/route.ts` (`PUT`) | warn | routine | refusal (4xx); nothing substituted (slot taken) |
| `src/app/api/classes/route.ts` (`POST`) | warn | routine | documented race; the loser is refused or retried (room deleted) |
| `src/app/api/classes/route.ts` (`POST`) | warn | routine | refusal (4xx); nothing substituted (slot taken) |
| `src/app/api/health/route.ts` (`GET`) | warn | routine | refusal; nothing substituted (an `Authorization` header that is not the cron secret gets the public summary) |
| `src/app/api/health/route.ts` (`GET`) | error | routine | failure, surfaced as an error (503) |
| `src/app/api/health/route.ts` (`GET`) | error | routine | failure (an exception or outage), not impossible data; the count is omitted and `db` stays up |
| `src/app/api/invitations/[id]/resend/route.ts` (`POST`) | warn | routine | rate-limit throttle |
| `src/app/api/invitations/[id]/route.ts` (`casMatchedNothing`) | warn | routine | failure (an exception or outage), not impossible data; answered as a 409 |
| `src/app/api/payments/[id]/processor-return/route.ts` (`GET`) | error | routine | failure (an exception or outage), not impossible data; the student is sent on to the pay page and the webhook settles the attempt |
| `src/app/api/registrations/[id]/route.ts` (`notifyCancellation`) | error | routine | failure (an exception or outage), not impossible data; the cancellation itself succeeded |
| `src/app/api/registrations/[id]/route.ts` (`notifyCancellation`) | error | routine | failure (an exception or outage), not impossible data (the logger itself threw) |
| `src/app/api/registrations/[id]/route.ts` (`promoteAfterCancel`) | warn | routine | failure (an exception or outage), not impossible data |
| `src/app/api/registrations/[id]/route.ts` (`promoteAfterCancel`) | error | routine | failure (an exception or outage), not impossible data (the logger itself threw) |
| `src/app/api/registrations/route.ts` (`targetOf`) | warn | routine | rate-limit throttle |
| `src/app/api/rooms/[id]/route.ts` (`DELETE`) | warn | routine | documented race; the loser is refused or retried (FK backstop, 409) |
| `src/app/api/students/[id]/privacy/route.ts` (`GET`) | warn | routine | refusal (4xx); nothing substituted |
| `src/app/api/students/[id]/privacy/route.ts` (`PUT`) | warn | routine | refusal (4xx); nothing substituted |
| `src/app/api/students/route.ts` (`POST`) | warn | routine | rate-limit throttle |
| `src/app/api/studio-class-templates/route.ts` (`POST`) | warn | routine | refusal (4xx); nothing substituted (slot taken) |
| `src/app/api/studio-classes/[id]/route.ts` (`PUT`) | warn | routine | refusal (4xx); nothing substituted (slot taken) |
| `src/app/api/studio-classes/[id]/route.ts` (`DELETE`) | warn | routine | documented race; the loser is refused or retried (row vanished, 404) |
| `src/app/api/studio-classes/route.ts` (`POST`) | warn | routine | refusal (4xx); nothing substituted (slot taken) |
| `src/app/api/teacher-rooms/[id]/route.ts` (`DELETE`) | warn | routine | documented race; the loser is refused or retried (FK backstop, 409) |
| `src/app/api/teacher-rooms/route.ts` (`POST`) | error | routine | failure, surfaced as an error (throws, 500) |
| `src/app/api/teachers/[id]/photo/route.ts` (`POST`) | warn | routine | bad upload (400); input, not stored data |
| `src/components/settings/mollie-connection-panel.tsx` (`MollieConnectionPanel`) | error | routine | failure (an exception or outage), not impossible data; the section shows Mollie as unavailable (`readConnectionView` answers a Mollie failure itself, as `MOLLIE_UNAVAILABLE`) |
| `src/components/student/method-panel.tsx` (`ManualPanel`) | error | routine | failure (an exception or outage), not impossible data (unreachable `never` branch; a code defect, not data) |
| `src/lib/api-utils.ts` (`parseBody`) | warn | routine | refusal (4xx); nothing substituted (415, body not sent as JSON) |
| `src/lib/api-utils.ts` (`withErrorHandler`) | warn | routine | refusal (4xx); nothing substituted (403 `CROSS_ORIGIN`); a misconfigured proxy shows here, a configuration fault like `rate-limit.ts`'s unresolved IP |
| `src/lib/auth/handoff.ts` (`claimWithCode`) | warn | routine | documented race; the loser is refused or retried (concurrent handoff) |
| `src/lib/auth/handoff.ts` (`claimWithCode`) | warn | routine | rate-limit throttle (every address budget exhausted; the claim is refused) |
| `src/lib/auth/handoff.ts` (`claimWithCode`) | warn | routine | documented race; the loser is refused or retried (concurrent handoff) |
| `src/lib/auth/handoff.ts` (`claimWithCode`) | warn | routine | documented race; the loser is refused or retried (concurrent handoff) |
| `src/lib/auth/link-delivery.ts` (`deliverSignInLinkIfRegistered`) | error | routine | failure (an exception or outage), not impossible data; nothing awaits it, so the response cannot depend on it |
| `src/lib/auth/passkey.ts` (`flushPendingEvictionLog`) | warn | routine | rate-limit throttle (challenge store at capacity) |
| `src/lib/auth/passkey.ts` (`warnRefused`) | warn | routine | refusal (4xx); nothing substituted |
| `src/lib/auth/profile-authorization.ts` (`ticketAuthorization`) | warn | routine | refusal (4xx); nothing substituted (foreign ticket ignored) |
| `src/lib/auth/profile-authorization.ts` (`ticketAuthorization`) | warn | routine | documented race; the loser is refused or retried (ticket spent by a double submit or TTL) |
| `src/lib/auth/signup-ticket.ts` (`consumeSignupTicket`) | warn | routine | refusal (4xx); nothing substituted (wrong-family ticket discarded) |
| `src/lib/auth/signup-ticket.ts` (`signupTicketFor`) | error | routine | failure, surfaced as an error; see close calls |
| `src/lib/auth/signup-ticket.ts` (`signupTicketFor`) | error | routine | failure, surfaced as an error (unreachable `never` branch) |
| `src/lib/degradation.ts` (`onWriteError`) | error | routine | failure (an exception or outage), not impossible data (recording the event failed) |
| `src/lib/entry-conflict.ts` (`probeConflictingEntry`) | warn | routine | failure (an exception or outage), not impossible data (probe query failed); the 409 stands, less specific |
| `src/lib/finish-window.ts` (`formatClockInZone`) | error | routine | echo of `CLASS_START_UNREADABLE`; see close calls |
| `src/lib/log.ts` (docblock) | error | — | not a call: a usage example in the docblock |
| `src/lib/rate-limit.ts` (`flushPendingEvictionLog`) | warn | routine | rate-limit throttle (bucket evicted under memory pressure) |
| `src/lib/rate-limit.ts` (`warnUnresolvedClientIp`) | warn | routine | configuration fault, not data; see close calls |
| `src/lib/rule-slot-holder.ts` (`ruleSlotHolder`) | warn | routine | failure (an exception or outage), not impossible data (probe query failed); the 409 stands, less specific |
| `src/lib/scheduler.ts` (`isolatedSweeps`) | error | routine | operational state, reported through job health |
| `src/lib/scheduler.ts` (`startScheduler`) | warn | routine | configuration (`CRON_SCHEDULER=off`), logged at boot |
| `src/lib/scheduler.ts` (`startScheduler`) | error | routine | configuration (`OPERATOR_EMAIL` unset), logged at boot |
| `src/lib/scheduler.ts` (`startScheduler`) | warn | routine | configuration (`EMAIL_DRY_RUN=1` in production), logged at boot |
| `src/lib/scheduler.ts` (`makeTick`) | error | routine | operational state, reported through job health |
| `src/lib/scheduler.ts` (`makeTick`) | error | routine | operational state, reported through job health |
| `src/lib/timezone.ts` (`startOfLocalDay`) | error | routine | echo of `CLASS_START_UNREADABLE`; see close calls |
| `src/lib/timezone.ts` (`formatInstantInZone`) | error | routine | echo of `CLASS_START_UNREADABLE`; see close calls |
| `src/lib/timezone.ts` (`startsInPast`) | warn | routine | refusal (4xx); nothing substituted (`startsInPast` fails closed, 409) |
| `src/services/class-generator.ts` (`generateClassInstances`) | warn | routine | lock contention (`isLockTimeout`) |
| `src/services/class-generator.ts` (`generateClassInstances`) | error | routine | operational state, reported through job health |
| `src/services/class-lifecycle.ts` (`transitionClass`) | warn | routine | documented race; the loser is refused or retried (room archived mid-request) |
| `src/services/class-lifecycle.ts` (`completeClass`) | error | routine | echo of `CLASS_START_UNREADABLE`; completion is refused |
| `src/services/class-reminders.ts` (`emailReminder`) | error | routine | failure (an exception or outage), not impossible data (send refused) |
| `src/services/class-reminders.ts` (`emailReminder`) | error | routine | failure (an exception or outage), not impossible data |
| `src/services/class-reminders.ts` (`processClassReminders`) | error | routine | operational state, reported through job health |
| `src/services/class-reminders.ts` (`remindForClass`) | error | routine | echo of `CLASS_START_UNREADABLE`; see close calls |
| `src/services/class-transitions.ts` (`autoTransitionToInProgress`) | warn | routine | documented race; the loser is refused or retried (rescheduled after the snapshot) |
| `src/services/class-transitions.ts` (`autoTransitionToInProgress`) | error | routine | lock invariant broken, not data; see close calls |
| `src/services/class-transitions.ts` (`autoTransitionToInProgress`) | error | routine | operational state, reported through job health |
| `src/services/class-transitions.ts` (`autoCancelClasses`) | error | routine | operational state, reported through job health |
| `src/services/class-transitions.ts` (`autoCompleteClasses`) | warn | routine | documented race; the loser is refused or retried (rescheduled or cancelled after the snapshot) |
| `src/services/class-transitions.ts` (`autoCompleteClasses`) | error | routine | operational state, reported through job health (completion refused) |
| `src/services/class-transitions.ts` (`autoCompleteClasses`) | error | routine | operational state, reported through job health |
| `src/services/degradation-digest.ts` (`notifyOperatorOfDegradations`) | error | routine | configuration (`OPERATOR_EMAIL` unset); the job throws |
| `src/services/degradation-digest.ts` (`notifyOperatorOfDegradations`) | error | routine | failure (an exception or outage), not impossible data; the job throws |
| `src/services/email-fallback.ts` (`markOne`) | error | routine | failure (an exception or outage), not impossible data |
| `src/services/email-fallback.ts` (`claimOne`) | error | routine | failure (an exception or outage), not impossible data |
| `src/services/email-fallback.ts` (`releaseOne`) | error | routine | documented race; the loser is refused or retried (claim no longer ours) |
| `src/services/email-fallback.ts` (`releaseOne`) | error | routine | failure (an exception or outage), not impossible data |
| `src/services/email-fallback.ts` (`processEmailFallback`) | error | routine | failure (an exception or outage), not impossible data (unreachable `never` branch; a code defect, not data) |
| `src/services/email-fallback.ts` (`processEmailFallback`) | error | routine | failure (an exception or outage), not impossible data (send refused) |
| `src/services/email-fallback.ts` (`processEmailFallback`) | error | routine | failure (an exception or outage), not impossible data |
| `src/services/entry-generation.ts` (`claimRuleForGeneration`) | warn | routine | documented race; the loser is refused or retried (EvalPlanQual re-check) |
| `src/services/entry-generation.ts` (`generateEntriesForRule`) | warn | routine | echo of `CLASS_START_UNREADABLE`; see close calls |
| `src/services/entry-generation.ts` (`logSkippedEntries`) | warn | routine | skipped dates; the teacher is told why |
| `src/services/entry-generation.ts` (`probeFirstEffectiveWeek`) | warn | routine | failure (an exception or outage), not impossible data; the edit saved, the confirmation names no week |
| `src/services/entry-generation.ts` (`probeFirstEffectiveWeek`) | warn | routine | a defect in that function, not a stored value; see close calls |
| `src/services/gdpr.ts` (`deleteStudentAccount`) | error | routine | failure (an exception or outage), not impossible data (the logger itself threw) |
| `src/services/gdpr.ts` (`deleteTeacherAccount`) | warn | routine | configuration (Mollie unset); the erased teacher's grant is not revoked |
| `src/services/gdpr.ts` (`deleteTeacherAccount`) | warn | routine | documented race; the loser is refused or retried (erasure CAS) |
| `src/services/gdpr.ts` (`deleteTeacherAccount`) | error | routine | failure (an exception or outage), not impossible data (the logger itself threw) |
| `src/services/generation-contention.ts` (`recordSweepContention`) | error | routine | lock contention (`isLockTimeout`) (streak escalation) |
| `src/services/invitations.ts` (`inviteContact`) | error | routine | failure, surfaced as an error (throws, 500) |
| `src/services/invitations.ts` (`logUndeliveredTeacherInbox`) | warn | routine | documented race; the loser is refused or retried (no row matched the dispatch) |
| `src/services/invitations.ts` (`deliverInvitation`) | error | routine | failure (an exception or outage), not impossible data (delivery failed) |
| `src/services/invitations.ts` (`deliverInvitation`) | error | routine | failure (an exception or outage), not impossible data |
| `src/services/invitations.ts` (`deliverInvitation`) | error | routine | failure (an exception or outage), not impossible data |
| `src/services/mollie-deps.ts` (`mollieDeps`) | warn | routine | configuration (Mollie unset), logged once per process |
| `src/services/mollie-deps.ts` (`mollieDeps`) | error | routine | configuration (Mollie misconfigured), logged once per process |
| `src/services/notification-retention.ts` (`reapExpiredNotifications`) | error | routine | operational state, reported through job health |
| `src/services/notification-retention.ts` (`reapExpiredNotifications`) | warn | routine | operational state, reported through job health (per-run cap) |
| `src/services/notifications.ts` (`emitToBus`) | error | routine | failure (an exception or outage), not impossible data (event bus) |
| `src/services/processor-attempts.ts` (`completeRefund`) | warn | routine | the payment left `paid` before its refund completed (a teacher's own edit); nothing substituted, see close calls |
| `src/services/processor-attempts.ts` (`syncAttempt`) | warn | routine | documented race; the loser is refused or retried (a refund that cannot apply yet; the webhook is answered 503 and Mollie retries) |
| `src/services/processor-connection.ts` (`revokeDroppedGrant`) | warn | routine | refusal; nothing substituted (Mollie answered 400: it holds no grant for the token) |
| `src/services/processor-connection.ts` (`revokeDroppedGrant`) | error | routine | failure (an exception or outage), not impossible data; nothing awaits it |
| `src/services/processor-connection.ts` (`revokeDueConnection`) | warn | routine | policy (the deferral cap); the grant is revoked while Mollie may still report on it |
| `src/services/processor-connection.ts` (`revokeDueConnection`) | warn | routine | refusal; nothing substituted (Mollie answered 400: it holds no grant for the token, so the row is revoked) |
| `src/services/processor-connection.ts` (`revokeDueConnection`) | error | routine | configuration fault (Mollie refused fair.yoga's client credentials), not data; the row stays due |
| `src/services/processor-connection.ts` (`revokeDueConnection`) | warn | routine | documented race; the loser is refused or retried (work became live during the revoke; deferred) |
| `src/services/processor-connection.ts` (`revokeConnection`) | error | routine | failure (an exception or outage), not impossible data; nothing awaits it |
| `src/services/processor-refunds.ts` (`requestRefund`) | warn | routine | failure (an exception or outage), not impossible data; Mollie is then asked which refunds the payment has |
| `src/services/processor-refunds.ts` (`reconcileStale`) | error | routine | failure, surfaced as an error (`unavailable`) |
| `src/services/processor-refunds.ts` (`unheldRefund`) | error | routine | failure, surfaced as an error (`unavailable`, or `unconfirmed` beside `MOLLIE_UNAVAILABLE`); see close calls |
| `src/services/processor-revocation.ts` (`revokeDueConnections`) | error | routine | operational state, reported through job health |
| `src/services/push-dispatch.ts` (`reportUnconfigured`) | warn | routine | configuration (`VAPID_*` unset), logged once per process |
| `src/services/push-dispatch.ts` (`reportUnconfigured`) | error | routine | configuration (`VAPID_*` misconfigured), logged once per process |
| `src/services/push-dispatch.ts` (`sendTo`) | warn | routine | failure (an exception or outage), not impossible data (push service refused the send; not retried) |
| `src/services/push-dispatch.ts` (`runPushDispatch`) | error | routine | failure (an exception or outage), not impossible data (a worker crashed; the first crash is rethrown) |
| `src/services/push-dispatch.ts` (`logTaskFailures`) | error | routine | failure (an exception or outage), not impossible data (a send task threw) |
| `src/services/room-archive.ts` (`setTeacherRoomArchived`) | warn | routine | documented race; the loser is refused or retried (room back in use, 409) |
| `src/services/rule-lifecycle.ts` (`archiveOrUnarchiveRule`) | error | routine | failure, surfaced as an error (404); see close calls |
| `src/services/rule-lifecycle.ts` (`archiveOrUnarchiveRule`) | error | routine | failure, surfaced as an error (404); see close calls |
| `src/services/rule-lifecycle.ts` (`archiveOrUnarchiveRule`) | warn | routine | documented race; the loser is refused or retried (CAS miss, busy) |
| `src/services/rule-lifecycle.ts` (`archiveOrUnarchiveRule`) | warn | routine | refusal (4xx); nothing substituted (slot taken) |
| `src/services/rule-lifecycle.ts` (`archiveOrUnarchiveRule`) | error | routine | failure, surfaced as an error (rethrown) |
| `src/services/rule-lifecycle.ts` (`pauseOrResumeRule`) | error | routine | failure, surfaced as an error (404); see close calls |
| `src/services/rule-lifecycle.ts` (`pauseOrResumeRule`) | error | routine | failure, surfaced as an error (404); see close calls |
| `src/services/rule-lifecycle.ts` (`pauseOrResumeRule`) | warn | routine | documented race; the loser is refused or retried (CAS miss, busy) |
| `src/services/rule-lifecycle.ts` (`pauseOrResumeRule`) | warn | routine | a resume whose window is empty; the teacher is told |
| `src/services/rule-lifecycle.ts` (`pauseOrResumeRule`) | warn | routine | documented race; the loser is refused or retried (slot exclusion, rethrown as 409) |
| `src/services/rule-lifecycle.ts` (`pauseOrResumeRule`) | error | routine | failure, surfaced as an error (rethrown) |
| `src/services/rule-lifecycle.ts` (`updateRule`) | warn | routine | documented race; the loser is refused or retried (row vanished, 404) |
| `src/services/rule-lifecycle.ts` (`updateRule`) | warn | routine | refusal (4xx); nothing substituted (slot taken) |
| `src/services/rule-lifecycle.ts` (`updateRule`) | warn | routine | failure, surfaced as an error (rethrown) |
| `src/services/rule-lifecycle.ts` (`updateRule`) | warn | routine | documented race; the loser is refused or retried (room vanished) |
| `src/services/studio-class-generator.ts` (`generateStudioClassInstances`) | warn | routine | lock contention (`isLockTimeout`) |
| `src/services/studio-class-generator.ts` (`generateStudioClassInstances`) | error | routine | operational state, reported through job health |
| `src/services/teacher-photo.ts` (`processTeacherPhoto`) | warn | routine | bad upload (400); input, not stored data |
| `src/services/teacher-photo.ts` (`processTeacherPhoto`) | warn | routine | bad upload (400); input, not stored data |
| `src/services/timezone-audit.ts` (`auditTeacherTimezones`) | error | routine | a detector, not a substitution; see close calls |
| `src/services/waitlist-reconciliation.ts` (`report`) | error | routine | operational state, reported through job health (tick escalation) |
| `src/services/waitlist-reconciliation.ts` (`report`) | warn | routine | lock contention (`isLockTimeout`) (transient, retried next tick) |
| `src/services/waitlist-retention.ts` (`reapClosedWaitlistEntries`) | warn | routine | operational state, reported through job health (per-run cap) |
| `src/services/waitlist-retention.ts` (`report`) | error | routine | operational state, reported through job health |
| `src/services/waitlist-retention.ts` (`report`) | error | routine | operational state, reported through job health |
| `src/services/waitlist-retention.ts` (`report`) | warn | routine | operational state, reported through job health |

### Computed-level calls (`log[…](`)

Each picks its level at run time, mostly through `transientDbFailure` (`src/lib/api-errors.ts`), which is why the first pattern misses them.

| site (file, function) | level | verdict | code or reason |
|---|---|---|---|
| `src/app/api/account/route.ts` (`DELETE`) | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/app/api/account/route.ts` (`DELETE`) | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/app/api/cron/daily-cleanup/route.ts` (`settle`) | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/app/api/registrations/[id]/route.ts` (`promoteAfterCancel`) | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/app/api/registrations/route.ts` (`POST`) | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/app/api/waitlist/route.ts` (`POST`) | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/lib/api-utils.ts` (`withErrorHandler`) | dynamic | routine | `withErrorHandler`; every uncaught route error, surfaced as an error |
| `src/lib/degradation.ts` (`logDegraded`) | dynamic | — | not a site: the line `logDegraded` itself emits |
| `src/services/class-template-lifecycle.ts` (`createClassTemplate`) | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/services/gdpr.ts` (`deleteStudentAccount`) | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/services/gdpr.ts` (`deleteTeacherAccount`) | dynamic | routine | failure (an exception or outage), not impossible data (completion refused during erasure) |
| `src/services/notification-retention.ts` (`reapExpiredNotifications`) | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/services/rule-lifecycle.ts` (`archiveOrUnarchiveRule`) | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/services/rule-lifecycle.ts` (`pauseOrResumeRule`) | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/services/rule-lifecycle.ts` (`updateRule`) | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/services/studio-class-template-lifecycle.ts` (`createStudioClassTemplate`) | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/services/waitlist-reconciliation.ts` (`reconcileOne`) | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/services/waitlist-retention.ts` (`reapClosedWaitlistEntries`) | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |

## When a code arrives in the digest

Each digest entry carries the code, its registry description, first and last
seen, an approximate count, and the latest *sample* — the allowlisted context
of one occurrence. The full log line for every occurrence is in the app's
stdout (`docker compose logs app`), carrying the same `code` field, so
`grep '"code":"<CODE>"'` over the log finds each one. SQL below runs in
`psql` against the production database.

### `INCOME_TIER_OUT_OF_RANGE`

**What happened.** A stored income tier was outside 1–5. Where a per-person
claim was being made (`readIncomeTier`) the claim was withheld; where the tier
fed a shared price (`toIncomeTier`) the median was substituted.

**Where the bad value lives.** The sample's `studentId` points at
`Student.incomeTier`; a `registrationId` points at
`Registration.tierAtBooking`. `tier` is the value found.

**Confirm.**

```sql
SELECT id, "incomeTier" FROM "Student" WHERE "incomeTier" NOT BETWEEN 1 AND 5;
SELECT id, "classId", "tierAtBooking" FROM "Registration" WHERE "tierAtBooking" NOT BETWEEN 1 AND 5;
-- Both columns carry a CHECK; a row here means one was dropped or bypassed.
SELECT conname FROM pg_constraint
 WHERE conname IN ('Student_income_tier_check', 'Registration_tier_at_booking_check');
```

**Correct.** First restore whichever constraint is missing, from
`prisma/migrations/20260802150845_income_tier_range_check/migration.sql` — the
row is the symptom, the bypass is the bug. Then: a `Student` row is the
student's own choice, so ask them to pick their tier again; a `Registration.tierAtBooking` is income
history used at completion, so set it to the tier the student held when they
booked if that is known, otherwise to 3. Completion does not substitute:
`completeClass` reads the tier through `toIncomeTierOrThrow`, which throws and
rolls the completion back, so the class cannot complete until the row is
fixed. Only the price previews substituted 3.

### `TIMEZONE_INVALID_FALLBACK_UTC`

**What happened.** A teacher's stored timezone would not resolve, and a
calendar day, a time label or a class start was computed in UTC instead.
`site` names which fallback fired (`local-day`, `format`, `interpret`,
`finish-window`).

**Where the bad value lives.** `Teacher.defaultTimezone`; the sample's
`timeZone` is the value.

**Confirm.**

```sql
SELECT id, "defaultTimezone" FROM "Teacher" WHERE "defaultTimezone" = '<timeZone from the sample>';
```

`node -e "new Intl.DateTimeFormat('en', { timeZone: '<timeZone>' })"` throws for
an unresolvable zone. The daily `auditTeacherTimezones` sweep
(`src/services/timezone-audit.ts`) finds those rows and more: it checks with
`isValidTimeZone`, which also refuses offset identifiers such as `+01:00`
that `Intl` resolves, and it fails `daily-cleanup`'s health while any exist.

**Correct.** Set `defaultTimezone` to the teacher's real IANA zone (ask them;
`Europe/Amsterdam`, not an offset). Then check that teacher's classes since
`firstSeenAt`: start, auto-cancel and completion ran on UTC wall-clock time, so
a class may have been auto-cancelled or completed at the wrong hour.

### `CLASS_START_UNREADABLE`

**What happened.** `classStartInstant` was handed a date or a start time that
is not a readable `Date`, and answered an Invalid Date. Every caller acts on
that silently: the class never starts, completes or is reminded about on its
own, it sorts as past, and its times do not render. `site` says which half was
unreadable (`date` or `start-time`).

**Where the bad value lives.** Usually a stored `CalendarEntry.date`;
possibly a value built in code that never touched the database. The sample has no row id, because
`classStartInstant` is not given one.

**Confirm.** Find the row through the log first: within the same request or
sweep, the caller that tripped over the Invalid Date usually logs right after,
with ids — `class reminders: unreadable class start; skipped` (`classId`),
`… generation found no candidate dates because their start instants could not
be read` (`templateId`, `teacherId`), `refusing completion: this class schedule
is unreadable …` (`classId`). Then look at the row. A Postgres `date` can hold
values no JavaScript `Date` can — `infinity`, or a year past 275760. Both
`startTime` columns are `@db.Time`, whose every value (00:00 to 24:00) reads
back as a valid `Date`, so `date` is the only stored culprit:

```sql
SELECT id, kind, date, "startTime" FROM "CalendarEntry"
 WHERE NOT isfinite(date) OR date > '275760-09-13';
```

If no stored row is unreadable, the Invalid Date was built in code: a defect
in the caller the echo line names, and the fix is there.

**Correct.** Set the entry's `date` to the value the teacher intended. A
terminal class's schedule is frozen by `entry_frozen_schedule_guard`; changing
it then is a deliberate migration-level repair, not an `UPDATE`.

### `PAYMENT_SNAPSHOT_MISSING`

**What happened.** A completed class had a null `totalRevenue` or
`totalStudents`. `completeClass` writes both in the same statement that marks
the class completed, so the class reached `completed` some other way. The
student's past-classes row or the class's pay page rendered without its
payment breakdown.

**Where the bad value lives.** `Class.totalRevenue` / `Class.totalStudents`
for the sample's `classId` (`registrationId` is the registration whose
past-classes row or pay page showed it).

**Confirm.**

```sql
SELECT id, status, "totalRevenue", "totalStudents" FROM "Class"
 WHERE status = 'completed' AND ("totalRevenue" IS NULL OR "totalStudents" IS NULL);
SELECT p.status, p.amount FROM "Payment" p
  JOIN "Registration" r ON p."registrationId" = r.id
 WHERE r."classId" = '<classId>';
```

**Correct.** Find what completed the class outside `completeClass` (a manual
`UPDATE`, a data migration) — that is the bug. Then restore the snapshot from
the `Payment` rows the second query lists, one per charged registration:
`totalStudents` is their count, `totalRevenue` their summed `amount` (within a cent or so of what the pricing engine would
have written, since each amount was rounded). With no `Payment` rows,
completion writes `0` for both. Reporting (`/settings/reporting`) reads
`totalRevenue`, so this class's revenue was missing there until the fix.

### `ENTRY_CONFLICT_KIND_UNKNOWN`

**What happened.** A teacher's write was refused because a calendar entry
holds the slot, and that entry's `kind` is not a family this code can name.
The 409 said the time was taken without naming the class, its time or date.

**Where the bad value lives.** `CalendarEntry.kind` for the sample's
`entryId`; `kind` is the value found. `kind` is the Postgres enum
`ClassFamily`, so a value the code cannot name means the database has an enum
member the running code does not — a migration deployed ahead of (or without)
its code, or a code rollback over a newer schema.

**Confirm.**

```sql
SELECT enum_range(NULL::"ClassFamily");
SELECT id, kind, "teacherId", date, "startTime" FROM "CalendarEntry" WHERE id = '<entryId>';
```

**Correct.** Deploy the code that knows the new family, or roll the migration
back. The entry itself is not wrong; nothing in the row needs editing.

### `RULE_SLOT_KIND_UNKNOWN`

**What happened.** A teacher's recurring-class write was refused because a
schedule rule holds that weekday slot, and that rule's `kind` is not a family
this code can name. The 409 said the slot was taken without naming which kind
of class holds it. The sibling of `ENTRY_CONFLICT_KIND_UNKNOWN`, one layer up.

**Where the bad value lives.** `ScheduleRule.kind` for a live rule of the
sample's `teacherId` on its `dayOfWeek`; `kind` is the value found. Like
`CalendarEntry.kind` it is the Postgres enum `ClassFamily`, so the cause is the
same: the database has an enum member the running code does not.

**Confirm.**

```sql
SELECT enum_range(NULL::"ClassFamily");
SELECT id, kind, "startTime", "durationMinutes" FROM "ScheduleRule"
 WHERE "teacherId" = '<teacherId>' AND "dayOfWeek" = <dayOfWeek> AND "isArchived" = false;
```

**Correct.** Deploy the code that knows the new family, or roll the migration
back. The rule itself is not wrong; nothing in the row needs editing.

### `TEACHER_NOTIFICATION_TYPE_UNKNOWN`

**What happened.** The email fallback met a notification addressed to a
teacher whose `type` is not a member of `TeacherNotificationType`
(`src/services/notification-policy.ts`). It emailed it without consulting the
teacher's email preferences, rather than drop it.

**Where the bad value lives.** `Notification.type` on the sample's
`notificationId`.

**Confirm.**

```sql
SELECT id, "recipientType", "recipientId", type, title, "createdAt"
  FROM "Notification" WHERE id = '<notificationId>';
```

**Correct.** The email has gone; nothing to undo there. The defect is the
writer that created a teacher notification of that type around the type
system — find it by the `type` and `title` (`grep -rn "type: '<type>'" src`)
and route it through the typed path. The row can stay in the teacher's inbox
or be deleted.

### `PAYMENT_NOTIFICATION_WITHOUT_CLASS`

**What happened.** The email fallback rendered a student's `payment_request`
or `reminder` notification whose `relatedClassId` is null. Every writer of a
student payment notification sets it, and `Notification.relatedClassId` goes
null only when its class row is deleted (`onDelete: SetNull`). The email went
out without a Pay now button, whatever the teacher's payment methods.

**Where the bad value lives.** `Notification.relatedClassId` on the sample's
`notificationId`. If the class was deleted, its registrations and payments
went with it (both cascade), so the student was asked to pay for a payment
that no longer exists.

**Confirm.**

```sql
SELECT id, "recipientId", type, title, body, "createdAt"
  FROM "Notification" WHERE id = '<notificationId>';
SELECT id, type, "createdAt" FROM "Notification"
 WHERE "recipientType" = 'student' AND type IN ('payment_request', 'reminder')
   AND "relatedClassId" IS NULL;
```

**Correct.** The body names the class type, day and time; look for that class
among the student's registrations. If it still exists, set `relatedClassId`
to its id. If it is gone, what deleted it is the bug — no code path deletes a
class with payments — and the student needs telling that the request no
longer stands.

### `DONATION_INVITATION_WITHOUT_CLASS`

**What happened.** The email fallback rendered a student's `donation_invitation`
notification whose `relatedClassId` is null. Every writer of one sets it, and
`Notification.relatedClassId` goes null only when its class row is deleted
(`onDelete: SetNull`). The email went out without a How to give button.

**Where the bad value lives.** `Notification.relatedClassId` on the sample's
`notificationId`. The invitation names a class that no longer exists, so
there is no give page to send the student to.

**Confirm.**

```sql
SELECT id, "recipientId", type, title, body, "createdAt"
  FROM "Notification" WHERE id = '<notificationId>';
SELECT id, "createdAt" FROM "Notification"
 WHERE "recipientType" = 'student' AND type = 'donation_invitation'
   AND "relatedClassId" IS NULL;
```

**Correct.** The body names the class type; the student's registrations show
which class it was. If the class still exists, set `relatedClassId` to its
id. If it is gone, what deleted it is the bug, and the invitation has
nothing left to point at; the row can be deleted.

### `PAYMENT_PAID_WITHOUT_TIMESTAMP`

**What happened.** The student pay page met a `paid` payment whose `paidAt` is
null. `markPaymentPaid` writes the status and the timestamp in one statement,
so the row reached `paid` some other way. The page said "Marked paid." without
saying when.

**Where the bad value lives.** `Payment.paidAt` on the sample's `paymentId`.

**Confirm.**

```sql
SELECT id, "registrationId", status, method, "paidAt", "updatedAt"
  FROM "Payment" WHERE status = 'paid' AND "paidAt" IS NULL;
```

**Correct.** Find what marked the payment paid outside `markPaymentPaid` (a
manual `UPDATE`, a data migration) — that is the bug. Then ask the teacher when
they received it and set `paidAt`; `updatedAt` is an upper bound if they do not
know.

### `CHARGED_REGISTRATION_WITHOUT_PAYMENT`

**What happened.** The student pay page met a registration in a charged status
(`CHARGED_STATUSES`, `src/lib/registration-status.ts`) on a completed class,
with no `Payment` row. `completeClass` creates one for every charged
registration in the transaction that completes the class, so either the
payment was deleted or the registration became charged after completion. The
page answered not found, as it does for a registration with nothing to pay.

**Where the bad value lives.** The `Payment` that should exist for the
sample's `registrationId`, on the class `classId`.

**Confirm.**

```sql
SELECT r.id, r.status, r."updatedAt", c.status AS class_status, c."totalStudents"
  FROM "Registration" r JOIN "Class" c ON c.id = r."classId"
 WHERE c.status = 'completed'
   AND r.status IN ('registered', 'attended', 'no_show', 'late_cancel')
   AND NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."registrationId" = r.id);
SELECT r.id, r.status, p.amount FROM "Registration" r
  LEFT JOIN "Payment" p ON p."registrationId" = r.id
 WHERE r."classId" = '<classId>';
```

**Correct.** Find what removed the payment or changed the registration after
completion — that is the bug. Restore the payment from the registration's
`price`, which completion wrote alongside it; if `price` is null too, the
registration was not charged at completion, so set its status back to what
the teacher recorded and leave it unpaid. Compare the class's `totalStudents`
with its charged registrations: a mismatch means the snapshot no longer
matches the room.

### `MOLLIE_UNAVAILABLE`

**What happened.** A call to Mollie failed or came back in a shape the client
does not accept (`MollieUnavailable`, `src/lib/mollie/client.ts`). The student
pay page showed the teacher's other payment rows without the Mollie ones, a
student's payment could not be started (`createPayment`), a Mollie webhook was
answered 503 so Mollie retries it (`getPayment`), a grant could not be revoked
(`revoke`), a teacher connecting or choosing a profile was told Mollie could
not be reached (`exchangeCode`, `organization`, `profiles`; no `connectionId`
before a connection exists), the settings section showed Mollie as
unreachable (`organization`, `profiles`, once per render), or a refund
request failed (`createRefund`). `operation` is the client method that failed
and `status` the HTTP status, when there was one.

A `createRefund` sample without a `status` whose message says Mollie *did not
confirm* the refund is the worst of these: `createRefund` and the follow-up
`getPayment` both failed, so the refund may exist at Mollie. Its intent row
(a `ProcessorRefund` with no `processorRefundId`) is kept; a webhook adopts
the refund if Mollie made it, and the attempt's next refund request reconciles
it once it is two minutes old. The teacher was told not to refund in Mollie
meanwhile.

A failed `revoke` comes from one of two places in
`src/services/processor-connection.ts`. `revokeDueConnection` leaves its
disconnected row unrevoked, `revokedAt` still null, so a later revoke of that
row can try again. Once its disconnect is more than 30 days old it stops
retrying: the tokens are nulled and `revokedAt` stamped although the grant
may stay authorized at Mollie. It does not record a 400 here: Mollie then
holds no grant for the token, so the row is revoked and the revoke logged at
warn. Nor a 401 or 403, which is fair.yoga's own client credentials failing:
that is logged at error and the row stays due, whatever its age. A grant the OAuth callback dropped is a grant no row holds:
one it exchanged and then did not store (Mollie failed reading the
organization or profiles, or the teacher was erased meanwhile; no
`connectionId`), or the one a reconnect replaced (`connectionId` is the row
that now holds the new grant). Nothing retries those; the authorization stays
live at Mollie until the merchant removes it or a forced consent replaces it.

**Where the bad value lives.** Not in our data. The cause is Mollie being down
or rate-limiting, a revoked or expired grant for `connectionId`, or Mollie
changing a response shape the client validates.

**Confirm.**

```sql
SELECT id, "teacherId", testmode, "connectedAt", "disconnectedAt",
       "revokeAfter", "revokedAt"
  FROM "ProcessorConnection" WHERE id = '<connectionId>';
```

Then check Mollie's status page, and whether the samples cluster on one
`connectionId` (that teacher's grant) or spread across connections (Mollie).

**Correct.** A spread across connections needs nothing: the pay page recovers
on the next request, because an unavailable answer is not cached, and Mollie
retries webhooks. A single connection that keeps failing with 401 or 403 has a
revoked grant (`revokedAt` or `disconnectedAt` set); the teacher reconnects
Mollie in settings. A repeating `status` of 422 or an unexpected shape means Mollie changed its API: fix the
client, since the pay page will keep hiding Mollie until it does. A failed
`revoke` of a grant the callback dropped needs nothing from us when Mollie
was merely down; if it keeps happening, the teacher can revoke fair.yoga's
access from their Mollie dashboard.

### `PROCESSOR_DISCONNECTED`

**What happened.** Mollie answered `invalid_grant` to the refresh token stored
for `connectionId` (`getAccessToken`, `src/services/processor-token.ts`). The
connection was revoked in the same transaction: both tokens nulled, `revokedAt`
set. Only when the connection was not already disconnected, the teacher got
a `processor_disconnected` notification, and, when it had a live payout
identity (a profile chosen), a `processor_disconnected` `PayoutChangeEvent`
was written, so a resume after a pause shows why Mollie left the payout
details. Students see the teacher's other
payment options until the teacher reconnects.

**Where the bad value lives.** Mollie's side: the teacher revoked this app's
access in their Mollie dashboard, or Mollie revoked the grant.

**Confirm.**

```sql
SELECT id, "teacherId", "connectedAt", "disconnectedAt", "revokeAfter", "revokedAt"
  FROM "ProcessorConnection" WHERE id = '<connectionId>';
```

A single sample is that teacher having revoked access. A cluster across many
connections in a short window means the app was revoked or removed in Mollie's
dashboard, or Mollie revoked grants. Wrong client credentials do not land here:
Mollie answers them `invalid_client`, which the adapter reports as
`MOLLIE_UNAVAILABLE`.

**Correct.** Nothing for a single teacher: they reconnect Mollie in Settings →
Profile. For a cluster, check the app in Mollie's dashboard; the affected
teachers reconnect once it is restored.

### `PROCESSOR_PAYMENT_UNCONFIRMED`

**What happened.** `syncAttempt` (`src/services/processor-attempts.ts`) was
asked about a Mollie payment fair.yoga holds as an attempt (`attemptId`,
Mollie's id `processorPaymentId`) and could not read or apply it. It answered
`unknown`, so the webhook was answered 200 and Mollie does not retry it, and
nothing was written. `reason` says why:

- `teacher_erased` — the attempt has no connection: erasure deleted the
  teacher's `ProcessorConnection`, so no token is left to ask Mollie with.
- `connection_revoked` — the connection's grant is revoked, so no token.
- `mollie_unknown` — Mollie answered 404 for a payment fair.yoga holds.
- `status_unknown` — Mollie reported a status (`mollieStatus`) that
  `ProcessorPaymentStatus` does not name.
- `row_gone` — the attempt or its payment was deleted between the sync's
  first read and its lock on the payment.

A Mollie id that no attempt holds is not fair.yoga's and is not logged.

**Where the bad value lives.** Not in our data for the first two: the
payment's money, if the student paid, went to the teacher's Mollie account and
fair.yoga cannot see it. For `mollie_unknown`, the attempt row points at a
payment Mollie no longer has (another mode or organization, or Mollie
removed it). For `status_unknown`, Mollie changed its API. For `row_gone`,
an erasure or a deletion of the payment ran during the sync.

**Confirm.**

```sql
SELECT a.id, a."paymentId", a."connectionId", a.testmode, a.status, a."processorPaymentId",
       p.status AS payment_status
  FROM "ProcessorPayment" a JOIN "Payment" p ON p.id = a."paymentId"
 WHERE a.id = '<attemptId>';
```

**Correct.** For `connection_revoked` or `mollie_unknown`, the teacher checks
the payment in their Mollie dashboard and marks the payment paid by hand if
the money arrived. For `teacher_erased`, nothing in fair.yoga can be
corrected: the erased teacher's Mollie account holds the money. A repeating
`status_unknown` means the client's status list needs the new value. For
`row_gone`, the confirm query finds no row; Mollie's next webhook for the
payment answers `unknown` silently, as for any id no attempt holds.

### `PROCESSOR_REFUND_UNRECORDED`

**What happened.** A refund Mollie reported (`processorRefundId`, on the
attempt `attemptId`) was not recorded as Mollie reported it. `reason` says
how:

- `store_failed` — `storeAnswer` (`src/services/processor-refunds.ts`) could
  not write Mollie's answer to a refund request (the error is in the log
  line). The intent row (`refundId`) is kept with no Mollie id, the teacher
  was answered 503 ("Mollie accepted the refund"), and nothing was applied.
- `intent_gone` — `storeAnswer` found the intent row deleted when it came to
  store Mollie's answer. The teacher was answered as if the refund were
  requested; nothing was applied and no row holds the refund.
- `status_unknown` — Mollie gave a refund a status (`mollieStatus`) that
  `ProcessorRefundStatus` does not name. `storeAnswer` recorded it as
  `queued`; `syncAttempt` (`src/services/processor-attempts.ts`) skipped
  that refund and left its row as it was.

**Where the bad value lives.** For `store_failed`, nowhere yet: the database
refused the write. For `intent_gone`, the intent row was deleted while
Mollie was being called. For `status_unknown`, Mollie changed its API.

**Confirm.**

```sql
SELECT r.id, r."processorRefundId", r.status, r.outcome, r."requestedAt",
       a."processorPaymentId", a."settledPayment", p.status AS payment_status
  FROM "ProcessorRefund" r
  JOIN "ProcessorPayment" a ON a.id = r."attemptId"
  JOIN "Payment" p ON p.id = a."paymentId"
 WHERE r."attemptId" = '<attemptId>';
```

**Correct.** For `store_failed`, nothing once a webhook has arrived: the sync
adopts the refund into the kept intent once it is two minutes old (a row
whose `processorRefundId` is now set shows it did). For `intent_gone`, the
refund is held by no row, so a sync treats it as one made in Mollie's
dashboard: a full refund releases the attempt and the teacher can mark the
payment unpaid, but its waive or ask-again outcome is never applied; the
teacher settles the payment by hand. A repeating `status_unknown` means the
client's refund status list needs the new value.

### `PROCESSOR_CHARGEBACK_CURRENCY_MISMATCH`

**What happened.** `syncAttempt` (`src/services/processor-attempts.ts`, in
`chargedBackLine`) read a chargeback on the attempt `attemptId` in
`chargedBackCurrency`, not the attempt's `currency`. The chargeback was
recorded as usual, and the teacher's "Payment disputed" notice named the
attempt's whole amount instead of the amount taken back.

**Where the bad value lives.** Mollie's answer: Mollie charges back in the
payment's own currency, so this is an API change or a defect at Mollie.

**Confirm.**

```sql
SELECT id, "paymentId", amount, currency, "chargedBackAt", "processorPaymentId"
  FROM "ProcessorPayment" WHERE id = '<attemptId>';
```

Then look the payment up in the teacher's Mollie dashboard for the amount
actually charged back.

**Correct.** Nothing in the data: the chargeback is recorded correctly. If
the amount differs, tell the teacher the real figure. Repeated samples mean
the client's handling of `amountChargedBack` needs revisiting.

### `PROCESSOR_TOKEN_UNREADABLE`

**What happened.** A sealed Mollie token for `connectionId` failed to open
(`TokenCipherError`, `src/lib/processor-token-cipher.ts`). `getAccessToken`
answered `unavailable` and left the connection as it was: the pay page hid
Mollie's rows and webhooks were answered 503 to be retried.

**Where the bad value lives.** In `ProcessorConnection.accessToken` or
`refreshToken` for that row, or in the `PROCESSOR_TOKEN_KEY` environment
variable: the key differs from the one the row was sealed with, or the bytes
were damaged.

**Confirm.**

```sql
SELECT id, "teacherId", length("accessToken") AS access_len,
       length("refreshToken") AS refresh_len, "accessTokenExpiresAt", "connectedAt"
  FROM "ProcessorConnection" WHERE id = '<connectionId>';
```

Samples across every connection mean the key is wrong. A sample for one
connection means that row is damaged.

**Correct.** For a wrong key, restore the key the rows were sealed with and
restart; nothing in the database changes. For one damaged row, run the
statement below, then the teacher reconnects Mollie in Settings → Profile.

```sql
UPDATE "ProcessorConnection"
   SET "accessToken" = NULL, "refreshToken" = NULL, "accessTokenExpiresAt" = NULL,
       "disconnectedAt" = COALESCE("disconnectedAt", now()),
       "revokeAfter" = NULL, "revokedAt" = now()
 WHERE id = '<connectionId>';
```

### `DATABASE_POOL_EXHAUSTED`

**What happened.** A database query waited the pool's full
`connectionTimeoutMs` for a connection and failed. A request answered the busy
503 (`withErrorHandler`) or a page rendered its error page; a sweep may have
failed the same way, and then its own error is in job health. The pool's own hook
(`onPoolExhausted`, wired in `src/lib/db.ts`) reports it, so every caller is
covered, page renders included. Since the record is written through the same
pool, it can itself time out: then the log line is all there is, and that
write's timeout counts once more in the next window.

**The sample.** The pool's counters as the timeout was delivered:

- `waiting` — callers still queued for a connection. It does not count the
  waiter that timed out, so `0` means that waiter was the only one.
- `total` — connections open, idle or busy.
- `idle` — connections open and free.
- `max` — the pool's bound (`poolMax`).

**Health.** `/api/health` reads `status: "degraded"` for 15 minutes after this
process last saw an exhaustion (`POOL_EXHAUSTION_HEALTH_WINDOW_MS`,
`src/lib/pool-exhaustion.ts`), so an exhaustion between two monitor checks
still alerts. A restart clears that; this row does not.

**Confirm.** The log has every occurrence with its counters
(`grep '"code":"DATABASE_POOL_EXHAUSTED"'`), next to the request or sweep that
failed. While it is happening, look at what holds the connections:

```sql
SELECT pid, application_name, state, now() - xact_start AS in_xact,
       now() - query_start AS in_query, left(query, 120) AS query
  FROM pg_stat_activity
 WHERE datname = current_database() AND pid <> pg_backend_pid()
 ORDER BY xact_start NULLS LAST;
```

Look for sessions `idle in transaction` (a transaction left open while the code
awaited something else), long-running queries, and a sweep's burst: several
sessions from one tick, at the time a sweep ran (`/api/health`'s detailed
body, with the cron secret, has each job's last run).

**Correct.** Fix the holder, not the timeout: shorten the long transaction,
move the awaited work out of it, or make the sweep claim in smaller batches.
If the pool is simply too small for the load, `poolMax` and its default are in
`docs/technical-architecture.md` ("Where Prisma comes from"). If this code
keeps arriving and the samples point at sweeps, that is the trigger for the
scheduler-only pool #937 set aside
(`docs/superpowers/specs/2026-10-29-process-singletons-design.md`, Decision 4).
