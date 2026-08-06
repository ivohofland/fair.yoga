import type { Prisma } from '@prisma/client';

/**
 * Takes the `Class` row lock with a bounded wait.
 *
 * `tx`'s type carries an extra `{ $transaction?: never }` brand on top of
 * `Prisma.TransactionClient`, and that brand is load-bearing, not
 * decorative: `Prisma.TransactionClient` is `Omit<PrismaClient,
 * ITXClientDenyList>`, and `Omit` only drops members from the *type* — a
 * bare `PrismaClient` still has every one of them at runtime, so it remains
 * structurally assignable to `Prisma.TransactionClient` with no cast. Passing
 * one in would compile cleanly and fail silently: on a bare `PrismaClient`
 * each statement is its own autocommit transaction, so `SET LOCAL` and `FOR
 * UPDATE` would each apply to a transaction that no longer exists by the time
 * the caller's next statement runs, protecting nothing. A real interactive
 * transaction client has no `$transaction` method at all (that is what
 * `ITXClientDenyList` removes), so `$transaction?: never` costs it nothing;
 * `PrismaClient` has one, and a method is never assignable to `never`, so
 * `lockClassRow(prisma, classId)` — the full client — is now a compile
 * error: `Argument of type 'PrismaClient<...>' is not assignable to
 * parameter of type 'TransactionClient & { $transaction?: undefined; }'`.
 * Verified directly: a throwaway call site passing the bare client failed
 * `tsc --noEmit` with exactly that error before this brand was added, and
 * compiled clean after.
 *
 * `SET LOCAL` scopes the timeout to the calling transaction: it governs
 * every statement left in that transaction, not just the `FOR UPDATE`
 * immediately below it, and resets on `COMMIT` or `ROLLBACK` regardless of
 * how the transaction ends — the same effect `studio-class-template-
 * lifecycle.ts` documents around its own `SET LOCAL lock_timeout`. In
 * `completeClass` that also caps the `registration.update` / `payment.create`
 * loop that follows, which is harmless — those never wait on a lock. Verified
 * in psql that a second `SET LOCAL lock_timeout` later in the same
 * transaction simply overwrites the first rather than erroring or stacking,
 * so calling this helper more than once per transaction is safe on that
 * axis. It is not free on every axis: a caller that calls it in a loop puts
 * each iteration's own lock wait under the same 2s cap inside a transaction
 * Prisma itself caps at 5s by default, so a handful of contended iterations
 * can exhaust the transaction's whole budget well before any single one of
 * them hits its own timeout. `deleteStudentAccount` (`gdpr.ts`) is exactly
 * this caller, added in #174 Task 5 — its call site sizes the erasure
 * transaction's own `timeout` to the number of classes it is about to lock
 * rather than trusting the 5s default; the arithmetic lives there, not
 * here.
 *
 * 2s matches the two template-claim sites (`class-generator.ts:140`,
 * `studio-class-generator.ts:31`) — the only other bounded lock waits in the
 * codebase.
 *
 * Five pre-existing `FOR UPDATE` sites deliberately do NOT use this and keep
 * their inline SQL: four in `waitlist.ts` (`addToWaitlist`, `promoteNext`,
 * `claimSpot`, `withdrawWaitingEntriesForTeacher`), one in `POST
 * /api/registrations`. All five take an unbounded wait, which is #104's
 * subject, and retrofitting them from here would blur what that issue is
 * accountable for. This helper takes the bound instead because not every
 * caller that will end up sharing it can afford an unbounded one:
 * `deleteStudentAccount`'s erasure transaction is time-bound by GDPR's own
 * clock, and an unbounded block there on a row the 60-second transitions
 * sweep can hold would hang a legally time-bound operation. That caller
 * landed in #174 Task 5. The three call sites this issue's plan intended for
 * this helper all exist: `completeClass` below was the first,
 * `removeFromWaitlist` (`waitlist.ts`) picked it up next, and
 * `deleteStudentAccount` (`gdpr.ts`) — called once per class it is about to
 * renumber — was the last of the three. A fourth arrived afterward, outside
 * the plan: `autoCancelClasses` (`class-transitions.ts`), added by #174 Task
 * 6's round 1 review once moving its registration count inside the
 * transaction turned a CAS-only decision into one that reads more state
 * under the lock. Not the only callers this helper exists to serve, either:
 * nothing about it restricts it to these four.
 *
 * Must be given a transaction client for the lock to have anywhere to live —
 * see the brand paragraph above for what enforces that at compile time.
 */
export async function lockClassRow(
  tx: Prisma.TransactionClient & { $transaction?: never },
  classId: string,
): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
  await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
}
