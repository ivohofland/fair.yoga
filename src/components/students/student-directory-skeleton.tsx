import { InputSkeleton } from '@/components/ui/input';
import { ListRowSkeleton } from '@/components/ui/list-row';

// The search field's wrapper, shared by `StudentDirectory` and its skeleton.
export const SEARCH_WRAP = 'mb-4';

// Row count for both `StudentDirectory`'s own initial-load state and
// `StudentDirectorySkeleton`'s default, so the two agree without either
// retyping the other's number.
export const SKELETON_ROWS = 6;

// The search field, then directory rows: a name line and an email line each.
export function StudentDirectorySkeleton({ rows = SKELETON_ROWS }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      <div className={SEARCH_WRAP}>
        <InputSkeleton />
      </div>
      <div>
        {Array.from({ length: rows }, (_, i) => (
          <ListRowSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
