import Link from 'next/link';
import type { StudioClassTemplate } from '@prisma/client';

interface StudioTemplateListProps {
  templates: StudioClassTemplate[];
  emptyMessage?: string;
}

const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function StudioTemplateList({ templates, emptyMessage = 'No studio classes yet.' }: StudioTemplateListProps) {
  if (templates.length === 0) {
    return <p className="text-brown text-sm">{emptyMessage}</p>;
  }

  const active = templates.filter((t) => t.isActive && !t.isArchived);
  const paused = templates.filter((t) => !t.isActive && !t.isArchived);
  const archived = templates.filter((t) => t.isArchived);

  return (
    <div>
      {active.map((t) => (
        <Link
          key={t.id}
          href={`/settings/studio-classes/${t.id}`}
          className="flex items-start justify-between py-3 border-b border-border"
        >
          <div className="flex flex-col gap-1">
            <span className="text-dark text-sm font-medium">{t.classType || t.location}</span>
            <span className="text-brown text-xs">
              {DAY_LABELS[t.dayOfWeek]} {t.startTime} &middot; {t.durationMinutes} min
            </span>
            <span className="text-brown text-xs">
              {t.location} &middot; &euro;{Number(t.hourlyRate).toFixed(2)}/hr
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
              href={`/settings/studio-classes/${t.id}`}
              className="flex items-start justify-between py-3 border-b border-border opacity-60"
            >
              <div className="flex flex-col gap-1">
                <span className="text-dark text-sm font-medium">{t.location}</span>
                <span className="text-brown text-xs">
                  {DAY_LABELS[t.dayOfWeek]} {t.startTime} &middot; {t.durationMinutes} min
                </span>
                <span className="text-brown text-xs">
                  &euro;{Number(t.hourlyRate).toFixed(2)}/hr
                </span>
              </div>
              <span className="text-brown text-xs pt-1">paused</span>
            </Link>
          ))}
        </>
      )}

      {archived.length > 0 && (
        <>
          {(active.length > 0 || paused.length > 0) && <div className="py-3" />}
          {archived.map((t) => (
            <Link
              key={t.id}
              href={`/settings/studio-classes/${t.id}`}
              className="flex items-start justify-between py-3 border-b border-border opacity-40"
            >
              <div className="flex flex-col gap-1">
                <span className="text-dark text-sm font-medium">{t.location}</span>
                <span className="text-brown text-xs">
                  {DAY_LABELS[t.dayOfWeek]} {t.startTime} &middot; {t.durationMinutes} min
                </span>
                <span className="text-brown text-xs">
                  &euro;{Number(t.hourlyRate).toFixed(2)}/hr
                </span>
              </div>
              <span className="text-brown text-xs pt-1">archived</span>
            </Link>
          ))}
        </>
      )}
    </div>
  );
}
