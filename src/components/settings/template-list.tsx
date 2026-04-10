import Link from 'next/link';
import type { ClassTemplate, TeacherRoom, Room } from '@prisma/client';
import { formatRoomLocation } from '@/lib/format';

type TemplateWithRoom = ClassTemplate & {
  teacherRoom: TeacherRoom & { room: Room };
};

interface TemplateListProps {
  templates: TemplateWithRoom[];
}

const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function TemplateList({ templates }: TemplateListProps) {
  if (templates.length === 0) {
    return <p className="text-brown text-sm">No recurring classes yet.</p>;
  }

  const active = templates.filter((t) => t.isActive);
  const paused = templates.filter((t) => !t.isActive);

  return (
    <div>
      {active.map((t) => (
        <Link
          key={t.id}
          href={`/settings/recurring/${t.id}`}
          className="flex items-start justify-between py-3 border-b border-border"
        >
          <div className="flex flex-col gap-1">
            <span className="text-dark text-sm font-medium">{t.classType}</span>
            <span className="text-brown text-xs">
              {DAY_LABELS[t.dayOfWeek]} {t.startTime} &middot; {t.durationMinutes} min
            </span>
            <span className="text-brown text-xs">
              {formatRoomLocation(t.teacherRoom.room.roomName, t.teacherRoom.room.venueName)}
            </span>
          </div>
          <span className="text-teal text-xs pt-1">active</span>
        </Link>
      ))}

      {paused.length > 0 && (
        <>
          {active.length > 0 && <div className="py-3" />}
          {paused.map((t) => (
            <Link
              key={t.id}
              href={`/settings/recurring/${t.id}`}
              className="flex items-start justify-between py-3 border-b border-border opacity-60"
            >
              <div className="flex flex-col gap-1">
                <span className="text-dark text-sm font-medium">{t.classType}</span>
                <span className="text-brown text-xs">
                  {DAY_LABELS[t.dayOfWeek]} {t.startTime} &middot; {t.durationMinutes} min
                </span>
                <span className="text-brown text-xs">
                  {formatRoomLocation(t.teacherRoom.room.roomName, t.teacherRoom.room.venueName)}
                </span>
              </div>
              <span className="text-brown text-xs pt-1">paused</span>
            </Link>
          ))}
        </>
      )}
    </div>
  );
}
