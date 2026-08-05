import type { Prisma } from '@prisma/client';

/**
 * Takes the `Class` row lock with a bounded wait.
 *
 * `SET LOCAL` scopes the timeout to the calling transaction, so it is
 * released with it. 2s matches the two template-claim sites
 * (`class-generator.ts:140`, `studio-class-generator.ts:31`) — the only other
 * bounded lock waits in the codebase.
 *
 * The five pre-existing `FOR UPDATE` sites deliberately do NOT use this and
 * keep their inline SQL: three in `waitlist.ts`, one in
 * `withdrawWaitingEntriesForTeacher`, one in `POST /api/registrations`. All
 * five take an unbounded wait, which is #104's subject, and retrofitting them
 * from here would blur what that issue is accountable for. The three sites
 * added by #174 take the bound because one of them
 * (`deleteStudentAccount`'s reorder loop) runs inside the erasure
 * transaction, where an unbounded block on a row the 60-second transitions
 * sweep can hold would hang a legally time-bound operation.
 *
 * Must be given a transaction client. On a bare `PrismaClient` each statement
 * is its own transaction, so the lock would be released before it was useful
 * and `SET LOCAL` would apply to nothing.
 */
export async function lockClassRow(
  tx: Prisma.TransactionClient,
  classId: string,
): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
  await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
}
