import Link from 'next/link';
import type { ReactNode } from 'react';
import type { CalendarEntry, Class, TeacherRoom, Room, StudioClass, PaymentStatus } from '@prisma/client';
import { Card } from '@/components/ui/card';
import { StatusBadge, StatusBadgeSkeleton, deriveBadgeVariant, type BadgeVariant } from '@/components/ui/status-badge';
import { RegistrationProgress, RegistrationProgressSkeleton } from '@/components/ui/registration-progress';
import { SkeletonText } from '@/components/ui/skeleton';
import { Icon, IconSkeleton } from '@/components/ui/icon';
import { formatRoomLocation, formatDayHeader } from '@/lib/format';
import { timeToHHmm } from '@/lib/time-of-day';

export type ClassWithDetails = Class & {
  /** The calendar identity both card kinds render from. */
  calendarEntry: CalendarEntry;
  _count: { registrations: number };
  teacherRoom: TeacherRoom & { room: Room };
  /** Charged registrations' payment states — powers the completed-card rollup. */
  registrations?: { payment: { status: PaymentStatus } | null }[];
};

export type StudioClassWithEntry = StudioClass & { calendarEntry: CalendarEntry };

const CHEVRON_SIZE = 20;

type RowState = {
  variant: BadgeVariant;
  cancelled: boolean;
  past: boolean;
  showProgress: boolean;
};

function deriveClassRowState(cls: ClassWithDetails, isPast: boolean): RowState {
  const reg = cls._count.registrations;
  // Both card kinds read cancellation from the entry.
  const cancelled = cls.calendarEntry.cancelledAt !== null;
  const variant = deriveBadgeVariant(cls.status, cancelled, reg, cls.minStudents, cls.maxStudents);
  const past = !cancelled && (cls.status === 'completed' || isPast);
  // The signature bar appears while registrations still matter.
  const showProgress = !cancelled && !past && cls.status !== 'draft';
  return { variant, cancelled, past, showProgress };
}

// Completed classes roll payment state up inline — text, never a badge
// (see the status explorations, turn 2): ✓ all paid · ○ N unpaid ·
// ! N overdue · ⊘ N not charged. Silent until the class completes and
// payments exist.
function PaymentRollup({ cls }: { cls: ClassWithDetails }) {
  if (cls.status !== 'completed' || !cls.registrations) return null;
  const payments = cls.registrations
    .map((r) => r.payment)
    .filter((p): p is { status: PaymentStatus } => p !== null);
  if (payments.length === 0) return null;

  const overdue = payments.filter((p) => p.status === 'overdue').length;
  const unpaid = payments.filter((p) => p.status === 'pending').length;
  const notCharged = payments.filter((p) => p.status === 'not_charged').length;
  if (overdue > 0) {
    return <span className="text-danger font-medium"> · ! {overdue} overdue</span>;
  }
  if (unpaid > 0) {
    return <span className="text-brown"> · ○ {unpaid} unpaid</span>;
  }
  if (notCharged > 0) {
    return <span className="text-brown-light"> · ⊘ {notCharged} not charged</span>;
  }
  return <span className="text-teal font-medium"> · ✓ all paid</span>;
}

// The class card's inner layout: when + badge, title + chevron, caption, bar.
// Shared by `ClassCard` and `ClassCardSkeleton` so their frames never drift.
function ClassCardBody({ when, badge, title, chevron, caption, progress }: {
  when: ReactNode; badge: ReactNode; title: ReactNode; chevron: ReactNode; caption: ReactNode; progress: ReactNode;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-2">{when}{badge}</div>
      <div className="flex items-center gap-3 mt-1">{title}{chevron}</div>
      {caption}
      {progress}
    </>
  );
}

// Class card: day/time + status badge, class type, room, and the
// registration progress bar. Sand surface, radius 16, chevron.
export function ClassCard({ cls, isPast }: { cls: ClassWithDetails; isPast: boolean }) {
  const { variant, cancelled, past, showProgress } = deriveClassRowState(cls, isPast);
  const reg = cls._count.registrations;

  return (
    <Card href={`/class/${cls.id}`} className={past || cancelled ? 'opacity-70' : ''}>
      <ClassCardBody
        when={
          <span className="type-label text-ink">
            {formatDayHeader(cls.calendarEntry.date)} · {timeToHHmm(cls.calendarEntry.startTime)}
          </span>
        }
        badge={<StatusBadge variant={variant} />}
        title={
          <span
            className={`type-subtitle flex-1 min-w-0${cancelled ? ' line-through decoration-brown decoration-[1.5px]' : ''}`}
          >
            {cls.calendarEntry.classType}
          </span>
        }
        chevron={<Icon name="chevron-right" size={CHEVRON_SIZE} className="text-brown-light" />}
        caption={
          <p className="type-caption mt-0.5">
            {formatRoomLocation(cls.teacherRoom.room.roomName, cls.teacherRoom.room.venueName)}
            <PaymentRollup cls={cls} />
          </p>
        }
        progress={
          showProgress && (
            <RegistrationProgress
              registered={reg}
              min={cls.minStudents}
              max={cls.maxStudents}
              className="mt-3"
            />
          )
        }
      />
    </Card>
  );
}

// The class card's loading state: same `Card` frame and `ClassCardBody`
// layout, every placeholder already `aria-hidden` so `Card` needs no new
// prop for it.
export function ClassCardSkeleton() {
  return (
    <Card>
      <ClassCardBody
        when={<SkeletonText type="type-label" width="w-32" surface="card" />}
        badge={<StatusBadgeSkeleton surface="card" />}
        title={<SkeletonText type="type-subtitle" width="w-1/2" surface="card" className="flex-1 min-w-0" />}
        chevron={<IconSkeleton size={CHEVRON_SIZE} surface="card" />}
        caption={<SkeletonText type="type-caption" width="w-1/3" surface="card" className="mt-0.5" />}
        progress={<RegistrationProgressSkeleton className="mt-3" surface="card" />}
      />
    </Card>
  );
}

// Studio classes are visually lighter: dashed border on cream, no bar.
// Their frame — shared by `StudioClassCard` and `StudioClassCardSkeleton`.
const STUDIO_CARD_FRAME = 'border border-dashed border-border rounded-card px-5 py-3';

// The studio card's inner layout: when + badge, then a caption line. Shared
// by `StudioClassCard` and `StudioClassCardSkeleton` so their frames never
// drift, the same way `ClassCardBody` does for the regular card.
function StudioClassCardBody({ when, badge, caption }: { when: ReactNode; badge: ReactNode; caption: ReactNode }) {
  return (
    <>
      <div className="flex items-center justify-between gap-2">{when}{badge}</div>
      {caption}
    </>
  );
}

// A studio class's "done" state is text, not a badge (like payment states):
// a teal ✓ once the student count is logged, a quiet nudge while it's missing.
export function StudioClassCard({ sc, isPast }: { sc: StudioClassWithEntry; isPast: boolean }) {
  const cancelled = sc.calendarEntry.cancelledAt !== null;
  const past = !cancelled && isPast;
  const logged = sc.studentCount !== null;

  return (
    <Link
      href={`/studio-class/${sc.id}`}
      className={`block ${STUDIO_CARD_FRAME} no-underline hover:bg-sand-soft${past || cancelled ? ' opacity-70' : ''}`}
    >
      <StudioClassCardBody
        when={
          <span className={`type-label text-ink${cancelled ? ' line-through decoration-brown' : ''}`}>
            {formatDayHeader(sc.calendarEntry.date)} · {timeToHHmm(sc.calendarEntry.startTime)}
          </span>
        }
        badge={cancelled && <StatusBadge variant="cancelled" />}
        caption={
          <p className="type-caption mt-0.5">
            {sc.calendarEntry.classType
              ? `${sc.calendarEntry.classType} · ${sc.location}`
              : sc.location} · Studio class
            {logged && (
              <span className="text-teal">
                {' '}· ✓ {sc.studentCount} {sc.studentCount === 1 ? 'student' : 'students'}
              </span>
            )}
            {!logged && past && !cancelled && (
              <span className="text-brown"> · ○ add student count</span>
            )}
          </p>
        }
      />
    </Link>
  );
}

// The studio card's skeleton shape: the dashed frame, no link, bars on the
// page surface since the dashed card sits directly on cream.
export function StudioClassCardSkeleton() {
  return (
    <div className={STUDIO_CARD_FRAME}>
      <StudioClassCardBody
        when={<SkeletonText type="type-label" width="w-32" surface="page" />}
        badge={null}
        caption={<SkeletonText type="type-caption" width="w-1/3" surface="page" className="mt-0.5" />}
      />
    </div>
  );
}
