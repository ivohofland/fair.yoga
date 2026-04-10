import Link from 'next/link';
import type { Class, TeacherRoom, Room } from '@prisma/client';
import { StatusDot } from '@/components/ui/status-dot';
import { formatRoomLocation } from '@/lib/format';

type ClassWithDetails = Class & {
  _count: { registrations: number };
  teacherRoom: TeacherRoom & { room: Room };
};

interface ClassListProps {
  classes: ClassWithDetails[];
  emptyMessage?: string;
  showAddLink?: boolean;
  dimPast?: boolean;
}

function formatDate(date: Date): string {
  const d = new Date(date);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const dayName = days[d.getUTCDay()];
  const monthName = months[d.getUTCMonth()];
  const dayNum = d.getUTCDate();
  return `${dayName}, ${monthName} ${dayNum}`;
}

function deriveDisplayStatus(cls: ClassWithDetails): string {
  if (cls.status === 'open' && cls._count.registrations >= cls.maxStudents) {
    return 'open_full';
  }
  return cls.status;
}

function ClassRow({ cls, dimmed }: { cls: ClassWithDetails; dimmed?: boolean }) {
  const displayStatus = deriveDisplayStatus(cls);

  return (
    <Link
      key={cls.id}
      href={`/class/${cls.id}`}
      className={`flex items-start justify-between py-3 border-b border-border${dimmed ? ' opacity-50' : ''}`}
    >
      <div className="flex flex-col gap-1">
        <span className="text-dark text-sm font-medium">
          {formatDate(cls.date)} &middot; {cls.startTime}
        </span>
        <span className="text-dark text-sm">{cls.classType}</span>
        <span className="text-brown text-xs">
          {formatRoomLocation(cls.teacherRoom.room.roomName, cls.teacherRoom.room.venueName)}
        </span>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <span className="text-brown text-sm">
          {cls._count.registrations}/{cls.maxStudents}
        </span>
        <StatusDot status={displayStatus} label={displayStatus.replace('_', ' ')} />
      </div>
    </Link>
  );
}

function classDateTime(cls: ClassWithDetails): Date {
  const d = new Date(cls.date);
  const [hours, minutes] = cls.startTime.split(':').map(Number);
  d.setUTCHours(hours!, minutes!, 0, 0);
  return d;
}

export function ClassList({ classes, emptyMessage = 'No classes yet. Create your first class.', showAddLink = true, dimPast = false }: ClassListProps) {
  const now = new Date();

  const past = dimPast ? classes.filter((cls) => classDateTime(cls) < now) : [];
  const upcoming = dimPast ? classes.filter((cls) => classDateTime(cls) >= now) : classes;

  return (
    <div>
      {showAddLink && (
        <div className="mb-4">
          <Link href="/class/new" className="text-teal text-sm font-medium">
            + Add class
          </Link>
        </div>
      )}

      {classes.length === 0 ? (
        <p className="text-brown text-sm">
          {emptyMessage}
        </p>
      ) : (
        <div>
          {past.map((cls) => (
            <ClassRow key={cls.id} cls={cls} dimmed />
          ))}
          {upcoming.map((cls) => (
            <ClassRow key={cls.id} cls={cls} />
          ))}
        </div>
      )}
    </div>
  );
}
