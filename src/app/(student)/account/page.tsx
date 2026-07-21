import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { Icon } from '@/components/ui/icon';
import { AddPasskey } from '@/components/account/add-passkey';
import { SignOutButton } from '@/components/account/sign-out-button';

export const dynamic = 'force-dynamic';

const SETTINGS_ITEMS = [
  { href: '/account/tier', label: 'Your tier' },
  { href: '/account/notifications', label: 'Notifications' },
  { href: '/account/privacy', label: 'Privacy' },
  { href: '/account/data', label: 'Data & deletion' },
];

// The student settings index: one row per area, teacher-settings pattern.
export default async function StudentSettingsPage() {
  const session = await getSession();
  if (!session?.studentId) redirect(session?.teacherId ? '/' : '/login');

  return (
    <div>
      <Link
        href="/bookings"
        className="inline-flex items-center gap-1.5 type-label text-teal no-underline mb-2"
      >
        <Icon name="arrow-left" size={18} />
        Your bookings
      </Link>
      <h1 className="type-display mb-6">Settings</h1>

      <div>
        {SETTINGS_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex items-center gap-3 min-h-14 py-2 border-b border-border last:border-b-0 no-underline"
          >
            <span className="flex-1 text-base text-ink">{item.label}</span>
            <Icon name="chevron-right" size={20} className="text-brown-light" />
          </Link>
        ))}
      </div>

      {session.teacherId && (
        <section className="mt-10 pt-6 border-t border-border">
          <Link
            href="/"
            className="flex items-center gap-3 min-h-14 py-2 no-underline"
          >
            <span className="flex-1 text-base text-ink">Your teaching side</span>
            <Icon name="chevron-right" size={20} className="text-brown-light" />
          </Link>
        </section>
      )}

      <section className="mt-10 pt-6 border-t border-border">
        <h2 className="type-subtitle mb-3">Sign-in</h2>
        <AddPasskey />
        <div className="mt-5">
          <SignOutButton />
        </div>
      </section>
    </div>
  );
}
