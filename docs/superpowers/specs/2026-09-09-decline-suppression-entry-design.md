# Making a plain decline's refusal survive erasure (#522)

## What's measured

Every claim in #522 verified against `main` at `1b59538e`, plus three findings
the issue does not carry — two of which change the decision.

### The issue's own four links hold

1. **`declineInvitation` (`src/services/invitations.ts:928`) writes no
   `TeacherBlock`** — only `status: 'declined'` and `respondedAt`, through a
   CAS `updateMany` scoped `status: 'pending'`.
2. **The refusal therefore *is* the row's `(teacherId, email)` key.**
   `inviteContact` looks it up by exactly that key and answers `DECLINED` on a
   hit (`invitations.ts:260-263`).
3. **Erasure rewrites that key with no status filter.**
   `deleteStudentAccount`'s first two `tx.invitation.updateMany` calls
   (`gdpr.ts:586`, `gdpr.ts:594`) match on `email` alone and set `email` to
   `deleted-<uuid>@deleted.invalid`.
4. **Nothing else catches the re-invite.** The `(teacherId, email)` lookup
   misses, `rosterLinkState` misses, `teacherBlock.findUnique` misses (no block
   was ever written), `delivered` computes `true`, and `POST /api/students`
   fires `deliverInvitation` to the real mailbox.

`TeacherBlock` has exactly one writer today. Re-derive:

```
grep -rn "teacherBlock\.\(create\|upsert\|createMany\)" src/ | grep -v '\.test\.'
→ src/services/invitations.ts:1120   (unlinkTeacher)
```

### Finding 1 — the repo has already ruled on this, through two other doors

Moving a declined row's `email` is not an open question here. Both
teacher-facing doors that could do it already refuse, and
`PUT /api/invitations/[id]:155` says why in as many words:

> The tombstone is keyed on (teacherId, email) — editing the address off a
> declined row would free that address for a fresh invite just as surely as
> deleting the row would, so an edit is the same hole through a second door.

`DELETE` refuses `declined` rows on the same grounds (`CAS_FILTER['not-declined']`).
`deleteStudentAccount` performs exactly that move, unguarded. So #522 is an
inconsistency with a rule this codebase enforces twice, not a new policy call.

**Three bespoke guards on three doors is the signal.** Each guard is correct;
together they say the representation is wrong. A refusal stored as a row needs
no guard on any door.

### Finding 2 — the cost of writing a block is smaller than #522 states

#522 gives Direction 1's cost as "`TeacherBlock` retains a plaintext address
for an erased person — the exact tension `docs/data-model.md` already parks,
widened to every decline". Two corrections:

- **`TeacherBlock.email` is disclosed to nobody.** The three `findUnique`
  readers select `id` only; `exportStudentData` (`gdpr.ts:110`) selects
  `createdAt` and the teacher's name, and is the *subject's own* Art. 15
  export; `listPendingInvitations` reads it as a relation filter that excludes
  rows and returns nothing. Compare `Invitation.email`, which
  `GET /api/invitations` hands to the teacher — that **disclosure** is what made
  #520 refuse the analogous "leave the address intact" option. Retention and
  disclosure are not the same cost, and only one of them is on the table here.
- **For a decliner who never erases, a block row holds no address the system
  does not already hold**, in plaintext, teacher-visible, on the `Invitation`
  row the teacher typed themselves. The whole incremental retention is one
  case: an erased decliner's address surviving in a table no route reads out —
  which is the intended effect, not a side effect.

This also **collapses** the parked legal question rather than widening it.
Today retention-vs-erasure for blocks has two divergent answers depending on
how the student said no. Afterwards there is one answer in one place, so a
later legal review is a single change.

### Finding 3 — a census hazard worth recording

A `grep` for `teacherBlock\.` **under-counts readers**: Prisma relation filters
name the relation field, not the model accessor, so
`listPendingInvitations`'s `teacher: { teacherBlocks: { none: { email } } }`
is invisible to it. Both commands are needed:

```
grep -rn "teacherBlock\." src/ | grep -v '\.test\.'      → 6 sites
grep -rn "teacherBlocks" src/ | grep -v '\.test\.'       → 1 site
```

7 total: 1 upsert (`unlinkTeacher`), 1 `deleteMany` (`resolveInvitationOnLink`),
3 `findUnique` gates (`inviteContact`, `deliverInvitation`, `acceptInvitation`),
1 `findMany` (the subject's own export), 1 relation filter
(`listPendingInvitations`). This spec's own claim that no reader discloses the
address is checked against all 7, not the 6 the first command finds.

### Not a defect, checked and ruled out

The `pending` → `ALREADY_INVITED` probe loses its key to erasure the same way,
but a pending invitation is not a refusal: the teacher typed that address and
never got an answer, so retyping it overrides nobody. Of the four identity
columns `deleteStudentAccount` rewrites (`Student.email`, `Account.email`,
`Invitation.email`, `Invitation.lastNotifiedEmail`), the declined tombstone is
the only refusal among the predicates keyed on them. **Scope of that sweep:**
it covers the columns erasure rewrites, not every mutable-key-derived predicate
in the repo.

## The decision

**A refusal is a row, never a derived key.** `declineInvitation` writes a
`TeacherBlock`, storing the address in plaintext, exactly as `unlinkTeacher`
already does.

Three alternatives were considered and declined:

- **Leave declined rows' `email` intact at erasure.** Smallest diff, but
  `GET /api/invitations` selects `email`, so this is a disclosure cost — the
  thing #520 refused for the general case.
- **Hash the key.** Genuinely better against a database-only compromise, but a
  plain hash of an email is dictionary-reversible (low-entropy address space,
  and the teacher's own contact list is the dictionary), so it needs an HMAC
  pepper. This repo has no such infrastructure — the only hashing is
  `createHash('sha256')` in `db-locks.ts` for advisory-lock keys, which is not
  a secret. It would add a migration, ~7 call sites, and a **silent** failure
  mode (a lost or rotated pepper un-refuses everyone with no error) — the same
  silent-unblocking failure `docs/data-model.md` already rejects scrubbing for.
  On a single VPS the pepper would sit in the same `.env` as the database
  password, so the threat it defends against is largely not the one this
  topology produces. It remains the right shape for the parked
  "scrub or hash" question, for **all** blocks at once, decided on its own terms.
- **Accept and document.** Fails the live-defect floor: decline → erase →
  teacher retypes the address → mail is delivered, with nothing blocking any
  step.

**Why the decline path and not `deleteStudentAccount`.** The set of addresses
retained *after erasure* is identical either way. Writing at erasure adds only
rows for people who never erased — and for those the address is already on the
`Invitation` row. Against that, the erasure placement puts refusal logic in
`gdpr.ts` (whose own comment says "Do not resolve it from in here"), creates a
second `TeacherBlock` writer meaning something different from the first, and
closes only this door. Writing at the moment of the refusal is also what a
suppression list does.

### Precedent

This is not a new pattern for the codebase; it is the one place an established
one was not applied. `Registration.tier_at_booking`, `Class.totalRevenue`,
`Invitation.delivered` and `StudioClassTemplate.archivedAt`/`withdrawnCount`
all persist a fact rather than re-deriving it from state that moves.
`delivered` is the closest: #520 added it last week for this exact reason, and
its docblock already half-states the rule — "worth naming so the next writer of
`Invitation.email` checks this column too".

## Fix 1 — `declineInvitation` writes the suppression entry

`declineInvitation` (`invitations.ts:928`) gains `teacherId` in its `select`,
wraps its CAS in `$transaction`, and upserts a `TeacherBlock` after it.

**Write order: `Invitation` then `TeacherBlock`.** Conformant with
`docs/lock-order.md:7` (`… → StudentPrivacy → TeacherStudent → Invitation →
TeacherBlock`).

**The upsert must be `update: {}`.** `docs/lock-order.md` carries a standing
warning about the sibling upsert in `unlinkTeacher`:

> **If you are the future reader who turns `unlinkTeacher`'s `TeacherBlock`
> `update: {}` into something with a real field in it** (an `updatedAt` stamp,
> a bookkeeping flag, anything) — stop. That edit silently restores the atomic,
> lock-taking path for that upsert, and if the write order at that call site
> doesn't already match this document, you have just reintroduced a live
> `40P01`.

`resolveInvitationOnLink` takes these two tables in the opposite order, and the
`update: {}` no-lock path is the only reason racing them does not deadlock
today. The new upsert races the same function — a student declining while a
booking resolves the same pair — so it inherits the constraint. This is a
policy of the write, not an implementation detail.

**A CAS miss writes no block.** With the status write first, `count === 0`
returns `NOT_PENDING` having written nothing, so the transaction commits
nothing and no sentinel-error rollback is needed — unlike `acceptInvitation`,
whose `NotPendingError` exists because its roster-link write already ran.

**The transaction is for atomicity, not ordering.** Without it, a failure
between the two writes leaves a declined row with no block — today's state, and
silently #522 again for that row. With it the pair is all-or-nothing.

## Fix 2 — the seed, not a backfill

Not in production, so no data migration. `prisma/seed.ts:401` creates one
declined invitation (`declined@example.com`, teacher `ivo`) and the seed writes
no `TeacherBlock` rows at all (`prisma/seed.ts:154` only clears the table), so
it would produce a state the new invariant forbids. It gains the matching
block. `prisma/seed.ts:1220`'s summary line is checked for whether it should
name the block.

## Fix 3 — the route back already works; pin it

No new code. `POST /api/registrations:251` calls `resolveInvitationOnLink`
inside `!isTeacher`, and that function deletes the block unconditionally
(`link-consent.ts:99`) before returning the declined row to `accepted`. The
route's own comment already names the rule:

> only the student's own booking is consent — this call sits inside
> `!isTeacher` on purpose, so a roster add or a walk-in never launders itself
> into acceptance. It clears a decline, which is one of the two routes back
> from one (joining a waitlist … is the other).

`addToWaitlist` (`waitlist.ts:296`) is that second route. `promoteNext` and
`claimSpot` deliberately resolve nothing. `acceptInvitation` is **not** a route
back: it refuses a blocked pair with `NOT_FOUND` (`invitations.ts:816`), and
`listPendingInvitations` filters `teacherBlocks: { none: { email } }`, so a
blocked student never sees the card. Only the student's own affirmative act
lifts a block; nothing the teacher does can.

What changes is that a **decline-written** block travels these paths for the
first time. Tests, not code.

## Fix 4 — make the route back discoverable

Today a declined invitee has no surface telling them the state they are in or
how to leave it. Two additions, both student-facing only.

**Copy is neutral about history, deliberately.** `unlinkTeacher` writes
`status: 'declined'` to the `Invitation` row with no status filter, so a row
the student *accepted* becomes `declined` when they later unlink, and no column
records which act set it (`respondedAt` is written identically by both).
"You declined this invitation" would therefore be false for an ex-student who
left on good terms. The copy states the situation and the action, never the
history.

**4a — at decline time.** `pending-invitation-card.tsx`'s confirm step gains one
sentence: connecting later is possible by booking one of that teacher's
classes. Costs nothing and lands when the information is relevant.

**4b — on `/account/privacy`.** A "Not connected" section beside the existing
"Pending invitations" and "Your teachers" headings, listing teachers whose
invitation row is declined, with a link to that teacher's page.

**Keyed on the declined `Invitation` row, never on `TeacherBlock`.** This is a
privacy requirement, not a convenience. After erasure the block survives and
the invitation row's email is scrubbed — so a *new* account on the same address
(the same person returning, or an address that changed hands) would be told
"you are not connected with this teacher" about an erased person's history if
the query read the block. Reading the invitation row means the message
disappears exactly when the history was erased, while the suppression keeps
working silently. **The block is the rule; the invitation row is the narrative;
only the narrative may be shown to anyone.**

The query mirrors `listPendingInvitations`'s own exclusions —
`teacher: { deletedAt: null, teacherStudents: { none: { student: { email } } } }`
— so a teacher who added this student to their roster while a declined row
stood does not appear as "not connected". It selects `pageSlug` for the link.

**Known gap, accepted:** an unlinker with no invitation row at all (most links
come from bookings) gets no entry. There is no narrative row to read, and
reading the block instead is the disclosure this section exists to avoid.

## Docs to correct

Per `solve-issue` §4, the same claim is corrected everywhere it appears:

- `CLAUDE.md` — "a plain decline does not; the declined `Invitation` row is
  itself the tombstone that blocks a re-invite".
- `docs/data-model.md` — the `TeacherBlock` section's "Written only when a
  student unlinks…" line; design note 589's "a bare decline blocks re-invites
  without a `TeacherBlock` row, only an unlink writes one"; and the parked
  retention paragraph, which becomes one question rather than two divergent
  behaviours.
- `src/services/gdpr.ts` — the docblock at 325 ("but NOT their refusal, which
  this frees (#522)") and the `TeacherBlock` comment at 623, whose framing
  changes even though its conclusion does not.
- `docs/lock-order.md` — the new call site, and the `update: {}` warning now
  covering two upserts.
- **New rule, folded in here rather than filed:** a refusal is a row, never a
  derived key — stated in `docs/data-model.md` beside the `TeacherBlock`
  section, with the erasure-column list as the check. Three doors have now been
  found one at a time; the rule is what catches the fourth.

Corrections replace the wrong claim rather than annotating it. The
before-and-after belongs in the PR body.

## Tests

RED first, and each guard mutation-tested per §3 — broken, exact error text
recorded, restored, re-verified.

1. **The regression pin.** Decline → erase → teacher re-invites the real
   address → no invitation email is sent. Must fail against `main`.
2. Decline writes a `TeacherBlock` for `(teacherId, email)`.
3. A CAS miss (non-`pending` row) writes no block.
4. **Behaviour preservation:** a non-erased decliner's re-invite still answers
   `DECLINED`, not a silently-undelivered creation.
5. **The route back, pinned twice** — decline → book a class with that teacher
   → block gone and the row returns to `accepted`; and the post-erasure shape,
   a new account on the same address booking a class, which passes only
   *because* the block outlived the scrub.
6. **Lock order:** the new upsert keeps `update: {}`.
   `invitations-lock-order.test.ts` is the existing home.
7. **Fix 4b:** the entry renders for a declined row, and does **not** render
   when only a block survives (the erasure case) or when the pair is linked.

Mutation-testing note: tests 2 and 5 share fixtures with existing
unlink-written-block tests. Mutate the **decline** path specifically — a
permissive change makes a shared-fixture test pass for the wrong reason.

## Not in scope

- **Hashing `TeacherBlock.email`.** The parked "scrub or hash" question, which
  applies to unlink-written blocks equally. Filing it as a decision issue with
  the options above is the follow-up; resolving it inside a security fix is not.
- **A per-invitation URL.** The invitation email links to a bare
  `${baseUrl}/login` (`invitations.ts:604`), so there is no invitation link to
  land on, and a valid invitee has to find `/account/privacy` themselves. Worth
  fixing, but adding one turns the email into a capability token — anyone
  holding the link learns an invitation exists for that address — which
  reverses a deliberate design decision (`acceptInvitation` authorizes by
  address precisely because "the invitation id travels in a URL and is not a
  secret"). Its own issue.
- **#502 and #520 are unaffected.** This spec changes no `delivered` semantics
  and no anonymisation token.
