# Data Model — Ethical Yoga App

17 entities across 6 domains. This is the source of truth for the application's data layer.

---

## People

### Account (auth identity)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| email | string, unique | The authenticated identity — sessions and passkeys key off this, not off Teacher/Student. Lowercased on write by `emailField` and pinned by `Account_email_lowercase_check` (#170) — Postgres compares this column case-sensitively, so without it a case variant is a second identity. |
| **Timestamps** | | |
| created_at | datetime | |

One Account per human. Teacher and Student are profiles optionally linked to it, each holding at most one LIVE profile of its kind per account — enforced by the partial unique indexes `Teacher_account_live_unique` and `Student_account_live_unique` (`ON ("accountId") WHERE "deletedAt" IS NULL`) rather than a plain `@unique` — a dual-role person (a teacher who also attends classes) has one Account with both profiles attached. See Design Notes below for the claim path that links an Account to a pre-existing unclaimed Student.

### Teacher (core)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| first_name | string | |
| last_name | string | |
| email | string, unique | Denormalized copy of the account email. Lowercase by `Teacher_email_lowercase_check` (#170). |
| photo_url | string, nullable | |
| bio | string(250) | |
| page_slug | string, unique | Public booking page URL |
| custom_domain | string, nullable | |
| **Defaults** | | |
| default_currency | string, default 'EUR' | |
| default_timezone | string | e.g. 'Europe/Amsterdam' |
| default_reminder | enum: morning_of, evening_before, 1h_before | Pre-fills class reminder setting |
| **Payment settings** | | |
| payment_level | enum: 1, 2 | Level 1 = manual, Level 2 = payment processor |
| bank_iban | string, nullable | Level 1 only |
| bank_account_name | string, nullable | Level 1 only |
| processor_type | enum: mollie, stripe | Level 2 only |
| processor_account_id | string, nullable | Level 2 only |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

### Student (core)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| first_name | string | Required |
| last_name | string | Required |
| email | string, unique | Required. Contact email; copies the account email once claimed. Lowercase by `Student_email_lowercase_check` (#170). |
| income_tier | int (1-5) | Global tier, can change anytime |
| *account_id* (FK), nullable | → Account | Nullable for rows predating #166; nothing creates a new unclaimed row any more (see Design Notes). Bound to `claimed_at` by `Student_claim_link_check`. |
| claimed_at | datetime, nullable | Set together with `account_id`, never independently — see `Student_claim_link_check` below. |
| **Optional fields** | | |
| phone | string, nullable | |
| birthday | date, nullable | |
| address | string, nullable | e.g. for teacher sending holiday cards |
| **Preferences** | | |
| reminder_pref | enum: eve, morning, 1h, off | Student controls their own reminders |
| email_notifications | boolean, default true | Fallback email on/off |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |
| deleted_at | datetime, nullable | GDPR erasure marker (#623). Set by `deleteStudentAccount`; `account_id` and `claimed_at` are both RETAINED, not cleared. |
| **Constraints** | | |
| check | `Student_claim_link_check`: `(claimed_at IS NULL) = (account_id IS NULL)` | |
| unique (partial) | `Student_account_live_unique` on `(account_id)` `WHERE deleted_at IS NULL` | At most one LIVE student profile per account (#623) |

Nothing in the database requires an erased row to keep its `account_id`. A future erasure that nulled it would, via `Student_claim_link_check`, be forced to null `claimed_at` too — producing a row `resolveOrClaimAccount`'s claim probe (`db.student.findFirst({ where: { email, claimedAt: null } })`) would treat as claimable. Today the tombstoned email is what keeps that unreachable: the erased row's `email` no longer matches the address anyone signs in with.

### StudentPrivacy (per-teacher privacy layer)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *student_id* (FK) | → Student | |
| *teacher_id* (FK) | → Teacher | |
| share_full_name | boolean, default false | Surname; when false a teacher sees a last initial |
| share_email | boolean, default false | |
| share_phone | boolean, default false | |
| share_birthday | boolean, default false | |
| share_address | boolean, default false | |
| receive_comms | boolean, default true | Opt-out from teacher announcements |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

Not created on booking. Two sites write it: the student's own
`PUT /api/students/[id]/privacy` — where the student opts in to each field —
and `DELETE /api/teacher-links/[teacherId]` (`unlinkTeacher`), which force-sets
every flag, including `receive_comms`, to `false` when a student severs a
teacher link. The second write is not an opt-in; it is the system silencing
every share on the student's behalf because deleting the link alone does not
stop the teacher reaching them. Until one of those two sites has run there is
no row, and every read treats absence as maximum privacy
(`privacy?.shareX ?? false`). One projection reads these flags for nearly
every teacher-facing surface: `src/lib/student-visibility.ts`. The one
exception is `rosterLinkState` (`src/services/invitations.ts`), which decides
what `POST /api/students` may tell a teacher about a guessed address (#412)
outside that projection — and so has to answer "may this teacher see this
address" by both of the projection's own routes, not just the flag: this
teacher's `StudentPrivacy.shareEmail`, **or** `Student.claimedAt IS NULL`,
which `bypassesPrivacy` treats as fully visible to any teacher (#419). Those
two are the whole census of that rule, and they share its predicate
(`privacyIsBypassed`) rather than each spelling it out, because a change
reaching only one of them is the drift #419 was filed for — they keep their
own logging, which is not the same question.

No unclaimed `Student` is reachable today: #166 stopped the CRM creating the
row, the sole remaining create site (`api/account/student-profile`) sets
`claimedAt` under both of its authorizations, and the seed writes none.
So this rule governs no live data, and the reason to keep the two surfaces
agreeing anyway is that the day one of those three facts stops holding, the
disagreement is what ships — silently, since neither surface would be wrong
on its own. See the Invitation section below.
No server-side predicate may filter
(`where`) or order (`orderBy`) on a privacy-gated `Student` column —
`lastName`, `email`, `phone`, `birthday`, or `address`, one per
`VisibilityFlags` member in that file — because a match, or a sort position,
against a column the projection redacts is an enumeration oracle regardless
of what the response body shows: a teacher can learn a withheld value from a
hit/miss, a count, or its rank among other rows even when it is never
rendered. Re-derive this column list from `VisibilityFlags` if it ever
changes: `_visibilityFlagsAreExhaustive` (same file) only pins that every
`StudentPrivacy` column is classified as a flag or excluded, not that this
sentence's five-item list stays in sync with it. `firstName` is exempt: `formatStudentName`
(`src/lib/format.ts`) always discloses it in full via `displayName`
regardless of privacy settings, which is also why the list route's own
`orderBy: { firstName: 'asc' }` is safe. Found and fixed in #176, which
replaced server-side student search with client-side filtering over the
already-redacted response.

One carve-out to the `where`/`orderBy` rule above: `listPendingInvitations`
(`src/services/invitations.ts`) filters on `teacherStudents: { none: {
student: { email } } }` — a match against `email`, a privacy-gated column.
It is safe because the query runs for the signed-in student against their
OWN address only; no teacher's request can reach this predicate, so there is
no party for it to disclose the match to. The general rule still holds for
every teacher-facing route.

### Invitation (teacher → student contact, #166)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *teacher_id* (FK) | → Teacher | |
| email | string | Lowercased on write — the one place a teacher types another person's address, so a case slip must not hide the invitation from them |
| first_name | string, default '' | As the teacher typed it; independent of the invitee's own Student row, if one exists |
| last_name | string, default '' | |
| status | enum: pending, accepted, declined | |
| is_archived | boolean, default false | Teacher's own filing action; never hides the row from the invitee |
| responded_at | datetime, nullable | Set when status leaves pending, cleared when an accepted row is returned to pending (see re-inviting, below) |
| last_notified_at | datetime, nullable | When a notify was last attempted — written unconditionally by both `POST /api/students` and `POST /api/invitations/[id]/resend`, decoupled from whether `TeacherBlock` withholds delivery, so a teacher can never tell "blocked" from "not yet (re)sent" by watching this column (#173) |
| last_notified_email | string, nullable | The address a notify was last attempted against — compared to `email` to tell the teacher whether an edit since then has gone unsent |
| last_notify_failed_at | datetime, nullable | Set only when the fire-and-forget dispatch (`deliverInvitation`) genuinely throws — never on a `notifyInvitee` early return (blocked, already linked) — and behind two further guards a PR review found this column needs (#392, #583). `recordDispatchFailure` (`src/lib/notify-health.ts`) suppresses the write while recent failures look systemic: only the stranger path (`sendInvitationEmail`, an HTTPS call) can throw under normal operation, the in-app path (`createNotification`, a local insert, for a student or a teacher-only account) essentially never does, so an unguarded write during a Resend outage or a lapsed API key would read "failed" for every unregistered invitee and "sent" for every registered one — a proxy for "does this address have a fair.yoga account," reopening #166. The write is also scoped to the row still holding the `lastNotifiedAt` value the dispatching request wrote, so a superseded attempt's late failure cannot overwrite a newer attempt's state. Cleared to null on every fresh dispatch attempt's own unconditional pre-write and on `PUT /api/invitations/[id]`'s `readdressed` branch — re-derive the current writer set with `grep -rn lastNotifyFailedAt src/`. No paired `last_notify_failed_email` column — clearing on every fresh attempt keeps this always describing the most recent attempt against the row's current address without one |
| teacher_inbox_notified_at | datetime, nullable | Set by `notifyInvitee`'s teacher branch on delivery, capping that branch at one notification per invitation (#622); cleared by `deliverInvitation`'s failure-path `.catch`, by a genuine readdress in `PUT /api/invitations/[id]`, and by `revivePendingInvitation` — full writer census and re-derivation command in "Who an invitation reaches," below. The claim that sets it and the `Notification` insert it stands for commit in one transaction, so this column can never read "told" over a notification that does not exist. Never read outside those writers: no teacher- or student-facing route selects it, because which of `notifyInvitee`'s branches an address takes is exactly the fact #172's routing exists to keep off every surface — `TeacherFacingInvitationSelect` (`src/lib/contacts.ts`) makes that a build failure rather than a review note for every select that renders a contact — re-derivation command in that type's own docblock. The `.catch`'s clear is scoped to the marker value that same dispatch's own claim wrote, not to `lastNotifiedAt` — see "Who an invitation reaches" for what that distinction buys. Like `delivered`, this column is left alone by `deleteStudentAccount` (`gdpr.ts`), the other writer of `Invitation.email`. Benign, but **not** because of the `.invalid` TLD: `gdpr.ts` writes `deleted-<accountId>@deleted.invalid` onto `Account.email` too, so an address under that TLD can perfectly well hold an account. What makes it benign is that the local part this function writes onto `Invitation.email` is a fresh `crypto.randomUUID()` rather than anything derived from an id, so it matches no `Account.email` and the teacher branch is unreachable for that row. Worth naming so the next writer of `Invitation.email` checks this column too — and worth naming precisely, since an erased *teacher's* account still holds that `Teacher` row in `account.teachers` (the erasure is a soft delete); it is `notifyInvitee`'s `deletedAt: null` filter, not the row's absence, that keeps the teacher branch from reading it as live |
| delivered | boolean, default true | Whether this teacher's current address for this invitee was safe to disclose to them the last time one of its writers touched this column — not every write to this row does. Three producers of `delivered: false`: `inviteContact`'s create and revive paths compute `blocked === null && !link.linked` fresh each time (never fixed at the row's first write), which is false for either of two separate reasons — a `TeacherBlock` on the address (an ordinary re-invite of someone who has blocked this teacher, nothing decoy-shaped about it) or an already-linked-but-unshared pair (the #417/#418 gate's decoy) — and `PUT /api/invitations/[id]`, which resets it to `false` when the incoming `email` differs from the row's own stored value, a genuine re-address rather than mere field presence (`contact-form.tsx`, the route's only client, sends `email` on every save whether or not it changed). Every other writer of this row leaves it as it stood, including `deleteStudentAccount` (`gdpr.ts`) — a second, pre-existing writer of `Invitation.email` that never touches this column; currently benign, since the anonymised address it writes lives under the reserved `.invalid` TLD and can never match `unlinkTeacher`'s `where`, but worth naming so the next writer of `Invitation.email` checks this column too. The marker exists so a later writer (`unlinkTeacher`'s tombstone) can scope a mutation to rows that were actually delivered, without re-deriving delivery status from current `TeacherBlock`/roster state — and it must never be selected on any teacher- or student-facing route: it is literally `!blocked && !linked`, so exposing it would hand a teacher both the #173 and #417/#418 secrets at once. Every row that existed before this shipped backfilled to `true` regardless of its actual delivery history (in a `docker compose up -d --build` deploy, that window can run slightly past the migration itself, up to the moment the new application code starts serving), so a decoy planted before that stays indistinguishable from a genuine delivery until one of the writers above next touches its row |
| **Timestamps** | | |
| created_at | datetime | |
| **Constraints** | | |
| unique | (teacher_id, email) | One contact per address per teacher |
| check | `email = lower(email)` | The lowercasing is relied on by every reader that matches an account or student address against this column |
| check | `(responded_at IS NULL) = (status = 'pending')` | A pending invitation has no response time; an answered one has one |
| check | `last_notified_email IS NULL OR last_notified_email = lower(last_notified_email)` | Same lowercase reasoning as `email` |
| check | `(last_notified_at IS NULL) = (last_notified_email IS NULL)` | Both written together, in one statement, or neither |

A teacher may not link themselves to a student unilaterally. `POST /api/students` creates an `Invitation`, never a `Student` row — the `TeacherStudent` link (above) forms only once the invitee accepts it, or books one of the teacher's classes. A declined row is not deleted: it is the tombstone that stops the same address being re-invited, so `PUT`/`DELETE` on a declined invitation both refuse. This is a separate table from `TeacherStudent` on purpose — `POST /api/students` must behave identically whether or not the address is already on the platform, which it cannot if it writes to a table with a unique `email` column.

`accepted` is not a second tombstone. Whether the teacher may invite that address again turns on whether a `TeacherStudent` link actually exists, never on the status alone — erasing a student deletes their links and leaves this row `accepted`, and reading the status there would tell the teacher "already one of your students" forever about someone off their roster, with `unique (teacher_id, email)` blocking any second row. `inviteContact` therefore returns such a row to `pending` (clearing `responded_at`) rather than creating one, and a `TeacherBlock` on the address still withholds delivery exactly as it does for a first invitation.

Since #412, a live link is no longer sufficient on its own to refuse the invite: `inviteContact` refuses (`ALREADY_LINKED`) only when the link exists AND the teacher could already have had that address anyway — which since #419 is three disjuncts, not two: the student's `StudentPrivacy.shareEmail` for this teacher is true, or the student is unclaimed (`claimedAt IS NULL`, which `bypassesPrivacy` hands to any teacher in full — see the StudentPrivacy section above), or this same `accepted` status holds. See `rosterLinkState`, `src/services/invitations.ts`. A *claimed* linked student who has not shared their email gets a real, silent pending invitation instead of a refusal that would confirm the address belongs to one of this teacher's own students.

The unclaimed disjunct restores what #412 accidentally took away, rather than opening anything: before #412 the link alone refused, so an unclaimed linked contact met `ALREADY_LINKED` then too. In between it fell through to an invitation that could never arrive — `notifyInvitee` returns early on a live link, so the row sat in Contacts forever under a name the teacher typed, undeliverable and unexplained.

**What a student's own act resolves (#418).** The rule spans `resolveInvitationOnLink` (`src/services/link-consent.ts`), `linkTeacherStudent` (`src/services/roster-link.ts`) and the two callers that create a roster link on the student's behalf — `POST /api/registrations` (their own booking) and `addToWaitlist` (`src/services/waitlist.ts`) — so it is stated here rather than in any one of them. A booking or a waitlist join returns a **`pending`** invitation to `accepted` only when that same act created the `TeacherStudent` link; someone already on the roster has nothing left to consent to, so a `pending` row standing beside a link that already existed is left where it is. A **`declined`** row is returned to `accepted` either way, and the `TeacherBlock` is deleted either way. `promoteNext` and `claimSpot` (`waitlist.ts`) resolve nothing at all, and not for the same reason. A promotion is never the promoted student's own act: `handleSpotFreed` runs from a cancelled registration (`DELETE /api/registrations/[id]`, which the class teacher and the registered student can each call), from another student's erasure (`deleteStudentAccount`, `src/services/gdpr.ts`) and from the scheduler's reconciliation sweep (`src/services/waitlist-reconciliation.ts`). Whichever door it comes through, the request being acted on is one the student made earlier and nothing rechecks their intent in between. A claim *is* the student's own act at that instant (`POST /api/waitlist/claim` is `requireSession` and self-only), so it clears that bar and abstains on the other one: its link write is a backstop, not the act's own link. It can insert only where the join's own write is missing — a `waiting` row no `addToWaitlist` ever wrote (pre-#166, or hand-written, which is what `promoteNext`'s docblock names), or one whose link a later unlink deleted (`withdrawWaitingEntriesForTeacher`'s docblock names that race). Both are repairs, and a repair is not a fresh act of consent; in the unlink case a resolution taken off one would clear the tombstone the student had just written. Where the join did write the link, the claim inserts nothing anyway. A new caller has to clear both bars: the act must be the student's own at this instant, and it must be the act that put them on the roster.

That roster — which sites create a roster link, which of them resolve, which
abstain — is re-derived rather than trusted from this prose:

```sh
grep -rnE 'linkTeacherStudent\(|resolveInvitationOnLink\(' --include="*.ts" src/ \
  | grep -v '\.test\.ts'
```

**Nine lines today**: the two function definitions, plus every production site
that creates a roster link or resolves an invitation on one. Three link
creators call no `resolveInvitationOnLink` in the same function, and they are
not one kind. `promoteNext` and `claimSpot` abstain, each for the reason above.
`acceptInvitation` (`src/services/invitations.ts`) is not an abstainer at all:
it resolves the row itself, with its own compare-and-set on `status:
'pending'`, because the accept IS the answer. So a link creator turning up here
has to be placed in one of those two categories — abstains, with its reason
recorded above, or resolves by its own hand — and neither is the default. The
match is syntactic — a call made through an alias would escape it — the same
limit `docs/lock-order.md`'s `FOR UPDATE OF` check runs under.

Each half is load-bearing against a different failure, and neither follows from the other:

- The **`pending`** narrowing is a security property. A teacher who guesses the address of a student already on their roster who has not shared it gets an ordinary success and a real, undelivered `pending` row (the paragraph above) rather than the `ALREADY_LINKED` refusal that would confirm the address. Resolving that row on the student's next ordinary booking handed the same answer back one probe later, because an `accepted` row on a linked pair *is* refused `ALREADY_LINKED` — the third disjunct above. A row that never becomes `accepted` has no second probe to leak into.
- The **`declined`** half stays unconditional because narrowing it could only strand students, and because it is not an address a teacher can write to. Two functions write `declined`: `unlinkTeacher`, which deletes the link in the same transaction, and `declineInvitation`, which writes the tombstone and a `TeacherBlock` and touches no link at all — so a `declined` row standing beside a live link is a state the app itself produces, and "declined implies unlinked" is not available as a premise. What is available is that both writers are reached only through the invitee's own session (`DELETE /api/teacher-links/[teacherId]` and `POST /api/invitations/[id]/respond`, both `requireStudent`, both taking the student from the session), so a teacher cannot manufacture a `declined` row at an address they guessed. That is what would be needed to turn this half into the oracle the `pending` half closes, and no path reaches it. Narrowing it, meanwhile, would leave every student whose decline stands beside a link they did not create — a promotion re-linking around a raced unlink, or any decline written while linked — permanently linked, still blocked and un-re-invitable behind a tombstone `DELETE /api/invitations/[id]` refuses to remove. Reversing a decline is the escape hatch the whole decline design rests on: permanent from the teacher's side, always reversible from the student's, and reversible by their own act alone — a booking or a waitlist join clears the block and the tombstone together.

The fact that tells the two apart is read off the roster link's own write, not from a column on this table. `linkTeacherStudent` is a single `INSERT … ON CONFLICT DO NOTHING` and returns a `LinkOutcome` saying which of the two it did, so the reading cannot race a concurrent writer the way a `findUnique` on either side of it could — and the two names travel as a union rather than a `boolean`, so an unrelated flag cannot be handed to `resolveInvitationOnLink` in their place. A stored origin marker would also answer a subtly different question — where a row came *from*, when what matters at resolution time is what the pair is *now* — and `PUT /api/invitations/[id]` can move a row's `email` onto a linked pair, which is exactly where those two come apart.

**Who an invitation reaches (#172).** `notifyInvitee` (`src/services/invitations.ts`) delivers an unblocked invitation through the first of these that holds for its address:

- **A `Student` row** gets a student-inbox `teacher_invitation`, or nothing if that student is already on this teacher's roster.
- **Otherwise, an `Account` with a LIVE teacher profile** gets a teacher-inbox `teacher_invitation`, which opens `/inbox/invitations`. The teacher branch delivers at most once per invitation (#622).

  **The claim is the check, and it commits with what it stands for.** The branch does not read the marker and then write it; it issues a conditional `UPDATE` whose `where` requires the marker null — plus the invitation's id, its teacher, and the address this dispatch actually resolved an account for — and treats a matched row as permission to notify. That claim and the `Notification` insert run in one transaction, so the marker cannot be committed over a notification that was never created: a refused insert takes the claim down with it, and a process killed between the two commits neither. The address clause is what keeps a `PUT` readdress landing mid-dispatch from capping the *new* address behind a notification the *old* one received — a state nothing fails on, and so a state nothing would re-open.

  **`lastNotifyFailedAt` cannot serve as the release valve for that cap.** Every dispatching route clears it before dispatching, unconditionally, so by the time `notifyInvitee` could read it there is normally nothing left to read; re-deriving that set is the `grep -rn lastNotifyFailedAt src/` in the `last_notify_failed_at` row above. (Normally, not always: a second dispatch clearing and then failing fast can write the column while an older one is still in flight — which changes nothing here, because the clause is not there. The reason it is not there is that the column is written to destroy a correlation, and cannot then be read as evidence of one.) So a failed dispatch re-opens the cap on the failure path itself, in `deliverInvitation`'s `.catch`.

  **Writers.** Set by the teacher branch's claim; cleared by that `.catch`, by a genuine readdress in `PUT /api/invitations/[id]`, and by `revivePendingInvitation`. No reader selects this column outside those writers — it reaches no teacher- or student-facing surface, which is why the `.catch`'s clear is not gated by the same burst suppression that guards `lastNotifyFailedAt` from becoming an account-existence proxy (see `notify-health.ts`'s own docblock): there is no surface for a burst to leak through here.

  **What the clear's CAS is on, and what it now costs.** It is scoped to the marker value the same dispatch's own claim wrote, not to `lastNotifiedAt`, because the claim is what this column correlates with. Under the transaction the clear has become a backstop rather than the guarantee: the case it can still act on is the commit a process never heard the answer to, where clearing re-opens a cap over a notification that did land and the next resend notifies twice. That is the direction this design fails in on purpose. The CAS's load-bearing half is the other one — a dispatch that exited before the claim wrote that value nowhere, so a marker some other attempt set is left alone. The exception is arithmetic rather than logical: `claimedAt` is a `TIMESTAMP(3)`, so two dispatches starting in the same millisecond share it and one can clear the other's marker, which again costs one extra notification.

  Re-derive the writer set with `grep -rn teacherInboxNotifiedAt --include="*.ts" --include="*.tsx" src/ | grep -v '\.test\.ts'`, and read the hits down rather than counting them — the command matches prose in comments as readily as code. Every hit should be one of: `invitations.ts`'s claim, its `.catch` clear, `revivePendingInvitation`'s reset, the `PUT` route's readdress reset, the miss-path diagnostic `count` inside `notifyInvitee`'s teacher branch (it tells `already-capped` from `no-matching-row` for the log line, and reads no further than that), or the `TeacherFacingInvitationSelect` exclusion in `src/lib/contacts.ts`, which names the column precisely so that no select may. A hit anywhere else — and in particular the column appearing inside a `select` — is what falsifies this.
- **Otherwise,** the address gets the sign-in email.

An account holding both LIVE profiles therefore always takes the student branch — the `Student` lookup runs first and does not consult the teacher side at all. An account holding a LIVE teacher beside an ERASED student takes the teacher branch instead: erasure tombstones `Student.email` (see `deleteStudentAccount`, `services/gdpr.ts`), so the lookup above misses and falls through.

**The teacher branch consults no email preference, because a teacher recipient has none.** `processEmailFallback` (`src/services/email-fallback.ts`) initialises `emailEnabled = true` and only its student arm reassigns it, through `shouldEmailStudent` (`src/services/notification-policy.ts`). There is no teacher-side counterpart to `Student.emailNotifications` in the schema: `Teacher.defaultReminder` is class-reminder timing and `StudentPrivacy.receiveComms` is student-side per-teacher announcement muting, neither of them an email opt-out for a teacher recipient. Re-derive by reading the models rather than by grepping the name — the claim is that no such preference exists under *any* spelling, and a column added as `emailEnabled` or `receiveEmails` would leave a name-scoped grep's output unchanged while falsifying it:

```sh
grep -n "model Teacher" -A 40 prisma/schema.prisma
grep -n "model Account" -A 25 prisma/schema.prisma
```

Read both whole. Any boolean preference column on `Teacher` or `Account` governing whether that person is emailed is what falsifies this. So keeping `teacher_invitation` out of `ESSENTIAL_NOTIFICATION_TYPES` (`src/services/notification-policy.ts`), which is what honours a *student* invitee's opt-out, buys a teacher invitee nothing, and the one-notification cap above is what bounds the teacher branch instead. Building the missing preference is filed out of scope in `docs/superpowers/specs/2026-09-16-teacher-inbox-dispatch-cap-design.md` (§10).

The teacher branch filters on teacher liveness: `notifyInvitee` selects `account.teachers` with `where: { deletedAt: null }` and takes the result through `liveProfile` (`src/lib/live-profile.ts`), so a row's existence in `account.teachers` never stands in for a live teacher. This is load-bearing since #623: an account can hold erased `Teacher` rows beside a live one, so nothing about a row's mere presence tells the branch whether there is a teacher there to read the notification — the filter is what keeps it from addressing a notification to a tombstone.

Re-derive the filter with `grep -n "teachers: { where: { deletedAt: null }" src/services/invitations.ts`.

A teacher-only account is offered no decline: leaving the invitation unanswered is its answer. So no `TeacherBlock` is written from one, and the student export's boundary in the TeacherBlock section below stays true.

### TeacherBlock (a student's standing refusal of one teacher, #166)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *teacher_id* (FK) | → Teacher | |
| email | string | Lowercased on write, same reasoning as `Invitation.email` |
| **Timestamps** | | |
| created_at | datetime | |
| **Constraints** | | |
| unique | (teacher_id, email) | |
| check | `email = lower(email)` | Same reasoning as `Invitation.email` — the block is looked up by an address someone else typed |

Written whenever a student refuses a teacher, by either route: `unlinkTeacher` when they walk away from a link they already had, `declineInvitation` when they turn an invitation down (#522). Held in its own table rather than as a flag on `Invitation` so a blocked address behaves identically to a fresh one everywhere an `Invitation` is read, edited, archived or re-created — the only place the distinction is allowed to surface on the teacher's side is whether an invite email is actually sent.

**A refusal is a row, never a derived key.** What stands between a student and a teacher they refused is a stored row, not a fact re-derived from a column somebody else can move. `deleteStudentAccount` (`src/services/gdpr.ts`) rewrites the identity columns a predicate could be keyed on — `Student.email`, `Account.email`, `Invitation.email`, `Invitation.lastNotifiedEmail` — so a refusal keyed on one of them is a refusal the subject's own erasure lifts, silently and in the direction that hurts them. Re-derive that list with:

```sh
grep -nE 'tx\.[a-zA-Z]+\.update|anonymizedEmail|@deleted\.invalid' src/services/gdpr.ts
```

Read down the hits inside `deleteStudentAccount`: each anonymised write is a `tx.<model>.update…` accessor hit — which is why the accessor alternative is in the pattern — with the column it rewrites named on a later hit, before the next accessor. An accessor under which no hit names a column rewrites no identity, and hits past the end of that function belong to `deleteTeacherAccount`. Matching the address literal alone is **not** enough: both `Invitation` columns are written through the `anonymizedEmail` variable and never carry the literal, so a grep for `@deleted.invalid` finds `Student.email` and `Account.email` and silently drops the two that #522 was actually about — the same grep-reads-syntax hazard the *Hash the address* bullet below hits with the `teacherBlocks` relation filter. The scope of the check is these columns, not every mutable-key-derived predicate in the repo.

#522 was that defect on the decline path, and the same shape had already been found twice from other directions: `PUT` and `DELETE /api/invitations/[id]` each refuse a `declined` row precisely because moving or deleting it would free the `(teacher_id, email)` an answer hung on. Three doors, found one at a time, each with its own guard. The rule is what catches the fourth: a refusal that needs a guard on every door that can touch its key is stored wrong.

**Decided (#171): erasing a student leaves this row exactly as it stands.** `deleteStudentAccount` (`src/services/gdpr.ts`) keeps the row — the erased person's plaintext address included — as a suppression entry, so it can go on honouring a refusal that person made. It is **one** decision: both routes above write this row, so it covers every refusal whichever way the student said no. It was made as a product call, not on legal advice, and the GDPR/legal review `CLAUDE.md` parks can reopen it; if it does, this paragraph is where the new answer lands.

- **The same person stands on both sides.** Every option trades one of the subject's interests against another — the erasure they asked for, and the refusal they made. The refusal is the more specific instruction, about one teacher, and asking to be forgotten does not withdraw it. The erased person's real mailbox still exists in the world: while it is still theirs, if the teacher re-types that address, this row is what makes `inviteContact` compute `delivered: false`, so no invitation email is sent.
- **The row is small, and no teacher reads it.** It holds the teacher, the address a refusal is matched on, and when it was written. No teacher-facing route reads this table, and a new reader is what would change that — re-check with the two commands in the *Hash the address* bullet below. The one reader that hands rows back out is the student's own export (`exportStudentData`, `src/services/gdpr.ts`), and it lists only refusals made since the current student profile was created: both routes that write a block (`POST /api/invitations/[id]/respond`, `DELETE /api/teacher-links/[teacherId]`) require a signed-in student, so an older block on the same address was written by an erased profile, and narrating it to whoever holds the address now is the disclosure `listDeclinedTeachers` already refuses.
- **The subject is told before they commit.** The student delete confirmation (`src/components/account/data-and-deletion.tsx`) says the address behind a refusal is kept, and why. A dual-role account deleting from teacher settings is shown the teacher copy instead, which carries none of the student copy's sentences, this one included — although `DELETE /api/account` erases every profile the account holds.

The accepted costs are a retained plaintext address belonging to someone who asked to be forgotten, and a refusal that can outlive their hold on the address. The row is keyed on the address, not the person, so if the address later passes to someone else — a reassigned work address, a lapsed domain — that one teacher's invitations silently never reach its new holder, and nothing on their settings page says why, until they book one of that teacher's classes. Declined:

- **Scrub the address**, the way `Invitation.email` is scrubbed. Honours the erasure literally, but every lookup matches the exact `email`, so a scrubbed row matches nothing and the block silently stops blocking — a row that still exists but no longer does its job, with nothing reporting that it lapsed.
- **Hash the address.** Only equality is ever needed, so a hash would keep every lookup working without plaintext. But a plain hash of an email is reversible by dictionary — the teacher's own contact list is the dictionary — so it would need a keyed hash with a secret pepper. A keyed hash is pseudonymisation (GDPR Art. 4(5)), and pseudonymised data stays personal data for the controller holding the key (Recital 26): hashing would strengthen the row's security without taking it outside the erasure right, so it does not dissolve the question this decision answers. That reading is this project's own, not legal advice. It would also swap one silent failure for another — a lost or rotated pepper un-refuses every student at once — and on this deployment the pepper would sit in the same `.env` as the database password. `docs/superpowers/specs/2026-09-09-decline-suppression-entry-design.md` costs it on those deployment grounds and still called hashing the right shape for the question while it was open; #171 declines it on the legal point above, which that spec did not weigh. If it is ever reopened, the sites that would have to hash first take two commands, not one — a Prisma relation filter names the relation field rather than the model accessor, so `listPendingInvitations`'s `teacherBlocks: { none: { email } }` is invisible to the obvious grep:

  ```sh
  grep -rn "teacherBlock\." src/ | grep -v '\.test\.'
  grep -rn "teacherBlocks" src/ | grep -v '\.test\.'
  ```
- **Expire the row after some period.** The refusal's purpose lasts as long as the teacher can type the address, so an expiry is the scrub's silent lapse on a timer.

`Invitation` rows are handled differently from this one, and that asymmetry is intentional: `deleteStudentAccount` anonymises `Invitation.email` / `first_name` / `last_name` in place (to `deleted-<random-uuid>@deleted.invalid` — one `crypto.randomUUID()` token generated per erasure call and reused across every row it touches, not derived from the subject's id, so a teacher who plants a guessed-address decoy invitation cannot read the anonymised `email` back via `GET /api/invitations` and recover which student it was; the token satisfies the lowercase CHECK the same way the id it replaced did) on every row whose current `email` is the subject's, while leaving `status` and `responded_at` alone, so a teacher's own filing state is not rewritten by someone else's erasure. `last_notified_email` is scrubbed separately and more broadly: wherever it still holds the subject's address, independent of what the row's current `email` is — a teacher's `PUT /api/invitations/[id]` edit can move `email` on without touching the marker, so the marker's own scrub has to key on itself rather than on the row's current identity. `deleteTeacherAccount` deletes that teacher's `Invitation` rows outright — they hold other people's addresses and, with the teacher erased, guard a door nobody can open.

**A refusal survives that anonymisation, because it does not live on the scrubbed row (#522).** The scrub frees `(teacher_id, email)` exactly as a delete would, so `inviteContact` stops answering `DECLINED` for that address and the teacher's next attempt creates an ordinary-looking row — but `TeacherBlock` is retained, `delivered` computes `false` from it, and `deliverInvitation` sends nothing. What the scrub costs the subject is the teacher-facing *narrative* of their refusal, not the refusal — which is why the #171 decision above weighed a retained plaintext address, not a standing no going quiet. This is the rule at the top of this section doing its work: had the refusal stayed a key on the `Invitation` row, this paragraph would be describing a defect instead.

**That anonymisation is itself observable, and #520 accepts the signal rather than closing it.** The columns a teacher reads are the ones it rewrites — `GET /api/invitations` and the contacts detail page both select `email`, `first_name` and `last_name` — so a teacher who typed a *guessed* address into their CRM watches that row turn into "Deleted Student" and learns the address belonged to a real account which has just erased. (`last_notified_email` is rewritten too, but reaches no screen: the contacts page hands it to `invitationDeliveryStatus`, which collapses it to a sent/not-sent flag and a date.) #502's Fix #1 removed the subject's `Student.id` from the anonymised address; nothing can remove the fact that the row changed.

The sharpest form is the #417/#418 decoy, and it discloses an identity rather than merely an existence. `inviteContact` derives that row's `delivered: false` from `link.linked`, which `rosterLinkState` computes from the guessed address itself — so the decoy sits on the subject's real address only when the teacher guessed right. `deleteStudentAccount` deletes the roster link in the same transaction as the rename, so the student leaving the directory and the guessed-address row renaming happen together, and the pair binds a named student on that teacher's roster to an address that student declined to share. That is the #417/#418 secret, arriving late.

The one candidate close — leave a never-delivered row alone, i.e. scope the anonymisation to `delivered = true` — is refused, and each of the counts below is sufficient alone:

- **`delivered` is not a decoy predicate** — see its row above for who writes it and when. A `false` there means neither "never delivered" nor "decoy": a teacher correcting a typo through `PUT /api/invitations/[id]` stamps it on an ordinary contact's row, so scoping erasure on that column would strand erased people's plaintext addresses on rows that were never decoys at all.
- **It aims the retention at the worst party.** In the blocked-re-invite case the address would stay readable forever by exactly the teacher that person refused, on a row only that teacher can act on: an `Invitation` is a teacher's CRM record, and while the subject can read it in their Art. 15 export, nothing gives them a way to clear it.
- **It closes only part of the oracle.** The three erasure statements carry no delivery scope, so a genuinely *delivered* pending row renames identically and confirms existence just as well. The scoping would pay a permanent, certain privacy cost for a partial fix.

The narrower variants of the same idea go the same way. Deleting the row rather than anonymising it buys nothing: a row vanishing is as visible as a row renaming, and it frees `(teacher_id, email)` exactly as the scrub already does — which is the #522 paragraph above, said from the other side. What a delete additionally destroys is the teacher's own filing state, and that, not the refusal, is the whole remaining reason this erasure anonymises. Scrubbing `email` while keeping the teacher's typed names changes nothing, the address being the loudest column. Deferring or batching the scrub to decorrelate its timing fails on the same fact that makes the residual tolerable at all: erasures are rare, so no practical delay window mixes enough of them to break the pairing channel above.

Sharpening the threat that way does not soften the verdict; it hardens it. The decoy's identity is confirmed only in the case where the teacher guessed *right* — which is exactly the case where option A would hand them permanent, on-demand read access to a confirmed-correct address, in place of a one-time correlation they have to be watching for. The sharper the leak, the worse the alternative to accepting it.

So the anonymisation stays unscoped, deliberately. What is left needs the subject to erase, which no teacher can trigger or provoke, and it is irreducible for a structural reason worth naming: the teacher holds standing read access to the row, so any durable mark an erasure leaves on it is a mark they can see. Splitting the teacher's display from the system's matching only relocates that — a display column holding what the teacher typed retains the address, and a scrubbed one changes under their eyes exactly as `email` does. `gdpr.test.ts` ("erasing a student anonymises the invitations that name them") pins the unscoped behaviour against rows shaped like both the `link.linked` decoy and the blocked re-invite, and pins that the erasure leaves `delivered` itself alone rather than laundering a decoy into a delivered-looking row.

Why the two resolve in opposite directions, given #520 filed them as the same shape: the retained `TeacherBlock` address is never read by a teacher-facing route, while the `Invitation` row option A would have spared is read by `GET /api/invitations` and the contacts page. Retained-and-unread-by-the-teacher is a different bargain from retained-and-readable: this section refuses the second, and #171 above accepts the first.

---

## Spaces

### Room (shared library)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| venue_name | string | e.g. "De Yogaschool", "Community Center West" |
| address | string | |
| city | string | |
| postcode | string | |
| floor | string | |
| room_name | string | |
| max_capacity | int | Venue's stated capacity |
| equipment | json[] | e.g. ["mats", "blocks", "straps"] |
| notes | text, nullable | |
| is_public | boolean | Visible to other teachers or private |
| *created_by* (FK) | → Teacher | |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

Base properties are read-only after creation. Changes via admin only. Duplicate detection covers `(address, floor, room_name)` normalized across case and whitespace via `lower(trim(...))` expression indexes: `Room_public_identity_unique` globally for shared rooms (`is_public = true`), and `Room_private_identity_unique` per teacher for private rooms (`created_by`, `is_public = false`) (#196, #260). Enforced at room creation and room publish time.

### TeacherRoom (per-teacher override)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *teacher_id* (FK) | → Teacher | |
| *room_id* (FK) | → Room | |
| capacity_override | int | Teacher's own cap (may be lower than venue max) |
| rental_rate | decimal | Private to each teacher, never shared |
| equipment_notes | text, nullable | |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

Each teacher sets their own capacity and rental rate for a room. Rental rate is private — never shown to other teachers using the same room.

---

## Classes

### ScheduleRule (shared calendar identity, #298)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *teacher_id* (FK) | → Teacher | |
| kind | enum: regular, studio | Pins which template family this rule belongs to. `ClassTemplate`/`StudioClassTemplate` attach by the composite `(schedule_rule_id, kind)`, so a `CHECK` on each child pins its own literal and the pair can only ever mean "regular child ↔ regular rule" |
| class_type | string | e.g. "Vinyasa", "Yin", "Hatha" |
| day_of_week | int (0-6) | 0 = Monday |
| start_time | time | |
| duration_minutes | int | |
| is_active | boolean | Teacher can pause/stop a recurring class |
| is_archived | boolean | |
| archived_at | datetime, nullable | When this rule was last archived |
| withdrawn_count | int, nullable | How many future unbooked instances that archive withdrew |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

One teacher, one slot, across both template families (#296, #298): an
`EXCLUDE USING gist` constraint over `(teacher_id, day_of_week, slot)` —
`slot` a generated range covering `[start_time, start_time +
duration_minutes)` — partial on `is_archived = false`, refuses two live rules
of either kind whose windows overlap for one teacher on one weekday. Range,
not exact-start: two templates a minute apart are no longer both legal, where
they were before #298. `ClassTemplate` and `StudioClassTemplate` below hold
only their own economics now — they reach their teacher, and everything
calendar-shaped, through this row.

### ClassTemplate (recurring class economics)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *schedule_rule_id* (FK) | → ScheduleRule, unique | The calendar identity — teacher, day/time, active/archived state — moved to the rule (#298); this row reaches Teacher through it, not directly |
| *teacher_room_id* (FK) | → TeacherRoom | |
| description | text, nullable | |
| **Economics** | | Copied to each instance at generation time — a later template edit does not re-copy (#194) |
| room_cost | decimal | From TeacherRoom.rental_rate |
| min_rate | decimal | Minimum teacher earns per student |
| target_rate | decimal | Ideal teacher earns per student |
| min_students | int | Below this, class auto-cancels |
| max_students | int | Registration cap |
| **Policies** | | |
| cancel_deadline | enum: 48h, 24h, 12h, 6h | Student cancellation window |
| auto_cancel_check | enum: 4h, 2h, 1h | When to check min_students threshold |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

Class instances are generated on a rolling 4-week basis. Runs indefinitely
until the rule is paused or archived — see ScheduleRule above for day/time,
active/archived state, and the cross-family slot rule.

### CalendarEntry (shared calendar identity, #327)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *teacher_id* (FK) | → Teacher | |
| kind | enum: regular, studio | Pins which entry family this row belongs to. `Class`/`StudioClass` attach by the composite `(calendar_entry_id, kind)`, so a `CHECK` on each child pins its own literal and the pair can only ever mean "regular child ↔ regular entry" |
| class_type | string | |
| date | date | |
| start_time | time | |
| duration_minutes | int | |
| cancelled_at | datetime, nullable | Liveness, for both families — one column where `Class.status = 'cancelled'` and `StudioClass.cancelled_at` used to be two spellings |
| class_completed_at | datetime, nullable | The owning class completed. Written only by the `class_sync_entry_completed` triggers, and write-once: `entry_completion_marker_guard` refuses every departure from a value it has set, because the schedule freeze reads this column and clearing it in one statement unfroze `date` in the next |
| *schedule_rule_id* (FK) | → ScheduleRule, nullable | Null for one-off entries. Unique with `date` |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

One teacher, one slot, across both entry families (#296, #327): an
`EXCLUDE USING gist` constraint over `(teacher_id, span)` — `span` a generated
`tsrange` covering `[date + start_time, date + start_time + duration_minutes)`
— partial on `cancelled_at IS NULL`, refusing two live entries of either kind
whose windows overlap for one teacher. Range, not exact-start: two entries a
minute apart are no longer both legal, and an entry running past midnight
conflicts with one on the following date.

A cancelled entry releases its SLOT but keeps its DATE: `(schedule_rule_id,
date)` is unique regardless of `cancelled_at`, so the hourly sweep does not
refill a date the teacher deliberately cancelled.

`Class` and `StudioClass` below hold only their own economics now — they reach
their teacher, and everything calendar-shaped, through this row.

**An entry with no child holds a slot nobody can see, and nothing in the schema
forbids one.** Every entry is meant to have exactly one child. There is no
totality constraint and that is deliberate (stage B design §8): what makes the
pair total is a property of the WRITERS — every creator writes parent and child
in one transaction, nested — not of the schema, and PostgreSQL has no way to
say "this row must be referenced" without a deferred constraint trigger per
child table. So the invariant is real, unenforced, and its violation is silent:
an orphan is visible on no page, reachable by no route and removed by no sweep,
while its live `span` goes on occupying
`CalendarEntry_teacher_slot_excl` for its teacher. The symptom is a
teacher — or a fixture — being refused a time that looks free.

Cheap to detect, expensive to diagnose from the symptom. Expect **zero rows**:

```sql
SELECT e.id, e.kind, e."teacherId", e.date, e."startTime", e."cancelledAt"
  FROM "CalendarEntry" e
 WHERE NOT EXISTS (SELECT 1 FROM "Class" c        WHERE c."calendarEntryId" = e.id)
   AND NOT EXISTS (SELECT 1 FROM "StudioClass" s  WHERE s."calendarEntryId" = e.id);
```

Both local databases held some when #327's whole-branch review ran — 8 of 37 in
`ethical_yoga`, 46 of 155 in `ethical_yoga_test`. All were test residue from a
teardown that deleted the CHILD and left the parent standing, the shape
`ca3418aa` fixed across ~25 suites; none appeared after it. If this query ever
returns rows again, look for a `class.deleteMany`/`studioClass.deleteMany`
where a `calendarEntry.deleteMany` belongs — deleting the entry cascades to the
child, and the reverse does not.

### Class (single class instance)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *calendar_entry_id* (FK) | → CalendarEntry, unique | The calendar identity — teacher, date/time, cancellation — moved to the entry (#327); this row reaches Teacher through it, not directly, and a generated class reaches its ClassTemplate through the entry's ScheduleRule |
| kind | enum: regular, studio | Always `regular` here, pinned by a `CHECK`; half of the composite FK above |
| *teacher_room_id* (FK) | → TeacherRoom | |
| description | text, nullable | |
| **Economics** | | Locked after first registration |
| room_cost | decimal | |
| min_rate | decimal | |
| target_rate | decimal | |
| min_students | int | |
| max_students | int | |
| **Policies** | | |
| cancel_deadline | enum: 48h, 24h, 12h, 6h | |
| auto_cancel_check | enum: 4h, 2h, 1h | |
| **State** | | |
| status | enum | draft → open → in_progress → completed. `full` is derived, not stored; cancellation is the entry's `cancelled_at`, not a member |
| settings_locked | boolean | Flips to true on first registration |
| spot_broadcast_at | datetime, nullable | When the first-come-first-claimed broadcast last went out for the seat that is currently free (#220) |
| **Calculated** | | Populated after class ends |
| effective_teacher_rate | decimal, nullable | What the teacher actually earned per student |
| total_students | int, nullable | Final attendance count |
| total_revenue | decimal, nullable | Sum of all student payments |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

### StudioClass (simple tracking)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *calendar_entry_id* (FK) | → CalendarEntry, unique | Same arrangement as `Class` above (#327): the calendar identity, cancellation included, lives on the entry |
| kind | enum: regular, studio | Always `studio` here, pinned by a `CHECK`; half of the composite FK above |
| location | string | Free text (not linked to Room) |
| student_count | int, nullable | |
| hourly_rate | decimal | Teacher's rate at this studio |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

No pricing engine. No individual registration. No link to Room or Student. No `status`. This is income tracking for classes the teacher gives at someone else's studio; the calendar half is the entry above.

---

## Bookings

### Registration (student ↔ class)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *class_id* (FK) | → Class | |
| *student_id* (FK) | → Student | |
| status | enum | registered → attended / no_show / late_cancel / cancelled |
| is_walk_in | boolean, default false | Added by teacher during class |
| tier_at_booking | int (1-5) | Snapshot of student's tier at booking time. Used for pricing. Also serves as income history. |
| **Calculated** | | Populated after class ends |
| price | decimal, nullable | Actual amount this student pays |
| tier_ratio | decimal, nullable | Multiplier applied to this tier |
| **Timestamps** | | |
| registered_at | datetime | |
| cancelled_at | datetime, nullable | |
| updated_at | datetime | |

**A booking that meets its student's erasure at the `Student` row is refused
if the erasure took the row first (#625).** `POST /api/registrations` and
`deleteStudentAccount` serialise on that row, for the student's own booking
and the teacher's roster add alike.

A booking that finds the profile erased writes nothing and answers 409
`STUDENT_ERASED`. A teacher sees `This student's account no longer exists.` A
student sees `This account has been deleted.` only when their request raced
the erasure. A self-booking made after the erasure committed never gets that
far: the erasure removed its session, so the request is answered 401 —
unless the account's live teacher profile kept the session, in which case it
survives but no longer resolves a student, and the request is answered 403
`Student access required`.

A booking that takes the row first commits, and the erasure then handles what
it wrote. If the class is still open and not cancelled, the erasure cancels
the registration and hands the freed seat to the waitlist hook, which promotes
the next student or broadcasts the seat unless the waitlist is frozen. A
teacher's walk-in into an `in_progress` class stays `registered`, as the
erasure keeps every in-progress registration. The erasure also deletes the
roster link and any waitlist entry the booking resolved. Among what it does
not undo is `resolveInvitationOnLink`'s work: a `TeacherBlock` it cleared stays
cleared, and an `Invitation` it resolved keeps its status, with its identity
anonymised.

The mechanism is `docs/lock-order.md`, "The `Student` row is the erasure's
gate".

### WaitlistEntry (overflow)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *class_id* (FK) | → Class | |
| *student_id* (FK) | → Student | |
| position | int | Queue order |
| status | enum | waiting → promoted / claimed / expired / removed |
| promoted_at | datetime, nullable | |
| *registration_id* (FK) | → Registration, nullable | Created when student is promoted or claimed |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

Hybrid waitlist promotion, anchored on class start (#236): until 1 hour before start, students are auto-promoted in queue order; in the final hour before start, it switches to first-come-first-claimed for any remaining spots; from start, the queue is frozen. An auto-promoted student can cancel free until the later of the cancel deadline and 15 minutes after promotion (`freeCancelUntil`, `src/lib/cancel-deadline.ts`) — a claimed spot gets no grace: the claim is the student's own act, and it always lands past the cancel deadline, so it is charged.

**Retention (#238):** an entry that never became a registration is deleted once
its class is terminal (`completed`/`cancelled`) and more than 365 days past its
`date`. "Never became a registration" is TWO clauses the sweep treats as
co-equal: `registration_id IS NULL` **and** a status outside
`FULFILLED_WAITLIST_STATUSES` (`promoted`, `claimed`). No writer can make the
two disagree, but deleting is irreversible, so their intersection is taken —
if they ever disagree, the row survives.

An entry that did become a registration is kept because the FK to
`Registration` makes it bookkeeping. That argument stands on the FK alone: a
`Payment` is created only by `completeClass`, so a fulfilled entry on a
**cancelled** class has a `Registration` and no `Payment`.
Swept daily by `reapClosedWaitlistEntries` (`services/waitlist-retention.ts`).

**`WaitlistEntry_waiting_position_key` (#183):** a hand-authored partial unique
index on `(classId, position) WHERE status = 'waiting'` — Prisma cannot express
the predicate, so the migration is raw SQL and the model carries a `///`
docblock naming it instead of a schema attribute. Immediate, not deferred:
every writer that touches a class's waiting positions does so under that
class's row lock, and each either renumbers downward (`reorderWaitingEntries`,
ascending by current position — read as `1..n`, the i-th of the class's
distinct positive positions is already ≥ i, so overwriting it with `i` in
ascending order never collides with a row the loop has not reached yet) or
appends at `max(position) + 1` (`addToWaitlist`). No writer ever produces a
transient duplicate, so nothing needs deferring to end-of-transaction. A
deferrable alternative exists — Postgres 16 accepts a partial `EXCLUDE USING
btree (...) WHERE (...) DEFERRABLE` — but a partial *unique index* cannot be
promoted to a constraint and so can never be made deferrable; that `EXCLUDE`
form would have been the only way to defer, and the immediate case above is
why reaching for it was unnecessary. Gaps are legal: a gap in the waiting
sequence still preserves promotion order, and gap-freedom is a cross-row
property no single-row constraint can express. The migration renumbers
existing `waiting` rows to `1..n` per class, ordered by `(position, createdAt,
id)`, before creating the index, and announces the affected count via `RAISE
NOTICE` so a repair on production data does not pass silently. It first takes
`SHARE ROW EXCLUSIVE` on the table, because the deploy keeps the old app
running while `migrate` runs, and an old-app queue write landing between the
renumber and the index build could fail the index with `23505` or deadlock
against the renumber — a failed deploy either way. Spiked before being
written (measured 2026-09-16 for #183): with an equivalent index applied by
hand, the unit tier (2095 tests) and the integration tier (711) passed with
zero violations, and a mutation forcing `addToWaitlist`'s `nextPosition` to
always be `1` failed 5 tests with `P2002` on `['classId', 'position']`.

**A join that races its own student's erasure is refused (#183).** The erasure
wins: `addToWaitlist` and `deleteStudentAccount` serialise on the `Student`
row, and a join that finds the profile erased — whether it waited for the
erasure or arrived after it — writes nothing and throws `WaitlistJoinError`
with reason `student_erased`, which `POST /api/waitlist` answers with 409. A
join that takes the row first commits, and the erasure then deletes the entry
and the roster link it wrote. It does not undo the rest of the join:
`resolveInvitationOnLink` may have cleared a `TeacherBlock` and resolved an
`Invitation`, and the erasure recreates no block and anonymises that
invitation's identity without reverting its status.
Refusal was chosen over the two alternatives. Deleting and re-scanning at the
end of the erasure would take class locks after the erasure's own writes —
`Class` after the rows below it in `docs/lock-order.md`'s order — and still
could not see a join that had not committed yet.
Accepting the join would leave an entry and a roster link for an erased
profile, and `promoteNext` could later turn that entry into a registration.
The mechanism — lock modes, order, and which writers are not gated yet — is
`docs/lock-order.md`, "The `Student` row is the erasure's gate".

---

## Payments

### Payment (per registration)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *registration_id* (FK) | → Registration | |
| amount | decimal | |
| status | enum | pending → paid / overdue / not_charged; paid and not_charged both reopen to pending |
| method | string, nullable | e.g. "cash", "bank_transfer", "mollie", "stripe" |
| processor_ref | string, nullable | External transaction ID (Level 2) |
| reminder_sent_at | datetime, nullable | |
| **Timestamps** | | |
| created_at | datetime | |
| paid_at | datetime, nullable | |
| not_charged_at | datetime, nullable | Set when the teacher waives the payment (grace policy) |
| updated_at | datetime | |

Level 1: teacher marks payment as received manually (cash, bank transfer). Level 2: automated via Mollie/Stripe payment links. Failed payment retry policy is an open question for Level 2.

`not_charged` is the grace-policy waiver (`docs/product-concept.md` §3): the teacher marks a post-completion payment as not collected, for the same class of case this app has no other exception mechanism for (a genuine emergency, lenience). It is post-completion only — early cancellation already produces no `Payment` row at all, since `completeClass` is the only place one is created.

---

## Communication

### Notification (inbox item)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| recipient_type | enum: teacher, student | Polymorphic — both share inbox infrastructure |
| *recipient_id* (FK) | → Teacher or Student | |
| type | string | See types below |
| title | string | |
| body | text | |
| *related_class_id* (FK) | → Class, nullable | |
| is_read | boolean, default false | |
| email_sent | boolean, default false | True when fallback email was triggered |
| created_at | datetime | |
| updated_at | datetime | |

Notification types: booking_confirmed, booking_cancelled, booking_removed, class_cancelled, payment_received, payment_request, waitlist_promoted, spot_available, spot_taken, reminder, announcement, teacher_invitation.

Rows are deleted by the daily `daily-cleanup` job once older than their type's retention period; the periods live in `NOTIFICATION_RETENTION_DAYS` (`src/lib/notification-retention.ts`) — `spot_available` and `spot_taken` keep 30 days, every other type keeps 365, and read state has no bearing on when a row is reaped. Deleting is safe because a notification row is the message about an event, never that event's record: the domain row the notification is about holds the record (for example `Payment`, `Registration`, `Invitation`, or the class's calendar entry), and no code reads a notification once it has aged out. There is no index on `createdAt`: the sweep's batch read filters on `(type, createdAt)`, which no index covers, so each daily run reads the table in full once for each retention period (the last, short batch of each period is a full scan), accepted because it runs once a day and the table stays bounded to about a year of rows, against an index maintained on every insert into the app's highest-write table.

Three-layer delivery: in-app notification (real-time) → in-app inbox (retained per type) → email (fallback for unread).

### Announcement (teacher → students)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *teacher_id* (FK) | → Teacher | |
| *class_id* (FK) | → Class, nullable | Null = broadcast to all teacher's students |
| message | text | |
| recipient_count | int | Snapshot of how many received it |
| sent_at | datetime | |

When sent, creates one Notification per recipient student. Class-scoped (specific class registrants) or teacher-wide (all students).

---

## Relationships

- Account → has one Teacher (optional)
- Account → has one Student (optional)
- Teacher → has many TeacherRooms
- Teacher → has many ScheduleRules
- ScheduleRule → has one ClassTemplate (kind: regular) or one StudioClassTemplate (kind: studio)
- Teacher → has many CalendarEntries
- CalendarEntry → has one Class (kind: regular) or one StudioClass (kind: studio)
- ScheduleRule → has many CalendarEntries (generated instances), unique per date
- Teacher → has many Announcements
- Room → has many TeacherRooms
- TeacherRoom → has many Classes
- Class → has many Registrations
- Class → has many WaitlistEntries
- Student → has many Registrations
- Student → has many StudentPrivacy records (one per teacher)
- Teacher → has many Invitations
- Teacher → has many TeacherBlocks
- Registration → has one Payment
- WaitlistEntry → has one Registration (when promoted)
- Announcement → creates many Notifications

---

## Design Notes

- **A `Teacher` hard-delete cascades through `ScheduleRule`, not directly to `ClassTemplate`/`StudioClassTemplate`** (#298) — one hop further out than `TeacherRoom`, whose `ClassTemplate_teacherRoomId_roomArchived_fkey` is `ON DELETE RESTRICT`. Measured in a rolled-back transaction against the real constraints: a single `DELETE FROM "Teacher"` still succeeds cleanly and every dependent row goes, because PostgreSQL defers a `NOT DEFERRABLE` foreign-key check to the end of the enclosing statement, and by then the sibling `ON DELETE CASCADE` from `Teacher` through `ScheduleRule` has already removed the `ClassTemplate`/`StudioClassTemplate` row the RESTRICT check would otherwise block on. That deferral is a property of one statement, not of the transaction: nothing in `src/` issues a hard `teacher.delete` today (erasure soft-deletes, per `deleteTeacherAccount`), but wherever tests tear a teacher down by hand across separate `deleteMany` calls, `scheduleRule.deleteMany` must run before `teacherRoom.deleteMany` — reversed, the `teacherRoom.deleteMany` hits the still-live `ClassTemplate`/`StudioClassTemplate` row and fails on `ClassTemplate_teacherRoomId_roomArchived_fkey`, measured the same way.
- **No production path deletes a `ClassTemplate` or `StudioClassTemplate` row** — archiving withdraws a template's future window and records what it withdrew (`archivedAt`/`withdrawnCount` on the rule), and a delete would destroy that record; `deleteTeacherAccount` archives rather than deletes for the same reason. The consequence lives one model out: `ScheduleRule` carries no foreign key back to either child, so a child deleted out from under an open transaction would leave an orphaned rule row that either shared compare-and-swap would still match — the archive's and the pause/resume's, `archiveOrUnarchiveRule` and `pauseOrResumeRule` (`rule-lifecycle.ts`), each serving both template families. That is why each of those takes the child row `FOR UPDATE` first and checks the returned row count rather than discarding it, and why `claimTemplateForGeneration` (`class-generator.ts`) may follow its lock with `findUniqueOrThrow`. Re-derive rather than trusting this sentence — `grep -rnE '(classTemplate|studioClassTemplate)\.(delete|deleteMany)\(' src --include='*.ts' | grep -v '\.test\.'` — no hits today; a first hit is the signal to revisit every site named here.
- **tier_at_booking** on Registration captures the student's income tier at the moment they booked. The student's global tier on the Student table can change anytime, but pricing uses the tier at booking time. This also serves as income history — no separate tracking table needed.
- **settings_locked** on Class flips to true when the first Registration is created. After that, economic fields (room_cost, min_rate, target_rate, min_students, max_students) are immutable.
- **Terminal status is the second, wider freeze** (#247). Once a Class is `completed` or `cancelled`, `updateClass` refuses every field edit — the class, not a column list — and `PUT /api/classes/[id]` answers 409. It never lifts. The entry's schedule is additionally frozen in the database by `entry_frozen_schedule_guard`, because the waitlist retention sweep above deletes on a terminality-plus-date predicate and reads that column before it does; since #327 it covers `date`, `start_time` and `duration_minutes`, all three of which moved to `CalendarEntry` together. `entry_terminal_liveness_guard` freezes `cancelled_at` beside it, for regular entries only — a studio cancellation is reversible — and `entry_completion_marker_guard` makes `class_completed_at` write-once, which is what stops the freeze being walked around in two statements: every one of these is `BEFORE UPDATE OF <columns>` and `UPDATE OF` fires on a column's presence in the SET list, so a guard reading `OLD` is only as immovable as the columns its `OLD` depends on. All three are narrower than the service on purpose, so the two layers are not the same rule twice, and all three decide from the entry's own columns (`cancelled_at`, `class_completed_at`) rather than reaching back for `Class.status` — see `docs/lock-order.md` for why that direction matters.
- **WaitlistEntry** is a separate entity from Registration to cleanly model the hybrid promotion rules. When promoted, a new Registration is created and linked via registration_id.
- **StudioClass** is intentionally disconnected from Room and Student entities. It's a simple log entry for the teacher's calendar and income reporting.
- **Notification** uses a polymorphic recipient (teacher or student) so both user types share the same inbox infrastructure.
- **rental_rate** on TeacherRoom is private to each teacher — never exposed to other teachers using the same room.
- **Authentication** hangs off the Account entity: one Account per human owns the authenticated email, sessions, and passkeys. Teacher and Student are profiles optionally linked to it, each holding at most one LIVE profile per account — enforced by the partial unique indexes `Teacher_account_live_unique` and `Student_account_live_unique` (`ON ("accountId") WHERE "deletedAt" IS NULL`) — a dual-role person (a teacher who attends classes) has one account with both profiles. Student.account_id is nullable, but nothing creates a new unclaimed Student any more (#166): a CRM contact is an Invitation until accepted, and accepting requires an already-signed-in account. The nullable column and the claim-on-first-authenticate path only still serve pre-existing unclaimed rows created before that change. Profile email fields are denormalized copies set at link time.
- **The `20260916165852_live_profile_unique_per_account` migration's own header cites `20260811202634_teacher_slot_unique_indexes` as its precedent for `prisma migrate diff` not seeing a partial index** — correction recorded here because the migration file is immutable. That precedent no longer holds as stated: `20260811202634` declared six partial indexes, and the four SLOT ones among them are gone — folded into `ScheduleRule_teacher_slot_excl` (#298) and `CalendarEntry_teacher_slot_excl` (#327), see `docs/lock-order.md`. The live precedent is `Room_private_identity_unique` (#196, updated in #260 to `lower(trim(...))` expression keys) — one of the two `Room` identity indexes that migration also created, neither of which has since been dropped or folded into anything else.
- **Both `accountId` columns lost their plain btree index when `Teacher_accountId_key`/`Student_accountId_key` were dropped for the partial indexes above.** `Teacher_account_live_unique`/`Student_account_live_unique` cover only `WHERE "deletedAt" IS NULL`, so a predicate on `accountId` without that clause seq-scans — including Postgres's own referential-integrity check when an `Account` row is hard-deleted. Production never hard-deletes an `Account`, and both `gdpr.ts` liveness reads carry the `deletedAt` filter, so the affected callers today are test teardowns and `prisma/seed.ts`.
- **Email is lowercase everywhere** (#170). All six email columns — Account,
  Teacher, Student, MagicLinkToken, Invitation, TeacherBlock — carry a
  `CHECK (email = lower(email))` constraint. `emailField` in `src/lib/schemas.ts`
  normalises everything arriving over HTTP; anything else (seed, GDPR
  anonymisation, psql) is rejected rather than rewritten. Before this, the plain
  btree unique keys under `en_US.utf8` made `Foo@x.com` and `foo@x.com` two
  distinct identities: sign-in silently missed, and signup could create a second
- **Invitation and TeacherBlock** (#166) exist because a teacher may not link a student unilaterally. `POST /api/students` creates only an Invitation; the TeacherStudent link forms when the invitee accepts it or books a class. Declining leaves the Invitation row itself as a tombstone against re-inviting, and both ways of saying no — declining, and unlinking after being linked — write a TeacherBlock as well, so the two "no" states are uniform. The two rows do different jobs: the Invitation row is what makes a re-invite answer DECLINED, the TeacherBlock is what makes one undeliverable, and only the block survives the subject's own erasure (#522 — see the TeacherBlock section above).
- **Room identity is case- and whitespace-insensitive** (#260). PostgreSQL expression indexes `Room_public_identity_unique` (on `(lower(trim(address)), lower(trim(floor)), lower(trim(roomName))) WHERE isPublic = true`) and `Room_private_identity_unique` (on `(createdById, lower(trim(address)), lower(trim(floor)), lower(trim(roomName))) WHERE isPublic = false`) enforce uniqueness without modifying teacher-entered text in the database. Client-side predicate `sameRoomIdentity` (`src/lib/room-identity.ts`) mirrors this normalization using `normalizeRoomField`, and `isUniqueConflictOn` (`src/lib/unique-conflict.ts`) unwraps decompiled expression targets so route handlers continue matching standard column lists.

## Open Questions

- How to handle failed payments in Level 2? Retry policy? (parked for later)
