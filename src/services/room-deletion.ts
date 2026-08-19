import type { PrismaClient } from '@prisma/client';

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
 * permanent as class history and has the identical remedy. Wording that named
 * the cause would be right half the time and would imply, wrongly, that the
 * teacher can clear it. Same reasoning `classifyApiError` states for the two
 * terminality triggers ("any wording that names one column is wrong half the
 * time").
 */
export const ROOM_DELETE_BLOCKED_MESSAGE =
  'Cannot delete a room with class history. Archive it instead.';

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
