import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="py-16 px-4 text-center">
      <p className="type-subtitle">This page doesn&apos;t exist</p>
      <p className="type-body mt-2">The link may be old, or the page may have moved.</p>
      <Link
        href="/"
        className="mt-5 inline-flex items-center justify-center rounded-pill px-6 min-h-12 text-base font-semibold text-teal no-underline hover:bg-teal-tint"
      >
        Go to your schedule
      </Link>
    </div>
  );
}
