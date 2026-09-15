# An invitation to a teacher-only account is a one-time notification (#172)

## What was measured

Every claim in #172 was checked against `main` at `7eb6b6f5`. Where #172 cites
code, its account of what goes wrong holds. Several of its explanations did
not, and the corrections below changed the design.

### The issue's premise holds where it names code

1. **A teacher-only account gets the no-account email.** `notifyInvitee`
   (`src/services/invitations.ts:520-607`) looks for a `Student` row by
   address. A teacher-only account has none, so it falls through to
   `sendInvitationEmail(email, teacherName, '/login')` at `:607`. No in-app
   notification is created.
2. **Signing in lands them on the teacher home.** `magic-link/verify/route.ts:103`
   sends them to `/schedule`. The issue says `/`, because the home page moved
   in `d43edbd9`; the effect is the same.
3. **The one page that lists invitations turns them away.**
   `(student)/account/privacy/page.tsx` redirects through
   `redirectNonStudent` (`src/lib/student-guard.ts`), which was extracted from
   the inline redirect the issue quotes.
4. **The API refuses them too.** `POST /api/invitations/[id]/respond` calls
   `requireStudent`, and `tests/integration/invitations-api.test.ts:1577`
   pins its 403 for a teacher-only session.

### What the issue got wrong or left out

1. **The redirect guards the whole `(student)` group, not one page.**
   `src/app/(student)/layout.tsx` calls `redirectNonStudent` itself.
   Acceptance option 1 ("`/account/privacy` stops redirecting") would
   therefore have to change the layout that every student page shares.
2. **The no-account email's wording is already true for a teacher-only
   account.** "…added you as a contact on fair.yoga… You choose whether to
   connect. [Sign in]" assumes nothing about the recipient, and
   `src/lib/email-templates.test.ts` pins that it never says "welcome back".
   The defect is where the link leads, not what the email says.
3. **A one-tap way to add a student side already exists.** `JoinAsStudent`
   (`src/components/booking/join-as-student.tsx`) appears in place of the
   sign-in form when a teacher-only session opens another teacher's class
   (`(public)/[slug]/book/[classId]/page.tsx:114-176`). It is the only
   interface that calls `POST /api/account/student-profile` with a session
   rather than a signup ticket. Re-derive the callers with
   `grep -rn "account/student-profile" src --include="*.tsx"`. The other hit,
   `booking-name-step.tsx`, is the ticket path for someone with no account.
4. **A way to a link already works, but nobody can find it.** Join on the
   booking page, then book: `POST /api/registrations` creates the link and
   calls `resolveInvitationOnLink`, which clears the block
   (`src/services/link-consent.ts:99`) and accepts the invitation (`:110`).
   `tests/e2e/account-hybrid.spec.ts:151` covers joining and booking; no test
   combines it with a pending invitation.
5. **Only accepting needs a student profile.** `listPendingInvitations` and
   `declineInvitation` take only `accountEmail`; `acceptInvitation` also
   takes a `studentId`.
6. **`/login` discards the destination the proxy hands it.** Filed as #615;
   see *Out of scope*.

### Found while designing

- **Letting a teacher-only account decline would break #171.** The student
  export lists only refusals created on or after the student profile
  (`src/services/gdpr.ts:114`). `docs/data-model.md:226` justifies that by
  saying both routes that write a `TeacherBlock` require a signed-in student,
  so an older block must belong to an erased profile. A refusal written
  before a student profile existed would falsify that. This design writes no
  refusal from a teacher-only account, so the boundary and its reasoning
  stand unchanged.
- **Resend has no limit per invitation.** `deliverInvitation` calls
  `notifyInvitee` on every dispatch (`invitations.ts:673-693`). The only brake
  is `checkStudentWriteLimit`: 50 per hour per teacher, shared with adding
  contacts (`src/lib/rate-limit.ts:224`).
  - Students can defend themselves by declining and by opting out of
    optional email.
  - A no-account address can do neither, and the code accepts the hourly
    budget as its only protection (`rate-limit.ts:209-212`).
  - Teachers cannot opt out of fallback emails: `email-fallback.ts:149-203`
    applies no preference to a teacher recipient.

## Decisions

1. **An invitation to a teacher-only account is a one-time notification, not
   a question waiting for an answer.** Ignoring it is how they decline.
   - Teacher-only accounts get no decline control, and no `TeacherBlock` is
     ever written from one.
   - The respond route stays exactly as it is.
   - The inviting teacher's CRM shows "Invited"
     (`src/components/students/contact-list.tsx:63`), which is true, and is
     what a student who ignores an invitation shows too. `Invitation` has no
     expiry.

   *Rejected:*
   - **A card on `/schedule` with Accept and Decline.** It stays on the home
     page until answered, and declining needs either a student profile or a
     change to #171's boundary.
   - **Opening `/account/privacy` to teacher-only sessions.** It widens the
     guard every student page shares, and would still need a pointer from
     where they land.
2. **It is delivered by the existing three layers.** A teacher-inbox
   notification appears in real time and in the Inbox, and the unread-email
   fallback sends the email. A teacher-only account no longer receives the
   no-account email.
3. **The notification points to a new page, `/inbox/invitations`.** From
   there, setting up a student side leads to `/account/privacy`, where the
   existing card accepts or declines.

   *Rejected:*
   - **`/settings/student-side`.** A general "add a student side" entry is a
     feature beyond #172.
   - **The inviting teacher's `/{slug}`.** It dead-ends when that teacher has
     no open classes.
4. **Once per address.** A teacher-only account is notified by the first
   dispatch of an invitation that reaches its address. A resend reaches it
   again only if the address has changed since the last dispatch, or that
   dispatch recorded a failure. Students and no-account addresses are
   unchanged.

   *Rejected:*
   - **Repeating on every resend, as for a no-account address.** A
     teacher-only account has neither defence a student has.
   - **A resend cooldown for every recipient.** It changes resend for every
     teacher, which is beyond #172. Not filed.

## Design

### 1. `notifyInvitee` gains a teacher-account branch

The order after the change:

1. `requireNormalised(input.email)`. Unchanged.
2. A `TeacherBlock` for this teacher and address: return. Unchanged.
3. A `Student` row for the address: if it is already linked to this teacher,
   return; otherwise send the student notification. Unchanged.
4. **New: an `Account` for the address with a teacher profile.** If this is a
   repeat dispatch (§2), return. Otherwise call `createNotification` with
   `recipientType: 'teacher'`, `recipientId` set to that teacher's id, and
   `type: 'teacher_invitation'`.
5. Otherwise, the no-account email. Unchanged.

**Why step 4 comes after the `Student` check.** Every address with a
`Student` row, including an account with both profiles, is already served by
step 3. Step 4 therefore only ever sees accounts with no student profile.
Placing it first would give an account with both profiles a teacher
notification in place of the student one it gets today.

**No check for an erased teacher, because none could be reached.**
- *Erasing an account's last live profile renames its address.*
  `Account.email` is rewritten (`gdpr.ts:653` in the student half, and the
  same step in the teacher half), so an erased teacher-only address matches
  no `Account`.
- *Erasing only the teacher leaves a live `Student` row.* That row has the
  same address, so step 3 answers first.

So the teacher found at step 4 is always live. A `deletedAt` filter would be
a guard nothing could trigger, the kind `email-fallback.ts:149-203` argues
against adding.

**A legacy edge.** A `Student` row created before #166, still unclaimed and
sharing a teacher-only account's address, still takes step 3: the
notification lands on a row no session reads. Nothing creates unclaimed rows
since #166. If that teacher sets up a student side, `student-profile` claims
the row and the notification becomes visible.

Copy for the in-app notification (draft): title "A teacher would like to
connect", body "{teacherName} added you as a contact. Connecting adds a
student side to your account, and you choose whether to."

### 2. The once-per-address rule

**The route that dispatches decides**, from the row as it stood before that
route's own unconditional write of the last-sent markers. It passes the
answer through `deliverInvitation` to `notifyInvitee`.

- **`POST /api/students`, both create and revive, is always a first
  dispatch.** Revive returns an `accepted` row to `pending`: a new
  invitation after a link ended.
- **`POST /api/invitations/[id]/resend` is a repeat when**
  `lastNotifiedEmail` equals the row's current `email` and
  `lastNotifyFailedAt` is null. `ownedInvitation`
  (`api/invitations/[id]/shared.ts`) selects neither column today, so the
  resend route needs both.
- **A readdressed row is a first dispatch again.**
  `PUT /api/invitations/[id]` changes `email` but leaves `lastNotifiedEmail`
  alone, so the two no longer match.

**Only step 4 reads the answer.** Steps 3 and 5 ignore it, so a resend to a
student or to a no-account address still sends. The value should be a
two-member union rather than a boolean, so any new caller has to choose one;
the plan names it.

**It is not an oracle.** Both routes write the markers unconditionally before
dispatching (`api/students/route.ts:129`, `resend/route.ts:84-88`), and
`deliverInvitation` returns `FireAndForget`. The status, body and timing of
the teacher's response are identical whether or not the invitee is
notified. Skipping is an early return, so like the blocked and already-linked
returns it records no failure.

**Accepted residuals:**
- **Removing and re-adding the contact notifies again.** That creates a new
  row, whose dispatch is a first one. It takes two deliberate actions, and
  each add spends the hourly budget.
- **A failure during an outage goes unrecorded.** `recordDispatchFailure`
  (`src/lib/notify-health.ts`) suppresses `lastNotifyFailedAt` while failures
  look systemic. A step-4 insert that fails during such a burst leaves the
  row looking delivered, and a later resend skips it. This needs a failing
  local insert during a burst of other failures.
- **A resend can race a create's failure.** If a resend reads the row before
  the create's dispatch has failed, it sees clean markers and skips. The
  create's failure write is then superseded by the resend's `lastNotifiedAt`
  and never lands. This needs a local insert that fails while a resend is in
  flight.

### 3. The failure signal splits addresses differently

`docs/data-model.md:150` and `deliverInvitation`'s docblock
(`invitations.ts:649-657`) explain why failure recording is suppressed:
- *The email path can fail in normal operation.* It is an HTTPS call, and a
  Resend outage or lapsed key fails every send alike.
- *The in-app path essentially cannot.* It is a local insert.
- *So a recorded failure would sort addresses.* A partial outage would
  separate "in-app" addresses from "email" addresses.

Today a teacher-only account is on the email side; after this change it is on
the in-app side. The split becomes "has a fair.yoga account" (plus legacy
unclaimed rows), which is the wording that docblock already uses. The
existing suppression covers it, and no new guard is needed. Both passages
describe the in-app side as the "registered-student path" and need to include
teacher accounts.

### 4. The inbox row

`NotificationList` (`src/components/layout/notification-list.tsx`) links a
teacher row to its class, or to nothing, unless the page passes `hrefById`.
A teacher `teacher_invitation` row links to the invitations page. The type
decides first and the class second, the same order `studentNotificationHref`
uses (`src/lib/notification-links.ts:62`). The path is one constant beside
`STUDENT_INVITATION_PATH` in `notification-links.ts`, read by both the list
and the email.

### 5. The fallback email

**The email gets an action link.** `renderNotificationEmail` gives teacher
recipients no action button (`src/lib/email-templates.ts:113-116`). Add a
teacher counterpart to `STUDENT_ACTION_LINKS` that maps `teacher_invitation`
to the invitations page, and choose the map by recipient.

**Its intro needs no teacher entry.** `TEACHER_INTROS` has none for this
type, so it falls back to the student intro, "A teacher would like to connect
with you.", which reads correctly for any reader.

**The email is always sent, and the cap makes that acceptable.** A teacher
recipient cannot opt out of it, but §2 limits it to one per invitation per
address.

**Signed-out readers take one extra tap.** `/inbox/*` is in the proxy
matcher, but `/login` drops the destination (#615). Until that is fixed, they
land on `/schedule` and reach the page through the Inbox dot.

### 6. The `/inbox/invitations` page

A server component in the `(teacher)` group. As a detail page it has a back
link to `/inbox` and no tab bar, since it is not a tab root.

- **A session with a `studentId` is redirected to `/account/privacy`.** One
  rule covers three cases:
  - an account with both profiles;
  - a teacher-only account that has since added a student side by any route;
  - the moment after this page's own button succeeds.
- **Otherwise it reads the account's email and calls
  `listPendingInvitations` on every load.** It does not trust the
  notification, because since it was sent the inviting teacher may have
  removed the contact, the invitation may have been answered, or the teacher
  may have been erased.
- **With nothing pending it shows a plain empty state** and links back to the
  Inbox. Draft copy: "No open invitations".
- **With invitations pending it names each inviting teacher**, followed by
  one explanation and one button, because setting up a student side is a
  single act, not one per invitation. Draft copy:
  - one line per teacher: "{Teacher name} would like to connect with you as a
    student."
  - then: "Connecting adds a student side to your account, on the same
    sign-in. You choose whether to connect, and what each teacher can see."
  - button: "Set up student side".
- **The button:**
  - posts to `POST /api/account/student-profile`, which authorizes by
    session;
  - treats `409 ALREADY_STUDENT` as success;
  - then navigates to `/account/privacy` explicitly.

  `JoinAsStudent` already has this request and its error handling, but its
  copy is about joining a class; the plan decides between a copy prop and a
  sibling component. Navigation is explicit rather than a refresh that
  relies on the server redirect firing.
- **Surfaces follow `docs/design-brief.md`:** a sand-soft card with a 1px
  border and radius 16, the six type styles, and no motion.

`/account/privacy` and `PendingInvitationCard` handle the rest, unchanged.

### What stays the same

- `POST /api/invitations/[id]/respond` still requires a student for both
  answers, and `invitations-api.test.ts:1577` stays true.
- The `(student)` layout, `/account/privacy` and `PendingInvitationCard`.
- The no-account email branch, `renderInvitationEmail`, and its test.
- #171's export boundary and `docs/data-model.md:226`.
- Student and dual-profile invitees, resend included.

## #172's acceptance criteria against this design

1. **The invitation is reachable from where they land.** Signed in, they see
   the Inbox dot on `/schedule`, open the row, and reach the page. The issue
   imagined a surface on the home page itself; the Inbox is that surface.
2. **They are offered `POST /api/account/student-profile`, then acceptance
   through the existing route, with no auto-create.** Met.
3. **The email is not the no-account email.** A teacher-only account gets the
   notification fallback email instead. It is not an oracle (§2, §3). Met.
4. **A test that fails today.** Kept, but it fails earlier than the issue
   says: no teacher notification is created, so that is the first assertion,
   before the 403.

## Testing

Test-first. Every guard below is proven to bite (*Mutation checks*).

**Service**, in `src/services/invitations.notify.test.ts`, using its existing
mock of Resend:
- **Teacher-only address:** exactly one teacher-recipient `teacher_invitation`
  notification, and no invitation email.
- **Teacher-only address, repeat dispatch:** nothing.
- **Readdressing and a recorded failure** are decided before
  `notifyInvitee` sees the dispatch, so they are pinned where they are
  decided: `priorDispatchFor`'s own unit test, and a resend route test of
  what it passes on.
- **Address with both profiles:** the student notification only, never a
  teacher one.
- **Student address, repeat dispatch:** still notified. This is the other
  side of the rule, pinned so that widening it cannot pass silently.
- **No-account address, repeat dispatch:** still emailed.
- **Blocked teacher-only address:** nothing; the block check still runs
  first.

**Integration**, in `tests/integration/invitations-api.test.ts`:
- **The #172 path.** Teacher B adds teacher-only A. A has a teacher-recipient
  notification (polled, since dispatch is fire-and-forget). A's
  `GET /inbox/invitations` returns 200 naming B. A's student-profile request
  returns 201. A accepts with 200, and the `TeacherStudent` link exists.
  Today this fails at the first assertion.
- **Resend to the same address.** No second notification, and the response's
  status and body equal a resend that did notify.

**Unit:**
- **`renderNotificationEmail`:** a teacher `teacher_invitation` links to the
  teacher path; a student's still links to the student path; a teacher
  `booking_confirmed` has no link.
- **`NotificationList`:** a teacher `teacher_invitation` row links to the
  invitations page; a class row still links to its class.

**Page**, in `src/app/(teacher)/inbox/invitations/page.test.tsx`. The
session, Prisma and the service are mocked, the way
`settings/rooms/[id]/page.test.tsx` renders an async server page. It covers
the redirect, the named teachers with one button, and the empty state.

**End-to-end**, in `tests/e2e/invitations.spec.ts`, runs the page against real
data.
- **The whole journey:** a teacher-only invitee sees the Inbox dot, opens the
  row, reaches the page, sets up a student side, lands on `/account/privacy`
  and accepts, and B's CRM shows a student.
- **Edge visits:** visiting with a student profile redirects; visiting with
  nothing pending shows the empty state.

### Mutation checks

For each one: break it, record the exact failure text, restore, and
re-verify.

1. Delete the teacher branch: the integration #172 path fails.
2. Ignore the repeat value in step 4: the teacher repeat test fails.
3. Invert the address comparison in the resend route: the readdress test
   fails.
4. Apply the repeat value in step 3: the student repeat test fails.
5. Move step 4 above step 3: the both-profiles test fails.
6. Drop the teacher action link: the email test fails.
7. Remove the page's `studentId` redirect: the page test's student-side case
   fails, and so does the e2e visit after joining.

## Docs and comments this change makes false

**Live docs:**
- **`docs/data-model.md:150`.** The list of `notifyInvitee` early returns
  that record no failure ("blocked, already linked") gains the repeat skip,
  and its "registered-student path" includes teacher accounts.
- **`docs/information-architecture.md`, *Tab 3: Inbox*.** Add the
  invitations page.
- **`docs/teacher-screens.md` §10.1.** Name the invitation notification.
  Leave screen counts alone: CLAUDE.md cites the inventory total, so the plan
  re-derives it before touching any count.

**Docblocks and comments.** Read each one whole, because what changes is
what they describe, not a name a grep would find:
- `invitations.ts:434-436`, `notifyInvitee`'s summary: "a registered
  invitee… a plain email for everyone else".
- `invitations.ts:595-607`: "No Student row means no in-app surface exists to
  notify".
- `invitations.ts:649-657`, `deliverInvitation`'s docblock: "the
  registered-student path".
- `listPendingInvitations`' docblock, which names the student privacy page
  as its reader.
- `email-templates.ts`: `renderInvitationEmail`'s docblock ("the address has
  no `Student` row yet") and the action-links docblock.
- `email-templates.test.ts:145-148`.
- `notification-list.tsx`: the `hrefById` docblock.

**Records left as they are.** The arrival-state table in
`docs/superpowers/specs/2026-08-04-student-link-acceptance-design.md:314` is a
record of #166's design. The PR body states what changed.

## Out of scope

- **#615.** `/login` drops the destination, so a signed-out reader of any
  sign-in-protected link lands on their role's home.
- **A resend cooldown for every recipient.** Considered under decision 4 and
  not filed.
- **The legacy unclaimed `Student` row** that shares a teacher-only account's
  address (§1).
- **Declining or dismissing** for a teacher-only account.
- **A general "add a student side" entry in Settings.**
