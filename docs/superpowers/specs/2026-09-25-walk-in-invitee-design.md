# Walk-in for invitees and new people (#255) — design

**Issue:** #255 — "A walk-in must already have accepted an invitation, and the
escape hatch AddWalkIn's own comment names has not existed since #166".
**Base:** `origin/main` at `90f54d57` (2026-09-25).
**Status:** direction agreed in brainstorming, 2026-09-25.

## Problem

A teacher running a class taps **Add walk-in** and can pick only someone
already on their roster. The person at the door who is not has no path to a
registration: the CRM's "add" creates an `Invitation`, and an invitation
becomes a roster link only when the invitee, signed in as a student, accepts
it. Four independent gates each block the walk-in on their own (measured
below). This spec adds the path, and states what that costs.

## Premise, re-measured

The issue was filed on 2026-08-18 against `45d11d8`, with its design decided.
Eight related PRs landed after it. Every claim was re-read against
`90f54d57`; the full table with quotes is the PR body's appendix. Summary:

**Held (lines moved):**

1. The picker is roster-only by its data source. `add-walk-in.tsx` fetches
   `GET /api/students`, whose `where` is `teacherStudents: { some: … }`.
2. `POST /api/registrations` refuses independently: a codeless
   `403 Student is not in your roster` when the teacher path finds no
   `TeacherStudent`.
3. `Registration.studentId` is a non-null FK. `Invitation` is deliberately not
   a `Student` row (its schema docblock).
4. Only the invitee can accept: `POST /api/invitations/[id]/respond` is
   `requireStudent` and passes `session.studentId`.
5. `add-walk-in.tsx:23-24` ("goes through Students → New") and the copy at
   `:152` ("Add them under Students first") describe a route that creates an
   invitation, not a student.

**Wrong or overtaken — the corrections this design makes:**

- **"Both branches succeed identically, so eligibility carries no oracle" —
  true only of the POST response.** Afterwards the teacher can tell whether
  the address already had an account: `claimedAt` is in the teacher
  projection (`TeacherVisibleStudent`) and drives the directory's "unlinked"
  caption; the class page shows an existing account holder's *own* name and
  initial instead of the name the teacher typed; privacy flags are seeded on
  one branch only; the tier differs. This reopens the #166 account-existence
  oracle through reads. **Decided: accepted as a residual** — see *Accepted
  residuals*.
- **Lock order.** Since #625 this route takes `Student` before `Class`, and
  the canonical line is `Student → Class → WaitlistEntry → Registration →
  StudentPrivacy → TeacherStudent → Invitation → TeacherBlock`
  (`docs/lock-order.md`). The issue found the `Student` after the `Class` lock
  and linked before registering, contradicting both.
- **The teacher-or-student discriminator.** `body.studentId !== undefined`
  decides teacher-vs-student, `isTeacher`, and the post-commit
  `tierSelectedAt` stamp. A body carrying only `invitationId` would book the
  teacher's own student profile.
- **The `deletedAt` refusal cannot fire.** Erasure rewrites `Student.email` to
  `deleted-<id>@deleted.invalid` in the statement that sets `deletedAt`
  (`gdpr.ts`), so an email lookup never meets a soft-deleted row. Erasure also
  anonymises the person's invitations to `deleted-<uuid>@deleted.invalid` /
  "Deleted Student" with `status` untouched — so a `pending` erased invitation
  is still pending, and walking it in would have created a "Deleted Student".
- **Teacher-only accounts.** `resolveOrClaimAccount` returns early when an
  `Account` exists, so an unclaimed `Student` created for an address held by a
  teacher-only account is never claimed at sign-in (only the explicit
  add-student-hat path, `api/account/student-profile`, claims it).
- **The privacy bypass has two callers.** `bypassesPrivacy` is now private;
  the exported `privacyIsBypassed` also feeds `rosterLinkState`
  (`invitations.ts`, #419). Removing one without the other re-creates #419's
  drift.
- **Student creation census.** `student-signup` no longer writes any row. The
  only production creator is `api/account/student-profile`'s `POST`, which sets
  `claimedAt`; `prisma/seed.ts` also sets it.
- **Smaller:** the invitation email links to plain `${baseUrl}/login`, not a
  magic link (true at `45d11d8` too); resend exists (#173); a decline also
  writes a `TeacherBlock` (#522), so "declined" and "blocked" overlap;
  `deliverInvitation` lives in `services/invitations.ts` and returns
  `FireAndForget`; `GET /api/invitations` already lists a teacher's contacts,
  so `GET /api/students` needs no new flag; `WALK_IN_WINDOW_MS` (booking rule,
  registrations route) and `CHECKIN_OPENS_MINUTES` (where `AddWalkIn`
  renders, `lib/finish-window.ts`) are two constants of the same value.

## Decisions

### Presence is acceptance (kept from the issue)

A teacher-initiated walk-in completes the link: the `Invitation` becomes
`accepted`, a `TeacherStudent` row exists, and — when the address has no
`Student` — one is created. This is the one named exception to CLAUDE.md's
"a teacher may not link a student unilaterally", and the exception is bounded
by the walk-in window: it exists only while a class is running or about to.

### Eligibility is uniform

Any `pending` invitation of this teacher, or any address typed as a new
contact, can be walked in. Archiving is list placement, not consent state: the
picker omits archived rows, and the API accepts them. If the address has a `Student`, that row is
used; if not, one is created. Refusals depend on the teacher's own rows and on
refusal rows the student wrote, never on whether the address is on the
platform.

### The email is a notification

A new `NotificationType` value `walk_in_added`, created inside the registration
transaction on both branches, essential (bypasses `emailNotifications`) and
immediate-email (joins `IMMEDIATE_EMAIL_TYPES` beside `waitlist_promoted`,
which is the same shape: a booking the student did not make at that moment).
The existing 5-minute fallback sweep emails it with its claim-before-send
discipline. Consequences: exactly one email; the same channel and timing on
both branches, so delivery reveals nothing; an inbox record once the person
signs in; a signed-in student who reads it in-app is not emailed again. Cost:
one enum migration, and delivery up to one sweep late. Chosen over a dedicated
`FireAndForget` email, which would need its own failure marker (#392), has no
retry, and leaves no in-app record.

## Design

### 1. Request shape

`createRegistrationSchema` becomes a union of three strict shapes:

```ts
{ classId, studentId }                                   // roster (unchanged)
{ classId, invitationId }                                // pending invitee
{ classId, newContact: { firstName, lastName, email } }  // new person
```

plus the self-booking `{ classId }`. `newContact` reuses
`createInvitationSchema`'s field rules (`firstName` `.trim().min(1)`,
`lastName` optional default `''`, `emailField`).

The teacher path is decided once — "a subject field is present" — and every
consumer reads that single value: the `requireTeacher`-equivalent check, the
roster 403 (roster subject only), `isWalkIn`, and the self-booking-only
post-commit `tierSelectedAt` stamp. A walk-in never stamps `tierSelectedAt`:
the person chooses their tier when they claim.

Both new subjects **refuse outside the walk-in window** (`WALK_IN_WINDOW_CLOSED`,
409). The roster subject keeps its current behaviour, where a teacher may add
a roster student to an `open` class ahead of time. Without the person at the
door, presence-is-acceptance has nothing to rest on.

`newContact` spends `checkStudentWriteLimit` before the transaction, so it
cannot become the way around the CRM's spam brake. `invitationId` does not:
the invitation it names was already rate-limited when it was created.

### 2. `src/services/walk-ins.ts`

Framework-agnostic, takes a `tx`, returns a typed result. The route keeps the
class-side logic it already has; the service owns the consent state machine.
Two exported steps, because the lock order puts the class work between them:

**`resolveWalkInStudent(tx, { teacherId, subject })`** — before any lock.

1. Resolve the subject to an address and, where one exists, this teacher's
   `Invitation`. `invitationId`: the row must have `teacherId` = the acting
   teacher, else `NOT_FOUND` (404, as ownership answers elsewhere).
   `newContact`: read the teacher's row for the normalised address, if any —
   **read only**. A missing row is created in `completeWalkIn`, at the
   `Invitation` position of the lock order, never here before the `Class`
   lock.
2. Refuse, in this order, on plain reads:
   - erased — the invitation's address is an erasure placeholder →
     `INVITATION_ERASED`. The teacher already sees "Deleted Student" on their
     Contacts list, so the refusal tells them nothing new. The predicate is a
     new `isErasedAddress` beside the constant `gdpr.ts` builds its
     placeholders from, so the writer and the reader cannot drift;
   - invitation `declined` → `DECLINED` (existing code). Checked before the
     block because since #522 every decline also writes one: block-first
     would answer a decline with the generic code, while the teacher already
     reads `declined` on their own Contacts row, so naming it leaks nothing.
     The picker omits declined rows; this is reached by a `newContact` typed
     for a declined address, or a direct request;
   - `TeacherBlock` for `(teacherId, email)` → `WALK_IN_REFUSED` (generic,
     names no cause — the accepted residual). Reached by a block on a
     `pending` row: an unlink leaves an undelivered row `pending` beside its
     block, and an invite to a blocked address creates one.
3. Find the `Student` by email. Found → the match branch. Not found → create
   it (the create branch): `firstName`/`lastName`/`email` from the invitation,
   schema-default tier, `tierSelectedAt: null`. If an `Account` already holds
   the address and holds no live `Student` (a teacher-only account), the row
   is created with `accountId` and `claimedAt` set in the creating statement,
   as `Student_claim_link_check` requires — an account that already holds a
   live profile cannot take a second (`Student_account_live_unique`, #623);
   otherwise both stay `null` and
   `resolveOrClaimAccount` claims it on first sign-in. A `P2002` on the email
   (a concurrent create) is re-read and continues as the match branch.
4. Return `{ studentId, email, firstName, lastName, created: boolean }`. `created` never
   leaves the server: it drives the privacy seed and nothing else.

**The route** then runs its existing body with that `studentId`:
`lockLiveStudent` (`Student`), `lockClassRow` (`Class`), ownership,
cancellation, the window refusal above, status, capacity (walk-ins may exceed
it), `activateRegistration` with `isWalkIn: true` (`Registration`, claimable
`WaitlistEntry`).

**`completeWalkIn(tx, { teacherId, classId, resolved, notice })`**
— after `Registration`, in lock order:

1. `created` only: create `StudentPrivacy { teacherId, studentId,
   shareFullName: true, shareEmail: true }`, every other flag at its `false`
   default. The teacher supplied the name and address; they have no claim on
   phone, birthday or home address. The match branch seeds nothing: that
   person's own settings, or the default-deny absence of a row, govern.
2. `linkTeacherStudent` (`TeacherStudent`).
3. `Invitation` → `accepted`. A missing row for `(teacherId, email)` is
   inserted first (`createMany … skipDuplicates`, `status: pending`, the typed
   name; no invitation email is sent — the walk-in notification replaces it);
   an existing row keeps its name. Then a compare-and-set on
   `status: 'pending'` → `accepted`, `respondedAt: now`. A miss is classified
   by re-reading: `accepted` is what was asked for; `declined` (a concurrent
   decline) → `DECLINED`; gone (a concurrent delete) → `NOT_FOUND`.
4. `walk_in_added` notification to the student, linked to the class.
5. **`TeacherBlock` re-check as the last statement** — the #537 pattern
   `acceptInvitation` uses. A decline landing between step 2 of
   `resolveWalkInStudent` and here writes a block; this read sees it and throws,
   rolling the whole transaction back → `WALK_IN_REFUSED`.

`resolveInvitationOnLink` is **never** called on this path: it deletes the
`TeacherBlock`, and its docblock confines it to acts the student performs. In
`docs/data-model.md`'s roster-link census the walk-in is classified as
**resolves by its own hand**, like `acceptInvitation`, with its own
compare-and-set.

An `unchanged` outcome (this student already actively registered in this
class) answers `respondUnchanged` as today, after the refusals — so a walk-in
of someone already present is not a red error.

### 3. Error codes

Registered in `src/lib/api-error-codes.ts`, 409 each, asserted by code in tests:

| Code | When |
|---|---|
| `WALK_IN_WINDOW_CLOSED` | invitee / new-contact subject outside the walk-in window |
| `WALK_IN_REFUSED` | a `TeacherBlock` exists, before or after the race |
| `INVITATION_ERASED` | the invitation's address is an erasure placeholder |
| `DECLINED` (existing) | the invitation is `declined` |

`STUDENT_ERASED` (existing) continues to cover an erasure racing the walk-in
via `lockLiveStudent`. `WALK_IN_REFUSED` must not share a message or a code
with any refusal that names a cause.

### 4. Privacy

- Delete `bypassesPrivacy` **and** `privacyIsBypassed`. `teacherVisibleName`
  and `projectStudentForTeacher` read only the teacher's `StudentPrivacy` row.
  An unclaimed student created by a walk-in is projected through its seeded
  flags; there is no other source of unclaimed rows (not in production, so no
  pre-#166 rows to carry).
- `rosterLinkState`'s `mayBeTold: unclaimed || shareEmail` becomes
  `shareEmail`. For a walk-in-created student the outcome is unchanged, since
  `shareEmail` is seeded `true`. `invitations.gate.test.ts`'s unclaimed-linked
  case is rewritten to state the new rule.
- `claimedAt` stays in `TeacherVisibleStudent`. The directory's "unlinked"
  caption becomes live — it means "has not signed in yet" — and its comment,
  which calls it dead code, is replaced.

### 5. Notification

- Migration: `ALTER TYPE "NotificationType" ADD VALUE 'walk_in_added'` via
  `prisma migrate dev`.
- `ESSENTIAL_NOTIFICATION_TYPES` and `IMMEDIATE_EMAIL_TYPES` gain it.
- `STUDENT_INTROS` gains a line; `STUDENT_ACTION_LINKS` gains
  `{ label: 'Sign in', path: '/login' }`.
- Title and body name the teacher, the class and its date, and say the price
  is calculated after class. Recipient: the student only.
- Retention follows the ordinary class-linked rule.

### 6. UI — `src/components/class/add-walk-in.tsx`

- Fetch `GET /api/students` and `GET /api/invitations?status=pending`. The
  `status` flag is new; the route also drops archived rows and erasure
  placeholders when it is present. `ContactList`'s docblock already names this
  flag as what a second consumer should get.
- One flat alphabetical list; invitees carry a quiet `· invited` suffix
  (`type-caption`). An invitee pick posts `invitationId`.
- Below a divider, a new-person form — first name, last name, email — whose
  single **Add walk-in** button posts `newContact`.
- Each refusal code maps to its own copy; `WALK_IN_REFUSED` copy names no
  cause. Success calls `router.refresh()`.
- The stale comment (`:23-24`) and copy (`:152`) are replaced.

### 7. Documentation that this change falsifies

All in the same PR:

- `CLAUDE.md`, Data Model: walk-ins are the named exception to "a teacher may
  not link a student unilaterally", and create unclaimed `Student` rows.
- `prisma/schema.prisma`: the `Student` comment on unclaimed rows.
- `docs/data-model.md`: the `StudentPrivacy` writers (a third, teacher-caused
  writer on the create branch); the roster-link census (re-run its grep; the
  walk-in resolves by its own hand); the unclaimed-student paragraphs; the
  accepted residuals below.
- `docs/lock-order.md`: amend `POST /api/registrations`'s Known-conformance
  entry and the `Student`-gate table (a new `Student` INSERT before the
  `Class` lock; `StudentPrivacy → TeacherStudent → Invitation → TeacherBlock`
  after `Registration`).
- `src/lib/student-visibility.ts` and `student-directory.tsx` comments.

## Accepted residuals

1. **Account existence is readable after a walk-in.** `claimedAt`, the
   projected name, the seeded flags and the tier distinguish an address that
   had a `Student` from one that did not. Accepted because every probe is
   loud: it registers the address holder in a real class, emails them naming
   the teacher and the class, creates a payment obligation they will see, only
   works inside a live class window, and — on the new-contact path — spends
   the teacher's student-write budget. #166 closed a *silent* oracle; this one
   announces itself to its subject.
2. **A block refusal is observable** (from the issue). An invite to a blocked
   address answers identically to any other; a walk-in refuses. The
   alternative is re-linking the person who unlinked to get away from that
   teacher. The copy names no cause.
3. **A #412 decoy is walkable.** A pending invitation a teacher created for a
   guessed address of an already-linked student (`delivered: false`) is listed
   and walkable; walking it in registers that roster student and so confirms
   the guess. The picker cannot omit it without revealing `delivered`, which is
   the same oracle. Loud, as in 1.

## Testing

- **Service integration tests** (`walk-ins.test.ts`): create branch, match
  branch, teacher-only-account attach, concurrent create (`P2002` → match), the
  `StudentPrivacy` seed on create only, the invitation reaching `accepted`, the
  notification row.
- **Route integration tests**: each refusal by code via `expectRefusal`;
  discriminator cases (an `invitationId` body never books the teacher's own
  student profile, never stamps `tierSelectedAt`); `newContact` rate limit;
  foreign `invitationId` → 404; the two branches' responses identical in shape.
- **Race test**: a decline landing between resolve and complete → refused,
  nothing written (the final block re-check).
- **Email fallback**: `walk_in_added` is emailed on the first sweep, opted-out
  student included, and exactly once.
- **Visibility**: unclaimed walk-in student projected through flags; the
  bypass is gone.
- **e2e**: an invitee picked from the merged list, and a new person added from
  the form, both end registered on the class page.
- **Mutation, one per guard** — break it, see a named test go red, restore:
  drop the block refusal; drop the final block re-check; accept `declined`;
  accept an erased invitation; drop the window refusal; skip the rate limit;
  seed privacy on the match branch; call `resolveInvitationOnLink` instead of
  the own compare-and-set (the block-survives test must go red); restore
  `privacyIsBypassed`'s disjunct.

## Out of scope

- `POST /api/students` keeps its behaviour; decline and unlink are unchanged.
- No new resend behaviour (resend already exists, #173).
- Bulk/CSV import (#51) is unaffected.
- Unifying `WALK_IN_WINDOW_MS` and `CHECKIN_OPENS_MINUTES` — same value, two
  owners, noted here and left.
