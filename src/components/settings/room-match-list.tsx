import { formatRoomLocation } from '@/lib/format';
import type { RoomResult } from '@/lib/room-search';

interface RoomMatchListProps {
  rooms: readonly RoomResult[];
  /** Given: rows are selectable buttons. Omitted: rows are read-only. */
  onSelect?: (room: RoomResult) => void;
}

/**
 * Rooms already shared at an address. Selectable when adding a room (pick one
 * instead of creating), read-only when sharing one (the share panel's switch
 * acts on the exact match, not on a row).
 */
export function RoomMatchList({ rooms, onSelect }: RoomMatchListProps) {
  return (
    <div className="mb-4">
      {rooms.map((room) => {
        const body = (
          <>
            <span className="text-base text-ink">
              {formatRoomLocation(room.roomName, room.venueName)}
            </span>
            <span className="type-caption">{room.address}, {room.city}</span>
          </>
        );

        const className = 'w-full text-left flex flex-col gap-1 py-3 border-b border-border';

        return onSelect ? (
          <button key={room.id} type="button" onClick={() => onSelect(room)} className={className}>
            {body}
          </button>
        ) : (
          <div key={room.id} className={className}>{body}</div>
        );
      })}
    </div>
  );
}
