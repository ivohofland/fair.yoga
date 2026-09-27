import { Prisma, type ClassStatus, type PrismaClient } from '@prisma/client';
import { lockClassRowsOrdered, setLockTimeout, statusInList } from '@/lib/db-locks';
import { sameRoomIdentity } from '@/lib/room-identity';
import { log } from '@/lib/log';

/**
 * Moving a teacher from their private room onto the already-shared room with
 * the same identity (issue 259). The rules — what moves, what stays, which
 * link values survive — and the reasoning behind the lock order are in
 * `docs/superpowers/specs/2026-09-26-switch-to-shared-room-design.md`; the
 * lock order itself is recorded in `docs/lock-order.md` ("Switching to a
 * shared room").
 *
 * Framework-agnostic: the route `POST /api/teacher-rooms/[id]/switch` maps
 * `SwitchRoomResult` to responses.
 */

export type SwitchRoomInput = {
  teacherId: string;
  /** The PRIVATE link being retired. */
  teacherRoomId: string;
  /** The SHARED `Room` being moved onto. */
  sharedRoomId: string;
};

export type SwitchRoomResult =
  | {
      ok: true;
      action: 'switched';
      /** The shared room's link — created, or the one the teacher already had. */
      sharedTeacherRoomId: string;
      moved: { templates: number; classes: number };
      reusedLink: boolean;
      capacityClamped: { from: number; to: number } | null;
    }
  | { ok: true; action: 'unchanged'; sharedTeacherRoomId: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'now_shared' }
  | { ok: false; reason: 'shared_room_not_found' }
  | { ok: false; reason: 'not_same_room' }
  | { ok: false; reason: 'class_in_progress' };

type Refusal = Extract<SwitchRoomResult, { ok: false }>;

/** Thrown inside the transaction so a refusal found after a write rolls it back. */
class SwitchRefused extends Error {
  constructor(readonly result: Refusal) {
    super(`room switch refused: ${result.reason}`);
  }
}

/** The statuses that move: `in_progress` is a class already under way, kept
 *  out by decision (spec §1.3) and refused separately at step 4. */
const MOVING_STATUSES = ['draft', 'open'] as const satisfies readonly ClassStatus[];

/** The classes that move: upcoming, not cancelled. `entryLive` is the
 *  cancellation mirror on the `Class` row (#339). This is what the unchanged
 *  check (below) counts; what actually moves is step 4's lock set once it has
 *  refused `in_progress`, which is this same predicate. */
const MOVING_CLASS_WHERE = {
  status: { in: [...MOVING_STATUSES] },
  entryLive: true,
} satisfies Prisma.ClassWhereInput;

export async function switchToSharedRoom(
  db: PrismaClient,
  input: SwitchRoomInput,
): Promise<SwitchRoomResult> {
  const { teacherId, teacherRoomId, sharedRoomId } = input;

  // Ownership before any lock: a request about another teacher's link must
  // not take row locks on that teacher's templates.
  const pre = await db.teacherRoom.findUnique({ where: { id: teacherRoomId } });
  if (!pre) return { ok: false, reason: 'not_found' };
  if (pre.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  try {
    return await db.$transaction(async (tx) => {
      await setLockTimeout(tx);

      // 1. Templates before links — the order archiving uses, and the one the
      //    generator's claim implies (`docs/lock-order.md`).
      await tx.$queryRaw`
        SELECT ct."id" FROM "ClassTemplate" ct
        WHERE ct."teacherRoomId" = ${teacherRoomId}
        ORDER BY ct."id"
        FOR UPDATE`;

      // 2. The private link, then every guard again against what is locked.
      await tx.$queryRaw`
        SELECT "id" FROM "TeacherRoom" WHERE "id" = ${teacherRoomId} FOR UPDATE`;
      const priv = await tx.teacherRoom.findUnique({
        where: { id: teacherRoomId },
        include: { room: true },
      });
      if (!priv) throw new SwitchRefused({ ok: false, reason: 'not_found' });
      if (priv.room.isPublic) throw new SwitchRefused({ ok: false, reason: 'now_shared' });
      const shared = await tx.room.findUnique({ where: { id: sharedRoomId } });
      if (!shared || !shared.isPublic) {
        throw new SwitchRefused({ ok: false, reason: 'shared_room_not_found' });
      }
      if (!sameRoomIdentity(priv.room, shared)) {
        throw new SwitchRefused({ ok: false, reason: 'not_same_room' });
      }

      // Already switched: nothing left on the private link, and a usable
      // link on the shared room. After every refusal that makes the goal
      // moot or invalid, before any write.
      const existing = await tx.teacherRoom.findUnique({
        where: { teacherId_roomId: { teacherId, roomId: sharedRoomId } },
      });
      if (priv.isArchived && existing && !existing.isArchived) {
        const templatesLeft = await tx.classTemplate.count({ where: { teacherRoomId } });
        const classesLeft = await tx.class.count({ where: { teacherRoomId, ...MOVING_CLASS_WHERE } });
        if (templatesLeft === 0 && classesLeft === 0) {
          return { ok: true, action: 'unchanged', sharedTeacherRoomId: existing.id };
        }
      }

      // 3. The shared link: insert if absent, then hold it. Held before any
      //    class moves, so the move's foreign-key check waits on nothing.
      const capacity = Math.min(priv.capacityOverride, shared.maxCapacity);
      const inserted = await tx.teacherRoom.createMany({
        data: [{
          teacherId,
          roomId: sharedRoomId,
          capacityOverride: capacity,
          rentalRate: priv.rentalRate,
          equipmentNotes: priv.equipmentNotes,
        }],
        skipDuplicates: true,
      });
      const [target] = await tx.$queryRaw<Array<{ id: string; isArchived: boolean }>>`
        SELECT "id", "isArchived" FROM "TeacherRoom"
        WHERE "teacherId" = ${teacherId} AND "roomId" = ${sharedRoomId}
        FOR UPDATE`;
      if (!target) {
        throw new Error(
          `switchToSharedRoom: no link from teacher ${teacherId} to shared room ${sharedRoomId} ` +
            `right after this transaction's insert-if-absent (private link ${teacherRoomId})`,
        );
      }
      if (target.isArchived) {
        await tx.teacherRoom.update({ where: { id: target.id }, data: { isArchived: false } });
      }

      // 4. The private link's classes.
      //
      // VERDICT (#327): this transaction writes `Class.teacherRoomId` and
      // `roomArchived` and no entry column, so it takes the `Class` rows and
      // stops there. Cancellation is read from `entryLive` on the locked row,
      // not from a join, so a cancel that lands while this waits is re-checked.
      const lockedIds = await lockClassRowsOrdered(tx, {
        where: Prisma.sql`c."teacherRoomId" = ${teacherRoomId}
          AND c.status IN (${statusInList([...MOVING_STATUSES, 'in_progress'])})
          AND c."entryLive"`,
      });
      const running = await tx.class.count({
        where: { id: { in: lockedIds }, status: 'in_progress' },
      });
      if (running > 0) throw new SwitchRefused({ ok: false, reason: 'class_in_progress' });

      // 5. Move them, keyed on the locked ids alone, so the write set is a
      //    structural subset of the lock set (`lockClassRowsOrdered`'s
      //    docblock). No `in_progress` id survives the refusal above, so the
      //    set is exactly the upcoming classes. The mirror is written in the
      //    same statement: the cascade fires on the parent, never on a child
      //    that repoints.
      const movedClasses = await tx.class.updateMany({
        where: { id: { in: lockedIds } },
        data: { teacherRoomId: target.id, roomArchived: false },
      });

      // 6. Every template, by predicate rather than by the step-1 id set: the
      //    private link's lock (step 2) is what stops a new arrival, and a
      //    template moved onto it between steps 1 and 2 must go too.
      const movedTemplates = await tx.classTemplate.updateMany({
        where: { teacherRoomId },
        data: { teacherRoomId: target.id, roomArchived: false },
      });

      // 7. Retire the private link. Only terminal rows point at it now.
      await tx.teacherRoom.update({ where: { id: teacherRoomId }, data: { isArchived: true } });

      const reusedLink = inserted.count === 0;
      return {
        ok: true,
        action: 'switched',
        sharedTeacherRoomId: target.id,
        moved: { templates: movedTemplates.count, classes: movedClasses.count },
        reusedLink,
        capacityClamped:
          !reusedLink && capacity < priv.capacityOverride
            ? { from: priv.capacityOverride, to: capacity }
            : null,
      };
    });
  } catch (e) {
    if (e instanceof SwitchRefused) {
      // Not decoration: `respondError` does not log, so this line is the only
      // record of the refusals thrown inside this transaction (guards 2-7 and
      // `class_in_progress`). The pre-transaction `not_found`/`forbidden`
      // refusals above return directly and are unlogged.
      log.info({ teacherId, teacherRoomId, sharedRoomId, reason: e.result.reason }, 'room switch refused');
      return e.result;
    }
    throw e;
  }
}
