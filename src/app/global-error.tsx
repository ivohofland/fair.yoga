'use client';

// Root-level error boundary — replaces the root layout entirely, so it must
// render its own <html>/<body> and cannot rely on globals.css being loaded.
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          background: '#F7F4EF',
          color: '#6B5B4E',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, Helvetica, sans-serif",
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          margin: 0,
        }}
      >
        <div style={{ padding: '16px' }}>
          <p
            style={{
              fontFamily: "Georgia, 'Times New Roman', serif",
              fontWeight: 700,
              fontSize: 18,
              color: '#2D2D2D',
              margin: 0,
            }}
          >
            Something went wrong
          </p>
          <p style={{ fontSize: 16, lineHeight: 1.55, margin: '8px 0 0' }}>
            The app hit an unexpected error.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 20,
              height: 48,
              padding: '0 24px',
              borderRadius: 999,
              border: 'none',
              background: 'transparent',
              color: '#1A5653',
              fontSize: 16,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
