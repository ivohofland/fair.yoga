# Closing the gated ghost invitation's delayed confirmation oracle (#418)

Follow-up to #412 (shipped as #417) and #419. Design decisions, the premise
corrections that reshaped them, and what this deliberately leaves standing.

## 1. The premise, verified

Everything the issue and its status comment measured about the *mechanism*
holds. Re-derived against `origin/main` at `eb1028b7`:

| Claim | Verdict |
|---|---|
| `resolveInvitationOnLink` flips ANY non-accepted invitation for `(teacherId, email)` unconditionally | **Holds** — `src/services/link-consent.ts:82-89`, `status: { not: 'accepted' }` |
| Reachable from `POST /api/registrations` and `addToWaitlist` | **Holds** — `src/app/api/registrations/route.ts:242` (inside `!isTeacher`), `src/services/waitlist.ts:291` |
| The gate's second disjunct is `existing?.status === 'accepted'` at `invitations.ts:298` | **Holds** — the status comment's corrected line number is right; the issue body's `:233` is stale |
| `RosterLinkState.shareEmail` is now `mayBeTold` | **Holds** — `invitations.ts:96` |
| Promotion (`promoteNext`/`claimSpot`) deliberately does not resolve | **Holds** — `waitlist.ts:564` |
| Neither guard's `TeacherStudent` scoping is pinned against an archived link | **Holds** — every `isArchived` in `invitations.gate.test.ts` is on `Invitation.isArchived` |
| No single comparative indistinguishability test exists | **Holds** — the stranger case and the gated case sit in separate `it`s |

One claim does **not** hold, and it is the one the whole issue was scoped
around.

> "Closing it properly needs a way to tell a gated ghost invitation apart from a
> real one *before* `resolveInvitationOnLink` runs — which means a new column on
> `Invitation` (or an equivalent marker)." — #418
>
> "closing it needs a new column recording that a link's acceptance was
> gate-suppressed … and no cheaper alternative exists." —
> `2026-09-03-already-linked-email-confirmation-design.md`, §"Filed, not folded"

A marker is needed. A **column** is not. `linkTeacherStudent`
(`src/services/roster-link.ts`) is `createMany({ skipDuplicates: true })`, which
Prisma compiles to a single `INSERT … ON CONFLICT DO NOTHING`, and the
`BatchPayload.count` it already returns *is* the fact: `1` when this call
inserted the row, `0` when the link already stood. Measured directly against
`ethical_yoga_test` with a throwaway probe before this spec was written — first
call `{"count":1}`, second `{"count":0}`.

That fact is available in the same statement, inside the same transaction, with
no extra query and no new lock node. The whole reason the issue reached for a
column — "there is no way to know at resolution time" — is false.

### The derived fact is not merely cheaper — it is more correct

A persisted `gatedAt` would record where the row came *from*. The question that
actually matters at resolution time is about the pair right *now*, and the two
come apart on a path that exists today:

`PUT /api/invitations/[id]` can move a row's `email`. A teacher can therefore
take a genuine, delivered, un-marked invitation to a stranger and re-address it
to a linked-but-unshared student. An origin marker is not set on that row, so it
would still flip on the student's next booking and the oracle would still be
open through a second door. The runtime fact closes that door too — a
re-addressed `pending` row resolves no more readily than any other, and there is
no marker to launder.

That is the **`pending`** half of that route, and it is the whole of what this
branch closes there. The same PUT walked with an **`accepted`** row never
reaches `resolveInvitationOnLink` at all, so no condition on this function can
touch it: the route gates on ownership and a `declined` status only
(`src/app/api/invitations/[id]/route.ts:86-93` — no roster-link check, no other
status check), so a teacher holding any `accepted` invitation can `PUT` its
`email` to a guessed address and then `POST /api/students` with that same
address. `inviteContact` falls past both early returns and meets the gate's
second disjunct (`invitations.ts:299`), answering `ALREADY_LINKED` when the
address is linked to that teacher and an ordinary `201` when it is a stranger's.
Two HTTP calls, no student action. This is a **pre-existing #412/#417
residual** rather than anything this branch introduces or was scoped to fix,
and it is filed as #500; the fix belongs on the PUT route,
not here.

## 2. The decision

`resolveInvitationOnLink` gains one input: whether the student's act **created**
the link, rather than finding one already there. It ships as a two-member
union, `LinkOutcome` (`src/services/roster-link.ts`), returned by
`linkTeacherStudent` and taken by `resolveInvitationOnLink` — a `boolean` on
that parameter would accept any other boolean in scope, and the wrong `true`
is the oracle reopening.

```
                     'created'                     'already-linked'
TeacherBlock         deleted                       deleted            (unchanged)
Invitation pending   → accepted                    left standing      (THE CHANGE)
Invitation declined  → accepted                    → accepted         (unchanged)
Invitation accepted  untouched                     untouched          (unchanged)
```

Stated as prose, so a reader does not have to re-derive it from a table: **a
booking or waitlist join resolves a `pending` invitation only when it was the
act that put the student on the roster.** Someone already on the roster has
nothing left to consent to; there is no acceptance for their booking to express.
A `declined` row is different in kind and is cleared either way — it is a
standing refusal, and reversing it is the escape hatch the whole decline design
rests on.

### Why `declined` stays unconditional

Not symmetry-for-its-own-sake, and not an oversight — but not for the reason
first written here either. That reason was "`declined` implies unlinked at the
moment it is written", from `unlinkTeacher` (`invitations.ts:1083`) writing the
tombstone and deleting the `TeacherStudent` row in one transaction. It is
false: `declineInvitation` (`invitations.ts:925`) also writes `declined`, with
no link write and no link check, so a tombstone standing beside a live link is
a state the app itself produces.

The decision survives that, and is stronger for it. Two things hold it up.

**Narrowing `declined` would only strand students.** With the false premise,
the affected population looked like a race (`promoteNext`/`claimSpot`
re-linking around an unlink). Without it, it is anyone who declined while
linked as well — a larger set, all of them stuck the same way: linked,
unblocked, and permanently un-re-invitable behind a tombstone that `DELETE
/api/invitations/[id]` refuses to remove.

**And a `declined` row is not an address a teacher can write to.** Both
writers are reached only through the invitee's own session — `DELETE
/api/teacher-links/[teacherId]` and `POST /api/invitations/[id]/respond`, both
`requireStudent`, both taking the student from the session and never from the
request. A teacher cannot manufacture a `declined` row at a guessed address,
which is what turning this half into an oracle would require. That argument
does not depend on link state at all, so nothing about it can be falsified the
way the first one was.

### What is deliberately not changed

- **`TeacherBlock` deletion stays unconditional.** It is about deliverability,
  not about the oracle, and a teacher can observe blocks nowhere (that is the
  entire reason `TeacherBlock` is its own table — `docs/data-model.md`,
  TeacherBlock). Making it conditional would add a branch with no property
  behind it.
- **`acceptInvitation` and `declineInvitation` are untouched.** A decoy row is
  hidden from the student by `listPendingInvitations`' already-linked exclusion,
  so reaching either would mean guessing a v4 UUID. More decisively: the *victim*
  of that path is the student, and the *attacker* in this threat model is the
  teacher, who cannot cause it. A door only the victim can open is not an
  oracle. Classified, not overlooked.
- **No migration.** No new column, no new constraint, no new index — so
  `docs/lock-order.md` is untouched by construction: same tables, same
  acquisition order, one narrowed `WHERE` on an `updateMany` that already ran.

## 3. What the teacher can observe afterwards

The probe-wait-probe sequence:

| Step | Genuine stranger | Gated linked-unshared student |
|---|---|---|
| Probe 1 | 201, row `pending`, delivered | 201, row `pending`, **not** delivered (invisible on the wire) |
| Student does something ordinary | may accept → `accepted` | **nothing happens** (was: → `accepted`) |
| Probe 2 | `ALREADY_INVITED`, or `ALREADY_LINKED` if they accepted | `ALREADY_INVITED` |

The gated row's second probe now lands on the same refusal an un-accepted
stranger's does, which is the ordinary outcome for most invitations. Both of the
issue's consequences follow from the single flip and go with it:

1. The directory signal ("my pending contact resolved but the directory gained
   nobody") — there is no resolution left to notice.
2. The working slower oracle — the `existing?.status === 'accepted'` disjunct is
   never reached for a gated row, because a gated row never becomes `accepted`.

### The residual this leaves, stated honestly

A decoy row never resolves *by itself*, ever. A genuine invitation to a real
platform user might. That is a statistical difference, not a channel: an
invitation nobody accepts is the common case, and it is indistinguishable from a
stranger who ignored the mail. The teacher can archive or delete the row exactly
as they can any other, and a re-probe after deleting it creates a fresh decoy.

One behaviour is *lost*, and it is worth naming rather than discovering later.
Wherever a `pending` invitation comes to stand beside a `TeacherStudent` link
that no act of the student's created *for it*, that invitation now stays pending
instead of flipping on the student's next booking. **Two routes reach that
state, and the first of them is an ordinary CRM action.**

- **The teacher moves an address onto a linked pair.** `PUT
  /api/invitations/[id]` accepts an arbitrary `email` edit —
  `updateInvitationSchema` permits it (`src/lib/schemas.ts:276-280`) and the
  route gates only on ownership, a `declined` status and the `(teacherId,
  email)` unique key (`route.ts:78-152`). There is **no roster-link check**. So
  a teacher fixing a typo'd address onto someone already on their roster lands
  a `pending` row beside an existing link, with no waitlist row anywhere in it.
  Staying `pending` here is the **correct** outcome rather than a regression,
  and §1 above is the argument for exactly this case: a row that resolved here
  would tell the teacher that the address they typed belongs to one of their
  own students, which is the oracle — through a second door, and one a
  persisted origin marker would not have closed, since no marker is set on a
  re-addressed row.
- **A linkless `waiting` row is promoted.** The link creators that resolve
  nothing are `promoteNext` and `claimSpot` (`waitlist.ts`, each writing the
  link beside its `activateRegistration` call — that function creates the
  `Registration`, not the link); `acceptInvitation` creates one too and
  resolves the row itself. So only the two promotions are in question, and
  reaching either needs a `waiting` row. They abstain for different reasons,
  and `docs/data-model.md` (Invitation) is where that is settled: a promotion
  is never the promoted student's own act, whichever of `handleSpotFreed`'s
  callers fired it, while a claim IS the student's own act at that instant
  (`POST /api/waitlist/claim` is `requireSession` and self-only,
  `src/app/api/waitlist/claim/route.ts:19-24`) and abstains on the other bar:
  its link write can insert only where the join's own is missing — a linkless
  `waiting` row, or one whose link a later unlink deleted — so every link a
  claim creates is a repair, and a repair is not a fresh act of consent. A queue join normally links *and* resolves — but not every `waiting` row
  came from one, and two comments in `waitlist.ts` say so. `promoteNext`'s link
  write exists precisely to repair the ones that did not: "a `waiting` row
  written before that change, and one written by hand (fixtures, a psql
  fix-up)" (`waitlist.ts:558-564`). And `withdrawWaitingEntriesForTeacher`'s
  docblock names an unlink committing after a join's withdrawal window as "the
  one way a `waiting` entry can outlive its link" (`waitlist.ts:1075-1082`).

  Concretely, for a `waiting` row that never carried a link — pre-#166, or
  hand-written: the teacher invites that pair while it is unlinked, so the row
  is `pending` and genuinely delivered. Then any cancellation (`handleSpotFreed` →
  `promoteNext`) creates the link and resolves nothing. The pair is now linked
  with a `pending` row standing, and every later booking passes
  `'already-linked'`, so nothing the student does clears it again — the
  teacher's `DELETE` or archive is the only exit left. The teacher sees that
  person as an "Invited" contact *and* in their student directory;
  `listPendingInvitations`' already-linked exclusion (§4 of the #412 spec)
  hides the row from the student, so nobody can answer it. Both exits still
  work — the row is `pending`, not `declined`, so `PATCH ?state=archived` and
  `DELETE` both take it. The staging is not hypothetical: two existing tests
  build exactly this fixture, hand-writing the linkless `waiting` row —
  `waitlist.test.ts`'s "a promotion repairs a missing link but leaves the
  invitation as it stands" and `invitations-api.test.ts`'s "promoting off the
  waitlist repairs a missing link and resolves nothing". Both assert the row
  stays `pending`; what changes is that a later booking no longer clears it.

**The unlink race is not a third route.** What `unlinkTeacher` leaves behind is
a `declined` tombstone, and `declined` is exactly the half this change leaves
unconditional — so a promotion re-linking around that race is followed by a
booking that still clears the tombstone and the `TeacherBlock` with it. That is
the state §2's "Why `declined` stays unconditional" is about.

Both routes leave the same artifact: a lingering "Invited" contact, which is
what a decoy already is, and what #417 established as load-bearing rather than
tolerated. Both exits still take it, and a re-probe after deleting it creates a
fresh decoy. What the two routes differ in is how often they are walked, not in
what they leave behind. The PUT is an ordinary edit any teacher can make today;
the promotion needs a `waiting` row the app itself did not write, and how many
of those exist is a data question this branch does not answer. The repo is not
of one mind about it either: `src/lib/student-visibility.ts:172-180` argues
from a premise that would settle it — no production deployment, so no legacy
rows of any kind survive — though the claim it actually makes there is about
unclaimed `Student` rows rather than `waiting` ones, while `CLAUDE.md`'s Data
Model section assumes pre-#166 rows can still be around. Either way the fix is
the teacher's own `DELETE`, and no path here becomes an oracle.

**Two writers MUTATE a standing decoy, and both are outside what this branch
touches.** The two routes above are about what leaves a decoy standing; these
are about what happens to one afterwards. Both are pre-existing, both matter
more now that a decoy is permanent, and both are filed as **#502** rather than
fixed here.

- `deleteStudentAccount` (`src/services/gdpr.ts`) rewrites every `Invitation`
  row matching the erased student's address to
  `deleted-<studentId>@deleted.invalid`, with no status or link scope. A decoy
  is such a row. `GET /api/invitations` returns `email`, so the teacher's
  contact list shows the rewritten address — which says the person behind that
  guessed address erased their account.
- `unlinkTeacher` (`src/services/invitations.ts`) flips every `Invitation` for
  `(teacherId, email)` to `declined`, likewise unscoped by status. A decoy the
  student never saw therefore reads as a refusal they never made — and the
  teacher watching for a status change gets one.

Neither is reachable by the teacher's own action alone, which is why they are
follow-ups rather than a blocker: each needs the student to erase or unlink.

The concurrent-insert race is the same shape and equally benign, for the two
resolving callers: a booking and a queue join in flight together, one inserts
and resolves, the other finds the link and skips. The invitation is resolved
either way. `claimSpot` is not in that set — it is the student's own request
and resolves nothing — so a claim racing a booking leaves whatever the booking
decided, which is the same answer the booking alone would have given.

## 4. The bundled gaps

Both are test-only, both were re-verified above, and the first stopped being
optional when #424 shipped.

**A. Archived-link scoping.** #424's second `log.warn` tripwire in
`rosterLinkState` was justified by one sentence, and that sentence is false.
It read: `teacherStudents` here is unfiltered while `GET /api/students` scopes
its listing to `isArchived: false`, so an archived unclaimed contact is
bypassed here and logged nowhere else. The route does not scope to `false` —
it reads `isArchived` from an `archived` query parameter
(`src/app/api/students/route.ts:20-23`), which `student-directory.tsx:47`
sends as `'true'` for the archive tab — and that listing projects every row
through `projectStudentForTeacher` → `bypassesPrivacy`
(`src/lib/student-visibility.ts`), which logs the same bypass under its own
message. So an archived unclaimed contact is logged in two places, not one.

Task 3 therefore replaces that sentence in both shipped copies — the comment
at `invitations.ts:162-165` and the gate test's own tripwire docblock — with
what the select actually holds: `teacherStudents` is unfiltered, so an
archived link still answers `linked` here, same as a live one. The tripwire
itself stays; what changes is the reason given for it.

The gap it was really about survives untouched. Adding `isArchived: false` to
that select (`invitations.ts:149`) leaves the whole suite green, and
`notifyInvitee`'s roster check (`invitations.ts:558`) has the same unfiltered
read and the same missing pin. Archiving is a CRM filing action, not an
unlink; both guards correctly treat an archived link as still-linked, and that
is the thing to hold down.

**B. Indistinguishability, side by side.** The stranger case and the gated case
are each asserted, in different `describe` blocks, against different fixtures.
Nothing compares them. One test that invites a genuine stranger and a gated
linked-unshared student through the same code path and asserts the two outcomes
are *equal* — same `ok`, same result shape, same resulting row shape — is what
makes a future divergence fail rather than merely go unnoticed.

## 5. Verification

`resolveInvitationOnLink`'s callers are the two service/route sites and
`invitations-lock-order.test.ts:613`. The behaviour tests live in the `unit`
tier (`src/services/`), which runs against `ethical_yoga_test` and **does** run
from a worktree — confirmed by running `src/services/roster-link.test.ts` here
before any edit. `integration` and `e2e` cannot: both are wired to the app on
`:3000` and the shared dev database, which a worktree has neither of. The PR
body cites the CI run for those two tiers, not a local pass.

Each new guard gets its mutation recorded: the condition is broken, the exact
failure text captured, the mutation reverted, and the suite re-run green.
