import Link from 'next/link';
import { SignOutButton } from '@/components/account/sign-out-button';

/**
 * What `/signup` tells a teacher, instead of moving them (#431).
 *
 * The refusal is the same one the redirect made — a teacher is still not
 * offered a second signup form. What changes is that it happens on the page
 * they asked for, in words, with both ways out: their schedule, and the
 * sign-out that makes a different address reachable.
 */
export function AlreadyTeachingPanel({ email }: { email: string }) {
  return (
    <div className="flex-1 flex flex-col justify-center py-4">
      <p className="type-label text-teal mb-[10px]">Already teaching</p>
      <h1 className="type-display mb-4">You already have a page.</h1>
      <p className="type-body max-w-[360px] mb-6">
        You&apos;re signed in as <span className="text-ink">{email}</span>, and
        that address already has a teacher page.
      </p>
      <Link
        href="/schedule"
        className="inline-flex items-center justify-center w-full text-center bg-teal text-cream hover:bg-teal-hover rounded-pill px-6 min-h-12 font-semibold text-base no-underline"
      >
        Go to your schedule
      </Link>
      <p className="mt-6 type-caption leading-[1.55]">
        Setting up a page for a different address?
      </p>
      <div className="mt-2">
        <SignOutButton redirectTo="/signup" />
      </div>
    </div>
  );
}
