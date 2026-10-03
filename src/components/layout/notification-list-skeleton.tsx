import { ListRowSkeleton, type ListRowFrameOptions } from '@/components/ui/list-row';

// The list and its rows' frame, shared by `NotificationList` and its
// skeleton. The inset is the row's horizontal geometry; the rest of the row's
// layout is its content's, which the skeleton's lines do not have.
export const LIST_ROOT = 'flex flex-col';
export const ROW_FRAME: ListRowFrameOptions = { density: 'relaxed', divider: 'after-each' };
export const ROW_INSET = 'px-3 -mx-3';

export function NotificationListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className={LIST_ROOT}>
      {Array.from({ length: rows }, (_, i) => (
        <ListRowSkeleton key={i} {...ROW_FRAME} className={ROW_INSET} />
      ))}
    </div>
  );
}
