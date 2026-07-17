import { Skeleton } from '@/components/ui/skeleton';

// Schedule-shaped skeleton: heading + three card blocks. Static sand,
// no shimmer — also the fallback for teacher segments without their own.
export default function TeacherLoading() {
  return (
    <div aria-busy="true">
      <div className="mb-6">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-28 mt-2" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-32 rounded-card" />
        <Skeleton className="h-32 rounded-card" />
        <Skeleton className="h-32 rounded-card" />
      </div>
    </div>
  );
}
