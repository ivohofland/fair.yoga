# Auto-cancel judges a class once, at its check time (#836)

## Problem, as measured

`autoCancelClasses` (`src/services/class-transitions.ts`) runs every minute and
cancels any open, live class whose instant falls inside `inCancelWindow` — from
`start − autoCancelCheck` until `start` — and whose count over
`ACTIVE_REGISTRATION_STATUSES` is below `minStudents`. The check is a window, not
a moment: every tick re-judges the class until it starts.

`late_cancel` is not in `ACTIVE_REGISTRATION_STATUSES` (it frees the seat) but is
in `CHARGED_STATUSES` (`src/services/class-lifecycle.ts`). So a class sitting at
exactly its minimum at the check time is auto-cancelled on a later tick when one
student cancels late — possibly minutes before the start. The late canceller
would have paid; an auto-cancel bills nobody.

The premise in #836 holds. Where it came from: `docs/product-concept.md` has
defined the "Auto-cancel check (4/2/1h before class)" as a check since Phase 1
(`98746df6`); the sweep implemented it as a continuous window.

## Rule

An open class is judged **exactly once**, at its check time
(`start − autoCancelCheck`):

- **Survives** when its count over `CHARGED_STATUSES` is at least `minStudents`.
  Late cancellations count: they are charged, so they are in the price, and the
  teacher loses nothing by running the class.
- **Cancelled** otherwise, exactly as today — same notifications, waitlist
  closed, no charges.

Either outcome is final. A class that survived its check is never auto-cancelled
afterwards, whatever happens to its registrations, and a class below its
minimum at the check does not get the chance to recover later.

Both settings stay: `cancelDeadline` decides who pays when they cancel;
`autoCancelCheck` decides when the class is judged. The concept already requires
the check to sit inside the deadline (`docs/product-concept.md`, "Auto-cancel
time must be shorter than the cancellation deadline"), which is why `late_cancel`
rows can exist at the check.

## The marker

`Class.autoCancelDecidedAt DateTime?` (nullable),
added by a migration with no backfill. Non-null means the
auto-cancel decision is made and the sweep never selects the class again.

Rejected alternative: keep the window and count `CHARGED_STATUSES`. The count
can still fall after the check — an auto-promoted student inside their 15-minute
grace cancels as `cancelled`, not `late_cancel` — so a class could still be
cancelled minutes before its start. That makes the bug rarer, not gone.

No backfill: a class already inside its window when this deploys is judged on
the next tick, as it would have been today.

## Who stamps it

1. **The sweep.** It selects open, live classes with `autoCancelDecidedAt IS NULL`
   whose check time has passed and whose start has not. Under the existing
   `lockClassRow` transaction it counts `CHARGED_STATUSES` and either cancels
   (as today) or stamps the marker. The stamp is inside the same transaction as
   the count, so a concurrent registration cannot land between them. The
   cancel CAS also requires `autoCancelDecidedAt IS NULL`.

   The sweep's registration-count pre-filter goes. It existed so a healthy
   class did not take a lock every minute of its window; a healthy class
   must now be stamped, which needs the lock, and after that one transaction
   it is never selected again. The window pre-filter stays.

2. **A teacher's write that puts an undecided open class past its check time.**
   The teacher chose to run the class inside its own window, so the class counts
   as already judged (agreed in brainstorming, option A). Otherwise the next
   tick would cancel it within a minute, usually with zero students. The writers
   that can do this:
   - `transitionClass` `draft → open` — publishing a class whose check time has
     passed.
   - The class generator (`class-generator.ts`), which inserts `open` rows
     directly. A new template's first candidate can fall inside its window, and
     the generator may insert a class whose start has already passed.
   - `updateClass` moving `date` or `startTime` on an undecided open class so
     that its check time is now behind it.

   `POST /api/classes` creates `draft` rows and is not a writer of this state.

   All three use one helper, `isPastCancelCheck(entry, cls, timezone, now)`,
   which shares its check-time arithmetic with `inCancelWindow`. There is one
   spelling of "check time".

## Edits after the decision

A class's `cancelDeadline` and `autoCancelCheck` are fixed when it is created:
`updateClassSchema` (`src/lib/schemas.ts`) is `.strict()` and accepts neither,
so they cannot change on a class at all — stricter than the `settingsLocked`
freeze on `ECONOMIC_FIELDS`, which starts at the first registration. On a
template they are editable, but a template is a stamp and never touches classes
it already made. So the only edit that moves a class's check time is a schedule
edit.

A decided class stays decided. Moving it later does not clear the marker: reopening the decision would bring back the very
late cancellation this issue removes. An **undecided** class follows its
current schedule, because its check time is computed from the live row on every
tick.

## Copy and docs

- `autoCancelHint` (`src/lib/class-options.ts`, from #834) already describes a
  single check. Add that late cancellations count because they still pay. #834
  is open on `feat/cancellation-setting-hints`; this change lands on top of it,
  or the sentence follows it if this PR merges first.
- `docs/product-concept.md` — the auto-cancel check is a single decision;
  late cancellations count toward the minimum; publishing inside the window
  skips the check.
- `docs/data-model.md` — the new column on `Class`.
- The race comment in `autoCancelClasses` — the `DELETE`/`PUT` arguments are
  about which statuses the count includes. With `late_cancel` counted, a racing
  `DELETE` writing `late_cancel` no longer changes the count, and a racing one
  writing `cancelled` can only lower it. Rewrite the comment to state what is
  true now.

## Testing

- Sweep (`class-transitions.test.ts`, beside the existing auto-cancel tests):
  - at exactly the minimum at the check, then one registration becomes
    `late_cancel` → stays open on the next tick, marker set;
  - below the minimum at the check → cancelled;
  - `late_cancel` rows count toward the minimum at the check;
  - a decided class whose count later falls (a free `cancelled` in the grace
    window) is not cancelled;
  - a class published inside its window is never cancelled;
  - an `updateClass` edit moving the check time behind `now` stamps the marker;
  - the generator stamps a class it inserts past its check time, and leaves one
    still ahead of it unstamped.
- Each guard is shown to bite: remove the marker filter, the stamp, or the
  `late_cancel` count and record the failing test.

## Out of scope

- Studio classes have no auto-cancel.
