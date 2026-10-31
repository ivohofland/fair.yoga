import Link from 'next/link';
import { Wordmark } from '@/components/layout/wordmark';
import { COLUMN, QUIET_LINK } from './landing-links';

/** The marketing pages' header; `onHome` keeps its anchors in-page, elsewhere they lead back to `/`. */
export function SiteHeader({ signedIn, onHome }: { signedIn: boolean; onHome: boolean }) {
  const prefix = onHome ? '' : '/';
  return (
    <header
      className={`${COLUMN} pt-4 sm:pt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-2`}
    >
      <Wordmark />
      <nav aria-label="Site" className="flex flex-wrap items-center gap-x-6 text-sm">
        <Link href={`${prefix}#features`} className={`${QUIET_LINK} hidden sm:inline-flex`}>
          What it does
        </Link>
        <Link href={`${prefix}#open-source`} className={`${QUIET_LINK} hidden sm:inline-flex`}>
          Open source
        </Link>
        {signedIn ? (
          <Link href="/start" className="inline-flex items-center min-h-11 text-teal">
            Open the app
          </Link>
        ) : (
          <Link href="/login" className="inline-flex items-center min-h-11 text-teal">
            Sign in
          </Link>
        )}
      </nav>
    </header>
  );
}
