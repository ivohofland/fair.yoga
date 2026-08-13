# Branch 2 of #196 — the nine endpoints needing no schema change

Spec for the second and final branch of #196. Branch 1 (PR #208) put six partial
unique indexes in Postgres and gave thirteen write paths a tailored 409. This
branch closes #196.

**This spec supersedes §4.2 of
`docs/superpowers/specs/2026-08-11-retry-safe-endpoints-design.md`.** That
section was written before branch 1 executed and before any of its nine rows was
read against the code. Seven of the nine are wrong. §1 below records what
measurement found; §3 is the corrected design.

The four product decisions in §1 of the branch-1 spec still stand and are not
re-opened. Four *further* decisions were forced by the corrections and were
answered by Ivo on 2026-08-12; they are in §2.

---

## 1. What §4.2 claimed, and what measurement found

Every one of the nine rows was read against the current code by three
independent sweeps, and every finding acted on below was then re-verified by
reading the file directly. Two rows stand as written. Seven do not.

| Endpoint | §4.2's mechanism | Verdict |
|---|---|---|
| `DELETE /api/invitations/[id]` | status-scoped `deleteMany` + count | **stands** |
| `PUT /api/invitations/[id]` | same status scope | **stands** |
| `POST /api/announcements` | dedupe the insert | guards the wrong write |
| `POST /api/cron/email-fallback` | `emailSent: false` in the mark | wrong side of the send; and one of two triggers |
| `POST /api/payments/[id]/remind` | CAS on `reminderSentAt` | sound; two false supporting claims, no window chosen |
| `POST /api/auth/magic-link/send` | reuse the live token | not expressible |
| `POST /api/auth/student-signup` | move the mint inside the guard | would remove sign-in for every returning student |
| `DELETE /api/registrations/[id]` | guard the final-hour broadcast | names the symptom, not the source |
| `DELETE /api/account` | scope the erasure by `deletedAt: null` | incomplete — the duplicate is post-commit |

`2 stand + 7 corrected = 9 ✓`

### 1.1 The predicted failure mode, and where it actually was

Branch 1's largest error was a census scoped by endpoint when the enforcement
was by table: a unique index constrains every statement touching its columns, so
a plan scoped to five POST routes under-counted by eight. The instruction for
this branch was to look for the analogue.

It is not the same shape, because these mechanisms are the mirror image. A
unique index binds to a **table**; a `where` clause, a lock and a CAS bind to a
**call site**. So the under-count does not come from missing a verb — it comes
from writing the guard where only one of several callers passes through it. Two
instances, both confirmed:

- **`processEmailFallback` has two triggers.** `POST /api/cron/email-fallback`
  (`route.ts:11`) and `src/lib/scheduler.ts:100-103`, an in-process timer
  running **every 5 minutes** from boot. §4.2 names only the route, and the
  unattended trigger is by far the likelier producer of the overlap.
- **`handleSpotFreed` has two callers.** `registrations/[id]/route.ts:190`
  (itself reached from two branches, `:165` and `:178`) and `gdpr.ts:599`,
  inside a post-commit per-class loop. §4.2 gives these two endpoints separate
  mechanisms; the duplicate they both produce comes from one function.

One further verb was found in an already-correct row, and it must be
**excluded** rather than included: `PATCH /api/invitations/[id]` (`route.ts:174`)
archives a declined row on purpose — `route.ts:167-169` says so and
`tests/integration/invitations-api.test.ts:503` pins it. Applying the status
scope file-wide would break the archive escape hatch that DELETE's own refusal
message points at. **Widening a guard to "every verb in the file" is as wrong
here as narrowing it to one route was on branch 1.**

### 1.2 Two mechanisms guard a write that is not the one with the side effect

Both are the same mistake: the irreversible effect escapes before the row the
spec proposes to deduplicate is written.

**Announcements.** `src/app/api/announcements/route.ts:81` calls
`createBulkNotifications` — one `Notification` per recipient, plus an SSE emit
per input inside that call (`notifications.ts:120-122`). Only then, at `:84`,
does the `Announcement` row get inserted. **No transaction wraps them.** A
compare-then-insert at `:84` suppresses the teacher's sent-history record and
leaves every student holding a second notification — it protects the audit trail
and nothing the user experiences.

**Email fallback.** `src/services/email-fallback.ts:152-157` calls
`resend().emails.send`; `markOne` runs at `:165`, *after* it returns. Adding
`emailSent: false` to `markEmailSent`'s `where` makes the mark idempotent and
does not prevent one real email being sent twice. (`markEmailSent` is what the
function was called when this was measured. It shipped as `claimEmailFallback`,
and why is in §3.8.)

### 1.3 Two mechanisms cannot be built, and one would ship a regression

**`magic-link/send` — "reuse the live unconsumed token" is not expressible.**
`generateMagicLinkToken` (`src/lib/auth/magic-link.ts:18-29`) generates 32 random
bytes, stores `sha256(raw)` as `tokenHash`, and returns the raw value, **which
is persisted nowhere**. Recovering a raw token from a live row would require
inverting SHA-256. Every workaround weakens the control that blocks it: storing
the raw token makes any database read a sign-in; reversible encryption moves the
problem to key management and still falls to a key-plus-database compromise; an
in-memory cache dies on restart, and this is a single-process VPS.

Separately, **the defect this row describes does not exist under §1's own
answer.** That answer was "resend, and the first link stays valid".
`generateMagicLinkToken` performs no lookup, no `deleteMany` and no
`updateMany` before its `create` — it has never invalidated a prior token. The
behaviour §1 chose is the behaviour that ships today.

**`student-signup` — "move the mint+send inside the existing guard" would remove
sign-in for every returning student.** The guard at `route.ts:40-50` covers only
`prisma.student.create`, and the comment above it (`:37-39`) states the
contract: *"Fresh email: account + claimed student, atomically. Every other
state just gets the link — an unclaimed CRM row claims at verify, and a profile
never attaches to an existing account without its session."* Moving the mint
inside it would break the unclaimed-CRM claim flow, the returning-student
sign-in, and the identical-response guarantee at `:10-16`.

It would also have shipped green: no test asserts that a *non-fresh* address
receives a link. `tests/integration/signup-api.test.ts:124`, `:137` and `:148`
each assert only what is **not** created.

### 1.4 Two mechanisms name a symptom whose source is a single unguarded write

**`DELETE /api/registrations/[id]`.** There is nothing to key a broadcast guard
on: `WaitlistEntry` (`schema.prisma:543-560`) has no `notifiedAt` or equivalent,
`Notification` (`:587-603`) has no unique index, and `createBulkNotifications`
uses `createMany` without `skipDuplicates`. The duplicate's actual source is
that the handler runs **no transaction at all** and cancels with
`prisma.registration.update({ where: { id } })` at `:160` and `:171` — unscoped,
so both racers pass the `:143` pre-check and both reach `handleSpotFreed`.

**Correction found in implementation: that last sentence is true of `:171`
only.** `:160` is the late-cancel branch, reached only when `now > deadline`,
and `getWaitlistWindow` returns `frozen` for exactly that — so `handleSpotFreed`
broadcasts nothing there and there is no duplicate to observe. That branch still
needs its scope, for money rather than notifications; §3.6 carries the reason.

**`DELETE /api/account`.** The duplicate `spot_available` set §3 of the branch-1
spec attributes to this endpoint is produced at `gdpr.ts:597-603`, a loop that
runs **after** the transaction commits. Scoping the final `student.update`
(`:486-499`) by `deletedAt: null` and letting the transaction commit anyway
leaves that loop running twice.

**So both rows resolve the same way: scope the source and abort on
`count === 0`.** Then exactly one racer reaches the broadcast, and no broadcast
dedupe is needed at all. Fixing the source beats deduplicating the effect
whenever the source is a single unguarded write.

### 1.5 Three false claims, corrected

- **`reminderSentAt` is "written at `payments.ts:193` and never read".** It is
  read in six places: the cron's dedupe (`payment-reminders.ts:47` and `:78`) and
  four UI sites (`class/[id]/page.tsx:78`, `settings/payments/page.tsx:77`,
  `outstanding-payment-row.tsx:52`, `send-reminder-button.tsx:77-81`). A unit
  test pins the coupling (`payment-reminders.test.ts:153`).
- **The column is not at `schema.prisma:536`.** Line 536 is `payment Payment?`
  inside `Registration`; `reminderSentAt DateTime?` is at **`:573`**. This spec
  cites model and field names rather than line numbers wherever it can, which is
  the lesson branch 1 recorded after three `schema.prisma:NNN` citations were
  falsified by its own 37-line insertion.
- **`scheduler.ts:9-10` claims every job is idempotent.** *"Every job is
  idempotent at the DB layer (conditional updates, unique constraints), so an
  overlapping external trigger is harmless."* True for `payment-reminders`
  (`payment-reminders.ts:74-81`), false for `email-fallback`, which is the whole
  of §1.2's second half.

One claim checked and **holding**: the branch-1 spec's §2.4 correction is
correct in every particular. There is no welcome email in this codebase —
`src/lib/email.ts` exports only `emailDryRun`, `sendMagicLinkEmail` and
`sendInvitationEmail`, and the only "welcome" strings in `src/` are a
*prohibition* in the invitation template plus a UI heading. `student-signup`
mints a second live sign-in credential, exactly as the reopening comment said.

---

## 2. The four decisions this branch's corrections forced

§1 of the branch-1 spec answered four product questions. The corrections above
raised four more that it could not have anticipated. Answered by Ivo,
2026-08-12, before any implementation.

| Question | Answer | Mechanism it forces |
|---|---|---|
| Reuse is unbuildable and today already matches the decided behaviour — how far should magic-link security go? | **Invalidate sibling tokens on a successful sign-in**, keep hash-only storage, never build reuse | a `deleteMany` in `verifyMagicLinkToken`, after the expiry check |
| §1 said "a reminder is legitimate after a cooldown" but chose no window | **2 minutes** | a new constant; the same window as announcements |
| The fallback's CAS is on the wrong side of the send; fixing it flips a documented trade | **Claim before send**, release the claim on failure | `markEmailSent` gains a CAS and a return count — **shipped as `claimEmailFallback(db, id)` answering `'claimed'` or `'already-claimed'`; the count was itself a defect, §3.8** |
| Should the broadcast be deduplicated, or the sources scoped? | **Scope the sources** (engineering call, recorded for the record) | status-scoped cancel; `deletedAt: null`-scoped erasure |

### 2.1 Why sibling invalidation is the right magic-link answer

The obstacle to §4.2's mechanism is itself a security control, so the correct
response is to keep it and harden elsewhere rather than route around it.

Today `verifyMagicLinkToken` deletes only the row it consumed
(`magic-link.ts:50`). Live sign-in credentials for that address survive in the
user's inbox **after they have already signed in** — zero remaining utility, and
real exposure to a forwarded mail, a shared mailbox or a link-prefetching mail
scanner.

**How many, corrected.** This paragraph read "3 tokens per address per 15
minutes … so up to two other live credentials". The budget is twice that, and
the error was found while implementing. Both minting routes cap three per
address per 15 minutes, but from **separate buckets** (`magic-link:email:` and
`student-signup:email:`), and `student-signup` mints for any address with no
account required. So one address can hold **six** live tokens, and a consumption
can find **up to five** siblings.

**Placement is load-bearing.** The `deleteMany` must fire only after the expiry
check at `:55-57` passes. If it fired on every consumption, anyone holding an
old expired link could destroy the user's fresh one — a self-inflicted denial of
service, and a guard that creates the attack it exists to prevent.

Two costs, both accepted: a user who requested two links and clicks the *older*
first will find the newer one dead, where today it would have re-authenticated
and honoured its own `redirect` (they are signed in at that point, so they
navigate); and `deleteMany({ where: { email } })` is unindexed, since
`MagicLinkToken` carries `@unique` on `tokenHash` only. What bounds the table is
`cleanupExpiredAuth`'s daily sweep of `expiresAt < now` — roughly a day's
accumulation — so the scan is microseconds. This sentence originally credited
the rate limiter, which is the second arithmetic error implementation found: the
limiter caps rows **per address** and says nothing about how many addresses
there are. **Adding the index would mean a migration, which is the one thing
branch 2 is scoped to avoid.**

**Rejected: binding the link to the requesting device** (an httpOnly cookie set
at send, required at verify). It is the strongest hardening against link
interception and it breaks request-on-desktop / click-on-phone, a core
magic-link affordance. That is a product decision with its own spec, not
something to fold into a retry-safety branch. Filed rather than built (§7).

### 2.2 Why 2 minutes for the reminder cooldown

`send-reminder-button.tsx:30-33` documents the absent cooldown as deliberate:
*"the calm 'Reminded …' caption — the only pressure against nagging, since no
cooldown is enforced."* The only existing constant is `REMIND_EVERY_DAYS = 7`,
which would block a legitimate second nudge for a week and make the manual
button near-useless after one press.

2 minutes kills the double-submit and the retried request — the actual defect —
while leaving the product's no-nag stance intact, and it matches the
announcement window so the branch carries one concept rather than two.

### 2.3 Why claim-before-send, and what it trades

`email-fallback.ts:41-43` records the current trade: *"Mark each notification
immediately after its send: batching the marks at the end meant one failed
batch-update re-emailed every recipient on every 5-minute sweep. Worst case now
is a single duplicate."*

Claiming first inverts the residual risk from "duplicate on crash" to "drop on
crash". Accepted, for two reasons. Frequency: two sweeps overlapping is routine
(a 5-minute timer plus any route or external trigger), while a crash inside the
few hundred milliseconds between claim and send is rare. And cost: this is the
*email fallback* for an unread in-app notification — a dropped fallback email
leaves the in-app notification and the inbox record intact, so the message is
not lost, only its second delivery channel.

Releasing the claim on a Resend failure keeps the ordinary retry path exactly as
it is today.

---

## 3. The corrected design

Nine rows. Two are unchanged from §4.2; seven are corrected.

### 3.1 `POST /api/announcements` — lock and compare above the fan-out

Wrap the fan-out and the insert in one interactive `$transaction`, take the
advisory lock as its first statement, and compare before either write.

```
$transaction:
  pg_advisory_xact_lock(ANNOUNCEMENT_LOCK_NAMESPACE, hash32(teacherId, classId, message))
  findFirst Announcement where teacherId, classId: classId ?? null,
            message: <exact>, sentAt >= now - 2min
  if found  -> return it, no fan-out, no insert
  else      -> createBulkNotifications(tx, …)   // was route.ts:81
               announcement.create(tx, …)       // was route.ts:84
```

Four details, each of which was wrong or absent in §4.2:

- **`sentAt`, not `createdAt`.** The `Announcement` model has no `createdAt`;
  its recency column is `sentAt @default(now())`.
- **`classId: body.classId ?? null` explicitly.** `classId` is nullable (the
  "all my students" case) and a Prisma `where` given `undefined` **omits the
  clause**, so a naive pass-through would match every announcement that teacher
  ever sent.
- **`pg_advisory_xact_lock`, never `pg_advisory_lock`** — the session-scoped
  variant leaks a lock onto a pooled connection. This is carried forward from
  the branch-1 spec §1 and remains correct.
- **The two-int form, namespaced.** `pg_advisory_xact_lock(int4, int4)` with a
  constant namespace in the first argument keeps this lock from ever colliding
  with a future unrelated advisory lock. A hash collision within the namespace
  costs needless serialisation and nothing else, because the duplicate test
  compares the real message text — which is the whole reason §1 of the branch-1
  spec chose a lock over a hashed index.

**Shipped differently: the helper takes the tuple, not a pre-composed key.**
`lockAnnouncementSlot(tx, { teacherId, classId, message })` builds the key
inside `db-locks.ts`. In the sketch above the caller composes the key while the
`findFirst` below compares the same three columns, with nothing holding the two
together — change one without the other and two identical sends take two
*different* locks, both read an empty compare, and both fan out.

**There is no advisory-lock precedent in this repo** — the only `advisory` hit
anywhere is unrelated prose in `src/middleware.ts:21`. So this is a new idiom and
it adopts the conventions already established next door in `src/lib/db-locks.ts`:

- The helper lives in `db-locks.ts` and takes `TransactionClientOnly`. That
  module's own docblock states the rule it falls under — *"a function needs this
  brand when it issues a statement whose effect is scoped to the surrounding
  transaction"* — and `pg_advisory_xact_lock` is exactly such a statement. **That
  docblock enumerates its adopters and must gain this one**, or the list is
  wrong the moment this lands.
- `docs/lock-order.md` enumerates every lock in the project and has no advisory
  entry. It gains one.

**Known residue, stated so it is not mistaken for an oversight.**
`createBulkNotifications` emits SSE per input *inside* the call
(`notifications.ts:120-122`), so moving it into a transaction means a rollback
leaves bus events already emitted. This is pre-existing shape, the transaction is
short, and its only rollback source is a database error. Not fixed here.

#### The suppressed send says so (Ivo, 2026-08-12)

The first draft of this design returned `201` in both branches, on #98's
absolute-target-state reasoning: the caller's intent — "this announcement is
sent" — holds either way. **Rejected, because it is silently untrue in the one
case it exists for.** A teacher who deliberately presses Send twice would see
"Sent to 12 students" and no second delivery, and nothing would tell them the
two facts disagree. Suppressing a duplicate is right; hiding the suppression is
a small lie told by a tool whose whole premise is being a calm, honest utility.

So the route answers **`201` when it created the announcement and `200` when it
suppressed one**, and the body carries `duplicateSuppressed: boolean` alongside
the announcement's own fields. The status alone is not enough: any client that
checks only `res.ok` would go on reporting a send that did not happen, so the
signal has to be in a field a client must read past, not in a status code it can
ignore.

`send-announcement.tsx` renders the two outcomes differently — the suppressed
one names what happened and confirms the earlier send landed, so the teacher
learns their message went out without being told a second one did. No badge, no
alarm colour: this is not an error, and `danger` is reserved for things that
are.

This is the one place in the branch where a fix reaches a component, and it is
why `src/components/class/send-announcement.test.tsx` is created (there is no
component test for that file today).

### 3.2 `POST /api/payments/[id]/remind` — extend the CAS that is already there

§4.2 describes this as copying `payment-reminders.ts:74-82`. The idiom is
already in the function being changed: `sendPaymentReminder`
(`payments.ts:187-202`) opens a transaction and does `updateMany` +
`count === 0`. It simply CASes on **`status`** and not on the timestamp, so two
concurrent clicks both read `pending`, both pass, both stamp and both fan out.

Add a new `MANUAL_REMIND_COOLDOWN_MS = 2 * 60 * 1000` and extend the existing
`where`:

```
where: { id, status: { in: ['pending','overdue'] },
         OR: [ { reminderSentAt: null },
               { reminderSentAt: { lt: new Date(Date.now() - MANUAL_REMIND_COOLDOWN_MS) } } ] }
```

The `count === 0` diagnostic branch (`:195-202`) already re-reads the payment to
explain itself; it gains a third case distinguishing "too soon" from "no longer
outstanding", so the teacher is told which of the two happened.

Two docblocks assert the absence this adds and must be corrected in the same
commit: `send-reminder-button.tsx:30-33` and `payments.ts:174-181`.

### 3.3 `POST /api/auth/magic-link/send` — no change, and a docblock that says why

No code change at this route. The duplication it produces is the behaviour §1
decided on, and #196's own acceptance permits exactly this outcome: *"explicitly
documented as 'duplication is legitimate here' with the reason."*

The reason goes on `generateMagicLinkToken`, where the next reader will meet it:
that a second live token is deliberate, that the first link stays valid by
design, and that **reuse is structurally impossible because only the hash is
persisted, and that is a control worth keeping.** Without that note the next
reader re-derives §4.2's mechanism and gets the same distance before hitting the
same wall.

The security improvement decided in §2.1 lands one function away, in
`verifyMagicLinkToken`: after the atomic single-use delete **and after the
expiry check passes**, `deleteMany({ where: { email: record.email } })`.

### 3.4 `POST /api/auth/student-signup` — the real defect, which §4.2 missed

Do **not** move the mint inside the guard (§1.3).

The genuine defect here is on the concurrent axis, and the branch-1 census filed
this endpoint's axis-2 column as `N/A`. `existingAccount` and `existingStudent`
are plain `findUnique`s at `route.ts:34-35`; `Student.email` and `Account.email`
are both `@unique`. Under Read Committed two concurrent submissions of a fresh
address both pass the pre-check, both reach the `create` at `:41`, and the loser
raises P2002 — which `withErrorHandler` maps to **409 "Resource already
exists"** (`api-errors.ts:248-256`).

That is user-visible twice over: a signup that simply fails, and a response that
tells an anonymous caller the address is taken, breaking the no-enumeration
contract this route documents at `:10-16` and implements by always returning the
same 200.

Fix: catch P2002 on that `create` and continue to the mint and send. A row
losing that race means the account now exists, which is precisely the state the
unconditional mint-and-send below already handles correctly. **There is no
`else` in this route** — every state that is not a fresh email simply falls
through — and this sentence said "the `else` path" until the comment review
falsified it.

**Shipped differently: the catch is narrowed, not blanket.** `P2002` alone is
"some unique constraint", and the reasoning above holds only for the email keys;
a future unique on this `create` would inherit it by accident. The catch matches
`isUniqueConflictOn(err, ['email'])` — one predicate covering both halves of the
race, since `Student.email` and `Account.email` both key on `['email']` — logs
which model lost, and rethrows anything else as an **ordinary** error rather
than as a P2002. Rethrowing it as a P2002 would land on `classifyApiError`'s 409
"Resource already exists", which is the same enumeration signal this route's
uniform 200 exists to prevent, arriving through the other door.

### 3.5 `DELETE` and `PUT /api/invitations/[id]` — as §4.2 wrote them

The two rows that stand.

- `DELETE` (`route.ts:143`): `deleteMany({ where: { id, status: { not: 'declined' } } })`,
  `count === 0` → the same 409 the `:135-141` pre-check already returns.
- `PUT` (`route.ts:94-104`): `updateMany` with the same status scope,
  `count === 0` → the same 409 as `:55-61`.

**Shipped differently: `count === 0` does not mean "declined".** Both verbs call
a shared `casMatchedNothing`, which re-reads the row and reports what is
actually there — **404** when it is gone, `DECLINED_IS_PERMANENT` only when it
is genuinely declined, and a neutral 409 ("this contact changed while you were
working on it") otherwise. The design above answers `DECLINED_IS_PERMANENT`
unconditionally, and the harm is specific: a teacher whose own concurrent delete
removed the row would be told that the person had declined their invitation — a
false statement about a third party's choice, made by a tool whose premise is
not making those. The re-read is scoped to the teacher (a row that is no longer
theirs is not theirs to hear about) and bounded by a `catch`, so it cannot turn
a deterministic 409 into a 500 on the retry path #196 exists to make safe; an
unreadable row falls to the neutral 409, never to the decline.

The third branch — present, not gone, not declined — is reachable by the
mechanism this domain is built around: `resolveInvitationOnLink`
(`link-consent.ts`) flips a declined row to `accepted` when the student books.
It logs at `info` for that reason. Found by the type-design review.

`declined` is the only tombstone: `enum InvitationStatus { pending accepted
declined }`. `accepted` is deliberately deletable — what blocks a re-invite for a
linked pair is `hasRosterLink` → `ALREADY_LINKED` (`invitations.ts:191-193`),
not the row.

**`PATCH` is explicitly excluded** (§1.1), with a comment at the site saying so,
because the next person to read these three verbs together will otherwise
"finish the job".

The precedent to follow is in the same domain: `revivePendingInvitation`
(`invitations.ts:274`) is this exact mechanism, with a test that dies when the
scope is removed (`invitations.revive.test.ts:97`).

### 3.6 `DELETE /api/registrations/[id]` — scope the cancel, not the broadcast

Replace the unscoped `prisma.registration.update({ where: { id } })` at `:160`
and `:171` with a status-scoped `updateMany` — scoped by the same statuses the
`:143` pre-check accepts — plus a `count === 0` branch returning the same 409
that pre-check returns.

Then two concurrent cancels resolve to one winner, one `promoteAfterCancel`, one
`handleSpotFreed`, and the final-hour broadcast fires once without needing any
notion of "already broadcast" — which is fortunate, because no such marker
exists (§1.4).

**The two branches are scoped for different reasons, which this section
originally ran together.** The broadcast argument is the *full-cancel* branch's
(`:171`), reached before the deadline. The *late-cancel* branch (`:160`) runs
only when `now > deadline`, where `getWaitlistWindow` returns `frozen` and
nothing broadcasts at all. Its scope is about money: `late_cancel` is in
`CHARGED_STATUSES` (`class-lifecycle.ts`) and `cancelled` is not, so an unscoped
write landing *after* a teacher's free cancel silently rewrites `cancelled` →
`late_cancel` and bills a student for a class they had been let out of. Both
branches also give the loser of two concurrent cancels the same 409 instead of a
second 200.

`POST /api/waitlist/claim` is unaffected: `claimSpot` (`waitlist.ts:509-606`)
resolves entirely against class state — `FOR UPDATE`, status, window, and a
capacity count against `maxStudents` — and never reads a notification.

### 3.7 `DELETE /api/account` — scope the erasure and abort

`gdpr.ts` sets `deletedAt` in two places, both unscoped `update({ where: { id } })`:
`:486-499` (`Student`, in `deleteStudentAccount`) and `:855-871` (`Teacher`, in
`deleteTeacherAccount`). Change both to `updateMany` scoped by `deletedAt: null`
with a `count === 0` branch that **throws, aborting the transaction**.

Aborting is the operative half. A bare scope would let the second request's
transaction commit anyway and its post-commit `handleSpotFreed` loop
(`:597-603`) broadcast a second time — the exact defect §3 of the branch-1 spec
attributes to this endpoint.

The route maps that abort to the **same 200** a successful erasure returns. The
end state is identical (the account is erased, by the first request), the second
transaction rolled back whole, and the caller's question — "is this account
gone?" — is honestly answered yes. `validateSession`
(`src/lib/auth/session.ts:83-88`) already makes the *sequential* retry a no-op;
this closes the concurrent one. (This paragraph named `resolveSession`, which
does not exist in this codebase. Corrected in source and in one test during the
branch, and missed here until now.)

### 3.8 `POST /api/cron/email-fallback` — claim, then send

`markEmailSent` gains `emailSent: false` in its `where` and returns the updated
count instead of `void`. In the send branch of `email-fallback.ts`, it moves to
**before** `resend().emails.send`:

```
claimed = markEmailSent(db, [id])       // CAS: emailSent false -> true
if claimed === 0 -> continue            // another sweep owns it; do not send
send(...)
if error -> releaseEmailClaim(db, [id]) // back to false, next sweep retries
```

**Shipped differently, and the array-plus-count above was itself the defect.**
The function is `claimEmailFallback(db, notificationId)` in
`src/services/notifications.ts`, answering `'claimed'` or `'already-claimed'` —
one id, a named outcome, no count. The release is a local `releaseOne` inside
`email-fallback.ts`; there is no `releaseEmailClaim`. `claimed === 0` reads
correctly only because every caller happened to pass a one-element array:
batched, it silently means *"I won one of five"* while the sweep goes on to send
all five. The single-id signature makes that batch impossible to write by
accident, and a future batch claim needs a different function returning **which**
ids it won, not how many. Found by the type-design review.

- A **throw** from the claim must also skip the send. The existing `markOne`
  swallows mark errors and logs (`:44-50`); as a claim it must fail closed,
  because "we could not record ownership" and "we own it" are not the same
  state.
- The two non-send call sites (`:136` opted-out, `:143` dry-run) keep marking
  after their decision — there is no external effect to protect, and the CAS is
  harmless there. (Shipped with one change the re-review forced: `markOne` there
  no longer swallows a write failure, because a clean return **clears** the
  scheduler's `lastError` and would drive health green through a claim-write
  outage.)
- **Shipped addition: the three outcomes are a `switch` closed by `const
  unhandled: never`.** What follows the branch is the send, so a fourth outcome
  falling past a chain of `if`s would email a notification nobody had decided
  this sweep owned. The `never` makes adding one a compile error; a separate
  `owned` flag makes the runtime default not-sending, so the two failure modes
  are covered by different mechanisms. A claim that *errors* counts as `failed`
  rather than being skipped like one another sweep already holds — collapsing
  the two would return a clean sweep through an outage that emailed nobody.
- `scheduler.ts:9-10`'s idempotency claim is corrected in the same commit
  (§1.5). It is true of `payment-reminders` and was never true of this job.

---

## 4. Guards, and the mutation that proves each bites

A guard that compiles but cannot fail certifies nothing. Every row below gets
its mutation run, the exact error text recorded, and the mutation reverted.

Two rules carried from branch 1's failures. **Break it the way it actually
broke** — a guard proved against a convenient mutation can be blind to the
realistic one. And **a mutation must use a value the code under test cannot
produce**, so it cannot poison state that a later unrelated run trips over.

| Guard | Mutation that must break it |
|---|---|
| Announcement advisory lock | Remove the `pg_advisory_xact_lock` call → the concurrent double-send test must fail. The *sequential* test must still pass, proving the two tests are not measuring one thing |
| Announcement window predicate | Widen `sentAt >= now - 2min` to no bound → "a legitimate identical announcement 3 minutes later still sends" must fail |
| Announcement `classId ?? null` | Pass `body.classId` through unchanged → an all-students send must wrongly match a class-scoped one |
| Fan-out placement | Move the compare back below `createBulkNotifications` → the assertion on **notification count** must fail while the announcement-row assertion still passes |
| The suppressed send says so | Return `201` and `duplicateSuppressed: false` on the suppressed branch → the component test asserting the teacher is told it was not re-sent must fail |
| Reminder cooldown | Remove the `reminderSentAt` term from the CAS `where` → the second-within-2-minutes test must fail |
| Reminder cooldown expiry | Freeze the clock so the cooldown never lapses → "a reminder 3 minutes later succeeds" must fail |
| Sibling token invalidation | Remove the `deleteMany` → "a second live token for that address is dead after sign-in" must fail |
| Its placement after the expiry check | Move it above the expiry check → "an expired link cannot kill a live one" must fail |
| `student-signup` P2002 catch | Remove the catch → the concurrent fresh-address test must see a 409 instead of two 200s |
| Invitation DELETE status scope | Remove `status: { not: 'declined' }` → the interleaved decline-then-delete test must fail |
| Invitation PUT status scope | Same | Same, on the edit path |
| PATCH exclusion | *Add* the status scope to PATCH → `invitations-api.test.ts:503` must fail. **This mutation proves an absence, and is the only way to prove one** |
| Registration **full**-cancel scope (`:171`) | Revert to `update({ where: { id } })` → the concurrent-cancel test must observe two `spot_available` notification sets. This row holds for the pre-deadline branch only; the late-cancel branch's mutation produces a mis-billing, not a second broadcast — §4.1 |
| Erasure `deletedAt: null` scope | Remove the scope → the concurrent-erasure test must observe a doubled broadcast |
| Its `count === 0` abort | Keep the scope, drop the throw → the same test must still fail, proving the **abort** is what works and not the scope alone |
| Fallback claim-before-send | Move the claim back after the send → the overlapping-sweep test must observe two sends |
| Fallback claim release | Remove the release → "a failed send is retried by the next sweep" must fail |

**Fixtures must not be able to poison shared state.** Every test creates its own
teacher, student and class, and uses addresses and dates outside the seed
window.

### 4.1 Five guards that arrived after this table

The eighteen rows above were written before implementation and all eighteen were
run. Five further guards shipped — from the fix wave and the scoped re-review —
and the table did not grow with them. They were **not** proved by the §4
procedure. What did hold each up, stated exactly, because "a guard that compiles
but cannot fail certifies nothing" applies to these too:

| Guard | What proves it |
|---|---|
| **Late-cancel status scope** (`registrations/[id]/route.ts:175`) | A mutation, run and recorded. Narrowing to `notIn: ['late_cancel']` leaves the `cancelled` → `late_cancel` overwrite live and still answers `[200, 409]`, because both racers start from `registered` — so the first test written here was a duplicate-cancel test wearing the money test's name and could not fail against it. The real money test fails with `expected 'late_cancel' to be 'cancelled'` |
| **Invitation CAS 404-vs-409 split** (`casMatchedNothing`) | A mutation, run and recorded, once this gap was noticed. `invitations-api.test.ts` ("404s a delete whose row vanished mid-request, rather than blaming a decline") holds a delete uncommitted so the request's `deleteMany` parks and finds the row gone; collapsing the helper back to an unconditional `DECLINED()` fails it with `expected 'DECLINED_IS_PERMANENT' to be undefined` — the false statement about a third party, reproduced. The neutral-409 arm remains argument alone |
| **Signup P2002 narrowing** (`isUniqueConflictOn(err, ['email'])`) | Argument alone, and §4's own row for this endpoint hides it: "remove the catch" still passes against the narrowed code, so no mutation in this document can reach the narrowing. The unrecognised-P2002 rethrow has no coverage at all |
| **`releaseOne`'s `emailSent: true` scope** | Nothing, deliberately. Its docblock records it as defensive rather than load-bearing — only the owner releases, and no sweep can claim a row while `emailSent` is true, so the race a looser predicate would lose to cannot occur today. The `count === 0` arm that would report otherwise is uncovered; the release-throws arm is pinned (`email-fallback.test.ts`, "names the stranded claim in the thrown error") |
| **The claim `switch` closed by `const unhandled: never`** | Split. The `'error'` arm has a test ("does not send when the claim itself fails") and a recorded mutation — collapsing it into the skip resolves 0 instead of rejecting. The `never` default is unreachable and enforced by the compiler, not by any test |

**Two of these five are held by neither a mutation nor a test** — the signup
narrowing and `releaseOne`'s scope. Recorded that way rather than backfilled
with mutations that were never run: §5 item 5 is a claim about the eighteen
rows above, and it stays true of them.

Writing this table is what closed the third. The invitation split sat here as
"argument alone, and three reviewers agreeing" — which is the shape of every
guard this project has shipped and later found could not fail. Enumerating them
honestly made that one impossible to leave, and it took one test. The other two
are genuinely lower stakes (one rethrows on a constraint that does not arrive
today; one is documented as defensive rather than load-bearing), and they stay
listed until someone decides otherwise.

---

## 5. Acceptance

1. **Each of the nine is fixed, or documented as legitimate with its reason.**
   Seven get code; `magic-link/send` gets the documented-as-legitimate outcome
   its own decision requires, plus the sibling-invalidation hardening; the
   fallback's two non-send mark sites are unchanged by design.
2. **A test per fixed endpoint issuing the same request twice and asserting the
   side effect happened once — a count, not merely a 4xx on the second.** This
   is #196's stated criterion and it is the one that catches a guard that
   returns the right status while doing the wrong thing.
3. **A concurrent test (both requests in flight) for every row whose defect is
   on the concurrent axis**: announcements, remind, student-signup, both
   invitation verbs, registrations, account, fallback. A sequential-only test
   cannot observe the defect these fix.
4. **The two multi-trigger paths are tested at the shared function, not at the
   route** — `handleSpotFreed` and `processEmailFallback` — since that is where
   the guard has to hold for both callers.
5. **Every mutation in §4 is run, its error text recorded in the PR body, and
   reverted.** Including the two that prove an absence and an abort.
6. **Every corrected claim in §1.5 is fixed in every artifact it appears in** —
   source, docblock, test comment, and the superseded §4.2 of the branch-1 spec,
   which gains a pointer to this file.
7. `npm run verify` green — typecheck, lint, and all three vitest projects.
   Baseline before this branch: **1255 passed, 2 todo, 111 files**.

---

## 6. Scope

**In:** the nine rows of §3, `markEmailSent`'s signature (shipped as
`claimEmailFallback` — §3.8), the new advisory-lock
helper in `db-locks.ts` and its docblock's adopter list, `docs/lock-order.md`,
`scheduler.ts`'s idempotency claim, the two reminder docblocks, the supersession
note on §4.2, and — the branch's only component change —
`send-announcement.tsx` reporting a suppressed send honestly, with the first
component test that file has ever had.

**Out, and named so nobody re-derives them:**

- **No migration.** That is this branch's defining constraint. The `email` index
  on `MagicLinkToken` (§2.1) is the one place it costs something, and the cost
  is microseconds on a table swept daily.
- **Device-bound magic links** (§2.1) — filed, not built.
- **`handleSpotFreed`'s missing capacity check.** Its sibling `claimSpot`
  compares active registrations to `maxStudents` (`waitlist.ts:550-555`) and the
  broadcast branch (`:658-675`) does not, so it can announce a spot that has
  already been refilled. **This is a live bug and it is filed, not folded** — it
  is a wrong-content defect, not a duplication one, and folding it would put an
  unrelated product judgement inside a retry-safety branch.
- **The three non-race paths that also end a tombstone** — `gdpr.ts:834`
  (teacher erasure deletes that teacher's invitations), `gdpr.ts:415` (student
  erasure moves the row off the `(teacherId, email)` key), `link-consent.ts:82`
  (booking flips `declined` → `accepted`). All three are deliberate, documented
  product decisions, and none is a duplicate-submit shape.
- **`P2025` surfacing as a 500** on two delete routes — #197's family, as the
  branch-1 spec already recorded.
- **The duplicated reminder notification body** between `payments.ts:219` and
  `payment-reminders.ts:90`. Pre-existing debt this branch makes visible without
  making worse.
- **`edit-room-form.tsx`'s two sequential PUTs**, parked in #196's Update. A
  client-side atomicity question, not a duplication one.

---

## 7. Risks, and what is not known

**The SSE emit inside a transaction (§3.1) is the weakest point in this
design.** Moving `createBulkNotifications` into a transaction means a rollback
can leave bus events already emitted. It is pre-existing shape rather than
something this branch introduces, the window is short, and the only rollback
source is a database error — but it is the claim most likely to be wrong, which
is why it is stated rather than buried.

**Claim-before-send trades a duplicate for a drop** (§2.3). The reasoning is
recorded there. If a crash between claim and send ever proves more common than
argued, the release path is the place to add a timeout-based reclaim.

**The concurrent tests are the hard part of this branch, not the fixes.** Every
mechanism here is a few lines; what makes them provable is a test that genuinely
interleaves two requests. Branch 1's biggest defect was found by a probe rather
than a review, and the same is likely here.

**No production database exists yet**, so nothing in this branch needs a
pre-flight data check — unlike branch 1, whose indexes could have failed against
violating rows.
