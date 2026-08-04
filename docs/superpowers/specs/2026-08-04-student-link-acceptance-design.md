# Linking a student to a teacher requires that student's acceptance (#166)

**Status:** design agreed, ready for a plan
**Issue:** #166 — spun out of #162 / PR #165
**Date:** 2026-08-04

The product decision was already made before this document: a teacher may not
attach themselves to a student unilaterally. What was open was the design, and
the issue listed six questions. All six are answered below, and answering the
third one first collapsed most of the feature.

---

## Corrections to the issue's premise

The issue's framing is sound but three of its statements need adjusting, and one
thing it does not mention turns out to be in scope.

### 1. Question 3 is already answered by the code, in the affirmative

The issue asks whether registering for a class constitutes acceptance and treats
it as open. It is not: **the codebase already draws exactly the line the issue
wants**, everywhere except the one route the issue is about.

`src/app/api/registrations/route.ts:198-205` creates the link, and only under
`if (!isTeacher)`:

> "A self-booking student joins the teacher's roster: this link is how the CRM
> sees them and how per-teacher privacy gets its scope."

The teacher-initiated branch of that same route (`:88-93`) *requires* a link and
never creates one — a teacher registering a roster student or adding a walk-in
gets 403 `'Student is not in your roster'` if no link exists. So student-initiated
acts create links; teacher-initiated acts consume them. The one exception in the
whole codebase is `POST /api/students`.

The student-facing copy already says so out loud. `src/app/(student)/account/privacy/page.tsx:59`,
the empty state on the page that lists a student's teachers:

> "Book a class first — teachers appear here once you're connected."

**Consequence: the invitation path covers `POST /api/students` and nothing else.**
The issue's "shape of the work" paragraph anticipates a change across schema,
notifications, a student surface, a migration and a teacher-side pending view. The
first three hold. The data migration does not (see Q5), and none of the nine
surviving sites that read a `TeacherStudent` link needs to change at all (see
"Why a separate table").

### 2. The waitlist path is a live bug the issue does not name

`src/services/waitlist.ts:344` (`promoteNext`) and `:443` (`claimSpot`) both call
`activateRegistration` and then touch only `WaitlistEntry` and notifications.
Neither upserts `TeacherStudent`; `grep teacherStudent src/services/waitlist.ts
src/app/api/waitlist/` returns nothing. Joining the waitlist
(`src/app/api/waitlist/route.ts:28`) does not create one either.

So a student who joins a full class's waitlist and is promoted has an active
`Registration` and **no roster link**. This is the mirror image of the issue —
consent given, no link created — and it is broken today. Measured consequences:

| | outcome |
|---|---|
| Teacher's class detail page, attendance, payment checklist, reminders | **Work normally.** All registration-scoped (`(teacher)/class/[id]/page.tsx:38-51`, `services/class-lifecycle.ts:165-234`, `services/payments.ts:130-172`). |
| Name shown to the teacher | **No leak.** `class/[id]/page.tsx:61-64` consults `StudentPrivacy` and defaults closed, so `formatStudentName` (`src/lib/format.ts:7-13`) renders "Anna d." |
| Teacher's CRM list | **Absent**, and absent from `total` — `api/students/route.ts:21-32, 65`. |
| Teacher's `/students/[id]` page | **Silent `redirect('/students')`** (`page.tsx:41`) — reachable as a dead link from `payment-checklist.tsx:76`. |
| Archive / remove / add as a later walk-in | **403** (`students/[id]/route.ts:231`, `:192`; `registrations/route.ts:92`). |
| Student setting per-teacher privacy | **403 `TEACHER_NOT_LINKED`** (`students/[id]/privacy/route.ts:107-110`). The privacy card never renders. |
| Announcements reaching them | **Yes** — recipients are registration-scoped (`announcements/route.ts:34-65`) — **and they cannot mute it.** The opt-out at `:56-63` needs a `StudentPrivacy` row, which needs a link. Absent row means included. |
| 500s / crashes | **None.** Every failure is a 403, a redirect, or a silent absence. |

Net: **visible and billable, but unmanageable and consent-less.** The last row is
the same defect this issue exists to fix, pointing the other way: a teacher can
announce to someone who is locked out of the controls that would silence them.
That is why it is folded in rather than filed.

### 3. A hypothesis about the unclaimed path, checked and refuted

`students/[id]/route.ts:51` treats an unclaimed student as carrying *no* privacy
restrictions, so a probed unclaimed row looked like it might disclose another
teacher's typed phone, birthday and address. **It does not.** The teacher `PUT`
branch parses with `createStudentSchema` (`:146`), which admits only
`firstName`/`lastName`/`email`; `phone`, `birthday` and `address` are writable
only on the self-edit branch (`:83-104`), which requires a session with a
`studentId` and therefore a claimed account. Unclaimed rows never carry those
fields in the first place. #165's account of the residual — name plus a default
`incomeTier` — is accurate and does not need widening.

### 4. Held, as written

- **No invitation concept anywhere in the codebase.** Confirmed: `grep -i invit`
  over `src/` and `prisma/` hits only UI copy (`booking-flow.tsx:29`,
  `tiers.ts:63`) and four documentation mentions. No schema, no route, no service.
- **`POST /api/students` sends no notification on either branch.** Confirmed by
  reading the whole handler (`route.ts:105-186`): no `createNotification` /
  `createBulkNotifications` import and no email call.
- **A student cannot remove a teacher.** Confirmed across all 52 `route.ts` files
  under `src/app/api` and all 7 pages under `src/app/(student)`. The only
  `teacherStudent.delete*` calls are `students/[id]/route.ts:198` (teacher-gated
  at `:177`), `services/gdpr.ts:223` (full student erasure) and `:363` (full
  teacher erasure). Cancelling a registration does not remove the link.
- **`incomeTier` and `firstName` return unconditionally** to any linked teacher
  (`students/[id]/route.ts:55, :57`). There is no `shareIncomeTier` flag.

---

## Answers to the six design questions

**Q1 — Does the unclaimed path need consent too?** Resolved by construction. No
`Student` row is created for anyone who has not agreed. A CRM contact is an
`Invitation` row: a record the teacher typed themselves, which is their own
business record, rather than the platform minting a profile for a stranger.

**Q2 — Decline semantics.** A tombstone that is permanent from the teacher's side
and always reversible from the student's. Decline sets `status = declined`; the
row stays and `@@unique([teacherId, email])` makes it un-re-invitable. The teacher
keeps the contact data they entered. The student's own booking of that teacher's
class re-establishes the link and clears the tombstone. Neither horn of the
issue's dilemma bites: no harassment vector, and no trap.

**Q3 — Does registering constitute acceptance?** Yes. See "Corrections" §1.

**Q4 — Unlink.** A student-side route deletes the `TeacherStudent` row and writes
the same declined tombstone. Registrations and payments survive — they are facts,
and money may be owed; the teacher continues to see them through the
registration-scoped surfaces. This matches #167's decision that privacy flags win
even when payment is owed, because reminders are in-app and blocking is the
escalation.

**Q5 — Migration.** No *data* migration. The system is not in production, so the
schema change ships as a plain create-table migration that touches no existing
row, `prisma/seed.ts` is rewritten to the new model, and the database is reset and
re-seeded. The issue's premise — "every existing `TeacherStudent` row is
implicitly accepted" — is true and costs nothing, because a separate table needs
no backfill in the first place.

**Q6 — Where does the student accept?** A `teacher_invitation` notification through
the existing three-layer model, linking to a "Pending invitations" section at the
top of `/account/privacy` — already the page that lists a student's teachers, and
whose empty state already frames it that way. No new page and no new top-level
student destination.

**Q7 — Can the response hide existence?** Yes, and this is what finally closes the
oracle #165 could only meter. See "The oracle, stated precisely".

---

## Design

### The entity

```prisma
enum InvitationStatus {
  pending
  accepted
  declined
}

enum InvitationOrigin {
  teacher_invite  // a contact the teacher typed — theirs to see and manage
  student_block   // a block the student created by unlinking — never listed
}

model Invitation {
  id          String           @id @default(uuid())
  teacherId   String
  email       String
  firstName   String           @default("")
  lastName    String           @default("")
  status      InvitationStatus @default(pending)
  origin      InvitationOrigin @default(teacher_invite)
  isArchived  Boolean          @default(false)
  createdAt   DateTime         @default(now())
  respondedAt DateTime?

  teacher Teacher @relation(fields: [teacherId], references: [id], onDelete: Cascade)

  @@unique([teacherId, email])
}
```

`TeacherStudent` is **not modified**. It keeps meaning exactly what it means
today: an accepted link.

**Why `origin` exists, and why it is not optional.** A link created by booking
gives the teacher no access to the student's address — `shareEmail` defaults to
false (`(student)/account/privacy/page.tsx:14-21`). If that student later unlinks
and the tombstone is written as an ordinary `Invitation` row, `GET /api/invitations`
hands the teacher an email address they never had. The student's act of leaving
would disclose more than staying did.

So `origin` records who created the row. `student_block` rows are **never returned
by any teacher-facing query** — they exist only to be hit by the uniqueness check
on re-invite. Rows that started as `teacher_invite` and were later declined stay
visible, because the teacher typed that address themselves and already has it.

This was found while planning, not while designing; it is recorded here rather
than only in the plan because the spec is what the next reader will trust.

### Why a separate table rather than a pending state on `TeacherStudent`

A nullable `acceptedAt` on the existing table would require every read site that
consults a link to also filter on acceptance. A census found **8 hard gates** that
403 or redirect on a missing link —

`api/students/route.ts:22` · `api/students/[id]/route.ts:36-39`, `:137-140`,
`:192-195`, `:231-234` · `api/students/[id]/privacy/route.ts:36-42` (called at
`:61` and `:107`) · `api/registrations/route.ts:89-92` ·
`(teacher)/students/[id]/page.tsx:23-26, :41`

— plus **4 soft reads** (`(student)/account/privacy/page.tsx:28-32`,
`api/students/route.ts:162-167`, `api/students/[id]/route.ts:201-206`,
`services/gdpr.ts:31-33` and `:84-88`). Twelve sites, and any one of them missing
the filter silently reinstates the exact bug this issue exists to remove. A
separate table means none of the twelve changes and the invalid state is not
representable.

(Three of the twelve — `students/[id]/route.ts:137-140`, `:192-195`, `:201-206` —
disappear anyway when the dead `PUT` and `DELETE` branches go. The count is what
the *rejected* alternative would have had to audit against today's code, and it
is measured against today's code. Nine sites survive this change untouched.)

There is no raw SQL to audit: the 11 `$queryRaw`/`$executeRaw` call sites in
`src/` and `prisma/` are `SELECT 1`, the class row lock, and the generator
advisory locks. None names the table.

### The two ways a link comes into existence — both student-initiated

1. **The student accepts an invitation.** Creates `TeacherStudent`, sets
   `status = accepted` and `respondedAt`.
2. **The student books or waitlists one of that teacher's classes.** The existing
   upsert at `registrations/route.ts:201` already does this; it additionally
   resolves any `pending` invitation for that pair to `accepted`, and clears a
   `declined` tombstone.

### Which email identifies the invitee, and who can accept

Match on **`Account.email`** — the authenticated identity. `Student.email` is a
denormalized copy, and the schema comment at `prisma/schema.prisma:104-107` states
that live linked profiles match the account's email by construction and that there
is deliberately no email-change flow, so the two agree; `Account.email` is
nonetheless the right thing to key on, because it is the address the person proved
they own.

Three arrival states, all of which the surface must handle:

| invitee | what happens |
|---|---|
| Signed-in student | Invitation appears on `/account/privacy`; accept or decline there. |
| No account | The email links to signup. After the magic link, the invitation is waiting on `/account/privacy` — they are not auto-linked by signing up. |
| Teacher-only account (no student profile) | They cannot hold a link without a `Student` row. The pending-invitation section prompts them to add a student profile (`POST /api/account/student-profile`), then accept. Not a silent failure and not an auto-create. |

### Route changes

| route | change |
|---|---|
| `POST /api/students` | Creates an `Invitation` only. No `Student` row, no `TeacherStudent`, on any path. 409 if this teacher already has an invitation or a link for that address — their own data, so no disclosure. |
| `PUT /api/students/[id]` teacher branch (`:107-164`) | **Removed.** It refuses claimed students at `:133`, so its only purpose was editing unclaimed contacts; contacts are now `Invitation` rows, edited through their own route. This is the unmetered twin oracle the #165 PR review found — deleted outright rather than left metered. `edit-student-form.tsx` repoints to the invitation route. |
| `DELETE /api/students/[id]` | **Removed, for the same reason.** It refuses claimed students at `:188-190`, so it too served only unclaimed contacts. Removing a *contact* is `DELETE /api/invitations/[id]`; parting with a *linked* student is `PATCH ?state=archived`, which is already the mechanism and already works for claimed students. `remove-student-button.tsx` repoints to the invitation route. This also deletes the orphan cascade at `:201-206` (delete the `Student` row when its last link goes) — not because it could fire on the student-side unlink, it is a different handler, but because it is the only precedent in the codebase for that behaviour and the new route must not be written by copying it. |
| `GET /api/invitations` | Teacher's contacts, for the CRM "Contacts" section. Separate from `GET /api/students` rather than a union — paginating and searching across two tables for one list is not worth the complexity, and the two-section directory matches the existing row-based pattern. |
| `PUT`/`DELETE /api/invitations/[id]` | Teacher edits or removes a contact. **Both are refused on a `declined` row** — see below. `PUT` as well as `DELETE`, because the tombstone is keyed on `(teacherId, email)`: editing the address on a declined row moves the tombstone off the person who declined and frees their address for a fresh invitation. Deleting and editing are the same hole through two doors. |
| `PATCH /api/invitations/[id]` | Teacher archives/unarchives, mirroring `PATCH /api/students/[id]?state=` exactly. |
| `POST /api/invitations/[id]/accept`, `/decline` | Student-authed. Accept creates the link; decline writes the tombstone. |
| `DELETE /api/teacher-links/[teacherId]` | Student-authed unlink. Deletes the `TeacherStudent` row for the session's `studentId`, then upserts the tombstone: **update** an existing row to `declined` (keeping `origin: teacher_invite`, since the teacher typed that address), or **create** one with `origin: student_block` when the link came from a booking and no invitation ever existed. The student's own `Student` row survives unconditionally — unlinking a last teacher must not orphan-delete an account. (The one code path that did that, `students/[id]/route.ts:201-206`, is removed by the row above; this route must not reintroduce it.) |
| `services/waitlist.ts:344`, `:443` | Gain the same link upsert `registrations/route.ts:201` has, and the same invitation resolution. |

### The tombstone hole, and the fix

If a teacher can delete a `declined` invitation, they delete it and re-invite, and
the anti-harassment property evaporates. So **`DELETE` is refused on a declined
row.** A teacher stuck with a declined contact cluttering their CRM forever is bad
UX, so they may **archive** it (`isArchived`, mirroring `TeacherStudent.isArchived`)
— hidden from the list, row surviving as the tombstone.

**The same hole has a second door.** The tombstone is keyed on
`(teacherId, email)`, so *editing* the address on a declined row moves it off the
person who declined and frees that address for a fresh invitation. `PUT` is
refused on a declined row for the same reason `DELETE` is. This was found while
writing the plan, not while designing — the route table originally guarded only
the delete.

Both are called out explicitly because this is the shape of defect the project
keeps finding at review: a guard that exists and cannot fail. The plan includes a
test that deletes a declined invitation, confirms the refusal, archives it, and
confirms a subsequent `POST /api/students` for the same address is *still*
refused — archiving must hide the row without disarming it.

### The oracle, stated precisely

**What closes it:** no observable output branches on whether the address is on the
platform. Same status, same body, same `Invitation` row, either way.

**What does not close it, and must not be claimed:** the route still *reads*
`Student` — it has to, to decide whether to create an in-app notification
alongside the email, and to respect `Student.emailNotifications` if a row exists.
Writing "the route performs no lookup" would be false. The property is about the
response, not about the absence of a query.

**What remains observable, and why it is acceptable:** an attacker who invites
10,000 addresses and waits learns which ones a *human* responded to. That is not a
database oracle — acceptance is necessarily observable anyway (the student appears
in the CRM), so surfacing "declined" adds no new class of information. The
enumeration bit #165 metered at 50/hour is gone.

### The block oracle, found during the build

**Filtering the list was not enough, and the refusal code reopened the same hole.**
`origin: 'student_block'` keeps a student's address out of `GET /api/invitations`
(§"Why `origin` exists"). But `inviteContact` refuses *any* declined row with 409
`DECLINED` — and a `student_block` row is declined. So a teacher probing addresses
got 409 for the one belonging to a student who unlinked, and 201 for everything
else. They already know *someone* left: the class roster and payment history still
show "Anna d." The 409 hands them the address `shareEmail` withheld. Rate-limited,
and it needs a correct guess — but a former student's address is guessable when you
know their name, which the roster gives you.

**Decision: silent block, for `student_block` rows only.** Such an invite answers
exactly as a fresh one does — 201 with an id — and creates nothing, sends nothing.
The teacher sees "invitation sent"; it never arrives. This is the standard
anti-harassment pattern, and it is the same principle the rest of the feature rests
on: the response must not depend on what the database knows.

`teacher_invite` rows that were declined keep their honest 409. That address is one
the teacher typed themselves, so refusing discloses nothing they did not already
have, and a teacher who invited someone deserves to know the invitation is dead
rather than re-sending into silence.

**The cost, stated rather than glossed:** the teacher is genuinely misled. If they
follow up in person, the student may face a conversation they were trying to avoid.
That is the accepted trade — the alternative hands a person's contact details to
someone they deliberately walked away from.

**How this was found is worth recording.** Not by a reviewer reading the diff — the
refusal lives in `inviteContact`, which no task after Task 3 touched, so every
task-scoped review was structurally blind to it. It surfaced from a whole-repo sweep
of every `Invitation` consumer, run to resolve a reviewer's "cannot verify from
diff" note. The lesson generalises: a property enforced in one file is not verified
by reviewing the file that depends on it.

`POST /api/auth/student-signup` is the model to follow. Its docblock already
states the property this route is adopting: *"The response is identical whether
the email was new, an existing student, or a teacher — no account enumeration."*

### Notification and email

- Add `teacher_invitation` to `NotificationType` (currently 9 values,
  `prisma/schema.prisma:85-95`).
- **Not** essential. `ESSENTIAL_NOTIFICATION_TYPES`
  (`services/notification-policy.ts:16-21`) is `class_cancelled`,
  `waitlist_promoted`, `spot_available`, `payment_request` — those bypass
  `Student.emailNotifications`. An invitation from a stranger is not in that
  class.
- Delivery: an in-app `Notification` when a `Student` row exists; an email to the
  address unless an existing `Student` row has `emailNotifications: false`. Both
  decisions are server-side and neither reaches the response.
- Email to arbitrary addresses is a spam vector, metered by the existing
  `checkStudentWriteLimit` (50/hour per teacher, shared with the write routes).
  The invitation email body must not disclose whether the address was already
  registered.

### Seed and database

`prisma/seed.ts` currently creates two CRM-only students — Lena Visser and Max
Dekker (`:243-258`) — as unclaimed `Student` rows, and links all twelve (10
claimed + those 2) to Ivo at `:293-302`. Rewritten: the two CRM-only students
become `pending` `Invitation` rows and no unclaimed `Student` row is seeded, so
Ivo's link loop covers 10, not 12. Sarah's three links (`:304-312`) are all to
claimed students and are unaffected. Add one `declined` invitation so the
tombstone path has a fixture. Then `npm run db:reset` (`prisma migrate reset` —
drops, re-migrates, re-seeds).

**The seed change breaks no tests. Measured, after an earlier draft of this
document worried that it would.** `grep -rl 'unclaimed\|claimedAt'
tests/integration/` returns 11 of the 21 files, and an earlier draft called
classifying them "the plan's first task". Classified: **all 11 are
self-fixturing.** Every one mints its own teacher and students in `beforeAll`
under a `uniqueSuffix()`. Nothing in `tests/` reads `lena@example.com` or
`max@example.com` — `grep -rn` over `tests/ src/ prisma/` returns exactly two
hits, `prisma/seed.ts:248` and `:255` — and no test asserts on a count the seed
produces (`students-api.test.ts` asserts `total: 25` against 25 students it
creates itself at `:30-41`). No e2e test visits a `/students` CRM page at all.

What *does* break is smaller and entirely in two files:

- **Removing the teacher `PUT` branch** breaks 3 tests and hollows out a 4th:
  `students-api.test.ts:950` (`'returns only the id when a teacher edits an
  unclaimed contact'`), `:984` (`'refuses a teacher editing an unclaimed student
  outside their contacts'`), `:814` (`'spends one shared budget across POST and
  the teacher PUT'`), and `tier-selected-at.test.ts:194`. `:355`
  (`'a teacher cannot edit a claimed student'`) still passes but stops meaning
  anything — it asserts only `403`, which it will now get from the catch-all at
  `students/[id]/route.ts:166` rather than from the `claimedAt` guard. Delete it
  rather than leave a green test whose name is a lie.
- **Changing `POST /api/students`** breaks 5, all in `students-api.test.ts`:
  `:146`, `:168`, `:183`, `:726`, `:763`. `:726` is the #162 disclosure regression
  test and must be **rewritten** against the invitation flow, never deleted.

**Removing `DELETE /api/students/[id]` breaks nothing**, because nothing tests it.
Its only caller is `remove-student-button.tsx:23`, which is the one component in
`src/components/students/` with no test file. That absence is why the removal
looks free; it is not evidence that it is.

---

## What this does not do

**`incomeTier` still returns unconditionally to a linked teacher.**
`students/[id]/route.ts:57`, and there is no `shareIncomeTier` flag. That is
#167's, and this change narrows its reach rather than closing it: after this,
every linked teacher is one the student agreed to.

**The `isUnclaimed ||` privacy bypasses become dead code and are kept.** Nothing
will create a new unclaimed `Student` row after this. Measured: there are three
non-seed creation sites in `src/` — `auth/student-signup/route.ts:41`,
`api/students/route.ts:175`, and `api/account/student-profile/route.ts:54`. The
middle one is the branch this change removes; the other two both stamp
`claimedAt` (`student-signup/route.ts:46`, `student-profile/route.ts:60`).
Invitation acceptance adds no fourth site — accepting requires a session that
already has a `studentId`, so it creates the link and nothing else. The
adopt-an-unclaimed-row branch at `student-profile/route.ts:41-51` goes dead for
the same reason as the bypasses.

**Five privacy bypasses go dead, plus one UI affordance** — enumerated by
`grep -rn 'isUnclaimed\|!student.claimedAt\|claimedAt ||' src/` excluding tests,
which returns 13 lines across 6 files:

1. `api/students/route.ts:86` (`isUnclaimed`, used at `:87-88`)
2. `api/students/[id]/route.ts:51` (used at `:56`, `:63-66`)
3. `(teacher)/students/[id]/page.tsx:42` (named `isUnlinked` here, used at `:46-51`)
4. `(teacher)/class/[id]/page.tsx:62`
5. `(teacher)/settings/payments/page.tsx:52`
6. `components/students/student-directory.tsx:129` — renders an "unlinked" caption. Not a privacy bypass; a label that can never show.

Two citations that were wrong in an earlier draft of this document and are
corrected here: site 3 is at `:42`, not `:47-52`, and the variable is `isUnlinked`
rather than `isUnclaimed`; and `students/[id]/privacy/route.ts:75-86` was listed
as a seventh bypass — **it is not one.** That block synthesizes maximally-private
defaults when no `StudentPrivacy` row exists, which is unrelated to `claimedAt`
and stays live and load-bearing.

Removing these means also removing the claim path (`lib/auth/account.ts:34-50`), the
`Student_claim_link_check` CHECK constraint and `Student.claimedAt`, and reworking
GDPR anonymisation — a second feature riding on this one. **Each site gets a
comment saying the branch is unreachable for rows created after this change, and
removal is filed as a leaf.**

**Legacy unclaimed rows are not a concern.** There is no production data; the
database is reset. The paragraph above is about code, not rows.

**No bulk/CSV import.** #51 remains open and now has a clearer target: it creates
invitations, and will still exceed the 50/hour ceiling by design.

---

## Testing

Integration (`tests/integration/`), run by explicit file path — never
`--project integration` without one:

- **The oracle is closed.** `POST /api/students` for an address with a `Student`
  row and one without must produce byte-identical status and body, and an
  `Invitation` row in the same state. This is the assertion the whole design
  exists for; it must be written so it fails if either branch diverges.
- **The tombstone bites.** Decline, then `POST /api/students` again → refused.
  Delete the declined invitation → refused. Archive it → still refused.
- **A `student_block` tombstone is invisible and still blocks.** Student books a
  class (link, no invitation row), then unlinks. `GET /api/invitations` must not
  return the row — assert the teacher's email address does not appear anywhere in
  the response body, not merely that the row count is unchanged — and
  `POST /api/students` for that address must still be refused.
- **The student's way back.** After declining, the student books that teacher's
  class → link exists, tombstone cleared.
- **Waitlist promotion and claim create the link**, and the promoted student can
  then set per-teacher privacy (the 403 `TEACHER_NOT_LINKED` path must stop
  firing for them).
- **Unlink does not delete the `Student` row.** A student whose last teacher is
  unlinked still has an account, still signs in, and still sees their bookings.
- **The removed `PUT` teacher branch.** The route survives for the self-edit
  branch, so a teacher `PUT` now falls through to the uniform `'Access denied'`
  403 at `students/[id]/route.ts:166`. Assert that response is **identical for a
  taken and a free email** — that is the property, not the status code. Written as
  "expect 403" alone the test passes against the bug it exists to catch, because
  the old branch also returned 403 on some paths.
- **The removed `DELETE`.** The export is gone, so the method is unrouted.

**Prove every guard bites.** Per project practice, each guard above is broken
deliberately, the exact error text recorded, then restored and re-verified. A
guard that compiles but cannot fail certifies nothing — #39 shipped three of
those and all three were caught only at PR review.

E2E (`tests/e2e/`): teacher adds a contact → student sees the invitation on
`/account/privacy` → accepts → appears in the teacher's CRM. And the decline path
through to the teacher's "Declined" state.

---

## Open questions

None. All six of the issue's questions are answered above.
