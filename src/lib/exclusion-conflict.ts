import { Prisma } from '@prisma/client';

/**
 * True when `err` is a PostgreSQL 23P01 raised by the exclusion constraint
 * named `constraint`.
 *
 * Matched on the message rather than on `err.code`, because Prisma has no
 * mapped error for an exclusion violation: it arrives as
 * `PrismaClientUnknownRequestError` with `code` and `meta` both `undefined`.
 * That is why this is a separate predicate from `isUniqueConflictOn`
 * (`./unique-conflict`), which gates on `P2002` and cannot see this at all.
 *
 * Both the SQLSTATE and the constraint name are required, so a message that
 * merely quotes a name does not match.
 */
export function isExclusionConflictOn(err: unknown, constraint: string): boolean {
  if (!(err instanceof Prisma.PrismaClientUnknownRequestError)) return false;
  return err.message.includes('23P01')
    && err.message.includes(`exclusion constraint \\"${constraint}\\"`);
}
