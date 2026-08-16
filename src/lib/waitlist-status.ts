/**
 * What each `WaitlistStatus` means for the queue, and the one subset the app
 * derives from it.
 *
 * One definition, in `lib/` and import-free at runtime, for the same reason
 * `registration-status.ts` and `class-fields.ts` are: a `'use client'` component
 * that ever needs this list must be able to import it without dragging
 * `@/lib/log` (pino, server-only) into the browser bundle. The `import type`
 * below erases completely, so this module emits no runtime import at all.
 *
 * **Why this file exists.** `expired` sat in the Prisma enum from Phase 1 with
 * no writer. #216 gave it one — `closeQueueOnStart` — and the set of statuses a
 * teacher can still walk a student in from changed from `{waiting}` to
 * `{waiting, expired}` in the same commit. That set was then spelled three
 * different ways in three files (the walk-in resolver's `in:` list, the class
 * page's count, and the label `class-info.tsx` renders from it), agreeing only
 * by prose. They did not agree: the resolver was widened and the count was not,
 * so a queued student walked in at the door held a live, billed registration
 * next to an entry stuck on `expired` — the exact "never got in" story `expired`
 * exists to prevent. Naming the set is what stops the next such change drifting.
 *
 * Nothing here pins a status to a LIFECYCLE stage. `expired` is written when a
 * class starts; whether it can still be resolved depends on the class's status,
 * which is the caller's business, not this module's.
 */
import type { WaitlistStatus } from '@prisma/client';

/**
 * Every status, and what it says about the student's standing in the queue.
 *
 * `Record` over the enum is EXHAUSTIVE — this is the mechanical pin
 * `registration-status.ts`'s docblock describes as worth building "if it ever
 * earns its keep". On the waitlist side it now has: adding a sixth member is a
 * compile error here, at the one place the decision belongs, rather than a
 * silent absence from a hand-written list.
 *
 * The four roles are not cosmetic, and `lapsed` vs `withdrawn` is the load-bearing
 * split:
 *
 * - `live` — still contending for a seat. The only role `reorderWaitingEntries`
 *   renumbers; closed rows keep stale positions by design (#183).
 * - `fulfilled` — the student got a seat. Self-limiting and not a queue closure.
 * - `lapsed` — the queue closed under them and they never got in. No decision was
 *   ever made ABOUT them, which is why a walk-in can still make them `claimed`.
 * - `withdrawn` — they left (`removeFromWaitlist`), or a cancel path closed the
 *   queue (#195). A decision was already made; resolving it to `claimed` would
 *   assert the opposite of what happened.
 *
 * That distinction is legally load-bearing, not editorial: `exportStudentData`
 * (`services/gdpr.ts`) publishes `WaitlistEntry.status` verbatim and does not
 * select the class's status alongside it, so an Article 15 export saying
 * `removed` for a student who never withdrew is a false statement of fact about
 * a data subject.
 */
const QUEUE_ROLE: Record<WaitlistStatus, 'live' | 'fulfilled' | 'lapsed' | 'withdrawn'> = {
  waiting: 'live',
  promoted: 'fulfilled',
  claimed: 'fulfilled',
  expired: 'lapsed',
  removed: 'withdrawn',
};

/**
 * The statuses a teacher can still resolve by walking the student in.
 *
 * `live` ∪ `lapsed` — a student who is still queuing, or one the queue closed
 * under when the class started. Both are people who never got a seat and never
 * said no.
 *
 * Every site that asks "can this student still be walked in?" must use THIS
 * list: the resolver in `POST /api/registrations`, and the count rendered beside
 * the **Add walk-in** button it feeds. If the two disagree the button consumes
 * something the count says is not there, which is how the #216 regression
 * happened.
 *
 * Derived from `QUEUE_ROLE` rather than written out, so it cannot drift from the
 * role table above.
 *
 * **Annotated and frozen, NOT `as const satisfies`** — the same shape and the
 * same reason as `ACTIVE_REGISTRATION_STATUSES` (`registration-status.ts`, which
 * explains it at length): `as const` narrows `Array.prototype.includes`'
 * parameter to the literal members, forcing every call site to widen it back
 * with `as readonly string[]` — a cast that accepts any string, under which a
 * wrong-enum argument compiles clean and silently returns false. The annotation
 * keeps `.includes` typed as `WaitlistStatus`.
 *
 * Prisma's `in:` filter wants a mutable array, so query call sites spread:
 * `status: { in: [...CLAIMABLE_WAITLIST_STATUSES] }`.
 */
export const CLAIMABLE_WAITLIST_STATUSES: readonly WaitlistStatus[] = Object.freeze(
  (Object.keys(QUEUE_ROLE) as WaitlistStatus[]).filter(
    (status) => QUEUE_ROLE[status] === 'live' || QUEUE_ROLE[status] === 'lapsed',
  ),
);

/**
 * The statuses that mean the student got a seat.
 *
 * `fulfilled` from the role table above, so it cannot drift from it — the same
 * derivation as `CLAIMABLE_WAITLIST_STATUSES`.
 *
 * Used by `waitlist-retention.ts` (#238) as the SECOND of two independent
 * discriminators for "this entry never became a booking". The first, and the
 * primary one, is `registrationId IS NULL`: a foreign key to a `Registration`
 * is what actually makes a row bookkeeping, where a status is only a label.
 * That argument stands on the FK by itself — NOT on "and through it to a
 * `Payment`", which an earlier version added and which is not always true:
 * `Payment` rows are created only by `completeClass`, so a fulfilled entry on a
 * CANCELLED class has a `Registration` and no `Payment`. No writer can produce
 * a row where the status and the FK disagree; all three fulfilment sites write
 * `registrationId` in the same statement as the status (`waitlist.ts`'s
 * `promoteNext` and `claimSpot`, and the walk-in resolver in
 * `POST /api/registrations`).
 *
 * It is there anyway because deleting is irreversible, and two independently
 * derived discriminators intersected are conservative: if they ever disagree,
 * the row survives.
 */
export const FULFILLED_WAITLIST_STATUSES: readonly WaitlistStatus[] = Object.freeze(
  (Object.keys(QUEUE_ROLE) as WaitlistStatus[]).filter(
    (status) => QUEUE_ROLE[status] === 'fulfilled',
  ),
);
