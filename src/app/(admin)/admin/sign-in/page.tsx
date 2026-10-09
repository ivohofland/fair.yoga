import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { isAdminHost, adminReturnPath } from '@/lib/admin-host';
import { PasskeySignIn } from '@/components/booking/passkey-sign-in';

export const metadata: Metadata = { title: 'Admin sign-in · fair.yoga', robots: { index: false, follow: false } };

export default async function AdminSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  if (!isAdminHost((await headers()).get('host'))) notFound();
  const { redirect } = await searchParams;
  return (
    <main className="flex flex-col gap-4 py-8">
      <h1 className="type-title">Admin</h1>
      <p className="type-body">Sign in with your passkey. The admin pages ask again five minutes after each sign-in.</p>
      <PasskeySignIn redirect={adminReturnPath(redirect)} emailFallback={false} />
    </main>
  );
}
