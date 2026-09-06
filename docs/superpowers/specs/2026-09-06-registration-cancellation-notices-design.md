# Every registration cancellation tells the student (#434)

## Summary

Cancelling a registration notifies nobody. Booking one notifies two people.
This closes that asymmetry on the student's side: each of the three ways a
registration can end sends the student a notification, with copy distinct to
which one happened.

Two new `NotificationType` values, one migration, one route handler, one line
of delivery policy. **No teacher-facing notification is added** — see *The
decisions* for why.

## What the issue said, and what measurement showed

#434 is two sentences: *"No cancellation message when you cancel the class
yourself. When cancelling a class yourself, before the cancellation deadline
there is no notification?"*

| #434 claim | Verdict |
|---|---|
| Cancelling before the cancel deadline produces no notification | **Holds.** `DELETE /api/registrations/[id]`'s full-cancel branch (`route.ts:283-289`) writes the status and calls `promoteAfterCancel`. Nothing else. |
| *"cancel the class"* | **Ambiguous, and resolved by measurement.** The teacher cancelling a whole class already notifies every registered and waitlisted student (`api/classes/[id]/cancel/route.ts:147-157`, #112/#200). The gap is the *registration*-level cancel, which is what "yourself" points at. |
| Implied: this is one missing message | **Incomplete.** The same handler ends a registration three ways, and all three are silent. |

### The census

`DELETE /api/registrations/[id]` (`src/app/api/registrations/[id]/route.ts`),
three outcomes, each reached by a different branch:

| Outcome | Branch | Who acted | Charged? | Notifies today |
|---|---|---|---|---|
| `cancelled` | `:283-289`, reached with `isStudent` true and now ≤ deadline | the student | no | nothing |
| `late_cancel` | `:267-276`, inside `if (isStudent)`, now > deadline | the student | **yes** | nothing |
| `cancelled` | `:283-289`, reached with `isStudent` false | the teacher, on the student | no | nothing |

The third row is not a separate code path — it is the same branch, entered by
a request that skipped the deadline block. `if (isStudent)` (`:242`) is the
only thing dividing them, which is why it is also the branch selector for the
copy below.

Re-derive: `grep -n "isStudent\|updateMany\|promoteAfterCancel" src/app/api/registrations/[id]/route.ts`

### What booking does, that cancelling does not

`api/registrations/route.ts:247-266` sends a pair, under a comment naming the
convention: *"Layer 1+2 of the comms model: confirmation for the student,
heads-up for the teacher."* That comment is the strongest evidence the silence
on the cancel side is an omission rather than a decision — the pattern is
named in the codebase, and applied on exactly one half of the event.

## The decisions

Three, all taken by the issue's author during brainstorming, recorded here
because each closes off an option a reader would otherwise reopen.

**1. The student is the only recipient.** Not the symmetric pair booking
sends. A teacher gets no notification when a seat frees. For the
teacher-initiated case this is self-evident (they did it); for the two
self-cancel cases it is a deliberate scoping choice, and the seat-freeing
signal a teacher does get remains the roster on the class page.

**2. All three outcomes notify, with distinct copy.** Not just the one #434
names. The three differ in what the student needs told — nothing owed, money
owed, or a decision someone else made for them — and a single body covering
all three would have to be vague about all three.

**3. Two types, not one.** Essentiality is a property of the *type*
(`ESSENTIAL_NOTIFICATION_TYPES`, `services/notification-policy.ts:16-21`), and
the three outcomes do not agree on it:

- A student who cancelled their own booking already watched it happen. That is
  a receipt. `booking_confirmed` — the mirror-image event — is deliberately
  **not** essential, and a receipt for undoing it should not be louder than
  the confirmation was.
- A student removed by their teacher did not ask for it and may otherwise
  arrive at a class they think they are booked into. That is the same shape as
  `class_cancelled`, which **is** essential.

One shared type forces one answer onto both, and either answer is wrong for
one of them: `true` force-emails a receipt to someone who opted out of
optional mail, `false` lets a unilateral removal go unmailed.

## Changes

### 1. Schema — `prisma/schema.prisma` + one migration

Two values on `NotificationType`:

```prisma
booking_cancelled   // the student ended their own registration
booking_removed     // the teacher ended the student's registration
```

`NotificationType` has **10** members today (`grep -n "enum NotificationType"
-A 20 prisma/schema.prisma`); 10 + 2 = **12** after.

Migration follows `prisma/migrations/20260717204036_add_payment_request_notification/`
verbatim in shape — `ALTER TYPE "NotificationType" ADD VALUE '…';` per value,
created with `npx prisma migrate dev --name registration_cancellation_notices`.
Neither value is *used* by a statement in its own migration, so the
Postgres restriction on consuming a new enum value in the transaction that
added it is not in play.

### 2. Delivery policy — `services/notification-policy.ts`

`booking_removed` joins `ESSENTIAL_NOTIFICATION_TYPES` (4 members today → 5).
`booking_cancelled` does **not**, and that absence is the design, not an
oversight — it needs a line saying so, since a reader finding one of a pair
in the set will otherwise "fix" the other in.

### 3. Fallback email copy — `lib/email-templates.ts`

**`STUDENT_INTROS` is `Record<NotificationType, string>` — total, not
partial** (`:47`). Both new values need an intro line or the build fails.
This is the tether doing its job; the entries are required work, not optional
polish:

```ts
booking_cancelled: 'Your booking was cancelled.',
booking_removed: 'Your teacher cancelled your booking.',
```

`TEACHER_INTROS` (`:60`) and `STUDENT_ACTION_LINKS` (`:81`) are both
`Partial<Record<…>>` and stay untouched — no teacher receives either type, and
neither needs a link beyond what the inbox row already gives.

### 4. The handler — `api/registrations/[id]/route.ts`

One added select field, one added import pair, one notification per outcome.

**Query:** the existing top-of-function read (`:199-217`) already selects
`date` and `startTime` on the entry but **not `classType`**. Add it. No new
query, no second round trip.

**Bodies.** Every cancellation notice names the class — type, day, time —
whatever the audience and whatever path sent it. That rule is #200's, written
for the `class_cancelled` family, and these three follow it. Rendering is
`formatDayHeader` (`lib/format.ts`) and `timeToHHmm` (`lib/time-of-day.ts`),
the same pair `api/classes/[id]/cancel/route.ts:152` uses; `startTime` is a
`@db.Time` column, so it is a `Date` needing `timeToHHmm`, never interpolated
raw.

| Outcome | Type | Essential | Title | Body |
|---|---|---|---|---|
| self, on time | `booking_cancelled` | no | `Booking cancelled` | `Your booking for {classType} on {day} at {time} is cancelled. You won't be charged for it.` |
| self, late | `booking_cancelled` | no | `Booking cancelled` | `Your booking for {classType} on {day} at {time} is cancelled. It was past the cancellation deadline, so this class is still charged.` |
| by teacher | `booking_removed` | **yes** | `Booking cancelled by your teacher` | `Your teacher cancelled your booking for {classType} on {day} at {time}. You won't be charged for it.` |

`recipientType: 'student'`, `recipientId: registration.studentId`,
`relatedClassId: registration.classId` on all three. The related class makes
the inbox row link: `studentNotificationHref`
(`lib/notification-links.ts:61-68`) links a class that is still `open` and
uncancelled — which all three of these are, since the *class* is unaffected —
so the row lands on the booking page, where a student who changed their mind
can rebook. That is the desired destination and needs no change to the helper.

**Placement.** Each `createBulkNotifications` call goes after its own
`updateMany` has been confirmed to have written (`updated.count === 0` returns
409 first), and before the response. The late-cancel branch returns at `:276`,
so it takes its own call rather than sharing one after the second branch.

**Branch selector is `isStudent`**, already computed at `:222` for
authorization. A dual-role account cancelling its own booking is
self-initiated even when it also teaches — the same precedence this file's GET
handler already applies and documents (`:40-51`).

**No transaction, no lock, deliberately.** `createBulkNotifications` accepts a
plain client (`Db = PrismaClient | Prisma.TransactionClient`,
`services/notifications.ts:25`), so these calls fit the handler as it is. This
handler opens no transaction and takes no `Class` lock today; it defends
itself by scoping each write's `WHERE` instead (`:253-266`, `:281-289`), and
a notification created after a write that is already confirmed to have landed
adds no race that scoping does not already cover. The proportionality rule
being followed is stated one function up, in the sibling `PUT`
(`:143-146`): a `Class` lock is not taken to protect something that is not
worth the app's hottest row. The consequence is stated under *Risks*.

### 5. `docs/data-model.md:495`

The prose list of notification types is **already stale before this change**:
it names 8, the enum has 10 — `payment_request` (added 2026-07-17) and
`teacher_invitation` (added with #166) are both missing. Since the line has to
be edited anyway, it is brought fully current at 12 rather than extended to a
list that is wrong in two other places.

## Testing

### Integration — `tests/integration/registrations-api.test.ts`

The three bodies are built inline in the route handler, not in a service, so
HTTP is the only level that reaches them. The file already has the fixtures:
`makeClass` for the on-time case, `makeLateCancelClass` for the late one,
`ownerToken` for the teacher.

One test per outcome, each asserting: a `Notification` exists for the
registration's student, its `type` is the expected one, its body contains the
class type, `formatDayHeader(date)` and `timeToHHmm(startTime)` **derived from
the fixture rather than hard-coded**, and — for the two that differ on money —
that the charge sentence is present or absent as expected.

A fourth test asserts what is *not* created: no `Notification` with
`recipientType: 'teacher'` for any of the three. Decision 1 is otherwise
invisible to the suite, and a future "symmetry" edit would go green.

**The teacher-initiated branch has no positive-path test today** — no DELETE
in the suite is sent with a teacher token (`grep -n "method: 'DELETE'" -A 3
tests/integration/registrations-api.test.ts`). Its test is therefore first
coverage of that branch, not an extension.

The two existing `…and nothing else` tests (`:1077`, `:1092`) are unaffected:
they pin the HTTP response body's keys (`['id','status']`), which this change
does not touch.

### Unit — `services/notification-policy.test.ts`

`booking_removed` is essential; `booking_cancelled` is not. Two assertions,
naming both, because the pair's asymmetry is the whole decision and a set
membership is exactly the claim that rots silently.

### Mutations

| Guard | Mutation | Test that must fail |
|---|---|---|
| Essentiality split | add `booking_cancelled` to `ESSENTIAL_NOTIFICATION_TYPES` | the policy unit test |
| Essentiality split | remove `booking_removed` from it | the policy unit test |
| Branch selector | key the type off `isTeacher` instead of `isStudent` | the teacher-initiated integration test |
| Late-cancel copy | drop the "still charged" sentence | the late-cancel integration test |
| Recipient scope | add a teacher notification beside any of the three | the no-teacher-notification test |

Each broken, the exact error text recorded, restored, re-verified. The
`STUDENT_INTROS` entries need no mutation row: omitting either is a typecheck
failure, which is a stronger proof than a test and is demonstrated by the
build rather than by breaking it.

## Out of scope

- **Teacher-facing notifications on any of the three outcomes** — decision 1.
- **The whole-class cancel path** (`api/classes/[id]/cancel/route.ts`). It
  already notifies correctly; #112 and #200 are its history. **#434 is
  unaffected by it and it is unaffected by this.**
- **`promoteAfterCancel` and the waitlist notifications it sends.** Orthogonal:
  those tell *other* students a seat opened, and nothing here changes when or
  whether they fire.
- **A notification when a teacher marks a registration `no_show`** — a
  different verb on a different route (`PUT`), and not a cancellation.
- **Adding a link target for the two new types in `STUDENT_ACTION_LINKS`.**
  The inbox row already links via `relatedClassId`; the email's own action
  button exists for types that carry no related class, which is not this.

## Risks

- **Stale class name in a body.** The bodies interpolate the route's
  top-of-function read (`:199-217`), and this handler takes no `Class` lock, so
  a teacher rescheduling the class between that read and the write would
  produce a notice naming the old day. This is the exact staleness the
  whole-class cancel route fixed for itself by re-reading under its lock
  (`api/classes/[id]/cancel/route.ts:136-146`) — it can afford to, because it
  already holds one. Buying the same guarantee here means giving this route a
  lock it has deliberately never had, for a body rather than for money. The
  window is narrow (no user-input await sits inside it). Out of scope, and
  named here so the next reader knows it was weighed rather than missed.
- **A student who opts out of optional email gets no mail for a self-cancel.**
  That is decision 3 working as intended, and it matches `booking_confirmed`.
  The in-app inbox record is unconditional either way.
- **Copy volume.** Three bodies where there were none, all near-identical in
  shape. The mutation table's charge-sentence row is what keeps the two
  self-cancel bodies from silently converging.
