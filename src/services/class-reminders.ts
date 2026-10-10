import type { PrismaClient, ReminderChannel, ReminderTiming } from '@prisma/client';
import { readInPages } from '@/lib/read-in-pages';
import { classStartInstant } from '@/lib/timezone';
import { reminderMoment } from '@/lib/reminder-moment';
import { formatDayHeader } from '@/lib/format';
import { timeToHHmm } from '@/lib/time-of-day';
import { renderNotificationEmail, CLASS_REMINDER_EMAIL_FOOTER } from '@/lib/email-templates';
import { sendEmail } from '@/lib/email';
import { unsubscribeLinks } from '@/lib/unsubscribe-token';
import { log } from '@/lib/log';
import { createNotification } from './notifications';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ClassReminderResult {
  studentReminders: number;
  teacherReminders: number;
  emailFailures: number;
}

function utcMidnight(ms: number): Date {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Entry dates that can hold a due reminder at `now`: wide enough, under any
 * zone offset, for a class not yet started (the lower bound) and for the
 * earliest moment, evening-before (the upper). The moment check narrows it.
 */
export function reminderCandidateDates(now: Date): { from: Date; to: Date } {
  return { from: utcMidnight(now.getTime() - 2 * DAY_MS), to: utcMidnight(now.getTime() + 3 * DAY_MS) };
}

function readCandidatePage(db: PrismaClient, from: Date, to: Date, afterId: string | undefined, take: number) {
  return db.class.findMany({
    where: {
      status: 'open',
      calendarEntry: { cancelledAt: null, date: { gte: from, lte: to }, teacher: { deletedAt: null } },
      ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: 'asc' },
    take,
    select: {
      id: true,
      createdAt: true,
      teacherReminderSentAt: true,
      calendarEntry: {
        select: {
          classType: true,
          date: true,
          startTime: true,
          teacherId: true,
          teacher: {
            select: { firstName: true, email: true, defaultTimezone: true, classReminder: true, classReminderChannel: true },
          },
        },
      },
    },
  });
}
type Candidate = Awaited<ReturnType<typeof readCandidatePage>>[number];

const wantsInbox = (c: ReminderChannel) => c !== 'email';
const wantsEmail = (c: ReminderChannel) => c !== 'inbox';

/**
 * The moment of a reminder at `timing` when it is due at `now` for something
 * created at `createdAt`; `null` when it is not due.
 */
function dueMoment(
  entry: Candidate['calendarEntry'],
  timing: ReminderTiming,
  createdAt: Date,
  start: Date,
  now: Date,
): Date | null {
  const moment = reminderMoment(entry, entry.teacher.defaultTimezone, timing);
  return moment !== null && moment <= now && now < start && createdAt < moment ? moment : null;
}

/**
 * The class's liveness (open, entry not cancelled), restated in each claim
 * because the candidate read can be a whole tick of sends old by the time a
 * later class is claimed. The schedule and the teacher's erasure are judged on
 * the read.
 */
const LIVE_CLASS = { status: 'open', calendarEntry: { cancelledAt: null } } as const;

/**
 * Renders and sends one reminder email and reports whether it went out. Never
 * throws: the stamp has already committed, so a failure — reported or thrown,
 * rendering included — is logged and not retried.
 */
async function emailReminder(
  to: string,
  recipientType: 'student' | 'teacher',
  title: string,
  body: string,
  context: { classId: string; recipientId: string },
): Promise<boolean> {
  try {
    const target = {
      kind: recipientType === 'student' ? 'student_reminders' : 'teacher_reminders',
      subjectId: context.recipientId,
    } as const;
    const content = renderNotificationEmail(
      { type: 'class_reminder', title, body, recipientType },
      undefined,
      CLASS_REMINDER_EMAIL_FOOTER,
      unsubscribeLinks(target)?.page,
    );
    const result = await sendEmail({ to, audience: 'class', content, unsubscribe: target });
    if (!result.ok) {
      log.error({ ...context, recipientType, reason: result.reason }, 'class reminder email failed; not retried');
    }
    return result.ok;
  } catch (err) {
    log.error({ ...context, recipientType, err }, 'class reminder email failed; not retried');
    return false;
  }
}

export async function processClassReminders(db: PrismaClient, now: Date = new Date()): Promise<ClassReminderResult> {
  const result: ClassReminderResult = { studentReminders: 0, teacherReminders: 0, emailFailures: 0 };
  const { from, to } = reminderCandidateDates(now);
  const classes = await readInPages<Candidate>((after, take) => readCandidatePage(db, from, to, after?.id, take));

  // One class failing must not starve the classes after it in `id` order: a
  // failure on the same row would otherwise recur on every tick.
  let classFailures = 0;
  for (const cls of classes) {
    try {
      await remindForClass(db, cls, now, result);
    } catch (err) {
      classFailures++;
      log.error({ classId: cls.id, err }, 'class reminders failed for this class; the sweep carries on');
    }
  }

  // Surface failures to the caller once the whole sweep has run: the scheduler
  // records this as lastError, so /api/health cannot show green through a send
  // outage. Every claim this sweep made has already committed, so throwing here
  // changes no retry: a failed email stays sent-once, and a failed class's
  // uncommitted claim is due again on the next tick.
  if (result.emailFailures > 0 || classFailures > 0) {
    throw new Error(
      `class reminders: ${result.emailFailures} reminder email(s) failed and will not be retried, ` +
        `${classFailures} class(es) failed (${result.studentReminders} student, ` +
        `${result.teacherReminders} teacher reminders claimed)`,
    );
  }
  return result;
}

/**
 * One class's due reminders: each student's claim, then the teacher's. Counts
 * into `result` as it claims, so a throw part-way keeps what already went out.
 */
async function remindForClass(db: PrismaClient, cls: Candidate, now: Date, result: ClassReminderResult): Promise<void> {
  const entry = cls.calendarEntry;
  const start = classStartInstant(entry, entry.teacher.defaultTimezone);
  if (Number.isNaN(start.getTime())) {
    log.error({ classId: cls.id }, 'class reminders: unreadable class start; skipped');
    return;
  }
  if (now >= start) return;
  const when = `${entry.classType} on ${formatDayHeader(entry.date)} at ${timeToHHmm(entry.startTime)}`;

  const registrations = await db.registration.findMany({
    where: { classId: cls.id, status: 'registered', classReminderSentAt: null, student: { deletedAt: null } },
    select: { id: true, registeredAt: true, student: { select: { id: true, email: true, classReminder: true, classReminderChannel: true } } },
  });
  for (const reg of registrations) {
    const { student } = reg;
    const moment = dueMoment(entry, student.classReminder, reg.registeredAt, start, now);
    if (moment === null) continue;
    const title = 'Class reminder';
    const body = `Your ${when} with ${entry.teacher.firstName}.`;
    const claimed = await db.$transaction(async (tx) => {
      // `Class` before `Registration`, the order `docs/lock-order.md` fixes:
      // the inbox row's `relatedClassId` takes this same lock, and taken there
      // it would land after the registration's.
      await tx.$queryRaw`SELECT 1 FROM "Class" WHERE id = ${cls.id} FOR KEY SHARE`;
      const { count } = await tx.registration.updateMany({
        where: {
          id: reg.id,
          status: 'registered',
          classReminderSentAt: null,
          registeredAt: { lt: moment },
          class: LIVE_CLASS,
        },
        data: { classReminderSentAt: now },
      });
      if (count === 0) return false;
      if (wantsInbox(student.classReminderChannel)) {
        await createNotification(tx, {
          recipientType: 'student', recipientId: student.id, type: 'class_reminder',
          title, body, relatedClassId: cls.id, emailSent: true,
        });
      }
      return true;
    });
    if (!claimed) continue;
    result.studentReminders++;
    if (
      wantsEmail(student.classReminderChannel) &&
      !(await emailReminder(student.email, 'student', title, body, { classId: cls.id, recipientId: student.id }))
    ) {
      result.emailFailures++;
    }
  }

  const { teacher } = entry;
  if (cls.teacherReminderSentAt === null && dueMoment(entry, teacher.classReminder, cls.createdAt, start, now) !== null) {
    const title = 'Class reminder';
    const registered = await db.registration.count({ where: { classId: cls.id, status: 'registered' } });
    const body = `${when} — ${registered} registered so far.`;
    const claimed = await db.$transaction(async (tx) => {
      const { count } = await tx.class.updateMany({
        where: { id: cls.id, teacherReminderSentAt: null, ...LIVE_CLASS },
        data: { teacherReminderSentAt: now },
      });
      if (count === 0) return false;
      if (wantsInbox(teacher.classReminderChannel)) {
        await createNotification(tx, {
          recipientType: 'teacher', recipientId: entry.teacherId, type: 'class_reminder',
          title, body, relatedClassId: cls.id, emailSent: true,
        });
      }
      return true;
    });
    if (claimed) {
      result.teacherReminders++;
      if (
        wantsEmail(teacher.classReminderChannel) &&
        !(await emailReminder(teacher.email, 'teacher', title, body, { classId: cls.id, recipientId: entry.teacherId }))
      ) {
        result.emailFailures++;
      }
    }
  }
}
