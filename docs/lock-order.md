# Lock order

Nothing enforces this. It is a convention, and the only defence against a
deadlock is that every transaction taking two of these rows takes them in this
order:

    Class → WaitlistEntry → Registration → StudentPrivacy → TeacherStudent → Invitation → TeacherBlock

## Why it is written down rather than enforced

Postgres breaks a genuine cycle by aborting one transaction with `40P01`, which
reaches the user as a 500 through `withErrorHandler`. No constraint, trigger or
type can prevent the cycle forming — only the order can.

## `Class` is the real gate; the rest is not

`Class` is not merely first in the list — every site below that touches more
than one of these tables also holds `Class`'s row lock (via `lockClassRow` or
an inline `SELECT ... FOR UPDATE`) before touching any of the others, *when it
touches `Class` at all*. `POST /api/registrations` writes `Registration`
before `WaitlistEntry`; `promoteNext` can write `WaitlistEntry` before
`Registration`, but only conditionally (the stale-head-drop loop,
`waitlist.ts:405` — it runs only when the current queue head already holds an
active registration, not the common case); `claimSpot` never writes
`WaitlistEntry` before `Registration` at all (its only `WaitlistEntry` write,
`waitlist.ts:557`, comes after `activateRegistration`) — an earlier version of
this document claimed otherwise for both, corrected in round 1 review. None of
that is a bug regardless: all three of those sites lock `Class` first, so only
one of them can ever be past that lock for a given class at a time — they
cannot hold conflicting `WaitlistEntry`/`Registration` locks concurrently
regardless of which table each reaches for second, or whether it reaches for
it at all. That protection is real but conditional on the `Class` lock actually
being taken, which is why the entries further down this list matter: several
sites reach `StudentPrivacy`, `TeacherStudent`, `Invitation` or `TeacherBlock`
for a (teacher, student) or (teacher, email) pair with **no** `Class` row in
scope at all (`unlinkTeacher` when the student is not waiting in any of that
teacher's classes; `acceptInvitation`; `deleteStudentAccount` erasing links to
teachers whose classes the student never joined a waitlist for). For that
suffix of the list — `StudentPrivacy → TeacherStudent → Invitation →
TeacherBlock` — the order is the *only* thing preventing a cycle, not a
side-effect of a shared lock elsewhere. Both of #174 task 7's fixes are in
that suffix.

## The empty-`update` upsert quirk — read this before "tidying" one

Prisma 6.19.3 does **not** compile `tx.someTable.upsert({ where, update: {},
create: {...} })` to the atomic `INSERT ... ON CONFLICT DO UPDATE` when the
target row already exists. It compiles to three plain, non-locking `SELECT`s
instead — confirmed by direct query logging (`DEBUG=prisma:query` emits
nothing on this Prisma version; a standalone
`new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })` was used).
Give the same call a single real column — `update: { isArchived: false }`, for
instance — and Prisma switches to the atomic path, which **does** take the row
lock.

This matters here because five call sites upsert `TeacherStudent` with
`update: {}` while racing a transaction that takes the opposite order on
purpose or by circumstance:

- `acceptInvitation` (`invitations.ts`) — `TeacherStudent` upsert, `update: {}`.
- `addToWaitlist`, `promoteNext`, `claimSpot` (`waitlist.ts`) and
  `POST /api/registrations` (`route.ts`) — same, `update: {}`.
- `unlinkTeacher`'s `TeacherBlock` upsert (`invitations.ts`) — also `update: {}`,
  a sixth upsert, on a different table.

None of those five `TeacherStudent` upserts, and neither the `TeacherStudent`
upsert nor the `TeacherBlock` upsert, currently take the row lock in the one
scenario that would matter (the row already exists — the only case a race
against a delete/decline of that same row is possible). That is why
`acceptInvitation`'s old order never actually deadlocked against `unlinkTeacher`
in production, and why `resolveInvitationOnLink` racing `unlinkTeacher` on
`{TeacherBlock, Invitation}` doesn't either (see "Known safe by accident"
below) — **not** because either order was safe.

**If you are the future reader who turns one of these `update: {}` objects
into something with a real field in it** (an `updatedAt` stamp, a bookkeeping
flag, anything) — stop. That edit silently restores the atomic, lock-taking
path for that upsert, and if the write order at that call site doesn't already
match this document, you have just reintroduced a live `40P01`. Check this
file first.

`StudentPrivacy`'s upsert (`unlinkTeacher`, `SILENCED_PRIVACY`) is never
empty — six real boolean columns, every call — so it was never protected by
this quirk. The `{StudentPrivacy, TeacherStudent}` inversion #174 task 7 fixed
was a live, reproduced deadlock in real production code, not a theoretical one.

## Known conformance

- **`unlinkTeacher`** (`src/services/invitations.ts`) — `Class`/`WaitlistEntry`
  via `withdrawWaitingEntriesForTeacher` (must run first; its docblock,
  `waitlist.ts:669-732`, explains why — a deadlock question, not a
  preference), then `StudentPrivacy`, `TeacherStudent`, `Invitation`,
  `TeacherBlock`. `StudentPrivacy` used to come after `TeacherStudent`; fixed
  in #174 task 7 after a direct reproduction (see below).
- **`acceptInvitation`** (`src/services/invitations.ts`) — `TeacherStudent`
  then `Invitation`. Was the other way round until #174 task 7. Does not
  currently deadlock against the old order either way, for the reason in the
  quirk section above — reordered anyway, because that protection is an
  accident, not a guarantee. `tests/integration/invitations-api.test.ts`
  pins the mechanism with a synthetic non-empty `update` that forces the
  atomic path and shows the old order deadlocking under it while the new one
  does not.
- **`deleteStudentAccount`** (`src/services/gdpr.ts`) — `Class`, looped via
  `lockClassRow` over every class the student is `waiting` in (sorted),
  hoisted ahead of every row write by #174 task 5. Then `Registration`
  (`gdpr.ts:329`), `StudentPrivacy`, `TeacherStudent`, `WaitlistEntry`
  (`gdpr.ts:348`), `Invitation` (anonymized in place, not deleted). Was
  already `StudentPrivacy` before `TeacherStudent`; not the outlier on that
  pair. **Not** listed as conformant on `Registration`/`WaitlistEntry` order,
  though: it writes `Registration` before `WaitlistEntry`, the opposite of
  this document's canonical line, and "`Class` is the real gate" above does
  not cover it — that escape is scoped to sites that lock `Class` before
  touching either table, and this function's `lockClassRow` loop covers only
  classes the student is `waiting` in, not the (potentially different) set
  of classes whose `Registration` rows it cancels. Round 1 review of #174
  task 7 could not construct a live counterparty — the one candidate
  disagreement, `promoteNext`'s conditional stale-head drop above, needs the
  erased student to hold both an active `Registration` and a `waiting`
  `WaitlistEntry` for the same class at once, a state `POST /api/registrations`'s
  own waitlist-resolution step actively prevents in the normal booking flow —
  but "no counterparty found" is not the same claim as "safe," and none is
  made here. Left open, not resolved: no code changed for this.
- **`deleteTeacherAccount`** (`src/services/gdpr.ts`) — `Class`, via a
  per-class compare-and-swap `class.updateMany` inside a loop over upcoming
  classes (not `lockClassRow`, but still a lock-taking `UPDATE`, and still
  first). Then, per class, `WaitlistEntry`. After the loop: `StudentPrivacy`,
  `TeacherStudent`, `Invitation` (deleted, not anonymized — the teacher is
  soft-deleted, not scrubbed like a student's identity is). Was already
  `StudentPrivacy` before `TeacherStudent`; not the outlier.
- **`completeClass`** (`src/services/class-lifecycle.ts`) — `Class` via
  `lockClassRow`, then `Registration`, `Payment`. `transitionClass`'s own
  docblock (`class-lifecycle.ts:117-120`) names this and `autoCancelClasses`
  as the two sites that read more state than a bare status under the
  decision, and take the lock instead of a plain CAS for that reason.
- **`autoCancelClasses`** (`src/services/class-transitions.ts`) — `Class` via
  `lockClassRow` (#174 task 6), then a `Registration` count read, then the
  CAS `class.updateMany`. Matches `transitionClass`'s docblock.
- **`addToWaitlist`** (`src/services/waitlist.ts`) — `Class`, then
  `TeacherStudent` (upsert), then `TeacherBlock`/`Invitation` via
  `resolveInvitationOnLink`, then `WaitlistEntry`. That call takes
  `TeacherBlock` BEFORE `Invitation` — the opposite of this document's
  canonical line, and of `unlinkTeacher`'s own order. Not conformant on that
  one sub-order; conformant on everything else. See "Known safe by accident"
  below for why the disagreement is not currently live, and why the
  canonical line still names `unlinkTeacher`'s direction over this one's.
- **`promoteNext`** (`src/services/waitlist.ts`) — `Class`, then
  conditionally `WaitlistEntry` (the stale-head-drop loop,
  `waitlist.ts:405` — only when the current queue head already holds an
  active registration, not the common case), then `Registration`
  (`activateRegistration`), `TeacherStudent`, then `WaitlistEntry` again (the
  promotion and the reorder). **`claimSpot`** (`src/services/waitlist.ts`) —
  `Class`, then `Registration` (`activateRegistration`), `TeacherStudent`,
  then `WaitlistEntry` (`waitlist.ts:557`) — never before `Registration`. An
  earlier version of this document claimed both functions wrote
  `WaitlistEntry` before `Registration` unconditionally; wrong for
  `claimSpot` and overstated for `promoteNext`, corrected in round 1 review.
  Neither calls `resolveInvitationOnLink` (deliberately — see each
  function's own docblock), so neither touches `Invitation`/`TeacherBlock`.
- **`removeFromWaitlist`**, **`withdrawWaitingEntriesForTeacher`**
  (`src/services/waitlist.ts`) — `Class` then `WaitlistEntry` only.
- **`POST /api/registrations`** (`src/app/api/registrations/route.ts`) —
  `Class`, then `Registration`, `WaitlistEntry`, `TeacherStudent`, then
  `TeacherBlock`/`Invitation` via `resolveInvitationOnLink` — the same
  `TeacherBlock`-before-`Invitation` disagreement as `addToWaitlist`, not
  conformant on that sub-order for the same reason.

## Known safe by accident, not by order — not fixed here

**`resolveInvitationOnLink`** (`src/services/link-consent.ts`, called from
`addToWaitlist` and `POST /api/registrations`) takes `TeacherBlock` before
`Invitation` — the opposite of `unlinkTeacher`'s `Invitation` then
`TeacherBlock`. Directly tested (#174 task 7): a transaction shaped like
`resolveInvitationOnLink`'s order racing one shaped like `unlinkTeacher`'s did
**not** deadlock, because `unlinkTeacher`'s own `TeacherBlock` upsert is also
`update: {}` and hits the same non-locking path described above whenever a
block already exists. This is not a "shared prior `TeacherStudent` lock"
protecting it — an earlier working hypothesis, now shown wrong — it is the
same upsert quirk on a different table. Not fixed, per instruction: doing so
would widen this task past the two pairs it was scoped to. If a future edit to
either upsert's `update` payload makes it non-empty, this pair needs the same
treatment `{Invitation, TeacherStudent}` and `{StudentPrivacy, TeacherStudent}`
already got.

**Why the canonical line names `unlinkTeacher`'s direction, not
`resolveInvitationOnLink`'s.** By call site this looks like 2-against-1 —
`addToWaitlist` and `POST /api/registrations` both disagree with
`unlinkTeacher` — but both of those call the SAME function,
`resolveInvitationOnLink`; by function it is 1-against-1, not a majority
either way. `unlinkTeacher` is the one function in this codebase that
touches every table in the canonical line — `StudentPrivacy`,
`TeacherStudent`, `Invitation` AND `TeacherBlock` — and its order across the
first three of those was directly audited and fixed for lock safety in #174
task 7. `resolveInvitationOnLink`'s own order was not chosen with lock
safety in mind at all, as far as this document can tell from its docblock:
"the block is the thing that actually stands between them... clearing it is
what makes booking the student's route back" is a narrative choice about
which state change makes sense first from the student's side, not a
decision that ever weighed deadlock risk. Anchoring the canonical line on
the function that WAS reasoned about for lock safety, rather than the one
that wasn't, is the basis for the choice — not a claim that
`unlinkTeacher`'s direction is inherently safer on its own merits.

## Known violation, not fixed here

`deleteTeacherAccount` takes `Class` before `ClassTemplate`; the generator
(`src/services/class-generator.ts`) and three template paths take them in the
opposite order, and that counterparty is a sweep that runs continuously.
Choosing a canonical order there touches the whole template family, so it is
filed as a decision rather than resolved from here.

**Inherited from an earlier draft of this document, not re-verified in #174
task 7.** This entry is unrelated to either pair task 7 fixed, and nothing in
that task's work re-derived it from the code. In particular, "three template
paths" was not re-counted here and should not be trusted at that precision
without an independent check — the count and file list above are
as-inherited, not as-confirmed.

## Related, but not a lock-order issue — found while fixing the above, not fixed

`unlinkTeacher` reads the `TeacherStudent` row's id with a plain `findUnique`
**before** opening its transaction, then deletes it by that id
(`tx.teacherStudent.delete({ where: { id: link.id } })`). If a concurrent
`deleteStudentAccount` or `deleteTeacherAccount` deletes and commits that same
row at any point between that read and `unlinkTeacher`'s own delete-by-id, the
id no longer exists and Prisma throws `P2025 record not found for a delete`.
That window has two distinct shapes, not one: the erasure can commit entirely
before `unlinkTeacher`'s transaction even opens — pure sequencing, no lock
contention involved at all — or `unlinkTeacher`'s transaction can already be
open and blocked on a lock the erasure holds (exactly what happens when
`unlinkTeacher` loses the `StudentPrivacy` race the rest of this document is
about), in which case the erasure finishes and commits while `unlinkTeacher`
waits, with the same result once it unblocks. Reordering `unlinkTeacher`
closes the second shape's likeliest path to that outcome (the deadlock that
used to fire first is gone) but does nothing about the first, which does not
depend on lock order, or even on `StudentPrivacy`, at all. `classifyApiError`
(`src/lib/api-errors.ts`) has no branch for `P2025`, so it falls through to
the generic 500. Reproduced directly, reliably, three times in a row (#174
task 7 report has the transcripts). The pre-transaction read itself predates
this task — byte-identical at commit `e99c165`, well before task 7 touched
this file. Left as a finding for a separate issue: the fix is either a
`deleteMany` (count-tolerant) in place of the single-row `delete`, or
re-verifying the link inside the transaction rather than trusting a
pre-transaction read.
