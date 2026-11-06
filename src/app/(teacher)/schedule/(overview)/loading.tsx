import { ScheduleHeaderSkeleton } from '@/components/schedule/schedule-header';
import { ClassListSkeleton } from '@/components/schedule/class-list-skeleton';

export default function ScheduleLoading() {
  return (
    <div aria-busy="true">
      <ScheduleHeaderSkeleton />
      <div data-layout-anchor="first-item">
        <ClassListSkeleton />
      </div>
    </div>
  );
}
