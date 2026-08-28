import type { PrismaClient, ClassStatus } from '@prisma/client';
import { ACTIVE_TEMPLATE_WHERE } from '@/lib/template-selection';
import { isCheckViolationOn } from '@/lib/check-violation';
import { log } from '@/lib/log';

/**
 * Whether a teacher's room link may be archived (issue 76).
 *
 * `TeacherRoom.isArchived` shipped in `e57b8bd` as a display flag: it decided
 * which of two list pages a row appeared on and nothing else read it. This
 * module is what gives it meaning for the CLASS half — a room may not be
 * archived while it still honours a commitment — and `describeRoomBlockers`
 * turns the counts that refuse archiving into a sentence a teacher can clear.
 *
 * The TEMPLATE half of that refusal used to be a count here too; issue 272 made
 * it the database's own rule instead. `ClassTemplate_live_needs_open_room`
 * refuses every write that would leave a live template on an archived room, so
 * the count below is no longer load-bearing for the template clause — it is
 * kept because the constraint is a refusal a teacher cannot see, and this
 * module still produces the words for it. The doors are named by verb rather
 * than counted, because the count is what went stale: this sentence said
 * "three" until fix round 2 added a fourth. They are publish
 * (`class-lifecycle`), resume and move (`class-template-lifecycle`), and
 * create (`POST /api/class-templates`) — each of the last three now just a
 * probe in front of the constraint that enforces it.
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
 *
 * A STATUS LIST IS NO LONGER THE WHOLE PREDICATE. Cancellation left
 * `ClassStatus` in #327, so a cancelled class still matches both members here
 * and the caller has to ask the entry as well — hand-declared lists like this
 * one are exactly where an enum shrink changes what a filter MEANS without
 * changing what it compiles to.
 */
export const BLOCKING_CLASS_STATUSES: readonly ClassStatus[] = Object.freeze(
  ['open', 'in_progress'] as ClassStatus[],
);

// Templates that block archiving come from `ACTIVE_TEMPLATE_WHERE`
// (`lib/template-selection.ts`), imported above and shared with
// `class-generator.ts`. "Would this template put classes into this room?" is
// precisely the question the generator asks when selecting what to run, so
// the two must not be able to answer differently — sharing the constant means
// divergence takes a deliberate edit at a call site rather than a silent drift
// apart. NOT "impossible", which both this comment and
// `template-selection.ts` claimed until PR review disproved it: re-inlining
// the predicate at `class-generator.ts` and dropping the `isArchived` half
// compiles clean and leaves `template-selection.test.ts` green, because that
// test pins the constant's VALUE and never that either consumer reads it.
// What actually catches that edit is behavioural — `class-generator.test.ts`'s
// stale-`isActive` case and its mirror in `room-archive.test.ts`.

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
  // `RoomBlockers` admits `{ classes: 0, templates: 0 }`, so this function is
  // callable with a state its one caller never produces (the `in_use` return
  // is guarded on a non-zero count). Unreachable is not the same as safe: the
  // precedent one module over is `class-lifecycle.ts`'s `locked`, which
  // carries a NON-EMPTY tuple deliberately, because the bug it replaced (#72)
  // shipped a "locked" response naming no fields. Without this line the empty
  // case renders " still use this room." — a sentence with no subject.
  if (blockers.classes + blockers.templates === 0) return 'This room is still in use.';

  const parts: string[] = [];
  // "unfinished", not "upcoming": `BLOCKING_CLASS_STATUSES` is
  // `open`/`in_progress` with NO date bound, and CLAUDE.md records that the
  // generator legitimately produces an `open` class whose start has already
  // passed. An `in_progress` class is happening now, not upcoming. Calling
  // either "upcoming" sent a teacher looking for something their schedule does
  // not show, with no way to clear the block.
  if (blockers.classes > 0)
    parts.push(plural(blockers.classes, 'unfinished class', 'unfinished classes'));
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
      // `calendarEntry: { cancelledAt: null }` beside the statuses (#327). A
      // cancelled class keeps its `open`/`in_progress` status now, and a class
      // the teacher has already called off is not a commitment the room still
      // has to honour — before this branch, cancelling was how a teacher
      // cleared exactly this blocker.
      db.class.count({
        where: {
          teacherRoomId,
          status: { in: [...BLOCKING_CLASS_STATUSES] },
          calendarEntry: { cancelledAt: null },
        },
      }),
      db.classTemplate.count({ where: { teacherRoomId, ...ACTIVE_TEMPLATE_WHERE } }),
    ]);
    if (classes > 0 || templates > 0) {
      // Not decoration. `respondError` does not log and `withErrorHandler`
      // logs only on `throw`, which this path does not do — so without this
      // line the only record of a refusal is a 409 body the teacher reads and
      // nobody keeps. Same reasoning the `STARTS_IN_PAST` refusal states in
      // `transitionClass` (`class-lifecycle.ts`) and the template-move
      // refusal states in `class-template-lifecycle.ts` ("template move
      // refused: the target room is archived", door 5). That second citation
      // was `sync_conflict` at a line number until #194 deleted the
      // propagation that raised it — named by its log line this time, since
      // the number is the half that rots. It matters most here: the accepted
      // race below can leave an archived room holding an `open` class, and
      // without a line on this side there is nothing to correlate that state
      // against afterwards.
      log.info(
        { teacherRoomId, teacherId, blockers: { classes, templates } },
        'room archive refused: the room is still in use',
      );
      return { ok: false, reason: 'in_use', blockers: { classes, templates } };
    }
  }

  // KNOWN-OPEN, and deliberate (spec section 8), now on the CLASS side only.
  // The counts above are read before this write, so a class published in
  // another tab in between leaves an archived room holding an `open` class.
  // Accepted rather than locked: the publish guard two doors away already
  // records the reasoning for this exact class of check ("a policy about
  // intent, not an invariant", see class-lifecycle.ts:303-304), losing the
  // race needs two tabs, and the state is recoverable by un-archiving and
  // self-heals when the class completes. A transaction here would NOT help —
  // under read-committed the counts lock nothing — and the alternative is a
  // new FOR UPDATE node in the ordering that `template-lock-order.test.ts`
  // exists to defend.
  //
  // The TEMPLATE half of the race was closed, not accepted, in issue 272: a
  // template resumed between the counts and this write makes the write's own
  // cascade to the child row trip `ClassTemplate_live_needs_open_room`, so
  // the archive is refused by the constraint (below) exactly as if the count
  // had seen it. The class half is what stays racy — the class invariant is
  // deliberately out of scope (spec section 8).
  try {
    await db.teacherRoom.update({
      where: { id: teacherRoomId },
      data: { isArchived: archiving },
    });
  } catch (e) {
    // The counts above are read before this write, so a template resumed in
    // between is invisible to them — this is that window closing (issue 272),
    // and it is now a refusal rather than a wrong success. `blockers` is
    // reported as the counts saw it: zero, which is honest about what this
    // function measured rather than inventing a number it did not.
    if (isCheckViolationOn(e, 'ClassTemplate_live_needs_open_room')) {
      log.info(
        { teacherRoomId, teacherId },
        'room archive refused by the constraint: a template went live mid-request',
      );
      return { ok: false, reason: 'in_use', blockers: { classes: 0, templates: 0 } };
    }
    throw e;
  }

  return { ok: true, action: archiving ? 'archived' : 'unarchived', isArchived: archiving };
}
