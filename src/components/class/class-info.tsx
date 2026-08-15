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

  // #199. `in_progress` is included, not `open` alone: `closeQueueOnStart`
  // (#216) closes the queue the moment a class starts, but a teacher can still
  // walk one of those students in at the door, so the number stays actionable.
  // After `completed` nothing can consume it, so it stops rendering.
  //
  // Written as its own condition rather than reusing `showProgress`: the two
  // windows coincide today for the same reason (registrations still matter),
  // but they are separate decisions and a change to one must not silently move
  // the other.
  const queueIsLive = cls.status === 'open' || cls.status === 'in_progress';

  // Two different sets, so two different sentences — and the sentence has to
  // describe the set the caller actually counted, or it goes stale as the
  // number moves.
  //
  // While `open`, `waitlistCount` is the live queue: "N on waitlist" is true and
  // stays true. While `in_progress` it is `CLAIMABLE_WAITLIST_STATUSES` — the
  // students who never got a seat and can still be walked in — and that number
  // FALLS as the teacher walks them in. "N were on the waitlist" would be wrong
  // in both directions: it never counted the students who were promoted before
  // the class started, and it would keep shrinking while claiming to be history.
  // "N didn't get a spot" describes exactly the set being counted, and stays
  // true as walk-ins remove people from it.
  const waitlistLabel =
    cls.status === 'in_progress'
      ? `${waitlistCount} didn't get a spot`
      : `${waitlistCount} on waitlist`;

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
        {queueIsLive && waitlistCount > 0 && <> &middot; {waitlistLabel}</>}
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
