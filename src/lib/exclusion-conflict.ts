import { Prisma } from '@prisma/client';

/**
 * True when `err` is a PostgreSQL 23P01 raised by the exclusion constraint
 * named `constraint`.
 *
 * Matched on the message rather than on `err.code` alone, because Prisma has
 * no mapped error for an exclusion violation. That is why this is a separate
 * predicate from `isUniqueConflictOn` (`./unique-conflict`), which gates on
 * `P2002` and cannot see this at all.
 *
 * TWO ERROR SHAPES CARRY THE SQLSTATE, and both are admitted rather than
 * only the one a typed call produces: a whole-repo census of what writes a
 * table raw is not a claim this repo can keep honest, and it was false once
 * already when it was made that way.
 *
 *   1. A typed model call — `PrismaClientUnknownRequestError` with `code` and
 *      `meta` both `undefined`; the SQLSTATE and constraint name survive only
 *      in `message`, escaped as `\"…\"`.
 *   2. A raw query — `PrismaClientKnownRequestError` with `code: 'P2010'`;
 *      the SQLSTATE is spelled `` Code: `23P01` `` and the constraint name
 *      appears unescaped, quoted by Postgres itself.
 *
 * Both shapes are reached. Shape 1 is what a typed model call produces;
 * shape 2 is what a raw statement produces, and
 * `src/services/calendar-entry.test.ts` takes that path for every
 * `CalendarEntry_teacher_slot_excl` refusal it asserts — those cases write
 * that table raw precisely so the database, not the Prisma client, is what
 * answers.
 *
 * Both the SQLSTATE and the constraint name are required in either shape, so
 * a message that merely quotes a name does not match.
 */
export function isExclusionConflictOn(err: unknown, constraint: string): boolean {
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return err.message.includes('23P01')
      && err.message.includes(`exclusion constraint \\"${constraint}\\"`);
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2010') {
    return err.message.includes('Code: `23P01`')
      && err.message.includes(`exclusion constraint "${constraint}"`);
  }
  return false;
}
