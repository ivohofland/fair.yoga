import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { RoomList } from '@/components/settings/room-list';

export default async function ArchivedRoomsPage() {
  const session = await requireTeacherSession();

  const teacherRooms = await prisma.teacherRoom.findMany({
    where: { teacherId: session.userId, isArchived: true },
    include: { room: true },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <>
      <PageHeader title="Archived rooms" backHref="/settings/rooms" backLabel="Rooms" />
      <RoomList teacherRooms={teacherRooms} emptyMessage="No archived rooms." />
    </>
  );
}
