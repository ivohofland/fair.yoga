import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { RoomList } from '@/components/settings/room-list';

export default async function RoomsPage() {
  const session = await requireTeacherSession();

  const teacherRooms = await prisma.teacherRoom.findMany({
    where: { teacherId: session.userId, isArchived: false },
    include: { room: true },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <>
      <PageHeader backHref="/settings" backLabel="Settings"
        title="Rooms"
        action={<Link href="/settings/rooms/new" className="type-label text-teal no-underline">+ Add room</Link>}
      />
      <RoomList teacherRooms={teacherRooms} />
      <div className="mt-6">
        <Link href="/settings/rooms/archived" className="type-caption no-underline">
          View archived rooms
        </Link>
      </div>
    </>
  );
}
