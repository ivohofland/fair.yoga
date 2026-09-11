# #392: A dispatch failure after the "attempt" marker is invisible to the teacher

## Premise verification

The issue's core claim holds, confirmed by reading the code rather than trusting
its line references:

- `POST /api/students` (`src/app/api/students/route.ts:121-124`) and
  `POST /api/invitations/[id]/resend` (`resend/route.ts`) both write
  `lastNotifiedAt`/`lastNotifiedEmail` **synchronously, unconditionally**,
  before the fire-and-forget `deliverInvitation` call. `deliverInvitation`
  (`src/services/invitations.ts:653-673`) owns its own rejection path — a
  `.catch` that only `log.error`s — because it returns `FireAndForget` and no
  caller may `.then()`/`.catch()` it (#391). A failure inside `notifyInvitee`
  (a thrown `sendInvitationEmail`, a thrown `createNotification`, or the
  `teacher.findUniqueOrThrow` at the top of `deliverInvitation` itself) is
  therefore recorded nowhere a teacher can see — `invitationDeliveryStatus`
  (`src/lib/contacts.ts`) reads only `lastNotifiedAt`/`lastNotifiedEmail`, and
  both are already committed by the time the dispatch even starts.
- `sendInvitationEmail` (`src/lib/email.ts:65-86`) throws only on an `error`
  Resend's SDK returns synchronously from `.emails.send()` — an API-level
  rejection (bad `from` domain, auth, rate limit) or a network failure. **It
  does not throw for an address that will later bounce.** Resend's `.send()`
  call succeeds (no `error`) for a syntactically valid but non-existent
  mailbox; a bounce is an asynchronous webhook event this app does not
  consume anywhere in this flow. This matters for the oracle-safety argument
  below: the failure signal this issue asks for can only ever mean "the send
  attempt itself errored," never "that mailbox doesn't exist."
- The issue's own oracle-safety argument — the two `notifyInvitee` early
  returns (`if (blocked) return;`, `if (student.teacherStudents.length > 0)
  return;`) resolve normally, so the `.catch` genuinely never fires for a
  withheld send — is confirmed by reading `notifyInvitee` end to end
  (`src/services/invitations.ts:519-607`). Both paths are already covered by
  existing tests: `invitations.notify.test.ts` (`'sends nothing at all to a
  student already on this teacher's roster (#412)'`) and
  `tests/integration/invitations-api.test.ts` (`'still writes the marker for
  a blocked address, and sends nothing'`).

**A correctness gap in the issue's own sketch, found while tracing the write
sites.** The issue proposes "a third nullable column... written *only* inside
each dispatch's existing `.catch` block — never on the success path." Taken
literally, that leaves the column with no clearing rule, and two concrete
scenarios make it wrong under that rule:

1. **A failed attempt followed by a successful retry.** Teacher sends →
   `sendInvitationEmail` throws (Resend outage) → `lastNotifyFailedAt` set.
   Teacher clicks Resend a minute later, this time Resend is healthy →
   `notifyInvitee` completes without throwing → the sketch writes nothing on
   the success path → `lastNotifyFailedAt` is still the first attempt's
   timestamp. The contact page would keep showing "failed" for an invitation
   that, this time, actually went out.
2. **A corrected address after a failure.** Teacher sends to a typo'd
   address, it fails → `lastNotifyFailedAt` set. Teacher corrects the address
   via `PUT /api/invitations/[id]` — which does not notify at all (existing,
   deliberate behavior) — and the row now reads `lastNotifyFailedAt: <set>`,
   `lastNotifiedEmail: <old address>`. Nothing has ever been attempted
   against the corrected address, but a naive three-state read (any
   non-null `lastNotifyFailedAt` means "failed") would say the *new* address
   failed to send.

Neither is a security problem — the failure column carries no address
information the teacher doesn't already have — but both break the acceptance
criterion ("A teacher can tell 'we tried and it failed' apart from 'not yet
sent' and from 'sent'"): the signal would be wrong, not merely delayed. The
Direction below fixes this by clearing the column at the same two sites that
already reset the equivalent state for `lastNotifiedAt`/`delivered`, rather
than by adding a second paired column.

Prior art checked: `docs/superpowers/specs/` has none for #392.
`2026-09-08-invitation-readdress-oracle-design.md` (#500) and the #173/#391
history in `src/services/invitations.ts`'s docblocks are the closest
neighbors and are cited throughout below.

## Direction

**One new nullable column, `Invitation.lastNotifyFailedAt`, written in
`deliverInvitation`'s existing `.catch`, and cleared at the two sites that
already reset delivery-adjacent state for a fresh attempt or a re-address.**
No second `lastNotifyFailedEmail` column.

- **Set**: inside `deliverInvitation`'s `.catch` (`src/services/
  invitations.ts:667-672`), alongside the existing `log.error` — an
  `updateMany` scoped to `invitationId` (not `teacherId` or `email`), so it
  can never throw on a row deleted in the meantime, matching every other
  background write in this file.
- **Cleared** in the same statement that already writes
  `lastNotifiedAt`/`lastNotifiedEmail` unconditionally before dispatch — both
  in `POST /api/students` (`route.ts:121-124`) and `POST
  /api/invitations/[id]/resend` (`resend/route.ts`). Every new attempt starts
  from "we don't yet know," which is exactly what those two columns already
  express for the same write.
- **Cleared** in `PUT /api/invitations/[id]`'s existing `readdressed`
  conditional (`route.ts:240-244`), alongside `delivered: false` — no attempt
  has been made against the corrected address, so no failure can be pinned
  to it.

This is sufficient to make "failed" always describe the most recent attempt
against the invitation's *current* address, without a paired email column,
because the column is never left stale across either of the two events that
could make it stale (a new attempt, an address change) — both are already
synchronous writes this change piggybacks on.

**Rejected: a second `lastNotifyFailedEmail` column**, mirroring
`lastNotifiedEmail`. Works, but costs more than it buys:

- It reproduces a check constraint
  (`(last_notify_failed_at IS NULL) = (last_notify_failed_email IS NULL)`,
  mirroring the existing `lastNotifiedAt`/`lastNotifiedEmail` one) for no
  behavioral gain over clearing eagerly.
- It becomes a second identity-bearing column `deleteStudentAccount`
  (`src/services/gdpr.ts`) would need to rewrite alongside `Invitation.email`
  and `Invitation.lastNotifiedEmail` (`docs/data-model.md:212`'s own
  re-derivable list) — one more place a future eraser has to remember, for a
  value that clearing-on-write makes unnecessary to store at all.
- A plain timestamp, cleared at write time, is simpler to reason about than
  "is this failure timestamp for the address the row currently holds" as a
  read-time comparison.

**Rejected: comparing `lastNotifyFailedAt` against `lastNotifiedAt` at read
time** instead of clearing. `lastNotifiedAt` is bumped *synchronously, before
dispatch starts* — it means "an attempt began," not "an attempt resolved
successfully." A newer `lastNotifiedAt` than `lastNotifyFailedAt` cannot
distinguish "the newer attempt succeeded" from "the newer attempt is still in
flight" (both read as "newer timestamp, no matching failure yet"). Clearing
at the same synchronous write site sidesteps the ambiguity entirely instead
of trying to resolve it after the fact.

**Known, accepted gap**: two concurrent dispatches against the same address
(a double-click on Resend) can race — the first succeeds, the second fails
and writes `lastNotifyFailedAt` after the first's silent success, showing
"failed" for an invitation that did go out once. This is the same shape of
race `resend/route.ts`'s own docblock already accepts for `lastNotifiedAt`
("Not a new gap this route opens") and isn't worth a CAS for a double-click
edge case. Not tested; noted here so a future reader doesn't rediscover it as
new.

## Mechanism

1. **`prisma/schema.prisma`**: add `lastNotifyFailedAt DateTime?` to
   `Invitation`, next to `lastNotifiedAt`/`lastNotifiedEmail`. Run `pnpm exec
   prisma migrate dev --name invitation_notify_failed_at` to generate the
   migration; no new check constraint (see Direction, rejected alternative).

2. **`src/services/invitations.ts`**, `deliverInvitation`: change the
   `.catch` callback from a plain `(err) => log.error(...)` to one that also
   persists the failure, without ever leaving an unhandled rejection of its
   own:

   ```ts
   .catch((err: unknown) => {
     log.error(
       { err, teacherId: input.teacherId, invitationId: input.invitationId },
       DELIVERY_FAILURE_MESSAGE[input.source],
     );
     db.invitation
       .updateMany({
         where: { id: input.invitationId },
         data: { lastNotifyFailedAt: new Date() },
       })
       .catch((writeErr: unknown) => {
         log.error({ err: writeErr, invitationId: input.invitationId }, 'failed to record notify failure');
       });
   });
   ```

   `updateMany` (not `update`) for the same reason every other background
   write in this file uses it: the row may have been deleted between dispatch
   start and this callback running, and a zero-count match is not an error
   here. The docblock above `deliverInvitation` needs one line added noting
   the persisted failure marker and its own scoping-by-id, alongside the
   existing "invitee's address deliberately not logged" note.

3. **`src/app/api/students/route.ts`**: add `lastNotifyFailedAt: null` to the
   existing unconditional `data: { lastNotifiedAt: new Date(), lastNotifiedEmail:
   parsed.data.email }` write (line ~123). One field added to an existing
   statement; no new write.

4. **`src/app/api/invitations/[id]/resend/route.ts`**: same addition to its
   equivalent unconditional write.

5. **`src/app/api/invitations/[id]/route.ts`** (`PUT`): add
   `lastNotifyFailedAt: null` to the existing `...(readdressed ? {
   delivered: false } : {})` spread (line ~243) — becomes `...(readdressed ?
   { delivered: false, lastNotifyFailedAt: null } : {})`.

6. **`src/lib/contacts.ts`**, `invitationDeliveryStatus`: widen the input
   type with `lastNotifyFailedAt: Date | null` and change the return type
   from `{ sent: true; at: Date } | { sent: false }` to a three-state
   discriminated union:

   ```ts
   export function invitationDeliveryStatus(
     invitation: {
       email: string;
       lastNotifiedAt: Date | null;
       lastNotifiedEmail: string | null;
       lastNotifyFailedAt: Date | null;
     },
   ): { state: 'sent'; at: Date } | { state: 'failed'; at: Date } | { state: 'not-sent' } {
     if (invitation.lastNotifiedAt && invitation.lastNotifiedEmail === invitation.email) {
       return invitation.lastNotifyFailedAt
         ? { state: 'failed', at: invitation.lastNotifyFailedAt }
         : { state: 'sent', at: invitation.lastNotifiedAt };
     }
     return { state: 'not-sent' };
   }
   ```

   The existing `lastNotifiedEmail === email` gate is unchanged — it still
   decides "attempted against the current address at all" before the failure
   check is even consulted, which is what keeps a stale failure from a prior
   address showing at all (belt and braces alongside the clearing in step 5).
   Rewrite the docblock: it currently states the marker's sole job is telling
   `sent` from "not yet sent, never blocked"; add the third state and its own
   oracle-safety sentence (never distinguishes blocked from failed — the
   `.catch` this reads from never fires on the blocked path either, per
   Premise verification).

7. **`src/app/(teacher)/students/contacts/[id]/page.tsx`**: the query
   selecting `invitation` fields for `invitationDeliveryStatus` needs
   `lastNotifyFailedAt` added to its `select`. The render line (currently
   `{delivery.sent ? \`Last invited ${timeAgo(delivery.at)}\` : 'Not yet sent
   to this address'}`) becomes a switch on `delivery.state`:
   - `'sent'` → `Last invited {timeAgo(delivery.at)}` (unchanged copy)
   - `'failed'` → `Last attempt failed {timeAgo(delivery.at)}`
   - `'not-sent'` → `Not yet sent to this address` (unchanged copy)

   Flagging `'failed'`'s copy as the one open call in this spec — "Last
   attempt failed" matches the existing line's voice (`Last invited …`) and
   the issue's own framing ("we tried and it didn't go out"); worth a glance
   before the plan locks it in, but not worth a second design fork.

8. **`docs/data-model.md`**, Invitation table (`docs/data-model.md:136-158`):
   add a `last_notify_failed_at` row after `last_notified_email`, in the same
   voice as the sibling rows — what sets it (the `.catch`, scoped by id),
   what clears it (a new attempt's own pre-dispatch write, or a readdress),
   and the oracle-safety property (never set on the two `notifyInvitee` early
   returns, so it carries no more information than "blocked" already
   withholds).

## Tests

1. **`src/services/invitations.deliver.test.ts`**: extend using the existing
   "no such teacher" failure trick (already proven to reach the `.catch`
   without mocking Resend or the DB). Seed a real `Invitation` row (any real
   teacher), call `deliverInvitation` with that row's real `id` but a
   fictional `teacherId` — `db.teacher.findUniqueOrThrow` throws before
   touching the invitation's own teacher or email, so the failure write
   (scoped only by `invitationId`) still lands. Assert
   `lastNotifyFailedAt` is set after `vi.waitFor`. This is the "prove the
   guard bites" test for the `.catch` addition itself.

2. **Blocked address never sets the failure signal** (the issue's own
   explicit ask). Extend `tests/integration/invitations-api.test.ts`'s
   existing `'still writes the marker for a blocked address, and sends
   nothing'` test: after the resend, also assert `lastNotifyFailedAt` is
   `null`. This is the test the issue names directly — "a blocked-address
   resend must never set the new column."

3. **Already-linked pair never sets the failure signal.** Extend
   `invitations.notify.test.ts`'s `'sends nothing at all to a student
   already on this teacher's roster (#412)'` test the same way, at the
   `notifyInvitee`-unit level rather than through a route.

4. **Clearing on a fresh attempt.** Seed a row with `lastNotifyFailedAt`
   already set (simulating a prior failure), then drive a successful
   resend (real teacher, real deliverable address) through the route.
   Assert `lastNotifyFailedAt` is `null` immediately after the response
   (proving the synchronous pre-dispatch write cleared it, not the async
   dispatch) — this is the regression test for premise-verification
   scenario 1.

5. **Clearing on readdress.** Seed a row with `lastNotifyFailedAt` set, `PUT`
   a new `email`, assert `lastNotifyFailedAt` is `null` in the same response
   — the regression test for premise-verification scenario 2.

6. **Mutation-proof step 2's clearing** (per the skill's §3): revert the
   `lastNotifyFailedAt: null` addition in one of the two unconditional
   pre-dispatch writes locally, confirm test 4 fails, restore. Same for the
   `PUT` readdress clearing against test 5.

7. **`src/lib/contacts.test.ts`**, `invitationDeliveryStatus`: add cases for
   the new third state and rewrite the two `{ sent: ... }` assertions in the
   existing three tests to `{ state: 'sent' | 'not-sent', ... }`. New cases:
   - `lastNotifiedEmail === email`, `lastNotifyFailedAt` set → `{ state:
     'failed', at: lastNotifyFailedAt }`.
   - `lastNotifiedEmail === email`, `lastNotifyFailedAt` null → `{ state:
     'sent', at: lastNotifiedAt }` (the existing "is sent" test, renamed).
   - `lastNotifiedEmail !== email` (readdressed), `lastNotifyFailedAt` set →
     still `{ state: 'not-sent' }` — proves the email gate is checked before
     the failure gate, independent of the write-site clearing in step 5/test
     6 (defense in depth, per the Mechanism note).

No new integration test forces a real Resend failure through the HTTP layer
end to end — the "no such teacher" trick (tests 1, and reused for 2/3 by
seeding a block/link instead) is the existing, already-proven failure
trigger in this codebase, and there is no existing Resend-mocking
infrastructure for this flow worth building for one issue.

## Scope

- One task: schema column, the one write site that sets it
  (`deliverInvitation`), the two write sites that clear it
  (`route.ts` × 2, `PUT`), the read-side function and its one caller, and the
  data-model doc entry. Splitting the "set" and "clear" halves across tasks
  would ship a column that goes stale the moment it's added.
- Not in scope: a distinct UI affordance on the failed state beyond the
  status line (the existing `ResendInvitationButton` already renders for any
  `pending` row, failed or not — no new button, no new route).
- Not in scope: closing the double-dispatch race noted as an accepted gap
  above, or building Resend bounce-webhook handling (a different, much
  larger feature the issue itself does not ask for — see the note in Premise
  verification that this signal can never mean "that mailbox doesn't
  exist").
