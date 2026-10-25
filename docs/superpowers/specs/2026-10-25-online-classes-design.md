# Online classes — design (#911)

## Intent

Many independent teachers teach some classes online, or run an online version
of a weekly class. Today they fake an "Online" room to create one, and the
form then asks a room cost that does not apply. This lets a `Class` or
`ClassTemplate` be **online**: no room, an optional video link (Zoom, Jitsi,
Meet — never recognised by provider), and a link that only registered
students ever see.

Pricing needs no change: `total = (room_cost + effective_teacher_rate) × (1 +
VAT%/100)` with `room_cost = 0` is already the right answer for an online
class. The work is in the schema, the room-assuming readers, the forms, and
getting the link to the right people at the right moment.

## Goals

- A teacher can create an online one-off class and an online template, and the
  template stamps online classes.
- A registered student gets the link in the app and by email, at booking,
  in the class reminder, on waitlist promotion, and whenever it is added or
  changed.
- Nobody who is not registered — public visitors, the booking page before
  booking, waitlisted students — can see the link, in rendered HTML or in any
  JSON a page or route returns.

## Non-goals

- **Hybrid** (a room *and* a stream). Considered and deliberately dropped: it
  is not a form change but an economics change — online students would share a
  room cost they do not use, one `maxStudents` cannot mean both "room seats"
  and "stream seats", registrations would need an attendance mode, and
  waitlist, auto-cancel and billing would each need a rule per mode. It may
  never be a teacher-level feature at all. **Not filed** (owner's decision).
  The enum below is the hook if it ever comes: adding a member makes every
  exhaustive `switch` name the places that need a decision.
- Separate online / in-person reporting.
- Provider detection, link previews, embedding a call.
- `StudioClass` — already roomless and untouched.

## Anti-goals

- A placeholder link sent to students because a form forced one. The link is
  never required; a missing link is nagged about, never blocked.
- The link leaking through a public page's props or a JSON payload even when
  the visible HTML hides it.

## Premise check (what the issue got right and wrong)

Measured at `64ac841c`.

- **`Class_live_needs_open_room` and its template twin do not need rewriting.**
  The issue said they would. Both room foreign keys are `MATCH SIMPLE`
  (`pg_constraint.confmatchtype = 's'` for
  `Class_teacherRoomId_roomArchived_fkey` and
  `ClassTemplate_teacherRoomId_roomArchived_fkey`), so a row with a NULL
  `teacherRoomId` is not checked against `TeacherRoom` at all, and
  `NOT (live AND roomArchived)` holds whenever `roomArchived` is false. What is
  needed is that a roomless row *cannot* carry `roomArchived = true` — folded
  into the shape CHECK below.
- **No email or notification carries a location today.** The issue's
  "included in the class reminder and in the booking confirmation" is new
  content, not an extension. `booking_confirmed` is an inbox row emailed by
  the fallback sweep; the reminder body is built in `class-reminders.ts`.
- **No server-side check ties `maxStudents` to room capacity** — only the two
  create forms clamp to `capacityOverride`. Online loses nothing there; the
  server bound stays `MAX_CLASS_SIZE`.
- **No "class changed" notice to booked students exists.** The link notice
  below is the first.
- `room-switch.ts`, `room-archive.ts`, `room-deletion.ts` find rows by
  `teacherRoomId`, so online rows fall out of them unchanged. Confirm with a
  test each rather than by reading.
- About nine places dereference `teacherRoom` on a class or template and would
  throw on null (the census is in the PR body, with its command); three are
  student/public pages, one is the publish refusal in `class-lifecycle.ts`.

## Decisions

### Data

- New enum `ClassFormat { in_person, online }` on `Class.format` and
  `ClassTemplate.format`, default `in_person`, so every existing row is
  unchanged by the migration.
- `teacherRoomId` becomes nullable on both. `roomCost` stays a required
  `Decimal` — an online row stores `0`.
- New `videoUrl String?` on both.
- One hand-authored CHECK per table (`Class_format_shape`,
  `ClassTemplate_format_shape`):
  - `in_person` ⇒ `teacherRoomId IS NOT NULL AND videoUrl IS NULL`
  - `online` ⇒ `teacherRoomId IS NULL AND NOT roomArchived AND roomCost = 0`
  
  The CHECK does **not** require `videoUrl` for online — that is timing, not
  shape, and lives in the UI as a nudge.
- `*_live_needs_open_room` and the composite foreign keys are left exactly as
  they are.
- `CLASS_GENERATOR.createChildren` copies `format` and `videoUrl` like every
  other stamped field.

### One projection, so readers cannot forget

A single function in `src/lib/` turns a class or template row into a
discriminated union — `{ format: 'in_person', room } | { format: 'online',
videoUrl: string | null }` — with an exhaustive `switch` and `never` default,
throwing on a row that violates the shape CHECK. Every former `teacherRoom`
dereference consumes the union instead. A second, **public** projection type
has no `videoUrl` member at all, and the public and pre-booking pages are typed
to accept only it, so passing the link there is a compile error, not a review
catch.

### Link visibility

Shown to: the teacher (class detail, template detail, edit forms), and a
student **with a live registration** on that class.

- Student surfaces: under `/bookings` only — the session-gated student area.
  The public booking page `(public)/[slug]/book/[classId]` renders only the
  public projection, booked or not, so the compile-time guard covers that
  whole file; a booked student there is pointed to their booking. *My call.*
- Public `/[slug]`, the booking page, and waitlisted students see "Online",
  never the link.

**The link is never stored in a notification** (owner's decision, option A of
three — body text and a new `Notification` column were the others). A
`Notification` row is only `title` and `body`; a URL there is not clickable in
the inbox, shows raw on a lock screen, and sits in the inbox for a year — which
matters when a teacher replaced the link *because* it leaked. Instead:

- The inbox row names the class and opens the student's booking under
  `/bookings`, where the link is a real button.
- The **email** for the link-bearing types renders the class's **current**
  `videoUrl` as a button at send time, and only when the recipient still holds
  a live registration on that class. A stale or leaked link is therefore never
  emailed after it was replaced, and two quick edits produce two emails that
  both carry the corrected link — no coalescing needed.
- **Push** shows the line, never the URL.

Link-bearing types: `booking_confirmed` (booking, and a claimed spot),
`waitlist_promoted`, `walk_in_added`, the class reminder (inbox and email), and
the new link notice below. For an online class without a link yet, these say
the teacher will share it before class.

### When the link is set

The link is optional everywhere, settable until the class is terminal
(completed or cancelled) — including while `in_progress`, because a broken link
discovered at the start time is the case that matters most, and `updateClass`
already allows `in_progress` edits. *My call.*

- **Template:** its link (if any) is stamped onto each generated class. A
  template is a stamp, not a live link (#194, #284), and **the link is no
  exception** — editing a template's link changes only classes generated
  afterwards (owner's decision). The edit's answer tells the teacher that
  already-scheduled classes keep their current link, in the same shape as the
  existing first-effective-week answer.
- **Class:** set or replaced on the class itself, booked or not. `videoUrl` is
  **not** a `LOCKED_FIELDS` member.
- **A missing link is nagged, never blocked:** publishing does not require
  one; the class detail shows "No video link yet" in attention gold; the
  teacher's own class reminder says the link is missing; a registered student
  sees that the teacher will share the link before class.

### The link notice

A new `NotificationType` member, sent to students with a live registration —
not the waitlist — whenever a class's `videoUrl` goes from one value to
another, including from null. "Added" and "changed" are the same notice; that
is what keeps a link added after the student's reminder already went out from
being missed. It is an essential message (always emails) and joins
`IMMEDIATE_EMAIL_TYPES`, not the 30-minute fallback, since a link changed
shortly before class is useless half an hour later. It is sent on every change,
during the class too. Clearing the link sends nothing.

### Locks

Format may not change once a class is booked (owner's decision). Today
`updateClass` accepts no room field at all; whether the edit form gains a
pre-booking format switch is left to the builder (below) — either way, a
booked class's `format` (and room) is immutable, refused with 409
`SETTINGS_LOCKED`. A template's format is freely editable: it reaches only
future classes.

### Validation

`https://` only, no userinfo, length-bounded — the rules `parsePaymentLink`
(`src/lib/payment-link.ts`) already applies, query strings (Zoom's `?pwd=`)
included. Generalise that parser rather than writing a second; the payment link
keeps its behaviour.

A body whose fields contradict its format — `in_person` with a `videoUrl`,
`online` with a room or a non-zero room cost — is refused with a 400 by the
request schema (a discriminated union on `format`), never silently corrected.
*My call.*

### Forms

Class and template forms get a Room / Online choice. Online hides the room
picker and the room cost field and shows an optional video link field. The
max-students copy stops talking about the room when online — *builder's
call on wording*. The pricing preview/breakdown omit the room line for an
online class rather than showing "Room 0.00" — *my call*.

The template's link field carries helper text warning that the link is stamped
onto every class (owner's request; wording may be polished):

> Every class from this template gets this link. Use one that works each week,
> like a personal meeting room. If you make a new link for each class, leave
> this empty and add it to each class instead.

The one-off class form needs no such warning; its helper text says the link is
shown only to registered students. A generated class stamped with an empty link
gets the same "No video link yet" nudge as any other.

## Constraints

- Migration hand-edits the two CHECKs into the generated SQL, following
  `prisma/migrations/20260721061528_student_claim_link_check/`. Prose about
  the migration goes in `docs/`, not in the SQL (CLAUDE.md, Comment
  Discipline).
- Every new refusal carries a registered code (`src/lib/api-error-codes.ts`).
- Prove each guard bites: the two CHECKs (each arm), the public-projection
  compile error, the link-absent-from-public-HTML/JSON test, the waitlisted
  student not seeing the link.
- Update `docs/data-model.md` and the CLAUDE.md data-model bullets.

## Left to the builder

- Notification type name and copy; push-group membership of the new type.
- Whether the class edit form offers a pre-booking format switch (needs a
  room picker / link field swap) or format is fixed at creation like the room
  is today. Both satisfy the lock.
- Where exactly the "No video link yet" nudge sits on class detail and how the
  teacher's class reminder words it.
- Whether `room-switch`, `room-archive`, `room-deletion` need any code change
  at all, decided by a test per service with an online row present.
