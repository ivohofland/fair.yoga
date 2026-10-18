import { pgErrorOf } from '@/lib/pg-error';

/** The unique indexes `isUniqueConflictOn` may be asked about: its `names` parameter is typed by this list, and `pg-error.test.ts` holds each member to `pg_indexes`. */
export const UNIQUE_CONSTRAINTS = [
  'Account_email_key',
  'CalendarEntry_scheduleRuleId_date_key',
  'Invitation_teacherId_email_key',
  'Registration_classId_studentId_key',
  'Room_private_identity_unique',
  'Room_public_identity_unique',
  'Student_account_live_unique',
  'Student_email_key',
  'Teacher_account_live_unique',
  'Teacher_email_key',
  'Teacher_pageSlug_key',
  'TeacherRoom_teacherId_roomId_key',
  'WaitlistEntry_waiting_position_key',
] as const;
export type UniqueConstraintName = (typeof UNIQUE_CONSTRAINTS)[number];

/**
 * True when `err` carries a Postgres unique violation (`23505`) on one of
 * `names`, whether it arrived as a typed P2002, a raw P2010 or a bare
 * `DriverAdapterError`.
 *
 * Matched by name because two tables can share a column set and only the
 * name tells them apart: `Student.email` and the `Account.email` a ticket
 * signup inserts in the same statement are both `email`. A name is also the
 * only whole identity an expression index reports. Where the name comes
 * from, and what the adapter's other fields hold: `docs/technical-architecture.md`,
 * "Database errors".
 *
 * A name match is narrower than a column match: a collision on a name the
 * caller did not list falls past it. What that costs depends on the catch.
 * One that rethrows hands it to `classifyApiError`'s 409 fallback; one that
 * refuses it as unrecognised answers 500.
 *
 * When a caller has no use for telling two names apart, it lists both and
 * answers them alike. When a caller does need to tell two models' collisions
 * apart and cannot from their names, the fix is consolidating the keys, not
 * this matcher, as the slot keys are one exclusion constraint
 * (`exclusion-conflict.ts`).
 */
export function isUniqueConflictOn(err: unknown, names: readonly UniqueConstraintName[]): boolean {
  const pg = pgErrorOf(err);
  return (
    pg !== null &&
    pg.sqlState === '23505' &&
    pg.constraint !== undefined &&
    (names as readonly string[]).includes(pg.constraint)
  );
}
