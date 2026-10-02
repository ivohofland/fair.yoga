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

Two further readings this audit applied, stated so they can be argued with:

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

Measured on the commit that added this file:

| command | count |
|---|---|
| `log.warn(` lines | 78 |
| `log.error(` lines | 67 |
| surface (`log.warn(` or `log.error(`) | **78 + 67 = 145** |
| split `.warn(` / `.error(` continuation lines | 0 |
| `log[…](` lines | 17 |
| `logDegraded(` call lines | 10 |

One of the 145 is not a call: `src/lib/log.ts:5` is a usage example inside
that file's docblock. One of the 17 is not a site: `src/lib/degradation.ts:71`
is the line `logDegraded` itself emits. So 144 static calls and 16
computed-level calls were classified, beside the 10 `logDegraded` calls.

Line numbers below are as of that commit and drift with every edit; the
commands are the source of truth. A new `log.warn(` or `log.error(` raises the
first count and appears in the first command's output without a row here —
that row is what the next audit owes.

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

## Classification

### Degradations

Every `logDegraded` call. The level is the code's, from the registry.

| site (file:line) | level | verdict | code or reason |
|---|---|---|---|
| `src/lib/entry-conflict.ts:282` | error | degradation | `ENTRY_CONFLICT_KIND_UNKNOWN` |
| `src/lib/finish-window.ts:61` | error | degradation | `TIMEZONE_INVALID_FALLBACK_UTC` |
| `src/lib/payment-breakdown.server.ts:24` | warn | degradation | `PAYMENT_SNAPSHOT_MISSING` |
| `src/lib/tiers.server.ts:43` | warn | degradation | `INCOME_TIER_OUT_OF_RANGE` |
| `src/lib/timezone.ts:114` | error | degradation | `TIMEZONE_INVALID_FALLBACK_UTC` |
| `src/lib/timezone.ts:227` | error | degradation | `TIMEZONE_INVALID_FALLBACK_UTC` |
| `src/lib/timezone.ts:308` | warn | degradation | `CLASS_START_UNREADABLE` |
| `src/lib/timezone.ts:316` | warn | degradation | `CLASS_START_UNREADABLE` |
| `src/lib/timezone.ts:330` | error | degradation | `TIMEZONE_INVALID_FALLBACK_UTC` |
| `src/services/email-fallback.ts:221` | error | degradation | `TEACHER_NOTIFICATION_TYPE_UNKNOWN` |

### The `log.warn(` / `log.error(` surface

| site (file:line) | level | verdict | code or reason |
|---|---|---|---|
| `src/app/(public)/[slug]/page.tsx:101` | warn | routine | documented race (hard delete vs session); the page falls back to its signed-out view |
| `src/app/(student)/bookings/page.tsx:165` | warn | routine | documented race (hard delete vs session); redirects |
| `src/app/api/account/route.ts:141` | error | routine | failure, surfaced as an error (answered busy) |
| `src/app/api/account/student-profile/route.ts:172` | error | routine | failure, surfaced as an error (throws, 500) |
| `src/app/api/account/student-profile/route.ts:184` | warn | routine | documented race; the loser is refused or retried (409) |
| `src/app/api/account/student-profile/route.ts:201` | error | routine | failure, surfaced as an error (throws, 500) |
| `src/app/api/account/teacher-profile/route.ts:150` | error | routine | failure, surfaced as an error (throws, 500) |
| `src/app/api/account/teacher-profile/route.ts:172` | warn | routine | documented race; the loser is refused or retried (409) |
| `src/app/api/account/teacher-profile/route.ts:188` | error | routine | failure, surfaced as an error (throws, 500) |
| `src/app/api/auth/magic-link/send/route.ts:60` | error | routine | failure (an exception or outage), not impossible data; the uniform 200 is the enumeration guard |
| `src/app/api/auth/magic-link/verify/route.ts:92` | error | routine | failure, surfaced as an error (400); reachable by an erasure racing the link |
| `src/app/api/auth/passkey/authenticate/verify/route.ts:36` | warn | routine | refusal (4xx); nothing substituted |
| `src/app/api/auth/student-signup/route.ts:25` | warn | routine | rate-limit throttle |
| `src/app/api/auth/student-signup/route.ts:34` | warn | routine | rate-limit throttle |
| `src/app/api/auth/student-signup/route.ts:69` | error | routine | failure (an exception or outage), not impossible data |
| `src/app/api/auth/teacher-signup/route.ts:54` | error | routine | failure (an exception or outage), not impossible data |
| `src/app/api/class-templates/[id]/route.ts:190` | warn | routine | refusal (4xx); nothing substituted (room not found) |
| `src/app/api/class-templates/[id]/route.ts:241` | warn | routine | failure, surfaced as an error (rethrown) |
| `src/app/api/class-templates/[id]/route.ts:255` | warn | routine | documented race; the loser is refused or retried (room deleted) |
| `src/app/api/class-templates/[id]/route.ts:267` | warn | routine | documented race; the loser is refused or retried (room archived) |
| `src/app/api/class-templates/[id]/route.ts:278` | warn | routine | documented race; the loser is refused or retried (room reopened) |
| `src/app/api/class-templates/[id]/route.ts:470` | warn | routine | documented race; the loser is refused or retried (room archived) |
| `src/app/api/class-templates/route.ts:137` | warn | routine | failure, surfaced as an error (rethrown) |
| `src/app/api/class-templates/route.ts:144` | warn | routine | documented race; the loser is refused or retried (room deleted) |
| `src/app/api/class-templates/route.ts:151` | warn | routine | documented race; the loser is refused or retried (room archived) |
| `src/app/api/class-templates/route.ts:157` | warn | routine | documented race; the loser is refused or retried (room reopened) |
| `src/app/api/class-templates/route.ts:167` | warn | routine | refusal (4xx); nothing substituted (slot taken) |
| `src/app/api/classes/[id]/route.ts:157` | error | routine | documented race; the loser is refused or retried (entry frozen mid-edit, 409) |
| `src/app/api/classes/[id]/route.ts:198` | warn | routine | refusal (4xx); nothing substituted (slot taken) |
| `src/app/api/classes/route.ts:189` | warn | routine | documented race; the loser is refused or retried (room deleted) |
| `src/app/api/classes/route.ts:208` | warn | routine | refusal (4xx); nothing substituted (slot taken) |
| `src/app/api/health/route.ts:48` | error | routine | failure, surfaced as an error (503) |
| `src/app/api/invitations/[id]/resend/route.ts:68` | warn | routine | rate-limit throttle |
| `src/app/api/invitations/[id]/route.ts:97` | warn | routine | failure (an exception or outage), not impossible data; answered as a 409 |
| `src/app/api/registrations/[id]/route.ts:500` | error | routine | failure (an exception or outage), not impossible data; the cancellation itself succeeded |
| `src/app/api/registrations/[id]/route.ts:505` | error | routine | failure (an exception or outage), not impossible data (the logger itself threw) |
| `src/app/api/registrations/[id]/route.ts:581` | warn | routine | failure (an exception or outage), not impossible data |
| `src/app/api/registrations/[id]/route.ts:603` | error | routine | failure (an exception or outage), not impossible data (the logger itself threw) |
| `src/app/api/registrations/route.ts:147` | warn | routine | rate-limit throttle |
| `src/app/api/rooms/[id]/route.ts:108` | warn | routine | documented race; the loser is refused or retried (FK backstop, 409) |
| `src/app/api/students/[id]/privacy/route.ts:63` | warn | routine | refusal (4xx); nothing substituted |
| `src/app/api/students/[id]/privacy/route.ts:110` | warn | routine | refusal (4xx); nothing substituted |
| `src/app/api/students/route.ts:88` | warn | routine | rate-limit throttle |
| `src/app/api/studio-class-templates/route.ts:72` | warn | routine | refusal (4xx); nothing substituted (slot taken) |
| `src/app/api/studio-classes/[id]/route.ts:287` | warn | routine | refusal (4xx); nothing substituted (slot taken) |
| `src/app/api/studio-classes/[id]/route.ts:392` | warn | routine | documented race; the loser is refused or retried (row vanished, 404) |
| `src/app/api/studio-classes/route.ts:125` | warn | routine | refusal (4xx); nothing substituted (slot taken) |
| `src/app/api/teacher-rooms/[id]/route.ts:200` | warn | routine | documented race; the loser is refused or retried (FK backstop, 409) |
| `src/app/api/teacher-rooms/route.ts:133` | error | routine | failure, surfaced as an error (throws, 500) |
| `src/app/api/teachers/[id]/photo/route.ts:39` | warn | routine | bad upload (400); input, not stored data |
| `src/lib/auth/handoff.ts:154` | warn | routine | documented race; the loser is refused or retried (concurrent handoff) |
| `src/lib/auth/handoff.ts:185` | warn | routine | documented race; the loser is refused or retried (concurrent handoff) |
| `src/lib/auth/handoff.ts:195` | warn | routine | documented race; the loser is refused or retried (concurrent handoff) |
| `src/lib/auth/passkey.ts:80` | warn | routine | rate-limit throttle (challenge store at capacity) |
| `src/lib/auth/passkey.ts:256` | warn | routine | refusal (4xx); nothing substituted |
| `src/lib/auth/profile-authorization.ts:110` | warn | routine | refusal (4xx); nothing substituted (foreign ticket ignored) |
| `src/lib/auth/profile-authorization.ts:127` | warn | routine | documented race; the loser is refused or retried (ticket spent by a double submit or TTL) |
| `src/lib/auth/signup-ticket.ts:79` | warn | routine | refusal (4xx); nothing substituted (wrong-family ticket discarded) |
| `src/lib/auth/signup-ticket.ts:183` | error | routine | failure, surfaced as an error; see close calls |
| `src/lib/auth/signup-ticket.ts:194` | error | routine | failure, surfaced as an error (unreachable `never` branch) |
| `src/lib/degradation.ts:51` | error | routine | failure (an exception or outage), not impossible data (recording the event failed) |
| `src/lib/entry-conflict.ts:301` | warn | routine | failure (an exception or outage), not impossible data (probe query failed); the 409 stands, less specific |
| `src/lib/finish-window.ts:48` | error | routine | echo of `CLASS_START_UNREADABLE`; see close calls |
| `src/lib/log.ts:5` | error | — | not a call: a usage example in the docblock |
| `src/lib/rate-limit.ts:123` | warn | routine | rate-limit throttle (bucket evicted under memory pressure) |
| `src/lib/rate-limit.ts:256` | warn | routine | configuration fault, not data; see close calls |
| `src/lib/rule-slot-holder.ts:131` | warn | routine | failure (an exception or outage), not impossible data (probe query failed); the 409 stands, less specific |
| `src/lib/scheduler.ts:79` | error | routine | operational state, reported through job health |
| `src/lib/scheduler.ts:132` | warn | routine | configuration (`CRON_SCHEDULER=off`), logged at boot |
| `src/lib/scheduler.ts:141` | error | routine | configuration (`OPERATOR_EMAIL` unset), logged at boot |
| `src/lib/scheduler.ts:243` | error | routine | operational state, reported through job health |
| `src/lib/scheduler.ts:257` | error | routine | operational state, reported through job health |
| `src/lib/timezone.ts:95` | error | routine | echo of `CLASS_START_UNREADABLE`; see close calls |
| `src/lib/timezone.ts:202` | error | routine | echo of `CLASS_START_UNREADABLE`; see close calls |
| `src/lib/timezone.ts:412` | warn | routine | refusal (4xx); nothing substituted (`startsInPast` fails closed, 409) |
| `src/services/class-generator.ts:259` | warn | routine | lock contention (`isLockTimeout`) |
| `src/services/class-generator.ts:265` | error | routine | operational state, reported through job health |
| `src/services/class-lifecycle.ts:582` | warn | routine | documented race; the loser is refused or retried (room archived mid-request) |
| `src/services/class-lifecycle.ts:782` | error | routine | echo of `CLASS_START_UNREADABLE`; completion is refused |
| `src/services/class-reminders.ts:109` | error | routine | failure (an exception or outage), not impossible data (send refused) |
| `src/services/class-reminders.ts:113` | error | routine | failure (an exception or outage), not impossible data |
| `src/services/class-reminders.ts:131` | error | routine | operational state, reported through job health |
| `src/services/class-reminders.ts:158` | error | routine | echo of `CLASS_START_UNREADABLE`; see close calls |
| `src/services/class-transitions.ts:222` | warn | routine | documented race; the loser is refused or retried (rescheduled after the snapshot) |
| `src/services/class-transitions.ts:245` | error | routine | lock invariant broken, not data; see close calls |
| `src/services/class-transitions.ts:258` | error | routine | operational state, reported through job health |
| `src/services/class-transitions.ts:650` | error | routine | operational state, reported through job health |
| `src/services/class-transitions.ts:744` | warn | routine | documented race; the loser is refused or retried (rescheduled or cancelled after the snapshot) |
| `src/services/class-transitions.ts:746` | error | routine | operational state, reported through job health (completion refused) |
| `src/services/class-transitions.ts:750` | error | routine | operational state, reported through job health |
| `src/services/degradation-digest.ts:57` | error | routine | configuration (`OPERATOR_EMAIL` unset); the job throws |
| `src/services/degradation-digest.ts:108` | error | routine | failure (an exception or outage), not impossible data; the job throws |
| `src/services/email-fallback.ts:80` | error | routine | failure (an exception or outage), not impossible data |
| `src/services/email-fallback.ts:99` | error | routine | failure (an exception or outage), not impossible data |
| `src/services/email-fallback.ts:134` | error | routine | documented race; the loser is refused or retried (claim no longer ours) |
| `src/services/email-fallback.ts:141` | error | routine | failure (an exception or outage), not impossible data |
| `src/services/email-fallback.ts:303` | error | routine | failure (an exception or outage), not impossible data (unreachable `never` branch; a code defect, not data) |
| `src/services/email-fallback.ts:327` | error | routine | failure (an exception or outage), not impossible data (send refused) |
| `src/services/email-fallback.ts:334` | error | routine | failure (an exception or outage), not impossible data |
| `src/services/entry-generation.ts:453` | warn | routine | documented race; the loser is refused or retried (EvalPlanQual re-check) |
| `src/services/entry-generation.ts:591` | warn | routine | echo of `CLASS_START_UNREADABLE`; see close calls |
| `src/services/entry-generation.ts:927` | warn | routine | skipped dates; the teacher is told why |
| `src/services/entry-generation.ts:1153` | warn | routine | failure (an exception or outage), not impossible data; the edit saved, the confirmation names no week |
| `src/services/entry-generation.ts:1208` | warn | routine | a defect in that function, not a stored value; see close calls |
| `src/services/gdpr.ts:1027` | error | routine | failure (an exception or outage), not impossible data (the logger itself threw) |
| `src/services/gdpr.ts:1658` | warn | routine | documented race; the loser is refused or retried (erasure CAS) |
| `src/services/gdpr.ts:1681` | error | routine | failure (an exception or outage), not impossible data (the logger itself threw) |
| `src/services/generation-contention.ts:82` | error | routine | lock contention (`isLockTimeout`) (streak escalation) |
| `src/services/invitations.ts:418` | error | routine | failure, surfaced as an error (throws, 500) |
| `src/services/invitations.ts:527` | warn | routine | documented race; the loser is refused or retried (no row matched the dispatch) |
| `src/services/invitations.ts:939` | error | routine | failure (an exception or outage), not impossible data (delivery failed) |
| `src/services/invitations.ts:990` | error | routine | failure (an exception or outage), not impossible data |
| `src/services/invitations.ts:1021` | error | routine | failure (an exception or outage), not impossible data |
| `src/services/notification-retention.ts:105` | warn | routine | lock contention (`isLockTimeout`) |
| `src/services/notification-retention.ts:107` | error | routine | operational state, reported through job health |
| `src/services/notification-retention.ts:120` | error | routine | operational state, reported through job health |
| `src/services/notification-retention.ts:122` | warn | routine | operational state, reported through job health (per-run cap) |
| `src/services/notifications.ts:83` | error | routine | failure (an exception or outage), not impossible data (event bus) |
| `src/services/room-archive.ts:277` | warn | routine | documented race; the loser is refused or retried (room back in use, 409) |
| `src/services/rule-lifecycle.ts:518` | error | routine | failure, surfaced as an error (404); see close calls |
| `src/services/rule-lifecycle.ts:623` | error | routine | failure, surfaced as an error (404); see close calls |
| `src/services/rule-lifecycle.ts:661` | warn | routine | documented race; the loser is refused or retried (CAS miss, busy) |
| `src/services/rule-lifecycle.ts:894` | warn | routine | refusal (4xx); nothing substituted (slot taken) |
| `src/services/rule-lifecycle.ts:904` | error | routine | failure, surfaced as an error (rethrown) |
| `src/services/rule-lifecycle.ts:1173` | error | routine | failure, surfaced as an error (404); see close calls |
| `src/services/rule-lifecycle.ts:1228` | error | routine | failure, surfaced as an error (404); see close calls |
| `src/services/rule-lifecycle.ts:1272` | warn | routine | documented race; the loser is refused or retried (CAS miss, busy) |
| `src/services/rule-lifecycle.ts:1401` | warn | routine | a resume whose window is empty; the teacher is told |
| `src/services/rule-lifecycle.ts:1449` | warn | routine | documented race; the loser is refused or retried (slot exclusion, rethrown as 409) |
| `src/services/rule-lifecycle.ts:1460` | error | routine | failure, surfaced as an error (rethrown) |
| `src/services/rule-lifecycle.ts:1743` | warn | routine | documented race; the loser is refused or retried (row vanished, 404) |
| `src/services/rule-lifecycle.ts:1763` | warn | routine | refusal (4xx); nothing substituted (slot taken) |
| `src/services/rule-lifecycle.ts:1783` | warn | routine | failure, surfaced as an error (rethrown) |
| `src/services/rule-lifecycle.ts:1790` | warn | routine | documented race; the loser is refused or retried (room vanished) |
| `src/services/studio-class-generator.ts:232` | warn | routine | lock contention (`isLockTimeout`) |
| `src/services/studio-class-generator.ts:238` | error | routine | operational state, reported through job health |
| `src/services/teacher-photo.ts:39` | warn | routine | bad upload (400); input, not stored data |
| `src/services/teacher-photo.ts:63` | warn | routine | bad upload (400); input, not stored data |
| `src/services/timezone-audit.ts:106` | error | routine | a detector, not a substitution; see close calls |
| `src/services/waitlist-reconciliation.ts:760` | error | routine | operational state, reported through job health (tick escalation) |
| `src/services/waitlist-reconciliation.ts:776` | warn | routine | lock contention (`isLockTimeout`) (transient, retried next tick) |
| `src/services/waitlist-retention.ts:429` | warn | routine | operational state, reported through job health (per-run cap) |
| `src/services/waitlist-retention.ts:526` | error | routine | operational state, reported through job health |
| `src/services/waitlist-retention.ts:534` | error | routine | operational state, reported through job health |
| `src/services/waitlist-retention.ts:539` | warn | routine | operational state, reported through job health |

### Computed-level calls (`log[…](`)

Each picks its level at run time, mostly through `transientDbFailure` (`src/lib/api-errors.ts`), which is why the first pattern misses them.

| site (file:line) | level | verdict | code or reason |
|---|---|---|---|
| `src/app/api/account/route.ts:148` | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/app/api/account/route.ts:198` | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/app/api/cron/daily-cleanup/route.ts:113` | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/app/api/registrations/[id]/route.ts:587` | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/app/api/registrations/route.ts:480` | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/app/api/waitlist/route.ts:64` | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/lib/api-utils.ts:217` | dynamic | routine | `withErrorHandler`; every uncaught route error, surfaced as an error |
| `src/lib/degradation.ts:71` | dynamic | — | not a site: the line `logDegraded` itself emits |
| `src/services/class-template-lifecycle.ts:1109` | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/services/gdpr.ts:1012` | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/services/gdpr.ts:1168` | dynamic | routine | failure (an exception or outage), not impossible data (completion refused during erasure) |
| `src/services/rule-lifecycle.ts:865` | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/services/rule-lifecycle.ts:1438` | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/services/rule-lifecycle.ts:1735` | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/services/studio-class-template-lifecycle.ts:758` | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/services/waitlist-reconciliation.ts:675` | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |
| `src/services/waitlist-retention.ts:477` | dynamic | routine | transient-failure classifier; level chosen by `transientDbFailure` |

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
booked if that is known, otherwise to 3, which is what the pricing already
assumed.

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
(`src/services/timezone-audit.ts`) finds the same rows and fails
`daily-cleanup`'s health while any exist.

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
student's past-classes row rendered without its payment breakdown.

**Where the bad value lives.** `Class.totalRevenue` / `Class.totalStudents`
for the sample's `classId` (`registrationId` is the row whose page showed it).

**Confirm.**

```sql
SELECT id, status, "totalRevenue", "totalStudents" FROM "Class"
 WHERE status = 'completed' AND ("totalRevenue" IS NULL OR "totalStudents" IS NULL);
SELECT status, amount FROM "Payment" WHERE "classId" = '<classId>';
```

**Correct.** Find what completed the class outside `completeClass` (a manual
`UPDATE`, a data migration) — that is the bug. Then restore the snapshot from
the class's `Payment` rows: `totalStudents` is their count, `totalRevenue`
their summed `amount` (within a cent or so of what the pricing engine would
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
