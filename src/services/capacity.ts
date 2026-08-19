/**
 * Class capacity — the one implementation of "how many seats are left", and of
 * "is this class full".
 *
 * "Full" is derived, never stored (`class-lifecycle.ts`), so every path that
 * hands out or announces a seat has to ask this question itself. Five write
 * paths ask it: `addToWaitlist`, `promoteNext`, `claimSpot` and the final-hour
 * broadcast (`waitlist.ts`), and `POST /api/registrations`. Four asked in their
 * own words; the broadcast forgot to ask at all, which is #212.
 *
 * **Not the only seat arithmetic in the codebase, and the exception is worth
 * naming.** Two public booking pages —
 * `(public)/[slug]/page.tsx` and `(public)/[slug]/book/[classId]/page.tsx` —
 * derive their own `isFull` from an already-fetched registration list, to
 * render a badge. They are reads with no lock, no transaction and no write to
 * protect, so routing them through a transaction-only helper would buy nothing;
 * they are display, not decision. Named here because this docblock is otherwise
 * read as "every capacity question in the repo comes through this module".
 */
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';
import type { TransactionClientOnly } from '@/lib/db-locks';

/**
 * A class's seat position at one instant.
 *
 * `readonly` throughout: nothing accepts a `SeatCount` as input today, so a
 * forged or mutated triple has nowhere to flow — but the three fields are
 * mutually constrained (`freeSeats === maxStudents - activeCount`), the type
 * cannot express that, and `readonly` is the free half of the fix. The sibling
 * constant `CHARGED_STATUSES` is frozen for the same reason.
 */
export interface SeatCount {
  readonly maxStudents: number;
  readonly activeCount: number;
  /**
   * `maxStudents − activeCount`. NOT clamped at zero: walk-ins deliberately
   * exceed `maxStudents` (`POST /api/registrations`), so a negative value is a
   * real state describing HOW overbooked a class is.
   *
   * The reason is information, not behaviour — an earlier version of this
   * comment claimed "a clamp added later would silently change what all of
   * them mean", and that is false: under `Math.max(0, …)` every caller
   * evaluates identically, because `isFull` is the only thing any of them
   * reads and `0` and `-1` are both `<= 0`. What a clamp destroys is the
   * magnitude, which no caller reads today and `capacity.test.ts` is the sole
   * defender of.
   */
  readonly freeSeats: number;
  /**
   * `freeSeats <= 0` — the question every caller actually asks, defined here
   * and nowhere else.
   *
   * This field exists because the module's first version unified the *count*
   * and left the *predicate* written out five times, four as `freeSeats <= 0`
   * and one inverted as `freeSeats > 0`. A sixth site written `< 0` compiles,
   * reads like its neighbours, and admits one student into a class at exactly
   * `maxStudents` — which is the shape of #212 itself. Four of this branch's
   * eight recorded mutations (M5-M8) were that off-by-one at four separate
   * sites; with the boundary here there is one place to get it wrong and one
   * mutation that proves it.
   */
  readonly isFull: boolean;
}

/**
 * Counts the seats left in a class, from the caller's transaction.
 *
 * **Precondition: the caller must already hold the `Class` row lock.** Without
 * it this is a snapshot with no meaning — a registration committing a
 * millisecond later makes the answer wrong, which is exactly the defect this
 * module exists to fix. Every caller takes that lock first: all five write
 * paths named above now go through `lockClassRow` (`db-locks.ts`).
 *
 * This function deliberately does NOT take the lock itself. Taking it here
 * would not close the gap that matters — nothing would stop a caller from
 * holding the lock on a DIFFERENT class and passing this one's id, since the
 * brand only rejects a bare client and proves no more than that. That gap is
 * #219's, not this one's; see the precondition paragraph below for the
 * options on file to close it structurally.
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
 * the precondition above is a review obligation, not a guarantee. **#219** is
 * the filed decision on making it structural (a `ClassLock` token, or taking
 * the lock in the read here); until it lands, this docblock is the enforcement.
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

  const freeSeats = cls.maxStudents - activeCount;
  return { maxStudents: cls.maxStudents, activeCount, freeSeats, isFull: freeSeats <= 0 };
}
