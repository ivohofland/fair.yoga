# Record what archiving withdrew

**Date:** 2026-07-28
**Status:** Approved (issue #97; design agreed with Ivo in discussion — the
record lives on the template, not in the notification feed)

## Problem

Archiving a template permanently deletes its future unbooked classes and reports
what it removed only as transient React state:

```tsx
setMessage(resolveTemplateConfirmation(data) ?? '');
```

Close the tab, navigate away, or refresh, and the count is gone. There is no way
— for the teacher, or for anyone helping them later — to answer *"how many
classes did archiving remove, and when?"* The deletion is irreversible; the
record of it survives one render.

## Why not a Notification

Issue #97 proposed persisting a `Notification` inside the archive transaction,
on the precedent of `autoCancelClasses` and `completeClass`, which both do
exactly that. Two things found while designing say otherwise.

**Teachers have no email opt-out.** `email-fallback.ts:57` looks up a teacher's
address and leaves `emailEnabled` at `true`; only students pass through
`shouldEmailStudent`. So a `Notification` of any type reaches the teacher by
email once it has gone 30 minutes unread — an email telling them what they did
half an hour earlier. Suppressing that means adding a third concept to
`notification-policy.ts`, which today has exactly two axes: **whether** (consent,
students only) and **when** (age, or a class starting inside the urgent window).

**And no existing notification is a receipt for the recipient's own action.**
`booking_confirmed` tells a teacher a student booked. `payment_received` tells
them money arrived. `class_cancelled` tells someone their class is off. Every
type is something that happened *to* the recipient. A self-action receipt would
be the first of its kind, and it would raise the gold unread dot on the Inbox
tab for a click the teacher just made — which sits badly beside `CLAUDE.md`'s
"No attention economy patterns — this is a tool, not an engagement platform."

The precedent also reads differently on inspection. `autoCancelClasses` and
`completeClass` notify because **someone else needs to know** — students whose
class was cancelled, or who now owe money. Neither is a receipt; both are
messages to people who were not in the room. Archiving affects only the teacher
who did it.

## Design

### 1. Two nullable columns per template model

```prisma
model ClassTemplate {
  // …
  archivedAt      DateTime?
  withdrawnCount  Int?
}
```

and the same pair on `StudioClassTemplate`. Both nullable: `null` means no
archive recorded itself, which is every existing row and the correct answer for
them. Not the same as "never archived" — see the `isArchived` bullet under
Risks for the bulk path that archives without writing either column.

Written inside the archive transaction, alongside the flag flip and the delete,
so a record that says three classes were withdrawn is a record three classes
were actually withdrawn. Un-archiving clears both back to `null` — a template
that is no longer archived has no withdrawal to report, and leaving a stale
count on it would be worse than having none. (Not a *live* template: the same
write forces `isActive: false`, so what is standing there is paused.)

Re-archiving overwrites. That is deliberate: a teacher asking "what did
archiving remove?" is asking about the archive that is in force, not a history
of every archive this template has had. A full history is an audit-log feature
and this is not one.

### 2. `remaining` is not persisted

Only `deleted` is unrecoverable, so only `deleted` is stored. `remaining` — the
future classes still on the schedule for this template — is returned once, by
the archive PATCH, into the transient confirmation message shown right after
the click. Nothing persists it and no page recomputes it on load. Freezing it
in a column would be worse than not having it: a teacher who cancels one of
those survivors individually afterwards would keep reading a count that was
accurate for one afternoon in June. Computing it at render time would be
truthful, and is a thing this design does *not* do — if a later change wants
the number on the page, it queries for it there rather than reviving a column.

This is why the column is `withdrawnCount` rather than a pair. Naming it after
what it records, not after the confirmation message that first exposed it, keeps
the next reader from assuming `remaining` was forgotten.

### 3. Rendered where the question is asked

`settings/recurring/[id]` already loads the template and renders its archive
button. An archived template gains a line there:

> Archived 12 Jun 2026 · 3 classes withdrawn

with the count omitted when `withdrawnCount` is `0`, since "0 classes withdrawn"
answers a question nobody asked and reads like a failure. Templates archived
before this ships have `archivedAt: null` and render nothing — no invented
history, no "unknown" placeholder.

The year is not decoration, and it needs its own formatter. `formatDayHeader`
omits the year, which is right for the schedule it was written for; a record
meant to survive indefinitely cannot borrow that format without losing the
ability to tell last year from this one. Worth stating precisely, because the
tempting shorthand is false: `formatDayHeader` is *not* only for upcoming
dates — `(student)/bookings` uses it for the "Past classes" section and for
bank-transfer remittance strings. That is arguably a place the year is missing
too, but it is not this change's to fix.

The studio detail page gets the same treatment. The two archived *list* pages
are deliberately untouched: a list is for finding the thing, and one line per
row about a past deletion is noise at that level.

### 4. The transient confirmation stays

The message shown immediately after clicking is not replaced. It is the right
medium for "here is what just happened" — the persisted line is for "what
happened last time I was here." Both exist in the codebase already for other
things; this change adds the second, it does not trade one for the other.

## Testing

**Service tests**, where the write belongs, for both families:

- archiving sets `archivedAt` and `withdrawnCount` to the number actually
  deleted, in the same transaction as the delete;
- the count matches `deleted` exactly — including the today-spared case where a
  class survives, so the two numbers differ;
- un-archiving clears both to `null`;
- re-archiving overwrites with the new count rather than accumulating;
- a template that never had unbooked classes records `withdrawnCount: 0`, not
  `null` — the distinction between "archived and removed nothing" and "never
  archived" is the whole point of the nullability.

**Component tests** for the rendered line, in the `components` project added by
#99: the line appears for an archived template with a count, is absent for a
live one, and omits the count when it is `0`.

**Mutation-verified**, and per the #66 lesson each mutation is confirmed to have
applied inside the function under test before its result is trusted. The
load-bearing mutation is writing `withdrawnCount` outside the transaction, or
from the pre-delete count rather than the delete's own result: the "matches
`deleted` exactly" test must fail.

## Out of scope

- **A general audit log.** One event does not justify a table, and the design
  above answers the question this issue actually asks.
- **History across multiple archives.** Re-archiving overwrites, per §1.
- **Backfilling templates archived before this ships.** Their `archivedAt` is
  `null` and the UI shows nothing. Inventing a timestamp would be worse than
  admitting the record starts now.
- **The two archived list pages**, per §3.
- **Any change to `notification-policy.ts`.** The reason this design avoids the
  notification path is precisely to avoid needing one.

## Risks

- **A migration on two tables.** Both columns are nullable with no default and
  no backfill, so the migration is additive and cannot fail on existing rows.
- **`withdrawnCount` can drift from reality** if a future change deletes classes
  on some other path without updating it. Mitigated by the column being written
  only in the one transaction that does the deleting, and by the service test
  asserting the two agree — but it is a denormalised count, and denormalised
  counts are a category that rots. If a second deletion path ever appears, this
  column needs revisiting rather than extending.
- **`isArchived` does not imply `archivedAt`.** GDPR erasure archives every
  template of an erased teacher in bulk (`src/services/gdpr.ts:360`) and writes
  no record, so those rows carry `isArchived: true` with both new columns
  `null`. Harmless — the teacher is gone and the detail page unreachable — and
  the component's `if (!archivedAt) return null` keeps it invisible. Recorded
  because the tempting invariant is false: this is a second *archiving* path,
  distinct from the second *deletion* path the bullet above anticipates.
- **Un-archive clearing the record** means a teacher who un-archives loses the
  note of what the previous archive withdrew. That is correct — those classes
  are still gone, but the template is live again and the line would be
  misleading — yet it is a real loss of information, and worth stating rather
  than discovering.
