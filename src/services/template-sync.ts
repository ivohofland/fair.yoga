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

export interface TemplateSyncResult {
  /** Instances updated in place. */
  synced: number;
  /**
   * Wrong-day instances removed. The window is refilled on the new day only
   * when the template is active — a paused template's `dayOfWeek` edit still
   * deletes the wrong-day instances and reports that count here, but skips
   * the refill.
   */
  regenerated: number;
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

  const result = await db.$transaction(async (tx) => {
    // Future generated instances; `gt: now` deliberately excludes today —
    // a class hours from starting should not shift under its students.
    //
    // `teacherId` is defence in depth, not a behaviour change: post-#146 a
    // templateId uniquely determines its owner, so every match already belongs
    // to `template.teacherId`. It is here because this is the query that turned
    // #146's squat into a disclosure — the `updateMany` below writes the
    // template's `teacherRoomId`, `roomCost`, `minRate` and `targetRate` onto
    // every row it returns, and rental rates are never shared between teachers.
    // Scoping it means a regression in the create route stays a squat.
    const future = await tx.class.findMany({
      where: { templateId, teacherId: template.teacherId, date: { gt: new Date() } },
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
  });

  // Refill the window after a day change (idempotent — the unique
  // (templateId, date) constraint guards against racing cron runs).
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
  if (result.regenerated > 0 && template.isActive) {
    await generateInstancesForTemplate(db, template);
  }

  return result;
}
