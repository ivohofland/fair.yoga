import type { Class, TeacherRoom, Room } from '@prisma/client';
import { StatusBadge, deriveBadgeVariant } from '@/components/ui/status-badge';
import { RegistrationProgress } from '@/components/ui/registration-progress';
import { formatRoomLocation } from '@/lib/format';

type ClassWithRoom = Class & {
  teacherRoom: TeacherRoom & { room: Room };
};

interface ClassInfoProps {
  cls: ClassWithRoom;
  registrationCount: number;
  waitlistCount: number;
}

function formatClassDate(date: Date): string {
  const d = new Date(date);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const dayName = days[d.getUTCDay()];
  const monthName = months[d.getUTCMonth()];
  const dayNum = d.getUTCDate();
  const year = d.getUTCFullYear();
  return `${dayName ?? ''}, ${monthName ?? ''} ${dayNum}, ${year}`;
}

// Class header block: when/where, count, status badge, and the
// registration progress bar while registrations still matter.
export function ClassInfo({ cls, registrationCount, waitlistCount }: ClassInfoProps) {
  const variant = deriveBadgeVariant(cls.status, registrationCount, cls.minStudents, cls.maxStudents);
  const showProgress = cls.status === 'open' || cls.status === 'in_progress';

  return (
    <div className="mb-6">
      <div className="mb-2">
        <StatusBadge variant={variant} />
      </div>
      <p className="type-body text-ink">
        {formatClassDate(cls.date)} &middot; {cls.startTime} &middot; {cls.durationMinutes} min
      </p>
      <p className="type-body">
        {formatRoomLocation(cls.teacherRoom.room.roomName, cls.teacherRoom.room.venueName)}
      </p>
      <p className="type-caption mt-1">
        {registrationCount} registered &middot; needs {cls.minStudents} to go ahead
        {waitlistCount > 0 && <> &middot; {waitlistCount} on waitlist</>}
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
