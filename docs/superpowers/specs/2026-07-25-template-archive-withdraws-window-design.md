# Archiving a template withdraws its unbooked window

**Date:** 2026-07-25
**Status:** Approved (issue #86; design agreed with Ivo in discussion — pause vs
archive semantics, the deletion rule, and the two confirmation messages)

## Problem

Archiving a `ClassTemplate` sets `isArchived: true, isActive: false` and stops
generation. It does **nothing** to the classes the template already generated.

Those instances are created `status: 'open'` (`class-generator.ts`), and the
public booking page filters on `status: 'open' && date >= today` — **nothing
anywhere consults the template**. So archiving leaves up to four weeks of
classes publicly bookable for a recurring class the teacher has shelved.

Issue #86 framed this as "a later edit silently reprices still-bookable
classes". That framing was wrong, and the correction matters because it changes
the fix:

- Template edits already skip anything a student has touched.
  `syncTemplateInstances` defines mutable as
  `!settingsLocked && (draft|open) && date > now`.
- So the edit-propagation only ever affects **unbooked** classes — which is what
  editing a *live* template does too, and is reasonable.

The disease is that **archive doesn't touch the window**; the edit-propagation
is a symptom. Fix the first and the second stops mattering, because there is
nothing left to propagate to.

## The model

Pause and archive currently differ only by a flag: both stop generation, neither
touches the window. That makes archive close to cosmetic. Giving each a distinct
effect on the window is what makes them mean different things:

| State | Generates? | Existing window | Meaning |
|---|---|---|---|
| **Active** | yes | bookable | running |
| **Paused** (`isActive: false`) | no | **untouched** | "skip a while" — you may resume |
| **Archived** (`isArchived: true`) | no | **unbooked future classes deleted; the rest stand** | "done" |

This extends a line the codebase already draws in three places — `settingsLocked`,
`syncTemplateInstances`' mutability filter, and `deleteTeacherAccount`'s
cancel-and-notify. All key on **student contact**: before a booking an instance
is an offer the template made; after, it is a commitment that stops being
template-managed. Booked classes therefore survive archiving untouched — the
teacher shelved a recurring *pattern*, not their obligation to people who booked.

## What counts as "unbooked"

**A future class is deletable when it has no registration in a charged status.**

`CHARGED_STATUSES = ['registered', 'attended', 'no_show', 'late_cancel']`
(`class-lifecycle.ts`). A registration with status `cancelled` does not count —
nobody is affected and nothing is owed, so a class everyone cancelled out of
*is* deleted.

Two rules were considered and rejected:

- **`settingsLocked: false`** — the rule `syncTemplateInstances` uses. Rejected:
  `settingsLocked` answers *"may I still change the price?"*, which stays "no"
  forever because someone booked at a tier. *"Is anyone affected if I delete
  this?"* is a different question. Reusing the flag would leak an implementation
  detail into user-visible behaviour — a class everyone cancelled would survive
  archiving for reasons the teacher cannot see.
- **No *active* registrations** — the literal reading.
  `ACTIVE_REGISTRATION_STATUSES = ['registered', 'attended', 'no_show']`
  **excludes `late_cancel`**, and `Registration.class` is `onDelete: Cascade`.
  A student cancelling past the deadline on a future class gets `late_cancel`,
  explicitly *"still charged"* (`registrations/[id]/route.ts`). Deleting such a
  class would cascade away a billable record. Charged-status is the same
  intent without the money loss.

**Scope:** `date > now`, `status` in `draft`/`open`. The `> now` boundary matches
`syncTemplateInstances`, whose comment reads *"a class hours from starting should
not shift under its students"* — if that holds for editing a class it holds more
strongly for deleting one.

## Confirmation messages

Both actions currently `router.push('/settings/recurring')` on success, so the
teacher is bounced to the list with no account of what happened. Instead the
buttons confirm **in place** and `router.refresh()`, leaving the teacher on the
page for the thing they changed.

**Pause:**

> No new classes will be added to your schedule. The last one still scheduled is
> **Thursday 12 June, 09:30**.

with no future classes:

> No new classes will be added to your schedule. Nothing from this template is
> currently scheduled.

**Archive:**

> Classes on the schedule without bookings are now deleted. There are still
> **3** classes on the schedule — cancel them individually if needed.

the three empty states:

- deleted > 0, remaining 0 — *"Classes on the schedule without bookings are now
  deleted. Nothing from this template is scheduled any more."*
- deleted 0, remaining > 0 — *"No unbooked classes to delete. There are still 3
  classes on the schedule — cancel them individually if needed."*
- both 0 — *"Nothing from this template was scheduled."*

**Un-archiving** deletes nothing and needs no message; it keeps its current
behaviour of leaving the template paused rather than live.

## Studio templates

Same shape, one simplification: `StudioClass` carries no registrations at all
(*"disconnected from Room/Student — pure calendar + income tracking"*), so every
future studio class is deletable and `remaining` is always 0. The archive
message therefore only ever needs its "nothing left" form:

> Deleted **4** scheduled studio classes. Nothing from this template is
> scheduled any more.

Pause behaves identically to the class family.

## Design

**Services own the logic** (`CLAUDE.md`: routes are thin wrappers). Both PATCH
handlers currently inline their updates.

`src/services/class-template-lifecycle.ts` gains:

```ts
export type PauseTemplateResult = {
  template: ClassTemplate;
  /** The furthest-out class still scheduled, for the pause message. */
  lastScheduled: { date: Date; startTime: string } | null;
};

export type ArchiveTemplateResult = {
  template: ClassTemplate;
  /** Future, unbooked classes removed. */
  deleted: number;
  /** Future classes left standing because they carry charged registrations. */
  remaining: number;
};

export async function pauseOrResumeTemplate(
  db: PrismaClient, templateId: string, teacherId: string,
): Promise<PauseTemplateResult | { ok: false; reason: 'not_found' | 'forbidden' | 'archived' }>;

export async function archiveOrUnarchiveTemplate(
  db: PrismaClient, templateId: string, teacherId: string,
): Promise<ArchiveTemplateResult | { ok: false; reason: 'not_found' | 'forbidden' }>;
```

Exact result shapes are the plan's to settle; what this spec fixes is that the
route returns `deleted`/`remaining`/`lastScheduled` alongside the template, and
that the deletion happens in a service rather than a handler.

The archive delete and the template update go in **one transaction** — a
half-applied archive would leave the template shelved with its window still
bookable, which is the exact state this change exists to prevent.

A parallel `studio-class-template-lifecycle.ts` does the same for the studio
family. The two are deliberately not shared: #92 found that these families had
already drifted apart in their guards, and a premature abstraction over two
models with different registration semantics is how that happens again.

**Route:** both PATCH handlers become thin wrappers returning the service result.

**UI:** `toggle-template-button.tsx`, `archive-template-button.tsx` and their two
studio counterparts render the confirmation in place, replacing
`router.push(...)` with `router.refresh()`. Copy lives in the components, not the
API — English-first, and the API returns numbers rather than sentences.

## Testing

**Service unit tests** are where the deletion rule belongs, because the rule is
the thing most likely to be got wrong:

- deletes a future class with no registrations;
- deletes a future class whose only registrations are `cancelled`;
- **keeps** a future class with a `late_cancel` registration — the money case;
- keeps a future class with a `registered` one;
- keeps today's class (`date > now` boundary);
- keeps past classes;
- counts `remaining` as exactly the kept future ones;
- pause deletes nothing and reports the furthest-out class.

**Integration** on both PATCH routes: archive returns `deleted`/`remaining`;
pause returns `lastScheduled` and leaves the window intact; the ownership and
`409`-on-activate-archived guards from #92 still hold.

**A regression test for the original bug:** after archiving, a class from that
template is no longer returned by the public booking page's query
(`status: 'open' && date >= today`). This is what #86 is actually about, and it
is the assertion that would fail if someone later "optimised" the deletion away.

Each guard verified by reverted mutation, and — per the lesson from #66 — each
mutation asserted to have applied inside the function under test before its
result is trusted.

## Out of scope

- **Cancelling booked classes on archive.** They stand; the message tells the
  teacher to cancel individually. Bulk-cancel-with-notification is a bigger
  feature and belongs with the cancellation flow.
- **Restoring the window on un-archive.** Un-archiving leaves the template
  paused; explicit activation regenerates through the normal sweep.
- **#83's write/sync atomicity.** Separate seam, separate issue.

## Risks

- **Deletion is irreversible.** Mitigated by the charged-status rule (nothing
  billable is ever removed), the `date > now` boundary, and the transaction. The
  service tests pin each boundary rather than the aggregate.
- **Cascade reach.** Checked against `prisma/schema.prisma` rather than assumed,
  because a `Restrict` anywhere would make the delete fail at runtime instead of
  doing what this spec says:

  | Relation | On class delete | Consequence |
  |---|---|---|
  | `Registration.class` | **Cascade** | only `cancelled` rows, by the deletion rule |
  | `Payment.registration` | **Cascade** | none in practice — payments are created at completion, and these are future classes |
  | `WaitlistEntry.class` | **Cascade** | queue for a class nobody can now book |
  | `Notification.relatedClass` | **SetNull** | notification history survives, unlinked |
  | `Announcement.class` | **SetNull** | announcement survives, unlinked |

  Nothing restricts, so the delete succeeds. Nothing billable is reachable: the
  only registrations that can cascade are `cancelled`, which by definition are
  not charged. Worth an explicit test rather than a one-time reading — the
  cascade behaviour is a schema property that a later migration could change
  without anyone revisiting this file.
