# Closing the two decoy-Invitation leaks from #502

## What's measured

Both writers and both leaks in #502 are confirmed exactly as filed, against
`origin/main` at `d6f452ac` (`git diff` against that commit for the four
files #502 cites is empty — no drift since the issue was written):

1. **`deleteStudentAccount`** (`src/services/gdpr.ts`) anonymises
   `Invitation` rows matching the erased student's email in three
   `tx.invitation.updateMany` calls. The first two write
   `email: \`deleted-${studentId}@deleted.invalid\`` (plus `firstName:
   'Deleted'`, `lastName: 'Student'`); the third writes the same literal to
   `lastNotifiedEmail` only. `GET /api/invitations`
   (`src/app/api/invitations/route.ts:11-17`) selects `id, email, firstName,
   lastName, status, isArchived, createdAt` — `email` reaches the teacher,
   `lastNotifiedEmail` never does — though not for the reason given here when
   this spec was written ("not selected anywhere", from a grep of
   `.invitation.find*` calls in `src/app` and `src/services`). It **is**
   selected, by the contacts detail page
   (`src/app/(teacher)/students/contacts/[id]/page.tsx`, since #173). That
   grep returns the page; what it cannot show is a `select`, and nobody
   opened one — a census of call sites is not a census of columns. What
   keeps the column off the teacher's screen is that the page hands it to
   `invitationDeliveryStatus` (`src/lib/contacts.ts`), which compares it
   against the row's own `email` and returns only whether a send happened and
   when, so a boolean and a date reach the render, never an address. The only
   other reader of the row at all is `exportStudentData`, Art. 15 — which
   selects neither `email` nor `lastNotifiedEmail`, and is the *subject's
   own* export besides, a different audience this issue does not concern.
   So today's exploitable leak is on `email` only, but `lastNotifiedEmail`'s
   write is the same pattern and `docs/data-model.md`'s Invitation-erasure
   paragraph documents both in
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

A genuinely delivered `pending` row that still exists at unlink time — the
linkless `waiting`-row promotion route `docs/superpowers/specs/2026-09-07-
gated-ghost-invitation-design.md` §3 names — is unaffected: `email` never
changed, `delivered: true` is still accurate, the tombstone still fires
exactly as before.

**The other residual route that spec names is not unaffected — it is the
bypass this fix has to also close.** `PUT /api/invitations/[id]` re-
addresses a `pending` row's `email` with no roster-link check
(`route.ts`'s own docblock states this is deliberate — the status gate
alone is sufficient for #500), and until now without touching `delivered`
at all. A teacher can create an ordinary, genuinely-delivered invitation to
an address they control, then `PUT` its `email` to a guessed victim
address — the row now sits at the guessed address carrying a `delivered:
true` inherited from the OLD address's delivery, not the new one. Nothing
was ever delivered to whoever now holds that address. If the guess lands on
a linked-but-unshared student, this reproduces #502's leak #2 exactly:
`unlinkTeacher`'s `delivered: true` scope matches the re-addressed row, and
it tombstones on that student's next unlink. **Fix #3, below, closes this**
— `PUT` writes `delivered: false` whenever `email` changes, since that is
simply true: delivery is a fact about a specific address, and changing the
address always invalidates whatever was true of the old one.

**Never select `delivered` from any student- or teacher-facing route.**
`GET /api/invitations`'s select list stays exactly as it is today — an
explicit, narrow field list that does not name `delivered`, the same
pattern every other route already uses to keep new columns out of a
response by default. No new named `satisfies`-tethered constant is needed
for one call site; the plan adds a test pinning that the response shape
doesn't gain the field, so a future edit to that `select` has to fail a
test to reintroduce this.

### Fix #3 — `PUT /api/invitations/[id]` keeps `delivered` honest on re-address

`src/app/api/invitations/[id]/route.ts`'s `PUT` handler, in the same
`prisma.invitation.updateMany` that already writes `email`:

```ts
const readdressed = email !== undefined && email !== invitation.email;
...
data: {
  ...rest,
  ...(email !== undefined ? { email } : {}),
  ...(readdressed ? { delivered: false } : {}),
},
```

Triggered on a genuine change to the stored address — compared against
`ownedInvitation`'s own read of the row, not against whether `email` was
merely present in the request body. `src/components/students/contact-form.tsx`
(the only client that calls this route) sends all three fields on every
save, so field presence alone would flip `delivered` on a pure name-typo fix
that never touches the address — a distinct bug an earlier version of this
fix shipped with and a later review round caught and closed. Not gated on
whether the new address looks blocked or linked, either — re-deriving that
here would need the same `TeacherBlock`/roster queries `inviteContact`
already runs, on a route that has never needed them, and `false` is simply
the honest value whenever the address moves: no delivery attempt has been
made to the new one, full stop, the same way a freshly-created row's
`delivered` reflects nothing having been sent yet until the create/revive
path's own check runs.

**The cost, named rather than chased:** a teacher who corrects a genuine
typo (`PUT` to a real, unblocked, unlinked address) and then clicks
`POST /api/invitations/[id]/resend` gets a real, successful delivery, but
`delivered` stays `false` — `resend` calls `notifyInvitee` (which re-checks
`TeacherBlock` structurally, correctly refuses to send when blocked) but
does not itself persist a fresh `delivered` value, so this one path loses
its unlink-tombstone eligibility going forward. That is a strictly safe
failure direction — a row that should tombstone on unlink stays `pending`
instead, the same non-disclosing residual state a genuine decoy already
sits in — never the reverse. Wiring `resend` to persist `notifyInvitee`'s
own fresh answer would close this residual too, but is a second, separable
change (`notifyInvitee`'s callers and signature, not `unlinkTeacher` or
`gdpr.ts`) and is deliberately left out of #502's scope: closing the
leak does not require it, and the residual it would close is a UX gap
(an invitation that stops auto-cleaning-up on unlink), not a disclosure.
**Whoever picks this up should restructure `notifyInvitee`'s signature
first:** it returns `Promise<void>` today, so there is no honest fresh value
for a naive edit to persist — writing `delivered: true` next to the
`lastNotifiedAt`/`lastNotifiedEmail` columns `resend` already writes
unconditionally, without first giving `notifyInvitee` something true to
report, would reopen leak #2 through a third door rather than close this
residual.

`invitations.ts:461-467`'s docblock currently states the opposite of what
is now true — "`PUT`... edits `email` on a pending row without recomputing
`delivered`, which looks like a second door and is not: PUT does not
notify, so a value gone stale there reaches nobody." That was accurate when
`delivered` had no persisted reader. It is corrected to state the current
mechanism: `PUT` now resets `Invitation.delivered` itself (to `false`) when
the address actually changes, so it cannot go stale in the way this
paragraph used to argue was harmless anyway.

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
- **A decoy planted before this shipped stays exploitable via #2 until it is
  next touched.** The backfill cannot retroactively know which pre-existing
  `pending` rows were ever delivered, so every row that existed before this
  shipped gets `delivered: true` — including real decoys already planted
  under the old code. ("Before this shipped", not "at migration time": in a
  `docker compose up -d --build` deploy the migrate service commits before
  the app container is replaced, so the window this covers can run slightly
  past the migration itself, up to the moment the new application code
  starts serving.) Fix #2 only protects a decoy from this point forward: one
  created (or revived — `revivePendingInvitation` re-derives `delivered`
  fresh) or re-addressed (Fix #3) after this ships. **Not fully a one-time
  gap**, though — a row can also re-acquire a stale `delivered: true` going
  forward whenever its `email` changes through some future writer that (like
  `PUT` before Fix #3) forgets to invalidate it. Fix #3 closes the one such
  writer that exists today; naming the pattern here so the next one that
  touches `Invitation.email` checks this column too, rather than treating
  Fix #3 as the last time it needs saying.
- **The erasure sweep's own rename is itself an observable oracle.**
  `deleteStudentAccount` (`gdpr.ts`) rewrites a matching row's
  `firstName`/`lastName` to "Deleted"/"Student" alongside the anonymised
  `email` Fix #1 randomises — all three teacher-visible. A teacher watching
  a planted decoy undergo that rename still learns the guessed address
  belongs to a real, now-erased account, even though Fix #1 closed the
  specific `studentId`-in-the-token leak. This is a real residual neither
  fix here closes — filed separately as
  [#520](https://github.com/ivohofland/fair.yoga/issues/520), not fixed in
  this branch. **#520 has since resolved it as accepted**: the signal is
  irreducible, because one column serves both the teacher's display and the
  system's matching, so every treatment of it is a visible change. The
  candidate fix this bullet implies — scoping the anonymisation to
  `delivered: true` — was refused, in part because `delivered` is not a decoy
  predicate. The reasoning and the trade-off live in `docs/data-model.md`'s
  Invitation-erasure paragraph, which owns the decision; this bullet only
  records that the question left open here has an answer now.

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
7. A test reproducing the exact PUT bypass: create a genuinely-delivered
   invitation, `PUT` its `email` to a linked-but-unshared student's address,
   assert `delivered` is now `false`, then unlink that student and assert
   the row stays `pending` — the scenario Fix #3 exists to close.
8. A test that an ordinary `PUT` re-address (to an unrelated, unblocked,
   unlinked address) also sets `delivered: false` — pinning that Fix #3's
   write is unconditional on the new address's status, not gated on it.

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
