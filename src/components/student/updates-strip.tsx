'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { timeAgo } from '@/lib/format';

export interface StudentUpdate {
  id: string;
  title: string;
  body: string;
  createdAt: string; // ISO
  /** Booking page of the related class while it's still open, else null. */
  href: string | null;
}

interface UpdatesStripProps {
  updates: StudentUpdate[];
  /** Any notifications ever — read ones live on /updates. */
  hasHistory: boolean;
}

/**
 * The student's version of the inbox: unread notifications at the top of
 * /bookings. Deliberately not a tab — one page stays one page. Email
 * fallback remains the push channel; this closes the missed-email gap
 * (a waitlist promotion was previously invisible in the app).
 */
export function UpdatesStrip({ updates, hasHistory }: UpdatesStripProps) {
  const router = useRouter();

  async function markRead(id: string) {
    await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
    // Server component re-render drops the row from the strip.
    router.refresh();
  }

  if (updates.length === 0 && !hasHistory) return null;

  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="type-subtitle">Updates</h2>
        <Link href="/updates" className="type-label text-teal no-underline shrink-0">
          All updates
        </Link>
      </div>
      <div className="flex flex-col">
        {updates.map((update) => (
          <div
            key={update.id}
            // The page's own row idiom (waitlist/past sections): column-
            // aligned, untinted — the gold dot already says "unread" in an
            // all-unread strip. The tinted inbox idiom lives on /updates,
            // where read and unread coexist.
            className="flex items-start justify-between gap-2 min-h-14 py-3 border-b border-border last:border-b-0"
          >
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[15px] text-ink font-medium">
                {update.href ? (
                  <Link
                    href={update.href}
                    onClick={() => markRead(update.id)}
                    className="no-underline text-ink"
                  >
                    {update.title} <span className="text-brown-light">&rarr;</span>
                  </Link>
                ) : (
                  update.title
                )}
              </span>
              <span className="type-caption">{update.body}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-2 pt-0.5">
              <span className="type-caption">{timeAgo(new Date(update.createdAt))}</span>
              <button
                type="button"
                onClick={() => markRead(update.id)}
                className="type-caption text-teal min-h-[44px] px-1"
              >
                Mark read
              </button>
              <span className="inline-block w-2 h-2 shrink-0 rounded-full bg-gold" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
