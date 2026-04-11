import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { StudentCountEditor } from '@/components/studio-class/student-count-editor';
import { CancelStudioClassButton } from '@/components/studio-class/cancel-studio-class-button';

function formatDate(date: Date): string {
  const d = new Date(date);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export default async function StudioClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireTeacherSession();
  const { id } = await params;

  const studioClass = await prisma.studioClass.findUnique({
    where: { id },
    include: { template: true },
  });

  if (!studioClass || studioClass.teacherId !== session.userId) {
    redirect('/schedule');
  }

  return (
    <>
      <PageHeader title={studioClass.location} backHref="/schedule" backLabel="Schedule" />

      <div className="mb-6">
        <div className="py-3 border-b border-border">
          <span className="text-sm text-brown">Date</span>
          <p className="text-dark">{formatDate(studioClass.date)}</p>
        </div>

        <div className="py-3 border-b border-border">
          <span className="text-sm text-brown">Time</span>
          <p className="text-dark">{studioClass.startTime} &middot; {studioClass.durationMinutes} min</p>
        </div>

        <div className="py-3 border-b border-border">
          <span className="text-sm text-brown">Hourly rate</span>
          <p className="text-dark">&euro;{Number(studioClass.hourlyRate).toFixed(2)}</p>
        </div>

        {studioClass.template && (
          <div className="py-3 border-b border-border">
            <span className="text-sm text-brown">Template</span>
            <p>
              <Link href={`/settings/studio-classes/${studioClass.template.id}`} className="text-teal text-sm">
                {studioClass.template.location} &rarr;
              </Link>
            </p>
          </div>
        )}
      </div>

      {studioClass.cancelledAt ? (
        <div className="py-8 text-center text-brown">
          This class was cancelled.
        </div>
      ) : (
        <>
          <section>
            <StudentCountEditor
              studioClassId={studioClass.id}
              initialCount={studioClass.studentCount}
            />
          </section>

          <section className="mt-8 pt-6 border-t border-border">
            <CancelStudioClassButton studioClassId={studioClass.id} />
          </section>
        </>
      )}
    </>
  );
}
