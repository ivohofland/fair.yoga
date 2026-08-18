/**
 * Class Lifecycle State Machine — Pure logic, no side effects.
 *
 * Manages class status transitions with guards.
 * Classes move through: draft → open → in_progress → completed
 * with cancellation possible from most non-terminal states.
 * "Full" is derived (registrations >= maxStudents), not a stored state —
 * `services/capacity.ts` is where that derivation lives.
 */

import type { PrismaClient, Prisma, ClassStatus, RegistrationStatus, Class } from '@prisma/client';
import type { z } from 'zod';
import type { updateClassSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { ECONOMIC_FIELDS, type EconomicField } from '@/lib/class-fields';
import { toIncomeTierOrThrow } from '@/lib/tiers.server';
import { lockClassRow, setLockTimeout } from '@/lib/db-locks';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { calculateClassPricing } from './pricing';
import { createBulkNotifications, type CreateNotificationInput } from './notifications';
import { closeQueueOnStart } from './waitlist';
import { classStartInstant } from '@/lib/timezone';

export { ECONOMIC_FIELDS, type EconomicField };

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * All valid state transitions. Terminal states (completed, cancelled)
 * have empty arrays — no transitions out.
 *
 * The arrays are `readonly`. `VALID_TRANSITIONS.completed.push('open')`
 * compiled before, which would have desynchronised this table at runtime from
 * both `TERMINAL_CLASS_STATUSES` (frozen at module load, so it would NOT have
 * followed) and the DB trigger that enforces the same thing — the exact drift
 * the derivation below exists to make impossible. All four read sites
 * (`.length`, `.includes` ×2, `.join`) are readonly-safe, so this costs nothing.
 *
 * `readonly ClassStatus[]` rather than `as const satisfies`: the latter would
 * narrow the values to literal unions and force `as readonly ClassStatus[]`
 * casts into `canTransition` and `sourceStatesFor`, which are the two functions
 * that most need to stay honest about their argument types.
 */
export const VALID_TRANSITIONS: Record<ClassStatus, readonly ClassStatus[]> = {
  draft: ['open', 'cancelled'],
  open: ['in_progress', 'cancelled'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
};

/**
 * The statuses a class can never leave, derived rather than listed.
 *
 * Terminal means "no outgoing transition", which is exactly `[]` in the table
 * above — so this cannot disagree with `VALID_TRANSITIONS` the way a
 * hand-written pair would. `waitlist-retention.ts` (#238) is the consumer, and
 * its entire safety argument is that a row on such a class has no possible
 * writer.
 *
 * That argument rests on TWO DB triggers, each hard-coding
 * `('completed','cancelled')` in an applied migration that cannot be edited,
 * because the reaper's predicate has two halves and a deletion needs both:
 *
 * - `class_terminal_status_guard`
 *   (`prisma/migrations/20260805120000_class_terminal_status_trigger/`) — the
 *   class cannot leave a terminal status.
 * - `class_terminal_date_guard` (#247,
 *   `prisma/migrations/20260817120000_class_terminal_date_trigger/`) — a
 *   terminal class's `date` cannot move, which is what makes "more than 365
 *   days past" a fact rather than a snapshot.
 *
 * Deriving from a TABLE while depending on TRIGGERS is the one hazard here:
 * widen the table and this widens silently while neither trigger does.
 * `class-terminal-status.test.ts` and `class-terminal-date.test.ts` each
 * iterate this constant and each compare it against their OWN migration's SQL,
 * for exactly that reason — adding a terminal status a trigger does not cover
 * fails there, not in production. Two pins rather than one because the two
 * migrations are independent texts that nothing else forces to agree.
 *
 * Annotated and frozen, NOT `as const satisfies` — the same shape and reason as
 * `CLAIMABLE_WAITLIST_STATUSES` (`lib/waitlist-status.ts`, which explains it at
 * length): `as const` narrows `Array.prototype.includes`' parameter to the
 * literal members, forcing call sites to widen it back with a cast that
 * accepts any string.
 */
export const TERMINAL_CLASS_STATUSES: readonly ClassStatus[] = Object.freeze(
  (Object.keys(VALID_TRANSITIONS) as ClassStatus[]).filter(
    (status) => VALID_TRANSITIONS[status].length === 0,
  ),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Why a transition was refused, as a value rather than as prose.
 *
 * `error` alongside it stays free text for humans — a 409 body, a log line. The
 * split matters: those two have opposite change pressures. User-facing copy
 * wants to be rewritten (and, per CLAUDE.md's "international from day one",
 * eventually translated); something another module branches on must never
 * change silently. Before this existed, `autoCompleteClasses` told the
 * reschedule race apart from every other refusal with
 * `result.error.endsWith('has not ended yet')`, so appending a debug detail to
 * the message — still importing the shared constant, still green under `tsc`
 * and the suite — would have flipped a benign, self-resolving race back to
 * logging at `error` on every tick.
 */
export type TransitionFailureReason =
  | 'NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'NOT_ENDED_YET'
  | 'CONCURRENT_MODIFICATION';

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: 'ILLEGAL_TRANSITION'; error: string };

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Check whether a state transition is valid.
 */
export function canTransition(from: ClassStatus, to: ClassStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed.includes(to);
}

/**
 * Validate a state transition, returning a typed result.
 * On failure, the error message describes the invalid transition.
 */
export function validateTransition(
  from: ClassStatus,
  to: ClassStatus,
): TransitionResult {
  if (canTransition(from, to)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: 'ILLEGAL_TRANSITION',
    error: `Invalid transition: cannot move from "${from}" to "${to}". Valid transitions from "${from}": [${VALID_TRANSITIONS[from].join(', ')}]`,
  };
}

/**
 * The states from which `to` is a legal move — the inverse of
 * `VALID_TRANSITIONS`, derived rather than hand-declared so the
 * compare-and-swap in `transitionClass` cannot drift from the state machine
 * when a transition is added or removed.
 */
export function sourceStatesFor(to: ClassStatus): ClassStatus[] {
  return (Object.keys(VALID_TRANSITIONS) as ClassStatus[]).filter((from) =>
    VALID_TRANSITIONS[from].includes(to),
  );
}

// ---------------------------------------------------------------------------
// Economic field locking
// ---------------------------------------------------------------------------

/**
 * Whether economic fields are locked for editing.
 * Locked once the first registration is created (settingsLocked = true).
 */
export function isEconomicFieldLocked(settingsLocked: boolean): boolean {
  return settingsLocked;
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

export type TransitionDbResult =
  | { ok: true; newStatus: ClassStatus }
  | { ok: false; reason: TransitionFailureReason; error: string };

/**
 * Transition a class to a new status in the database.
 *
 * Compare-and-swap, not read-then-write. The predicate IS the guard: under
 * READ COMMITTED the `UPDATE` re-evaluates `status` after it acquires the row
 * lock, so a cancel that commits between a caller's read and this write is
 * seen rather than written over. No `FOR UPDATE`, because the status is the
 * only thing this decision depends on — the same reason `POST
 * /api/classes/[id]/transition`'s cancel branch doesn't need one for its own
 * conditional cancel-update either, even though it additionally wraps it in
 * a transaction — for an unrelated reason, to keep its notification write
 * atomic with the status change, not because the conditional update itself
 * needs one. Sites that read more state under the decision (`completeClass`,
 * and `autoCancelClasses` since #174 Task 6 started deciding from a
 * registration count read under its own cancel decision) take the lock
 * instead; see `docs/lock-order.md`.
 *
 * Since #216 this also closes the class's waitlist when the target is
 * `in_progress`, which is why the CAS now sits in a transaction. That does not
 * weaken the no-lock argument above: the close's own predicate (`classId`,
 * `status: 'waiting'`) is re-evaluated by Postgres at execution time, and the
 * CAS `UPDATE` has already taken the `Class` row lock that every
 * `WaitlistEntry` writer conflicts on — so a concurrent join or promotion is
 * either committed before this transaction's CAS or blocked behind it. This is
 * the same shape the manual-cancel branch of
 * `POST /api/classes/[id]/transition` has used since #112.
 */
export async function transitionClass(
  db: PrismaClient,
  classId: string,
  targetStatus: ClassStatus,
): Promise<TransitionDbResult> {
  // The CAS and the queue close in one transaction; the diagnostic reads below
  // stay outside it, because they decide nothing that gets persisted and would
  // only hold the transaction open on the failure path.
  const moved = await db.$transaction(async (tx) => {
    // Bounded, like every other transaction in this codebase that ends up
    // holding a `Class` row lock. This one takes its lock through the CAS
    // rather than through `lockClassRow`, so it used to inherit no bound at
    // all — and once the CAS moved inside an interactive transaction, an
    // unbounded wait became Prisma's 5s budget expiring mid-transaction
    // (`P2028`, a 503 the caller cannot act on) instead of the 2s `55P03` its
    // siblings get, which `classifyApiError` answers with a retry. Still no
    // `FOR UPDATE` — the argument above is unchanged; this bounds the wait,
    // it does not add a lock.
    await setLockTimeout(tx);

    const updated = await tx.class.updateMany({
      where: { id: classId, status: { in: sourceStatesFor(targetStatus) } },
      data: { status: targetStatus },
    });
    if (updated.count !== 1) return false;
    // #216. Predicated on the TARGET: `draft -> open` must not expire a queue,
    // and `-> cancelled` never reaches here (the route intercepts it, and no
    // other caller passes it).
    if (targetStatus === 'in_progress') await closeQueueOnStart(tx, classId);
    return true;
  });
  if (moved) return { ok: true, newStatus: targetStatus };

  // Nothing was written, so this read decides nothing that gets persisted —
  // it only tells the caller which refusal happened, and the route maps both
  // to a 409.
  const cls = await db.class.findUnique({ where: { id: classId }, select: { status: true } });
  if (!cls) return { ok: false, reason: 'NOT_FOUND', error: `Class not found: ${classId}` };

  const validation = validateTransition(cls.status, targetStatus);
  if (!validation.ok) return validation;

  // The CAS matched nothing, yet the status now permits the move: the row
  // changed twice while we were deciding. Refuse rather than retry — the
  // caller's decision was made against a world that no longer exists.
  return {
    ok: false,
    reason: 'CONCURRENT_MODIFICATION',
    error: `Concurrent modification of class ${classId}`,
  };
}

// ---------------------------------------------------------------------------
// Class completion
// ---------------------------------------------------------------------------

/**
 * Registration statuses that represent a real obligation: the student is
 * charged for these when the class completes. Exported because the archive
 * rule in `class-template-lifecycle.ts` decides what is safe to delete by the
 * same list — a class carrying any of these is one a student is still on the
 * hook for, and must not be removed silently.
 *
 * Frozen, like `ECONOMIC_FIELDS` above: this list now gates a destructive
 * `deleteMany` in two services, so a mutation anywhere in the process would
 * silently widen what archiving is allowed to destroy. Prisma's `in` filter
 * does want a mutable `RegistrationStatus[]` and will not accept a readonly
 * one — that is a constraint on the call site, not on the source of truth, so
 * callers spread (`in: [...CHARGED_STATUSES]`) exactly as the callers of
 * `ACTIVE_REGISTRATION_STATUSES` (`@/lib/registration-status`) do. That set
 * is this one minus `late_cancel`: it asks who occupies a seat, this one asks
 * who gets billed. This constant stays here rather than joining it in `lib/`
 * because only server-side services use it, and comments in
 * `class-transitions.test.ts` and `tests/integration/registrations-api.test.ts`
 * name this file as its home — all by name rather than by line number,
 * deliberately: this docblock has already grown twice since the earliest of
 * them was written (once before this branch, once again by it),
 * and a line-number citation into a docblock that keeps growing is exactly
 * the kind of claim that goes stale silently.
 */
export const CHARGED_STATUSES: readonly RegistrationStatus[] = Object.freeze([
  'registered',
  'attended',
  'no_show',
  'late_cancel',
]);

/**
 * Complete a class: validate transition, calculate pricing, update
 * registrations with prices, and create pending payments.
 *
 * Wrapped in a transaction so that all DB mutations (class status,
 * registration prices, payment creation) succeed or fail atomically.
 */
/**
 * Whether this completion has to prove the class has actually ended.
 *
 * REQUIRED, and a union rather than an optional field, because the dangerous
 * mode is the one you get by saying nothing. `completeClass(db, id)` used to
 * read as "complete it" while silently meaning "and skip the clock" — and the
 * two callers that legitimately want that were indistinguishable from a third
 * that forgot. #182 was exactly the forgetting: `autoCompleteClasses` decided
 * from its own pre-transaction snapshot, so a class rescheduled in the gap was
 * completed against a time it no longer had, and completion runs the pricing
 * engine and writes `Payment` rows.
 *
 * `finishedEarly` is not decoration either. A teacher ending a class early
 * (`POST /api/classes/[id]/complete`) and `deleteTeacherAccount` closing
 * in-flight classes during erasure both mean it, and now have to say so.
 */
export type CompletionTiming = { requireEndedBy: Date } | { finishedEarly: true };

export async function completeClass(
  db: PrismaClient,
  classId: string,
  timing: CompletionTiming,
): Promise<TransitionDbResult> {
  return db.$transaction(async (tx) => {
    // Before the read, not with the first write. Everything below decides
    // from this row — the status gate, the registration set the pricing
    // engine consumes, and the Payment rows created from it — so the read
    // has to happen under the lock rather than the update acquiring it after
    // the decision is already made.
    await lockClassRow(tx, classId);

    const cls = await tx.class.findUnique({
      where: { id: classId },
      include: {
        registrations: true,
        teacher: { select: { defaultTimezone: true } },
      },
    });
    if (!cls) return { ok: false, reason: 'NOT_FOUND', error: `Class not found: ${classId}` };

    // #182. The TIMING decision lives here, under the lock this function
    // already holds, rather than in the caller's pre-transaction snapshot.
    // `autoCompleteClasses` used to compute the end time from its outer
    // `findMany` and pass only the id, so a class rescheduled between that
    // read and this transaction was completed against a time it no longer
    // had — and completion runs the pricing engine and creates `Payment`
    // rows, so students were billed for a class whose start had moved.
    //
    // Two callers legitimately skip the check — a teacher finishing early
    // (`POST /api/classes/[id]/complete`) and `deleteTeacherAccount`
    // (`gdpr.ts`) closing in-flight classes during erasure — which is why
    // `finishedEarly` exists rather than the check being unconditional. They
    // have to SAY so: see `CompletionTiming` for why skipping cannot be the
    // silent default.
    if ('requireEndedBy' in timing) {
      // Not a truthiness test. An `Invalid Date` is truthy, and every
      // comparison against it is false, so the old shape let a broken clock
      // through the guard silently. `in` narrows on the KEY, and the explicit
      // NaN check turns a caller bug into a loud one rather than a completed
      // class.
      if (Number.isNaN(timing.requireEndedBy.getTime())) {
        throw new TypeError('completeClass: requireEndedBy is not a valid Date');
      }
      const start = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
      const end = new Date(start.getTime() + cls.durationMinutes * 60 * 1000);
      if (timing.requireEndedBy < end) {
        return {
          ok: false,
          reason: 'NOT_ENDED_YET',
          error: `Class ${classId} has not ended yet`,
        };
      }
    }

    // If open, transition to in_progress first (teacher completing directly)
    if (cls.status === 'open') {
      const toInProgress = validateTransition('open', 'in_progress');
      if (!toInProgress.ok) return toInProgress;
      await tx.class.update({ where: { id: classId }, data: { status: 'in_progress' } });
      // #216, third of the three `open -> in_progress` exits. The other two go
      // through `transitionClass` and `autoTransitionToInProgress`; this one
      // does not, so it needs its own call. Inside the lock this function
      // already holds, so it is atomic with the status flip above.
      await closeQueueOnStart(tx, classId);
    } else {
      const validation = validateTransition(cls.status, 'completed');
      if (!validation.ok) return validation;
    }

    const chargedRegistrations = cls.registrations.filter((r) =>
      CHARGED_STATUSES.includes(r.status),
    );

    if (chargedRegistrations.length === 0) {
      await tx.class.update({
        where: { id: classId },
        data: { status: 'completed', effectiveTeacherRate: 0, totalStudents: 0, totalRevenue: 0 },
      });
      return { ok: true, newStatus: 'completed' as ClassStatus };
    }

    const pricing = calculateClassPricing({
      roomCost: Number(cls.roomCost),
      minRate: Number(cls.minRate),
      targetRate: Number(cls.targetRate),
      minStudents: cls.minStudents,
      maxStudents: cls.maxStudents,
      studentTiers: chargedRegistrations.map((r) =>
        toIncomeTierOrThrow(r.tierAtBooking, { registrationId: r.id }),
      ),
    });

    await tx.class.update({
      where: { id: classId },
      data: {
        status: 'completed',
        effectiveTeacherRate: pricing.effectiveTeacherRate,
        totalStudents: pricing.studentCount,
        totalRevenue: pricing.totalCost,
      },
    });

    // Iterating the priced records rather than indexing two arrays: price and
    // ratio arrive together, so they cannot skew apart. What assertions remain
    // are on chargedRegistrations, this function's own array — never on the
    // pricing engine's output.
    for (const [i, s] of pricing.students.entries()) {
      const reg = chargedRegistrations[i]!;
      await tx.registration.update({
        where: { id: reg.id },
        data: { price: s.price, tierRatio: s.ratio },
      });
      await tx.payment.create({
        data: { registrationId: reg.id, amount: s.price, status: 'pending' },
      });
    }

    // Payments exist — now tell people about them, in the same transaction.
    // In the Level 1 model this notification IS the payment request.
    const notifications: CreateNotificationInput[] = pricing.students.map((s, i) => {
      const reg = chargedRegistrations[i]!;
      return {
        recipientType: 'student' as const,
        recipientId: reg.studentId,
        type: 'payment_request' as const,
        title: 'Payment requested',
        body: `Your price for ${cls.classType} is €${s.price.toFixed(2)}. Pay your teacher directly.`,
        relatedClassId: cls.id,
      };
    });
    notifications.push({
      recipientType: 'teacher' as const,
      recipientId: cls.teacherId,
      type: 'payment_request' as const,
      title: 'Class completed',
      body: `${cls.classType} completed — €${(pricing.totalCost - Number(cls.roomCost)).toFixed(2)} earnings, ${chargedRegistrations.length} payment ${chargedRegistrations.length === 1 ? 'request' : 'requests'} sent.`,
      relatedClassId: cls.id,
    });
    await createBulkNotifications(tx, notifications);

    return { ok: true, newStatus: 'completed' as ClassStatus };
  });
}

// ---------------------------------------------------------------------------
// Class updates
// ---------------------------------------------------------------------------

/**
 * The fields a teacher may change on an existing class.
 *
 * Derived from `updateClassSchema` rather than hand-declared. `date` is the one
 * genuine difference — a `YYYY-MM-DD` string on the wire, a `Date` by the time
 * it reaches Prisma.
 *
 * Deriving alone buys no safety: the route builds its payload with
 * `{ ...rest }`, and spreading defeats TypeScript's excess-property check, so
 * the route itself will never flag a field added to the schema — it reaches
 * `db.class.updateMany` either way, hand-declared or derived. What deriving
 * enables is the pins below, and they are what catches it now: before them
 * adding a field to `updateClassSchema` alone left `tsc --noEmit` at exit 0
 * (that was true when this type landed, and is why #79 was filed); today the
 * allowlist pin fails the build with the field named.
 */
export type ClassUpdateData =
  Omit<z.infer<typeof updateClassSchema>, 'date'> & { date?: Date };

/**
 * Compile-time pin: every field the wire schema accepts must be a column
 * `updateMany` can actually write on `Class`.
 *
 * Because `ClassUpdateData` is derived, a new schema field lands in `keyof
 * ClassUpdateData`; if it has no matching column this pin resolves to that
 * field's name instead of `true`, and the assignment below stops compiling
 * with the offending field named in the error. A hand-declared type could not
 * do this — the unknown field would never appear in `keyof` at all.
 *
 * The reference is the *Many* input deliberately: `ClassUncheckedUpdateInput`
 * (the single-record type) additionally accepts nested relation writes
 * (`registrations`, `notifications`, …) that `updateMany` rejects, so pinning
 * against it would wave through a schema field named after a relation.
 */
const _classUpdateColumnsExist: NoneOf<
  Exclude<keyof ClassUpdateData, keyof Prisma.ClassUncheckedUpdateManyInput>
> = true;
void _classUpdateColumnsExist;

/**
 * The fields a teacher may change on their own class via `PUT /api/classes/[id]`.
 *
 * A pure type, not a runtime array: nothing reads this list at runtime — the
 * schema's `.strict()` already rejects undeclared keys, so this exists only to
 * feed the two pins below. Unlike `ECONOMIC_FIELDS`, which the update path
 * genuinely iterates, a runtime `as const` array here would be used solely as
 * a `typeof` source and earn an eslint suppression for the privilege.
 *
 * Adding a member is how a new schema field gets authorized: it grants write
 * access to a `Class` column that may be gated by business logic the plain
 * update path does not run. Before adding one, go read what actually guards
 * that column — none of these guards live in `updateClass`, which is the point:
 *   - `status`             → the lifecycle state machine (`VALID_TRANSITIONS`),
 *                            enforced by `validateTransition` in
 *                            `transitionClass` and `completeClass`
 *   - `settingsLocked`     → written once by the first registration
 *                            (`api/registrations/route.ts`). `updateClass` only
 *                            *reads* it, to gate `ECONOMIC_FIELDS` — so nothing
 *                            here would stop a write to the flag itself
 *   - `teacherId`          → class ownership, checked in the route
 *                            (`api/classes/[id]/route.ts`), not in this service
 *   - the financial totals → written only by `completeClass`
 * — because the compiler will not. For the columns above, the forbidden pin
 * below refuses the grant outright; for anything else, the judgement is yours.
 */
type TeacherEditableClassField =
  | 'classType'
  | 'description'
  | 'date'
  | 'startTime'
  | 'durationMinutes'
  | 'roomCost'
  | 'minRate'
  | 'targetRate'
  | 'minStudents'
  | 'maxStudents';

/**
 * Compile-time pin (forward): every field `updateClassSchema` accepts must be
 * on the teacher-editable allowlist. Add a column-shaped field to the schema
 * without adding it to the allowlist and this resolves to that field's name
 * instead of `true`, failing the build with the field named. This is the guard
 * the column pin above does NOT provide: `status` is a perfectly real, writable
 * column, so that pin waves it through.
 *
 * What it proves is narrower than "this field is permitted". Together with the
 * reverse pin it forces the allowlist to equal the schema's key set exactly, so
 * the allowlist holds no policy of its own and cannot encode "the schema has
 * `status` but a teacher may not write it" — that state does not compile. What
 * it buys is that the grant must be *explicit*: a new schema field breaks the
 * build until someone also names it above, next to the list of what else guards
 * these columns. It cannot tell a considered grant from a paste of the name the
 * error just handed you. The forbidden pin below is what refuses the grants
 * that are never right. See issue #79 for the latent `status` bypass this
 * closes — latent, because no such field is in the schema today.
 */
const _classUpdateFieldsArePermitted: NoneOf<
  Exclude<keyof ClassUpdateData, TeacherEditableClassField>
> = true;
void _classUpdateFieldsArePermitted;

/**
 * Compile-time pin (reverse): every allowlist entry must still be a field the
 * schema accepts. Remove a field from `updateClassSchema` but leave it on the
 * allowlist and this names the stale entry, so the list can't rot into granting
 * permission for a column that no longer flows through this route.
 *
 * Two things to know before deleting this as redundant paranoia:
 *   - It is the only pin that fires if `ClassUpdateData` ever degrades to `{}`
 *     or `unknown` — on an empty `keyof`, the forward pin passes vacuously.
 *     Measured across `any`, `unknown`, `{}`, `never` and an added index
 *     signature: every degradation trips the forward pin or this one, and the
 *     narrowing half is caught here alone.
 *   - It is blind to exactly one field. `date` is re-added unconditionally by
 *     the intersection in `ClassUpdateData`, so it is in `keyof` whether or not
 *     the schema declares it, and dropping `date` from the schema leaves both
 *     pins green. Covered instead by the key-set test in `schemas.test.ts`,
 *     which reads the schema object rather than a type derived from it.
 */
const _allowlistHasNoStaleFields: NoneOf<
  Exclude<TeacherEditableClassField, keyof ClassUpdateData>
> = true;
void _allowlistHasNoStaleFields;

/**
 * The `Class` columns the plain update path must never write.
 *
 * "Plain update path", not "never": each of these is owned by a different,
 * guarded route — `status` by `POST …/transition` and `completeClass`,
 * `settingsLocked` by the first registration. The pin says "not here", which is
 * why the name says it too.
 *
 * The forward and reverse pins force the allowlist to mirror the schema, which
 * means the quickest way to make a forward-pin failure go away is to paste the
 * offending field name into the allowlist — exactly the reflexive grant #79 is
 * about. This list is the set where that repair is never the right one, and the
 * pin below fails on a const whose *name* carries the reason, since the name is
 * the part of a type error people actually read.
 *
 * It also changes the shape of the mistake: adding a member above is a one-line
 * edit that looks like configuration, while deleting a member here reads in
 * review as what it is. Granting one of these still has an escape hatch — the
 * contributor has to remove it from this list first — and that is the point,
 * not a weakness: the guard makes the decision visible, it does not pretend to
 * be an access-control system.
 */
type PlainUpdateForbiddenClassField =
  | 'id'
  | 'teacherId'
  | 'status'
  | 'settingsLocked'
  | 'effectiveTeacherRate'
  | 'totalStudents'
  | 'totalRevenue';

/**
 * Compile-time pin: every name above must be a real `Class` column. Without
 * this, a typo (`statuss`) would sit in the forbidden list protecting nothing
 * while looking like protection — the same rot the reverse pin exists to stop,
 * one list over.
 */
const _forbiddenColumnsExist: NoneOf<
  Exclude<PlainUpdateForbiddenClassField, keyof Prisma.ClassUncheckedUpdateManyInput>
> = true;
void _forbiddenColumnsExist;

/**
 * Compile-time pin (forbidden): no forbidden column may appear on the
 * teacher-editable allowlist. Fails naming the field that must not be there.
 */
const _allowlistHasNoForbiddenFields: NoneOf<
  Extract<TeacherEditableClassField, PlainUpdateForbiddenClassField>
> = true;
void _allowlistHasNoForbiddenFields;

/**
 * Thrown when `updateClass` reaches a state its own guards say cannot happen.
 * A programmer error, never a business outcome — business outcomes are values
 * of `UpdateClassResult`. Named so it is distinguishable from unrelated
 * failures in `withErrorHandler`'s catch-all.
 */
export class UpdateClassInvariantError extends Error {}

/**
 * Why an update did or did not happen.
 *
 * `locked` carries a NON-EMPTY tuple of offending fields deliberately. The bug
 * this type replaced (#72) returned a "locked" response naming no fields at
 * all, for a request that touched none — the compiler now refuses to construct
 * that. Callers own the user-facing wording; this type owns the distinction.
 *
 * `terminal` carries the status for the same reason `locked` carries fields:
 * the caller owns the wording and needs to name what happened. It is plain
 * `ClassStatus` rather than a narrowed terminal union — the value is only ever
 * read into a message, and narrowing it would cost a type guard at each of the
 * two construction sites (the early return and the disambiguation branch,
 * below) for nothing.
 *
 * Every *business* outcome of an update is a variant here. The one non-outcome
 * — an invariant violation, where the function's own reasoning about its
 * inputs turns out to be wrong — is not encoded as a value; it throws
 * `UpdateClassInvariantError` instead.
 */
export type UpdateClassResult =
  | { ok: true; cls: Class }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'locked'; fields: readonly [EconomicField, ...EconomicField[]] }
  | { ok: false; reason: 'terminal'; status: ClassStatus }
  | { ok: false; reason: 'no_fields' }
  | { ok: false; reason: 'slot_conflict' }
  | { ok: false; reason: 'template_date_conflict' };

/**
 * Apply a partial update to a class, enforcing two independent freezes.
 *
 * They gate on different events and cover different things. The ECONOMIC
 * freeze (`settingsLocked`) starts at the first registration and covers
 * `ECONOMIC_FIELDS`. The TERMINAL freeze (#247) starts when the class reaches
 * `completed` or `cancelled` and covers EVERY field — it is the class that is
 * frozen, not a list of columns.
 *
 * NEITHER LIFTS. They differ in SCOPE, not in permanence. An earlier revision
 * of this docblock said a teacher could undo the economic freeze by removing
 * the registration; that was never true. `settingsLocked` is only ever written
 * `true`, from one site (`POST /api/registrations`), and nothing anywhere
 * writes it back to `false` — `template-sync.ts` leans on exactly that,
 * saying registration latches it `true` one way and never back. A terminal
 * status, in turn, has no outgoing transition.
 *
 * Both are checked twice, for the same reason. The first check, against the
 * row we just read, is an optimisation: it answers the common case in one
 * query instead of three. The compare-and-swap inside the write is the one
 * that matters — it catches a first registration, or a completion, landing
 * between that read and this write, and on its own it produces the identical
 * result, list of offending fields included. Deleting the ECONOMIC check costs
 * round trips, not correctness, for exactly that reason.
 *
 * DELETING THE TERMINAL CHECK IS NOT AS FREE, AND IT CHANGES THE ANSWER IN
 * TWO CASES, NOT ONE. An earlier revision of this docblock said one, and the
 * branch that wrote it had already shipped the test that disproves it. Both
 * are questions of ORDER — the terminal check sits above two other early
 * returns, and each would answer first without it:
 *
 *  1. A class that is BOTH terminal and settings-locked with an economic
 *     field sent. `cls.settingsLocked && sentEconomic !== null` fires next and
 *     answers `locked` — the narrower and more misleading of two true
 *     refusals, since it reports the refusal as being about economic fields
 *     when in fact every field is refused. Pinned by `'reports terminal, not
 *     locked, when the class is both'`.
 *  2. A terminal class with an empty or all-`undefined` payload. `hasEdit`
 *     fires next and answers `no_fields` (a 400) where the class is in fact
 *     frozen (a 409) — and here the CAS re-derives nothing at all, because
 *     control returns before any write is attempted. Pinned by `'answers
 *     terminal, not no_fields, for a body that asks for nothing'`.
 *
 * Everywhere else deleting it costs only round trips, and the CAS does
 * re-derive the same refusal.
 *
 * The terminal freeze additionally has a database backstop for `date` alone
 * (`class_terminal_date_guard`), because that is the column
 * `waitlist-retention.ts` reads before it deletes.
 */
export async function updateClass(
  db: PrismaClient,
  classId: string,
  data: ClassUpdateData,
): Promise<UpdateClassResult> {
  const cls = await db.class.findUnique({ where: { id: classId } });
  if (!cls) return { ok: false, reason: 'not_found' };

  // Checked BEFORE the economic lock AND before `hasEdit`, and the position is
  // load-bearing in both directions. For most inputs this is an optimisation
  // only — the CAS below re-derives the same refusal — but for TWO it is what
  // produces the right answer at all, because each of the two early returns
  // downstream would otherwise answer first: `locked` for a class that is also
  // settings-locked with an economic field sent, and `no_fields` for an empty
  // or all-undefined payload. The second is the one that gets forgotten,
  // because the CAS cannot cover it: `hasEdit` returns before any write is
  // attempted, so there is no compare-and-swap to fall back on. `updateClass`'s
  // docblock enumerates both, each with the test that pins it.
  if (TERMINAL_CLASS_STATUSES.includes(cls.status)) {
    return { ok: false, reason: 'terminal', status: cls.status };
  }

  // Destructured rather than length-checked, so the non-empty tuple below is
  // proven to the compiler (via noUncheckedIndexedAccess) instead of asserted.
  const [firstEconomic, ...otherEconomic] = ECONOMIC_FIELDS.filter(
    (f) => data[f] !== undefined,
  );
  const sentEconomic: readonly [EconomicField, ...EconomicField[]] | null =
    firstEconomic === undefined ? null : [firstEconomic, ...otherEconomic];

  if (cls.settingsLocked && sentEconomic !== null) {
    return { ok: false, reason: 'locked', fields: sentEconomic };
  }

  // A key whose value is `undefined` is not an edit. Prisma agrees more
  // strongly than you might expect: given a `data` object whose every value is
  // undefined it issues no UPDATE at all and returns `{ count: 0 }` — with no
  // regard for whether the row exists. Testing key *presence* here (rather
  // than defined *values*, as `sentEconomic` above already does) let a
  // no-op payload reach the compare-and-swap, come back with a zero count,
  // and land in the "unreachable" branch below as a 500.
  const hasEdit = Object.values(data).some((v) => v !== undefined);
  if (!hasEdit) {
    return { ok: false, reason: 'no_fields' };
  }

  // `date`/`startTime` are both teacher-editable (`TeacherEditableClassField`
  // above), and `status` is not writable through this path — so every class
  // reaching this write stays inside `Class_teacher_slot_unique`'s partial
  // scope (`WHERE status <> 'cancelled'`, #196) across the edit. That used
  // to read "any class ... that isn't already `cancelled`", which #247 made
  // vacuous: the `notIn` conjunct below refuses a `cancelled` class outright,
  // so no such class reaches this write to fall outside the scope, and the
  // qualifier implied a live case there is not. Moving `date`/`startTime`
  // onto a slot this teacher already occupies collides here exactly as a
  // `POST` into that slot does.
  //
  // A second, older key is reachable here too, and only here: `date` is
  // teacher-editable but no create route ever sets `templateId` (it is
  // server-assigned, only ever by the generator), so `@@unique([templateId,
  // date])` (`Class_templateId_date_key`, predates #196) can never fire from
  // a create. It fires from THIS write: a template-generated class carries a
  // real `templateId`, and moving its `date` onto a date a sibling instance
  // of the same template already holds collides on that older key — even
  // when the two classes' `startTime` differs enough that the slot key above
  // never would. Postgres validates a multi-key violation in the indexes'
  // OID order, and `Class_templateId_date_key` is older than
  // `Class_teacher_slot_unique`, so this is the one Postgres reports first.
  //
  // Terminality re-checked in the filter for exactly the reason
  // `settingsLocked` is: `completeClass` (this same file) takes a `Class` row
  // lock and re-reads under it — the `lockClassRow` call, and the
  // `requireEndedBy` comparison that decides against what it read — so a
  // completion can commit between this function's opening read and this
  // write. This function takes no lock at all.
  //
  // Cited by name, not by line — `CHARGED_STATUSES`' docblock above argues why.
  //
  // ONE THING NEITHER TRIGGER CATCHES, recorded here because the migration
  // that would be the natural home for it is applied and therefore frozen:
  // both triggers gate on `OLD.status`, so a SINGLE statement that writes
  // `status` and `date` together (`SET status = 'completed', date = <past>`)
  // sees `OLD.status = 'open'` and satisfies neither WHEN clause. No such
  // writer exists — every status writer in `src/` writes status alone or
  // status-plus-totals — and this function cannot become one, since `status`
  // is not a `TeacherEditableClassField`. It is a shape to refuse in review,
  // not a hole in the guard.
  //
  // Built as one object rather than two ternary arms so the terminal conjunct
  // cannot be present in one filter shape and missing from the other: there
  // is only one shape. `settingsLocked` is the part that varies, and it
  // varies by conditional spread, the idiom `route.ts` already uses to build
  // this function's `data`. Spread copy of the statuses because
  // `TERMINAL_CLASS_STATUSES` is `readonly` and Prisma's `notIn` wants a
  // mutable array — the same reason `gdpr.ts` spreads `CANCELLABLE_STATUSES`
  // into its own status CAS.
  const where: Prisma.ClassWhereInput = {
    id: classId,
    status: { notIn: [...TERMINAL_CLASS_STATUSES] },
    ...(sentEconomic !== null ? { settingsLocked: false } : {}),
  };

  let result: Prisma.BatchPayload;
  try {
    result = await db.class.updateMany({ where, data });
  } catch (err) {
    if (isUniqueConflictOn(err, ['teacherId', 'date', 'startTime'])) {
      return { ok: false, reason: 'slot_conflict' };
    }
    // `Class_templateId_date_key` — see the comment above the write for why
    // this is reachable here and nowhere else. Without this arm the error
    // rethrows and `classifyApiError`'s generic P2002 fallback
    // (`src/lib/api-errors.ts`) answers "Resource already exists" for the
    // ordinary act of moving this week's class to next Monday.
    if (isUniqueConflictOn(err, ['templateId', 'date'])) {
      return { ok: false, reason: 'template_date_conflict' };
    }
    throw err;
  }

  if (result.count === 0) {
    // Both filter shapes constrain `id`, so a deleted row explains a zero
    // count under either of them — find out which happened rather than
    // assuming. #72 was this branch asserting a cause instead of checking it;
    // the economic path had the identical defect, and a deleted class
    // reported as "locked" is harder to spot than #72's empty list, because
    // the field name it names looks entirely plausible.
    const stillExists = await db.class.findUnique({
      where: { id: classId },
      select: { id: true, status: true },
    });
    if (!stillExists) return { ok: false, reason: 'not_found' };

    // The class went terminal between the opening read and the write — the
    // race the CAS above exists to lose. This branch is NOT optional cleanup:
    // without it a `date`-only edit on a completed class reaches the throw
    // below (the row exists, and `date` is not economic, so `sentEconomic` is
    // null) and `withErrorHandler` answers 500 — for the single most likely
    // request #247 is about. Adding the conjunct without adding this branch
    // is strictly worse than adding neither.
    if (TERMINAL_CLASS_STATUSES.includes(stillExists.status)) {
      return { ok: false, reason: 'terminal', status: stillExists.status };
    }

    // The row survives, so the only other conjunct that can have failed is
    // `settingsLocked: false` — which is only ever in the filter when
    // economic fields were sent.
    if (sentEconomic !== null) return { ok: false, reason: 'locked', fields: sentEconomic };

    // Unreachable, and still actually so now that a third conjunct is in the
    // filter: `hasEdit` above guarantees Prisma issues a real UPDATE, and
    // every conjunct that UPDATE can fail on has just been re-read — the row
    // exists, it is not terminal, and `settingsLocked: false` is only ever in
    // the filter when economic fields were sent. Loud rather than silently
    // returning a plausible-but-wrong reason.
    throw new UpdateClassInvariantError(
      `updateClass: class ${classId} matched no rows but still exists`,
    );
  }

  // `findUnique`, not `findUniqueOrThrow`. The write succeeded, but the row
  // can still be gone by the time it is re-read: `template-sync.ts`'s
  // wrong-day cleanup and `archiveOrUnarchiveTemplate` both delete future
  // instances, which is the same population being edited here. `P2025` has no
  // branch in `classifyApiError`, so throwing would surface a bare 500 for a
  // race — and `isRecordNotFound`'s own docblock states the rule this would
  // break: losing the race should produce the same answer as never having had
  // the row. That answer already exists as a variant.
  const updated = await db.class.findUnique({ where: { id: classId } });
  if (!updated) return { ok: false, reason: 'not_found' };
  return { ok: true, cls: updated };
}
