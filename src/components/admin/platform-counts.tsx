import type { PlatformCounts } from '@/services/admin-metrics';

function CountCard({ title, total, split }: { title: string; total: number; split?: string }) {
  const id = `count-${title.toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="rounded-card border border-border bg-sand-soft p-5">
      <h2 id={id} className="type-label">{title}</h2>
      <p className="type-number">{total}</p>
      {split !== undefined && <p className="type-caption">{split}</p>}
    </section>
  );
}

export function PlatformCountsView({ counts }: { counts: PlatformCounts }) {
  const { teachers, students, rooms } = counts;
  return (
    <div className="flex flex-col gap-3">
      <CountCard title="Teachers" total={teachers} />
      <CountCard
        title="Students"
        total={students.withAccount + students.walkInOnly}
        split={`with an account ${students.withAccount} · walk-in only ${students.walkInOnly}`}
      />
      <CountCard
        title="Rooms"
        total={rooms.public + rooms.private}
        split={`public ${rooms.public} · private ${rooms.private}`}
      />
    </div>
  );
}
