import { Skeleton } from '@/components/ui/skeleton';
import { ListRowSkeleton } from '@/components/ui/list-row';

// Inbox-shaped skeleton: heading + six notification rows.
export default function InboxLoading() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-8 w-28 mb-6" />
      <div>
        {Array.from({ length: 6 }, (_, i) => (
          <ListRowSkeleton key={i} density="relaxed" />
        ))}
      </div>
    </div>
  );
}
