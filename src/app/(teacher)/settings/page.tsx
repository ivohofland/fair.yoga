import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { Icon } from '@/components/ui/icon';

const SETTINGS_ITEMS = [
  { href: '/settings/payments', label: 'Payments' },
  { href: '/settings/recurring', label: 'Recurring classes' },
  { href: '/settings/studio-classes', label: 'Studio classes' },
  { href: '/settings/rooms', label: 'Rooms' },
  { href: '/settings/profile', label: 'Profile' },
];

// The Settings tab index: set-up-once infrastructure, one row per area.
export default function SettingsPage() {
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
      </div>
    </div>
  );
}
