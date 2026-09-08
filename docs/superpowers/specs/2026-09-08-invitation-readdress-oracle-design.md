# #500: PUT can re-address an accepted invitation, closing the two-call address oracle

## Premise verification

The issue's premise holds, confirmed by reading the code rather than the issue's
line numbers alone:

- `src/app/api/invitations/[id]/route.ts` already carries a docblock reading
  `OPEN SECURITY ISSUE: #500` on the `PUT` handler — this gap was already
  known and flagged, not merely proposed by the issue.
- The `PUT` handler's only pre-checks are ownership (`ownedInvitation`) and
  `status === 'declined'`. There is no roster-link check and no `accepted`
  check on the `email` write path (`route.ts:126-136` — now shifted slightly
  by the resend-route read below, but the same statements).
- `updateInvitationSchema` (`src/lib/schemas.ts:276-280`) makes `email`
  optional and unrestricted beyond normal validation — nothing there
  distinguishes an `accepted` row from a `pending` one.
- `inviteContact`'s `ALREADY_LINKED` gate (`src/services/invitations.ts:298-301`)
  answers differently for a linked-and-private student
  (`existing?.status === 'accepted'` → refused `ALREADY_LINKED`) than for a
  stranger (falls through to `revivePendingInvitation` → `201`) — confirmed
  by reading `rosterLinkState` and the gate's own docblock in full.
- The two-call sequence in the issue is real: PUT re-addresses any held
  `accepted` row to a guessed address, then `POST /api/students` reads the
  gate's answer for that address. The PUT succeeds today regardless of the
  guess, so it costs the attacker nothing to retry on a miss.

**A load-bearing fact the issue's own text does not mention**: the sibling
route `POST /api/invitations/[id]/resend` already closed the identical hole
for itself:

```ts
if (invitation.status === 'declined') return DECLINED();
if (invitation.status !== 'pending') {
  // Unreachable from the UI today — the contact detail page redirects
  // away from an accepted invitation before a Resend button could ever
  // render — but the id travels in a URL, not a secret, so a direct call
  // still needs an honest answer rather than a 404 that pretends the row
  // doesn't exist.
  return respondError('This invitation is no longer pending.', 409, 'NOT_PENDING');
}
```

(`src/app/api/invitations/[id]/resend/route.ts`, tested by
`tests/integration/invitations-api.test.ts` — `'refuses a non-pending row
that is not declined'`.) `PUT` is the one remaining door of the three
(`PUT`/`DELETE`/`resend`) under this resource that does not already refuse a
non-pending, non-declined row. `DELETE` is intentionally different — see
below.

Also confirmed: the Contacts UI has **no reachable path** to `PUT` an
`accepted` row at all. `ContactDetailPage`
(`src/app/(teacher)/students/contacts/[id]/page.tsx:39`) redirects to
`/students` for `invitation.status === 'accepted'` before `ContactForm` is
ever rendered. The fix below costs zero legitimate functionality — the
attack path is the only path that reaches it.

## Direction

**Refuse `PUT` on a non-pending, non-declined (i.e. `accepted`) row, with the
same `NOT_PENDING` refusal `resend` already answers with — sharing the one
string and one code between the two routes instead of typing a second copy.**

This is the issue's own "Option 1" (refuse an `email` edit on an `accepted`
row), widened by one detail: refuse the *whole* update, not just the `email`
field. Reasons:

- The UI never edits any field of an accepted row (see above), so there is no
  cost to widening from "refuse `email`" to "refuse the row."
- `PUT`'s two other fields (`firstName`, `lastName`) carry no oracle by
  themselves, but a route that accepts a partial write to a row it has
  otherwise decided is frozen is a route with two policies instead of one —
  the same reasoning `route.ts`'s existing `declined` refusal already applies
  to the whole body, not just `email`.
- It exactly matches `resend`'s existing shape, which this project's own
  Comment Discipline favours over a second, narrower policy invented for one
  route (`docs/superpowers/specs/2026-09-03-already-linked-email-confirmation-design.md`
  and #419 are the precedent for what happens when a gate's policy grows a
  second, drifting copy).

**Rejected alternatives** (the issue's other two options):

- *Add a `rosterLinkState` check to the `PUT` `email` branch.* Narrower, but
  it puts a second, route-local copy of `inviteContact`'s gate policy in
  `route.ts` — precisely the shape #419 came from, per the issue's own
  framing. `NOT_PENDING` needs no knowledge of the roster at all, which is
  strictly less surface to keep in sync.
- *Re-evaluate the `accepted` disjunct in `inviteContact`.* This would touch
  the #412 gate itself, which the whole-branch review that filed #500
  explicitly did not ask for and which the resend precedent shows is
  unnecessary — the leak is `PUT`'s missing status check, not the gate's
  logic.

`DELETE` is deliberately left alone. It already refuses only `declined` rows
and allows `accepted` ones freely, by design (a genuine CRM-cleanup path —
removing the row entirely, not editing its address in place). Deleting an
`accepted` row does not recreate the oracle: a subsequent
`POST /api/students` at the guessed address finds no `existing` row at all,
so `inviteContact`'s second `ALREADY_LINKED` disjunct
(`existing?.status === 'accepted'`) never fires, and the response is
identical (a fresh `pending` row, `201`) whether the guess is a stranger or a
linked-private student. Confirmed by re-reading `inviteContact` end to end
for this specific sequence — `DELETE` then `POST` was not named as vulnerable
by the issue, and tracing it out shows why.

## Mechanism

1. **`src/app/api/invitations/[id]/shared.ts`**: promote resend's inline
   `NOT_PENDING` refusal to a shared export, alongside `NOT_FOUND` and
   `DECLINED`, with the same one-sentence-in-one-place rationale their own
   docblocks already state.
2. **`route.ts` `PUT`**: after the existing `if (invitation.status ===
   'declined') return DECLINED();`, add `if (invitation.status !== 'pending')
   return NOT_PENDING();` — reachable only by `accepted`, since `declined` is
   already handled above and those are the only three `InvitationStatus`
   members.
3. **`route.ts` `PUT`'s CAS**: narrow `where: { id, status: { not: 'declined'
   } }` to `where: { id, status: 'pending' }`. The pre-check above is a
   read-then-write; without narrowing the CAS too, a row that is `pending` at
   the pre-check and becomes `accepted` in the gap (the invitee accepts
   concurrently) would still match the old CAS and let the write through —
   the exact race shape `declined` was already guarded against, now closed
   for `accepted` too. `status: 'pending'` (positive equality) rather than
   `notIn: ['declined', 'accepted']`: naming the one state this write allows
   means a future `InvitationStatus` member is excluded from this CAS by
   default rather than silently admitted — the same preference
   `inviteContact`'s own inline comment states (`services/invitations.ts`,
   not `rosterLinkState`'s docblock, which has no `existing` variable in
   scope) for its `existing?.status === 'accepted'` check.
4. **`casMatchedNothing`**: its docblock currently states the CAS "matches
   nothing for TWO reasons" (declined, or gone) and analyses a "third branch"
   that is `declined`'s indirect return route through
   `resolveInvitationOnLink`. Widening PUT's CAS makes `accepted` a third
   base reason a miss can occur on PUT's side (declined, accepted, or gone) —
   but `casMatchedNothing` is shared with `DELETE`, whose own CAS is
   unchanged and still admits `accepted` outright, so the new branch must be
   scoped to PUT's caller only (an explicit `InvitationCasScope` parameter
   naming which CAS the caller ran, checked alongside `observed.status ===
   'accepted'`) rather than added unconditionally — an unconditional branch
   would silently change DELETE's answer on the exact
   `resolveInvitationOnLink` race the existing paragraph documents. Rewrite
   the docblock to state three base reasons for PUT's CAS and two for
   DELETE's, and to state the caller-scoped treatment explicitly; the
   `resolveInvitationOnLink` mechanism paragraph itself is unaffected by
   widening the CAS and needs no rewrite, only this added caller split.
5. **`resend/route.ts`**: switch its inline `respondError('This invitation is
   no longer pending.', 409, 'NOT_PENDING')` to the new shared `NOT_PENDING()`
   — no behavior change, just the dedup `shared.ts`'s existing `DECLINED`
   pattern already establishes.
6. **The `OPEN SECURITY ISSUE: #500` docblock on `PUT`**: replace with a
   docblock stating the closed property in the present tense, matching the
   voice of the surrounding file (e.g. `resend`'s own docblock on the same
   check) — not a "this used to be open" narrative.

## Tests

All in `tests/integration/invitations-api.test.ts`, alongside the existing
`PUT /api/invitations/[id]` describe block:

1. **Direct refusal**: seed an `accepted` row, `PUT` any field on it, assert
   `409` / `NOT_PENDING`, assert the row is untouched (mirrors the existing
   `declined` test's own untouched-row assertion).
2. **CAS race**: a `pending` row that becomes `accepted` between the
   pre-check and the write must not have its email moved. Driven the way
   this file drives other CAS races (a Prisma extension hook, per
   `invitations.revive.test.ts`'s own note on hooking `student.findUnique` —
   here hooking the read inside `ownedInvitation` or the `updateMany` call to
   flip the row to `accepted` first) — mutation-proof per the skill's
   requirement (§3): the test must fail if the CAS is reverted to `{ not:
   'declined' }`, confirmed by reverting it locally and observing the
   failure before restoring.
3. **The comparative oracle test (acceptance criterion)**: the full two-call
   sequence, run for a linked-and-private student's address and, separately,
   a genuine stranger's address, asserting the two runs produce equal
   outcomes at both calls — the shape `invitations.gate.test.ts`'s "answers a
   gated linked-unshared student the same as a genuine stranger" test uses,
   not two independent assertions:
   - Seed an `accepted` decoy `Invitation` (one is enough; the two guesses
     re-probe through the same decoy the way the real attack would reuse one
     row on a miss, which `inviteContact`'s docblock notes the decoy survives).
   - Run `PUT /api/invitations/[decoy]` with the linked-private guess, then
     `POST /api/students` with the same address; separately, the same two
     calls with a stranger address on a fresh decoy of the same shape.
   - Assert both `PUT` responses are equal (expected: both `409
     NOT_PENDING`, proving the guess never reaches the gate at all), and both
     `POST` responses are equal apart from fields already known to
     legitimately differ (`id`), the same "keys agree, `delivered` is the
     one allowed divergence, pin one side, derive the other" discipline the
     existing comparative test uses.
4. **Mutation-proof the pre-check itself**: revert step 2 of the mechanism
   locally, confirm the direct-refusal test (test 1) fails, restore.

`resend`'s own existing test ('refuses a non-pending row that is not
declined') must keep passing unedited after the `shared.ts` dedup — proof the
extraction is behavior-preserving, not a rewrite.

## Scope

- One task: the mechanism above is one cohesive change (a shared refusal, one
  pre-check, one CAS narrowing, one docblock rewrite) — splitting it would
  scatter a single guard's pre-check from its own CAS.
- Not in scope: `DELETE`'s permissive `accepted` handling (by design, traced
  above), the residual timing channel `rosterLinkState`'s own docblock
  already declines to close, and anything in
  `docs/superpowers/specs/2026-09-07-gated-ghost-invitation-design.md` (a
  different mechanism, per #500's own "Not in scope" section).
