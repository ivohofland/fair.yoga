import Link from 'next/link';
import type { TeacherRoom, Room } from '@prisma/client';
import { formatRoomLocation } from '@/lib/format';

type TeacherRoomWithRoom = TeacherRoom & { room: Room };

interface RoomListProps {
  teacherRooms: TeacherRoomWithRoom[];
  emptyMessage?: string;
}

export function RoomList({ teacherRooms, emptyMessage = 'No rooms yet. Add your first room.' }: RoomListProps) {
  if (teacherRooms.length === 0) {
    return <p className="text-brown text-sm">{emptyMessage}</p>;
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
              {formatRoomLocation(tr.room.roomName, tr.room.venueName)}
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
