import { PageHeaderSkeleton } from '@/components/layout/page-header';
import { ClassInfoSkeleton } from '@/components/class/class-info';

export default function ClassLoading() {
  return (
    <div aria-busy="true">
      <PageHeaderSkeleton backHref="/" />
      <ClassInfoSkeleton />
    </div>
  );
}
