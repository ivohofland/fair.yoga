import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { ShareSchedule } from '@/components/settings/share-schedule';
import { getScheduleShare } from '@/services/schedule-share';

export const dynamic = 'force-dynamic';

export default async function ShareSchedulePage() {
  const session = await requireTeacherSession();
  const [initial, teacher] = await Promise.all([
    getScheduleShare(prisma, session.teacherId),
    prisma.teacher.findUniqueOrThrow({ where: { id: session.teacherId }, select: { pageSlug: true } }),
  ]);
  const origin = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  return (
    <>
      <PageHeader title="Share your schedule" backHref="/settings" backLabel="Settings" />
      <ShareSchedule origin={origin} slug={teacher.pageSlug} initial={initial} />
    </>
  );
}
