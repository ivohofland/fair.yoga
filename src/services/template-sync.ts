/**
 * Template → instance propagation. Editing a recurring template used to
 * change future generations only; the up-to-four already-generated
 * instances silently kept the old time and rates.
 *
 * Rule: propagate to generated instances that are still fully mutable —
 * `draft`/`open`, `settingsLocked: false` (no registrations yet), and in
 * the future. Anything a student has touched keeps its settings.
 *
 * A day-of-week change doesn't move classes (a different day is a
 * different class): mutable instances on the wrong day are deleted and
 * the generator refills the window on the new day.
 */

import type { PrismaClient } from '@prisma/client';
import { generateInstancesForTemplate } from './class-generator';
import { countSkipReasons } from '@/lib/generation';
import { setLockTimeout } from '@/lib/db-locks';

export interface TemplateSyncResult {
  /** Instances updated in place. */
  synced: number;
  /**
   * Wrong-day instances **removed**. The window is refilled on the new day only
   * when the template is active — a paused template's `dayOfWeek` edit still
   * deletes the wrong-day instances and reports that count here, but skips
   * the refill.
   *
   * This is a delete count and has never been anything else. It was rendered
   * as "N rescheduled to the new day", which was true only while the refill
   * below could not fail: before #164/#192 it created one row per deleted one.
   * The slot pre-check can now decline every candidate date, so the delete
   * count and the create count are two numbers, and `refilled` is the other
   * one. Do not report this one as an arrival.
   */
  regenerated: number;
  /** Instances the refill actually created on the new day. */
  refilled: number;
  /** Candidate dates the refill skipped because a cancelled instance holds them (#192). */
  blockedByCancelled: number;
  /** Candidate dates the refill skipped because another class holds that slot (#196). */
  slotTaken: number;
  /** Future instances left untouched because bookings locked them. */
  kept: number;
}

export async function syncTemplateInstances(
  db: PrismaClient,
  templateId: string,
): Promise<TemplateSyncResult> {
  const template = await db.classTemplate.findUniqueOrThrow({
    where: { id: templateId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });

  const result = await db.$transaction(
    async (tx) => {
      // One instant for both the pre-lock's `WHERE` and the re-read below.
      // Two separate `new Date()` calls would let a class enter the read set
      // that the pre-lock never covered — the ordering hole this closes.
      const now = new Date();

      // Ordered pre-lock (issue 180). `syncTemplateInstances` used to take
      // its `Class` locks in heap order — its same-day `updateMany` below is
      // one statement, and Postgres visits the matching rows in whatever
      // order the planner picks, never the array's — cycling against
      // `deleteStudentAccount`'s ascending `lockClassRow` loop (`gdpr.ts`),
      // reproduced as `40P01` in `docs/lock-order.md`, "The two that do not",
      // and pinned by `template-lock-order.test.ts`. Sorting the id array is
      // inert: the write still visits in plan order, never array order. Only
      // a separate ordered statement fixes it. Same shape as
      // `withdrawWaitingEntriesForTeacher` (`waitlist.ts`), including the
      // re-read that follows.
      await setLockTimeout(tx);
      await tx.$queryRaw`
        SELECT c.id
        FROM "Class" c
        WHERE c."templateId" = ${templateId}
          AND c."teacherId" = ${template.teacherId}
          AND c.date > ${now}
        ORDER BY c.id
        FOR UPDATE OF c
      `;

      // Future generated instances; `gt: now` deliberately excludes today —
      // a class hours from starting should not shift under its students.
      //
      // Re-read UNDER the lock just taken above, not this transaction's
      // first read of these rows. Before the pre-lock existed, this WAS the
      // first read, and it ran unprotected: a registration committing
      // between it and the `updateMany` below could flip `settingsLocked`
      // after this had already decided the class was mutable, so the `kept`
      // guarantee was advisory rather than enforced. The pre-lock closes
      // that window by holding every matching row's lock for the rest of
      // this transaction, so nothing else can commit such a change while
      // this function is still deciding — demonstrated in
      // `template-sync.test.ts`, "does not propagate to a class that became
      // settingsLocked after the pre-lock read".
      //
      // `teacherId` is defence in depth, not a behaviour change: post-#146 a
      // templateId uniquely determines its owner, so every match already belongs
      // to `template.teacherId`. It is here because this is the query that turned
      // #146's squat into a disclosure — the `updateMany` below writes the
      // template's `teacherRoomId`, `roomCost`, `minRate` and `targetRate` onto
      // every row it returns, and rental rates are never shared between teachers.
      // Scoping it means a regression in the create route stays a squat.
      const future = await tx.class.findMany({
        where: { templateId, teacherId: template.teacherId, date: { gt: now } },
        select: { id: true, date: true, settingsLocked: true, status: true },
      });

      const mutable = future.filter(
        (c) => !c.settingsLocked && (c.status === 'draft' || c.status === 'open'),
      );
      const kept = future.length - mutable.length;

      // Schema convention 0=Monday; JS getUTCDay() 0=Sunday.
      const templateJsDay = (template.dayOfWeek + 1) % 7;
      const wrongDay = mutable.filter((c) => c.date.getUTCDay() !== templateJsDay);
      const sameDay = mutable.filter((c) => c.date.getUTCDay() === templateJsDay);

      if (wrongDay.length > 0) {
        // `WaitlistEntry.class` cascades, so this delete destroys queues too —
        // and unlike the three paths #112 fixed, it tells nobody. It is safe
        // only because of the `!settingsLocked` filter above: joining a waitlist
        // requires the class to be full (`addToWaitlist`), full requires at
        // least one registration (`maxStudents` is `.positive()`), and the first
        // registration latches `settingsLocked: true` one way and never back. So
        // a class that ever carried a waiter is in `kept`, never here.
        //
        // Relax that filter and this becomes a fourth silent path. Tripwire, not
        // decoration.
        await tx.class.deleteMany({ where: { id: { in: wrongDay.map((c) => c.id) } } });
      }

      if (sameDay.length > 0) {
        await tx.class.updateMany({
          where: { id: { in: sameDay.map((c) => c.id) } },
          data: {
            teacherRoomId: template.teacherRoomId,
            classType: template.classType,
            description: template.description,
            startTime: template.startTime,
            durationMinutes: template.durationMinutes,
            roomCost: template.roomCost,
            minRate: template.minRate,
            targetRate: template.targetRate,
            minStudents: template.minStudents,
            maxStudents: template.maxStudents,
            cancelDeadline: template.cancelDeadline,
            autoCancelCheck: template.autoCancelCheck,
          },
        });
      }

      return { synced: sameDay.length, regenerated: wrongDay.length, kept };
    },
    // Temporary. This inner transaction runs on Prisma's 5s default budget
    // (no `timeout` was ever set here), and the pre-lock above now adds a
    // bounded-but-real `LOCK_TIMEOUT_SQL` (2s) wait inside it — headroom that
    // was never sized for that wait plus everything else in this
    // transaction. 15s is a stopgap, not a considered budget: Task 6 deletes
    // this transaction entirely and moves the budget to the caller.
    { timeout: 15_000 },
  );

  // Refill the window after a day change. Idempotent, but not by the
  // `(templateId, date)` constraint alone any more: `generateInstancesForTemplate`
  // pre-checks occupancy and inserts with a bare `ON CONFLICT DO NOTHING`, so a
  // racing cron run costs one date rather than the transaction (#164).
  //
  // The result is **consumed**, not discarded. It used to be safe to drop
  // because the refill created one row per deleted row; since #196's slot
  // pre-check it can decline every candidate date, and the caller renders these
  // numbers to the teacher who just lost the old ones.
  //
  // Per-template, not the cron/teacher-wide `generateClassInstances`: this
  // runs on a request path, not a job, so a failure here must not become a
  // 500 for an edit to a template the caller never touched. The teacher-wide
  // generator is documented (`class-generator.ts`) as existing for job-health
  // visibility — it throws so `scheduler.ts` can catch, log, and record the
  // failure — and it would top up every active template this teacher owns,
  // so an unrelated template's generation failure would surface as a failure
  // of this edit. `generateInstancesForTemplate` is scoped to the one
  // template actually edited, and documented as accepting a transaction
  // client precisely so a caller can compose it — which is what would close
  // the seam described above, if that ever happens.
  const refill =
    result.regenerated > 0 && template.isActive
      ? await generateInstancesForTemplate(db, template)
      : { created: 0, skipped: [] };

  // `countSkipReasons` (`@/lib/generation`) is the one place
  // `blockedByCancelled`/`slotTaken` are reduced from `refill.skipped` — see
  // its docblock for why a fifth `SkipReason` fails the build here instead
  // of vanishing.
  return {
    ...result,
    refilled: refill.created,
    ...countSkipReasons(refill.skipped),
  };
}
