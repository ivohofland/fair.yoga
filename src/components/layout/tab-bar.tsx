'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from '@/components/ui/icon';

const TABS: { href: string; label: string; icon: IconName }[] = [
  { href: '/', label: 'Schedule', icon: 'calendar' },
  { href: '/students', label: 'Students', icon: 'users' },
  { href: '/inbox', label: 'Inbox', icon: 'inbox' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];

// The bar shows only on the four tab roots — detail views are separate
// pages with their own back links (the accordion-era IA carried over).
const TAB_ROOTS = ['/', '/students', '/inbox', '/settings'];

interface TabBarProps {
  unreadCount: number;
}

// Bottom tab bar, 64px, exactly 4 tabs. Active = teal icon + label in a
// teal-tint pill; inactive = brown. Gold dot on Inbox when unread.
export function TabBar({ unreadCount }: TabBarProps) {
  const pathname = usePathname();
  if (!TAB_ROOTS.includes(pathname)) return null;

  return (
    <>
      {/* In-flow spacer so page content never hides behind the fixed bar */}
      <div className="h-16" aria-hidden="true" />
      <nav className="fixed bottom-0 inset-x-0 z-40">
        <div className="mx-auto w-full max-w-content bg-cream border-t border-border pb-[env(safe-area-inset-bottom)]">
          <div className="grid grid-cols-4 h-16">
            {TABS.map((tab) => {
              const active = pathname === tab.href;
              const showDot = tab.href === '/inbox' && unreadCount > 0;
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  aria-current={active ? 'page' : undefined}
                  aria-label={showDot ? `${tab.label}, unread messages` : tab.label}
                  className="flex flex-col items-center justify-center gap-0.5 no-underline"
                >
                  <span
                    className={`relative flex items-center justify-center px-3.5 py-1 rounded-pill ${
                      active ? 'bg-teal-tint text-teal' : 'text-brown'
                    }`}
                  >
                    <Icon name={tab.icon} size={22} />
                    {showDot && (
                      <span className="absolute top-0 right-1 w-2 h-2 rounded-full bg-gold" />
                    )}
                  </span>
                  <span className={`text-[11px] ${active ? 'text-teal font-semibold' : 'text-brown'}`}>
                    {tab.label}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>
    </>
  );
}
