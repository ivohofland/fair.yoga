import Link from 'next/link';

/** A teacher's own pages: theirs above, one quiet line about where they run below. */
export default function TeacherPageLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col flex-1">
      <div className="flex-1">{children}</div>
      <footer className="mt-12 pt-4 pb-6 border-t border-border">
        <Link href="/" className="type-caption inline-flex items-center min-h-11 no-underline hover:text-teal">
          Bookings by fair.yoga
        </Link>
      </footer>
    </div>
  );
}
