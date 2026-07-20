import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { Icon } from '@/components/ui/icon';
import { SignOutButton } from '@/components/account/sign-out-button';
import { getSession } from '@/lib/session';

const SETTINGS_ITEMS = [
  { href: '/settings/payments', label: 'Payments' },
  { href: '/settings/reporting', label: 'Reporting' },
  { href: '/settings/recurring', label: 'Recurring classes' },
  { href: '/settings/studio-classes', label: 'Studio classes' },
  { href: '/settings/rooms', label: 'Rooms' },
  { href: '/settings/profile', label: 'Profile' },
];

// The Settings tab index: set-up-once infrastructure, one row per area.
export default async function SettingsPage() {
  const session = await getSession();
  return (
    <div>
      <PageHeader title="Settings" backHref={null} variant="display" />
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
        {session?.studentId && (
          <Link
            href="/bookings"
            className="flex items-center gap-3 min-h-14 py-2 border-b border-border last:border-b-0 no-underline"
          >
            <span className="flex-1 text-base text-ink">Your bookings as a student</span>
            <Icon name="chevron-right" size={20} className="text-brown-light" />
          </Link>
        )}
      </div>
      <div className="mt-8">
        <SignOutButton />
      </div>
    </div>
  );
}
