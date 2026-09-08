# Closing the two decoy-Invitation leaks from #502

## What's measured

Both writers and both leaks in #502 are confirmed exactly as filed, against
`origin/main` at `d6f452ac` (`git diff` against that commit for the four
files #502 cites is empty — no drift since the issue was written):

1. **`deleteStudentAccount`** (`src/services/gdpr.ts:576-611`) anonymises
   `Invitation` rows matching the erased student's email in three
   `tx.invitation.updateMany` calls. The first two write
   `email: \`deleted-${studentId}@deleted.invalid\`` (plus `firstName:
   'Deleted'`, `lastName: 'Student'`); the third writes the same literal to
   `lastNotifiedEmail` only. `GET /api/invitations`
   (`src/app/api/invitations/route.ts:11-17`) selects `id, email, firstName,
   lastName, status, isArchived, createdAt` — `email` reaches the teacher,
   `lastNotifiedEmail` never does (not selected anywhere; confirmed by
   grepping every `.invitation.find*` call in `src/app` and `src/services` —
   the only other reader is `exportStudentData`, Art. 15, which is the
   *subject's own* export, a different audience this issue does not concern).
   So today's exploitable leak is on `email` only, but `lastNotifiedEmail`'s
   write is the same pattern and `docs/data-model.md:216` documents both in
   the same breath — see "Why `lastNotifiedEmail` gets the same fix" below.

2. **`unlinkTeacher`** (`src/services/invitations.ts:1087-1090`) writes
   `status: 'declined', respondedAt: new Date()` to every `Invitation` row
   matching `{ teacherId, email }` — no scope on whether the row was ever
   delivered. `unlinkTeacher` runs only from `DELETE
   /api/teacher-links/[teacherId]`, `requireStudent`-gated — the student
   who is leaving triggers their own tombstone write, the same actor shape as
   #1's erasure.

3. **Confirmed: no persisted signal distinguishes a decoy (delivery
   withheld) from a genuine invitation.** `inviteContact`
   (`src/services/invitations.ts:237-372`) computes `delivered: blocked ===
   null && !link.linked` (line 371) and returns it as part of `InviteResult`
   — used once, by the caller, to decide whether to call `deliverInvitation`
   (`src/app/api/students/route.ts:134-140`), then discarded. The `Invitation`
   row itself (`create` at line 331, `revivePendingInvitation`'s `updateMany`
   at line 414) never stores it. `lastNotifiedAt`/`lastNotifiedEmail`
   (`students/route.ts:121-124`) are written **unconditionally**, deliberately,
   specifically so a teacher can't infer `TeacherBlock` status from whether
   that timestamp advances — so those columns are useless as a
   delivered/decoy signal too, by design.

4. **This is not a new class of problem for this codebase.** #418's own
   follow-up issue (fixed, PR #501) already named "a new column tracking
   gated-vs-real invitations" as the way to close a *related* oracle
   (`resolveInvitationOnLink` resolving a ghost invitation on the student's
   next booking), and parked it only because #417's plan forbade migrations
   at the time. That constraint doesn't apply here — CLAUDE.md treats
   migrations as routine ("Database changes require migrations... always
   create a migration"), and this repo has ten-plus recent examples of
   single-purpose `ALTER TABLE ... ADD COLUMN` migrations. This spec adds
   the column #418 anticipated, scoped strictly to #502's two writers — it
   does not touch `resolveInvitationOnLink` or attempt to close #418's own
   named residual (see "Not in scope").

## The decision

### Fix #1 — stop deriving the anonymised value from `studentId`

Replace the `studentId`-derived literal with one random, per-erasure token,
generated once per `deleteStudentAccount` call and reused across all three
`updateMany` statements:

```ts
import crypto from 'crypto';
// ...
const anonymizedEmail = \`deleted-${crypto.randomUUID()}@deleted.invalid\`;
```

`crypto.randomUUID()` matches this codebase's existing convention for opaque
tokens (`src/lib/auth/magic-link.ts`, `origin-nonce.ts`, `handoff.ts`,
`session.ts` all `import crypto from 'crypto'`; none of them use
`oslo/crypto`, despite CLAUDE.md's tech-stack line — that line is aspirational
for this codebase's actual auth module, not a constraint on this change). It
is already lowercase and hyphenated exactly like the UUID it replaces, so it
satisfies `Invitation_email_lowercase_check` (`email = lower(email)` — the
**only** format constraint on the column, confirmed by reading
`20260805074500_invitation_check_constraints/migration.sql` in full) the same
way the old value did, with no other CHECK affected.

**One token, reused across all three statements, not one per row.** Each
`updateMany` still applies a single literal to every row it matches — that
is unchanged from today. Reusing the *same* token across the (at most one
per teacher, by `@@unique([teacherId, email])`) rows it touches is safe:
no teacher can see another teacher's `Invitation` rows on any surface this
app exposes, so two different teachers' rows collapsing to the same
anonymised address discloses nothing to either of them — exactly the
uniqueness property the current `studentId`-derived value already relies on
for the same reason.

**Why `lastNotifiedEmail` gets the same fix, even though it is not
teacher-selected today.** The third `updateMany` (`gdpr.ts:608-611`) also
writes `deleted-${studentId}@deleted.invalid`, to a column `GET
/api/invitations` does not select. Leaving that one statement alone would
mean two of three sibling statements stop encoding `studentId` and the third
keeps doing it — a latent trap for the next surface that ever selects
`lastNotifiedEmail` (a future admin/debug view, an audit export), and an
inconsistency a reader of `gdpr.ts` would have to explain. Reusing
`anonymizedEmail` in the third statement too costs nothing extra (same
variable, no new query) and removes the drift. `docs/data-model.md:216`,
which documents this exact pattern in prose, gets corrected to match.

`firstName`/`lastName` already anonymise to fixed literals (`'Deleted'`,
`'Student'`) that encode nothing — no change needed there.

### Fix #2 — persist `delivered`, scope the unlink tombstone by it

Add `delivered Boolean @default(true)` to `Invitation`:

```prisma
model Invitation {
  // ...existing fields...
  delivered Boolean @default(true)
}
```

Migration (`npx prisma migrate dev --name invitation_delivered_marker`):

```sql
ALTER TABLE "Invitation" ADD COLUMN "delivered" BOOLEAN NOT NULL DEFAULT true;
```

`DEFAULT true` is the correct backfill for every pre-existing row: this
repo has never persisted the fact before, so there is no historical answer
to recover — and `true` preserves current behaviour for every row that
already exists (still tombstoned on unlink, still fully anonymised on
erasure), so this migration changes nothing for legacy data. Only rows
created or revived *after* this ships get an honest value.

**Write it exactly where `inviteContact` already computes the answer.**
`blocked` (the `TeacherBlock` check, currently line 366, run once, after
both the create and revive branches) moves earlier — to just after
`rosterLinkState` is read (after line 298) and before the `if (existing)`
branch at line 304 — so the same `blocked === null && !link.linked`
expression is available to pass into **both** writes:

- the `create` at line 331: add `delivered: blocked === null &&
  !link.linked` to `data`.
- `revivePendingInvitation` (line 409): add a `delivered: boolean` parameter,
  passed from the same expression at its one call site (line 305), added to
  its `updateMany`'s `data` alongside the existing fields.

Moving `blocked`'s read earlier is safe: it is a plain `db.teacherBlock.
findUnique`, not part of a transaction (`inviteContact` runs no
`$transaction` at all), with no ordering dependency on the create/revive
write — the comment currently justifying its position (`invitations.ts:357-
365`) argues only that it's *shared* by both branches, which stays true
above them.

**Scope `unlinkTeacher`'s tombstone to delivered rows:**

```ts
await tx.invitation.updateMany({
  where: { teacherId: input.teacherId, email, delivered: true },
  data: { status: 'declined', respondedAt: new Date() },
});
```

A never-delivered row now stays `pending` forever when its guessed student
unlinks — which is not a new kind of state. #418 already established that a
gated/decoy invitation never resolves to `accepted` by itself; this makes
"never resolves to `declined` by itself either" the same property, for the
same reason: the invitee was never told anything exists to decline, so a
`declined` status on their behalf was never an honest transcript of anything
that happened. `GET /api/invitations` keeps returning that row exactly as
it did the moment it was created — no new observable state, no new
teacher-visible field, nothing to correlate against the unlink.

A genuinely delivered `pending` row that still exists at unlink time (the
two residual routes `docs/superpowers/specs/2026-09-07-gated-ghost-
invitation-design.md` §3 already names — a `PUT`-readdressed row landing on
a linked pair, or a linkless `waiting`-row promotion) is unaffected: it was
delivered, `delivered: true`, the tombstone still fires exactly as before.

**Never select `delivered` from any student- or teacher-facing route.**
`GET /api/invitations`'s select list stays exactly as it is today — an
explicit, narrow field list that does not name `delivered`, the same
pattern every other route already uses to keep new columns out of a
response by default. No new named `satisfies`-tethered constant is needed
for one call site; the plan adds a test pinning that the response shape
doesn't gain the field, so a future edit to that `select` has to fail a
test to reintroduce this.

### `acceptInvitation` / `declineInvitation` / `resolveInvitationOnLink` are unaffected

All three act on a *specific* invitation id the student already has —
`acceptInvitation`/`declineInvitation` from `listPendingInvitations`, which
already excludes an already-linked pair (#412's suppression); a decoy's id
never reaches the student who'd need it to call either. `resolveInvitationOnLink`
only ever resolves a `pending` row when the student's own act *created* the
link (#418) — a decoy is, by construction, already linked before it exists,
so that function never reaches it either. None of the three need the new
column.

## What this does not do

- **#418's own named residual (the `resolveInvitationOnLink` "delayed, not
  closed" oracle) is unaffected.** This spec adds the marker column #418
  anticipated, but does not wire it into `resolveInvitationOnLink` or change
  that function's behaviour at all — doing so is a separate, already-scoped
  follow-up with its own design question (skip resolving a gated ghost
  entirely vs. resolve it to a hidden state), not something to ride along
  with #502's two writers.
- **`TeacherBlock` is still not scrubbed on erasure.** Unrelated to this
  issue; `gdpr.ts:613-623`'s existing comment already documents this as an
  open, parked GDPR question.
- **No change to what a teacher can infer from the `existing` row shape at
  invite time** (`inviteContact`'s own `ALREADY_LINKED`/`ALREADY_INVITED`
  gates) — #502 is only about what two *mutation* writers do to an existing
  row, not about invite-time responses.
- **A decoy planted before this migration ships stays exploitable via #2
  until it is next touched.** The backfill cannot retroactively know which
  pre-existing `pending` rows were ever delivered, so every row that exists
  at migration time gets `delivered: true` — including real decoys already
  planted under the old code. Fix #2 only protects a decoy from this point
  forward: one created (or revived — `revivePendingInvitation` re-derives
  `delivered` fresh) after this ships. This is a one-time, unavoidable
  migration-backfill gap, not an ongoing one; naming it here rather than
  discovering it later.

## Acceptance criteria (from the issue, restated as tests)

1. `gdpr.test.ts`: plant an invitation (both a genuinely-delivered shape and
   a never-delivered/decoy shape) at an address, erase that address's
   owner, assert the teacher-visible row's `email` (a) does not contain the
   erased `Student.id` in any form and (b) matches the anonymised shape,
   for both rows — replacing the current assertions at lines 685, 698, and
   715 that assert `row.email === \`deleted-${studentId}@deleted.invalid\``,
   which pin exactly the leak this issue reports.
2. A test that two teachers erasing/being erased against the same address in
   separate `deleteStudentAccount` calls get **different** tokens (proves
   the value isn't a second deterministic derivation reintroducing a
   different oracle).
3. `invitations-api.test.ts` (or `invitations.gate.test.ts`, wherever the
   real #417/#418 gate already produces a never-delivered row without
   fabricating a `TeacherBlock` directly): a never-delivered invitation does
   **not** flip to `declined` when its guessed student unlinks, and stays
   `pending`.
4. Same file: a genuinely-delivered `pending` invitation still **does** flip
   to `declined` on unlink — regression coverage for #2's existing, correct
   behaviour, so the new `delivered: true` scope is proven to still match
   what it always matched.
5. A test asserting `GET /api/invitations`'s response never contains a
   `delivered` key, for a mixed set of delivered/undelivered rows.
6. `docs/data-model.md:216`'s Invitation-erasure paragraph corrected to
   describe the random-token anonymisation, not the `student_id`-derived one.

## Not in scope

- **#418 and #500 are unaffected** — both closed, both already checked
  against `origin/main` for drift (none found).
- **#419 is unaffected** — a different gate-consistency question
  (`rosterLinkState` vs. `projectStudentForTeacher`'s unclaimed-`Student`
  bypass), untouched by either writer this spec changes.
- The timing channel `inviteContact`'s own docblock already declines to
  close at this threat level (per the issue).

## Lock order

No new lock acquisition and no new table touched: `unlinkTeacher`'s
`updateMany` already writes `Invitation` at this exact statement, inside
the same transaction, at the same position — only its `where` narrows.
`gdpr.ts`'s three statements are unchanged in shape, position, and the
transaction they run in — only the literal they write changes.
`docs/lock-order.md` needs no update.

## References

- Issue: #502
- `src/services/gdpr.ts:576-611`, `docs/data-model.md:216`
- `src/services/invitations.ts:237-372` (`inviteContact`), `:409-419`
  (`revivePendingInvitation`), `:968-1093` (`unlinkTeacher`)
- `src/app/api/invitations/route.ts:11-17` (the teacher-visible select)
- `src/app/api/students/route.ts:121-140` (unconditional `lastNotifiedAt`,
  the delivery gate on `deliverInvitation`)
- `prisma/migrations/20260805074500_invitation_check_constraints/migration.sql`
- Related, closed: #412, #417, #418 (PR #501), #500
- Related, open, untouched by this spec: #419
