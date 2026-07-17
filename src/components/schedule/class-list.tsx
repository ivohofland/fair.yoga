import Link from 'next/link';
import type { Class, TeacherRoom, Room, StudioClass } from '@prisma/client';
import { StatusBadge, deriveBadgeVariant, type BadgeVariant } from '@/components/ui/status-badge';
import { RegistrationProgress } from '@/components/ui/registration-progress';
import { Icon } from '@/components/ui/icon';
import { EmptyState } from '@/components/ui/empty-state';
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

type RowState = {
  variant: BadgeVariant;
  cancelled: boolean;
  past: boolean;
  showProgress: boolean;
};

function deriveClassRowState(cls: ClassWithDetails, isPast: boolean): RowState {
  const reg = cls._count.registrations;
  const variant = deriveBadgeVariant(cls.status, reg, cls.minStudents, cls.maxStudents);
  const cancelled = cls.status === 'cancelled';
  const past = !cancelled && (cls.status === 'completed' || isPast);
  // The signature bar appears while registrations still matter.
  const showProgress = !cancelled && !past && cls.status !== 'draft';
  return { variant, cancelled, past, showProgress };
}

// Class card: day/time + status badge, class type, room, and the
// registration progress bar. Sand surface, radius 16, chevron.
function ClassCard({ cls, isPast }: { cls: ClassWithDetails; isPast: boolean }) {
  const { variant, cancelled, past, showProgress } = deriveClassRowState(cls, isPast);
  const reg = cls._count.registrations;

  return (
    <Link
      href={`/class/${cls.id}`}
      className={`block bg-sand-soft border border-border rounded-card p-5 no-underline hover:bg-sand${past || cancelled ? ' opacity-40' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="type-label text-ink">
          {formatDayHeader(cls.date)} · {cls.startTime}
        </span>
        <StatusBadge variant={variant} />
      </div>
      <div className="flex items-center gap-3 mt-1">
        <span
          className={`type-subtitle flex-1 min-w-0${cancelled ? ' line-through decoration-brown decoration-[1.5px]' : ''}`}
        >
          {cls.classType}
        </span>
        <Icon name="chevron-right" size={20} className="text-brown-light" />
      </div>
      <p className="type-caption mt-0.5">
        {formatRoomLocation(cls.teacherRoom.room.roomName, cls.teacherRoom.room.venueName)}
      </p>
      {showProgress && (
        <RegistrationProgress
          registered={reg}
          min={cls.minStudents}
          max={cls.maxStudents}
          className="mt-3"
        />
      )}
    </Link>
  );
}

// Studio classes are visually lighter: dashed border on cream, no bar.
function StudioClassCard({ sc, isPast }: { sc: StudioClass; isPast: boolean }) {
  const cancelled = Boolean(sc.cancelledAt);
  const past = !cancelled && isPast;
  const count = sc.studentCount !== null ? ` · ${sc.studentCount} students` : '';

  return (
    <Link
      href={`/studio-class/${sc.id}`}
      className={`block border border-dashed border-border rounded-card px-5 py-3 no-underline hover:bg-sand-soft${past || cancelled ? ' opacity-40' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={`type-label text-ink${cancelled ? ' line-through decoration-brown' : ''}`}
        >
          {formatDayHeader(sc.date)} · {sc.startTime}
        </span>
        {cancelled && <StatusBadge variant="cancelled" />}
      </div>
      <p className="type-caption mt-0.5">
        {sc.classType ? `${sc.classType} · ${sc.location}` : sc.location} · Studio class{count}
      </p>
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

export function ClassList({ classes, studioClasses = [], emptyMessage = 'No classes yet', showAddLink = true, dimPast = false, sortDesc = false }: ClassListProps) {
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
          <Link href="/class/new" className="type-label text-teal no-underline">
            + Add class
          </Link>
        </div>
      )}

      {totalCount === 0 ? (
        <EmptyState title={emptyMessage} body="Classes you create appear here." />
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => {
            const isPast = dimPast && item.dateTime < now;
            return item.type === 'class'
              ? <ClassCard key={item.data.id} cls={item.data} isPast={isPast} />
              : <StudioClassCard key={item.data.id} sc={item.data} isPast={isPast} />;
          })}
        </div>
      )}
    </div>
  );
}
