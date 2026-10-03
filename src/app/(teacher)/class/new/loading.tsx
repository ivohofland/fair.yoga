import { PageHeaderSkeleton } from '@/components/layout/page-header';

export default function NewClassLoading() {
  return (
    <div aria-busy="true">
      <PageHeaderSkeleton backHref="/schedule" variant="display" />
    </div>
  );
}
