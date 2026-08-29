import { log } from './log';

/**
 * Issue 328's condition, turned into an alarm at the two places it currently
 * renders as something else.
 *
 * WHAT 328 IS. `CalendarEntry.scheduleRuleId` is the only single-column edge
 * into a kind-discriminated parent: the other four foreign keys reaching
 * `ScheduleRule` or `CalendarEntry` go `(parentId, kind) -> (id, kind)`, so a
 * family's children can only hang off that family's parents. This one carries
 * no `kind`, and it cannot simply be widened — the edge is `ON DELETE SET
 * NULL`, which on a composite key nulls every referencing column including the
 * `NOT NULL` `kind`. `CalendarEntry.scheduleRuleId`'s own comment in
 * `schema.prisma` carries the full argument and the reason PostgreSQL 16 could
 * express the fix while Prisma's schema language cannot.
 *
 * WHY IT NEEDS A DETECTOR RATHER THAN ONLY A TICKET. What keeps the edge sound
 * today is a property of the one generator both families run
 * (`generateEntriesForRule`, `services/entry-generation.ts`): it takes
 * `scheduleRuleId` from a template row it already holds, so the rule's `kind`
 * is already pinned to the entry's. That property expires the moment anything
 * sets the column WITHOUT routing through a template: a backfill, an import, a
 * repair script, a future family. And the state it produces is INVISIBLE: a studio entry
 * pointing at a regular rule finds no `studioClassTemplates`, so both readers
 * below render "no template" — which is exactly how a legitimately manual
 * studio class renders. The teacher sees a plausible page, the operator sees
 * nothing, and the row's `(scheduleRuleId, date)` pair goes on holding a date
 * against a sweep that will never fill it.
 *
 * A live rule id with no template of the asking family can mean nothing else.
 * `StudioClassTemplate` is never deleted — archiving withdraws its window and
 * records what it withdrew — and dropping a `ScheduleRule` cascades its
 * templates away while setting this column back to NULL, so the id and the
 * template disappear together. A surviving id with no template is a rule of the
 * OTHER kind.
 *
 * `error`, not `warn`: this is a state the schema declares impossible, and the
 * point of the line is that somebody looks. It costs nothing while the
 * condition is unreachable, and it fires per read rather than once — which is
 * the correct trade for a state whose whole problem is that it never announces
 * itself.
 */
export function reportRuleKindMismatch(
  site: string,
  entry: { id: string; scheduleRuleId: string | null },
  template: { id: string } | null,
): void {
  if (entry.scheduleRuleId === null || template !== null) return;
  log.error(
    { site, calendarEntryId: entry.id, scheduleRuleId: entry.scheduleRuleId },
    'calendar entry carries a schedule rule of the other family (issue 328); it renders as a manual class',
  );
}
