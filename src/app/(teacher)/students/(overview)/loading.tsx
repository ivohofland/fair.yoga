import { PageHeaderSkeleton } from '@/components/layout/page-header';
import { SendAnnouncementSkeleton } from '@/components/class/send-announcement-skeleton';
import { StudentDirectorySkeleton } from '@/components/students/student-directory-skeleton';

export default function StudentsLoading() {
  return (
    <div aria-busy="true">
      <PageHeaderSkeleton backHref={null} variant="display" action />
      <div className="mb-5" data-layout-anchor="first-item">
        <SendAnnouncementSkeleton />
      </div>
      <StudentDirectorySkeleton />
    </div>
  );
}
