import { PageHeaderSkeleton } from '@/components/layout/page-header';

// The neutral fallback: a quiet header and nothing below, so a route without
// a skeleton of its own shows something vague rather than another page's
// shape. A loading.tsx that re-exports it covers its segment and the segments
// below; where those files sit is docs/design-brief.md (Loading states), and
// which pages show it is recorded in src/lib/loading-coverage.test.ts.
export function RouteLoading() {
  return (
    <div aria-busy="true">
      <PageHeaderSkeleton />
    </div>
  );
}
