import Link from 'next/link';
import { ClassCard, StudioClassCard, type ClassWithDetails, type StudioClassWithEntry } from '@/components/schedule/class-card';
import { EmptyState } from '@/components/ui/empty-state';
import { FULL_MONTHS } from '@/lib/format';
import { classStartInstant, startOfLocalWeek, mondayOf } from '@/lib/timezone';
import { classEndInstant } from '@/lib/finish-window';
import type { TimelineItem } from '@/lib/now-line';
import { NowSlot, NowTimeline } from '@/components/schedule/now-timeline';
import { WEEK_HEADING_GAP, WEEK_ITEMS } from '@/components/schedule/class-list-skeleton';

interface ClassListProps {
  classes: ClassWithDetails[];
  studioClasses?: StudioClassWithEntry[];
  timeZone: string;
  emptyMessage?: string;
  showAddLink?: boolean;
  dimPast?: boolean;
  /** Draw the "now" line and the next/running labels; ascending lists only. */
  showNow?: boolean;
  sortDesc?: boolean;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** "This week" / "Next week" / "Last week" / "Week of 4 August". */
function weekLabel(itemDate: Date, thisMonday: number): string {
  const itemMonday = mondayOf(itemDate);
  if (itemMonday === thisMonday) return 'This week';
  if (itemMonday === thisMonday + WEEK_MS) return 'Next week';
  if (itemMonday === thisMonday - WEEK_MS) return 'Last week';
  const d = new Date(itemMonday);
  return `Week of ${d.getUTCDate()} ${FULL_MONTHS[d.getUTCMonth()]}`;
}

type ScheduleItem =
  | { type: 'class'; data: ClassWithDetails; dateTime: Date }
  | { type: 'studio'; data: StudioClassWithEntry; dateTime: Date };

export function ClassList({ classes, studioClasses = [], timeZone, emptyMessage = 'No classes yet', showAddLink = true, dimPast = false, showNow = false, sortDesc = false }: ClassListProps) {
  const now = new Date();
  const thisMonday = startOfLocalWeek(now, timeZone).getTime();

  const items: ScheduleItem[] = [
    ...classes.map((c) => ({
      type: 'class' as const,
      data: c,
      dateTime: classStartInstant(c.calendarEntry, timeZone),
    })),
    ...studioClasses.map((sc) => ({
      type: 'studio' as const,
      data: sc,
      dateTime: classStartInstant(sc.calendarEntry, timeZone),
    })),
  ].sort((a, b) => sortDesc
    ? b.dateTime.getTime() - a.dateTime.getTime()
    : a.dateTime.getTime() - b.dateTime.getTime(),
  );

  const totalCount = items.length;

  // Keyed by family as well as id: the two families' ids are separate keyspaces.
  const slotId = (item: ScheduleItem): string => `${item.type}:${item.data.id}`;
  const timeline: TimelineItem[] = items.map((item) => ({
    id: slotId(item),
    start: item.dateTime.getTime(),
    end: classEndInstant(item.data.calendarEntry, timeZone).getTime(),
    cancelled: item.data.calendarEntry.cancelledAt !== null,
    completed: item.type === 'class' && item.data.status === 'completed',
  }));

  const list = (
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
        // The list breaks at week boundaries — a section head in the same
        // idiom as "By month" or "Updates" (see the v2 kit's Schedule spec).
        (() => {
          const groups: { label: string; items: ScheduleItem[] }[] = [];
          for (const item of items) {
            const label = weekLabel(item.data.calendarEntry.date, thisMonday);
            const last = groups[groups.length - 1];
            if (last && last.label === label) last.items.push(item);
            else groups.push({ label, items: [item] });
          }
          return groups.map((group, gi) => (
            <section key={group.label}>
              <h2 className={`type-subtitle ${WEEK_HEADING_GAP} ${gi === 0 ? '' : 'mt-8'}`}>{group.label}</h2>
              <div className={WEEK_ITEMS}>
                {group.items.map((item) => {
                  const isPast = dimPast && item.dateTime < now;
                  return (
                    <NowSlot key={slotId(item)} id={slotId(item)}>
                      {item.type === 'class'
                        ? <ClassCard cls={item.data} isPast={isPast} />
                        : <StudioClassCard sc={item.data} isPast={isPast} />}
                    </NowSlot>
                  );
                })}
              </div>
            </section>
          ));
        })()
      )}
    </div>
  );

  return showNow
    ? <NowTimeline items={timeline} timeZone={timeZone} serverNow={now.getTime()}>{list}</NowTimeline>
    : list;
}
