import Link from 'next/link';
import { Wordmark } from '@/components/layout/wordmark';
import { COLUMN, CONTACT_HREF, REPO_URL } from './landing-links';

const FOOTER_LINK = 'inline-flex items-center min-h-11';

export function SiteFooter({ signedIn }: { signedIn: boolean }) {
  return (
    <footer className="border-t border-border">
      <div
        className={`${COLUMN} pt-8 pb-12 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4`}
      >
        <div className="flex flex-col gap-1">
          <Wordmark />
          <p className="text-[13px] text-brown">
            A free, open source booking system for independent yoga teachers.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-4 text-[13px]">
          <Link href="/sliding-scale" className={FOOTER_LINK}>
            Sliding scale
          </Link>
          <Link href="/donation-based" className={FOOTER_LINK}>
            Donation-based
          </Link>
          <a href={REPO_URL} className={FOOTER_LINK}>
            Open source
          </a>
          <a href={CONTACT_HREF} className={FOOTER_LINK}>
            Contact
          </a>
          {signedIn ? (
            <Link href="/start" className={FOOTER_LINK}>
              Open the app
            </Link>
          ) : (
            <Link href="/login" className={FOOTER_LINK}>
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </footer>
  );
}
