import { PageHeaderSkeleton } from '@/components/layout/page-header';

// The neutral fallback: a quiet header and nothing below, so a route without
// a skeleton of its own shows something vague rather than another page's
// shape. A segment's loading.tsx re-exports it to cover the pages below that
// segment. Which pages show it is recorded in src/lib/loading-coverage.test.ts.
export function RouteLoading() {
  return (
    <div aria-busy="true">
      <PageHeaderSkeleton />
    </div>
  );
}
