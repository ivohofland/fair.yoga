import { Skeleton } from '@/components/ui/skeleton';
import { ListRowSkeleton } from '@/components/ui/list-row';

// Students-shaped skeleton: heading, search field, six rows.
export default function StudentsLoading() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-8 w-36 mb-6" />
      <Skeleton className="h-12 rounded-field mb-4" />
      <div>
        {Array.from({ length: 6 }, (_, i) => (
          <ListRowSkeleton key={i} density="regular" />
        ))}
      </div>
    </div>
  );
}
