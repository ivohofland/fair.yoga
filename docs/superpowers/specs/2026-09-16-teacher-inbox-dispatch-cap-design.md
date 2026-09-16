# Bounding repeat dispatches to a teacher-only invitee (#622)

Spun out of #172 / PR #620, which built the teacher-inbox branch and shipped a
cap that was removed before merge (`e04f0dd1`). This spec replaces that cap
with one keyed on a fact the row actually holds.

Measured against `main` at `e04f0dd1`.

## 1. The premise, verified

#622's claims A-E all hold. Three things it states imprecisely, each of which
changes the design or the urgency.

**The exposure is wider than the issue says.** `checkStudentWriteLimit`
(`src/lib/rate-limit.ts:224-226`) is `checkRateLimit(rateLimitKey('students',
teacherId), 50, 60 * 60 * 1000)` — keyed on the **inviting teacher**, not the
target address. Ten teachers holding the same contact have ten independent
budgets against one person. The limiter is also an in-memory sliding log
(`src/lib/rate-limit.ts:6-13`), so a process restart clears it. Against that,
one narrowing: `POST /api/students` cannot be looped at a single address —
a second call answers `ALREADY_INVITED` (`src/services/invitations.ts:271`) —
so the repeat vector is `POST /api/invitations/[id]/resend` alone.

**The teacher arm consults no preference, and there is nothing for it to
consult.** `src/services/email-fallback.ts:147` initialises `let emailEnabled =
true`; the teacher branch reads only the address and never reassigns it, while
the student branch calls `shouldEmailStudent`
(`src/services/notification-policy.ts:50-55`). No teacher-side counterpart to
`Student.emailNotifications` exists anywhere in `prisma/schema.prisma` —
`Teacher.defaultReminder` is class-reminder timing, and
`StudentPrivacy.receiveComms` is student-side per-teacher announcement muting.
So this is not a preference that is being skipped; it is a preference that does
not exist. **#622 is unaffected by that gap** — see *Out of scope*.

**Sequence 2's mechanism is narrower than "the student side is erased".**
`src/services/gdpr.ts:643-656` rewrites `Account.email` only inside
`if (!teacherOnAccount)`, where `teacherOnAccount` filters `deletedAt: null`.
A dual-profile account with a live teacher therefore keeps its address, its
sessions and its passkeys; only `Student.email` is tombstoned
(`src/services/gdpr.ts:705-721`) and every `TeacherStudent` row deleted
(`src/services/gdpr.ts:546`). `notifyInvitee`'s student lookup then misses on
the original address and the account lookup hits. The address surviving is a
consequence of the teacher profile being live, not of the erasure itself.

## 2. Why the withdrawn cap could not work, stated as a rule

`priorDispatchFor` read `lastNotifiedEmail` and `lastNotifyFailedAt`. Both
dispatching routes write those unconditionally, before any delivery decision
(`src/app/api/students/route.ts:129`,
`src/app/api/invitations/[id]/resend/route.ts:88`), so that a teacher cannot
tell a blocked contact from an unblocked one by watching "last invited".

The rule: **a marker written to destroy a correlation cannot later be read as
evidence of that correlation.** Unconditional-write is an anti-oracle measure
whose whole purpose is that the marker not reveal what happened; reading it
back as "what happened" asks it to carry the bit it exists to erase.

The #172 spec named its own rule accurately — "whether a dispatch has already
reached the invitation's **current address**"
(`docs/superpowers/specs/2026-09-15-teacher-invitee-notification-design.md:172`)
— and then had step 4 consume it as "has already reached this teacher's inbox".
Those are different questions whenever the recipient's class changes between
dispatches, which #622 documents as sequences 1 and 2.

The generalisable failure is the direction: `priorDispatchFor` resolved an
ambiguous input to **suppress**. A cap that fails closed loses people
entirely, on the one request that exists to recover a send that did not land.
Everything below is built to fail toward notifying.

## 3. Decisions

1. **Once ever, per invitation.** A teacher-only invitee is told once. Further
   resends reach them only if the row's address changes, the invitation is
   revived, or a dispatch failure was recorded.

   *Rejected:* **suppress only while unread.** It matches #622's criterion 1
   literally, but #172 decision 1 already holds that ignoring the notification
   is how a teacher-only invitee declines — so re-notifying someone who read it
   and did nothing contradicts that model. For an invitee who ignores
   everything it behaves identically anyway, and for one who reads each message
   it permits unbounded nudging.

   *Rejected:* **a cooldown of N hours on this invitation.** No principled
   value for N, and #172 declined a cooldown once already.

2. **A single-purpose nullable timestamp, not a channel enum.** The column is
   written only by the teacher branch and read only by the teacher branch.

   *Rejected:* **a channel enum written at the end of every branch** (#622's
   stated Direction). An enum must be written correctly on every terminal path;
   a branch that forgets leaves a stale value that can read
   `teacher_notification`, which suppresses — the same fail-closed direction
   that produced the dead end. It would also need the `dispatchedAt`
   compare-and-swap `lastNotifyFailedAt` carries, because `notifyInvitee`'s
   branches are unequal in cost (one indexed SELECT versus an HTTPS round trip
   to Resend), so two overlapping dispatches finish out of order by
   construction and a late writer's enum value is simply wrong. A column whose
   only reader is its only writer has neither problem.

   *Rejected:* **`Notification.relatedInvitationId`, suppressing on an unread
   row.** It asks the live question and needs no reset anywhere, but its
   mechanism is inherently unread-based, which decision 1 rules out. It would
   also put a nullable FK on the table `prisma/schema.prisma`'s own
   `Notification` comment calls "the app's highest-volume table".

   *Rejected:* **deriving from `Notification` without linkage** (#622's own
   ruling). The only available question is "has this teacher ever been sent any
   `teacher_invitation`", which suppresses a second teacher's invitation
   because a first teacher's arrived.

3. **The marker is claimed atomically, before the notification is created.**
   Two concurrent resends would otherwise both read null and both notify.

4. **A failed dispatch re-opens the cap, on the failure path itself.** Claiming
   before delivering means a failed `createNotification` would otherwise strand
   the invitee permanently. Note "on the failure path": the cap is re-opened
   where the failure is known, never inferred later from a marker a route has
   already overwritten (§4.2).

## 4. Design

### 4.1 The column

`Invitation.teacherInboxNotifiedAt DateTime?` — when this invitation last
placed a `teacher_invitation` notification in a teacher inbox. Null means no
such notification has been delivered for this row.

Named for the branch that owns it, not for a channel taxonomy: there is no
enumeration to keep exhaustive, and a future branch that ignores the column
notifies, which is the safe direction.

Migration: hand-authored is unnecessary (no CHECK constraint), so
`pnpm exec prisma migrate dev --name invitation_teacher_inbox_notified_at`,
following `20260911101701_invitation_notify_failed_at` as the nearest
precedent.

### 4.2 The write and the read are one statement

In `notifyInvitee`'s teacher branch (`src/services/invitations.ts:604`),
replacing the bare `createNotification` call:

```ts
const claimed = await db.invitation.updateMany({
  where: { id: input.invitationId, teacherInboxNotifiedAt: null },
  data: { teacherInboxNotifiedAt: new Date() },
});
if (claimed.count === 0) return;
await createNotification(db, { recipientType: 'teacher', ... });
```

The `where` is the whole suppression: the claim succeeds exactly once per row,
and a losing claim returns without notifying. No separate read, so no
time-of-check window. A row deleted mid-flight — the teacher removed the
contact while the dispatch was in the air — matches nothing and is likewise
not notified, which is the behaviour that case wants.

**`lastNotifyFailedAt` must not appear in this `where`, and decision 4 is
implemented on the failure path instead.** The tempting form of decision 4 is
`lastNotifyFailedAt: null` as a second clause, so that a recorded failure
re-opens the cap. It would be inert: both dispatching routes clear
`lastNotifyFailedAt` to null unconditionally, before dispatching
(`src/app/api/students/route.ts:129`,
`src/app/api/invitations/[id]/resend/route.ts:88`), so the clause is always
satisfied by the time this code reads it and the stale `teacherInboxNotifiedAt`
suppresses alone — an invitee whose only notification attempt failed would
never be notified again. That is the dead end's own mistake in a new column:
reading a marker the route has already overwritten. Its mutation check would
pass while proving nothing.

So **`deliverInvitation`'s `.catch` clears `teacherInboxNotifiedAt`**
(`src/services/invitations.ts:723-737`), restoring notifiability at the moment
the failure is known rather than asking a later reader to infer it.

Two properties of that clear, both load-bearing:

- **It is CAS'd on the marker value this dispatch's own claim wrote**
  (`where: { id, teacherInboxNotifiedAt: claimedAt }`) — *not* on
  `lastNotifiedAt`, the way the `lastNotifyFailedAt` write beside it is.
  `lastNotifiedAt` is the right correlate for `lastNotifyFailedAt`: both are
  per-attempt, both written by the dispatching route. The correlate for
  `teacherInboxNotifiedAt` is **the claim**, which is the only thing that
  ever sets it. Enumerate when this `.catch` can run with a marker standing:

  1. *This attempt claimed, then `createNotification` threw.* The marker is
     provably this attempt's own, so clearing is always correct — and under
     a `claimedAt` CAS it always happens. Under a `lastNotifiedAt` CAS it
     would be refused whenever the row's `lastNotifiedAt` had moved on in the
     meantime (a resend landing during a slow failure), leaving the marker
     standing over a notification that was never created: permanent silence,
     the one outcome this feature exists to prevent.
  2. *This attempt never claimed — the stranger, student, blocked or
     refused-claim paths — and threw.* Any marker belongs to another attempt
     and clearing is always wrong. A `lastNotifiedAt` CAS blocks this only
     when the failing attempt is itself superseded, so it misses the case it
     was added for: resend #1 claims through the teacher branch, the
     invitee's teacher profile is then deleted, resend #2 takes the stranger
     branch and Resend is down — `lastNotifiedAt` matches, and a branch that
     never claimed clears someone else's marker. Under a `claimedAt` CAS
     nothing wrote that value, so the `where` matches nothing.

  A readdress or a revive nulls the marker in between: null matches no
  `claimedAt`, and null is already the state this clear wants.
- **It runs before `recordDispatchFailure`'s `looksSystemic` early return**, not
  after. That suppression exists because `lastNotifyFailedAt` is teacher-visible
  and would otherwise proxy for "does this address have an account"
  (`src/lib/notify-health.ts`). `teacherInboxNotifiedAt` is visible to nobody
  (§5), so gating its clear on the same burst check would buy no privacy and
  would strand every invitee whose notification failed during an outage.

### 4.3 Signature

`notifyInvitee` gains `invitationId: string` and `claimedAt: Date`, both
required. `deliverInvitation` already holds the id
(`src/services/invitations.ts:693-702`) and forwards
`teacherId`/`email`/`teacherName` only (`src/services/invitations.ts:709-713`);
it forwards the id too, and mints `claimedAt` itself — one `new Date()` per
dispatch, read by the wrapper (it travels into `notifyInvitee`, whose claim
writes it) and by the `.catch` (where it is the clear's CAS). It is the lone
statement outside `deliverInvitation`'s `void (async () => …)()` wrapper,
which is safe only because it cannot throw.

`dispatchedAt` is **not** added to `notifyInvitee`, and the reason is about
the **claim's** CAS, not the clear's: the claim's own `where`
(`teacherInboxNotifiedAt: null`) is its compare-and-swap, so it needs nothing
from the dispatching route. The clear in §4.2 is a separate question, and its
CAS is `claimedAt` — minted for that purpose rather than borrowed from
`dispatchedAt`, so that what the column records (when the teacher branch
claimed the row) stays independent of when the route pre-wrote
`lastNotifiedAt`.

Required rather than optional: an optional id would let a caller silently opt
out of the cap. The cost is real and belongs in the plan — the ten
`notifyInvitee` call sites in `src/services/invitations.notify.test.ts` create
no `Invitation` row today, and each must now create one and clean it up. A
non-existent id makes `updateMany` match nothing, so the teacher-branch tests
would silently observe suppression rather than a missing row.

Re-derive that count, and confirm the production caller is still singular,
with:

```sh
grep -c 'notifyInvitee(prisma,' src/services/invitations.notify.test.ts
grep -rn 'notifyInvitee(' src/ --include='*.ts' | grep -v '\.test\.'
```

Measured at `e04f0dd1`: `10`, and the definition
(`src/services/invitations.ts:521`) plus `deliverInvitation`'s call
(`src/services/invitations.ts:709`). The second command matches on the open
paren, so a docblock writing `notifyInvitee(db, …)` would show up too — a third
hit needs reading, not assuming.

### 4.4 Resets

| Site | Change | Why |
|---|---|---|
| `src/app/api/invitations/[id]/route.ts:246` | join `delivered` and `lastNotifyFailedAt` in the `readdressed` reset | a readdress points the row at a different person |
| `revivePendingInvitation` (`src/services/invitations.ts:421`) | clear in the `data` alongside `respondedAt: null` | it reuses the same row (`accepted` → `pending`); a re-invitation after a link ended is a new invitation |
| `deliverInvitation`'s `.catch` (`src/services/invitations.ts:723-737`) | clear under a `claimedAt` CAS, **above** the `looksSystemic` early return | §4.2 |

Remove-and-re-add needs no reset: `DELETE` then `POST /api/students` creates a
fresh row whose column is null by default.

## 5. Oracle safety

Criterion 5 holds without new work, and the reasons are structural rather than
conventional:

- The claim runs inside `deliverInvitation`'s `void (async () => …)()` wrapper,
  whose `FireAndForget` return type is pinned by a type-level assertion
  (`src/services/invitations.ts:749-750`). Neither the claim's outcome nor its
  duration can reach the response.
- Both routes' marker writes stay unconditional, so a suppressed resend still
  answers 200 and still displays "Sent" with a fresh timestamp. That display is
  deliberately not the truth; it is the anti-oracle property.
- A suppressed dispatch records no failure — it is an early return, like the
  blocked and already-linked returns above it.

**The column must never reach a teacher-facing serializer.** It is a direct
statement of which account shape an address holds — a stronger oracle than the
one `recordDispatchFailure` (`src/lib/notify-health.ts`) exists to bound. Two
things make that a rule rather than a hope: `invitationDeliveryStatus`
(`src/lib/contacts.ts:44-51`) declares its own structural input type, so a new
model column does not flow into it, and
`src/app/(teacher)/students/contacts/[id]/page.tsx:48` selects columns
explicitly. Adding it to either is the mistake to guard against in review.

## 6. Tests

Against #622's acceptance criteria:

1. **Repeat suppressed.** A resend to a teacher-only account that was already
   notified creates no second notification. This inverts the current guard,
   `tests/integration/invitations-api.test.ts:4285` (*tells the invitee again
   when the invitation is resent*), whose surrounding comment is also replaced.
2. **Sequence 1.** An address invited with no `Account`, which then gains a
   teacher profile, is notified on the next resend.
3. **Sequence 2.** A pair linked at the last dispatch is notified after the
   student side is erased.
4. **Students and no-account addresses unchanged.** Every resend still reaches
   them — the existing repeat tests for both stand unmodified.
5. **No oracle.** Response status and body of a suppressed resend equal those
   of one that notified; the row's `lastNotifiedAt` still advances.
6. **A failure re-opens the cap** — four cases, because mutation checks 3-5
   each need one the others do not cover, and check 5 has two directions:
   a. *Ordinary.* A teacher-branch insert that throws leaves the column clear,
      and the next resend notifies.
   b. *Outage.* The same, while `recordDispatchFailure` reports the failure
      burst as systemic — the cap still re-opens even though
      `lastNotifyFailedAt` is suppressed.
   c. *A failure on a branch that never claimed.* A dispatch that took the
      stranger branch and failed there does **not** clear a marker some
      earlier teacher-branch attempt set — with the row's `lastNotifiedAt`
      equal to the failing dispatch's own `dispatchedAt`, which is the state
      in which a CAS on the wrong column would match and wrongly clear.

      The property this replaces — "a late failure from an attempt the row
      has moved past does not re-open a cap a newer attempt closed" — is
      unconstructable on the claim path, and asking for it produced a test
      that pinned the §4.2 case-1 stranding as correct. A claiming attempt
      can only be holding a marker that is its own (the claim's `where`
      requires null, so a second live claim cannot exist beside it), and an
      attempt whose claim is refused returns before anything can throw, so
      it never reaches the `.catch` at all. The only dispatch that can reach
      the failure path beside another attempt's marker is one that never
      claimed.
   d. *Claiming, with the row moved on.* The other direction of the same CAS:
      a dispatch whose own claim succeeded and whose insert then threw clears
      its marker even though a later resend has already advanced
      `lastNotifiedAt` past the value it carries. Without this case, a
      `lastNotifiedAt` clause re-added *beside* the `claimedAt` one — §4.2
      case 1, the permanent-silence bug — passes every other test in this
      list.
7. **Both resets.** A readdress and a revive each restore notifiability.
8. **Concurrency.** Two overlapping dispatches for one invitation produce
   exactly one notification.

`invitations-api.test.ts` shares fixtures across a describe block in file
order; test 1 currently runs before *lets the invitee add a student side and
accept*. The plan states whether order is load-bearing for the new cases.

## 7. Mutation checks

Break each, record the exact failure text, restore, re-verify.

1. Drop the `teacherInboxNotifiedAt: null` clause from the claim's `where`:
   test 1 fails.
2. Invert `claimed.count === 0` to `!== 0`: test 2 fails.
3. Drop the `.catch` clear entirely: test 6 fails.
4. Move the `.catch` clear below `recordDispatchFailure`'s `looksSystemic`
   early return: test 6's outage case fails while its ordinary case still
   passes.
5. Two mutations, one per direction of the clear's CAS. Replace the
   `claimedAt` CAS with the `lastNotifiedAt` one
   (`where: { id, lastNotifiedAt: dispatchedAt }`): test 6's non-claiming case
   (c) fails. Re-add `lastNotifiedAt: dispatchedAt` *beside* the `claimedAt`
   clause: test 6's moved-on case (d) fails. Dropping the CAS clause
   altogether fails (c) too — an unscoped clear wipes a marker this dispatch
   never wrote — which is why (c) pins the column the CAS is on, not merely
   that one exists.
6. Drop the readdress reset: test 7's readdress case fails.
7. Drop the revive reset: test 7's revive case fails.
8. Move the claim after `createNotification`: test 8 fails.
9. Move the claim into the student branch as well: test 4's student case fails.
   The #172 spec's own check 4 in the same position, and the one that proves
   the cap is scoped to the branch with no opt-out behind it.

Checks 3-5 must each fail for a reason the other two do not, or the two
narrower ones certify nothing of their own — 3 removes the release valve, 4
removes it only under a failure burst, 5 mis-aims it — letting a dispatch
reach across to a marker another attempt set, or refusing one its own attempt
wrote. Test 6 therefore needs four distinct cases, not one.

**Add a tenth, adversarial check.** Re-add `lastNotifyFailedAt: null` to the
claim's `where` (§4.2's rejected form) and confirm the suite stays green. It
will: that clause is inert, and nothing in this design can detect it. The check
exists to record that the clause is untestable — which is why it is forbidden
in prose rather than guarded by a test.

## 8. Docs and comments this makes false

- **`docs/data-model.md`, *Who an invitation reaches* (line 198).** The teacher
  branch gains a condition. The `Invitation` field table gains the column, and
  the `last_notify_failed_at` row gains the clear.
- **`notifyInvitee`'s docblock** (`src/services/invitations.ts`), whose closing
  paragraph explains why `teacher_invitation` is not essential and what that
  means for a student's opt-out — it now needs the teacher counterpart stated,
  and per *Comment Discipline* the branch census it would otherwise restate
  belongs in `docs/data-model.md` with a link.
- **`deliverInvitation`'s docblock**, which enumerates what the `.catch` path
  persists and under which guards.
- **`src/app/api/invitations/[id]/resend/route.ts:18-37`**, which describes what
  a resend does and does not do.
- **`src/lib/contacts.ts:24-42`**, `invitationDeliveryStatus`'s docblock, only
  if the reviewer judges "which writers set or clear either column" to now
  under-describe the row. It defers that census to `docs/data-model.md`, so
  probably not — read it whole rather than grepping.

## 9. Accepted residuals

- **Remove-and-re-add resets the cap.** A determined teacher can delete the
  contact and re-add it for a fresh row, at roughly two budget units per
  notification — about 25 per hour per teacher against one address, rather than
  50. Closing it needs a marker surviving row deletion, keyed on
  `(teacherId, email)`; `docs/data-model.md:229` forbids exactly that
  ("A refusal is a row, never a derived key") because the invitee's own erasure
  rewrites those columns and would lift the protection in the direction that
  hurts them. #172's spec accepted this residual for the same reason.
- **A failure during an outage still goes unrecorded *for the teacher*.**
  `recordDispatchFailure` suppresses `lastNotifyFailedAt` while failures look
  systemic, so the contact page shows "Sent" for a dispatch that did not land.
  Inherited from #392 and unchanged. It no longer strands the invitee, though —
  §4.2 puts the `teacherInboxNotifiedAt` clear above that early return, so the
  cap re-opens whether or not the failure was displayable. The #172 spec listed
  this as a residual of the withdrawn cap; this design retires that half of it.
- **Multiple teachers are not bounded against one address.** The cap is per
  invitation, so N teachers can each notify once. That is correct — each is a
  distinct invitation from a distinct person.

## 10. Out of scope

- **A teacher-side email opt-out.** §1 establishes that no such preference
  exists, for any teacher notification type. Building one is a settings
  surface plus a schema column affecting every teacher-recipient notification,
  not a property of invitations. File separately.
- **`Student.accountId` survives erasure.** `src/services/gdpr.ts:707-720`
  tombstones `Student.email` and sets `deletedAt` but does not clear
  `accountId`, so after sequence 2 the account still owns a soft-deleted
  student side — and the teacher branch's copy, "Connecting adds a student side
  to your account", is untrue for that person. Found while verifying claim D.
  Triage at §7 of the solve-issue arc.
- **#623** is unaffected.
