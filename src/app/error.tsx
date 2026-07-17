'use client';

// Route error boundary — v2 error state: brown text + ghost "Try again".
export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="py-16 px-4 text-center">
      <p className="type-subtitle">Something went wrong</p>
      <p className="type-body mt-2">The page hit an unexpected error. Nothing was lost.</p>
      <button
        type="button"
        onClick={reset}
        className="mt-5 inline-flex items-center justify-center rounded-pill px-6 min-h-12 text-base font-semibold text-teal hover:bg-teal-tint"
      >
        Try again
      </button>
    </div>
  );
}
