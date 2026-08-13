/**
 * Class capacity — the one implementation of "how many seats are left".
 *
 * "Full" is derived, never stored (`class-lifecycle.ts`), so every path that
 * hands out or announces a seat has to ask this question itself. Before this
 * module there were five such paths and each asked in its own words; one —
 * the final-hour waitlist broadcast — forgot to ask at all, which is #212.
 */
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';
import type { TransactionClientOnly } from '@/lib/db-locks';

/** A class's seat position at one instant. `freeSeats` may be negative. */
export interface SeatCount {
  maxStudents: number;
  activeCount: number;
  /**
   * `maxStudents − activeCount`. NOT clamped at zero: walk-ins deliberately
   * exceed `maxStudents` (`POST /api/registrations`), so a negative value is
   * a real state describing how overbooked a class is. Callers test `<= 0`,
   * and a clamp added later would silently change what all of them mean.
   */
  freeSeats: number;
}

/**
 * Counts the seats left in a class, from the caller's transaction.
 *
 * **Precondition: the caller must already hold the `Class` row lock.** Without
 * it this is a snapshot with no meaning — a registration committing a
 * millisecond later makes the answer wrong, which is exactly the defect this
 * module exists to fix. Every caller takes that lock first: four via their own
 * inline `SELECT … FOR UPDATE` (the sites `db-locks.ts` reserves for #104),
 * the waitlist broadcast via `lockClassRow`.
 *
 * This function deliberately does NOT take the lock itself. Doing so would
 * retrofit `lockClassRow`'s bounded 2s wait onto those four pre-existing
 * sites, which `db-locks.ts` reserves for #104 — "retrofitting them from here
 * would blur what that issue is accountable for."
 *
 * It reads the class rather than accepting one, so a caller cannot compare a
 * freshly-locked count against a `maxStudents` it read BEFORE taking the lock.
 * That half-locked comparison is the subtle version of the bug, and this
 * signature makes it unrepresentable. The extra read is one PK lookup on a row
 * the transaction already holds locked.
 *
 * The `TransactionClientOnly` brand rejects a bare `PrismaClient` at compile
 * time (see `db-locks.ts` for how the brand works). It cannot check that the
 * caller actually took the lock — nothing in TypeScript or Postgres can — so
 * the precondition above is a review obligation, not a guarantee.
 */
export async function readSeatCount(
  tx: TransactionClientOnly,
  classId: string,
): Promise<SeatCount> {
  const cls = await tx.class.findUniqueOrThrow({
    where: { id: classId },
    select: { maxStudents: true },
  });

  const activeCount = await tx.registration.count({
    where: { classId, status: { in: [...ACTIVE_REGISTRATION_STATUSES] } },
  });

  return { maxStudents: cls.maxStudents, activeCount, freeSeats: cls.maxStudents - activeCount };
}
