import Link from 'next/link';
import { EmptyState } from '@/components/ui/empty-state';
import type { StudioClassTemplate } from '@prisma/client';

interface StudioTemplateListProps {
  templates: StudioClassTemplate[];
  emptyMessage?: string;
}

const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const ROW_BASE =
  'flex items-start justify-between gap-3 min-h-14 py-2 border-b border-border no-underline';

interface StudioTemplateRowProps {
  template: StudioClassTemplate;
  /**
   * The whole `<Link>` class string, passed per section rather than composed
   * from a modifier: the active row carries no opacity class at all, and
   * composing would leave it a trailing space.
   */
  linkClass: string;
  status: string;
  /**
   * Active is `text-[13px] text-teal`, paused and archived are
   * `type-caption`. These are not a colour variant of one another —
   * `type-caption` also sets font family, weight and line-height, so folding
   * active into it would change the rendered glyphs.
   */
  statusClass: string;
}

/**
 * One directory row.
 *
 * #281: the sections used to spell the title and the caption separately and
 * drifted, so pausing a template renamed it on the page pausing returns you
 * to. Sharing one row is what makes them agree by construction rather than by
 * three people remembering; `studio-template-list.test.tsx` renders every
 * state through it and asserts they still do.
 */
function StudioTemplateRow({ template, linkClass, status, statusClass }: StudioTemplateRowProps) {
  return (
    <Link href={`/settings/studio-classes/${template.id}`} className={linkClass}>
      <div className="flex flex-col gap-1">
        <span className="text-base text-ink">{template.classType || template.location}</span>
        <span className="type-caption">
          {DAY_LABELS[template.dayOfWeek]} {template.startTime} &middot; {template.durationMinutes} min
        </span>
        <span className="type-caption">
          {template.location} &middot; &euro;{Number(template.hourlyRate).toFixed(2)}/hr
        </span>
      </div>
      <span className={`${statusClass} pt-1`}>{status}</span>
    </Link>
  );
}

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
        <StudioTemplateRow
          key={t.id}
          template={t}
          linkClass={ROW_BASE}
          status="active"
          statusClass="text-[13px] text-teal"
        />
      ))}

      {paused.length > 0 && (
        <>
          {active.length > 0 && <div className="py-3" />}
          {paused.map((t) => (
            <StudioTemplateRow
              key={t.id}
              template={t}
              linkClass={`${ROW_BASE} opacity-60`}
              status="paused"
              statusClass="type-caption"
            />
          ))}
        </>
      )}

      {archived.length > 0 && (
        <>
          {(active.length > 0 || paused.length > 0) && <div className="py-3" />}
          {archived.map((t) => (
            <StudioTemplateRow
              key={t.id}
              template={t}
              linkClass={`${ROW_BASE} opacity-40`}
              status="archived"
              statusClass="type-caption"
            />
          ))}
        </>
      )}
    </div>
  );
}
