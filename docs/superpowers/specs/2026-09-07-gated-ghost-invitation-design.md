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
open through a second door. The runtime fact closes both doors with one
condition, and there is no marker to launder.

## 2. The decision

`resolveInvitationOnLink` gains one input: whether the student's act **created**
the link, rather than finding one already there.

```
                     linkCreatedNow: true          linkCreatedNow: false
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

Not symmetry-for-its-own-sake, and not an oversight. `unlinkTeacher`
(`invitations.ts:1085`) writes the `declined` tombstone and deletes the
`TeacherStudent` row in **one transaction**, so `declined` implies unlinked at
the moment it is written. Every ordinary route back — book a class, join a queue
— therefore *creates* the link and takes the `linkCreatedNow: true` column
anyway. Narrowing `declined` would change behaviour only in states reachable by
a `promoteNext`/`claimSpot` re-link racing an unlink, and in exactly those
states the student would be stuck: linked, unblocked, and permanently
un-re-invitable behind a tombstone that `DELETE /api/invitations/[id]` refuses
to remove. Leaving `declined` alone means the change cannot regress the one
behaviour in this function that a student's access depends on.

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

One behaviour is *lost*, and it is worth naming rather than discovering later. If
a `TeacherStudent` link is created by something other than the student's own
resolving act while a `pending` invitation stands, that invitation now stays
pending forever instead of flipping on the student's next booking. The
non-student link creators are `promoteNext`, `claimSpot`, `activateRegistration`
(`waitlist.ts`) and `acceptInvitation` — every one of which requires the student
to have already joined a queue (which links *and* resolves) or accepted (which
resolves directly), so a `pending` row cannot survive into that state by any
sequence this codebase produces. Where it did, the outcome would be a lingering
"Invited" contact — the same benign artifact a decoy already is, and the same
one #417 established as load-bearing rather than tolerated.

The concurrent-insert race is the same shape and equally benign: two of the
student's own requests in flight, one inserts and resolves, the other skips. The
invitation is resolved either way.

## 4. The bundled gaps

Both are test-only, both were re-verified above, and the first stopped being
optional when #424 shipped.

**A. Archived-link scoping.** #424's second `log.warn` tripwire in
`rosterLinkState` is justified by one sentence: `teacherStudents` here is
unfiltered while `GET /api/students` scopes to `isArchived: false`, so an
archived unclaimed contact is bypassed here and logged nowhere else. Adding
`isArchived: false` to that select (`invitations.ts:149`) leaves the whole suite
green while the comment becomes false and the tripwire's only argument
evaporates. `notifyInvitee`'s roster check (`invitations.ts:555`) has the same
unfiltered read and the same missing pin. Archiving is a CRM filing action, not
an unlink; both guards correctly treat an archived link as still-linked, and
that is the thing to hold down.

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
