import { prisma } from '@/lib/db';
import { requireAdminSession } from '@/lib/admin-session';
import { getPlatformCounts } from '@/services/admin-metrics';
import { PlatformCountsView } from '@/components/admin/platform-counts';

export const dynamic = 'force-dynamic';

export default async function AdminDashboardPage() {
  const proof = await requireAdminSession();
  return <PlatformCountsView counts={await getPlatformCounts(proof, prisma)} />;
}
