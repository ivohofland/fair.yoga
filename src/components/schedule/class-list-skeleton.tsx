import { ClassCardSkeleton } from '@/components/schedule/class-card';
import { SkeletonText } from '@/components/ui/skeleton';

// The week section's heading gap and item stack, shared by `ClassList` and
// `ClassListSkeleton` so neither can drift from the other's spacing. Kept out
// of `class-list.tsx` so a loading.tsx reaches no 'use client' module.
export const WEEK_HEADING_GAP = 'mb-3';
export const WEEK_ITEMS = 'flex flex-col gap-3';

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
