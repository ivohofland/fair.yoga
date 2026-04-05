import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { RoomList } from '@/components/settings/room-list';

export default async function RoomsPage() {
  const session = await requireTeacherSession();

  const teacherRooms = await prisma.teacherRoom.findMany({
    where: { teacherId: session.userId },
    include: { room: true },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <>
      <PageHeader
        title="Rooms"
        action={<Link href="/settings/rooms/new" className="text-teal text-sm">+ Add room</Link>}
      />
      <RoomList teacherRooms={teacherRooms} />
    </>
  );
}
