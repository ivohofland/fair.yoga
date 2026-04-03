import Link from 'next/link';
import type { Class, TeacherRoom, Room } from '@prisma/client';
import { StatusDot } from '@/components/ui/status-dot';

type ClassWithDetails = Class & {
  _count: { registrations: number };
  teacherRoom: TeacherRoom & { room: Room };
};

interface ClassListProps {
  classes: ClassWithDetails[];
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

export function ClassList({ classes }: ClassListProps) {
  return (
    <div>
      <div className="mb-4">
        <Link href="/class/new" className="text-teal text-sm font-medium">
          + Create class
        </Link>
      </div>

      {classes.length === 0 ? (
        <p className="text-brown text-sm">
          No classes yet. Create your first class.
        </p>
      ) : (
        <div>
          {classes.map((cls) => (
            <Link
              key={cls.id}
              href={`/class/${cls.id}`}
              className="flex items-start justify-between py-3 border-b border-border"
            >
              <div className="flex flex-col gap-1">
                <span className="text-dark text-sm font-medium">
                  {formatDate(cls.date)} &middot; {cls.startTime}
                </span>
                <span className="text-dark text-sm">{cls.classType}</span>
                <span className="text-brown text-xs">
                  {cls.teacherRoom.room.roomName}, {cls.teacherRoom.room.venueName}
                </span>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <span className="text-brown text-sm">
                  {cls._count.registrations}/{cls.maxStudents}
                </span>
                <StatusDot status={cls.status} label={cls.status.replace('_', ' ')} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
