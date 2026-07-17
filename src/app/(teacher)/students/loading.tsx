import { Skeleton } from '@/components/ui/skeleton';

// Students-shaped skeleton: heading, search field, six rows.
export default function StudentsLoading() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-8 w-36 mb-6" />
      <Skeleton className="h-12 rounded-field mb-4" />
      <div>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="min-h-14 py-2 border-b border-border last:border-b-0 flex flex-col justify-center gap-1.5">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        ))}
      </div>
    </div>
  );
}
