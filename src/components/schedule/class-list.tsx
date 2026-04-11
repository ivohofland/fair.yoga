import Link from 'next/link';
import type { Class, TeacherRoom, Room, StudioClass } from '@prisma/client';
import { StatusDot, type Status } from '@/components/ui/status-dot';
import { formatRoomLocation } from '@/lib/format';

type ClassWithDetails = Class & {
  _count: { registrations: number };
  teacherRoom: TeacherRoom & { room: Room };
};

interface ClassListProps {
  classes: ClassWithDetails[];
  studioClasses?: StudioClass[];
  emptyMessage?: string;
  showAddLink?: boolean;
  dimPast?: boolean;
  sortDesc?: boolean;
}

function formatDayHeader(date: Date): string {
  const d = new Date(date);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function dateKey(date: Date): string {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function deriveDisplayStatus(cls: ClassWithDetails): Status {
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
        <span className="text-dark text-sm">
          <span className="font-medium">{cls.startTime}</span> &ndash; {cls.classType}
        </span>
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

function StudioClassRow({ sc, dimmed }: { sc: StudioClass; dimmed?: boolean }) {
  const isCancelled = Boolean(sc.cancelledAt);

  return (
    <Link
      key={sc.id}
      href={`/studio-class/${sc.id}`}
      className={`flex items-start justify-between py-3 border-b border-border${dimmed || isCancelled ? ' opacity-50' : ''}`}
    >
      <div className="flex flex-col gap-1">
        <span className="text-dark text-sm">
          <span className="font-medium">{sc.startTime}</span> &ndash; {sc.classType || sc.location}
        </span>
        <span className="text-brown text-xs">{isCancelled ? 'Cancelled' : `${sc.classType ? sc.location + ' \u00B7 ' : ''}Studio class`}</span>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <span className="text-brown text-sm">
          {isCancelled ? '' : sc.studentCount !== null ? `${sc.studentCount} students` : '\u2014'}
        </span>
      </div>
    </Link>
  );
}

type ScheduleItem =
  | { type: 'class'; data: ClassWithDetails; dateTime: Date }
  | { type: 'studio'; data: StudioClass; dateTime: Date };

function itemDateTime(date: Date, startTime: string): Date {
  const d = new Date(date);
  const [hours, minutes] = startTime.split(':').map(Number);
  d.setUTCHours(hours!, minutes!, 0, 0);
  return d;
}

export function ClassList({ classes, studioClasses = [], emptyMessage = 'No classes yet. Create your first class.', showAddLink = true, dimPast = false, sortDesc = false }: ClassListProps) {
  const now = new Date();

  // Merge into a single sorted timeline
  const items: ScheduleItem[] = [
    ...classes.map((c) => ({ type: 'class' as const, data: c, dateTime: itemDateTime(c.date, c.startTime) })),
    ...studioClasses.map((sc) => ({ type: 'studio' as const, data: sc, dateTime: itemDateTime(sc.date, sc.startTime) })),
  ].sort((a, b) => sortDesc
    ? b.dateTime.getTime() - a.dateTime.getTime()
    : a.dateTime.getTime() - b.dateTime.getTime(),
  );

  const totalCount = items.length;

  return (
    <div>
      {showAddLink && (
        <div className="mb-4">
          <Link href="/class/new" className="text-teal text-sm font-medium">
            + Add class
          </Link>
        </div>
      )}

      {totalCount === 0 ? (
        <p className="text-brown text-sm">
          {emptyMessage}
        </p>
      ) : (
        <div>
          {items.map((item, i) => {
            const isPast = dimPast && item.dateTime < now;
            const key = dateKey(item.type === 'class' ? item.data.date : item.data.date);
            const prevKey = i > 0
              ? dateKey(items[i - 1]!.type === 'class' ? items[i - 1]!.data.date : items[i - 1]!.data.date)
              : null;
            const showHeader = key !== prevKey;

            return (
              <div key={item.data.id}>
                {showHeader && (
                  <h3 className={`font-heading text-lg font-bold text-dark ${i > 0 ? 'mt-6' : ''} mb-2${isPast ? ' opacity-50' : ''}`}>
                    {formatDayHeader(item.type === 'class' ? item.data.date : item.data.date)}
                  </h3>
                )}
                {item.type === 'class'
                  ? <ClassRow cls={item.data} dimmed={isPast} />
                  : <StudioClassRow sc={item.data} dimmed={isPast} />
                }
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
