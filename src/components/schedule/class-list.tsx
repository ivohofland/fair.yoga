import Link from 'next/link';
import type { Class, TeacherRoom, Room, StudioClass } from '@prisma/client';
import { StatusDot, deriveDotShape, type DotShape } from '@/components/ui/status-dot';
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

type RowState = {
  dotShape: DotShape | null;
  state: string;
  cancelled: boolean;
  past: boolean;
};

function deriveClassRowState(cls: ClassWithDetails, isPast: boolean): RowState {
  if (cls.status === 'cancelled') return { dotShape: null, state: 'cancelled', cancelled: true, past: false };
  if (cls.status === 'draft') return { dotShape: null, state: 'draft', cancelled: false, past: false };
  if (cls.status === 'completed' || isPast) return { dotShape: null, state: 'past', cancelled: false, past: true };

  const reg = cls._count.registrations;
  const dotShape = deriveDotShape(reg, cls.minStudents, cls.maxStudents);
  const state = dotShape === 'filled' ? 'full' : dotShape === 'half' ? 'filling' : 'open';
  return { dotShape, state, cancelled: false, past: false };
}

function RowMeta({ count, dotShape, state }: { count?: string; dotShape: DotShape | null; state: string }) {
  return (
    <div className="flex flex-col items-end gap-1 shrink-0 text-[13px] text-brown fy-oldstyle-tabular">
      {count && <span className="leading-[1.4]">{count}</span>}
      <span className="inline-flex items-baseline gap-[6px]">
        {dotShape && <StatusDot shape={dotShape} label={state} />}
        <span className="font-heading italic">{state}</span>
      </span>
    </div>
  );
}

function ClassRow({ cls, isPast }: { cls: ClassWithDetails; isPast: boolean }) {
  const { dotShape, state, cancelled, past } = deriveClassRowState(cls, isPast);
  const reg = cls._count.registrations;

  return (
    <Link
      key={cls.id}
      href={`/class/${cls.id}`}
      className={`flex items-start justify-between gap-4 py-4 border-b border-border no-underline last:border-b-0${past ? ' opacity-40' : ''}`}
    >
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div
          className={`text-[15px] text-dark leading-[1.4]${cancelled ? ' line-through decoration-[0.5px] decoration-brown' : ''}`}
        >
          <span className="font-semibold">{cls.classType}</span>
          {' · '}
          {cls.startTime}
        </div>
        <div className="text-[12px] text-brown fy-oldstyle">
          {formatRoomLocation(cls.teacherRoom.room.roomName, cls.teacherRoom.room.venueName)}
        </div>
      </div>
      <RowMeta
        count={`${reg} / ${cls.maxStudents}`}
        dotShape={dotShape}
        state={state}
      />
    </Link>
  );
}

function StudioClassRow({ sc, isPast }: { sc: StudioClass; isPast: boolean }) {
  const cancelled = Boolean(sc.cancelledAt);
  const past = !cancelled && isPast;
  const state = cancelled ? 'cancelled' : past ? 'past' : 'studio';
  const count = sc.studentCount !== null ? `${sc.studentCount} students` : undefined;

  return (
    <Link
      key={sc.id}
      href={`/studio-class/${sc.id}`}
      className={`flex items-start justify-between gap-4 py-4 border-b border-border no-underline last:border-b-0${past || cancelled ? ' opacity-40' : ''}`}
    >
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div
          className={`text-[15px] text-dark leading-[1.4]${cancelled ? ' line-through decoration-[0.5px] decoration-brown' : ''}`}
        >
          <span className="font-semibold">{sc.classType || sc.location}</span>
          {' · '}
          {sc.startTime}
        </div>
        <div className="text-[12px] text-brown fy-oldstyle">
          {sc.classType ? `${sc.location} · Studio class` : 'Studio class'}
        </div>
      </div>
      <RowMeta count={count} dotShape={null} state={state} />
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
          <Link href="/class/new" className="text-[13px] text-brown">
            Add class
          </Link>
        </div>
      )}

      {totalCount === 0 ? (
        <p className="fy-lede">{emptyMessage}</p>
      ) : (
        <div>
          {items.map((item, i) => {
            const isPast = dimPast && item.dateTime < now;
            const key = dateKey(item.data.date);
            const prevKey = i > 0 ? dateKey(items[i - 1]!.data.date) : null;
            const showHeader = key !== prevKey;

            return (
              <div key={item.data.id}>
                {showHeader && (
                  <h3 className={`font-heading text-lg font-bold text-dark ${i > 0 ? 'mt-6' : ''} mb-2${isPast ? ' opacity-40' : ''}`}>
                    {formatDayHeader(item.data.date)}
                  </h3>
                )}
                {item.type === 'class'
                  ? <ClassRow cls={item.data} isPast={isPast} />
                  : <StudioClassRow sc={item.data} isPast={isPast} />
                }
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
