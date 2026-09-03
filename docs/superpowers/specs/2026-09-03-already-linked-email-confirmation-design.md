# `ALREADY_LINKED` confirms an email the teacher may not see

**Issue:** #412 · **Date:** 2026-09-03 · **Branch base:** `adf01828`

## What was measured

`POST /api/students` → `inviteContact` → `hasRosterLink`
(`src/services/invitations.ts:103`) resolves a caller-typed address against
`Student.email` and answers `ALREADY_LINKED` (`:193-195`) when a
`TeacherStudent` link exists. Nothing on that path consults
`StudentPrivacy.shareEmail`, the flag #167 built to decide whether this
teacher may see this student's address at all.

The issue's central claim therefore **holds**: a teacher who types the exact
address of a student who is on their roster but has not shared that address
learns, from the 409, that the address belongs to one of their own students —
a fact `projectStudentForTeacher` (`src/lib/student-visibility.ts:290`)
returns as `null` on every other surface in the app.

## Corrections to the issue's premise

### 1. The "every attempt has a real side effect" mitigation is backwards on the case that matters

The issue rules this out as a mitigating factor:

> Every attempt has a real side effect. A miss creates a genuine `Invitation`
> row and sends a real email to whatever address was typed.

True of a **miss**. False of a **hit**, which is the outcome a prober wants.
`inviteContact` returns at `:193-195` before any write, and the route returns
`respondError(…, 409, 'ALREADY_LINKED')` at `src/app/api/students/route.ts:100`
— *before* the `lastNotifiedAt` write (`:121`) and before `deliverInvitation`
(`:139`). A correct guess therefore creates no row, sends no mail, writes no
notification, and is never surfaced to the student.

This inverts the threat model rather than softening it:

- **Bulk enumeration** is loud and expensive, because misses dominate and each
  one emails a real stranger. The issue is right about this.
- **Targeted hypothesis testing** — "I believe Anna B. is `anna.b@example.com`"
  — costs one rate-limit token, produces no artifact, and is invisible to the
  person whose address is being confirmed.

The second is the scenario `shareEmail: false` exists to defeat, and it is the
cheap one. The targeted severity is higher than the issue argues, even though
its bulk-enumeration severity is lower.

### 2. Option B is not "one extra query" — A and B share an unexamined fall-through

Not answering `ALREADY_LINKED` means falling through to create a real
`Invitation` for a pair that is already linked. The issue names the
teacher-side cost of that and not the student-side one:

- `(student)/account/privacy/page.tsx` renders a **"Pending invitations"**
  section directly above **"Your teachers"**. The same teacher would appear in
  both — one card saying "would like to connect", the other already carrying
  that teacher's privacy toggles.
- `declineInvitation` (`:707`) writes only the tombstone. It does **not**
  unlink. A student who declines that card believing it severs the
  relationship stays linked *and* has permanently blocked that teacher from
  re-inviting (`PUT`/`DELETE /api/invitations/[id]` both refuse a declined
  row).
- Neither suppression is automatic: `listPendingInvitations` (`:518`) has no
  link filter, and `notifyInvitee` (`:380`) re-checks `TeacherBlock` only.

Because A and B pay this identically, **A is strictly worse than B** — the same
fall-through complexity, plus it withholds the signal from teachers who have
nothing to protect. A is dropped on that basis, not on its UX cost.

### 3. The incoherent state is already reachable, obscurely

`PUT /api/invitations/[id]` (`src/app/api/invitations/[id]/route.ts:120-131`)
edits a pending row's `email` with no link check, so a teacher can already
point a pending invitation at a linked student. The bogus card is therefore
pre-existing debt rather than something this change invents — but this change
would move it from obscure to routine, which is why the fix is folded in here
(§4 below) rather than filed.

### 4. An accepted invitation is invisible to the teacher

This corrects a claim made during the brainstorm, not one in the issue.

`contact-list.tsx:47` narrows the rendered list with
`isContact = row.status !== 'accepted'`, and its docblock explains why: once
accepted, that person is a real student and renders in `StudentDirectory`, so
listing them in Contacts too "would list the same person under two different
labels on the same page". The row survives in `Invitation` purely as history.

So "the teacher can already see that address on their own invitation row" is
**false**. The defensible claim is weaker: the teacher *typed* that address and
could have correlated the acceptance when it happened — their contact
disappears from Contacts as a student appears in the directory. That is the
"already-disclosed fact" the issue itself accepts under Option B.

### 5. The response body is unread

`create-student-form.tsx:100-101` reads only `res.ok` and then renders a
confirmation built from the address the teacher typed; its comment states that
"the body goes unread". Nothing navigates to the returned id, which is what
makes returning an ordinary-looking `201 { id }` on the gated path safe.

## The decision

**Option B, gated on `shareEmail`, with the disjunct below.** A and C are
declined.

**C is declined** on correction 1. The app makes a promise through
`shareEmail`, #167 built the machinery to keep it, and this is the last path
that does not consult it — while the cheapest attack against it is also the
silent one.

**A is declined** on correction 2: it costs exactly what B costs and protects
strictly less.

**The UX trade-off, named explicitly** (issue acceptance criterion 1). A
teacher who types the address of a student linked by booking or waitlist, who
has not shared that address, no longer sees *"This person is already one of
your students."* They see an ordinary "invitation sent" confirmation, and a
contact appears in their Contacts list at status **"Invited"** that will never
resolve, for a person already sitting in their student directory under a
redacted name. They cannot reconcile the two — which is the point, and also
the cost. Since `StudentPrivacy` defaults to every share off, this is the
**common** path for booking-created links, not a rare one.

That contact will never resolve *by itself* — it is not stuck there. Both
exits work on it: `PATCH ?state=archived` hides it, and `DELETE` removes it
outright, refusing only `declined` rows
(`src/app/api/invitations/[id]/route.ts:176`).

**Both exits act on the invitation line alone; neither can reach the
student.** That holds at three levels, and the first is structural:
`Invitation` has exactly one relation, `teacher` (`prisma/schema.prisma:254`)
— no `studentId`, no relation to `Student`, matching people by a plain `email`
string — so a cascade from an invitation to a student is impossible by
construction. The route only runs `invitation.deleteMany`. And there is no
teacher-facing student delete to confuse it with: `api/students/[id]/route.ts`
exports `GET`, `PUT` and `PATCH` only, because since #166 severing a link is
the student's own act (`DELETE /api/teacher-links/[teacherId]` →
`unlinkTeacher`). The two archive flags are likewise different columns —
`Invitation.isArchived` via `PATCH /api/invitations/[id]?state=archived`,
`TeacherStudent.isArchived` via `PATCH /api/students/[id]`.

Worth knowing when reading that UI: `remove-student-button.tsx` calls
`DELETE /api/invitations/${invitationId}`. The name says student; the action
is an invitation. Pre-existing, unchanged here, and it is the component the
ghost renders beside.

That cost is accepted rather than engineered away, because the obvious way to
avoid it reopens the oracle. Creating the row already `accepted` would hide it
from Contacts (`isContact`, `contact-list.tsx:47`) and from the student's
pending list at once — but then inviting a stranger makes a contact appear and
inviting a gated student does not, and **"did a new contact appear in my
list?" is itself a yes/no channel carrying the exact bit being withheld.** The
ghost's visibility is therefore load-bearing, not merely tolerated: a gated
invite has to leave the same artifact a real one does.

The residual channels around it hold. A ghost stays `pending` indefinitely,
which is indistinguishable from a stranger who ignored the invitation;
resending it is a no-op the teacher cannot observe, since §3 suppresses the
send and delivery was never visible to them anyway.

Two follow-on behaviours, both benign. Typing the same address again meets
`ALREADY_INVITED` at `:177`, which returns *above* the gate — an answer about
the teacher's own row, so no leak and no duplicate row. And if the student
later unlinks, `unlinkTeacher` flips the ghost to `declined`, showing the
teacher a decline for an invitation the invitee never saw: identical to how
every other invitation behaves on unlink, and indistinguishable from a real
one.

## Design

### 1. The gate

`hasRosterLink` becomes `rosterLinkState`, returning the facts rather than a
verdict — the caller composes the policy, and `inviteContact` needs the
`linked` half again for §2 regardless:

```ts
interface RosterLinkState {
  linked: boolean;
  shareEmail: boolean;
}
```

One query, not the current two, using the same nested-`where` shape
`studentVisibilitySelect` already uses for privacy rows:

```ts
const student = await db.student.findUnique({
  where: { email },
  select: {
    teacherStudents: { where: { teacherId }, select: { id: true } },
    studentPrivacy: { where: { teacherId }, select: { shareEmail: true } },
  },
});
```

A missing `StudentPrivacy` row means `shareEmail: false`, matching
`projectStudentForTeacher`'s own `flags?.shareEmail ?? false` and the page copy
that promises "new teachers start with nothing shared".

At the call site, `ALREADY_LINKED` is answered when the pair is linked **and**
either disjunct holds:

```ts
const link = await rosterLinkState(db, teacherId, email);
// `existing` is null or an `accepted` row here — pending and declined
// returned above.
if (link.linked && (link.shareEmail || existing !== null)) {
  return { ok: false, reason: 'ALREADY_LINKED' };
}
```

**Why the `existing !== null` disjunct earns its place.** Not for the privacy
reason given in the brainstorm (correction 4 retired that), but because it is
what keeps the gated path out of `revivePendingInvitation` entirely. That
function writes `status: 'pending', isArchived: false` plus the newly typed
names — so an accepted row falling through would flip from `accepted`
(invisible) to `pending` (rendered "Invited"), un-archive itself, and have its
names overwritten. A person already in the directory would suddenly also
appear as an outstanding contact: the exact double-labelling `contact-list.tsx`
is designed to prevent. Refusing when an accepted row exists means the revive
path is never reached under a gate, so that failure cannot arise.

The privacy cost of the disjunct is the one the issue already accepted: a
teacher who invited this address and saw it accepted retains a confirmation
they had already inferred.

**The gated population** is therefore precisely: a link created by a booking,
a waitlist join, or a promotion, with no invitation row and `shareEmail`
false.

### 2. Withhold delivery on the gated path

`InviteResult.delivered` becomes false for a second reason:

```ts
delivered: blocked === null && !link.linked,
```

Same machinery `TeacherBlock` already uses, and `delivered` still never reaches
the wire — the route answers `respondOk({ id }, 201)` either way.

### 3. `notifyInvitee` skips an already-linked pair

Required, not defence in depth. `POST /api/invitations/[id]/resend` gates only
on `declined` and `not pending`, then calls `deliverInvitation`
unconditionally — so without this, a teacher could resend the ghost invitation
and deliver *"A teacher would like to connect"* to a student they are already
connected to. The guard belongs in `notifyInvitee` for the reason its own
docblock already gives for the `TeacherBlock` re-check: it travels with the
send rather than living in whichever caller remembers it.

`notifyInvitee` already loads the `Student` row by email, so the link check
folds into that existing query.

### 4. `listPendingInvitations` excludes already-linked pairs

The exclusion nests inside the existing `teacher` filter, because `Invitation`
has no link relation of its own — `Teacher.teacherStudents` is the edge
(`prisma/schema.prisma:172`):

```ts
teacher: {
  deletedAt: null,
  teacherBlocks: { none: { email } },
  teacherStudents: { none: { student: { email } } },
},
```

No `isArchived` condition: archiving is the teacher's own filing action on
their CRM view and does not end the link — the same reading
`(student)/account/privacy/page.tsx` already applies when it lists teachers by
existence rather than by `isArchived: false`.

An invitation to someone already linked is meaningless, so filtering it is
always correct. This is also what closes the pre-existing `PUT`-reachable card
(correction 3).

Legitimate pending-plus-linked states do not exist to be hidden: booking and
waitlist joins both call `resolveInvitationOnLink`, which flips a pending row
to `accepted`, and `promoteNext`/`claimSpot` are reachable only for a student
already linked by `addToWaitlist`.

### 5. Comments to correct

Each of these states something this change falsifies (*Comment Discipline*,
CLAUDE.md — a claim is corrected by replacement, not annotation):

1. `hasRosterLink`'s docblock (`:79-102`) — argues only the #166 property and
   is silent on #167. Issue acceptance criterion 2.
2. `inviteContact`'s docblock (`:121-150`) — its "one residual channel … one
   extra query" paragraph describes a two-query shape §1 collapses to one.
3. `InviteResult.delivered` (`:28-41`) — "False when a `TeacherBlock` exists …
   true otherwise" becomes false.
4. `notifyInvitee`'s docblock (`:315-379`) — gains the link skip.
5. `listPendingInvitations`'s docblock (`:489-517`) — the "block exclusion is
   the PRIMARY gate" framing needs its sibling.
6. The `accepted`-row comment inside `inviteContact` (`:179-192`) — the F8
   reasoning still holds, but the branch it describes now carries the
   disjunct.

## What this does not do

- **The timing residual stays open**, and is now smaller: §1 collapses two
  sequential queries into one, so the "Student exists but is not on this
  teacher's roster" path no longer issues an extra round trip. Closing it
  entirely would still mean dummy queries, which `inviteContact`'s docblock
  already declines at this threat level.
- **A teacher who invited an address and saw it accepted still gets
  `ALREADY_LINKED`**, by design (§1).
- **A ghost invitation does not resolve when the student later shares their
  email.** Nothing re-evaluates an `Invitation` on a `StudentPrivacy` change —
  the privacy routes write only that table, and no sweep reads invitations.
  The knock-on is that the ghost then *masks* the answer the teacher has
  become entitled to: a second attempt at the same address meets
  `ALREADY_INVITED` at `:177`, which returns above the gate, so they are told
  to "open their contact to resend or update their details" about a contact
  whose resend is a no-op (§3). Recovery is manual and does work — delete the
  ghost, retype the address, and with no invitation row and `shareEmail` now
  true the answer is `ALREADY_LINKED`.

  Auto-resolving it was considered and declined. It would mean writing to
  `Invitation` from the privacy-toggle path — a second table, and therefore a
  lock-order question (`docs/lock-order.md`) — on a route that otherwise has
  no business touching invitations, to tidy a rare artifact that already has
  an exit.
- **`PUT /api/invitations/[id]` keeps its missing link check.** It discloses
  nothing — it answers `{ id }` or `ALREADY_INVITED` on the teacher's own row,
  never a link fact — and the card it could produce is now filtered by §4.
- **#166 is unaffected**: no branch is added on whether a `Student` row exists.
  Both gated and ungated paths continue to answer identically for "no student"
  and "student, no link".
- **#167 and #176 are unaffected** — no projection or search behaviour changes.

## Testing

**Service level** — `src/services/invitations.*.test.ts` (`unit` project).
These are runnable in this worktree despite hitting Prisma: the project points
at its own `ethical_yoga_test` database and needs no dev server, unlike
`integration` (verified by running `invitations.pending.test.ts` here, 7/7):

1. Linked + `shareEmail: false` + no invitation → **not** `ALREADY_LINKED`;
   an invitation is created and `delivered` is `false`.
2. Linked + `shareEmail: true` → `ALREADY_LINKED`, no row written.
3. Linked + `shareEmail: false` + an **accepted** invitation → `ALREADY_LINKED`,
   and the accepted row is untouched (still `accepted`, `isArchived` and names
   unchanged) — the anti-revive assertion, which is the disjunct's whole reason
   to exist.
4. Missing `StudentPrivacy` row behaves as `shareEmail: false`.
5. `notifyInvitee` creates no notification and sends no email for a linked
   pair (the resend hole).
6. `listPendingInvitations` omits an invitation whose pair is linked.

**HTTP level** — `tests/integration/students-api.test.ts` (issue acceptance
criterion 3): `POST /api/students` with the exact unshared address of a
booking-linked student answers `201`, not a 409 with code `ALREADY_LINKED`.

**Every guard broken before it is trusted**, per guard, recording the exact
failure text: revert the `shareEmail` conjunct and confirm test 1 goes red with
a 409; drop the `existing !== null` disjunct and confirm test 3 reddens on the
revived row rather than only on the status code; drop the `notifyInvitee` link
check and confirm test 5 sees a notification; drop the `listPendingInvitations`
filter and confirm test 6 sees the row.

Test 3 needs its falsifiability checked twice, because it can pass vacuously:
if the fixture's invitation is `pending` rather than `accepted`, `inviteContact`
returns `ALREADY_INVITED` far above the code under test.

**From this worktree, `integration` and `e2e` cannot run** — both need the dev
server on `:3000` and the shared dev database. `verify` is scoped to
typecheck, lint, `unit` and `components`; CI is the signal for the other two,
and the PR body cites the CI run for that tier rather than a local pass.

## Filed, not folded

Nothing. The one candidate — the ghost "Invited" contact that never resolves —
is not a defect awaiting a fix: its visibility is what keeps the gated path
indistinguishable from a real invitation (see §"The decision"), and the
teacher can archive or delete it. Filing it would describe the design back to
itself, and any issue proposing to hide it would be proposing to reopen the
oracle this branch closes.
