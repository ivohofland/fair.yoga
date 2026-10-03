import { PageHeaderSkeleton } from '@/components/layout/page-header';

// The fallback for every teacher route without a loading.tsx of its own: a
// quiet header and nothing below, so a route without a skeleton of its own
// shows something vague rather than another page's shape. Which routes rely
// on it is recorded in src/lib/loading-coverage.test.ts.
export default function TeacherLoading() {
  return (
    <div aria-busy="true">
      <PageHeaderSkeleton />
    </div>
  );
}
