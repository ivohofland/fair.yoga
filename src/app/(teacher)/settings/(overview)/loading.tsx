import { PageHeaderSkeleton } from '@/components/layout/page-header';
import { ListRowSkeleton } from '@/components/ui/list-row';

export default function SettingsLoading() {
  return (
    <div aria-busy="true">
      <PageHeaderSkeleton backHref={null} variant="display" />
      <div data-layout-anchor="first-item">
        {Array.from({ length: 6 }, (_, i) => (
          <ListRowSkeleton key={i} lines={1} />
        ))}
      </div>
    </div>
  );
}
