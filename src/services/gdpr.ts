/**
 * GDPR — data export (Art. 15/20) and account erasure (Art. 17).
 *
 * Erasure strategy: ANONYMIZE, don't cascade-delete. Registrations,
 * payments, and completed classes are the *other party's* bookkeeping
 * (Art. 17(3)(b) legal-obligation grounds) — hard deletes would destroy a
 * teacher's revenue history or a student's payment obligations. Personal
 * fields are wiped and the rows keep their financial meaning; anonymized
 * data falls outside the GDPR (Recital 26).
 */

import { DEFAULT_INCOME_TIER } from '@/lib/tiers';
import { Prisma } from '@prisma/client';
import type { PrismaClient, ClassStatus } from '@prisma/client';
import { createBulkNotifications, type CreateNotificationInput } from './notifications';
import { formatDayHeader } from '@/lib/format';
import { timeToHHmm } from '@/lib/time-of-day';
import { completeClass } from './class-lifecycle';
import { handleSpotFreed, reorderWaitingEntries } from './waitlist';
import { lockClassRowsOrdered, setLockTimeout } from '@/lib/db-locks';
import { isTransientDbError } from '@/lib/api-errors';
import { log } from '@/lib/log';
import { startOfLocalDay } from '@/lib/timezone';
import { withSlot as withClassSlot } from './class-template-lifecycle';
import { withSlot as withStudioSlot } from './studio-class-template-lifecycle';

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Everything we hold about a student, in portable JSON. */
export async function exportStudentData(db: PrismaClient, studentId: string) {
  const student = await db.student.findUniqueOrThrow({
    where: { id: studentId },
    include: {
      studentPrivacy: {
        include: { teacher: { select: { firstName: true, lastName: true, pageSlug: true } } },
      },
      teacherStudents: {
        include: { teacher: { select: { firstName: true, lastName: true, pageSlug: true } } },
      },
      registrations: {
        include: {
          class: {
            select: {
              status: true,
              // The calendar identity moved to the entry (#327), the teacher
              // with it. `cancelledAt` is selected because `status` can no
              // longer carry a cancellation, and an Art. 15 export that stops
              // saying a class was called off has lost a fact.
              calendarEntry: {
                select: {
                  classType: true,
                  date: true,
                  startTime: true,
                  cancelledAt: true,
                  teacher: { select: { firstName: true, lastName: true } },
                },
              },
            },
          },
          payment: { select: { amount: true, status: true, method: true, paidAt: true } },
        },
      },
      waitlistEntries: {
        include: {
          class: {
            select: {
              calendarEntry: { select: { classType: true, date: true, startTime: true } },
            },
          },
        },
      },
    },
  });

  const notifications = await db.notification.findMany({
    where: { recipientType: 'student', recipientId: studentId },
    select: { type: true, title: true, body: true, isRead: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  // Keyed by address, not by `studentId` — a teacher can type an address into
  // their CRM before (or without) the owner ever holding a Student row, which
  // is the whole point of `Invitation` being a separate table. The match
  // below needs no case-normalisation: all six email columns — Account,
  // Teacher, Student, MagicLinkToken, Invitation, TeacherBlock — are
  // lowercase by `*_email_lowercase_check` (#170).
  const subjectEmail = student.email;
  const invitations = await db.invitation.findMany({
    where: { email: subjectEmail },
    select: {
      status: true,
      firstName: true,
      lastName: true,
      createdAt: true,
      respondedAt: true,
      teacher: { select: { firstName: true, lastName: true, pageSlug: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  const blocks = await db.teacherBlock.findMany({
    where: { email: subjectEmail },
    select: {
      createdAt: true,
      teacher: { select: { firstName: true, lastName: true, pageSlug: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  return {
    exportedAt: new Date().toISOString(),
    format: 'fair.yoga student data export v1',
    profile: {
      firstName: student.firstName,
      lastName: student.lastName,
      email: student.email,
      incomeTier: student.incomeTier,
      phone: student.phone,
      birthday: student.birthday,
      address: student.address,
      reminderPref: student.reminderPref,
      emailNotifications: student.emailNotifications,
      createdAt: student.createdAt,
    },
    privacySettings: student.studentPrivacy.map((p) => ({
      teacher: `${p.teacher.firstName} ${p.teacher.lastName}`,
      shareFullName: p.shareFullName,
      shareEmail: p.shareEmail,
      sharePhone: p.sharePhone,
      shareBirthday: p.shareBirthday,
      shareAddress: p.shareAddress,
      receiveComms: p.receiveComms,
    })),
    teachers: student.teacherStudents.map((t) => ({
      teacher: `${t.teacher.firstName} ${t.teacher.lastName}`,
      page: t.teacher.pageSlug,
      since: t.createdAt,
    })),
    bookings: student.registrations.map((r) => ({
      class: r.class.calendarEntry.classType,
      teacher: `${r.class.calendarEntry.teacher.firstName} ${r.class.calendarEntry.teacher.lastName}`,
      date: r.class.calendarEntry.date,
      startTime: timeToHHmm(r.class.calendarEntry.startTime),
      status: r.status,
      classCancelledAt: r.class.calendarEntry.cancelledAt,
      tierAtBooking: r.tierAtBooking,
      price: r.price,
      payment: r.payment,
      registeredAt: r.registeredAt,
    })),
    waitlist: student.waitlistEntries.map((w) => ({
      class: w.class.calendarEntry.classType,
      date: w.class.calendarEntry.date,
      status: w.status,
      position: w.position,
    })),
    // Records held ABOUT the subject rather than created by them: a teacher
    // typed their address into a CRM and guessed at their name. `nameTheyUsed`
    // is that guess — it is not the subject's own profile name and can differ
    // from it, so the export has to show it rather than fold it into
    // `profile`.
    invitations: invitations.map((i) => ({
      teacher: `${i.teacher.firstName} ${i.teacher.lastName}`,
      page: i.teacher.pageSlug,
      nameTheyUsed: `${i.firstName} ${i.lastName}`.trim(),
      status: i.status,
      invitedAt: i.createdAt,
      respondedAt: i.respondedAt,
    })),
    blockedTeachers: blocks.map((b) => ({
      teacher: `${b.teacher.firstName} ${b.teacher.lastName}`,
      page: b.teacher.pageSlug,
      since: b.createdAt,
    })),
    notifications,
  };
}

/** Everything we hold about a teacher, in portable JSON. */
export async function exportTeacherData(db: PrismaClient, teacherId: string) {
  const teacher = await db.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    include: {
      teacherRooms: { include: { room: true } },
      scheduleRules: { include: { classTemplates: true, studioClassTemplates: true } },
      // Both class families reached through `calendarEntries` now (#327):
      // `Class` and `StudioClass` left `Teacher`'s own relations for the
      // entry's, and each entry carries at most one of either family. Same
      // shape as `scheduleRules` above, one layer down.
      calendarEntries: {
        include: {
          classes: { include: { _count: { select: { registrations: true } } } },
          studioClasses: true,
        },
      },
      announcements: true,
    },
  });

  const notifications = await db.notification.findMany({
    where: { recipientType: 'teacher', recipientId: teacherId },
    select: { type: true, title: true, body: true, isRead: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  return {
    exportedAt: new Date().toISOString(),
    format: 'fair.yoga teacher data export v1',
    profile: {
      firstName: teacher.firstName,
      lastName: teacher.lastName,
      email: teacher.email,
      bio: teacher.bio,
      pageSlug: teacher.pageSlug,
      defaultCurrency: teacher.defaultCurrency,
      defaultTimezone: teacher.defaultTimezone,
      bankIban: teacher.bankIban,
      bankAccountName: teacher.bankAccountName,
      createdAt: teacher.createdAt,
    },
    rooms: teacher.teacherRooms.map((tr) => ({
      venue: tr.room.venueName,
      room: tr.room.roomName,
      address: `${tr.room.address}, ${tr.room.city}`,
      rentalRate: tr.rentalRate,
      capacity: tr.capacityOverride,
    })),
    // Both template families reached via `scheduleRules` now (issue 298) —
    // `classTemplates`/`studioClassTemplates` left `Teacher`'s own relations
    // for the rule's, and each rule carries at most one of either family.
    recurringTemplates: teacher.scheduleRules.flatMap((r) =>
      r.classTemplates.map((ct) => withClassSlot(ct, r)),
    ),
    // `cancelledAt` alongside `status` on both families, because since #327
    // `status` cannot say a class was cancelled and an Art. 15 export that
    // stops reporting a cancellation has lost a fact the subject held.
    classes: teacher.calendarEntries.flatMap((e) =>
      e.classes.map((c) => ({
        classType: e.classType,
        date: e.date,
        startTime: timeToHHmm(e.startTime),
        durationMinutes: e.durationMinutes,
        status: c.status,
        cancelledAt: e.cancelledAt,
        registrations: c._count.registrations,
        totalRevenue: c.totalRevenue,
        effectiveTeacherRate: c.effectiveTeacherRate,
      })),
    ),
    studioClasses: teacher.calendarEntries.flatMap((e) =>
      e.studioClasses.map((sc) => ({
        ...sc,
        classType: e.classType,
        date: e.date,
        startTime: timeToHHmm(e.startTime),
        durationMinutes: e.durationMinutes,
        cancelledAt: e.cancelledAt,
      })),
    ),
    studioClassTemplates: teacher.scheduleRules.flatMap((r) =>
      r.studioClassTemplates.map((sct) => withStudioSlot(sct, r)),
    ),
    announcements: teacher.announcements.map((a) => ({
      message: a.message,
      sentAt: a.sentAt,
    })),
    notifications,
  };
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

/**
 * Which profile an erasure is working on.
 *
 * Exported because `DELETE /api/account` decides what its failure message may
 * claim from exactly this distinction and used to re-declare the union inline.
 * Two independent copies of one closed set is a third profile kind compiling
 * cleanly in one file while being silently omitted from the other — and the
 * omitted one is the file that writes the sentence a user reads about their
 * own erasure.
 */
export type ErasureHalf = 'student' | 'teacher';

/**
 * Thrown when an erasure finds the profile already erased.
 *
 * Not a failure: the caller's goal is satisfied, by the request that won. It
 * exists so the transaction ABORTS rather than committing a second, redundant
 * erasure — `deleteStudentAccount` runs `handleSpotFreed` per freed class
 * AFTER its transaction commits, so a second commit would broadcast a second
 * `spot_available` set to every waiting student. Scoping the write alone does
 * not prevent that; only refusing to commit does. `gdpr.test.ts` ("erases
 * once when the same student erasure runs twice concurrently") fails on the
 * doubled broadcast if the scope stays and this throw goes.
 *
 * `DELETE /api/account` maps this to the same 200 a first erasure returns —
 * see that route for why it must not reach `erasureFailure`.
 */
export class AlreadyErasedError extends Error {
  constructor(readonly half: ErasureHalf) {
    super(`${half} profile is already erased`);
    this.name = 'AlreadyErasedError';
  }
}

/**
 * Deletes a student account: personal data wiped, financial history kept.
 * - profile fields anonymized, email replaced with an unroutable unique one
 * - privacy rows, roster links, waitlist entries, notifications, sessions,
 *   magic-link tokens: deleted
 * - `Invitation` rows naming this address anonymized in place, so a teacher's
 *   refusal tombstones survive without the identity behind them
 * - `TeacherBlock` rows left standing on purpose; the tension is written down
 *   at the site and in `docs/data-model.md`
 * - upcoming registrations cancelled (teachers see the spot free up);
 *   charged/past registrations and payments remain, attributed to
 *   "Deleted Student"
 */
export async function deleteStudentAccount(db: PrismaClient, studentId: string): Promise<void> {
  const student = await db.student.findUniqueOrThrow({
    where: { id: studentId },
    select: { email: true, firstName: true, accountId: true },
  });

  const freedClassIds = await db.$transaction(async (tx) => {
    // FIRST statement, unconditionally — not left to a lock helper further down.
    //
    // The bound used to arrive only as a side effect of the old `lockClassRow`
    // loop, which ran only when the list it iterated came back non-empty. That
    // list was `waiting`-only when this paragraph was first written (#174 Task
    // 5, `sortedWaitingClassIds`) and every status by the time the loop was
    // removed (#216/#182, `sortedEntryClassIds`) — NOT the `waitingClassIds`
    // reorder list below, which is a live identifier this paragraph drifted
    // onto during a partial edit and never described. Under either version a
    // student the loop's own read returned nothing for — waiting in zero
    // classes then, holding no entry at all later, the common case either way
    // — got an UNBOUNDED wait on every statement in this transaction,
    // including a `registration.updateMany` that can contend with the
    // 60-second transitions sweep, and the erasure hung with no feedback until
    // Prisma's own transaction timeout eventually refused to start the NEXT
    // statement. That timeout cannot roll back a statement already blocked
    // inside Postgres, only decline to begin another one, which is what made
    // this transaction's budget — the flat `{ timeout: 20_000 }` below, a
    // `Math.min` of a pre-transaction count until #240 — a wish rather than a
    // guarantee for exactly those erasures. Round 2 review measured both
    // halves of that asymmetry directly (see the `timeout` option's own
    // comment); it was recorded there as intended, which it was not — nothing
    // in the GDPR-clock rationale for bounding this transaction depends on the
    // subject being on a waitlist.
    //
    // Idempotent with the ordered pre-lock's own `SET LOCAL`: a later one
    // overwrites the earlier rather than stacking (`db-locks.ts`, and
    // `db-locks.test.ts` checks it).
    await setLockTimeout(tx);

    // Record which open classes free a spot — the waitlist hook runs on
    // them after the erasure commits. A read, so it carries no lock-ordering
    // obligation — see the ordered pre-lock below for what does.
    // `calendarEntry: { cancelledAt: null }` beside the statuses (#327): a
    // cancelled class keeps its `draft`/`open` status now, and this list feeds
    // `handleSpotFreed` — which has nothing to free on a class that is off.
    const upcoming = await tx.registration.findMany({
      where: {
        studentId,
        status: 'registered',
        class: { status: { in: ['draft', 'open'] }, calendarEntry: { cancelledAt: null } },
      },
      select: { classId: true, class: { select: { status: true } } },
    });

    // EVERY entry, not just the `waiting` ones, because the delete below is
    // `deleteMany({ where: { studentId } })` — every entry, unscoped. The lock
    // set has to cover the write set or the difference is written unlocked, and
    // this read is what defines the lock set.
    //
    // Those two sets used to coincide by accident. Before #216 nothing closed a
    // queue when a class STARTED, so a student who never got in stayed `waiting`
    // for ever and their class stayed in this read. `closeQueueOnStart` flips
    // those rows to `expired`, which is the fix — and it silently dropped their
    // classes out of the lock set while the delete kept deleting them.
    //
    // Not narrowed to "statuses another writer can still touch", which was the
    // first version of this fix and was wrong: `addToWaitlist` revives an
    // existing entry of ANY status on a rejoin (`waitlist.ts`, the
    // `existingEntry` branch — it updates back to `waiting` rather than
    // creating), so there is no terminal status here whose row is provably
    // nobody else's to write. Write set equals lock set is the only version of
    // this that does not depend on such a claim staying true.
    //
    // Read here, before this transaction's first write — not where this used to
    // sit, immediately before the reorder loop — so the ordered pre-lock below
    // can run before any write. See that statement for why the order matters,
    // not just the fact of locking.
    //
    // ONE statement, not a `lockClassRow` loop, and the difference is not
    // stylistic. `lockClassRow` is two round trips (`setLockTimeout`, then the
    // `FOR UPDATE`), so a loop cost 2N of them and the transaction budget had to
    // grow with N to pay for it. Measured on an idle local Postgres, the loop
    // took 6.0s where this statement takes 13ms for the same class set. On the
    // single 2GB VPS this deployment targets (`CLAUDE.md`) the loop's ceiling
    // was reachable, and reaching it was terminal rather than transient — see
    // this transaction's `timeout` option below.
    //
    // Through the shared helper (#237), which owns all of that: ascending by
    // `c.id` so two concurrent erasures take any shared classes in one order,
    // `FOR UPDATE OF c` so only the `Class` rows are locked, the dedupe
    // Postgres forces by refusing `DISTINCT` alongside `FOR UPDATE`, and — the
    // part a loop cannot have — the lock taken BY the statement that chooses
    // the rows, so there is no window between choosing them and holding them.
    // `@@unique([classId, studentId])` means one entry per class per student,
    // so this join could not duplicate a class anyway; the helper's dedupe is
    // for its other callers.
    //
    // EVERY status, matching the unscoped `deleteMany` below. The lock set has
    // to cover the write set: before #216 a student who never got in stayed
    // `waiting` for ever, so a `waiting`-scoped lock happened to cover it;
    // `closeQueueOnStart` flips those rows to `expired`, and the walk-in
    // resolver in `POST /api/registrations` writes `expired` entries under this
    // same class row lock, so the gap was live.
    //
    // VERDICT (#327): no `entries: true`. This transaction reads and writes
    // `WaitlistEntry`, `Registration`, `StudentPrivacy`, `TeacherStudent`,
    // `Invitation`, `Notification`, `Session` and `Account` — it touches no
    // `CalendarEntry` column. Its registration-cancel filter reads
    // `calendarEntry: { cancelledAt: null }` further down, which is a
    // predicate on a relation, not a decision this lock has to serialise —
    // the same shape `status: { in: ['draft', 'open'] }` had, unlocked,
    // before #327.
    await lockClassRowsOrdered(tx, {
      join: Prisma.sql`JOIN "WaitlistEntry" w ON w."classId" = c.id`,
      where: Prisma.sql`w."studentId" = ${studentId}`,
    });

    // Read AFTER the lock rather than before it — under the rows this
    // transaction now holds, so it cannot see a queue another writer is
    // mid-change. The reorder stays `waiting`-only: closed rows keep stale
    // positions by design (#183), so a class where this student held only a
    // closed entry must still be LOCKED but has nothing to renumber.
    const waitingClassIds = (
      await tx.waitlistEntry.findMany({
        where: { studentId, status: 'waiting' },
        select: { classId: true },
      })
    ).map((w) => w.classId);

    // Locked here, before this transaction's first write below — not merely
    // before the reorder loop the lock used to sit beside. Round 1 review
    // reproduced why placement matters: `promoteNext` drops a stale head and
    // `withdrawWaitingEntriesForTeacher` clears every entry, and both take
    // the Class row's lock BEFORE writing `WaitlistEntry`. Locking after
    // this transaction's own writes (the previous version of this fix) let
    // this transaction hold a `WaitlistEntry` row lock — from, e.g., the
    // `waitlistEntry.deleteMany` below — while *requesting* the Class lock,
    // at the same moment one of those functions held the Class lock while
    // *requesting* that same `WaitlistEntry` row: transaction A holds row
    // lock 1 and waits on lock 2; transaction B holds lock 2 and waits on
    // lock 1. Postgres detects that cycle and kills one side with error
    // `40P01 deadlock detected` — reproduced against the previous version of
    // this fix, and the victim can be this erasure or a student's booking,
    // Postgres's choice, not this code's. Locking every affected class here,
    // before any write, makes this transaction's acquisition order match
    // theirs (Class row, then its children) — the same convention
    // `withdrawWaitingEntriesForTeacher`'s docblock (`waitlist.ts`)
    // documents as "a correctness requirement rather than a style note,"
    // now for the same reason there as here.
    //
    // Not covered by the escape argument in `waitlist.ts`'s
    // `withdrawWaitingEntriesForTeacher` docblock: that argument turns on
    // only ever moving an entry OUT of `waiting`, and this renumbers rows
    // belonging to OTHER students, racing the six other writers of
    // `WaitlistEntry.position` on the same class, all of which also lock it
    // (`addToWaitlist`, `removeFromWaitlist`, `promoteNext`, `claimSpot`,
    // `withdrawWaitingEntriesForTeacher`, `POST /api/registrations`).
    //
    // Ascending by id is this project's intended order for taking more than
    // one `Class` row. All four such sites take it, through the shared helper
    // `lockClassRowsOrdered` (`db-locks.ts`) — this function's pre-lock above,
    // `withdrawWaitingEntriesForTeacher` (`waitlist.ts`),
    // `deleteTeacherAccount` below, and `archiveOrUnarchiveTemplate`
    // (`class-template-lifecycle.ts`), which used to lock in heap order and
    // cycled against THIS function for real until it gained an ordered
    // pre-lock ahead of its multi-row write (issue 180, atomic-template-update).
    // Five until #194, whose deleted template sync was the fifth and carried
    // the same issue-180 pre-lock. Re-derived from `lockClassRowsOrdered(` in
    // `src/` rather than decremented — this project has been wrong about the
    // membership of this list while its total stayed plausible.
    //
    // "Takes an order", deliberately, not "agree" — one of the four is not
    // total, and the exception is a pairing with THIS function, so it must
    // not be read out of this comment. `archiveOrUnarchiveTemplate`'s
    // pre-lock covers `date > today`; `updateClass` (`class-lifecycle.ts`)
    // can reschedule a same-day instance into the future from outside that
    // transaction, between the pre-lock and the `deleteMany` whose predicate
    // is re-evaluated at execution time by design. That row is deleted
    // without ever having been held in order, so the AB-BA cycle against
    // this function can still form through that window — narrow, measured,
    // and tracked as a residual rather than closed. See that pre-lock's own
    // comment and the atomic-template-update spec's risk list before
    // treating this pairing as settled. `withdrawWaitingEntriesForTeacher`
    // does not share the exposure: its write set is keyed
    // `classId: { in: classIds }`, a structural subset of what its pre-lock
    // returned.
    //
    // The order lives in ONE place now — the helper's `ORDER BY c.id` — so
    // the two tables' disagreement that used to make this comment a three-way
    // audit is closed: two callers that share the helper cannot take a pair in
    // opposite sequences, whatever their reads return. That it stays true is
    // pinned by `db-locks-lock-order.test.ts` (the helper's own order) and by
    // the deadlock test this file's sibling suite runs, which races the two
    // erasures' pre-locks directly (`gdpr.test.ts`, "does not deadlock when a
    // teacher erasure and a student erasure overlap on two classes") and fails
    // with `40P01` if the clause is removed.
    // Cancel upcoming registrations so open classes free the spots.
    // The same predicate as the `upcoming` read above, `cancelledAt: null`
    // included, and it has to stay the same: this write is what that read
    // predicts. A cancelled class frees no spot, so its registrations are left
    // exactly as they were — which is what `status: { in: ['draft','open'] }`
    // did on its own before cancellation left the enum.
    await tx.registration.updateMany({
      where: {
        studentId,
        status: 'registered',
        class: { status: { in: ['draft', 'open'] }, calendarEntry: { cancelledAt: null } },
      },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

    // `StudentPrivacy` BEFORE `TeacherStudent` — this project's one order
    // for these two tables (#174 task 7; see `docs/lock-order.md`).
    // `unlinkTeacher` (services/invitations.ts) used to take them the other
    // way round, and racing it against this transaction deadlocked for
    // real — not a theoretical inversion, a reproduced `40P01 deadlock
    // detected` — because `unlinkTeacher`'s own `StudentPrivacy` write is
    // never an empty upsert (six real columns), so it always takes the row
    // lock. `unlinkTeacher` now takes them in this same order.
    await tx.studentPrivacy.deleteMany({ where: { studentId } });
    await tx.teacherStudent.deleteMany({ where: { studentId } });
    await tx.waitlistEntry.deleteMany({ where: { studentId } });

    // Invitations are keyed by address, not by `studentId` — a teacher can
    // hold a CRM contact for someone with no Student row at all — so this
    // matches on the address directly, with no normalisation needed: all six
    // email columns are lowercase by CHECK constraint (#170).
    //
    // Anonymised rather than deleted, and the reason is the teacher's side:
    // a `declined` row is the tombstone that stops that teacher re-inviting
    // this address, so deleting it would hand back the re-invite the refusal
    // exists to deny — an erasure request would double as a way to clear
    // every refusal anyone ever made. `status` and `respondedAt` therefore
    // stay exactly as they are; the identity columns change, plus
    // `lastNotifiedEmail` wherever it still holds the subject's address —
    // independent of what the row's CURRENT `email` is, since `PUT
    // /api/invitations/[id]` can move `email` on without touching the
    // marker — a resent invitation's "last invited" marker otherwise keeps
    // the erased person's real address forever, on a row they can no longer
    // reach. Split into three statements rather than one: setting
    // `lastNotifiedEmail` on a row where `lastNotifiedAt` is still null
    // would violate `Invitation_last_notified_pair_check`, and the third
    // statement below matches on the marker itself rather than on the row's
    // current `email`, so it has to run independently of the first two.
    //
    // The replacement satisfies both constraints the branch added:
    // `Invitation_email_lowercase_check` (uuid + `@deleted.invalid` is
    // already lowercase — true of every `deleted-<uuid>@deleted.invalid`
    // write in this file, so it equally satisfies the matching CHECK on
    // `Account`, `Student` and `Teacher`) and
    // `Invitation_responded_at_status_check` (this write touches neither
    // side of it). It also stays unique per teacher, so a student invited by
    // several teachers anonymises to one value without colliding on
    // `@@unique([teacherId, email])`.
    await tx.invitation.updateMany({
      where: { email: student.email, lastNotifiedAt: null },
      data: {
        email: `deleted-${studentId}@deleted.invalid`,
        firstName: 'Deleted',
        lastName: 'Student',
      },
    });
    await tx.invitation.updateMany({
      where: { email: student.email, lastNotifiedAt: { not: null } },
      data: {
        email: `deleted-${studentId}@deleted.invalid`,
        firstName: 'Deleted',
        lastName: 'Student',
        lastNotifiedEmail: `deleted-${studentId}@deleted.invalid`,
      },
    });
    // The two statements above only catch rows whose CURRENT `email` is
    // the subject's — but `PUT /api/invitations/[id]` can move `email` on
    // without touching the marker, so a row invited under the subject's
    // address, then corrected to someone else's, still carries the
    // subject's real address in `lastNotifiedEmail` and is invisible to
    // either statement above. This third statement is independent of
    // those two and closes that gap: it matches on the MARKER, not on the
    // row's current identity. Safe against
    // `Invitation_last_notified_pair_check`: every row this matches
    // already has `lastNotifiedEmail` non-null, which the CHECK already
    // requires to be paired with a non-null `lastNotifiedAt`, and this
    // statement leaves `lastNotifiedAt` untouched. Deliberately not
    // touching `email`/`firstName`/`lastName` here — on these rows the
    // row's current address belongs to a different person the teacher may
    // still be corresponding with; only the stale marker is the subject's.
    await tx.invitation.updateMany({
      where: { lastNotifiedEmail: student.email },
      data: { lastNotifiedEmail: `deleted-${studentId}@deleted.invalid` },
    });

    // `TeacherBlock` is DELIBERATELY not touched here, and the omission is
    // undecided rather than settled — see `docs/data-model.md`
    // (TeacherBlock). Scrubbing the address breaks the block, because every
    // lookup is `teacherId` + exact `email` and the erased person's real
    // mailbox still exists in the world: the teacher could re-type that
    // address and the invitation would actually be delivered. Retaining it
    // keeps a plaintext address for someone who asked to be forgotten, on a
    // row they can no longer reach to clear (their account email is rewritten
    // and their sessions are gone, so the unlink UI is unreachable for
    // them). `CLAUDE.md` parks GDPR/legal review for proper consultation and
    // this is exactly that call. Do not resolve it from in here.
    await tx.notification.deleteMany({ where: { recipientType: 'student', recipientId: studentId } });
    // Sessions and passkeys belong to the account. They die with the
    // erased profile unless a live teacher profile still uses the account.
    if (student.accountId) {
      const teacherOnAccount = await tx.teacher.findFirst({
        where: { accountId: student.accountId, deletedAt: null },
        select: { id: true },
      });
      if (!teacherOnAccount) {
        await tx.session.deleteMany({ where: { accountId: student.accountId } });
        await tx.passkeyCredential.deleteMany({ where: { accountId: student.accountId } });
        // Last live profile erased: the account email is PII too.
        await tx.account.update({
          where: { id: student.accountId },
          data: { email: `deleted-${student.accountId}@deleted.invalid` },
        });
      }
    }
    await tx.magicLinkToken.deleteMany({ where: { email: student.email } });

    // The teacher's "X booked …" notifications carry the student's first
    // name — scrub them for the classes this student booked. Matching by
    // body prefix can catch a same-named classmate; anonymizing that copy
    // too is the safe direction to err in.
    const bookedClassIds = (
      await tx.registration.findMany({
        where: { studentId },
        select: { classId: true },
      })
    ).map((r) => r.classId);
    if (bookedClassIds.length > 0) {
      await tx.notification.updateMany({
        where: {
          recipientType: 'teacher',
          type: 'booking_confirmed',
          relatedClassId: { in: bookedClassIds },
          body: { startsWith: `${student.firstName} booked ` },
        },
        data: { body: 'A student (account since deleted) booked this class.' },
      });
    }

    // The lock for each of these classes was already taken above, before
    // this transaction's first write — see that loop for why placement, not
    // just the fact of locking, matters here. Renumbering here rather than
    // there only changes when the write happens; the lock has been held
    // since before this transaction wrote anything at all.
    for (const classId of waitingClassIds) {
      await reorderWaitingEntries(tx, classId);
    }

    // `deletedAt: null` in the WHERE, and a throw on a count of 0. Two
    // concurrent erasures of one student both reach here — the reads above
    // ran before either wrote, so both carry the same `upcoming` — and an
    // unscoped `update({ where: { id } })` let both commit. The scope alone
    // would not help: the damage is done AFTER this transaction, by the
    // `handleSpotFreed` loop below, which a committed-but-no-op second
    // transaction still runs, telling every waiting student a second time
    // that one seat opened. Aborting is what stops it — the loop is
    // unreachable from a rolled-back transaction.
    //
    // Not an error condition, which is why the sentinel is typed rather than
    // generic: the caller wanted this profile erased and it is,
    // `api/account/route.ts` maps it to the same 200 a first erasure gets.
    const erased = await tx.student.updateMany({
      where: { id: studentId, deletedAt: null },
      data: {
        firstName: 'Deleted',
        lastName: 'Student',
        email: `deleted-${studentId}@deleted.invalid`,
        phone: null,
        birthday: null,
        address: null,
        incomeTier: DEFAULT_INCOME_TIER,
        emailNotifications: false,
        deletedAt: new Date(),
      },
    });
    if (erased.count === 0) throw new AlreadyErasedError('student');

    return upcoming.filter((r) => r.class.status === 'open').map((r) => r.classId);
  }, {
    // Flat, and that is a decision rather than a default. It used to be
    // `Math.min(5_000 + waitingCount * 2_000, 20_000)`, sized from a count read
    // before the transaction opened. The term is gone; the ceiling it rarely
    // reached is now the whole rule.
    //
    // WHY THE TERM COULD NOT BE MADE HONEST. It priced neither of the two
    // things that scale with the size of this erasure:
    //
    //   - It counted `waiting` entries, but the lock set is every class the
    //     student holds an entry in of ANY status — the pre-lock's join carries
    //     no status predicate, deliberately, see there. A student with 0
    //     `waiting` and 30 closed entries got 5_000ms against a statement
    //     asking for 30 row locks.
    //   - It did not count `reorderWaitingEntries` (`waitlist.ts`) at all: a
    //     `findMany` plus up to M individual `UPDATE`s per class, each
    //     separately bounded by the same 2s.
    //
    // A term that prices neither axis, and whose only possible effect is to
    // grant LESS than the ceiling already permits, is worse than the ceiling
    // alone. Computing it also cost a round trip before the transaction opened
    // and a documented stale-read window, because the count ran outside any
    // transaction and a waitlist join could land in the gap.
    //
    // AND THE ARGUMENT THAT KEPT IT `waiting`-ONLY WAS INVERTED, which is the
    // part worth reading before reviving it. Commit `7298311` reverted an
    // all-status count on the grounds that such a count is monotone for the
    // life of the account, so "past the `Math.min` ceiling the erasure would
    // fail, and the retry would re-read the same count and fail identically —
    // an account that can never be erased". That does not survive its own
    // arithmetic: `min(5_000 + N * 2_000, 20_000)` is monotone NON-DECREASING
    // in N and capped, so an all-status count could only ever grant MORE budget
    // than a `waiting`-only one for the same account, never less. It could not
    // have caused a failure the smaller count avoids. What actually made those
    // accounts un-erasable was the `lockClassRow` LOOP — two round trips per
    // class, measured at 6.0s against the single statement's 13ms for the same
    // class set. That commit removed the loop and reverted the count in one
    // change, and its subject line — "the erasure's lock loop grew with
    // account age until erasure was impossible" — credits the loop, so this is
    // not a claim that it missed the cause. The narrower and defensible one:
    // the comment it left on the count attributed the fix to the revert, and
    // the revert is the half that provably cannot have helped.
    //
    // 20_000ms. Generous enough that the realistic case always finishes — and
    // "realistic case" is measured on the axis that governs the cost, which is
    // the number of classes the student holds a `WaitlistEntry` in of ANY
    // status, because that set IS the pre-lock's lock set. (This sentence used
    // to read "no plausible legitimate student waiting in more than a handful
    // of classes at once", sizing the budget on the very axis the paragraphs
    // above spend twenty lines discrediting.) On a single-teacher CRM tool
    // that lock set is a handful of classes.
    //
    // #238 SHRINKS THAT AXIS; IT DOES NOT BOUND IT. The mismatch is between two
    // predicates: the pre-lock above joins `WaitlistEntry` with NO status
    // predicate, so its lock set is every class this student holds ANY entry
    // in, while `reapClosedWaitlistEntries` (`waitlist-retention.ts`) deletes
    // only entries with `registrationId IS NULL` and a status outside
    // `FULFILLED_WAITLIST_STATUSES`, on a terminal class more than
    // `WAITLIST_RETENTION_DAYS` old. NO BACKGROUND SWEEP EVER REAPS A FULFILLED
    // ENTRY. The one thing that deletes them is the `deleteMany` below, in this
    // very function — which is not a counter-example but the point: it runs
    // once per account, at that account's own request, so it cannot bound a set
    // that grows while the account is alive. (An earlier version of this clause
    // said fulfilled entries are reaped "by nothing, here or anywhere", which
    // was false in the file it was written in.) So a student who waitlists
    // weekly and gets promoted accumulates ~52 permanent entries a year, each
    // holding its class in this lock set for the life of the account. What #238
    // bounds is the UNFULFILLED share; the set still grows with account age,
    // just more slowly. Stated at this length because "bounded by the retention
    // window" is the natural shorthand and it is wrong.
    //
    // Which is why the number below is a ceiling on damage rather than a
    // forecast of need.
    //
    // NOT sized from statement cost, and the measurement is what says so. Not
    // all of this transaction's work is indexed on the column it filters by,
    // and an older version of this comment claimed otherwise:
    // `waitlistEntry.findMany`/`deleteMany` and `teacherStudent.deleteMany`
    // key on `studentId` alone (`WaitlistEntry` carries only
    // `(classId, studentId)` and `(classId, position)`; `TeacherStudent` only
    // `(teacherId, studentId)`), `magicLinkToken.deleteMany` keys on `email`
    // (only `tokenHash` and the PK are indexed), and the teacher-notification
    // `updateMany` filters on `body: { startsWith }`. Those four run as
    // sequential scans, verified against `prisma/migrations/*/migration.sql`
    // rather than assumed. That inventory is recorded to correct the
    // "it is all indexed" claim, NOT as a reason more budget was needed — the
    // measured fact points the other way: this whole statement set, the four
    // sequential scans included, already ran inside 5_000ms, which is Prisma's
    // default transaction timeout and the only budget this function had before
    // #174 gave it an explicit one. So the 20s buys nothing for statement time.
    // It is headroom for the pathological LOCK-WAIT case below, where
    // `lock_timeout` is armed per acquisition and N contended rows can cost up
    // to N * 2s inside one budget.
    //
    // Bounded enough that a pathological N cannot hold one of this app's
    // Postgres connections for more than 20s, against the 105s an uncapped
    // 50-class case would have taken (50 * 2s of lock waits on top of the 5s
    // base), on a deployment that is a single 2GB, 1-vCPU VPS (`CLAUDE.md`:
    // "VPS budget"; `docs/technical-architecture.md` draws the box as "VPS
    // (2GB RAM, 1 vCPU)", and the core count is cited because the pool
    // arithmetic below is computed from it). One cost of that number,
    // recorded as a cost rather than argued away: 20s is twice Prisma's
    // default `pool_timeout` of 10s, and `src/lib/db.ts` is a bare
    // `new PrismaClient()` — `connection_limit` is set nowhere in `src/`,
    // `docker-compose*.yml`, the `Dockerfile` or `DEPLOYMENT.md`, only on one
    // test's dedicated client — so the pool is `physical_cores * 2 + 1`,
    // which is three connections at that one vCPU. One erasure occupying one
    // of them for the full budget means a concurrent request that cannot get
    // a connection gives up at 10s with `P2024` while the erasure is still
    // running: the pool gives up before the transaction does. Survivable
    // rather than fine — `api-errors.ts` classifies `P2024` transient and
    // answers it with retry advice — and reachable at the old ceiling too,
    // since `waitingCount >= 8` already bought the same 20s. New here is only
    // that every erasure gets it, and that anyone has written it down.
    //
    // WHAT THIS DOES NOT BOUND, and the distinction is why the number above is
    // not a guarantee. Prisma's interactive-transaction timeout refuses to
    // START a statement past the budget; it cannot cancel one already blocked
    // inside Postgres. Two consequences, both measured rather than read off the
    // docs:
    //
    //   - `lock_timeout` is armed PER LOCK ACQUISITION, not per statement, so
    //     the ordered pre-lock over N contended rows can spend up to N * 2s
    //     while no single wait exceeds the bound. Measured 2026-08-16: two
    //     `Class` rows held by sessions releasing at 1.5s and 3.0s, one waiter
    //     at `lock_timeout='2s'` taking both in ONE statement, SUCCEEDED after
    //     2.67s. What #237's helper collapses to O(1) is round trips, not
    //     waiting.
    //   - `SET LOCAL lock_timeout` governs every statement left in this
    //     transaction, not just the `FOR UPDATE`s. Measured with a lock on the
    //     erased student's own `Registration` row, unrelated to any waitlist:
    //     `registration.updateMany` failed at ~2086ms with `55P03 canceling
    //     statement due to lock timeout`. That bound arrives from
    //     `setLockTimeout` at the top of this transaction, unconditionally —
    //     before it did, a student waiting in zero classes got an UNBOUNDED
    //     wait, which is what made this ceiling a wish rather than a rule.
    //
    // So the honest claim: every WAIT here is bounded at 2s, this budget bounds
    // how long Prisma will keep STARTING statements, and neither bounds the
    // transaction's total time in the pathological case. When the budget does
    // bind, the erasure aborts with P2028 — safe and retryable, because this
    // function is one transaction end to end (its only work outside it is the
    // post-commit `handleSpotFreed` loop, which swallows its own errors), so a
    // throw means nothing landed. `api/account/route.ts`'s `erasureFailure`
    // relies on exactly that to tell the caller "Nothing was changed", and says
    // why the teacher erasure cannot claim the same.
    timeout: 20_000,
  });

  // The seats are freed and the erasure is committed — a promotion failure
  // must not undo either, so errors are logged and swallowed.
  //
  // Split by transience for the reason `promoteAfterCancel`
  // (`api/registrations/[id]/route.ts`) carries in full: #212 put the
  // broadcast branch behind `lockClassRow` and #104 put the auto-promote
  // branch there too, so `55P03` is reachable here on EITHER branch — and the
  // auto-promote one is much the larger surface, since `getWaitlistWindow`
  // returns it for everything up to (cancel deadline − 1h) against one hour of
  // `first_come_first_claimed`. `api-errors.ts` reserves `error` for things
  // that should page someone. This loop is the likelier of the two call sites
  // to hit it — an erasure holds every class row it locks until its own
  // transaction commits, so a concurrent cancel on a shared class is exactly
  // the contention that times out.
  for (const classId of freedClassIds) {
    try {
      await handleSpotFreed(db, classId);
    } catch (err) {
      // `-1` and its blind spot: same shape and same caveat as
      // `promoteAfterCancel`'s, which carries the reasoning in full.
      const waiting = await db.waitlistEntry
        .count({ where: { classId, status: 'waiting' } })
        .catch(() => -1);
      const transient = isTransientDbError(err);
      log[transient ? 'warn' : 'error'](
        { err, classId, waiting, transient },
        transient
          ? 'gdpr: spot-freed hook lost a lock race after erasure — the freed seat was neither promoted nor broadcast'
          : 'gdpr: spot-freed hook failed after erasure',
      );
    }
  }
}

/**
 * The statuses a teacher erasure cancels — and the ONE list they are read
 * from.
 *
 * This was hand-typed twice in `deleteTeacherAccount` (the `upcoming` read's
 * filter and the per-class CAS `where` it must agree with), and the ordered
 * pre-lock would have made three. `class-template-lifecycle.ts:641-651`
 * records what that costs, measured rather than argued: dropping a status
 * from one of two hand-written lists "left every test covering this function
 * green, silently re-opening the deadlock the pre-lock exists to close".
 * There is one list to edit now, not three to keep in sync.
 */
const CANCELLABLE_STATUSES: readonly ClassStatus[] = Object.freeze([
  'draft',
  'open',
  'in_progress',
]);

/**
 * `CANCELLABLE_STATUSES`, pre-rendered as a raw SQL `IN (…)` list for the
 * ordered pre-lock's predicate — the one reader of it that cannot go through a
 * Prisma `{ in: [...] }` filter, because `FOR UPDATE OF c` and `ORDER BY` have
 * no query-builder equivalent.
 *
 * `Prisma.raw`, not `Prisma.join`, following `SCHEDULED_STATUSES_SQL`
 * (`class-template-lifecycle.ts:653`) and for the reason measured there:
 * `Prisma.join` binds each status as a separate parameter, and a bound text
 * parameter compared against the `status` column's enum type needs an explicit
 * `::text` cast to resolve, which costs the index. Safe here for the same one
 * precondition as there — `CANCELLABLE_STATUSES` is a frozen, hard-coded
 * constant, never input.
 */
const CANCELLABLE_STATUSES_SQL = Prisma.raw(CANCELLABLE_STATUSES.map((s) => `'${s}'`).join(', '));

/**
 * Deletes a teacher account: upcoming classes are cancelled with student
 * notifications, personal/business data wiped; completed classes and
 * payments remain so students keep their payment records.
 *
 * The two constants above sit between this and `deleteStudentAccount` rather
 * than beside their first use for a lint reason recorded in #237 task 7 —
 * declaring them next to the student erasure tripped `no-unused-vars` until
 * the pre-lock below consumed them. They belong ABOVE this docblock, not
 * between it and the function: a docblock binds to whatever declaration
 * follows it, so parking them in that gap silently reassigned this summary to
 * `CANCELLABLE_STATUSES` and left this function undocumented on hover.
 */
export async function deleteTeacherAccount(db: PrismaClient, teacherId: string): Promise<void> {
  const teacher = await db.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { email: true, accountId: true, defaultTimezone: true },
  });

  // A class already underway has happened — complete it (pricing, payment
  // records, notifications) instead of pretending it was cancelled
  // mid-session. The billing is the students' payment history too.
  // `cancelledAt: null` beside the status (#327): a cancelled class keeps its
  // `in_progress` status now, and `completeClass` bills — so without it this
  // erasure would run the pricing engine over a class the teacher had already
  // called off. (`completeClass` refuses one anyway; this is what keeps the
  // erasure from asking.)
  const inProgress = await db.class.findMany({
    where: { calendarEntry: { teacherId, cancelledAt: null }, status: 'in_progress' },
    select: { id: true },
  });
  for (const cls of inProgress) {
    // `completeClass` now opens with `lockClassRow`'s 2s `lock_timeout`
    // (#174), narrower than the ~5s default Prisma gives the transaction
    // that lock sits in, so this call can now fail faster than it used to.
    // The kind of failure is unchanged — it could always throw, and that is
    // deliberately left uncaught here, not wrapped in a try — but bounded
    // beats unbounded, and the next reader should not have to re-derive why
    // the window moved.
    // `finishedEarly`: erasure closes in-flight classes regardless of the
    // clock — the subject's right does not wait for the class to end.
    const result = await completeClass(db, cls.id, { finishedEarly: true });
    if (!result.ok) {
      // Fall through: the cancel sweep below still picks the class up.
      //
      // `log`, not `console.error` — it is imported and used elsewhere in
      // this file, and a bare `console.error` writes a line with no level, no
      // request context and no structured fields, so it is invisible to every
      // filtered view an operator actually reads.
      //
      // `warn`, not `error`, and with the status this class was actually
      // found in. The commonest way to land here is `completeClass` refusing
      // `completed → completed` — which is precisely what the LOSER of two
      // concurrent erasures of the same teacher hits, and that loser now ends
      // in a 200 (`AlreadyErasedError`). Paging someone for the expected
      // outcome of a race this design chooses to lose gracefully trains them
      // to ignore the line. `observedStatus` is what separates that benign
      // case from a genuine refusal, and it is the same field
      // `deleteTeacherAccount`'s own class CAS reports below.
      // `.catch` because this read exists only to enrich a log line, and a
      // diagnostic must never be able to fail the operation it describes:
      // unguarded, a pool timeout here would throw out of a GDPR erasure that
      // was on track to succeed, and the route would tell the user their
      // teaching data may have survived. `'unknown'` is kept distinct from
      // `'row-deleted'` — conflating "we could not look" with "it was gone"
      // is how a read failure gets filed as a finding.
      const observed = await db.class
        .findUnique({ where: { id: cls.id }, select: { status: true } })
        .catch(() => 'unread' as const);
      const observedStatus =
        observed === 'unread' ? 'unknown' : (observed?.status ?? 'row-deleted');

      // `warn` for the one refusal that is routine — the loser of two
      // concurrent erasures, whose class is already `completed`. Everything
      // else here is `error` and means it: a class that vanished, or one that
      // went `cancelled` and so will never be completed, never priced, and
      // never billed — the students' payment history quietly short by a
      // class. That is not a level nobody watches.
      const benignDuplicate = observedStatus === 'completed';
      log[benignDuplicate ? 'warn' : 'error'](
        { teacherId, classId: cls.id, reason: result.error, observedStatus },
        'teacher erasure: could not complete an in-progress class first',
      );
    }
  }

  await db.$transaction(
    async (tx) => {
      // Template child rows locked first, ordered by id (#229). This is the
      // transaction's FIRST lock acquisition. Five other sites —
      // `claimTemplateForGeneration` (`entry-generation.ts`),
      // `pauseOrResumeTemplate`, `archiveOrUnarchiveTemplate`,
      // `POST /api/class-templates`, `updateClassTemplate`
      // (`class-template-lifecycle.ts`) — all take `ClassTemplate` before
      // `Class`. Before #229 this function was the sole site taking the
      // opposite order, documented in `docs/lock-order.md` as a known
      // violation. Moving these locks ahead of `lockClassRowsOrdered` below
      // standardises on the majority's `ClassTemplate → Class` direction.
      //
      // Mirrors `lockClassRowsOrdered`'s discipline (`db-locks.ts`): two
      // transactions locking an overlapping set of `ClassTemplate` rows in
      // different orders is an AB-BA cycle exactly like the `Class` case
      // that helper exists for. This is the fix for a gap Task 3 left
      // `known-open` here: before issue 298 this bulk write targeted
      // `ClassTemplate` directly, and a bare `updateMany` locks the rows it
      // matches, so it already serialised against
      // `claimTemplateForGeneration`'s `FOR UPDATE OF ct`
      // (`class-generator.ts`) for free. `isActive`/`isArchived` moved to
      // `ScheduleRule`, so that free lock stopped covering the child.
      //
      // Not a theoretical gap — measured. `ACTIVE_TEMPLATE_WHERE`
      // (`lib/template-selection.ts`), which the sweep's own `findMany`
      // selects candidates with, carries no `teacher.deletedAt` filter at
      // all: it tests only `scheduleRule.isActive`/`isArchived`. So an
      // hourly sweep already mid-loop for this teacher when this transaction
      // opens is not merely possible in theory, it is a candidate set the
      // sweep's own selection query cannot distinguish from any other live
      // teacher's. Restoring the child lock is what makes the sweep's claim
      // wait here the same way it waits on `archiveOrUnarchiveTemplate`.
      //
      // `setLockTimeout` called explicitly here — `lockClassRowsOrdered`
      // below calls it again internally, but `SET LOCAL` is transaction-
      // scoped, so the second call is a harmless no-op.
      await setLockTimeout(tx);
      await tx.$queryRaw`
        SELECT ct."id" FROM "ClassTemplate" ct
          JOIN "ScheduleRule" sr ON sr."id" = ct."scheduleRuleId"
        WHERE sr."teacherId" = ${teacherId}
        ORDER BY ct."id"
        FOR UPDATE OF ct`;
      await tx.$queryRaw`
        SELECT sct."id" FROM "StudioClassTemplate" sct
          JOIN "ScheduleRule" sr ON sr."id" = sct."scheduleRuleId"
        WHERE sr."teacherId" = ${teacherId}
        ORDER BY sct."id"
        FOR UPDATE OF sct`;

      // Class + its CalendarEntry, locked ascending, in ONE statement,
      // BEFORE any read of this teacher's classes. Pinned by the
      // regression test "cancels a class that becomes cancellable
      // immediately before the class lock runs" (#367).
      //
      // Lock set and read set are identical by construction now: the read
      // below asks for exactly `lockedIds`, not a separately re-evaluated
      // predicate. What still escapes: a class created or rescheduled into
      // a cancellable status AFTER this statement runs — inherent to any
      // read-then-transact system, not a gap this design leaves open by
      // choice.
      //
      // This is the transaction's SECOND lock acquisition overall (the
      // template locks above are first, #229) and its first read of any
      // `Class` data at all.
      //
      // VERDICT (#327): this transaction WRITES entry-level state — the
      // cancel below is `CalendarEntry.cancelledAt`, and its CAS
      // re-evaluates that column — so the entry rows are locked here too,
      // keeping the lock set a superset of the write set. The sibling
      // pre-lock in `deleteStudentAccount` above does NOT take
      // them: it never reads or writes an entry column.
      const lockedIds = await lockClassRowsOrdered(tx, {
        join: Prisma.sql`JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"`,
        where: Prisma.sql`e."teacherId" = ${teacherId}
          AND e."cancelledAt" IS NULL
          AND c.status IN (${CANCELLABLE_STATUSES_SQL})`,
        entries: true,
      });

      // Read AFTER the lock, scoped to exactly the ids it holds — under the
      // rows this transaction now holds, mirroring `deleteStudentAccount`'s
      // own lock-then-read shape above in this file. `orderBy` is kept for
      // the notification loop's determinism only; `lockedIds` is already
      // ascending (`lockClassRowsOrdered`'s own contract), so this read is
      // not what orders the locks.
      const upcoming = await tx.class.findMany({
        where: { id: { in: lockedIds } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          calendarEntry: {
            select: { id: true, classType: true, date: true, startTime: true },
          },
        },
      });

      for (const cls of upcoming) {
        // Compare-and-swap, and still live enforcement rather than a
        // formality. `upcoming` is read scoped to `lockedIds`, so every row
        // reaching this loop was already held by the pre-lock above before
        // this transaction's own read ran (#367) — which closes the
        // completion race, not the cancellation one.
        //
        // COMPLETED concurrently: closed. `completeClass`
        // (`class-lifecycle.ts`) takes `lockClassRow` before it writes
        // `Class.status`, so it queues behind this hold rather than racing
        // it, and the pre-lock's `c.status IN (…)` is a predicate on the row
        // that statement actually locks.
        //
        // CANCELLED concurrently: NOT closed. That statement is `FOR UPDATE
        // OF c` — the `Class` row only — while its `e."cancelledAt" IS NULL`
        // conjunct reads the JOINED, unlocked `CalendarEntry`, and
        // `EvalPlanQual` re-fetches locked rows only. So a canceller that
        // takes `Class` first and then writes the entry (`POST
        // /api/classes/[id]/cancel`, the canonical order) can commit while
        // this statement is still WAITING on the class row, leaving the entry
        // half of the predicate evaluated against a pre-wait snapshot — the
        // same mechanism `docs/lock-order.md` records for `transitionClass`.
        //
        // Which is why `cancelledAt: null` below sits BESIDE the status check
        // rather than being redundant with it: since #327 a cancelled class
        // keeps its `draft`/`open`/`in_progress` status, so
        // `CANCELLABLE_STATUSES` no longer excludes one, and re-cancelling
        // would re-notify every student the cancelling route already told.
        // Either cause fails loud — a warn and a skip — rather than silently
        // cancelling a class this loop should not have: cancelling a
        // completed one would strip a class that already has Payment rows and
        // students who have been asked to pay.
        //
        // Skipping the CANCEL is the right handling: a completed class is one
        // erasure deliberately leaves standing (see this function's
        // docblock), so landing on one late is not an error, it is the same
        // outcome by a different route.
        //
        // Skipping SILENTLY was not. `count === 0` has four distinct causes —
        // the class completed concurrently, it was cancelled concurrently,
        // the row was deleted, or something nobody has thought of — and a
        // bare `continue` distinguished none of them, emitted nothing, and
        // returned `void`, so from outside this function the difference
        // between "erased 12 classes" and "erased 12 classes and skipped one
        // it could not explain" was invisible. Re-read to say WHICH cause
        // fired, following the precedent `updateClass` (`class-lifecycle.ts`)
        // sets for its own second check. `warn`, not `error`: the two
        // expected causes are races this CAS exists to lose gracefully.
        //
        // The write is the ENTRY's `cancelledAt` since #327, with the class
        // half of the predicate carried through the relation so the CAS still
        // asks the same question it always did: cancel this class only while
        // it is live and not yet completed.
        const cancelled = await tx.calendarEntry.updateMany({
          where: {
            id: cls.calendarEntry.id,
            cancelledAt: null,
            classes: { some: { status: { in: [...CANCELLABLE_STATUSES] } } },
          },
          data: { cancelledAt: new Date() },
        });

        if (cancelled.count === 0) {
          const observed = await tx.class.findUnique({
            where: { id: cls.id },
            select: { status: true, calendarEntry: { select: { cancelledAt: true } } },
          });
          // The `continue` below skips the waitlist sweep too, deliberately —
          // "does not touch the waitlist" is exactly what the test "warns and
          // skips when a locked id turns out not to be cancellable" pins,
          // because a HALF-applied skip (CAS refused, waitlist
          // and notifications applied anyway) would tell a student their
          // class was cancelled after `completeClass` had already asked them
          // to pay for it. The cost is a residual: any `waiting` entry on
          // that class survives, on a class that can never promote anyone,
          // belonging to a teacher who no longer exists. Counted into this
          // line rather than left invisible — an operator seeing a non-zero
          // `waitingEntriesLeft` knows there is a row to clean up, which is
          // the whole difference between a known residual and a silent one.
          //
          // Since #112 this line carries a second meaning: the happy path
          // below now NOTIFIES the queue as well as closing it, so a non-zero
          // count here is also "this many students heard nothing from this
          // path". That is tolerable only because every route that can produce
          // the three statuses `observedStatus` reports notifies the queue
          // itself — `completed` owes no cancellation notice, a concurrent
          // `cancelled` came from the manual route or `autoCancelClasses`
          // (which tells them, since #112), and `row-deleted` can only be
          // `archiveOrUnarchiveTemplate` (which tells them too). Add a fourth
          // way for a class to leave `draft|open|in_progress` and that
          // argument is what breaks.
          const waitingEntriesLeft = await tx.waitlistEntry.count({
            where: { classId: cls.id, status: 'waiting' },
          });
          log.warn(
            {
              teacherId,
              classId: cls.id,
              // Both halves, because neither answers alone any more: a
              // concurrent cancellation leaves `status` untouched and only
              // `cancelledAt` shows it.
              observedStatus: observed?.status ?? 'row-deleted',
              observedCancelledAt: observed?.calendarEntry.cancelledAt ?? null,
              waitingEntriesLeft,
            },
            'teacher erasure: class cancel CAS matched nothing',
          );
          continue;
        }

        // #112. Read before closing them: `updateMany` returns a count, not
        // rows, and these students are recipients. The update itself is
        // unchanged — this path has always closed the queue correctly and has
        // simply never told anyone it had.
        const waiting = await tx.waitlistEntry.findMany({
          where: { classId: cls.id, status: 'waiting' },
          select: { studentId: true },
        });
        await tx.waitlistEntry.updateMany({
          where: { classId: cls.id, status: 'waiting' },
          data: { status: 'removed' },
        });

        // Read HERE, under the row lock the pre-lock above already took —
        // `upcoming` never selected this data to begin with, so this is
        // the only place it is fetched, not a second read replacing a
        // stale eager-load. The same defect and the same fix as
        // `autoCancelClasses` (`class-transitions.ts`), for the same
        // reason its comment gives: a cancelled class nobody was told
        // about is worse than one that stays open one more sweep. Under
        // the lock, a registration writer either committed before this
        // transaction's own class-level read — and is in this read — or
        // is blocked behind the held row until this transaction ends
        // (#367).
        //
        // `status: 'registered'` only, deliberately narrower than the sibling
        // site's `registered`/`attended`/`no_show`: this predicate is
        // unchanged from the eager-load it replaces, and widening who an
        // erasure emails is a product decision, not a lock-discipline fix.
        const registrations = await tx.registration.findMany({
          where: { classId: cls.id, status: 'registered' },
          select: { studentId: true },
        });
        // Guard on the CONCATENATED list, not on `registrations`. A class
        // whose only audience is its queue has no registrations at all, and
        // that is precisely the case #112 exists to cover — keying this on
        // `registrations.length` drops the notification for exactly the
        // student it was added for, and every fixture with both audiences
        // passes anyway.
        const recipients = [...registrations, ...waiting];
        if (recipients.length > 0) {
          const notifications: CreateNotificationInput[] = recipients.map((r) => ({
            recipientType: 'student' as const,
            recipientId: r.studentId,
            type: 'class_cancelled' as const,
            title: 'Class cancelled',
            body: `${cls.calendarEntry.classType} class on ${formatDayHeader(cls.calendarEntry.date)} at ${timeToHHmm(cls.calendarEntry.startTime)} has been cancelled — the teacher closed their account.`,
            relatedClassId: cls.id,
          }));
          await createBulkNotifications(tx, notifications);
        }
      }

      // Cancel future studio entries (#280). Studio classes have no student
      // registrations or waitlists to notify, so a single bulk write suffices.
      // Uses `gt: today` matching `archiveOrUnarchiveStudioTemplate`'s boundary
      // to preserve today's and past classes as income records.
      await tx.calendarEntry.updateMany({
        where: {
          teacherId,
          kind: 'studio',
          cancelledAt: null,
          date: { gt: startOfLocalDay(new Date(), teacher.defaultTimezone) },
        },
        data: { cancelledAt: new Date() },
      });

      // ClassTemplate/StudioClassTemplate child row locks moved to the top
      // of this transaction (#229) — before the `Class` pre-lock — to
      // resolve the `Class`-before-`ClassTemplate` inversion that
      // `docs/lock-order.md` documented as a known violation.

      // `isActive`/`isArchived` live on `ScheduleRule` now (issue 298), kept
      // as two statements — one per `kind` — mirroring the pre-split shape
      // rather than collapsing to one `updateMany` over both families.
      await tx.scheduleRule.updateMany({
        where: { teacherId, kind: 'regular' },
        data: { isActive: false, isArchived: true },
      });
      await tx.scheduleRule.updateMany({
        where: { teacherId, kind: 'studio' },
        data: { isActive: false, isArchived: true },
      });
      // `StudentPrivacy` BEFORE `TeacherStudent` — the same order
      // `deleteStudentAccount` above and `unlinkTeacher`
      // (services/invitations.ts) both take these two rows in (#174 task 7;
      // see `docs/lock-order.md`). `unlinkTeacher` used to disagree and
      // deadlocked for real against this table pair; not repeating that
      // inversion here is the whole point of writing the order down.
      await tx.studentPrivacy.deleteMany({ where: { teacherId } });
      await tx.teacherStudent.deleteMany({ where: { teacherId } });
      // The teacher's CRM contacts — every one an address and a name they
      // typed about somebody ELSE. Deleted rather than anonymized, unlike the
      // student-side scrub above: the only thing an `Invitation` row means is
      // "this teacher may/may not invite this address", and with the teacher
      // erased there is nobody left to invite anyone. A tombstone guarding a
      // door that no longer exists is just a retained address. Safe on the
      // read side too — `listPendingInvitations` and `acceptInvitation` both
      // filter `deletedAt: null`, so these rows were already invisible to
      // every invitee the moment `deletedAt` below is set.
      //
      // `TeacherBlock` is NOT swept with them, and the asymmetry is
      // deliberate: this is a soft delete (`deletedAt` below, row retained),
      // so the rows have to survive a hypothetical restore. A restored
      // teacher whose contacts are gone simply re-types them; a restored
      // teacher whose blocks are gone has been silently un-refused by every
      // student who walked away. Erring toward the refusal is the only
      // direction that cannot hurt the person the block protects. The
      // student-erasure side of the same question is genuinely open — see
      // `deleteStudentAccount` above.
      await tx.invitation.deleteMany({ where: { teacherId } });
      await tx.notification.deleteMany({ where: { recipientType: 'teacher', recipientId: teacherId } });
      // Sessions and passkeys belong to the account. They die with the
      // erased profile unless a live student profile still uses the account.
      {
        const studentOnAccount = await tx.student.findFirst({
          where: { accountId: teacher.accountId, deletedAt: null },
          select: { id: true },
        });
        if (!studentOnAccount) {
          await tx.session.deleteMany({ where: { accountId: teacher.accountId } });
          await tx.passkeyCredential.deleteMany({ where: { accountId: teacher.accountId } });
          // Last live profile erased: the account email is PII too.
          await tx.account.update({
            where: { id: teacher.accountId },
            data: { email: `deleted-${teacher.accountId}@deleted.invalid` },
          });
        }
      }
      await tx.magicLinkToken.deleteMany({ where: { email: teacher.email } });

      // Scoped and aborting, for the same reason the student erasure above
      // is — see that write for the argument. It matters less here (this
      // function has no post-commit work of its own) and is done anyway so
      // the two halves answer a repeated request the same way: the route
      // catches this sentinel per half, and a teacher half that silently
      // re-erased while the student half refused would make that catch look
      // arbitrary to the next reader.
      //
      // What this abort does NOT undo, stated so it is not mistaken for a
      // whole-function guard: the `completeClass` loop at the top of this
      // function runs BEFORE this transaction opens and commits per class.
      // A loser that reaches this throw has already been through that loop.
      // It writes nothing, which is the part that matters: `completeClass`
      // takes the class row lock and `validateTransition` refuses
      // `completed → completed`. But "writes nothing" is not "does nothing" —
      // each refusal is logged by the loop above. It levels on
      // `observedStatus`: `warn` when the class is already `completed`, which
      // is exactly this case and pages nobody, and `error` for every other
      // reason, which are real. So a routine concurrent duplicate is visible
      // without being alarming, and a class that silently went unbilled still
      // reaches whoever watches `error`.
      // And `completeClass`'s 2s `lock_timeout` is
      // deliberately uncaught there, so a loser that waits too long throws
      // something that is NOT this sentinel and takes `erasureFailure`
      // instead. Either way the guarding is done by that loop, not by this.
      const erased = await tx.teacher.updateMany({
        where: { id: teacherId, deletedAt: null },
        data: {
          firstName: 'Deleted',
          lastName: 'Teacher',
          email: `deleted-${teacherId}@deleted.invalid`,
          photoUrl: null,
          bio: '',
          pageSlug: `deleted-${teacherId}`,
          bankIban: null,
          bankAccountName: null,
          customDomain: null,
          processorType: null,
          processorAccountId: null,
          deletedAt: new Date(),
        },
      });
      if (erased.count === 0) throw new AlreadyErasedError('teacher');
    },
    // `isActive`/`isArchived` live on `ScheduleRule` now (issue 298); the
    // ordered `FOR UPDATE OF ct`/`FOR UPDATE OF sct` pre-locks above the two
    // `updateMany`s take the same child row `claimTemplateForGeneration` /
    // `claimStudioTemplateForGeneration` (class-generator.ts,
    // studio-class-generator.ts) hold `FOR UPDATE` on for the duration of
    // their own per-template transactions (#95), so this erasure serialises
    // against a sweep or a resume in progress the same way the archive's own
    // child lock does now — one statement for both families, inside
    // `archiveOrUnarchiveRule` (`rule-lifecycle.ts`).
    //
    // This site needs the matching 10s budget more than those four
    // do, not just for symmetry: by the time this transaction opens,
    // `deleteTeacherAccount` has already run `completeClass` for every
    // in-progress class above — pricing, payments, and notifications
    // committed outside this transaction, not inside it. A P2028 here rolls
    // back the erasure but not that billing, leaving the two halves of one
    // account-deletion request permanently out of sync, and it surfaces as an
    // opaque 500 on `DELETE /api/account` rather than a merely-failed archive
    // click the teacher can just retry. This transaction is also already the
    // longest of the five sites: it loops over every upcoming class doing an
    // update plus bulk notifications before it ever reaches the template
    // rows, so it has less headroom against Prisma's 5s default than the
    // archive/pause sites did even before a lock wait enters the picture.
    { timeout: 10_000 },
  );
}
