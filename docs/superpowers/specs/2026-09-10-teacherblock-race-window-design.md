# #537: acceptInvitation misses a TeacherBlock committed after its outside pre-check

## Problem, as measured

`acceptInvitation` (`src/services/invitations.ts`) reads `TeacherBlock` once, in a
`db.teacherBlock.findUnique` call **before** its `$transaction` opens, and never
re-reads it inside. A block `unlinkTeacher` or `declineInvitation` commits in the gap
between that read and the transaction's own writes is invisible to it.

Confirmed against this branch (`git show origin/main:src/services/invitations.ts`,
`acceptInvitation`, lines ~886-1002): the outside read stands, unchanged, and the
transaction below it never consults `TeacherBlock` again before either success
return. The issue's own "Ruled out" section (not #522, not a delivery hole, not the
`TeacherStudent`/`Invitation` ordering) is confirmed the same way — #522 fixed a
different hole (retention through erasure), and the CAS/re-read ordering this fix
sits beside is untouched.

## Premise correction: `declineInvitation` cannot reproduce this race

The issue names `declineInvitation` as "a second producer of the racing commit" and
asks for a staged-race test using it as the blocker, parallel to `unlinkTeacher`'s.
It cannot be, and the asymmetry is structural, not incidental:

- `unlinkTeacher` writes `TeacherBlock` **unconditionally** — regardless of the
  paired `Invitation` row's status — and its own `Invitation` write is scoped to
  `delivered: true` (#502). On a `delivered: false` row, `unlinkTeacher` commits a
  block while leaving that row's `status` exactly as it was. That decoupling is what
  makes the race possible: a block can exist while the row still reads `pending` (or
  `accepted`, from an earlier successful accept), because the writer that landed the
  block never touched status at all.
- `declineInvitation` writes `TeacherBlock` **only after its own CAS**
  (`updateMany({ where: { id, status: 'pending' } })`) has already moved that exact
  same row to `declined`, in the same transaction. There is no interleaving in which
  `declineInvitation` commits a block without the row's status changing alongside
  it, in the same commit. Racing it against `acceptInvitation` on the same
  `(teacherId, email)` pair (the only pair `@@unique([teacherId, email])` allows) is
  therefore always safe already: whichever of the two CAS-shaped writers reaches the
  row's `pending` status first wins it, and the loser's own CAS (`acceptInvitation`'s
  `updateMany`, or its re-read) observes a non-`pending`, non-`accepted` status and
  throws `NotPendingError` — the pre-existing mechanism, unrelated to this fix.

So the two staged-race tests this fix needs are not "one per blocker function" — only
`unlinkTeacher` can play that role — but one per **pre-existing branch the CAS below
can still take** when a block lands in the gap:

1. The row is still `pending` when `acceptInvitation`'s CAS runs: without the fix,
   the CAS itself succeeds (`updated.count > 0`) — the issue's "pending,
   `delivered: false`" row.
2. The row is already `accepted` (a prior, non-racing accept succeeded first):
   without the fix, the CAS matches nothing and the idempotent re-read
   (`current?.status === 'accepted'`) treats it as success — the issue's
   "accepted, `delivered: false`" row.

No test is added for `declineInvitation` as a blocker. The existing coverage in
`invitations.decline.test.ts` (`describe('acceptInvitation, with a block standing')`,
and `'writes no block when the CAS misses, so a non-pending row cannot silently
suppress'`) already demonstrates decline-vs-accept interactions stay safe, and stays
correct after this fix — nothing about those tests exercises the code this fix adds
or removes.

## Reachability: `accepted` + `delivered: false` — settled

Reachable, two ways:

- **Without a race at all.** `invitations.decline.test.ts`'s
  `'answers NOT_PENDING for an accepted row on a blocked pair, and commits no
  link'` already constructs it sequentially: accept succeeds on a `delivered: false`
  invitation, then `unlinkTeacher` deletes the link and writes the block, leaving the
  row `accepted, delivered: false`. That test passes today because the **outside**
  guard's `blocked ? (status === 'pending' ? NOT_FOUND : NOT_PENDING) : ...` branch
  catches it — the block already stands by the time a second `acceptInvitation` call
  even starts.
- **As a race** (this fix's test 2, above): the same row, but the block lands
  *after* a second `acceptInvitation` call's outside pre-check has already read "no
  block" — which is exactly the window the outside guard cannot cover, and the case
  the issue's own table row 3 describes.

## The fix

In `acceptInvitation`'s transaction, immediately after the `linkTeacherStudent` call
and before the `tx.invitation.updateMany` CAS, re-read `TeacherBlock` and throw the
existing `NotPendingError` when it is present. Placed there — after the roster-link
write, before either success return (the CAS's own `count > 0` path, and the
`count === 0` + idempotent-re-read path) — one statement closes both of the branches
named above, because both currently return success further down from this exact
point.

> **Where it landed is not where this section puts it.** PR review found this
> position still leaks: a block committing between the re-check and the CAS is
> missed, and the CAS then flips the row to `accepted` and answers `{ ok: true }` —
> measured, and now pinned by `'a block committed between the roster-link write and
> the CAS is not missed'` (`invitations-lock-order.test.ts`). It shipped instead as
> the LAST statement before the callback's `return true`, after the
> `updated.count === 0` branch closes — still before either success return, just
> later than this section says. And it **narrows** that window rather than
> **closing** it: a plain non-locking `SELECT` under READ COMMITTED can only ever
> report "no block as of now", so a block committing between it and the
> transaction's own commit is still missed, at any position — this section's
> "closes" above is the claim to revise if you're reading this alongside the code.
> Two tests beyond the two this document's Acceptance section names shipped with
> it, discriminating "inside the transaction" and "before the CAS specifically" —
> neither of the two originally planned proves the re-check runs inside the
> transaction at all, since both stage their race on the outside pre-check, fully
> resolved before `$transaction` opens.

Reusing `NotPendingError` rather than a new class: the disclosure reasoning
`acceptInvitation`'s docblock already gives for mapping every mid-transaction give-up
to `reason: 'NOT_PENDING'` applies identically here — the caller's own email match
already proved they own the address, so naming a status-shaped refusal discloses
nothing about a block they did not, themselves, just cause (by declining or
unlinking on their own session).

No lock-order concern: the added statement is a plain `tx.teacherBlock.findUnique`
(no `FOR UPDATE`), and a plain `SELECT` under Postgres's default READ COMMITTED
takes no row lock and never blocks on one — it cannot introduce a wait edge, so
`docs/lock-order.md`'s write-ordering census (scoped to `update`/`updateMany`/
`upsert` call sites — see its "Re-derive both halves of that claim" grep) is
unaffected and needs no edit. Recorded here so a future reader does not mistake the
omission for one.

## Claims this fix invalidates, and where

Two places assert that the **outside** pre-check is the only thing distinguishing an
`accepted`-on-a-blocked-pair row from a `declined` one in a test — both go false
once the in-transaction re-check exists, because it now refuses the `accepted` arm
independently of the outside guard:

- `src/services/invitations.ts`, `acceptInvitation`'s own docblock (the paragraph
  ending "...the `accepted` one is the arm that goes red").
- `src/services/invitations.decline.test.ts`, the inline comment on
  `'answers NOT_PENDING for an accepted row on a blocked pair, and commits no
  link'` (lines ~381-386).

Both need rewriting, not merely a caveat added beside the old claim — see the plan
for the replacement text.

## Acceptance (superseding the issue's own list where corrected above)

- [ ] `acceptInvitation` re-reads `TeacherBlock` inside its transaction, after
      `linkTeacherStudent`, before either success return; throws `NotPendingError`
      when present.
- [ ] Staged-race test: block lands after the outside pre-check, row still
      `pending` — mutation-tested (remove the re-check, confirm red, restore).
- [ ] Staged-race test: block lands after the outside pre-check on a retried accept,
      row already `accepted` — mutation-tested the same way.
- [ ] No test added for `declineInvitation` as blocker; this document records why.
- [ ] `acceptInvitation`'s docblock and `NotPendingError`'s docblock state the
      mechanism as it exists now (two checks, two different jobs), not the
      pre-fix "only one arm" claim.
- [ ] `invitations.decline.test.ts`'s stale inline comment corrected.
- [ ] The `delivered: true` (tombstone) path's existing tests keep passing,
      unmodified.
- [ ] `docs/lock-order.md` left unedited; this document states why.
