# Private classes (#910)

A teacher can mark a class, or a recurring class template, **private**. A
private class is left off the teacher's public schedule (`/[slug]`). Anyone
holding its booking link (`/[slug]/book/[classId]`) can book it as they would
any other class. It is an ordinary class that isn't listed, and nothing about
pricing, lifecycle, the waitlist, walk-ins, auto-cancel or the slot constraint
changes.

Use cases: a private session for one student or a small group, a make-up
class, a trial for a few people, a class for a workshop group or a company.

## What the issue said, and what was measured

| #910 claim | Measured |
|---|---|
| The booking page only checks that the class is `open` and not cancelled | **Incomplete.** `book/[classId]/page.tsx:59-65` also returns 404 when `teacher.pageSlug !== slug` or the teacher is deleted. The link needs the right slug as well as the id. |
| `/[slug]` is the only place a student finds a class | **Holds.** Its `prisma.class.findMany` (`[slug]/page.tsx:57-61`) is the only listing query that reaches non-teachers. There is no sitemap, robots file, ICS feed, OpenGraph metadata, embed or digest. No `NotificationType` announces a new or published class, and the generator and `transitionClass` send nothing. `/api/classes` and `/api/classes/[id]` are `requireTeacher`. `/bookings` lists only the student's own registrations and waitlist entries. |
| Class ids are UUIDv4 | **Holds.** `Class.id @default(uuid())`, and the booking URL carries `Class.id`. |
| Q2: "Booking already respects blocks (check this); a private link mustn't become a way around one" | **Wrong premise.** `TeacherBlock` is the *student's* standing refusal of a teacher, not a teacher's ban on a student. No such ban exists. A booking or a waitlist join is the student's own act, and by design it lifts their block (#418, `docs/data-model.md`, "What a student's own act resolves"). A blocked student who books from a forwarded link is withdrawing their own refusal. Nothing to guard. |
| Q3: the final-hour broadcast only reaches the queue | **Holds.** `handleSpotFreed` reads `waitlistEntry` rows `where: { classId, status: 'waiting' }` (`waitlist.ts:1098`). |
| "Send to students" can reuse the announcement picker | **Not as-is.** The announcement schema forbids `classId` with `studentIds` (`schemas.ts:791-798`), and `listAnnouncementAudience` includes only students with a past registration. Dropped from this issue by decision, see below. |
| (not in the issue) | Class detail already has a **Share booking link** button (`(overview)/page.tsx:267-269`), but it shares the teacher's page `/{slug}`, not the class. On a private class, that link opens a schedule that doesn't show the class. |

## Decisions

1. **Link-only access.** Whoever holds the link can book. No allow-list table,
   no new refusal on the booking page, registration POST, waitlist join or
   claim. A forwarded link works for whoever receives it. That's accepted,
   because booking is consent and capacity and pricing still apply. It also
   works for people the teacher hasn't added yet, which is the trial-class
   case.
2. **No share token.** `Class.id` is a UUIDv4 and the URL also needs the slug,
   which is enough for "unlisted". Follows from 1.
3. **Sharing is copy/share only.** The teacher shares the link through the
   phone's share sheet (WhatsApp, Signal, mail) or the clipboard. No in-app
   "Send to students" in this issue: no new `NotificationType`, email copy or
   audience query. That fits "teachers use external tools for community". It
   becomes a follow-up only if teachers ask for it.
4. **The share button shares the class's own booking link, on every bookable
   class**, public or private.
5. **`isPrivate` is never locked.** It isn't in `LOCKED_FIELDS`, on a `Class`
   with registrations or on a `ClassTemplate` with generated classes. The lock
   exists so a student's price basis and slot can't move under them. Making a
   class private takes nothing from someone already booked (their registration,
   price and `/bookings` entry are untouched), and making it public only lists
   it.
6. **Templates stamp it, as they stamp everything else (#194).**
   `ClassTemplate.isPrivate` is copied onto each class the generator creates.
   Changing it on the template changes no class that already exists. The
   template form tells the teacher so, and since the flag is never locked, the
   teacher can always change those classes one by one.

## Design

### Data

- `Class.isPrivate Boolean @default(false)` and
  `ClassTemplate.isPrivate Boolean @default(false)`, one migration per table,
  each in the commit that adds the column: `ClassTemplate`'s partition pin
  fails the build until a new column is classified, so the column and its
  classification land together. Every
  existing row backfills to `false`, so nothing that is listed today stops
  being listed.
- Child-side only, not `CalendarEntry` or `ScheduleRule`. The parents hold
  what both entry families share (#327, #298), and only the `Class` family has
  a public listing. `StudioClass` has no booking page.
- `CLASS_GENERATOR.createChildren` (`class-generator.ts`) stamps `isPrivate`
  from the template in its explicit `createMany` object literal.
- Class create and update and template create and update accept `isPrivate`
  through their zod schemas (`src/lib/schemas.ts`). `updateClass`'s terminal
  freeze still applies, as for every field: a completed or cancelled class
  refuses the edit. That costs nothing, because a terminal class isn't listed.
- `docs/data-model.md` gains both columns.

### Hiding

- `[slug]/page.tsx`'s listing query adds `isPrivate: false`.
- The booking page allows exactly what it does today. For a private class it
  also:
  - sets `robots: { index: false }` metadata, so a link posted somewhere public
    isn't indexed;
  - shows a quiet caption under the class details: "Shared by link — not on
    {teacher first name}'s public schedule." This tells the student why they
    won't find it on the schedule, and that they can come back to it from
    `/bookings`.

### Teacher UI

- A **Private class** checkbox with helper text: "Not listed on your public
  page. Anyone with the link can book." It's a native checkbox in the codebase's
  existing pattern (`edit-room-form.tsx`: `w-5 h-5 accent-teal` in a 44px
  label row). There is no switch primitive and this adds none. Placement:
  - **Create wizard** (`new-class-form.tsx`): last field of step 3
    *Policies*, after Auto-cancel check. It's a rule about who reaches the
    class, beside the other booking policies. Step 4 *Review* echoes it as a
    row ("Listed on your public page" / "Private — link only").
  - **Template form** (`template-form.tsx`): after Auto-cancel check, the
    same position relative to the same fields.
  - **Class edit form** (`class-edit-form.tsx`): after the Economics block,
    before Save. It is never disabled by `settingsLocked`, and it stays in the
    payload when the form strips the locked keys.
- **Share link on class detail.** `ShareBookingLink` takes the URL path it
  shares instead of building `/{slug}` itself. The two call sites:
  - Class detail passes `/{slug}/book/{classId}`, with share title "Book
    {class title}". Shown when the class is `open` and not cancelled, and the
    class has not started (the start instant, via `classStartInstant`, not the
    status: the `open → in_progress` sweep trails the clock by up to a minute).
  - In `draft`, class detail shows the caption "Publish to share the link"
    instead, because the booking page returns 404 until the class is open.
  - `getting-started.tsx` keeps sharing `/{slug}`.
- **Schedule card.** `ClassCard` shows a plain `Private` word in its caption
  line (`type-caption`), beside the room. No badge: status badges encode time.
  The teacher's own schedule shows private classes as before. Hiding them
  there is out of scope.
- **Template edit.** When a save changes `isPrivate`, the form shows one line
  next to its existing notices: "Classes already on your schedule keep their
  own setting." The form knows the template's loaded value, so this needs no
  server change.

### Testing

- **Integration:**
  - `/[slug]` leaves out a private open class and lists a public one.
  - The booking page renders a private class, with `noindex` and the caption.
  - `POST /api/registrations` books a private class.
  - Toggling `isPrivate` on a class with registrations succeeds, where an
    economic edit on the same class answers `SETTINGS_LOCKED`.
  - A template with `isPrivate: true` generates private classes.
  - Flipping a template's flag leaves its already-generated classes' flags
    unchanged.
- **Component:**
  - `ShareBookingLink` shares the path it is given, through the share sheet,
    the clipboard fallback and the copy-by-hand fallback. It has no test file
    today.
  - Class detail shows Share for an open future class, the draft caption for a
    draft, and nothing once the class has started.
  - The `Private` label on `ClassCard`.
  - The template form's notice appears only when the flag changed.
- **Each guard broken on purpose to prove it fails**, with the error text
  recorded in the PR body:
  - drop the `isPrivate: false` filter;
  - drop the generator stamp;
  - add `isPrivate` to `LOCKED_FIELDS`;
  - make class detail share `/{slug}` again.

## Out of scope

- Hiding a private class from the teacher's own schedule.
- Password-protected classes, allow-lists and share-token rotation (decision
  1).
- In-app "Send to students" (decision 3).
- The booking page showing a just-started class as bookable for up to one
  sweep interval. The registration POST refuses on the clock
  (its start-instant check, 409 `CLASS_NOT_BOOKABLE`), so nobody is
  booked into a started class. That stays as is. The share button above is
  based on the start instant so it doesn't add to the gap.
