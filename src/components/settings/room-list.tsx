import Link from 'next/link';
import type { TeacherRoom, Room } from '@prisma/client';

type TeacherRoomWithRoom = TeacherRoom & { room: Room };

interface RoomListProps {
  teacherRooms: TeacherRoomWithRoom[];
}

export function RoomList({ teacherRooms }: RoomListProps) {
  if (teacherRooms.length === 0) {
    return <p className="text-brown text-sm">No rooms yet. Add your first room.</p>;
  }

  return (
    <div>
      {teacherRooms.map((tr) => (
        <Link
          key={tr.id}
          href={`/settings/rooms/${tr.id}`}
          className="flex items-start justify-between py-3 border-b border-border"
        >
          <div className="flex flex-col gap-1">
            <span className="text-dark text-sm font-medium">
              {tr.room.roomName ? `${tr.room.roomName} at ${tr.room.venueName}` : tr.room.venueName}
            </span>
            <span className="text-brown text-xs">
              {tr.room.city} {tr.room.postcode}
            </span>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="text-brown text-sm">
              {tr.capacityOverride} students
            </span>
            <span className="text-brown text-xs">
              &euro;{Number(tr.rentalRate).toFixed(2)}
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
