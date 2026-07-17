import type { Class, ClassStatus, TeacherRoom, Room } from '@prisma/client';
import { StatusDot, deriveDotShape, type DotShape } from '@/components/ui/status-dot';
import { formatRoomLocation } from '@/lib/format';

type ClassWithRoom = Class & {
  teacherRoom: TeacherRoom & { room: Room };
};

interface ClassInfoProps {
  cls: ClassWithRoom;
  registrationCount: number;
  waitlistCount: number;
}

const STATUS_LABELS: Record<ClassStatus, string> = {
  draft: 'Draft',
  open: 'Open for registration',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function deriveDisplayStatus(
  status: ClassStatus,
  registrationCount: number,
  minStudents: number,
  maxStudents: number,
): { dotShape: DotShape | null; label: string } {
  if (status === 'open') {
    return {
      dotShape: deriveDotShape(registrationCount, minStudents, maxStudents),
      label: registrationCount >= maxStudents ? 'Full' : STATUS_LABELS.open,
    };
  }
  return { dotShape: null, label: STATUS_LABELS[status] };
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

export function ClassInfo({ cls, registrationCount, waitlistCount }: ClassInfoProps) {
  const { dotShape, label } = deriveDisplayStatus(cls.status, registrationCount, cls.minStudents, cls.maxStudents);

  return (
    <div className="mb-6">
      <div className="py-3 border-b border-border">
        <span className="text-sm text-brown">Date</span>
        <p className="text-dark">{formatClassDate(cls.date)}</p>
      </div>

      <div className="py-3 border-b border-border">
        <span className="text-sm text-brown">Time</span>
        <p className="text-dark">{cls.startTime} &middot; {cls.durationMinutes} min</p>
      </div>

      <div className="py-3 border-b border-border">
        <span className="text-sm text-brown">Room</span>
        <p className="text-dark">
          {formatRoomLocation(cls.teacherRoom.room.roomName, cls.teacherRoom.room.venueName)}
        </p>
      </div>

      <div className="py-3 border-b border-border">
        <span className="text-sm text-brown">Registration</span>
        <div className="flex items-center gap-2">
          <p className="text-dark">
            {registrationCount} / {cls.maxStudents}
          </p>
        </div>
        {waitlistCount > 0 && (
          <p className="text-brown text-xs mt-1">
            {waitlistCount} on waitlist
          </p>
        )}
      </div>

      <div className="py-3 border-b border-border">
        <span className="text-sm text-brown">Status</span>
        <div className="flex items-center gap-2">
          {dotShape && <StatusDot shape={dotShape} label={label} />}
          <p className="text-dark">{label}</p>
        </div>
      </div>
    </div>
  );
}
