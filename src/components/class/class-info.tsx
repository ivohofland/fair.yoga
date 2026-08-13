import type { Class, TeacherRoom, Room } from '@prisma/client';
import { StatusBadge, deriveBadgeVariant } from '@/components/ui/status-badge';
import { RegistrationProgress } from '@/components/ui/registration-progress';
import { formatRoomLocation, formatDateWithYear } from '@/lib/format';

type ClassWithRoom = Class & {
  teacherRoom: TeacherRoom & { room: Room };
};

interface ClassInfoProps {
  cls: ClassWithRoom;
  registrationCount: number;
  waitlistCount: number;
}

// Class header block: when/where, count, status badge, and the
// registration progress bar while registrations still matter.
export function ClassInfo({ cls, registrationCount, waitlistCount }: ClassInfoProps) {
  const variant = deriveBadgeVariant(cls.status, registrationCount, cls.minStudents, cls.maxStudents);
  const showProgress = cls.status === 'open' || cls.status === 'in_progress';

  // #199, second half. Filtering the count to `waiting` entries fixed the
  // entry side of the defect and left the class side open: nothing closes a
  // queue when a class leaves `open` by starting (#216), so a class that ran
  // with three waiters kept telling its teacher "3 on waitlist", present
  // tense, forever — the same sentence #199 was filed about, one surface over.
  //
  // `in_progress` is deliberately included rather than `open` alone: during
  // check-in a teacher may still walk a waiting student in
  // (`api/registrations/route.ts` allows `in_progress` for a teacher, and
  // closes that student's entry to `claimed`), so the number is still
  // actionable. After `completed` nothing can consume the queue.
  // `cancelled` already reads 0 — every cancel path closes its entries to
  // `removed` (#195) — so `completed` is the live case this fixes.
  //
  // Written as its own condition rather than reusing `showProgress`: the two
  // windows coincide today for the same reason (registrations still matter),
  // but they are separate decisions and a change to one must not silently
  // move the other.
  const queueIsLive = cls.status === 'open' || cls.status === 'in_progress';

  return (
    <div className="mb-6">
      <div className="mb-2">
        <StatusBadge variant={variant} />
      </div>
      <p className="type-body text-ink">
        {formatDateWithYear(cls.date)} &middot; {cls.startTime} &middot; {cls.durationMinutes} min
      </p>
      <p className="type-body">
        {formatRoomLocation(cls.teacherRoom.room.roomName, cls.teacherRoom.room.venueName)}
      </p>
      <p className="type-caption mt-1">
        {registrationCount} registered &middot; needs {cls.minStudents} to go ahead
        {queueIsLive && waitlistCount > 0 && <> &middot; {waitlistCount} on waitlist</>}
      </p>
      {showProgress && (
        <RegistrationProgress
          registered={registrationCount}
          min={cls.minStudents}
          max={cls.maxStudents}
          className="mt-5"
        />
      )}
    </div>
  );
}
