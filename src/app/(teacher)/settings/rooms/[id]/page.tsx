import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { formatRoomLocation } from '@/lib/format';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { EditTeacherRoomForm } from '@/components/settings/edit-teacher-room-form';
import { ArchiveRoomButton } from '@/components/settings/archive-room-button';
import { UnlinkRoomButton } from '@/components/settings/unlink-room-button';

export default async function EditRoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireTeacherSession();
  const { id } = await params;

  const teacherRoom = await prisma.teacherRoom.findUnique({
    where: { id },
    include: { room: true },
  });

  if (!teacherRoom || teacherRoom.teacherId !== session.userId) {
    redirect('/settings/rooms');
  }

  const { room } = teacherRoom;
  const classCount = await prisma.class.count({ where: { teacherRoomId: teacherRoom.id } });
  const isArchived = teacherRoom.isArchived;
  const equipmentLabels: Record<string, string> = {
    mats: 'Mats',
    blocks: 'Blocks',
    straps: 'Straps',
    bolsters: 'Bolsters',
    blankets: 'Blankets',
    cushions: 'Meditation cushions',
  };
  const equipment = Array.isArray(room.equipment)
    ? (room.equipment as string[]).map((k) => equipmentLabels[k] ?? k)
    : [];

  return (
    <>
      <PageHeader title={room.roomName || room.venueName} backHref={isArchived ? '/settings/rooms/archived' : '/settings/rooms'} />

      {/* Room base info (read-only) */}
      <section className="mb-8">
        <h2 className="font-heading text-lg font-bold text-teal mb-3">Room details</h2>
        <div className="flex flex-col gap-2">
          <div>
            <span className="text-sm text-brown">Venue</span>
            <p className="text-dark">{room.venueName}</p>
          </div>
          <div>
            <span className="text-sm text-brown">Address</span>
            <p className="text-dark">{room.address}, {room.city} {room.postcode}</p>
          </div>
          <div>
            <span className="text-sm text-brown">Floor</span>
            <p className="text-dark">{room.floor}</p>
          </div>
          <div>
            <span className="text-sm text-brown">Max capacity</span>
            <p className="text-dark">{room.maxCapacity}</p>
          </div>
          {equipment.length > 0 && (
            <div>
              <span className="text-sm text-brown">Available props</span>
              <p className="text-dark">{equipment.join(', ')}</p>
            </div>
          )}
          {room.notes && (
            <div>
              <span className="text-sm text-brown">Notes</span>
              <p className="text-dark">{room.notes}</p>
            </div>
          )}
        </div>
      </section>

      {/* Teacher-specific settings (editable) */}
      <section className="mb-8">
        <h2 className="font-heading text-lg font-bold text-teal mb-3">Your settings</h2>
        <EditTeacherRoomForm
          teacherRoomId={teacherRoom.id}
          maxCapacity={room.maxCapacity}
          initial={{
            capacityOverride: teacherRoom.capacityOverride,
            rentalRate: Number(teacherRoom.rentalRate),
            equipmentNotes: teacherRoom.equipmentNotes ?? '',
          }}
        />
      </section>

      {/* Archive / Remove */}
      <section className="pt-6 border-t border-border flex flex-col gap-4">
        <ArchiveRoomButton teacherRoomId={teacherRoom.id} isArchived={isArchived} />
        {classCount === 0 && (
          <UnlinkRoomButton
            teacherRoomId={teacherRoom.id}
            roomName={formatRoomLocation(room.roomName, room.venueName)}
          />
        )}
      </section>
    </>
  );
}
