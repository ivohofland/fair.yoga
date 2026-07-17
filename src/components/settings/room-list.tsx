import Link from 'next/link';
import type { TeacherRoom, Room } from '@prisma/client';
import { Icon } from '@/components/ui/icon';
import { EmptyState } from '@/components/ui/empty-state';
import { formatRoomLocation } from '@/lib/format';

type TeacherRoomWithRoom = TeacherRoom & { room: Room };

interface RoomListProps {
  teacherRooms: TeacherRoomWithRoom[];
  emptyMessage?: string;
}

export function RoomList({ teacherRooms, emptyMessage = 'No rooms yet. Add your first room.' }: RoomListProps) {
  if (teacherRooms.length === 0) {
    return <EmptyState title={emptyMessage} />;
  }

  return (
    <div>
      {teacherRooms.map((tr) => (
        <Link
          key={tr.id}
          href={`/settings/rooms/${tr.id}`}
          className="flex items-center gap-3 min-h-14 py-2 border-b border-border last:border-b-0 no-underline"
        >
          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span className="text-base text-ink">
              {formatRoomLocation(tr.room.roomName, tr.room.venueName)}
            </span>
            <span className="type-caption">
              {tr.room.city} {tr.room.postcode}
            </span>
          </div>
          <div className="flex flex-col items-end gap-0.5 shrink-0">
            <span className="type-caption tabular-nums">
              {tr.capacityOverride} students
            </span>
            <span className="type-number text-[13px]">
              &euro;{Number(tr.rentalRate).toFixed(2)}
            </span>
          </div>
          <Icon name="chevron-right" size={20} className="text-brown-light" />
        </Link>
      ))}
    </div>
  );
}
