import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import { SkeletonText } from '@/components/ui/skeleton';
import type { MollieReturn } from '@/lib/mollie-return';
import type { MollieDeps } from '@/services/mollie-deps';
import { readConnectionView, type ConnectionView } from '@/services/processor-connection';
import { MollieConnectionSection } from './mollie-connection-section';

/**
 * The Mollie section with its connection read from Mollie. Rendered inside a
 * `<Suspense>` so the rest of the profile page does not wait on Mollie. A
 * failure reading it shows the section's unavailable view rather than
 * replacing the page.
 */
export async function MollieConnectionPanel({
  teacherId, deps, status,
}: { teacherId: string; deps: MollieDeps; status: MollieReturn | null }) {
  let view: ConnectionView;
  try {
    view = await readConnectionView(prisma, deps, teacherId);
  } catch (err) {
    log.error({ err, teacherId }, 'Mollie connection view failed; showing it as unavailable');
    view = { kind: 'unavailable' };
  }
  return <MollieConnectionSection teacherId={teacherId} view={view} status={status} />;
}

/** The section's place while Mollie answers: its heading and one quiet line. */
export function MollieConnectionFallback() {
  return (
    <section className="mt-10 pt-6 border-t border-border flex flex-col gap-4">
      <h2 className="type-subtitle">Mollie</h2>
      <SkeletonText type="type-body" width="w-3/5" />
    </section>
  );
}
