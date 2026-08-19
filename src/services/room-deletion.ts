import type { PrismaClient } from '@prisma/client';
import { isRestrictViolationOn } from '@/lib/api-errors';

/**
 * What blocks the HARD deletion of a room, and what to say when it does
 * (issue 103).
 *
 * The sibling of `room-archive.ts`, and deliberately not part of it: archiving
 * and deleting ask different questions and must answer them differently.
 *
 * ARCHIVING asks "would a template put classes here?" — only a live template
 * does, so that door uses `ACTIVE_TEMPLATE_WHERE`
 * (`src/lib/template-selection.ts`) and only `open`/`in_progress` classes.
 *
 * DELETING asks "does a row point here?" — and a foreign key reads neither
 * `isActive` nor `isArchived` nor `status`. Narrowing this module's predicates
 * to match the archive door's is the single most likely wrong edit here: it
 * compiles, it passes any test written against a live template, and it
 * restores the raw P2003 that issue 103 exists to remove. `room-deletion.test.ts`
 * carries archived and paused cases for exactly that reason.
 *
 * Framework-agnostic per CLAUDE.md: no HTTP, no `next/*`. Both routes are thin
 * wrappers.
 */

/**
 * Every foreign key that `RESTRICT`s a `TeacherRoom` delete
 * (`prisma/migrations/20260403092044_init/migration.sql:339,345`).
 *
 * Used with `isRestrictViolationOn` as the backstop for the check-to-delete
 * race. `Class_teacherRoomId_fkey` is here even though the `Class` guard
 * predates this issue: that guard has the identical race and had no backstop
 * at all.
 */
export const ROOM_DELETE_RESTRICT_FKS = [
  'ClassTemplate_teacherRoomId_fkey',
  'Class_teacherRoomId_fkey',
] as const;

/**
 * One refusal for both blockers, deliberately naming neither.
 *
 * A `ClassTemplate` is never hard-deleted anywhere in `src/` — there is no
 * `DELETE` verb on `/api/class-templates/[id]` — so a template blocker is as
 * permanent as class history and has the identical remedy. Same reasoning
 * `classifyApiError` states for the two terminality triggers ("any wording
 * that names one column is wrong half the time").
 *
 * "STILL IN USE", NOT "CLASS HISTORY" — the noun was corrected in PR review.
 * The earlier wording was accurate only when a class was the blocker. A room
 * blocked solely by a template has ZERO classes (that is the state issue 103
 * reproduced), so it sent the teacher to a schedule showing nothing — the
 * exact failure `describeRoomBlockers` documents at `room-archive.ts:74-79`
 * for its own "unfinished" vs "upcoming" choice.
 *
 * AND DO NOT REACH FOR `describeRoomBlockers` TO SAY IT BETTER. The two doors
 * count different things: it says "unfinished class", meaning
 * `BLOCKING_CLASS_STATUSES` (`open`/`in_progress`), while this door counts
 * EVERY class because a foreign key does. Reused here, three completed
 * classes read "3 unfinished classes still use this room" — the same defect
 * in a different word.
 *
 * The remedy is named unconditionally and is not always available in one
 * step: a LIVE template blocks archiving too (`ACTIVE_TEMPLATE_WHERE`), so
 * that teacher must pause or archive the template first. Same is already true
 * of an `open` class, and predates this issue. Tracked separately.
 */
export const ROOM_DELETE_BLOCKED_MESSAGE =
  'This room is still in use and cannot be deleted. Archive it instead.';

/**
 * True when a room-delete statement was refused by one of the foreign keys
 * above — the check-to-delete race, or a pre-check that has stopped working.
 *
 * BOTH ROUTES CALL THIS RATHER THAN `isRestrictViolationOn(err, ROOM_DELETE_RESTRICT_FKS)`
 * DIRECTLY, so the list cannot be got wrong at a call site. PR review measured
 * that nothing pinned that wiring: replacing the list with `[]` at both call
 * sites left every case in both integration suites green, because both
 * routes' tests are stopped by the pre-check and never reach the catch. Owning
 * the list here removes the mistake instead of testing for it, and gives the
 * real-refused-delete cases in `room-deletion.test.ts` something to assert
 * that the routes actually call.
 */
export function isRoomDeleteBlocked(error: unknown): boolean {
  return isRestrictViolationOn(error, ROOM_DELETE_RESTRICT_FKS);
}

/**
 * The pre-check's refusal code, and the backstop's.
 *
 * They differ ON PURPOSE. The two guards return the same status and the same
 * message — that is deliberate, the teacher's situation is identical — which
 * meant no assertion anywhere in the suite could tell which one answered, and
 * disabling the pre-check left every integration test green. The code is the
 * cheap half of the fix: every pre-check case asserts `ROOM_IN_USE`, so a dead
 * pre-check now reddens all of them at once instead of nothing.
 *
 * It does not replace the lock-ordering cases. A code assertion still passes
 * if someone moves the pre-check BELOW the delete inside the same handler;
 * only holding `FOR UPDATE` on the template row observes that the statement
 * was never issued, which is the property `docs/lock-order.md` depends on.
 *
 * `ROOM_IN_USE_RACE` also tells an operator which of the two causes fired,
 * matching the `warn` line beside it.
 */
export const ROOM_IN_USE_CODE = 'ROOM_IN_USE';
export const ROOM_IN_USE_RACE_CODE = 'ROOM_IN_USE_RACE';

export type RoomDeleteBlockers = { classes: number; templates: number };

/** Rows pointing at one teacher's link. */
export async function countTeacherRoomDeleteBlockers(
  db: PrismaClient,
  teacherRoomId: string,
): Promise<RoomDeleteBlockers> {
  const [classes, templates] = await Promise.all([
    db.class.count({ where: { teacherRoomId } }),
    db.classTemplate.count({ where: { teacherRoomId } }),
  ]);
  return { classes, templates };
}

/** Rows pointing at ANY link on one room — deleting the room takes them all. */
export async function countRoomDeleteBlockers(
  db: PrismaClient,
  roomId: string,
): Promise<RoomDeleteBlockers> {
  const [classes, templates] = await Promise.all([
    db.class.count({ where: { teacherRoom: { roomId } } }),
    db.classTemplate.count({ where: { teacherRoom: { roomId } } }),
  ]);
  return { classes, templates };
}
