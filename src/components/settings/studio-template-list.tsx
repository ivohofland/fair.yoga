import Link from 'next/link';
import { EmptyState } from '@/components/ui/empty-state';
import type { StudioClassTemplate } from '@prisma/client';

interface StudioTemplateListProps {
  templates: StudioClassTemplate[];
  emptyMessage?: string;
}

const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function StudioTemplateList({ templates, emptyMessage = 'No studio classes yet.' }: StudioTemplateListProps) {
  if (templates.length === 0) {
    return <EmptyState title={emptyMessage} />;
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
          className="flex items-start justify-between gap-3 min-h-14 py-2 border-b border-border no-underline"
        >
          <div className="flex flex-col gap-1">
            <span className="text-base text-ink">{t.classType || t.location}</span>
            <span className="type-caption">
              {DAY_LABELS[t.dayOfWeek]} {t.startTime} &middot; {t.durationMinutes} min
            </span>
            <span className="type-caption">
              {t.location} &middot; &euro;{Number(t.hourlyRate).toFixed(2)}/hr
            </span>
          </div>
          <span className="text-[13px] text-teal pt-1">active</span>
        </Link>
      ))}

      {paused.length > 0 && (
        <>
          {active.length > 0 && <div className="py-3" />}
          {paused.map((t) => (
            <Link
              key={t.id}
              href={`/settings/studio-classes/${t.id}`}
              className="flex items-start justify-between gap-3 min-h-14 py-2 border-b border-border no-underline opacity-60"
            >
              <div className="flex flex-col gap-1">
                <span className="text-base text-ink">{t.location}</span>
                <span className="type-caption">
                  {DAY_LABELS[t.dayOfWeek]} {t.startTime} &middot; {t.durationMinutes} min
                </span>
                <span className="type-caption">
                  &euro;{Number(t.hourlyRate).toFixed(2)}/hr
                </span>
              </div>
              <span className="type-caption pt-1">paused</span>
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
              className="flex items-start justify-between gap-3 min-h-14 py-2 border-b border-border no-underline opacity-40"
            >
              <div className="flex flex-col gap-1">
                <span className="text-base text-ink">{t.location}</span>
                <span className="type-caption">
                  {DAY_LABELS[t.dayOfWeek]} {t.startTime} &middot; {t.durationMinutes} min
                </span>
                <span className="type-caption">
                  &euro;{Number(t.hourlyRate).toFixed(2)}/hr
                </span>
              </div>
              <span className="type-caption pt-1">archived</span>
            </Link>
          ))}
        </>
      )}
    </div>
  );
}
