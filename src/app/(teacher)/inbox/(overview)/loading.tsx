import { PageHeaderSkeleton } from '@/components/layout/page-header';
import { NotificationListSkeleton } from '@/components/layout/notification-list-skeleton';

export default function InboxLoading() {
  return (
    <div aria-busy="true">
      <PageHeaderSkeleton backHref={null} variant="display" />
      <div data-layout-anchor="first-item">
        <NotificationListSkeleton />
      </div>
    </div>
  );
}
