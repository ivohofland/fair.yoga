import type { PrismaClient, ClassStatus } from '@prisma/client';
import { ACTIVE_TEMPLATE_WHERE } from '@/lib/template-selection';

/**
 * Whether a teacher's room link may be archived (issue 76).
 *
 * `TeacherRoom.isArchived` shipped in `e57b8bd` as a display flag: it decided
 * which of two list pages a row appeared on and nothing else read it. This
 * module is what gives it meaning — a room may not be archived while in use,
 * and an archived room accepts no new commitments. The other doors are named
 * by verb rather than counted, because the count is what went stale: this
 * sentence said "three" until fix round 2 added a fourth. They are publish
 * (`class-lifecycle`), resume and move (`class-template-lifecycle`), and
 * create (`POST /api/class-templates`).
 *
 * Framework-agnostic per CLAUDE.md: no HTTP, no `next/*`. The route is a thin
 * wrapper.
 */

/**
 * Classes that block archiving. NOT the complement of
 * `TERMINAL_CLASS_STATUSES` — `draft` is non-terminal and deliberately does
 * not block. A draft is a parked intention with no registrations; it is
 * stopped at the publish door instead (`transitionClass`, reason
 * `ROOM_ARCHIVED`), which is where the room's availability actually matters.
 */
export const BLOCKING_CLASS_STATUSES: readonly ClassStatus[] = Object.freeze(
  ['open', 'in_progress'] as ClassStatus[],
);

// Templates that block archiving come from `ACTIVE_TEMPLATE_WHERE`
// (`lib/template-selection.ts`), imported above and shared with
// `class-generator.ts`. "Would this template put classes into this room?" is
// precisely the question the generator asks when selecting what to run, so
// the two must not be able to answer differently — sharing the constant makes
// divergence impossible rather than merely detectable.

export type RoomBlockers = { classes: number; templates: number };

export type ArchiveRoomResult =
  | { ok: true; action: 'archived' | 'unarchived' | 'unchanged'; isArchived: boolean }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'in_use'; blockers: RoomBlockers };

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The refusal names what blocks it rather than saying "in use", so the teacher
 * knows what to clear — the house style `DUPLICATE_ROOM` and `NOW_SHARED`
 * already follow in `src/app/api/rooms/[id]/route.ts`.
 */
export function describeRoomBlockers(blockers: RoomBlockers): string {
  const parts: string[] = [];
  if (blockers.classes > 0) parts.push(plural(blockers.classes, 'upcoming class', 'upcoming classes'));
  if (blockers.templates > 0) parts.push(plural(blockers.templates, 'recurring class', 'recurring classes'));
  const subject = parts.join(' and ');
  // "uses" only when a single thing is named; two clauses are always plural.
  const verb = parts.length === 1 && blockers.classes + blockers.templates === 1 ? 'uses' : 'use';
  return `${subject} still ${verb} this room.`;
}

export async function setTeacherRoomArchived(
  db: PrismaClient,
  teacherRoomId: string,
  teacherId: string,
  target: 'archived' | 'unarchived',
): Promise<ArchiveRoomResult> {
  const link = await db.teacherRoom.findUnique({ where: { id: teacherRoomId } });
  if (!link) return { ok: false, reason: 'not_found' };
  if (link.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  const archiving = target === 'archived';

  // Before the in-use check, deliberately, and before any write. Issue 98: a
  // retry after a lost response must not undo what the first attempt did.
  // Placing it first also means an already-archived room in use (reachable via
  // the accepted race below) reports `unchanged` rather than a refusal about a
  // state it is already in.
  if (link.isArchived === archiving) {
    return { ok: true, action: 'unchanged', isArchived: link.isArchived };
  }

  // Un-archiving is unconditional. It is the release valve that makes every
  // refusal in this lifecycle recoverable in one action, so it must never
  // acquire a guard of its own.
  if (archiving) {
    const [classes, templates] = await Promise.all([
      db.class.count({
        where: { teacherRoomId, status: { in: [...BLOCKING_CLASS_STATUSES] } },
      }),
      db.classTemplate.count({ where: { teacherRoomId, ...ACTIVE_TEMPLATE_WHERE } }),
    ]);
    if (classes > 0 || templates > 0) {
      return { ok: false, reason: 'in_use', blockers: { classes, templates } };
    }
  }

  // KNOWN-OPEN, and deliberate (spec section 8). The counts above are read
  // before this write, so a class published in another tab in between leaves
  // an archived room holding an `open` class. Accepted rather than locked: the
  // publish guard two doors away already records the reasoning for this exact
  // class of check ("a policy about intent, not an invariant", see
  // class-lifecycle.ts:298-302), losing the race needs two tabs, and the state
  // is recoverable by un-archiving and self-heals when the class completes.
  // A transaction here would NOT help — under read-committed the counts lock
  // nothing — and the alternative is a new FOR UPDATE node in the ordering
  // that `template-lock-order.test.ts` exists to defend.
  await db.teacherRoom.update({
    where: { id: teacherRoomId },
    data: { isArchived: archiving },
  });

  return { ok: true, action: archiving ? 'archived' : 'unarchived', isArchived: archiving };
}
