import { Skeleton } from '@/components/ui/skeleton';

// Inbox-shaped skeleton: heading + six notification rows.
export default function InboxLoading() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-8 w-28 mb-6" />
      <div>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="min-h-14 py-3 border-b border-border last:border-b-0 flex flex-col justify-center gap-1.5">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        ))}
      </div>
    </div>
  );
}
