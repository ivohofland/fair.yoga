import { InputSkeleton } from '@/components/ui/input';
import { ListRowSkeleton } from '@/components/ui/list-row';

// The directory's search-field wrapper and its skeleton row count, exported
// so the directory and this skeleton draw them from one place (the
// sibling-module pattern: docs/design-brief.md, Loading states).
export const SEARCH_WRAP = 'mb-4';
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
