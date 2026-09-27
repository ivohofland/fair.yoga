# Archiving a student means "nothing live with me" (#265)

**Status:** design agreed 2026-09-27. Issue #265 was filed with the product
question open; this spec records the answer and the build.

## The decision

Archiving a student is the teacher's statement that this person is **no longer
an active student of theirs** (the issue's option (b)). It is the teacher's
filing, not a restriction on the student: an archived student can still book,
join a waitlist, or accept an invitation, and doing so makes them active again.

That gives one invariant, per `(teacher, student)` link:

> **An archived link has nothing live.** No open payment (`pending`/`overdue`)
> from that student to that teacher, and no registration that a completion
> would still bill.

Everything below either refuses to break that invariant (archiving) or restores
it by clearing the flag (every act that creates something live).

## What the issue got right, and what moved

Re-measured on `fb61333b` (origin/main, 2026-09-27). The issue was filed at
`eefeb18`.

- **Held:** claims 1 and 4–9. Archiving is one unlocked `findUnique` + `update`
  (`api/students/[id]/route.ts:125-140`); roster, seat count and auto-cancel never
  read the flag; announcements and dunning ignore it; the button has no confirm;
  the walk-in picker hides archived students the API accepts; no test covers any
  of it.
- **Changed, claim 3:** the five `upsert({ update: {} })` link sites are gone.
  Since #181 every link is `linkTeacherStudent` (`services/roster-link.ts:54`),
  `INSERT … ON CONFLICT DO NOTHING`. Six callers: self-booking, `completeWalkIn`,
  `addToWaitlist`, `promoteNext`, `claimSpot`, `acceptInvitation`. None clears the
  flag. That is one change point, not five.
- **Changed, claim 2:** the flag has more readers than the directory now — the
  teacher detail page, and the student's own privacy page ("Archived by {teacher}
  in their records", `teacher-privacy-card.tsx:180-184`). The latter stays; see
  *Not changed*.
- **Not in the issue — the teacher roster add links nothing.** `POST
  /api/registrations` for `subject.kind === 'roster'` checks the link exists with
  an unlocked read *outside* the transaction (`route.ts:129-132`) and never calls
  `linkTeacherStudent`. It is the one registration-creating path that would not
  un-archive through the chokepoint, and it may not call the chokepoint either:
  `linkTeacherStudent` inserts, and a teacher may never create a link
  unilaterally (CLAUDE.md, Data Model). The check's position outside the
  transaction also lets a concurrent `unlinkTeacher` land between check and
  registration; the new in-transaction check closes that too.
- **Not in the issue — the lock that is not there.** `ON CONFLICT DO NOTHING`
  against a committed row takes **no lock** (`docs/lock-order.md`, the
  `acceptInvitation` conformance entry). Without one, a booking and an archive
  interleave into the exact state the invariant forbids — see *Concurrency*.

## "Live", precisely

A **live registration** for `(teacher, student)`:

- `status ∈ CHARGED_STATUSES` (`services/class-lifecycle.ts:651` —
  `registered`, `attended`, `no_show`, `late_cancel`), **and**
- its class's `status ≠ 'completed'`, **and**
- its entry's `cancelledAt IS NULL`, **and**
- the class's entry belongs to that teacher.

`CHARGED_STATUSES`, not `ACTIVE_REGISTRATION_STATUSES`: the question is "will
completion bill this?", and `late_cancel` frees the seat but still bills
(`registration-status.ts:11-14`). Using the charged set also makes the
attendance PATCH (`api/registrations/[id]/route.ts`, `late_cancel → attended`)
irrelevant: it moves within the set, so it can never make a non-live
registration live.

An **open payment**: `status ∈ OUTSTANDING_STATUSES` (`lib/payment-status.ts`),
on a registration of that student, on a class of that teacher — the predicate
`countOutstandingPaymentsForStudent` (`services/payments.ts:420`) already uses.

Waitlist entries are not live: they carry no money, and every way off a waitlist
onto a roster (`promoteNext`, `claimSpot`) links, and so un-archives.

## Archiving: `PATCH /api/students/[id]?state=archived`

Order of checks — gates first, then "already done", then refusals:

1. Session is a teacher (403, as today).
2. Query parses (400, as today).
3. Ownership: the link exists (403 `Student not in your contacts`, as today).
4. **Already archived → `respondUnchanged`** (was `respondOk({action:'unchanged'})`;
   CLAUDE.md, *Refusals carry a registered code*). The invariant makes the
   refusals below moot for an archived link, so this goes before them. A
   `waivePaymentIds` sent with it is ignored — nothing can be outstanding.
5. In one transaction, starting with the `TeacherStudent` row lock:
   1. Count live registrations. If any: **409 `STUDENT_HAS_UNBILLED_CLASSES`**,
      message naming the count ("…is booked on 2 classes that haven't been billed
      yet. Remove them from those classes, or archive after they're completed.").
      Checked before payments, because waiving cannot resolve it.
   2. Read the open payment set `S`.
      - No `waivePaymentIds` in the body and `S` empty → archive.
      - No `waivePaymentIds` and `S` non-empty → **409
        `STUDENT_HAS_OUTSTANDING_PAYMENTS`**, message naming count and total.
      - `waivePaymentIds = W` and `W = S` as sets → mark every payment in `S`
        `not_charged` (same write as `markPaymentNotCharged`:
        `status`, `notChargedAt`), then archive.
      - `waivePaymentIds = W` and `W ≠ S` → **409
        `STUDENT_HAS_OUTSTANDING_PAYMENTS`**, message saying the amount owed has
        changed and naming the new count and total. Nothing is written.
6. Answer `respondOk({ isArchived: true, action: 'archived', waivedCount })`.

`W = S` is the ownership check for the waive as well as the staleness check:
`S` is computed from this teacher's classes and this student's registrations, so
an id belonging to anyone else is never in `S` and fails equality. No payment id
from the body reaches a write except as a member of `S`.

The body is JSON `{ waivePaymentIds?: string[] }`, validated with zod (unique
cuid strings, bounded length). Un-archiving (`state=unarchived`) is unchanged
apart from also answering `respondUnchanged` when already active.

### Why the ids, not a flag

A bare "waive everything" flag waives what is outstanding *at write time* — which
can include a payment created by a completion after the teacher read the
confirm. Sending the ids makes the confirm a compare-and-swap on exactly what
the teacher saw. The inverse direction (a payment the teacher saw has since been
marked paid) also refuses rather than silently waiving less; the teacher re-reads
a smaller number and confirms again.

## Un-archiving: every act that makes something live

A new function in `services/roster-link.ts`, alongside `linkTeacherStudent`:

```ts
export type LinkActivation = 'active' | 'reactivated' | 'missing';
export async function activateTeacherStudentLink(
  tx: Prisma.TransactionClient,
  pair: Prisma.TeacherStudentTeacherIdStudentIdCompoundUniqueInput,
): Promise<LinkActivation>
```

It takes the `TeacherStudent` row lock (`SELECT … FOR UPDATE`), returns
`'missing'` if there is no row, and otherwise clears `isArchived` if set
(`'reactivated'`) or leaves it (`'active'`). It never inserts.

Callers:

| Act | Where | How |
|---|---|---|
| Self-booking, walk-in, waitlist join/promote/claim, invitation accept | the six `linkTeacherStudent` callers | `linkTeacherStudent` calls `activateTeacherStudentLink` after its insert; its own return value (`LinkOutcome`) is unchanged, so `resolveInvitationOnLink` is untouched |
| Teacher roster add | `POST /api/registrations`, roster subject, inside the transaction after the registration write | calls `activateTeacherStudentLink` directly; `'missing'` refuses 403 `Student is not in your roster` and rolls back. The pre-transaction check stays as the cheap early answer |
| Reopening a payment | `reopenPayment` (`services/payments.ts:222`) | becomes a transaction: read the payment's `(teacher, student)`, lock the link, then the existing CAS; on `applied`, the link is reactivated. `'missing'` (student unlinked) does not refuse — money can be owed without a link (`unlinkTeacher`'s docblock) |

`completeClass` needs no call: under the invariant it never bills an archived
student's registration, because such a registration would have been live and
refused the archive.

## Concurrency

The race the lock closes, without it:

1. A booking inserts its `Registration` (uncommitted); `linkTeacherStudent`'s
   insert conflicts with the committed link and takes no lock.
2. An archive reads live registrations — the booking's is invisible — finds
   none, archives, commits.
3. The booking commits. Archived link, live registration.

With `activateTeacherStudentLink` in every live-making path and the archive
taking the same row lock first, the two serialise on the `TeacherStudent` row
in either order:

- **Archive first:** the booking's lock waits; after the archive commits, the
  booking clears the flag it just set.
- **Booking first:** the archive's lock waits until the booking commits; its
  count, a fresh statement under READ COMMITTED, sees the registration and
  refuses.

The same argument covers `reopenPayment` vs archive, and `completeClass` needs
none: its registrations were already live and visible before it ran, so an
archive concurrent with it refuses on the registration (before commit) or on the
payment (after).

### Lock order

Canonical line today (`docs/lock-order.md:7`):
`Student → Class → WaitlistEntry → Registration → StudentPrivacy → TeacherStudent → Invitation → TeacherBlock`.
`Payment` is not on it; `completeClass`'s conformance entry places it after
`Registration`.

This change adds `Payment` **after `TeacherStudent`**:
`… → StudentPrivacy → TeacherStudent → Payment → Invitation → TeacherBlock`.

- Archive: `TeacherStudent` (lock) → reads `Registration`/`Payment` unlocked →
  writes `Payment` (waive) → writes `TeacherStudent`. Conforms.
- `reopenPayment`: `TeacherStudent` → `Payment`. Conforms.
- Booking paths: `… → Registration → TeacherStudent` (+ `Invitation`). Unchanged
  in order; `TeacherStudent` becomes an actual lock where it was often none.
- `completeClass`, `markPaymentPaid`, `markPaymentNotCharged`, the reminder
  sweeps: `Payment` without `TeacherStudent`. Unaffected.

The plan must census every transaction that locks both a `Payment` row and one
of `Invitation`/`TeacherBlock`/`TeacherStudent` before fixing the position —
this spec's placement is checked against the writers found by
`grep -rnE "payment\.(create|update|updateMany|delete|deleteMany|upsert)\(" src`
(8 sites = 5 in `payments.ts` + 2 in `payment-reminders.ts` + 1 in `class-lifecycle.ts`, none
touching `TeacherStudent`), and the erasure paths in `gdpr.ts` must be read,
not grepped, per *A new lock node needs every mode*.

## Announcements

`POST /api/announcements`, all-students scope: the recipient query
(`route.ts:44-53`) excludes students whose link with this teacher is archived
(`student: { teacherStudents: { none: { teacherId, isArchived: true } } }`).
Students with no link at all keep today's behaviour. The class-scoped send is
unchanged — under the invariant an archived student holds no live registration
on a class that can still be announced to.

## UI: `ArchiveStudentButton`

The detail page already renders the student's payments with ids, amounts and
statuses (`students/[id]/page.tsx:134-146`). It passes the outstanding subset to
the button as a prop.

- **Nothing outstanding:** "Archive student" sends the plain PATCH, as today.
- **Something outstanding:** "Archive student" opens an inline confirm (the
  `CancelClassButton`/`RemoveStudentButton` pattern — no shared sheet component
  exists): "{Name} still owes €45.00 across 3 classes. Archiving waives these
  payments." with **Waive and archive** / **Keep**. Waive sends the ids.
- **`STUDENT_HAS_OUTSTANDING_PAYMENTS` back** (the prop was stale, either way):
  `router.refresh()` so the prop is re-read, and show the server's message; the
  confirm re-opens with the fresh numbers on the next tap. The prop is an offer,
  never a gate — the server's equality check is the gate (*server-snapshot
  props go stale*).
- **`STUDENT_HAS_UNBILLED_CLASSES` back:** show the message, no action offered.
- Success navigates to `/students`, as today.

Copy follows the design brief: money as text, no badges; "Waive and archive" is
a primary action, not danger-styled — waiving is lenience, not destruction.

## Docs

- `docs/data-model.md`: a `TeacherStudent` section (line 186 already points at
  one that does not exist) stating the invariant, the live predicate, and the
  un-archive rule.
- `docs/product-concept.md`, CRM section: what archiving means for the teacher.
- `docs/lock-order.md`: `Payment` on the canonical line, the new
  `TeacherStudent` lock node, conformance entries for archive and
  `reopenPayment`, and a note on the `acceptInvitation` entry that its "takes no
  lock" insert is now followed by an explicit row lock.
- Comments at `api/students/[id]/privacy/route.ts:23` and
  `teacher-privacy-card.tsx:41` that describe archiving as filing: re-read and
  correct against this spec.

## Not changed

- **The student-visible caption** "Archived by {teacher} in their records" stays.
  It is the teacher's record about them, and GDPR transparency favours showing
  it; archiving still does not restrict the student.
- **Dunning.** No policy change is needed: an archived student cannot have an
  open payment, so `sendPaymentReminders` never reaches one.
- **The walk-in picker** keeps hiding archived students. The teacher un-archives
  first; the API path un-archives if reached anyway.
- **Pre-existing archived links with live things.** Not in production yet
  (no backfill); dev data may hold such links, and nothing breaks — the next
  archive attempt is a no-op `unchanged`, the next live act clears the flag.

## Testing

Integration (`--project integration`):

- Archive refusals: live registration (each of `registered`, `late_cancel`;
  a completed class's and a cancelled class's registrations do **not** refuse);
  open payment (`pending`, `overdue`; `paid`/`not_charged` do not). Assert codes,
  never message text.
- Waive-and-archive: `W = S` waives all and archives; `W ⊂ S`, `W ⊃ S`, a
  foreign teacher's payment id in `W` — all 409, nothing written.
- `respondUnchanged` for an already-archived and an already-active link.
- Un-archive: one test per act — self-booking, walk-in, waitlist join, promote,
  claim, invitation accept, teacher roster add, `reopenPayment`.
- Teacher roster add after the student unlinked mid-request → 403, no
  registration.
- Announcements: all-students skips an archived student, reaches an active one.

Race (a lock-order test beside `route-lock-order.test.ts`, same
`waiterOf`/`pg_stat_activity` handshake): booking holds its transaction open
after the registration write; archive must block on the `TeacherStudent` lock
and then refuse. And the reverse order: archive holds, booking waits, ends
un-archived.

Guards to break (plan records exact error text for each):

- Remove the `FOR UPDATE` from the link-lock query (the plan splits it into
  `lockTeacherStudentLink`, which `activateTeacherStudentLink`, `reopenPayment`
  and `archiveStudent` all use) → the race test goes red.
- Drop `late_cancel` from the live predicate (switch to
  `ACTIVE_REGISTRATION_STATUSES`) → the `late_cancel` refusal test goes red.
- Replace `W = S` with `W ⊆ S` → the `W ⊂ S` test goes red.
- Remove the un-archive call from each path → that path's test goes red.

Component: the button's three branches (plain, confirm, each 409).
