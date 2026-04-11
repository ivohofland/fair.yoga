import type { Class, ClassStatus, TeacherRoom, Room } from '@prisma/client';
import { StatusDot } from '@/components/ui/status-dot';
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
          <StatusDot status={cls.status} label={STATUS_LABELS[cls.status]} />
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
          <StatusDot status={cls.status} label={STATUS_LABELS[cls.status]} />
          <p className="text-dark">{STATUS_LABELS[cls.status]}</p>
        </div>
      </div>
    </div>
  );
}
