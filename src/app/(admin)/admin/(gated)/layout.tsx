import { prisma } from '@/lib/db';
import { requireAdminSession } from '@/lib/admin-session';
import { SignOutButton } from '@/components/account/sign-out-button';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const proof = await requireAdminSession();
  const account = await prisma.account.findUniqueOrThrow({ where: { id: proof.accountId }, select: { email: true } });
  return (
    <main className="mx-auto flex max-w-[640px] flex-col gap-6 px-4 py-8">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="type-title">Platform</h1>
          <p className="type-caption">{account.email}</p>
        </div>
        <SignOutButton accountId={null} redirectTo="/admin/sign-in" />
      </header>
      {children}
    </main>
  );
}
