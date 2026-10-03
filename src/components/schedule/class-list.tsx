import Link from 'next/link';
import { ClassCard, ClassCardSkeleton, StudioClassCard, type ClassWithDetails, type StudioClassWithEntry } from '@/components/schedule/class-card';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonText } from '@/components/ui/skeleton';
import { FULL_MONTHS } from '@/lib/format';
import { classStartInstant, startOfLocalWeek, mondayOf } from '@/lib/timezone';

interface ClassListProps {
  classes: ClassWithDetails[];
  studioClasses?: StudioClassWithEntry[];
  timeZone: string;
  emptyMessage?: string;
  showAddLink?: boolean;
  dimPast?: boolean;
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

// The week section's heading gap and item stack, shared by the real list
// and `ClassListSkeleton` so neither can drift from the other's spacing.
const WEEK_HEADING_GAP = 'mb-3';
const WEEK_ITEMS = 'flex flex-col gap-3';

export function ClassList({ classes, studioClasses = [], timeZone, emptyMessage = 'No classes yet', showAddLink = true, dimPast = false, sortDesc = false }: ClassListProps) {
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
                  return item.type === 'class'
                    ? <ClassCard key={item.data.id} cls={item.data} isPast={isPast} />
                    : <StudioClassCard key={item.data.id} sc={item.data} isPast={isPast} />;
                })}
              </div>
            </section>
          ));
        })()
      )}
    </div>
  );
}

// Loading state for one week section: a heading placeholder above `cards`
// `ClassCardSkeleton`s, in the same frame the real list's section uses.
export function ClassListSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div aria-hidden="true">
      <section>
        <SkeletonText type="type-subtitle" width="w-1/4" className={WEEK_HEADING_GAP} />
        <div className={WEEK_ITEMS}>
          {Array.from({ length: cards }, (_, i) => <ClassCardSkeleton key={i} />)}
        </div>
      </section>
    </div>
  );
}
